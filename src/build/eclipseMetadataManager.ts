import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { DiscoveredModule } from '../types';

const JAVA_CONTAINER = 'org.eclipse.jdt.launching.JRE_CONTAINER';

interface ModuleWorkspaceContext {
    module: DiscoveredModule;
    projectNameByModule: Map<string, string>;
}

export async function syncModuleMetadata(
    workspaceUri: vscode.Uri,
    module: DiscoveredModule,
    allModules: DiscoveredModule[]
): Promise<void> {
    const projectNameByModule = new Map<string, string>();
    for (const currentModule of allModules) {
        projectNameByModule.set(currentModule.descriptor.name, getProjectName(workspaceUri, currentModule));
    }

    const context: ModuleWorkspaceContext = {
        module,
        projectNameByModule
    };

    await writeProjectFile(workspaceUri, context);
    await writeClasspathFile(workspaceUri, context, allModules);
}

async function writeProjectFile(workspaceUri: vscode.Uri, context: ModuleWorkspaceContext): Promise<void> {
    const { module } = context;
    const projectUri = vscode.Uri.joinPath(module.moduleUri, CONFIG_PATHS.ECLIPSE_PROJECT);
    const projectName = getProjectName(workspaceUri, module);

    const projectXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<projectDescription>',
        `  <name>${escapeXml(projectName)}</name>`,
        '  <comment></comment>',
        '  <projects>',
        ...module.descriptor.dependencies.map(dependencyName => {
            const dependencyProjectName = context.projectNameByModule.get(dependencyName);
            return dependencyProjectName ? `    <project>${escapeXml(dependencyProjectName)}</project>` : '';
        }).filter(Boolean),
        '  </projects>',
        '  <buildSpec>',
        '    <buildCommand>',
        '      <name>org.eclipse.jdt.core.javabuilder</name>',
        '      <arguments></arguments>',
        '    </buildCommand>',
        '  </buildSpec>',
        '  <natures>',
        '    <nature>org.eclipse.jdt.core.javanature</nature>',
        '  </natures>',
        '</projectDescription>',
        ''
    ].join('\n');

    await vscode.workspace.fs.writeFile(projectUri, Buffer.from(projectXml));
}

async function writeClasspathFile(
    workspaceUri: vscode.Uri,
    context: ModuleWorkspaceContext,
    allModules: DiscoveredModule[]
): Promise<void> {
    const { module } = context;
    const classpathUri = vscode.Uri.joinPath(module.moduleUri, CONFIG_PATHS.ECLIPSE_CLASSPATH);

    const dependencyEntries = resolveDependencyEntries(workspaceUri, module, allModules).map(entry =>
        `  <classpathentry kind="src" path="${escapeXml(entry)}" combineaccessrules="false"/>`
    );

    const classpathXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<classpath>',
        '  <classpathentry kind="src" path="src/main/java"/>',
        '  <classpathentry kind="src" path="src/test/java"/>',
        '  <classpathentry kind="src" path="src/main/resources"/>',
        ...dependencyEntries,
        `  <classpathentry kind="con" path="${JAVA_CONTAINER}"/>`,
        '  <classpathentry kind="output" path="bin"/>',
        '</classpath>',
        ''
    ].join('\n');

    await vscode.workspace.fs.writeFile(classpathUri, Buffer.from(classpathXml));
}

function resolveDependencyEntries(
    workspaceUri: vscode.Uri,
    module: DiscoveredModule,
    allModules: DiscoveredModule[]
): string[] {
    const moduleByName = new Map(allModules.map(discoveredModule => [discoveredModule.descriptor.name, discoveredModule]));

    const entries = module.descriptor.dependencies
        .map(dependencyName => moduleByName.get(dependencyName))
        .filter((dependency): dependency is DiscoveredModule => Boolean(dependency))
        .map(dependency => {
            const relativeModulePath = path.relative(module.moduleUri.fsPath, dependency.moduleUri.fsPath).replace(/\\/g, '/');
            const normalizedRelativePath = normalizeRelPath(relativeModulePath);
            return `${normalizedRelativePath}/src/main/java`;
        });

    return Array.from(new Set(entries)).sort();
}

function normalizeRelPath(inputPath: string): string {
    const normalized = inputPath.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!normalized || normalized === '.') {
        return '.';
    }

    if (normalized.startsWith('./') || normalized.startsWith('../')) {
        return normalized;
    }

    return `./${normalized}`;
}

function getProjectName(workspaceUri: vscode.Uri, module: DiscoveredModule): string {
    const modulePath = path.relative(workspaceUri.fsPath, module.moduleUri.fsPath).replace(/\\/g, '/');
    const normalizedPath = modulePath.replace(/\//g, '.');
    return `modulemanager.${normalizedPath}`;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
