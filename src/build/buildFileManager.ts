import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { findModuleDescriptors } from '../moduleDescriptors';
import * as gradleManager from './gradleManager';
import * as eclipseMetadataManager from './eclipseMetadataManager';
import * as pomManager from './pomManager';

export async function syncAllModules(workspaceUri: vscode.Uri): Promise<void> {
    const modules = await findModuleDescriptors(workspaceUri);

    for (const module of modules) {
        const { descriptor, moduleUri } = module;

        if (descriptor.type === 'basic') {
            await eclipseMetadataManager.syncModuleMetadata(workspaceUri, module, modules);
            continue;
        }

        await removeEclipseMetadata(moduleUri);

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

async function removeEclipseMetadata(moduleUri: vscode.Uri): Promise<void> {
    const eclipseMetadataUris = [
        vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.ECLIPSE_PROJECT),
        vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.ECLIPSE_CLASSPATH)
    ];

    for (const metadataUri of eclipseMetadataUris) {
        try {
            await vscode.workspace.fs.delete(metadataUri, { recursive: false, useTrash: false });
        } catch {
            // Ignore missing files to keep sync idempotent.
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
