import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { findModuleDescriptors } from '../moduleDescriptors';
import * as gradleManager from './gradleManager';
import * as pomManager from './pomManager';

export async function syncAllModules(workspaceUri: vscode.Uri): Promise<void> {
    const modules = await findModuleDescriptors(workspaceUri);

    for (const module of modules) {
        const { descriptor, moduleUri } = module;

        if (descriptor.type === 'basic') {
            const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
            const hasPom = await fileExists(pomUri);
            if (!hasPom) {
                await pomManager.generateMinimalPom(moduleUri, descriptor);
            }

            await pomManager.syncModuleDependencies(moduleUri, descriptor.dependencies, modules);
            continue;
        }

        if (descriptor.type === 'maven') {
            const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
            if (await fileExists(pomUri)) {
                await pomManager.syncModuleDependencies(moduleUri, descriptor.dependencies, modules);
            }
            continue;
        }

        const gradleUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.BUILD_GRADLE);
        if (await fileExists(gradleUri)) {
            await gradleManager.syncModuleDependencies(moduleUri, descriptor.dependencies, modules);
        }
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
