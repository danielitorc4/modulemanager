import * as path from 'path';
import * as vscode from 'vscode';
import { promptUserToSelectDirectory, getWorkspaceFolder } from '../utils/utils';
import { ModuleConfig } from '../types';
import { CONFIG_PATHS, REGEX } from '../constants';
import { generateMinimalPom } from '../build/pomManager';
import { syncAllModules } from '../build/buildFileManager';
import { findModuleDescriptors, writeModuleDescriptor } from '../moduleDescriptors';

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
			{ label: 'Basic Module', value: 'basic', description: 'Simple module structure' },
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
		const structure = await createModuleStructure(moduleUri, moduleType.value as ModuleConfig['type']);
		const descriptor: ModuleConfig = {
			name: moduleName,
			type: moduleType.value as ModuleConfig['type'],
			createdAt: new Date().toISOString(),
			dependencies: [],
			sourceRoot: 'src',
			structure
		};

		await writeModuleDescriptor(moduleUri, descriptor);

		if (descriptor.type === 'basic') {
			await generateMinimalPom(moduleUri, descriptor);
		}

		await updateVSCodeSettings(workspaceFolder.uri, descriptor.type);
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

async function createModuleStructure(moduleUri: vscode.Uri, type: ModuleConfig['type']): Promise<string[]> {
	const structure: string[] = [];

	switch (type) {
		case 'basic': {
			const dirs = ['src/main/java', 'src/main/resources', 'src/test/java'];
			for (const dir of dirs) {
				const dirUri = vscode.Uri.joinPath(moduleUri, dir);
				await vscode.workspace.fs.createDirectory(dirUri);
				structure.push(dir);
			}
			break;
		}
		case 'maven':
		case 'gradle': {
			const dirs = ['src/main/java', 'src/main/resources', 'src/test/java'];
			for (const dir of dirs) {
				const dirUri = vscode.Uri.joinPath(moduleUri, dir);
				await vscode.workspace.fs.createDirectory(dirUri);
				structure.push(dir);
			}
			break;
		}
	}

	const readmeUri = vscode.Uri.joinPath(moduleUri, 'README.md');
	await vscode.workspace.fs.writeFile(
		readmeUri,
		Buffer.from(`# ${path.basename(moduleUri.fsPath)}\n\nModule created on ${new Date().toLocaleString()}\n`)
	);
	structure.push('README.md');

	return structure;
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

async function updateVSCodeSettings(workspaceUri: vscode.Uri, moduleType: ModuleConfig['type']): Promise<void> {
	const vscodeDir = vscode.Uri.joinPath(workspaceUri, '.vscode');
	const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');

	try {
		await vscode.workspace.fs.createDirectory(vscodeDir);

		let settings: any = {};
		try {
			const settingsData = await vscode.workspace.fs.readFile(settingsUri);
			const settingsText = Buffer.from(settingsData).toString();
			settings = JSON.parse(settingsText.replace(REGEX.JSON_COMMENTS, ''));
		} catch {
			// Initialize empty settings if file doesn't exist or has invalid JSON.
		}

		if (!settings['files.exclude']) {
			settings['files.exclude'] = {};
		}

		settings['files.exclude'][`**/${CONFIG_PATHS.MODULE_DESCRIPTOR}`] = true;
		if (moduleType === 'basic') {
			settings['files.exclude'][`**/${CONFIG_PATHS.POM_XML}`] = true;
		}

		await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(settings, null, 2)));
	} catch (error) {
		console.error('Could not update VSCode settings:', error);
	}
}
