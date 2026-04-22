import * as assert from 'assert';

import * as vscode from 'vscode';
import {
	extractJavaImportSpecifiers,
	extractJavaModuleName
} from '../commands/dependencyManager';
import {
	applyManagedWorkspaceSettings,
	summarizeWorkspaceModuleTypes
} from '../commands/createModule';
import { normalizeModuleDescriptor } from '../moduleDescriptors';
import { parseJsonWithComments, stripJsonComments } from '../utils/utils';
import { updateRootClasspathExclusions } from '../build/buildFileManager';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extracts Java import specifiers and skips JDK imports', () => {
		const source = [
			'import com.orders.service.OrderService;',
			'import static com.billing.util.MoneyUtil.round;',
			'import java.util.List;',
			'import javax.inject.Inject;'
		].join('\n');

		const imports = extractJavaImportSpecifiers(source);
		assert.deepStrictEqual(imports.sort(), ['com.billing.util.MoneyUtil.round', 'com.orders.service.OrderService']);
	});

	test('Extracts module names from Java import specifiers', () => {
		const moduleByName = new Map([
			['orders', { moduleName: 'orders' } as any],
			['billing', { moduleName: 'billing' } as any]
		]);

		assert.strictEqual(extractJavaModuleName('orders.service.OrderService', moduleByName), 'orders');
		assert.strictEqual(extractJavaModuleName('billing.internal.MoneyUtil', moduleByName), 'billing');
		assert.strictEqual(extractJavaModuleName('com.external.SomeLibrary', moduleByName), null);
	});

	test('Prefers the longest direct module prefix match', () => {
		const moduleByName = new Map([
			['order', { moduleName: 'order' } as any],
			['orders', { moduleName: 'orders' } as any]
		]);

		assert.strictEqual(extractJavaModuleName('orders.api.OrderService', moduleByName), 'orders');
	});

	test('Returns null for imports where module name appears only as a nested package segment', () => {
		// Strict mode: only direct-prefix matches are accepted to avoid false-positives when a
		// module name coincidentally appears inside an external library package path.
		const moduleByName = new Map([
			['orders', { moduleName: 'orders' } as any],
			['billing', { moduleName: 'billing' } as any]
		]);

		assert.strictEqual(extractJavaModuleName('com.company.orders.api.OrderService', moduleByName), null);
		assert.strictEqual(extractJavaModuleName('org.example.billing.internal.MoneyUtil', moduleByName), null);
	});

	test('Parses JSON with comments without corrupting URL values', () => {
		const parsed = parseJsonWithComments<{ proxy: string; repository: string }>([
			'{',
			'  // proxy setting',
			'  "proxy": "http://proxy.internal:3128",',
			'  "repository": "https://repo.example.com/maven"',
			'}'
		].join('\n'));

		assert.strictEqual(parsed.proxy, 'http://proxy.internal:3128');
		assert.strictEqual(parsed.repository, 'https://repo.example.com/maven');
	});

	test('Strips JSON comments only outside string literals', () => {
		const stripped = stripJsonComments([
			'{',
			'  "url": "http://localhost:8080",',
			'  /* comment */',
			'  "name": "service" // line comment',
			'}'
		].join('\n'));

		const parsed = JSON.parse(stripped) as { url: string; name: string };
		assert.strictEqual(parsed.url, 'http://localhost:8080');
		assert.strictEqual(parsed.name, 'service');
	});

	test('Normalizes invalid descriptor createdAt values', () => {
		const normalized = normalizeModuleDescriptor({
			name: 'orders',
			type: 'basic',
			createdAt: 'not-a-valid-date',
			dependencies: []
		});

		assert.notStrictEqual(normalized.createdAt, 'not-a-valid-date');
		assert.strictEqual(Number.isNaN(new Date(normalized.createdAt).getTime()), false);
	});

	test('Keeps valid ISO descriptor createdAt values', () => {
		const normalized = normalizeModuleDescriptor({
			name: 'billing',
			type: 'maven',
			createdAt: '2026-01-15T10:30:00.000Z',
			dependencies: ['orders']
		});

		assert.strictEqual(normalized.createdAt, '2026-01-15T10:30:00.000Z');
	});

	test('Applies managed settings by workspace module types', () => {
		const summary = summarizeWorkspaceModuleTypes(['maven']);
		const updated = applyManagedWorkspaceSettings(
			{
				'files.exclude': { '**/.git': true },
				'java.project.referencedLibraries': ['lib/**/*.jar', 'custom/**/*.jar']
			},
			summary
		) as Record<string, unknown>;

		assert.strictEqual(updated['java.import.maven.enabled'], true);
		assert.strictEqual(updated['maven.executable.preferMavenWrapper'], true);
		assert.strictEqual(updated['java.configuration.updateBuildConfiguration'], 'automatic');
		assert.deepStrictEqual(updated['java.project.referencedLibraries'], ['custom/**/*.jar']);

		const filesExclude = updated['files.exclude'] as Record<string, unknown>;
		assert.strictEqual(filesExclude['**/.module.json'], true);
		assert.strictEqual(filesExclude['**/.project'], true);
		assert.strictEqual(filesExclude['**/.classpath'], true);
		assert.strictEqual(filesExclude['**/.git'], true);
	});

	test('Keeps managed referenced libraries for basic modules', () => {
		const summary = summarizeWorkspaceModuleTypes(['basic']);
		const updated = applyManagedWorkspaceSettings({}, summary) as Record<string, unknown>;

		const referencedLibraries = updated['java.project.referencedLibraries'];
		assert.ok(Array.isArray(referencedLibraries));
		assert.deepStrictEqual(referencedLibraries, [
			'lib/**/*.jar',
			'**/lib/**/*.jar',
			'**/target/dependency/*.jar'
		]);
		assert.strictEqual(updated['java.import.maven.enabled'], undefined);
		assert.strictEqual(updated['maven.executable.preferMavenWrapper'], undefined);
	});

	test('Adds excluding patterns to root .classpath src entries that overlap with module dirs', () => {
		const classpathXml = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<classpath>',
			'  <classpathentry kind="src" path="src"/>',
			'  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>',
			'  <classpathentry kind="output" path="bin"/>',
			'</classpath>',
			''
		].join('\n');

		const result = updateRootClasspathExclusions(classpathXml, ['src/moduleA', 'src/moduleB']);
		assert.ok(result.includes('excluding="moduleA/**|moduleB/**"'), `Expected exclusion pattern, got:\n${result}`);
		// Non-src entries must be unchanged.
		assert.ok(result.includes('<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>'));
		assert.ok(result.includes('<classpathentry kind="output" path="bin"/>'));
	});

	test('Does not add excluding patterns when no module is inside a source root', () => {
		const classpathXml = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<classpath>',
			'  <classpathentry kind="src" path="src/main/java"/>',
			'  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>',
			'</classpath>',
			''
		].join('\n');

		// Modules are at the workspace root, not inside src/main/java.
		const result = updateRootClasspathExclusions(classpathXml, ['moduleA', 'moduleB']);
		assert.ok(!result.includes('excluding='), `Expected no exclusion, got:\n${result}`);
		assert.strictEqual(result, classpathXml);
	});

	test('Replaces existing excluding patterns with fresh ones on re-sync', () => {
		const classpathXml = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<classpath>',
			'  <classpathentry kind="src" path="src" excluding="oldModule/**"/>',
			'</classpath>',
			''
		].join('\n');

		const result = updateRootClasspathExclusions(classpathXml, ['src/newModule']);
		assert.ok(result.includes('excluding="newModule/**"'), `Expected new exclusion, got:\n${result}`);
		assert.ok(!result.includes('oldModule'), `Old exclusion should be removed, got:\n${result}`);
	});
});
