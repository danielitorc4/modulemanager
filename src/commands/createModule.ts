import * as path from 'path';
import * as vscode from 'vscode';
import { promptUserToSelectDirectory, getWorkspaceFolder } from '../utils/utils';
import { ModuleConfig } from '../types';
import { CONFIG_PATHS, REGEX } from '../constants';
import { syncAllModules } from '../build/buildFileManager';
import { findModuleDescriptors, writeModuleDescriptor } from '../moduleDescriptors';
import { pomTemplate, buildGradleTemplate } from '../build/templates';
import { precheckMavenModule } from '../build/mavenPrecheck';

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

	try {
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
		try {
			await vscode.workspace.fs.delete(moduleUri, { recursive: true, useTrash: false });
		} catch {
			// Best-effort cleanup.
		}

		vscode.window.showErrorMessage(`Failed to create module: ${error}`);
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
		try {
			const settingsData = await vscode.workspace.fs.readFile(settingsUri);
			const settingsText = Buffer.from(settingsData).toString();
			const parsed = JSON.parse(settingsText.replace(REGEX.JSON_COMMENTS, ''));
			if (isRecord(parsed)) {
				settings = parsed;
			}
		} catch {
			// Initialize empty settings if file doesn't exist or has invalid JSON.
		}

		const filesExclude = asRecord(settings['files.exclude']);
		filesExclude[`**/${CONFIG_PATHS.MODULE_DESCRIPTOR}`] = true;
		filesExclude[`**/${CONFIG_PATHS.ECLIPSE_PROJECT}`] = true;
		filesExclude[`**/${CONFIG_PATHS.ECLIPSE_CLASSPATH}`] = true;
		settings['files.exclude'] = filesExclude;

		// Keep Java tooling aligned with Maven projects so editor classpath stays in sync.
		settings['java.import.maven.enabled'] = true;
		settings['java.configuration.updateBuildConfiguration'] = 'automatic';
		settings['maven.executable.preferMavenWrapper'] = true;
		settings['java.project.referencedLibraries'] = mergeReferencedLibrariesSetting(
			settings['java.project.referencedLibraries']
		);

		await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(settings, null, 2)));
	} catch (error) {
		console.error('Could not update VSCode settings:', error);
	}
}

async function runMavenPrecheck(moduleUri: vscode.Uri, workspaceUri: vscode.Uri): Promise<void> {
	const precheck = await precheckMavenModule(moduleUri, workspaceUri);
	if (!precheck.ok) {
		vscode.window.showWarningMessage(precheck.failure.message);
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

function mergeReferencedLibrariesSetting(currentValue: unknown): unknown {
	const requiredPatterns = ['lib/**/*.jar', '**/lib/**/*.jar', '**/target/dependency/*.jar'];

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

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
