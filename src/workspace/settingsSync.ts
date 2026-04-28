import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { ManagedModule, WorkspaceModuleTypeSummary } from '../types';
import { parseJsonWithComments } from '../utils/utils';

const MANAGED_REFERENCED_LIBRARY_PATTERNS = ['lib/**/*.jar', '**/lib/**/*.jar', '**/target/dependency/*.jar'];
const MANAGED_FILES_EXCLUDE_PATTERNS = [
    `**/${CONFIG_PATHS.MODULE_DESCRIPTOR}`,
    `**/${CONFIG_PATHS.ECLIPSE_PROJECT}`,
    `**/${CONFIG_PATHS.ECLIPSE_CLASSPATH}`,
    `**/${CONFIG_PATHS.MODULEMANAGER_DIR}/**`
];

const MANAGED_SEARCH_EXCLUDE_PATTERNS = [`**/${CONFIG_PATHS.MODULEMANAGER_DIR}/**`];

interface JsonObject {
    [key: string]: unknown;
}

export async function syncDistributedWorkspaceSettings(
    managementRootUri: vscode.Uri,
    modules: ManagedModule[],
    moduleTypeSummary: WorkspaceModuleTypeSummary
): Promise<void> {
    await syncRootSettings(managementRootUri, modules, moduleTypeSummary);
    for (const module of modules) {
        await syncModuleSettings(module);
    }
}

export function applyManagedRootSettings(
    currentSettings: Record<string, unknown>,
    managementRootUri: vscode.Uri,
    modules: ManagedModule[],
    moduleTypeSummary: WorkspaceModuleTypeSummary
): Record<string, unknown> {
    const updatedSettings = { ...currentSettings };
    const managedModuleExplorerExcludePatterns = modules
        .map(module => module.modulePath.replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter(modulePath => modulePath !== '' && modulePath !== '.');

    // ModuleManager core settings (always set)
    updatedSettings['modulemanager.managementRoot'] = managementRootUri.fsPath;
    updatedSettings['modulemanager.mode'] = 'independent-workspaces';

    // File/Search exclusions (merge, don't replace)
    updatedSettings['files.exclude'] = mergeBooleanMap(
        updatedSettings['files.exclude'],
        [...MANAGED_FILES_EXCLUDE_PATTERNS, ...managedModuleExplorerExcludePatterns]
    );
    updatedSettings['search.exclude'] = mergeBooleanMap(
        updatedSettings['search.exclude'],
        MANAGED_SEARCH_EXCLUDE_PATTERNS
    );

    // Exclude only the managed module subdirectories from JDTLS import scanning at
    // the root level. This prevents double-indexing (the modules have their own
    // workspace folder entries), while leaving any pre-existing src/ or other Java
    // source trees in the root folder fully visible to JDTLS.
    if (modules.length > 0) {
        updatedSettings['java.import.exclusions'] = modules.map(m => `${m.modulePath}/**`);
    } else {
        // No modules yet — remove any stale exclusion so the root src/ is discoverable
        delete updatedSettings['java.import.exclusions'];
    }

    // Only set Java import flags if modules of that type exist
    if (moduleTypeSummary.hasMavenModules) {
        updatedSettings['java.import.maven.enabled'] = true;
    }

    if (moduleTypeSummary.hasGradleModules) {
        updatedSettings['java.import.gradle.enabled'] = true;
    }

    return updatedSettings;
}

export function applyManagedModuleSettings(module: ManagedModule, currentSettings: Record<string, unknown>): Record<string, unknown> {
    const updatedSettings = { ...currentSettings };
    
    // Module type tracking for diagnostics
    updatedSettings['modulemanager.moduleType'] = module.resolvedType;

    // Exclude ModuleManager metadata
    updatedSettings['files.exclude'] = mergeBooleanMap(
        updatedSettings['files.exclude'],
        MANAGED_FILES_EXCLUDE_PATTERNS
    );
    updatedSettings['search.exclude'] = mergeBooleanMap(
        updatedSettings['search.exclude'],
        MANAGED_SEARCH_EXCLUDE_PATTERNS
    );

    // Handle each module type - only set what's necessary
    switch (module.resolvedType) {
        case 'basic':
            // Basic modules use referenced libraries
            updatedSettings['java.project.referencedLibraries'] = mergeReferencedLibrariesSetting(
                updatedSettings['java.project.referencedLibraries']
            );
            // Don't delete Maven/Gradle settings - user might have other projects
            break;

        case 'maven':
            // Only enable Maven for this module, don't disable Gradle (user might have mixed)
            updatedSettings['java.import.maven.enabled'] = true;
            updatedSettings['maven.executable.preferMavenWrapper'] = true;
            updatedSettings['java.configuration.updateBuildConfiguration'] = 'automatic';
            // Don't delete referenced libraries - user might need them
            break;

        case 'gradle':
            // Only enable Gradle for this module
            updatedSettings['java.import.gradle.enabled'] = true;
            updatedSettings['java.configuration.updateBuildConfiguration'] = 'automatic';
            // Don't delete other settings
            break;
    }

    return updatedSettings;
}

function mergeReferencedLibrariesSetting(currentValue: unknown): unknown {
    if (Array.isArray(currentValue)) {
        const existing = currentValue.filter((entry): entry is string => typeof entry === 'string');
        return Array.from(new Set([...existing, ...MANAGED_REFERENCED_LIBRARY_PATTERNS]));
    }

    if (isRecord(currentValue)) {
        const includeValue = currentValue.include;
        const include = Array.isArray(includeValue)
            ? includeValue.filter((entry): entry is string => typeof entry === 'string')
            : [];

        return {
            ...currentValue,
            include: Array.from(new Set([...include, ...MANAGED_REFERENCED_LIBRARY_PATTERNS]))
        };
    }

    return [...MANAGED_REFERENCED_LIBRARY_PATTERNS];
}

async function syncRootSettings(
    managementRootUri: vscode.Uri,
    modules: ManagedModule[],
    moduleTypeSummary: WorkspaceModuleTypeSummary
): Promise<void> {
    const current = await readSettingsFile(managementRootUri);
    const updated = applyManagedRootSettings(current, managementRootUri, modules, moduleTypeSummary);
    await writeSettingsFile(managementRootUri, updated);
}

async function syncModuleSettings(module: ManagedModule): Promise<void> {
    const current = await readSettingsFile(module.moduleUri);
    const updated = applyManagedModuleSettings(module, current);
    await writeSettingsFile(module.moduleUri, updated);
}

async function readSettingsFile(baseUri: vscode.Uri): Promise<Record<string, unknown>> {
    const settingsUri = vscode.Uri.joinPath(baseUri, CONFIG_PATHS.VSCODE_DIR, CONFIG_PATHS.SETTINGS_JSON);
    if (!(await fileExists(settingsUri))) {
        return {};
    }

    try {
        const content = Buffer.from(await vscode.workspace.fs.readFile(settingsUri)).toString();
        const parsed = parseJsonWithComments<unknown>(content);
        if (!isRecord(parsed)) {
            console.warn(`Expected JSON object in settings file: ${settingsUri.fsPath}`);
            return {};
        }

        return parsed;
    } catch (error) {
        console.warn(`Could not parse settings file at ${settingsUri.fsPath}:`, error);
        return {};
    }
}

async function writeSettingsFile(baseUri: vscode.Uri, settings: Record<string, unknown>): Promise<void> {
    const vscodeDirUri = vscode.Uri.joinPath(baseUri, CONFIG_PATHS.VSCODE_DIR);
    const settingsUri = vscode.Uri.joinPath(vscodeDirUri, CONFIG_PATHS.SETTINGS_JSON);
    await vscode.workspace.fs.createDirectory(vscodeDirUri);
    await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(settings, null, 2)));
}

function mergeBooleanMap(current: unknown, patterns: string[]): JsonObject {
    const result: JsonObject = isRecord(current) ? { ...current } : {};
    for (const pattern of patterns) {
        result[pattern] = true;
    }

    return result;
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

export async function ensureWorkspaceExcludes() {
  const config = vscode.workspace.getConfiguration();

  const excludes = config.get<Record<string, boolean>>('files.exclude') ?? {};

  let changed = false;

  if (!excludes['**/.module.json']) {
    excludes['**/.module.json'] = true;
    changed = true;
  }

  if (!excludes['**/*.code-workspace']) {
    excludes['**/*.code-workspace'] = true;
    changed = true;
  }

  if (changed) {
    await config.update('files.exclude', excludes, vscode.ConfigurationTarget.Workspace);
  }
}