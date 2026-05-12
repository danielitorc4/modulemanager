import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { ManagedModule, WorkspaceModuleTypeSummary } from '../types';
import {
    discoverManagedModules,
    reconcileWorkspaceLayout,
    resolveManagementRootUri,
    summarizeWorkspaceModuleTypes
} from '../workspace/managedWorkspace';
import { syncDistributedWorkspaceSettings } from '../workspace/settingsSync';
import * as gradleManager from './gradleManager';
import * as eclipseMetadataManager from './eclipseMetadataManager';
import * as pomManager from './pomManager';

export interface WorkspaceReconcileResult {
    managementRootUri: vscode.Uri;
    modules: ManagedModule[];
    moduleTypeSummary: WorkspaceModuleTypeSummary;
    workspaceFoldersChanged: boolean;
    shouldCleanJavaWorkspace: boolean;
}

export async function reconcileWorkspaceModel(resourceUri?: vscode.Uri): Promise<WorkspaceReconcileResult | null> {
    const managementRootUri = await resolveManagementRootUri(resourceUri);
    if (!managementRootUri) {
        return null;
    }

    const modules = await discoverManagedModules(managementRootUri);
    const moduleTypeSummary = summarizeWorkspaceModuleTypes(modules.map(module => module.resolvedType));

    const layout = await reconcileWorkspaceLayout(managementRootUri, modules);
    await syncDistributedWorkspaceSettings(managementRootUri, modules, moduleTypeSummary);

    // If the workspace root is no longer a managed Java module, strip any stale
    // Eclipse metadata that a previous extension version (or JDTLS auto-import)
    // left behind. Otherwise JDTLS treats the root as a parent project nested
    // around the child module projects and refuses to load them cleanly.
    const rootIsManagedModule = modules.some(module => module.modulePath === '.');
    if (!rootIsManagedModule) {
        await eclipseMetadataManager.removeEclipseMetadata(managementRootUri);
    }

    for (const module of modules) {
        await syncSingleModule(managementRootUri, module, modules);
    }

    return {
        managementRootUri,
        modules,
        moduleTypeSummary,
        workspaceFoldersChanged: layout.workspaceFoldersChanged,
        shouldCleanJavaWorkspace: layout.workspaceFoldersChanged
    };
}

async function syncSingleModule(
    managementRootUri: vscode.Uri,
    module: ManagedModule,
    allModules: ManagedModule[]
): Promise<void> {
    if (module.resolvedType === 'basic') {
        await eclipseMetadataManager.syncModuleMetadata(managementRootUri, module, allModules);
    } else {
        await eclipseMetadataManager.removeEclipseMetadata(module.moduleUri);
    }

    if (module.resolvedType === 'maven') {
        const pomUri = vscode.Uri.joinPath(module.moduleUri, CONFIG_PATHS.POM_XML);
        if (await fileExists(pomUri)) {
            await pomManager.syncModuleDependencies(
                module.moduleUri,
                module.descriptor.dependencies,
                allModules,
                module.outputPaths.mavenBuildDirectory
            );
        }
        return;
    }

    if (module.resolvedType === 'gradle') {
        const gradleUri = vscode.Uri.joinPath(module.moduleUri, CONFIG_PATHS.BUILD_GRADLE);
        if (await fileExists(gradleUri)) {
            await gradleManager.syncModuleDependencies(
                module.moduleUri,
                module.descriptor.dependencies,
                allModules,
                module.outputPaths.gradleBuildDirectory
            );
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
