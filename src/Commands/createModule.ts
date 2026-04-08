import * as path from 'path';
import * as vscode from 'vscode';
import { promptUserToSelectDirectory, getWorkspaceFolder } from '../utils/utils';
import { ModuleConfig } from '../types';
import { CONFIG_PATHS, REGEX } from '../constants';
import { syncWorkspaceModuleConfigs } from '../config/configManager';
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
			{ label: 'Maven Module', value: 'maven', description: 'Maven-based module (coming soon)', detail: 'Not yet implemented' },
			{ label: 'Gradle Module', value: 'gradle', description: 'Gradle-based module (coming soon)', detail: 'Not yet implemented' }
		],
		{ placeHolder: 'Select module type' }
	);

	if (!moduleType) {
		return null;
	}

	if (moduleType.value !== 'basic') {
		vscode.window.showWarningMessage(`${moduleType.label} is not yet implemented. Creating a basic module instead.`);
	}

	const moduleUri = vscode.Uri.joinPath(parentUri, moduleName);

	try {
		const structure = await createModuleStructure(moduleUri, moduleType.value as ModuleConfig['type']);
		await writeModuleDescriptor(moduleUri, {
			name: moduleName,
			type: moduleType.value as ModuleConfig['type'],
			createdAt: new Date().toISOString(),
			dependencies: [],
			sourceRoot: 'src',
			structure
		});

		await syncWorkspaceModuleConfigs(workspaceFolder.uri);
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
			const dirs = ['src', 'test', 'resources', 'lib'];
			for (const dir of dirs) {
				const dirUri = vscode.Uri.joinPath(moduleUri, dir);
				await vscode.workspace.fs.createDirectory(dirUri);
				structure.push(dir);
			}

			const readmeUri = vscode.Uri.joinPath(moduleUri, 'README.md');
			await vscode.workspace.fs.writeFile(
				readmeUri,
				Buffer.from(`# ${path.basename(moduleUri.fsPath)}\n\nModule created on ${new Date().toLocaleString()}\n`)
			);
			structure.push('README.md');
			break;
		}
		case 'maven':
		case 'gradle':
			break;
	}

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

export async function pruneDeletedModules(workspaceUri: vscode.Uri): Promise<void> {
	await syncWorkspaceModuleConfigs(workspaceUri);
}
