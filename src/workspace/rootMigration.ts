import * as path from 'path';
import * as vscode from 'vscode';
import { REGEX } from '../constants';
import { findModuleDescriptors, shouldIgnoreModuleDescriptorPath, writeModuleDescriptor } from '../moduleDescriptors';
import { ModuleConfig } from '../types';

const JAVA_SCAN_EXCLUDE = '**/{node_modules,target,build,out,bin,dist,.modulemanager,.git,.idea,.vscode,.settings}/**';

const FOLDERS_TO_MOVE = ['src', 'lib', 'resources'];
const FOLDERS_TO_DELETE = ['bin', 'target', 'out', 'build'];
const FILES_TO_DELETE = ['.project', '.classpath'];
const DIRS_TO_DELETE = ['.settings'];

export interface RootMigrationContext {
    rootUri: vscode.Uri;
    rootHasLooseJava: boolean;
    hasChildModules: boolean;
    hasRootDescriptor: boolean;
}

export async function describeRootState(rootUri: vscode.Uri): Promise<RootMigrationContext> {
    const descriptors = await findModuleDescriptors(rootUri);
    const hasRootDescriptor = descriptors.some(module => !module.modulePath || module.modulePath === '.');
    const childPaths = descriptors
        .filter(module => module.modulePath && module.modulePath !== '.')
        .map(module => module.modulePath.replace(/\\/g, '/'));

    return {
        rootUri,
        rootHasLooseJava: await rootHasLooseJavaCode(rootUri, childPaths),
        hasChildModules: childPaths.length > 0,
        hasRootDescriptor
    };
}

export async function rootHasLooseJavaCode(rootUri: vscode.Uri, childModulePaths?: string[]): Promise<boolean> {
    const childPaths = childModulePaths ?? (await findModuleDescriptors(rootUri))
        .filter(module => module.modulePath && module.modulePath !== '.')
        .map(module => module.modulePath.replace(/\\/g, '/'));

    const javaFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(rootUri, '**/*.java'),
        JAVA_SCAN_EXCLUDE
    );

    for (const file of javaFiles) {
        if (shouldIgnoreModuleDescriptorPath(file.fsPath)) {
            continue;
        }
        const relativePath = path.relative(rootUri.fsPath, file.fsPath).replace(/\\/g, '/');
        const insideChildModule = childPaths.some(
            childPath => relativePath === childPath || relativePath.startsWith(`${childPath}/`)
        );
        if (insideChildModule) {
            continue;
        }
        return true;
    }

    return false;
}

export function suggestRootModuleName(rootUri: vscode.Uri): string {
    const folderName = path.basename(rootUri.fsPath);
    const sanitized = folderName.replace(/[^a-zA-Z0-9-_]/g, '_');
    if (!sanitized) {
        return 'core';
    }
    return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
}

export async function promptForMigration(rootUri: vscode.Uri, modal: boolean): Promise<string | null> {
    const message =
        'ModuleManager detected Java code at the workspace root. ' +
        'To support multiple modules, that code must first be moved into its own module — ' +
        'JDTLS does not allow a Java project to be nested inside another Java project.';

    const choice = await vscode.window.showInformationMessage(
        message,
        modal ? { modal: true } : {},
        'Move into Module',
        'Cancel'
    );
    if (choice !== 'Move into Module') {
        return null;
    }

    const defaultName = suggestRootModuleName(rootUri);
    const moduleName = await vscode.window.showInputBox({
        prompt: 'Name for the module that will hold the existing root code:',
        value: defaultName,
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

    return moduleName ?? null;
}

export async function convertRootCodeToModule(rootUri: vscode.Uri, moduleName: string): Promise<vscode.Uri> {
    const moduleUri = vscode.Uri.joinPath(rootUri, moduleName);
    if (await pathExists(moduleUri)) {
        throw new Error(`A folder named "${moduleName}" already exists at the workspace root.`);
    }

    await vscode.workspace.fs.createDirectory(moduleUri);

    for (const folder of FOLDERS_TO_MOVE) {
        const source = vscode.Uri.joinPath(rootUri, folder);
        if (!(await pathExists(source))) {
            continue;
        }
        const target = vscode.Uri.joinPath(moduleUri, folder);
        await vscode.workspace.fs.rename(source, target, { overwrite: false });
    }

    for (const folder of FOLDERS_TO_DELETE) {
        const target = vscode.Uri.joinPath(rootUri, folder);
        if (!(await pathExists(target))) {
            continue;
        }
        await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
    }

    for (const file of FILES_TO_DELETE) {
        const target = vscode.Uri.joinPath(rootUri, file);
        if (!(await pathExists(target))) {
            continue;
        }
        await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
    }

    for (const dir of DIRS_TO_DELETE) {
        const target = vscode.Uri.joinPath(rootUri, dir);
        if (!(await pathExists(target))) {
            continue;
        }
        await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
    }

    const descriptor: ModuleConfig = {
        name: moduleName,
        type: 'basic',
        createdAt: new Date().toISOString(),
        dependencies: []
    };
    await writeModuleDescriptor(moduleUri, descriptor);

    return moduleUri;
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
