import * as path from 'path';
import * as vscode from 'vscode';
import { promptUserToSelectDirectory } from '../utils/utils';
import { ModuleConfig } from '../types';
import { CONFIG_PATHS, REGEX } from '../constants';
import { reconcileWorkspaceModel } from '../build/buildFileManager';
import { findModuleDescriptors, writeModuleDescriptor } from '../moduleDescriptors';
import { buildGradleTemplate, pomTemplate } from '../build/templates';
import { precheckMavenModule } from '../build/mavenPrecheck';
import { resolveManagementRootUri } from '../workspace/managedWorkspace';

export async function createModule(resourceUri?: vscode.Uri): Promise<vscode.Uri | null> {
    const managementRootUri = await resolveManagementRootUri(resourceUri);
    if (!managementRootUri) {
        return null;
    }

    const parentUri = await resolveParentDirectory(resourceUri, managementRootUri);
    if (!parentUri) {
        return null;
    }

    if (!isInsideWorkspace(managementRootUri, parentUri)) {
        vscode.window.showErrorMessage('Selected module directory must be inside the managed workspace root.');
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
            { label: 'Basic Module', value: 'basic', description: 'JDTLS metadata-managed Java module' },
            { label: 'Maven Module', value: 'maven', description: 'Java module initialized with pom.xml' },
            { label: 'Gradle Module', value: 'gradle', description: 'Java module initialized with build.gradle' }
        ],
        { placeHolder: 'Select module bootstrap type' }
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
            await runMavenPrecheck(moduleUri, managementRootUri);
        }

        const descriptor: ModuleConfig = {
            name: moduleName,
            type: moduleType.value as ModuleConfig['type'],
            createdAt: new Date().toISOString(),
            dependencies: []
        };

        await writeModuleDescriptor(moduleUri, descriptor);
        await reconcileWorkspaceModel(moduleUri);

        vscode.window.showInformationMessage(`Module "${moduleName}" created successfully.`);
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
    async function createJavaDirs(targetUri: vscode.Uri): Promise<void> {
        const dirs = ['src/main/java', 'src/main/resources', 'src/test/java'];
        for (const dir of dirs) {
            const dirUri = vscode.Uri.joinPath(targetUri, dir);
            await vscode.workspace.fs.createDirectory(dirUri);
        }
    }

    await createJavaDirs(moduleUri);

    if (type === 'maven') {
        const artifactId = path.basename(moduleUri.fsPath);
        const pom = pomTemplate(artifactId);
        const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
        await vscode.workspace.fs.writeFile(pomUri, Buffer.from(pom));
        return;
    }

    if (type === 'gradle') {
        const buildGradle = buildGradleTemplate();
        const gradleUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.BUILD_GRADLE);
        await vscode.workspace.fs.writeFile(gradleUri, Buffer.from(buildGradle));
    }
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

async function resolveParentDirectory(resourceUri: vscode.Uri | undefined, managementRootUri: vscode.Uri): Promise<vscode.Uri | null> {
    if (!resourceUri) {
        const selectedDirectory = await promptUserToSelectDirectory();
        return selectedDirectory ?? managementRootUri;
    }

    try {
        const stat = await vscode.workspace.fs.stat(resourceUri);
        if (stat.type & vscode.FileType.Directory) {
            return resourceUri;
        }
    } catch {
        // Fall back to parent directory resolution below.
    }

    return vscode.Uri.file(path.dirname(resourceUri.fsPath));
}

function isInsideWorkspace(workspaceUri: vscode.Uri, selectedUri: vscode.Uri): boolean {
    const workspacePath = path.resolve(workspaceUri.fsPath);
    const selectedPath = path.resolve(selectedUri.fsPath);
    const relativePath = path.relative(workspacePath, selectedPath);

    return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

async function runMavenPrecheck(moduleUri: vscode.Uri, workspaceUri: vscode.Uri): Promise<void> {
    const precheck = await precheckMavenModule(moduleUri, workspaceUri);
    if (!precheck.ok) {
        throw new Error(precheck.failure.message);
    }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
