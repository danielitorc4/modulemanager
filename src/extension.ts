import * as vscode from 'vscode';
import { createDirectory, createModule } from './commands';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "modulemanager" is now active!');

	const createDirectoryDisposable = vscode.commands.registerCommand(
		'modulemanager.createDirectory', 
		createDirectory
		
	);

	const createModuleDisposable = vscode.commands.registerCommand(
		'modulemanager.createModule', 
		createModule
	);

	context.subscriptions.push(createDirectoryDisposable, createModuleDisposable);
}

export function deactivate() {}