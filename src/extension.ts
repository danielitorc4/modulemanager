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
import { reconcileWorkspaceModel } from './build/buildFileManager';
import { syncDependencyBoundaryEnforcement } from './build/dependencyBoundaryEnforcer';
import { CONFIG_PATHS } from './constants';
import { shouldIgnoreModuleDescriptorPath } from './moduleDescriptors';
import { discoverManagedModules, resolveManagementRootUri } from './workspace/managedWorkspace';
import { ensureWorkspaceExcludes } from './workspace/settingsSync';

const RECONCILE_DEBOUNCE_MS = 700;
const DIAGNOSTIC_DEBOUNCE_MS = 700;
const JAVA_LIFECYCLE_DEBOUNCE_MS = 15_000;
const JAVA_RELOAD_MIN_INTERVAL_MS = 15_000;
const JAVA_CLEAN_MIN_INTERVAL_MS = 90_000;
const COMMANDS_CACHE_TTL_MS = 15_000;
const JAVA_RELOAD_COMMAND = 'java.reloadProjects';
const JAVA_CLEAN_COMMAND = 'java.cleanWorkspace';
const DIAGNOSTIC_SOURCE = 'modulemanager';
const JAVA_EXTENSION_CHECK_TIMEOUT_MS = 5_000;

// Reconciliation state to prevent infinite loops
const MAX_RECONCILE_RESCHEDULES_PER_CYCLE = 5;

let reconcileTimer: NodeJS.Timeout | undefined;
let diagnosticsTimer: NodeJS.Timeout | undefined;
let javaLifecycleTimer: NodeJS.Timeout | undefined;

let pendingReconcileRequiresClean = false;
let pendingJavaClean = false;
let isReconcileRunning = false;
let isJavaLifecycleRunning = false;
let reconcileRescheduleCount = 0;

let lastJavaLifecycleAt = 0;
let lastJavaCleanAt = 0;

let dependencyDiagnosticsCollection: vscode.DiagnosticCollection | undefined;
let javaCommandsCache: { hasReload: boolean; hasClean: boolean; checkedAt: number } | undefined;
let javaDebugSessionStartDisposable: vscode.Disposable | undefined;
let javaRunBlockMessageCooldownUntil = 0;

/**
 * Validates that the Java extension (JDTLS) is available and responding.
 * This is a hard requirement for ModuleManager.
 */
async function validateJavaExtensionAvailable(): Promise<boolean> {
	try {
		const commands = await Promise.race([
			vscode.commands.getCommands(true),
			new Promise<never>((_, reject) => 
				setTimeout(() => reject(new Error('Java extension check timeout')), JAVA_EXTENSION_CHECK_TIMEOUT_MS)
			)
		]);
		
		const hasReload = (commands as string[]).includes(JAVA_RELOAD_COMMAND);
		const hasClean = (commands as string[]).includes(JAVA_CLEAN_COMMAND);
		
		if (!hasReload && !hasClean) {
			console.error(
				'ModuleManager: Java extension (JDTLS) is not available. ' +
				'Please install the "Extension Pack for Java" or "Language Support for Java (Red Hat)" extension.'
			);
			vscode.window.showErrorMessage(
				'ModuleManager requires the Java extension to be installed. ' +
				'Please install "Extension Pack for Java" and reload VS Code.'
			);
			return false;
		}
		
		return true;
	} catch (error) {
		console.error('ModuleManager: Failed to validate Java extension:', error);
		vscode.window.showErrorMessage(
			'ModuleManager: Failed to detect Java extension. ' +
			'Please ensure the Java extension is properly installed and try reloading VS Code.'
		);
		return false;
	}
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('ModuleManager activated in independent workspace mode.');
	
	// Validate Java extension is available before proceeding
	const javaAvailable = await validateJavaExtensionAvailable();
	if (!javaAvailable) {
		console.log('ModuleManager deactivated: Java extension not available.');
		return;
	}

	dependencyDiagnosticsCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
	javaDebugSessionStartDisposable = vscode.debug.onDidStartDebugSession(session => {
		void enforceRunningDebugSessionPolicy(session);
	});

	const createModuleDisposable = vscode.commands.registerCommand('modulemanager.createModule', createModule);
	const addDependencyDisposable = vscode.commands.registerCommand('modulemanager.addDependency', addModuleDependency);
	const removeDependencyDisposable = vscode.commands.registerCommand('modulemanager.removeDependency', removeModuleDependency);
	const showDependenciesDisposable = vscode.commands.registerCommand('modulemanager.showDependencies', showModuleDependencies);
	const validateDependenciesDisposable = vscode.commands.registerCommand('modulemanager.validateDependencies', validateModuleDependencies);

	const descriptorWatcher = vscode.workspace.createFileSystemWatcher('**/.module.json');
	const onDescriptorCreate = descriptorWatcher.onDidCreate(uri => {
		if (shouldIgnoreModuleDescriptorPath(uri.fsPath)) {
			return;
		}
		scheduleReconciliation(true);
	});
	const onDescriptorChange = descriptorWatcher.onDidChange(uri => {
		if (shouldIgnoreModuleDescriptorPath(uri.fsPath)) {
			return;
		}
		scheduleReconciliation(false);
	});
	const onDescriptorDelete = descriptorWatcher.onDidDelete(() => scheduleReconciliation(true));

	const onWorkspaceDelete = vscode.workspace.onDidDeleteFiles(event => {
		if (event.files.length > 0) {
			scheduleReconciliation(true);
		}
	});

	const onWorkspaceFoldersChange = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		scheduleReconciliation(true);
	});

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
	context.subscriptions.push(descriptorWatcher);
	context.subscriptions.push(onDescriptorCreate);
	context.subscriptions.push(onDescriptorChange);
	context.subscriptions.push(onDescriptorDelete);
	context.subscriptions.push(onWorkspaceDelete);
	context.subscriptions.push(onWorkspaceFoldersChange);
	context.subscriptions.push(onDocumentOpen);
	context.subscriptions.push(onDocumentChange);
	context.subscriptions.push(onDocumentSave);
	if (dependencyDiagnosticsCollection) {
		context.subscriptions.push(dependencyDiagnosticsCollection);
	}
	if (javaDebugSessionStartDisposable) {
		context.subscriptions.push(javaDebugSessionStartDisposable);
	}

	await ensureWorkspaceExcludes();

	const managementRoot = await resolveManagementRootUri();
	const modules = managementRoot
		? await discoverManagedModules(managementRoot)
		: [];

	if (modules.length > 0) {
		scheduleReconciliation(true);
		scheduleDependencyDiagnosticsRefresh();
	}
}

async function collectViolationsForLaunch(folder?: vscode.WorkspaceFolder): Promise<DependencyViolation[]> {
	const managementRootUri = await resolveManagementRootUri(folder?.uri);
	if (!managementRootUri) {
		return [];
	}

	return collectJavaDependencyViolations(managementRootUri);
}

async function enforceRunningDebugSessionPolicy(session: vscode.DebugSession): Promise<void> {
	if (!session.type.toLowerCase().includes('java')) {
		return;
	}

	const requestType = typeof session.configuration?.request === 'string'
		? session.configuration.request.toLowerCase()
		: 'launch';
	if (requestType !== 'launch') {
		return;
	}

	const violations = await collectViolationsForLaunch(session.workspaceFolder);
	if (violations.length === 0) {
		return;
	}

	const now = Date.now();
	if (now >= javaRunBlockMessageCooldownUntil) {
		const moduleNames = Array.from(new Set(violations.map(violation => violation.sourceModule))).sort();
		const moduleSummary = moduleNames.slice(0, 3).join(', ');
		const suffix = moduleNames.length > 3 ? '...' : '';
		vscode.window.showErrorMessage(
			`ModuleManager blocked Java Run/Debug because ${violations.length} illegal module import(s) were detected (${moduleSummary}${suffix}). Fix dependencies before launching.`
		);
		javaRunBlockMessageCooldownUntil = now + 2000;
	}

	setTimeout(() => {
		void vscode.debug.stopDebugging(session);
	}, 50);
}

function scheduleReconciliation(requireJavaClean: boolean): void {
	pendingReconcileRequiresClean = pendingReconcileRequiresClean || requireJavaClean;

	if (reconcileTimer) {
		clearTimeout(reconcileTimer);
	}

	reconcileTimer = setTimeout(() => {
		void runReconciliation();
	}, RECONCILE_DEBOUNCE_MS);
}

async function runReconciliation(): Promise<void> {
	if (isReconcileRunning) {
		// Prevent infinite reschedule loops
		if (reconcileRescheduleCount >= MAX_RECONCILE_RESCHEDULES_PER_CYCLE) {
			console.warn(
				'ModuleManager reconciliation exceeded max reschedule attempts. ' +
				'This may indicate a performance issue or infinite loop condition.'
			);
			reconcileRescheduleCount = 0;
			return;
		}

		reconcileRescheduleCount++;
		scheduleReconciliation(false);
		return;
	}

	// Reset counter on successful reconciliation start
	reconcileRescheduleCount = 0;
	isReconcileRunning = true;
	const requiresClean = pendingReconcileRequiresClean;
	pendingReconcileRequiresClean = false;

	try {
		const result = await reconcileWorkspaceModel();
		if (!result) {
			return;
		}

		scheduleJavaLifecycle(result.shouldCleanJavaWorkspace || requiresClean);
		scheduleDependencyDiagnosticsRefresh();
	} catch (error) {
		console.error('ModuleManager reconciliation failed:', error);
	} finally {
		isReconcileRunning = false;
	}
}

function scheduleJavaLifecycle(requireClean: boolean): void {
	pendingJavaClean = pendingJavaClean || requireClean;

	if (javaLifecycleTimer) {
		clearTimeout(javaLifecycleTimer);
	}

	const elapsed = Date.now() - lastJavaLifecycleAt;
	const cooldownDelay = Math.max(0, JAVA_RELOAD_MIN_INTERVAL_MS - elapsed);
	const delay = Math.max(JAVA_LIFECYCLE_DEBOUNCE_MS, cooldownDelay);

	javaLifecycleTimer = setTimeout(() => {
		void runJavaLifecycle();
	}, delay);
}

async function runJavaLifecycle(): Promise<void> {
	if (isJavaLifecycleRunning) {
		scheduleJavaLifecycle(false);
		return;
	}

	const commands = await getJavaCommandAvailability();
	if (!commands.hasReload && !commands.hasClean) {
		// Java extension should be available - this is a hard requirement that we already validated
		// in activate(). If we reach here, the extension became unavailable, which is a serious issue.
		console.error('Java lifecycle sync failed: Java extension commands are unexpectedly unavailable.');
		return;
	}

	isJavaLifecycleRunning = true;

	const wantsClean = pendingJavaClean;
	pendingJavaClean = false;

	try {
		const now = Date.now();
		if (wantsClean && commands.hasClean && now - lastJavaCleanAt >= JAVA_CLEAN_MIN_INTERVAL_MS) {
			await vscode.commands.executeCommand(JAVA_CLEAN_COMMAND);
			lastJavaCleanAt = Date.now();
			lastJavaLifecycleAt = lastJavaCleanAt;
			return;
		}

		if (commands.hasReload) {
			await vscode.commands.executeCommand(JAVA_RELOAD_COMMAND);
			lastJavaLifecycleAt = Date.now();
			return;
		}

		await vscode.commands.executeCommand(JAVA_CLEAN_COMMAND);
		lastJavaCleanAt = Date.now();
		lastJavaLifecycleAt = lastJavaCleanAt;
	} catch (error) {
		console.error('Java lifecycle command failed:', error);
		javaCommandsCache = undefined;
	} finally {
		isJavaLifecycleRunning = false;
		if (pendingJavaClean) {
			scheduleJavaLifecycle(false);
		}
	}
}

function scheduleDependencyDiagnosticsRefresh(): void {
	if (diagnosticsTimer) {
		clearTimeout(diagnosticsTimer);
	}

	diagnosticsTimer = setTimeout(() => {
		void refreshDependencyDiagnostics();
	}, DIAGNOSTIC_DEBOUNCE_MS);
}

async function refreshDependencyDiagnostics(): Promise<void> {
	if (!dependencyDiagnosticsCollection) {
		return;
	}

	const managementRootUri = await resolveManagementRootUri();
	if (!managementRootUri) {
		dependencyDiagnosticsCollection.clear();
		return;
	}

	try {
		const violations = await collectJavaDependencyViolations(managementRootUri);
		const modules = await discoverManagedModules(managementRootUri);
		await syncDependencyBoundaryEnforcement(modules, violations);

		const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();
		const usageRangeCache = new Map<string, vscode.Range[]>();

		for (const violation of violations) {
			// Validate the file still exists before adding diagnostics
			try {
				await vscode.workspace.fs.stat(violation.fileUri);
			} catch {
				continue; // Skip files that no longer exist
			}

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

			const blockedTypeName = getSimpleTypeName(violation.importName);
			if (blockedTypeName) {
				const cacheKey = `${key}::${blockedTypeName}`;
				let usageRanges = usageRangeCache.get(cacheKey);
				if (!usageRanges) {
					usageRanges = await findTypeUsageRanges(violation.fileUri, blockedTypeName);
					usageRangeCache.set(cacheKey, usageRanges);
				}

				for (const usageRange of usageRanges) {
					if (usageRange.intersection(violation.range)) {
						continue;
					}

					const usageDiagnostic = new vscode.Diagnostic(
						usageRange,
						`Type "${blockedTypeName}" is blocked because module "${violation.sourceModule}" does not declare dependency on "${violation.targetModule}".`,
						vscode.DiagnosticSeverity.Error
					);
					usageDiagnostic.source = DIAGNOSTIC_SOURCE;
					usageDiagnostic.code = 'missing-module-dependency';
					diagnostics.push(usageDiagnostic);
				}
			}

			diagnosticsByFile.set(key, diagnostics);
		}

		// Clear existing diagnostics before setting new ones
		dependencyDiagnosticsCollection.clear();

		// Set new diagnostics only for files that are part of the current workspace
		const openFiles = vscode.workspace.textDocuments.map(doc => doc.uri.toString());
		for (const [uriString, diagnostics] of diagnosticsByFile.entries()) {
			try {
				dependencyDiagnosticsCollection.set(vscode.Uri.parse(uriString), diagnostics);
			} catch (error) {
				console.warn(`Failed to set diagnostics for ${uriString}:`, error);
			}
		}

		if (violations.length > 0) {
			console.info(`ModuleManager detected ${violations.length} dependency violation(s).`);
		}
	} catch (error) {
		console.error('Failed to refresh dependency diagnostics:', error);
		dependencyDiagnosticsCollection.clear();
	}
}

function isJavaOrModuleDescriptor(document: vscode.TextDocument): boolean {
	const lowerPath = document.uri.fsPath.toLowerCase();
	return (
		lowerPath.endsWith('.java') ||
		lowerPath.endsWith(`/${CONFIG_PATHS.MODULE_DESCRIPTOR}`) ||
		lowerPath.endsWith(`\\${CONFIG_PATHS.MODULE_DESCRIPTOR}`)
	);
}

async function findTypeUsageRanges(fileUri: vscode.Uri, typeName: string): Promise<vscode.Range[]> {
	const source = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString();
	const escapedTypeName = escapeRegExp(typeName);
	const usagePattern = new RegExp(`\\b${escapedTypeName}\\b`, 'g');
	const ranges: vscode.Range[] = [];
	let match: RegExpExecArray | null;

	while ((match = usagePattern.exec(source)) !== null) {
		const startOffset = match.index;
		const endOffset = startOffset + typeName.length;
		const start = offsetToPosition(source, startOffset);
		const end = offsetToPosition(source, endOffset);
		if (start.line !== end.line) {
			continue;
		}

		ranges.push(new vscode.Range(start, end));
	}

	return ranges;
}

function getSimpleTypeName(importName: string): string {
	const lastDot = importName.lastIndexOf('.');
	return lastDot >= 0 ? importName.slice(lastDot + 1) : importName;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function offsetToPosition(source: string, offset: number): vscode.Position {
	const safeOffset = Math.max(0, Math.min(offset, source.length));
	const precedingText = source.slice(0, safeOffset);
	const lines = precedingText.split(/\r?\n/);
	const line = Math.max(0, lines.length - 1);
	const character = lines[lines.length - 1]?.length ?? 0;
	return new vscode.Position(line, character);
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
