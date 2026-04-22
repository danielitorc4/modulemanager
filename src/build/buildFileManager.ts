import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { findModuleDescriptors } from '../moduleDescriptors';
import * as gradleManager from './gradleManager';
import * as eclipseMetadataManager from './eclipseMetadataManager';
import * as pomManager from './pomManager';
import type { DiscoveredModule } from '../types';

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

    await neutralizeRootProjectIfNeeded(workspaceUri, modules);
}

/**
 * When the workspace root contains a non-module .project file (a user-created Eclipse project)
 * and the workspace also has basic modules, the root project's .classpath source entries may
 * overlap with module source directories. This rewrites the root .classpath so that each
 * kind="src" entry carries an excluding attribute covering all basic-module directories that
 * fall inside it. This prevents the root project from compiling module-owned sources while still
 * leaving non-module sources in the root project intact.
 */
async function neutralizeRootProjectIfNeeded(
    workspaceUri: vscode.Uri,
    modules: DiscoveredModule[]
): Promise<void> {
    const rootProjectUri = vscode.Uri.joinPath(workspaceUri, CONFIG_PATHS.ECLIPSE_PROJECT);
    const rootDescriptorUri = vscode.Uri.joinPath(workspaceUri, CONFIG_PATHS.MODULE_DESCRIPTOR);
    const rootClasspathUri = vscode.Uri.joinPath(workspaceUri, CONFIG_PATHS.ECLIPSE_CLASSPATH);

    // Only act when the root has an Eclipse project but is NOT itself a managed module.
    if (!await fileExists(rootProjectUri) || await fileExists(rootDescriptorUri)) {
        return;
    }

    if (!await fileExists(rootClasspathUri)) {
        return;
    }

    const basicModulePaths = modules
        .filter(m => m.descriptor.type === 'basic')
        .map(m => m.modulePath.replace(/\\/g, '/').replace(/\/$/, ''));

    const classpathData = await vscode.workspace.fs.readFile(rootClasspathUri);
    const originalXml = Buffer.from(classpathData).toString();
    const updatedXml = updateRootClasspathExclusions(originalXml, basicModulePaths);

    if (updatedXml !== originalXml) {
        await vscode.workspace.fs.writeFile(rootClasspathUri, Buffer.from(updatedXml));
    }
}

/**
 * Rewrites kind="src" entries in an Eclipse .classpath XML string so that each entry
 * carries an excluding attribute for every basic-module directory nested within it.
 * Any previously written exclusions are replaced atomically so the result stays idempotent.
 */
export function updateRootClasspathExclusions(
    classpathXml: string,
    basicModulePaths: string[]
): string {
    // Matches self-closing <classpathentry .../> tags regardless of attribute order.
    return classpathXml.replace(/<classpathentry\b([^/]*)\/>/g, (fullMatch, attrs: string) => {
        if (!/\bkind="src"/.test(attrs)) {
            return fullMatch;
        }

        const pathMatch = /\bpath="([^"]*)"/.exec(attrs);
        if (!pathMatch) {
            return fullMatch;
        }

        // Normalize: treat "." as an alias for the workspace root ("").
        const rawSrcPath = pathMatch[1].replace(/\/$/, '');
        const srcPath = rawSrcPath === '.' ? '' : rawSrcPath;

        // Determine which module dirs are direct children of this source root.
        const newExclusions = basicModulePaths
            .filter(mp => srcPath === '' ? true : mp.startsWith(srcPath + '/'))
            .map(mp => {
                const rel = srcPath === '' ? mp : mp.slice(srcPath.length + 1);
                return rel ? rel + '/**' : '**';
            })
            .filter(Boolean)
            .sort();

        // Strip the old excluding attribute so we can replace it cleanly.
        const attrsWithoutExcluding = attrs.replace(/\s*\bexcluding="[^"]*"/, '');

        if (newExclusions.length === 0) {
            // No overlap — restore without any excluding attribute.
            return `<classpathentry${attrsWithoutExcluding}/>`;
        }

        const trimmedAttrs = attrsWithoutExcluding.replace(/\s+$/, '');
        return `<classpathentry${trimmedAttrs} excluding="${newExclusions.join('|')}"/>`;
    });
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
