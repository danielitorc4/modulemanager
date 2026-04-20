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

	test('Detects module names within nested package segments', () => {
		const moduleByName = new Map([
			['orders', { moduleName: 'orders' } as any],
			['billing', { moduleName: 'billing' } as any]
		]);

		assert.strictEqual(extractJavaModuleName('com.company.orders.api.OrderService', moduleByName), 'orders');
		assert.strictEqual(extractJavaModuleName('org.example.billing.internal.MoneyUtil', moduleByName), 'billing');
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
});
