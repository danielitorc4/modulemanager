import * as vscode from 'vscode';
import * as path from 'path';
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
const LEGACY_BUILD_BLOCKER_RELATIVE_PATH = 'src/main/java/modulemanager/generated/ModuleManagerDependencyViolationBlocker.java';
const BUILD_BLOCKER_CLASS_PREFIX = 'ModuleManagerDependencyViolationBlocker__';
const BLOCKED_CLASSPATH_CONTENT = [
'<?xml version="1.0" encoding="UTF-8"?>',
'<classpath>',
'  <classpathentry kind="src" path="src/main/java" excluding="**"/>',
'  <classpathentry kind="src" path="src/test/java" excluding="**"/>',
'  <classpathentry kind="src" path="src/main/resources" excluding="**"/>',
'  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>',
'  <classpathentry kind="output" path="bin"/>',
'</classpath>',
''
].join('\n');
// Retry delays (ms) after activation to call java.reloadProjects once the Java LS has started.
const STARTUP_RELOAD_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
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
const usageRangeCache = new Map<string, vscode.Range[]>();

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
const legacyBlockerUri = vscode.Uri.joinPath(module.moduleUri, LEGACY_BUILD_BLOCKER_RELATIVE_PATH);
if (blockedModulePaths.has(module.modulePath)) {
const moduleViolations = violations.filter(violation => violation.sourceModulePath === module.modulePath);
await writeCompileBlockerFilesForModule(module.moduleUri, module.descriptor.name, moduleViolations);
await deleteFileIfExists(legacyBlockerUri);
// Secondary blocker: exclude all sources in the module's .classpath so the Java
// compiler sees no files to compile, regardless of project-isolation state.
if (module.descriptor.type === 'basic') {
await writeBlockedClasspathFile(module.moduleUri);
}
continue;
}

await deleteFileIfExists(legacyBlockerUri);
await deleteGeneratedCompileBlockers(module.moduleUri);
}
}

async function writeCompileBlockerFilesForModule(
moduleUri: vscode.Uri,
moduleName: string,
violations: DependencyViolation[]
): Promise<void> {
const violationsBySourceFile = new Map<string, DependencyViolation[]>();
for (const violation of violations) {
const key = violation.fileUri.toString();
const existing = violationsBySourceFile.get(key) ?? [];
existing.push(violation);
violationsBySourceFile.set(key, existing);
}

const expectedBlockerUris = new Set<string>();

for (const [sourceFileUriString, sourceViolations] of violationsBySourceFile.entries()) {
const sourceFileUri = vscode.Uri.parse(sourceFileUriString);
const blocker = await createCompileBlockerForSourceFile(sourceFileUri, moduleName, sourceViolations);
expectedBlockerUris.add(blocker.uri.toString());
await vscode.workspace.fs.writeFile(blocker.uri, Buffer.from(blocker.source));
}

await deleteGeneratedCompileBlockers(moduleUri, expectedBlockerUris);
}

async function createCompileBlockerForSourceFile(
sourceFileUri: vscode.Uri,
moduleName: string,
violations: DependencyViolation[]
): Promise<{ uri: vscode.Uri; source: string }> {
const sourceText = Buffer.from(await vscode.workspace.fs.readFile(sourceFileUri)).toString();
const packageDeclaration = extractPackageDeclaration(sourceText);
const sourceClassName = sanitizeJavaIdentifier(path.basename(sourceFileUri.fsPath, '.java'));
const blockerClassName = `${BUILD_BLOCKER_CLASS_PREFIX}${sourceClassName}`;
const blockerUri = vscode.Uri.joinPath(parentDirectoryUri(sourceFileUri), `${blockerClassName}.java`);

const uniqueDependencyPairs = Array.from(
new Set(violations.map(violation => `${violation.sourceModule} -> ${violation.targetModule}`))
).sort();
const violationSummary = uniqueDependencyPairs.map(pair => ` * - ${pair}`).join('\n');

const packageLine = packageDeclaration ? [packageDeclaration, ''] : [];
const blockerSource = [
...packageLine,
'/**',
` * Generated by ModuleManager. Module "${moduleName}" contains illegal cross-module imports.`,
' * Resolve these dependencies with the ModuleManager dependency command:',
violationSummary || ' * - Unknown violation',
' */',
`public final class ${blockerClassName} {`,
`    private ${blockerClassName}() {}`,
'',
'    // Intentional type mismatch so Java compilation fails while violations exist.',
'    private static final int MODULE_MANAGER_DEPENDENCY_ERRORS_PRESENT = "fix-module-dependencies";',
'}',
''
].join('\n');

return { uri: blockerUri, source: blockerSource };
}

function extractPackageDeclaration(sourceText: string): string | null {
const packageMatch = sourceText.match(/^\s*(package\s+[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*\s*;)\s*$/m);
return packageMatch?.[1]?.trim() ?? null;
}

function sanitizeJavaIdentifier(value: string): string {
const sanitized = value.replace(/[^A-Za-z0-9_$]/g, '_');
if (/^[A-Za-z_$]/.test(sanitized)) {
return sanitized;
}

return `M_${sanitized || 'Source'}`;
}

async function deleteGeneratedCompileBlockers(moduleUri: vscode.Uri, keepUris: Set<string> = new Set()): Promise<void> {
const pattern = new vscode.RelativePattern(moduleUri, 'src/**/*.java');
const javaFiles = await vscode.workspace.findFiles(pattern);

for (const javaFile of javaFiles) {
const baseName = path.basename(javaFile.fsPath, '.java');
const isGeneratedBlocker = baseName.startsWith(BUILD_BLOCKER_CLASS_PREFIX) || baseName === 'ModuleManagerDependencyViolationBlocker';
if (!isGeneratedBlocker || keepUris.has(javaFile.toString())) {
continue;
}

await deleteFileIfExists(javaFile);
}
}

/**
 * Writes a .classpath that excludes all sources from the violating module so the Java compiler
 * finds nothing to compile. This is a belt-and-suspenders complement to the compile-error file
 * and is more reliable when project isolation is not yet fully enforced by the Java Language Server.
 */
async function writeBlockedClasspathFile(moduleUri: vscode.Uri): Promise<void> {
const classpathUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.ECLIPSE_CLASSPATH);
await vscode.workspace.fs.writeFile(classpathUri, Buffer.from(BLOCKED_CLASSPATH_CONTENT));
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
return value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
}

function offsetToPosition(source: string, offset: number): vscode.Position {
const safeOffset = Math.max(0, Math.min(offset, source.length));
const precedingText = source.slice(0, safeOffset);
const lines = precedingText.split(/\r?\n/);
const line = Math.max(0, lines.length - 1);
const character = lines[lines.length - 1]?.length ?? 0;
return new vscode.Position(line, character);
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
