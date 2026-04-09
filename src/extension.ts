import * as vscode from 'vscode';
import {
	createModule,
	addModuleDependency,
	removeModuleDependency,
	showModuleDependencies,
	validateModuleDependencies
} from './commands';
import { syncAllModules } from './build/buildFileManager';

const RELOAD_DEBOUNCE_MS = 350;
const COMMANDS_CACHE_TTL_MS = 15_000;
const JAVA_RELOAD_COMMAND = 'java.reloadProjects';
const JAVA_CLEAN_COMMAND = 'java.cleanWorkspace';
let reloadTimer: NodeJS.Timeout | undefined;
let javaCommandsCache: { hasReload: boolean; hasClean: boolean; checkedAt: number } | undefined;
let hasLoggedUnavailableJavaCommands = false;

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

	context.subscriptions.push(createModuleDisposable);
	context.subscriptions.push(addDependencyDisposable);
	context.subscriptions.push(removeDependencyDisposable);
	context.subscriptions.push(showDependenciesDisposable);
	context.subscriptions.push(validateDependenciesDisposable);
	context.subscriptions.push(descriptorWatcher);
	context.subscriptions.push(onDescriptorCreate);
	context.subscriptions.push(onDescriptorChange);
	context.subscriptions.push(onDescriptorDelete);

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

	scheduleJavaProjectReload();
}

async function reconcileWorkspaceFromUri(uri: vscode.Uri): Promise<void> {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (workspaceFolder) {
		await syncAllModules(workspaceFolder.uri);
		scheduleJavaProjectReload();
		return;
	}

	await reconcileAllWorkspaces();
}

function scheduleJavaProjectReload(): void {
	if (reloadTimer) {
		clearTimeout(reloadTimer);
	}

	reloadTimer = setTimeout(() => {
		void reloadJavaProjects();
	}, RELOAD_DEBOUNCE_MS);
}

async function reloadJavaProjects(): Promise<void> {
	const commands = await getJavaCommandAvailability();
	if (!commands.hasReload && !commands.hasClean) {
		if (!hasLoggedUnavailableJavaCommands) {
			console.info('Skipping Java project reload because Java extension commands are unavailable.');
			hasLoggedUnavailableJavaCommands = true;
		}
		return;
	}

	hasLoggedUnavailableJavaCommands = false;

	if (!commands.hasReload && commands.hasClean) {
		await runJavaCleanWorkspace();
		return;
	}

	try {
		await vscode.commands.executeCommand(JAVA_RELOAD_COMMAND);
	} catch (error) {
		console.warn('java.reloadProjects failed, attempting java.cleanWorkspace', error);
		javaCommandsCache = undefined;
		const refreshedCommands = await getJavaCommandAvailability(true);
		if (refreshedCommands.hasClean) {
			await runJavaCleanWorkspace();
		}
	}
}

async function runJavaCleanWorkspace(): Promise<void> {
	try {
		await vscode.commands.executeCommand(JAVA_CLEAN_COMMAND);
	} catch (cleanError) {
		console.error('java.cleanWorkspace failed after metadata sync', cleanError);
	}
}

async function getJavaCommandAvailability(forceRefresh = false): Promise<{ hasReload: boolean; hasClean: boolean }> {
	if (!forceRefresh && javaCommandsCache && Date.now() - javaCommandsCache.checkedAt < COMMANDS_CACHE_TTL_MS) {
		return javaCommandsCache;
	}

	const commands = await vscode.commands.getCommands(true);
	javaCommandsCache = {
		hasReload: commands.includes(JAVA_RELOAD_COMMAND),
		hasClean: commands.includes(JAVA_CLEAN_COMMAND),
		checkedAt: Date.now()
	};

	return javaCommandsCache;
}

export function deactivate() {}
