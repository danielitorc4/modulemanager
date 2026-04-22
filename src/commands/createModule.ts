import * as path from 'path';
import * as vscode from 'vscode';
import { promptUserToSelectDirectory, getWorkspaceFolder, parseJsonWithComments } from '../utils/utils';
import { ModuleConfig } from '../types';
import { CONFIG_PATHS, REGEX } from '../constants';
import { syncAllModules } from '../build/buildFileManager';
import { findModuleDescriptors, writeModuleDescriptor } from '../moduleDescriptors';
import { pomTemplate, buildGradleTemplate } from '../build/templates';
import { precheckMavenModule } from '../build/mavenPrecheck';

const MANAGED_REFERENCED_LIBRARY_PATTERNS = ['lib/**/*.jar', '**/lib/**/*.jar', '**/target/dependency/*.jar'];
const MANAGED_GENERATED_BLOCKER_PATTERNS = ['**/ModuleManagerDependencyViolationBlocker.java', '**/ModuleManagerDependencyViolationBlocker__*.java'];

export interface WorkspaceModuleTypeSummary {
	hasBasicModules: boolean;
	hasMavenModules: boolean;
	hasGradleModules: boolean;
}

export async function createModule(resourceUri?: vscode.Uri): Promise<vscode.Uri | null> {
	const workspaceFolder = resourceUri
		? vscode.workspace.getWorkspaceFolder(resourceUri) ?? null
		: await getWorkspaceFolder();
	if (!workspaceFolder) {
		return null;
	}

	const parentUri = await resolveParentDirectory(resourceUri);
	if (!parentUri) {
		return null;
	}

	if (!isInsideWorkspace(workspaceFolder.uri, parentUri)) {
		vscode.window.showErrorMessage('Selected module directory must be inside the workspace folder.');
		return null;
	}

	const moduleName = await vscode.window.showInputBox({
		prompt: 'Enter module name:',
		value: 'new-module',
		validateInput: input => {
			if (!input || input.trim() === '') {
				return 'Module name cannot be empty.';
			}
			if (!REGEX.MODULE_NAME.test(input)) {
				return 'Module name can only contain letters, numbers, hyphens, and underscores.';
			}
			return null;
		}
	});

	if (!moduleName) {
		return null;
	}

	const moduleType = await vscode.window.showQuickPick(
		[
			{ label: 'Basic Module', value: 'basic', description: 'Eclipse metadata-managed Java module' },
			{ label: 'Maven Module', value: 'maven', description: 'Module with user-managed pom.xml' },
			{ label: 'Gradle Module', value: 'gradle', description: 'Module with user-managed build.gradle' }
		],
		{ placeHolder: 'Select module type' }
	);

	if (!moduleType) {
		return null;
	}

	const moduleUri = vscode.Uri.joinPath(parentUri, moduleName);
	if (await fileExists(moduleUri)) {
		vscode.window.showErrorMessage(`A directory named "${moduleName}" already exists at ${parentUri.fsPath}.`);
		return null;
	}

	let createdModuleDirectory = false;

	try {
		await vscode.workspace.fs.createDirectory(moduleUri);
		createdModuleDirectory = true;

		await createModuleStructure(moduleUri, moduleType.value as ModuleConfig['type']);
		if (moduleType.value === 'maven') {
			await runMavenPrecheck(moduleUri, workspaceFolder.uri);
		}

		const descriptor: ModuleConfig = {
			name: moduleName,
			type: moduleType.value as ModuleConfig['type'],
			createdAt: new Date().toISOString(),
			dependencies: []
		};

		await writeModuleDescriptor(moduleUri, descriptor);

		await updateVSCodeSettings(workspaceFolder.uri);
		await syncAllModules(workspaceFolder.uri);
		vscode.window.showInformationMessage(`Module "${moduleName}" created successfully!`);
		return moduleUri;
	} catch (error) {
		if (createdModuleDirectory) {
			try {
				await vscode.workspace.fs.delete(moduleUri, { recursive: true, useTrash: false });
			} catch (cleanupError) {
				console.error(`Failed to clean up partially created module at ${moduleUri.fsPath}:`, cleanupError);
			}
		}

		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to create module: ${errorMessage}`);
		return null;
	}
}

async function createModuleStructure(moduleUri: vscode.Uri, type: ModuleConfig['type']): Promise<void> {
	// helper to create standard Java source/resource/test directories
	async function createJavaDirs(targetUri: vscode.Uri): Promise<void> {
		const dirs = ['src/main/java', 'src/main/resources', 'src/test/java'];
		for (const dir of dirs) {
			const dirUri = vscode.Uri.joinPath(targetUri, dir);
			await vscode.workspace.fs.createDirectory(dirUri);
		}
	}

	switch (type) {
		case 'basic': {
			await createJavaDirs(moduleUri);
			break;
		}
		case 'maven': {
			await createJavaDirs(moduleUri);

			const artifactId = path.basename(moduleUri.fsPath);
			const pom = pomTemplate(artifactId);
			const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
			await vscode.workspace.fs.writeFile(pomUri, Buffer.from(pom));
			break;
		}
		case 'gradle': {
			await createJavaDirs(moduleUri);

			const buildGradle = buildGradleTemplate();
			const gradleUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.BUILD_GRADLE);
			await vscode.workspace.fs.writeFile(gradleUri, Buffer.from(buildGradle));
			break;
		}
	}

	const readmeUri = vscode.Uri.joinPath(moduleUri, 'README.md');
	await vscode.workspace.fs.writeFile(
		readmeUri,
		Buffer.from(buildModuleReadme(path.basename(moduleUri.fsPath), type))
	);
}

export async function isModule(uri: vscode.Uri): Promise<boolean> {
	try {
		const moduleDescriptorUri = vscode.Uri.joinPath(uri, CONFIG_PATHS.MODULE_DESCRIPTOR);
		await vscode.workspace.fs.stat(moduleDescriptorUri);
		return true;
	} catch {
		return false;
	}
}

export async function getRegisteredModules(workspaceUri: vscode.Uri): Promise<ModuleConfig[]> {
	const modules = await findModuleDescriptors(workspaceUri);
	return modules.map(module => ({
		...module.descriptor,
		path: module.modulePath
	}));
}

async function resolveParentDirectory(resourceUri?: vscode.Uri): Promise<vscode.Uri | null> {
	if (!resourceUri) {
		return promptUserToSelectDirectory();
	}

	try {
		const stat = await vscode.workspace.fs.stat(resourceUri);
		if (stat.type & vscode.FileType.Directory) {
			return resourceUri;
		}
	} catch {
		// Fallback to parent directory below.
	}

	return vscode.Uri.file(path.dirname(resourceUri.fsPath));
}

function isInsideWorkspace(workspaceUri: vscode.Uri, selectedUri: vscode.Uri): boolean {
	const workspacePath = path.resolve(workspaceUri.fsPath);
	const selectedPath = path.resolve(selectedUri.fsPath);
	const relativePath = path.relative(workspacePath, selectedPath);

	return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

async function updateVSCodeSettings(workspaceUri: vscode.Uri): Promise<void> {
	const vscodeDir = vscode.Uri.joinPath(workspaceUri, '.vscode');
	const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');

	try {
		await vscode.workspace.fs.createDirectory(vscodeDir);

		let settings: Record<string, unknown> = {};
		if (await fileExists(settingsUri)) {
			try {
				const settingsData = await vscode.workspace.fs.readFile(settingsUri);
				const settingsText = Buffer.from(settingsData).toString();
				const parsed = parseJsonWithComments<unknown>(settingsText);
				if (!isRecord(parsed)) {
					vscode.window.showWarningMessage(
						'Skipped ModuleManager settings update because .vscode/settings.json does not contain a JSON object.'
					);
					return;
				}

				settings = parsed;
			} catch (error) {
				vscode.window.showWarningMessage(
					'Skipped ModuleManager settings update because .vscode/settings.json could not be parsed safely.'
				);
				console.warn('Could not parse VS Code settings. Skipping settings update to avoid overwriting user config.', error);
				return;
			}
		}

		const descriptors = await findModuleDescriptors(workspaceUri);
		const moduleTypeSummary = summarizeWorkspaceModuleTypes(descriptors.map(module => module.descriptor.type));
		const updatedSettings = applyManagedWorkspaceSettings(settings, moduleTypeSummary);

		await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(updatedSettings, null, 2)));
	} catch (error) {
		console.error('Could not update VSCode settings:', error);
	}
}

async function runMavenPrecheck(moduleUri: vscode.Uri, workspaceUri: vscode.Uri): Promise<void> {
	const precheck = await precheckMavenModule(moduleUri, workspaceUri);
	if (!precheck.ok) {
		throw new Error(precheck.failure.message);
	}
}

function buildModuleReadme(moduleName: string, type: ModuleConfig['type']): string {
	const base = `# ${moduleName}\n\nModule created on ${new Date().toLocaleString()}\n`;

	if (type !== 'maven') {
		return base;
	}

	return [
		base.trimEnd(),
		'',
		'## Maven-first build guidance',
		'Run compile/test from Maven so classpath resolution comes from pom.xml, not only from bin.',
		'',
		'```bash',
		'mvn -f pom.xml clean compile',
		'mvn -f pom.xml test',
		'```',
		''
	].join('\n');
}

export function summarizeWorkspaceModuleTypes(moduleTypes: ModuleConfig['type'][]): WorkspaceModuleTypeSummary {
	return {
		hasBasicModules: moduleTypes.includes('basic'),
		hasMavenModules: moduleTypes.includes('maven'),
		hasGradleModules: moduleTypes.includes('gradle')
	};
}

export function applyManagedWorkspaceSettings(
	settings: Record<string, unknown>,
	moduleTypeSummary: WorkspaceModuleTypeSummary
): Record<string, unknown> {
	const updatedSettings = { ...settings };
	const filesExclude = asRecord(updatedSettings['files.exclude']);
	filesExclude[`**/${CONFIG_PATHS.MODULE_DESCRIPTOR}`] = true;
	filesExclude[`**/${CONFIG_PATHS.ECLIPSE_PROJECT}`] = true;
	filesExclude[`**/${CONFIG_PATHS.ECLIPSE_CLASSPATH}`] = true;
	for (const pattern of MANAGED_GENERATED_BLOCKER_PATTERNS) {
		filesExclude[pattern] = true;
	}
	updatedSettings['files.exclude'] = filesExclude;

	if (moduleTypeSummary.hasMavenModules) {
		updatedSettings['java.import.maven.enabled'] = true;
		updatedSettings['maven.executable.preferMavenWrapper'] = true;
	} else {
		delete updatedSettings['java.import.maven.enabled'];
		delete updatedSettings['maven.executable.preferMavenWrapper'];
	}

	if (moduleTypeSummary.hasMavenModules || moduleTypeSummary.hasGradleModules) {
		updatedSettings['java.configuration.updateBuildConfiguration'] = 'automatic';
	} else {
		delete updatedSettings['java.configuration.updateBuildConfiguration'];
	}

	const referencedLibraries = applyReferencedLibrariesPolicy(
		updatedSettings['java.project.referencedLibraries'],
		moduleTypeSummary.hasBasicModules
	);
	if (referencedLibraries === undefined) {
		delete updatedSettings['java.project.referencedLibraries'];
	} else {
		updatedSettings['java.project.referencedLibraries'] = referencedLibraries;
	}

	return updatedSettings;
}

export function applyReferencedLibrariesPolicy(currentValue: unknown, shouldManagePatterns: boolean): unknown {
	if (shouldManagePatterns) {
		return mergeReferencedLibrariesSetting(currentValue);
	}

	return removeManagedReferencedLibrariesSetting(currentValue);
}

function mergeReferencedLibrariesSetting(currentValue: unknown): unknown {
	const requiredPatterns = MANAGED_REFERENCED_LIBRARY_PATTERNS;

	if (Array.isArray(currentValue)) {
		const existing = currentValue.filter((entry): entry is string => typeof entry === 'string');
		return Array.from(new Set([...existing, ...requiredPatterns]));
	}

	if (isRecord(currentValue)) {
		const includeValue = currentValue.include;
		const include = Array.isArray(includeValue)
			? includeValue.filter((entry): entry is string => typeof entry === 'string')
			: [];

		return {
			...currentValue,
			include: Array.from(new Set([...include, ...requiredPatterns]))
		};
	}

	return requiredPatterns;
}

function removeManagedReferencedLibrariesSetting(currentValue: unknown): unknown {
	if (Array.isArray(currentValue)) {
		const existing = currentValue.filter((entry): entry is string => typeof entry === 'string');
		const filtered = existing.filter(entry => !MANAGED_REFERENCED_LIBRARY_PATTERNS.includes(entry));
		return filtered.length > 0 ? filtered : undefined;
	}

	if (isRecord(currentValue)) {
		const includeValue = currentValue.include;
		if (!Array.isArray(includeValue)) {
			return currentValue;
		}

		const include = includeValue
			.filter((entry): entry is string => typeof entry === 'string')
			.filter(entry => !MANAGED_REFERENCED_LIBRARY_PATTERNS.includes(entry));

		const updated = { ...currentValue };
		if (include.length > 0) {
			updated.include = include;
		} else {
			delete updated.include;
		}

		return Object.keys(updated).length > 0 ? updated : undefined;
	}

	return currentValue;
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? { ...value } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
