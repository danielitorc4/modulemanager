import * as vscode from 'vscode';
import { createModule } from './commands';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "modulemanager" is now active!');

	const createModuleDisposable = vscode.commands.registerCommand(
		'modulemanager.createModule', 
		createModule
	);

	context.subscriptions.push(createModuleDisposable);
}

export function deactivate() {}