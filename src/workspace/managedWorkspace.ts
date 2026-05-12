import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { findModuleDescriptors, writeModuleDescriptor } from '../moduleDescriptors';
import { ManagedModule, ModuleConfig, ModuleOutputPaths, ModuleType, WorkspaceModuleTypeSummary } from '../types';
import { parseJsonWithComments } from '../utils/utils';

interface WorkspaceFolderEntry {
    name?: string;
    path: string;
}

interface CodeWorkspaceFile {
    folders: WorkspaceFolderEntry[];
    settings?: Record<string, unknown>;
    [key: string]: unknown;
}

const MANAGED_ROOT_FOLDER_NAME = 'modulemanager-root';
const MANAGEMENT_ROOT_CONFIG_KEY = 'managementRoot';
let hasPromptedToOpenManagedWorkspaceInSession = false;
let hasWarnedAboutNestedRootInSession = false;

function warnAboutNestedRootOnce(): void {
    if (hasWarnedAboutNestedRootInSession) {
        return;
    }
    hasWarnedAboutNestedRootInSession = true;
    vscode.window.showWarningMessage(
        'ModuleManager: the workspace root has its own .module.json but child modules also exist. ' +
        'JDTLS does not allow nested Java projects — the root will be treated as a container only. ' +
        'Either delete the root .module.json or remove the child modules.'
    );
}

export async function resolveManagementRootUri(resourceUri?: vscode.Uri): Promise<vscode.Uri | null> {
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile) {
        return vscode.Uri.file(path.dirname(workspaceFile.fsPath));
    }

    const configuredRoot = vscode.workspace
        .getConfiguration('modulemanager')
        .get<string>(MANAGEMENT_ROOT_CONFIG_KEY)
        ?.trim();
    if (configuredRoot) {
        return vscode.Uri.file(configuredRoot);
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return null;
    }

    const managedRootFolder = workspaceFolders.find(folder => folder.name === MANAGED_ROOT_FOLDER_NAME);
    if (managedRootFolder) {
        return managedRootFolder.uri;
    }

    if (resourceUri) {
        const fromResource = vscode.workspace.getWorkspaceFolder(resourceUri);
        if (fromResource) {
            return fromResource.uri;
        }
    }

    const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
    if (activeEditorUri) {
        const fromEditor = vscode.workspace.getWorkspaceFolder(activeEditorUri);
        if (fromEditor) {
            return fromEditor.uri;
        }
    }

    return workspaceFolders[0].uri;
}

export async function discoverManagedModules(managementRootUri: vscode.Uri): Promise<ManagedModule[]> {
    const discovered = await findModuleDescriptors(managementRootUri);
    const modules: ManagedModule[] = [];

    const rootExplicit = discovered.find(m => !m.modulePath || m.modulePath === '.');
    const childDescriptors = discovered.filter(m => m.modulePath && m.modulePath !== '.');

    for (const module of childDescriptors) {
        const resolvedType = await resolveModuleType(module.moduleUri);
        const normalizedDescriptor = module.descriptor.type === resolvedType
            ? module.descriptor
            : {
                ...module.descriptor,
                type: resolvedType
            };

        if (normalizedDescriptor.type !== module.descriptor.type) {
            await writeModuleDescriptor(module.moduleUri, normalizedDescriptor);
        }

        modules.push({
            ...module,
            descriptor: normalizedDescriptor,
            resolvedType,
            projectName: buildProjectName(module.modulePath),
            outputPaths: buildModuleOutputPaths(normalizedDescriptor.name)
        });
    }

    // The workspace root becomes a Java module only when:
    //   - the user has explicitly placed a .module.json at the root, AND
    //   - there are no child modules.
    // Mixing a root-level Java project with child Java projects creates nested
    // Eclipse projects, which JDTLS does not support — it triggers "overlapping
    // project" errors and cyclic classpath references between parent/child.
    if (rootExplicit && childDescriptors.length === 0) {
        const rootFolderName = path.basename(managementRootUri.fsPath);
        const rootResolvedType = await resolveModuleType(managementRootUri);
        const rootDescriptor: ModuleConfig = rootExplicit.descriptor.type === rootResolvedType
            ? rootExplicit.descriptor
            : { ...rootExplicit.descriptor, type: rootResolvedType };

        if (rootDescriptor.type !== rootExplicit.descriptor.type) {
            await writeModuleDescriptor(managementRootUri, rootDescriptor);
        }

        modules.unshift({
            modulePath: '.',
            moduleUri: managementRootUri,
            descriptor: rootDescriptor,
            resolvedType: rootDescriptor.type,
            projectName: buildProjectName(rootFolderName),
            outputPaths: buildModuleOutputPaths(rootDescriptor.name)
        });
    } else if (rootExplicit && childDescriptors.length > 0) {
        warnAboutNestedRootOnce();
    }

    return modules.sort((left, right) => left.modulePath.localeCompare(right.modulePath));
}

export function summarizeWorkspaceModuleTypes(moduleTypes: ModuleType[]): WorkspaceModuleTypeSummary {
    return {
        hasBasicModules: moduleTypes.includes('basic'),
        hasMavenModules: moduleTypes.includes('maven'),
        hasGradleModules: moduleTypes.includes('gradle')
    };
}

export async function reconcileWorkspaceLayout(
    managementRootUri: vscode.Uri,
    modules: ManagedModule[]
): Promise<{ workspaceFileUri: vscode.Uri; workspaceFoldersChanged: boolean }> {
    const workspaceFileUri = getManagedWorkspaceFileUri(managementRootUri);

    await syncCodeWorkspaceFile(workspaceFileUri, managementRootUri, modules);

    // If VS Code is NOT running from a .code-workspace file, do NOT call
    // updateWorkspaceFolders() — that would silently convert the session into an
    // untitled multi-root workspace and prompt the user to save it on close.
    // Instead, offer to open the generated .code-workspace file.
    if (!vscode.workspace.workspaceFile) {
        if (modules.length > 0 && !hasPromptedToOpenManagedWorkspaceInSession) {
            hasPromptedToOpenManagedWorkspaceInSession = true;
            const choice = await vscode.window.showInformationMessage(
                `ModuleManager generated '${CONFIG_PATHS.CODE_WORKSPACE}'. Open it to enable full module isolation.`,
                'Open Workspace'
            );
            if (choice === 'Open Workspace') {
                await vscode.commands.executeCommand('vscode.openFolder', workspaceFileUri);
            }
        }
        return { workspaceFileUri, workspaceFoldersChanged: false };
    }

    // Only manage workspace folders when already running inside a .code-workspace
    const workspaceFoldersChanged = syncOpenWorkspaceFolders(managementRootUri, modules);
    if (workspaceFoldersChanged) {
        // Brief grace period for JDTLS to reinitialize after folder changes
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return { workspaceFileUri, workspaceFoldersChanged };
}

export function getManagedWorkspaceFileUri(managementRootUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(managementRootUri, CONFIG_PATHS.CODE_WORKSPACE);
}

export async function resolveModuleType(moduleUri: vscode.Uri): Promise<ModuleType> {
    const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
    if (await fileExists(pomUri)) {
        return 'maven';
    }

    const gradleUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.BUILD_GRADLE);
    if (await fileExists(gradleUri)) {
        return 'gradle';
    }

    return 'basic';
}

function buildProjectName(modulePath: string): string {
    // Use only the folder name, not a prefixed path.
    // If .project name differs from the workspace folder name, JDTLS shows
    // the module twice in the Java Projects view (once per identifier).
    const normalizedPath = modulePath.replace(/\\/g, '/').replace(/^\.\//, '');
    const lastSegment = normalizedPath.split('/').filter(Boolean).pop() ?? normalizedPath;
    return lastSegment.replace(/[^a-zA-Z0-9._-]/g, '_') || 'module';
}

function buildModuleOutputPaths(moduleName: string): ModuleOutputPaths {
    const sanitized = sanitizePathSegment(moduleName);
    return {
        basicClasspathOutput: `${CONFIG_PATHS.MODULEMANAGER_DIR}/bin/${sanitized}`,
        mavenBuildDirectory: `${CONFIG_PATHS.MODULEMANAGER_DIR}/target/${sanitized}`,
        gradleBuildDirectory: `${CONFIG_PATHS.MODULEMANAGER_DIR}/gradle/${sanitized}`
    };
}

function sanitizePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function syncCodeWorkspaceFile(
    workspaceFileUri: vscode.Uri,
    managementRootUri: vscode.Uri,
    modules: ManagedModule[]
): Promise<void> {
    const existing = await readCodeWorkspaceFile(workspaceFileUri);
    const childModules = modules.filter(m => m.modulePath !== '.');

    // When child modules exist, omit the root from the workspace-folder list.
    // The root is then an implicit container: JDTLS only sees the per-module
    // workspace folders, so the Java Projects view shows each module as a
    // sibling instead of nesting them inside a "mm-test" parent that duplicates
    // every module entry.
    // Fall back to including the root only when there are no managed modules —
    // that's the bootstrap case where the user has a plain Java project at the
    // root and we still want them to see their code.
    const folders: WorkspaceFolderEntry[] = childModules.length > 0
        ? childModules.map(module => ({
            name: module.descriptor.name,
            path: module.modulePath
        }))
        : [{ path: '.' }];

    const settings = asRecord(existing.settings);
    settings['modulemanager.managementRoot'] = managementRootUri.fsPath;
    settings['modulemanager.mode'] = 'independent-workspaces';

    // Do NOT set java.import.exclusions here at workspace scope: a workspace-level
    // exclusion would also suppress JDTLS scanning inside each module's own workspace
    // folder.  Per-folder exclusions in mm-test/.vscode/settings.json (written by
    // applyManagedRootSettings) are the right mechanism — they apply only when JDTLS
    // is scanning the root folder, not when it scans the dedicated module folders.
    delete settings['java.import.exclusions'];

    const nextWorkspace: CodeWorkspaceFile = {
        ...existing,
        folders,
        settings
    };

    await vscode.workspace.fs.writeFile(workspaceFileUri, Buffer.from(JSON.stringify(nextWorkspace, null, 2)));
}

async function readCodeWorkspaceFile(workspaceFileUri: vscode.Uri): Promise<CodeWorkspaceFile> {
    if (!(await fileExists(workspaceFileUri))) {
        return { folders: [] };
    }

    try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(workspaceFileUri)).toString();
        const parsed = parseJsonWithComments<unknown>(content);
        if (!isRecord(parsed)) {
            return { folders: [] };
        }

        const folders = Array.isArray(parsed.folders)
            ? parsed.folders.filter(isWorkspaceFolderEntry)
            : [];

        return {
            ...parsed,
            folders
        } as CodeWorkspaceFile;
    } catch (error) {
        console.warn(`Could not parse workspace file at ${workspaceFileUri.fsPath}:`, error);
        return { folders: [] };
    }
}

function syncOpenWorkspaceFolders(managementRootUri: vscode.Uri, modules: ManagedModule[]): boolean {
    const childModules = modules.filter(m => m.modulePath !== '.');

    // Mirror syncCodeWorkspaceFile: when child modules exist, the running
    // VS Code window should show ONLY the module folders — the root is hidden
    // to keep JDTLS's Java Projects view free of the duplicate nested entries
    // (one per workspace folder + one nested inside the root).
    const desiredFolders: Array<{ uri: vscode.Uri; name?: string }> = childModules.length > 0
        ? childModules.map(module => ({
            uri: module.moduleUri,
            name: module.descriptor.name
        }))
        : [{ uri: managementRootUri }];

    const currentFolders = vscode.workspace.workspaceFolders ?? [];
    if (areWorkspaceFoldersEqual(currentFolders, desiredFolders)) {
        return false;
    }

    const updated = vscode.workspace.updateWorkspaceFolders(0, currentFolders.length, ...desiredFolders);
    if (!updated) {
        console.warn('Failed to update VS Code workspace folders for ModuleManager reconciliation.');
        return false;
    }

    return true;
}

function areWorkspaceFoldersEqual(
    currentFolders: readonly vscode.WorkspaceFolder[],
    desiredFolders: Array<{ uri: vscode.Uri; name?: string }>
): boolean {
    if (currentFolders.length !== desiredFolders.length) {
        return false;
    }

    for (let index = 0; index < currentFolders.length; index++) {
        const current = currentFolders[index];
        const desired = desiredFolders[index];
        if (!samePath(current.uri.fsPath, desired.uri.fsPath)) {
            return false;
        }

        // Only treat this as a mismatch when the desired entry explicitly sets a name.
        // If desired.name is undefined the folder keeps VS Code's auto-assigned name
        // (the real directory name), so there is nothing to change.
        if (desired.name !== undefined && current.name !== desired.name) {
            return false;
        }
    }

    return true;
}

function samePath(left: string, right: string): boolean {
    const normalize = (value: string) => path.normalize(value).replace(/\\/g, '/').toLowerCase();
    return normalize(left) === normalize(right);
}

function asRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? { ...value } : {};
}

function isWorkspaceFolderEntry(value: unknown): value is WorkspaceFolderEntry {
    return isRecord(value) && typeof value.path === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
