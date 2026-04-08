import * as assert from 'assert';

import * as vscode from 'vscode';
import {
	extractAliasedModuleName,
	extractImportSpecifiers,
	normalizeDependencyReferencePath
} from '../Commands/dependencyManager';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Normalizes dependency reference paths', () => {
		assert.strictEqual(normalizeDependencyReferencePath('./module-a/'), 'module-a');
		assert.strictEqual(normalizeDependencyReferencePath('..\\shared\\core'), '../shared/core');
		assert.strictEqual(normalizeDependencyReferencePath('src/module-b'), 'src/module-b');
	});

	test('Extracts import specifiers from static, dynamic and require imports', () => {
		const source = [
			"import { a } from '@alpha/foo';",
			"const b = await import('@beta/bar');",
			"const c = require('@gamma/baz');"
		].join('\n');

		const specifiers = extractImportSpecifiers(source);
		assert.deepStrictEqual(specifiers.sort(), ['@alpha/foo', '@beta/bar', '@gamma/baz']);
	});

	test('Extracts module alias names for supported format', () => {
		assert.strictEqual(extractAliasedModuleName('@orders/api'), 'orders');
		assert.strictEqual(extractAliasedModuleName('@billing/domain/models'), 'billing');
		assert.strictEqual(extractAliasedModuleName('./local/file'), null);
		assert.strictEqual(extractAliasedModuleName('react'), null);
	});
});
