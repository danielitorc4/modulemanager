import * as vscode from 'vscode';
import {
	createModule,
	addModuleDependency,
	removeModuleDependency,
	showModuleDependencies,
	validateModuleDependencies,
	collectJavaDependencyViolations,
	DependencyViolation
} from './commands';
import { syncAllModules } from './build/buildFileManager';
import { CONFIG_PATHS } from './constants';
import { findModuleDescriptors, shouldIgnoreModuleDescriptorPath } from './moduleDescriptors';

const RELOAD_DEBOUNCE_MS = 350;
const COMMANDS_CACHE_TTL_MS = 15_000;
const JAVA_RELOAD_COMMAND = 'java.reloadProjects';
const JAVA_CLEAN_COMMAND = 'java.cleanWorkspace';
const DIAGNOSTIC_SOURCE = 'modulemanager';
const BUILD_BLOCKER_RELATIVE_PATH = 'src/main/java/modulemanager/generated/ModuleManagerDependencyViolationBlocker.java';
let reloadTimer: NodeJS.Timeout | undefined;
let diagnosticsTimer: NodeJS.Timeout | undefined;
let dependencyDiagnosticsCollection: vscode.DiagnosticCollection | undefined;
let javaCommandsCache: { hasReload: boolean; hasClean: boolean; checkedAt: number } | undefined;
let hasLoggedUnavailableJavaCommands = false;

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "modulemanager" is now active!');
	dependencyDiagnosticsCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);

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
	const onDescriptorCreate = descriptorWatcher.onDidCreate(uri => {
		if (shouldIgnoreModuleDescriptorPath(uri.fsPath)) {
			return;
		}
		void reconcileWorkspaceFromUri(uri);
	});
	const onDescriptorChange = descriptorWatcher.onDidChange(uri => {
		if (shouldIgnoreModuleDescriptorPath(uri.fsPath)) {
			return;
		}
		void reconcileWorkspaceFromUri(uri);
	});
	const onDescriptorDelete = descriptorWatcher.onDidDelete(() => void reconcileAllWorkspaces());
	const onDocumentOpen = vscode.workspace.onDidOpenTextDocument(document => {
		if (isJavaOrModuleDescriptor(document)) {
			scheduleDependencyDiagnosticsRefresh();
		}
	});
	const onDocumentChange = vscode.workspace.onDidChangeTextDocument(event => {
		if (isJavaOrModuleDescriptor(event.document)) {
			scheduleDependencyDiagnosticsRefresh();
		}
	});
	const onDocumentSave = vscode.workspace.onDidSaveTextDocument(document => {
		if (isJavaOrModuleDescriptor(document)) {
			scheduleDependencyDiagnosticsRefresh();
		}
	});

	context.subscriptions.push(createModuleDisposable);
	context.subscriptions.push(addDependencyDisposable);
	context.subscriptions.push(removeDependencyDisposable);
	context.subscriptions.push(showDependenciesDisposable);
	context.subscriptions.push(validateDependenciesDisposable);
	context.subscriptions.push(dependencyDiagnosticsCollection);
	context.subscriptions.push(descriptorWatcher);
	context.subscriptions.push(onDescriptorCreate);
	context.subscriptions.push(onDescriptorChange);
	context.subscriptions.push(onDescriptorDelete);
	context.subscriptions.push(onDocumentOpen);
	context.subscriptions.push(onDocumentChange);
	context.subscriptions.push(onDocumentSave);

	void reconcileAllWorkspaces();
	void refreshDependencyDiagnostics();
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
	scheduleDependencyDiagnosticsRefresh();
}

async function reconcileWorkspaceFromUri(uri: vscode.Uri): Promise<void> {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (workspaceFolder) {
		await syncAllModules(workspaceFolder.uri);
		scheduleJavaProjectReload();
		scheduleDependencyDiagnosticsRefresh();
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

function scheduleDependencyDiagnosticsRefresh(): void {
	if (diagnosticsTimer) {
		clearTimeout(diagnosticsTimer);
	}

	diagnosticsTimer = setTimeout(() => {
		void refreshDependencyDiagnostics();
	}, RELOAD_DEBOUNCE_MS);
}

async function refreshDependencyDiagnostics(): Promise<void> {
	if (!dependencyDiagnosticsCollection) {
		return;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();
	const violationsByWorkspace = new Map<string, DependencyViolation[]>();

	for (const workspaceFolder of workspaceFolders) {
		const violations = await collectJavaDependencyViolations(workspaceFolder.uri);
		violationsByWorkspace.set(workspaceFolder.uri.toString(), violations);
		for (const violation of violations) {
			const diagnostic = new vscode.Diagnostic(
				violation.range,
				`Module "${violation.sourceModule}" imports "${violation.targetModule}" without a declared dependency. Use "ModuleManager: Add Module Dependency".`,
				vscode.DiagnosticSeverity.Error
			);
			diagnostic.source = DIAGNOSTIC_SOURCE;
			diagnostic.code = 'missing-module-dependency';

			const key = violation.fileUri.toString();
			const diagnostics = diagnosticsByFile.get(key) ?? [];
			diagnostics.push(diagnostic);
			diagnosticsByFile.set(key, diagnostics);
		}
	}

	dependencyDiagnosticsCollection.clear();
	for (const [uriString, diagnostics] of diagnosticsByFile.entries()) {
		dependencyDiagnosticsCollection.set(vscode.Uri.parse(uriString), diagnostics);
	}

	for (const workspaceFolder of workspaceFolders) {
		const violations = violationsByWorkspace.get(workspaceFolder.uri.toString()) ?? [];
		await syncCompileBlockers(workspaceFolder.uri, violations);
	}
}

function isJavaOrModuleDescriptor(document: vscode.TextDocument): boolean {
	const lowerPath = document.uri.fsPath.toLowerCase();
	return lowerPath.endsWith('.java') || lowerPath.endsWith(`/${CONFIG_PATHS.MODULE_DESCRIPTOR}`) || lowerPath.endsWith(`\\${CONFIG_PATHS.MODULE_DESCRIPTOR}`);
}

async function syncCompileBlockers(workspaceUri: vscode.Uri, violations: DependencyViolation[]): Promise<void> {
	const modules = await findModuleDescriptors(workspaceUri);
	const blockedModulePaths = new Set(violations.map(violation => violation.sourceModulePath));

	for (const module of modules) {
		const blockerUri = vscode.Uri.joinPath(module.moduleUri, BUILD_BLOCKER_RELATIVE_PATH);
		if (blockedModulePaths.has(module.modulePath)) {
			const moduleViolations = violations.filter(violation => violation.sourceModulePath === module.modulePath);
			await writeCompileBlockerFile(blockerUri, module.descriptor.name, moduleViolations);
			continue;
		}

		await deleteFileIfExists(blockerUri);
	}
}

async function writeCompileBlockerFile(
	blockerUri: vscode.Uri,
	moduleName: string,
	violations: DependencyViolation[]
): Promise<void> {
	const uniqueDependencyPairs = Array.from(
		new Set(violations.map(violation => `${violation.sourceModule} -> ${violation.targetModule}`))
	).sort();
	const violationSummary = uniqueDependencyPairs.map(pair => ` * - ${pair}`).join('\n');
	const blockerSource = [
		'package modulemanager.generated;',
		'',
		'/**',
		` * Generated by ModuleManager. Module "${moduleName}" contains illegal cross-module imports.`,
		' * Resolve these dependencies with the ModuleManager dependency command:',
		violationSummary || ' * - Unknown violation',
		' */',
		'public final class ModuleManagerDependencyViolationBlocker {',
		'    private ModuleManagerDependencyViolationBlocker() {}',
		'',
		'    // Intentional type mismatch so Java compilation fails while violations exist.',
		'    private static final int MODULE_MANAGER_DEPENDENCY_ERRORS_PRESENT = "fix-module-dependencies";',
		'}',
		''
	].join('\n');

	await vscode.workspace.fs.createDirectory(parentDirectoryUri(blockerUri));
	await vscode.workspace.fs.writeFile(blockerUri, Buffer.from(blockerSource));
}

async function deleteFileIfExists(fileUri: vscode.Uri): Promise<void> {
	try {
		await vscode.workspace.fs.delete(fileUri, { useTrash: false });
	} catch {
		// Ignore missing files.
	}
}

function parentDirectoryUri(uri: vscode.Uri): vscode.Uri {
	const normalizedPath = uri.path.replace(/\\/g, '/');
	const lastSlash = normalizedPath.lastIndexOf('/');
	const parentPath = lastSlash > 0 ? normalizedPath.slice(0, lastSlash) : '/';
	return uri.with({ path: parentPath });
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
