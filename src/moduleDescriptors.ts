import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_PATHS, REGEX } from './constants';
import { DiscoveredModule, ModuleConfig } from './types';

export async function findModuleDescriptors(workspaceUri: vscode.Uri): Promise<DiscoveredModule[]> {
    const descriptorPattern = new vscode.RelativePattern(workspaceUri, `**/${CONFIG_PATHS.MODULE_DESCRIPTOR}`);
    const descriptorUris = await vscode.workspace.findFiles(descriptorPattern, '**/node_modules/**');
    const modules: DiscoveredModule[] = [];
    const seenNames = new Set<string>();

    for (const descriptorUri of descriptorUris) {
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
    } catch {
        return null;
    }
}

export async function writeModuleDescriptor(moduleUri: vscode.Uri, descriptor: ModuleConfig): Promise<void> {
    const descriptorUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.MODULE_DESCRIPTOR);
    await vscode.workspace.fs.writeFile(descriptorUri, Buffer.from(JSON.stringify(descriptor, null, 2)));
}

export function normalizeModuleDescriptor(parsed: any, fallbackModuleName?: string): ModuleConfig {
    const fallbackName = fallbackModuleName && fallbackModuleName.trim() ? fallbackModuleName : 'module';
    const name = typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name.trim() : fallbackName;
    const type = parsed?.type === 'maven' || parsed?.type === 'gradle' ? parsed.type : 'basic';
    const createdAt =
        typeof parsed?.createdAt === 'string' && parsed.createdAt.trim() ? parsed.createdAt : new Date().toISOString();
    const dependencies = Array.isArray(parsed?.dependencies)
        ? Array.from(new Set(parsed.dependencies.filter((dep: unknown): dep is string => typeof dep === 'string' && dep.trim() !== '')))
        : [];
    const sourceRoot = typeof parsed?.sourceRoot === 'string' && parsed.sourceRoot.trim() ? parsed.sourceRoot : 'src';
    const structure = Array.isArray(parsed?.structure)
        ? parsed.structure.filter((entry: unknown): entry is string => typeof entry === 'string')
        : undefined;

    return {
        name,
        type,
        createdAt,
        dependencies,
        sourceRoot,
        structure
    };
}
