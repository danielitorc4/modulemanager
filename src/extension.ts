import * as vscode from 'vscode';
import {
	createModule,
	addModuleDependency,
	removeModuleDependency,
	showModuleDependencies,
	validateModuleDependencies
} from './commands';
import { syncAllModules } from './build/buildFileManager';

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
	const descriptorWatcher = vscode.workspace.createFileSystemWatcher('**/.module.json');
	const onDescriptorCreate = descriptorWatcher.onDidCreate(uri => void reconcileWorkspaceFromUri(uri));
	const onDescriptorChange = descriptorWatcher.onDidChange(uri => void reconcileWorkspaceFromUri(uri));
	const onDescriptorDelete = descriptorWatcher.onDidDelete(() => void reconcileAllWorkspaces());
	const deleteSyncDisposable = vscode.workspace.onDidDeleteFiles(() => void reconcileAllWorkspaces());

	context.subscriptions.push(createModuleDisposable);
	context.subscriptions.push(addDependencyDisposable);
	context.subscriptions.push(removeDependencyDisposable);
	context.subscriptions.push(showDependenciesDisposable);
	context.subscriptions.push(validateDependenciesDisposable);
	context.subscriptions.push(descriptorWatcher);
	context.subscriptions.push(onDescriptorCreate);
	context.subscriptions.push(onDescriptorChange);
	context.subscriptions.push(onDescriptorDelete);
	context.subscriptions.push(deleteSyncDisposable);

	void reconcileAllWorkspaces();
}

async function reconcileAllWorkspaces(): Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	for (const workspaceFolder of workspaceFolders) {
		try {
			await syncAllModules(workspaceFolder.uri);
		} catch (error) {
			console.error(`Module sync failed for ${workspaceFolder.name}:`, error);
		}
	}
}

async function reconcileWorkspaceFromUri(uri: vscode.Uri): Promise<void> {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (workspaceFolder) {
		await syncAllModules(workspaceFolder.uri);
		return;
	}

	await reconcileAllWorkspaces();
}

export function deactivate() {}
