import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_PATHS, REGEX } from './constants';
import { DiscoveredModule, ModuleConfig, ModuleType } from './types';

const ALLOWED_DESCRIPTOR_FIELDS = new Set(['name', 'type', 'createdAt', 'dependencies']);
const IGNORED_DESCRIPTOR_DIRECTORIES = new Set(['node_modules', 'bin', 'target', 'out']);

export async function findModuleDescriptors(workspaceUri: vscode.Uri): Promise<DiscoveredModule[]> {
    const descriptorPattern = new vscode.RelativePattern(workspaceUri, `**/${CONFIG_PATHS.MODULE_DESCRIPTOR}`);
    // Use null excludes so descriptor discovery is unaffected by files.exclude/search.exclude visibility settings.
    const descriptorUris = await vscode.workspace.findFiles(descriptorPattern, null);
    const modules: DiscoveredModule[] = [];
    const seenNames = new Set<string>();

    for (const descriptorUri of descriptorUris) {
        if (shouldIgnoreModuleDescriptorPath(descriptorUri.fsPath)) {
            continue;
        }

        const moduleUri = vscode.Uri.file(path.dirname(descriptorUri.fsPath));
        const descriptor = await readModuleDescriptor(descriptorUri, path.basename(moduleUri.fsPath));
        if (!descriptor) {
            continue;
        }

        if (seenNames.has(descriptor.name)) {
            console.warn(`Duplicate module descriptor ignored for "${descriptor.name}" at ${descriptorUri.fsPath}`);
            continue;
        }

        seenNames.add(descriptor.name);
        modules.push({
            descriptor,
            moduleUri,
            modulePath: path.relative(workspaceUri.fsPath, moduleUri.fsPath).replace(/\\/g, '/')
        });
    }

    return modules;
}

export async function readModuleDescriptor(
    descriptorUri: vscode.Uri,
    fallbackModuleName?: string
): Promise<ModuleConfig | null> {
    try {
        const content = await vscode.workspace.fs.readFile(descriptorUri);
        const parsed = JSON.parse(Buffer.from(content).toString().replace(REGEX.JSON_COMMENTS, ''));
        return normalizeModuleDescriptor(parsed, fallbackModuleName);
    } catch (error) {
        console.warn(
            `Invalid module descriptor ignored at ${descriptorUri.fsPath}${
                fallbackModuleName ? ` (module: ${fallbackModuleName})` : ''
            }: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

export async function writeModuleDescriptor(moduleUri: vscode.Uri, descriptor: ModuleConfig): Promise<void> {
    const descriptorUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.MODULE_DESCRIPTOR);
    await vscode.workspace.fs.writeFile(descriptorUri, Buffer.from(JSON.stringify(descriptor, null, 2)));
}

export function normalizeModuleDescriptor(parsed: any, fallbackModuleName?: string): ModuleConfig {
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Descriptor must be a JSON object.');
    }

    const record = parsed as Record<string, unknown>;
    const unsupportedFields = Object.keys(record).filter(field => !ALLOWED_DESCRIPTOR_FIELDS.has(field));
    if (unsupportedFields.length > 0) {
        throw new Error(`Unsupported descriptor fields: ${unsupportedFields.join(', ')}.`);
    }

    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) {
        throw new Error(
            fallbackModuleName
                ? `Descriptor must define a non-empty "name" field (expected module ${fallbackModuleName}).`
                : 'Descriptor must define a non-empty "name" field.'
        );
    }

    if (!REGEX.MODULE_NAME.test(name)) {
        throw new Error(`Invalid module name "${name}". Use letters, numbers, hyphens, and underscores only.`);
    }

    const supportedTypes: ModuleType[] = ['basic', 'maven', 'gradle'];
    const type = record.type;
    if (typeof type !== 'string' || !supportedTypes.includes(type as ModuleType)) {
        throw new Error('Descriptor field "type" must be one of: basic, maven, gradle.');
    }

    const createdAt =
        typeof record.createdAt === 'string' && record.createdAt.trim() ? record.createdAt : new Date().toISOString();

    if (record.dependencies !== undefined && !Array.isArray(record.dependencies)) {
        throw new Error('Descriptor field "dependencies" must be an array of module names.');
    }

    const dependencies = Array.from(
        new Set(
            (Array.isArray(record.dependencies) ? record.dependencies : [])
                .filter((dependency): dependency is string => typeof dependency === 'string')
                .map(dependency => dependency.trim())
                .filter(dependency => dependency !== '')
        )
    );

    return {
        name,
        type: type as ModuleType,
        createdAt,
        dependencies
    };
}

export function shouldIgnoreModuleDescriptorPath(fsPath: string): boolean {
    const normalizedPath = fsPath.replace(/\\/g, '/').toLowerCase();
    const segments = normalizedPath.split('/');
    return segments.some(segment => IGNORED_DESCRIPTOR_DIRECTORIES.has(segment));
}
