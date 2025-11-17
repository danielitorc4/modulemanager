import * as vscode from 'vscode';
import * as path from 'path';
import { promptUserToSelectDirectory, getWorkspaceFolder } from '../utils/utils';
import { ModuleConfig, ProjectModules } from '../types';
import { CONFIG_PATHS, REGEX } from '../constants';

export async function createModule(): Promise<vscode.Uri | null> {
    // Get workspace folder
    const workspaceFolder = await getWorkspaceFolder();
    if (!workspaceFolder) {
        return null;
    }

    // Get module parent directory
    const parentUri = await promptUserToSelectDirectory();
    if (!parentUri) {
        return null;
    }

    // Get module name
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

    // Select module type
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

    // For now, only basic is implemented
    if (moduleType.value !== 'basic') {
        vscode.window.showWarningMessage(`${moduleType.label} is not yet implemented. Creating a basic module instead.`);
    }

    const moduleUri = vscode.Uri.joinPath(parentUri, moduleName);

    try {
        // Create module directory structure
        const structure = await createModuleStructure(moduleUri, moduleType.value as ModuleConfig['type']);

        // Register the module in the project configuration
        await registerModule(workspaceFolder.uri, {
            name: moduleName,
            type: moduleType.value as ModuleConfig['type'],
            createdAt: new Date().toISOString(),
            structure
        });

        // Create a .module marker file
        const moduleMarkerUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.MODULE_MARKER);
        await vscode.workspace.fs.writeFile(
            moduleMarkerUri,
            Buffer.from(JSON.stringify({
                name: moduleName,
                type: moduleType.value,
                createdAt: new Date().toISOString()
            }, null, 2))
        );

        // (Optional) Update project configuration, e.g., tsconfig
        // await updateProjectConfig(workspaceFolder.uri, moduleUri, moduleName);

        vscode.window.showInformationMessage(`Module "${moduleName}" created successfully!`);
        return moduleUri;

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create module: ${error}`);
        return null;
    }
}

async function createModuleStructure(moduleUri: vscode.Uri, type: ModuleConfig['type']): Promise<string[]> {
    const structure: string[] = [];

    switch (type) {
        case 'basic':
            const dirs = ['src', 'test', 'resources', 'lib'];
            for (const dir of dirs) {
                const dirUri = vscode.Uri.joinPath(moduleUri, dir);
                await vscode.workspace.fs.createDirectory(dirUri);
                structure.push(dir);
            }
            // Create a README.md in the module
            const readmeUri = vscode.Uri.joinPath(moduleUri, 'README.md');
            await vscode.workspace.fs.writeFile(
                readmeUri,
                Buffer.from(`# ${path.basename(moduleUri.fsPath)}\n\nModule created on ${new Date().toLocaleString()}\n`)
            );
            structure.push('README.md');
            break;
        case 'maven':
        case 'gradle':
            // Future implementation
            break;
    }

    return structure;
}

async function registerModule(workspaceUri: vscode.Uri, moduleConfig: ModuleConfig): Promise<void> {
    const configUri = vscode.Uri.joinPath(workspaceUri, CONFIG_PATHS.MODULES_JSON);
    let projectModules: ProjectModules = { modules: {} };

    try {
        const configData = await vscode.workspace.fs.readFile(configUri);
        projectModules = JSON.parse(Buffer.from(configData).toString());
    } catch (error) {
        // Config doesn't exist yet, create .vscode directory
        const vscodeDir = vscode.Uri.joinPath(workspaceUri, '.vscode');
        try {
            await vscode.workspace.fs.createDirectory(vscodeDir);
        } catch {
            // Directory might already exist
        }
    }

    projectModules.modules[moduleConfig.name] = moduleConfig;

    await vscode.workspace.fs.writeFile(
        configUri,
        Buffer.from(JSON.stringify(projectModules, null, 2))
    );
}

// Utility function to check if a directory is a module
export async function isModule(uri: vscode.Uri): Promise<boolean> {
    try {
        const moduleMarkerUri = vscode.Uri.joinPath(uri, CONFIG_PATHS.MODULE_MARKER);
        await vscode.workspace.fs.stat(moduleMarkerUri);
        return true;
    } catch {
        return false;
    }
}

// Utility function to get all registered modules
export async function getRegisteredModules(workspaceUri: vscode.Uri): Promise<ModuleConfig[]> {
    try {
        const configUri = vscode.Uri.joinPath(workspaceUri, CONFIG_PATHS.MODULES_JSON);
        const configData = await vscode.workspace.fs.readFile(configUri);
        const projectModules: ProjectModules = JSON.parse(Buffer.from(configData).toString());
        return Object.values(projectModules.modules);
    } catch {
        return [];
    }
}