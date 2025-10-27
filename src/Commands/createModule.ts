import * as vscode from 'vscode';
import * as path from 'path';
import { updateProjectConfig } from '../config/configManager';
import { promptUserToSelectDirectory } from '../utils/utils';

interface ModuleConfig {
    name: string;
    type: 'basic' | 'maven' | 'gradle'; // Extensible for future build systems
    createdAt: string;
    structure: string[];
}

interface ProjectModules {
    modules: ModuleConfig[];
}

const MODULE_CONFIG_FILE = '.vscode/modules.json';

export async function createModule(): Promise<vscode.Uri | null> {
    // Get workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return null;
    }

    // Select workspace folder if there are multiple
    let workspaceFolder: vscode.WorkspaceFolder;
    if (workspaceFolders.length > 1) {
        const selected = await vscode.window.showQuickPick(
            workspaceFolders.map(folder => ({
                label: folder.name,
                description: folder.uri.fsPath,
                folder: folder
            })),
            {
                placeHolder: 'Select workspace folder for the new module'
            }
        );
        
        if (!selected) {
            return null;
        }
        workspaceFolder = selected.folder;
    } else {
        workspaceFolder = workspaceFolders[0];
    }

    // Select parent directory for the module
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
            if (!/^[a-zA-Z0-9-_]+$/.test(input)) {
                return 'Module name can only contain letters, numbers, hyphens, and underscores.';
            }
            return null;
        }
    });

    if (!moduleName) {
        return null;
    }

    // Select module type (extensible for future build systems)
    const moduleType = await vscode.window.showQuickPick(
        [
            { label: 'Basic Module', value: 'basic', description: 'Simple module structure' },
            { label: 'Maven Module', value: 'maven', description: 'Maven-based module (coming soon)', detail: 'Not yet implemented' },
            { label: 'Gradle Module', value: 'gradle', description: 'Gradle-based module (coming soon)', detail: 'Not yet implemented' }
        ],
        {
            placeHolder: 'Select module type'
        }
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

        // Create a .module marker file to distinguish from regular directories
        const moduleMarkerUri = vscode.Uri.joinPath(moduleUri, '.module');
        await vscode.workspace.fs.writeFile(
            moduleMarkerUri,
            Buffer.from(JSON.stringify({
                name: moduleName,
                type: moduleType.value,
                createdAt: new Date().toISOString()
            }, null, 2))
        );

        // Update project configuration (tsconfig/jsconfig, .gitignore, VSCode settings)
        const relativePath = path.relative(workspaceFolder.uri.fsPath, moduleUri.fsPath);
        await updateProjectConfig(workspaceFolder.uri, relativePath);

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
            // Create IntelliJ-like structure
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
            // Future implementation for Maven structure
            // src/main/java, src/main/resources, src/test/java, pom.xml, etc.
            break;

        case 'gradle':
            // Future implementation for Gradle structure
            // src/main/java, src/main/resources, build.gradle, etc.
            break;
    }

    return structure;
}

async function registerModule(workspaceUri: vscode.Uri, moduleConfig: ModuleConfig): Promise<void> {
    const configUri = vscode.Uri.joinPath(workspaceUri, MODULE_CONFIG_FILE);
    
    let projectModules: ProjectModules = { modules: [] };

    try {
        // Try to read existing config
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

    // Add new module to the list
    projectModules.modules.push(moduleConfig);

    // Write updated config
    await vscode.workspace.fs.writeFile(
        configUri,
        Buffer.from(JSON.stringify(projectModules, null, 2))
    );
}

// Utility function to check if a directory is a module
export async function isModule(uri: vscode.Uri): Promise<boolean> {
    try {
        const moduleMarkerUri = vscode.Uri.joinPath(uri, '.module');
        await vscode.workspace.fs.stat(moduleMarkerUri);
        return true;
    } catch {
        return false;
    }
}

// Utility function to get all registered modules
export async function getRegisteredModules(workspaceUri: vscode.Uri): Promise<ModuleConfig[]> {
    try {
        const configUri = vscode.Uri.joinPath(workspaceUri, MODULE_CONFIG_FILE);
        const configData = await vscode.workspace.fs.readFile(configUri);
        const projectModules: ProjectModules = JSON.parse(Buffer.from(configData).toString());
        return projectModules.modules;
    } catch {
        return [];
    }
}