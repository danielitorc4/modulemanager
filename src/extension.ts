import * as vscode from 'vscode';
import {
	createModule,
	addModuleDependency,
	removeModuleDependency,
	showModuleDependencies,
	validateModuleDependencies,
	pruneDeletedModules
} from './commands';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "modulemanager" is now active!');

	const createModuleDisposable = vscode.commands.registerCommand(
		'modulemanager.createModule', 
		createModule
	);
	const addDependencyDisposable = vscode.commands.registerCommand(
		'modulemanager.addDependency',
		addModuleDependency
	);
	const removeDependencyDisposable = vscode.commands.registerCommand(
		'modulemanager.removeDependency',
		removeModuleDependency
	);
	const showDependenciesDisposable = vscode.commands.registerCommand(
		'modulemanager.showDependencies',
		showModuleDependencies
	);
	const validateDependenciesDisposable = vscode.commands.registerCommand(
		'modulemanager.validateDependencies',
		validateModuleDependencies
	);
    const deleteSyncDisposable = vscode.workspace.onDidDeleteFiles(async () => {
        await reconcileAllWorkspaces();
    });

	context.subscriptions.push(createModuleDisposable);
	context.subscriptions.push(addDependencyDisposable);
	context.subscriptions.push(removeDependencyDisposable);
	context.subscriptions.push(showDependenciesDisposable);
	context.subscriptions.push(validateDependenciesDisposable);
	context.subscriptions.push(deleteSyncDisposable);

	void reconcileAllWorkspaces();
}

async function reconcileAllWorkspaces(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	for (const workspaceFolder of workspaceFolders) {
		try {
			await pruneDeletedModules(workspaceFolder.uri);
		} catch (error) {
			console.error(`Module prune failed for ${workspaceFolder.name}:`, error);
		}
	}
}

export function deactivate() {}