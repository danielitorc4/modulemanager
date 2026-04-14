import * as assert from 'assert';

import * as vscode from 'vscode';
import {
	extractJavaImportSpecifiers,
	extractJavaModuleName
} from '../commands/dependencyManager';

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
});
