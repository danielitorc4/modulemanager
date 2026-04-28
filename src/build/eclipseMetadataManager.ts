import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { ManagedModule } from '../types';
import * as path from 'path';

const JAVA_CONTAINER = 'org.eclipse.jdt.launching.JRE_CONTAINER';
const ECLIPSE_SETTINGS_DIR = '.settings';
const JDT_CORE_PREFS_FILE = 'org.eclipse.jdt.core.prefs';
const JDT_CORE_PREFS_CONTENT = [
    'eclipse.preferences.version=1',
    'org.eclipse.jdt.core.compiler.problem.forbiddenReference=error',
    ''
].join('\n');
const JAVA_SOURCE_PATHS_SETTING = 'javaSourcePaths';
const JAVA_DISCOVERY_EXCLUDES = '**/{.git,.settings,node_modules,.modulemanager,target,build,out,bin,dist}/**';
const JAVA_PACKAGE_REGEX = /^\s*package\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*)\s*;/m;

interface ClasspathAccessEntry {
    projectPath: string;
    accessRuleKind: 'accessible' | 'non-accessible';
}

export async function syncModuleMetadata(
    workspaceUri: vscode.Uri,
    module: ManagedModule,
    allModules: ManagedModule[]
): Promise<void> {
    const basicModules = allModules.filter(currentModule => currentModule.resolvedType === 'basic');
    const projectNameByModule = new Map<string, string>();
    for (const currentModule of basicModules) {
        projectNameByModule.set(currentModule.descriptor.name, currentModule.projectName);
    }

    await writeProjectFile(module, projectNameByModule);
    await writeClasspathFile(workspaceUri, module, basicModules, projectNameByModule);
    await writeJdtCompilerPrefsFile(module.moduleUri);
}

export async function removeEclipseMetadata(moduleUri: vscode.Uri): Promise<void> {
    const eclipseMetadataUris = [
        vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.ECLIPSE_PROJECT),
        vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.ECLIPSE_CLASSPATH),
        vscode.Uri.joinPath(moduleUri, '.settings', 'org.eclipse.jdt.core.prefs')
    ];

    for (const metadataUri of eclipseMetadataUris) {
        try {
            await vscode.workspace.fs.delete(metadataUri, { recursive: false, useTrash: false });
        } catch {
            // Keep metadata cleanup idempotent.
        }
    }
}

async function writeProjectFile(
    module: ManagedModule,
    projectNameByModule: Map<string, string>
): Promise<void> {
    const projectUri = vscode.Uri.joinPath(module.moduleUri, CONFIG_PATHS.ECLIPSE_PROJECT);
    const declaredDependencies = new Set(module.descriptor.dependencies);

    const dependencyProjectEntries = Array.from(projectNameByModule.entries())
        .filter(([dependencyName]) => declaredDependencies.has(dependencyName) && dependencyName !== module.descriptor.name)
        .map(([, dependencyProjectName]) => `    <project>${escapeXml(dependencyProjectName)}</project>`)
        .sort((left, right) => left.localeCompare(right));

    const projectXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<projectDescription>',
        `  <name>${escapeXml(module.projectName)}</name>`,
        '  <comment></comment>',
        '  <projects>',
        ...dependencyProjectEntries,
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
    module: ManagedModule,
    allModules: ManagedModule[],
    projectNameByModule: Map<string, string>
): Promise<void> {
    const classpathUri = vscode.Uri.joinPath(module.moduleUri, CONFIG_PATHS.ECLIPSE_CLASSPATH);
    const sourceEntries = await resolveClasspathSourceEntries(module.moduleUri);

    const accessEntries = resolveClasspathAccessEntries(workspaceUri, module, allModules, projectNameByModule).map(entry => [
        `  <classpathentry kind="src" path="${escapeXml(entry.projectPath)}" combineaccessrules="false">`,
        '    <accessrules>',
        `      <accessrule kind="${entry.accessRuleKind}" pattern="**"/>`,
        '    </accessrules>',
        '  </classpathentry>'
    ].join('\n'));

    const classpathXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<classpath>',
        ...sourceEntries,
        ...accessEntries,
        `  <classpathentry kind="con" path="${JAVA_CONTAINER}"/>`,
        `  <classpathentry kind="output" path="${escapeXml(module.outputPaths.basicClasspathOutput)}"/>`,
        '</classpath>',
        ''
    ].join('\n');

    await vscode.workspace.fs.writeFile(classpathUri, Buffer.from(classpathXml));
}

export function resolveClasspathAccessEntries(
    workspaceUri: vscode.Uri,
    module: ManagedModule,
    allModules: ManagedModule[],
    projectNameByModule?: Map<string, string>
): ClasspathAccessEntry[] {
    const projectNameByModuleFallback = new Map<string, string>();
    for (const currentModule of allModules) {
        projectNameByModuleFallback.set(currentModule.descriptor.name, currentModule.projectName);
    }
    const effectiveProjectNameByModule = projectNameByModule ?? projectNameByModuleFallback;

    const declaredDependencies = new Set(module.descriptor.dependencies);
    const entries: ClasspathAccessEntry[] = [];

    for (const dependency of allModules) {
        if (dependency.moduleUri.fsPath === module.moduleUri.fsPath || dependency.resolvedType !== 'basic') {
            continue;
        }

        const projectName = effectiveProjectNameByModule.get(dependency.descriptor.name);
        if (!projectName) {
            continue;
        }

        const accessRuleKind: ClasspathAccessEntry['accessRuleKind'] = declaredDependencies.has(dependency.descriptor.name)
            ? 'accessible'
            : 'non-accessible';

        entries.push({
            projectPath: `/${projectName}`,
            accessRuleKind
        });
    }

    return entries.sort((left, right) => left.projectPath.localeCompare(right.projectPath));
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

async function writeJdtCompilerPrefsFile(moduleUri: vscode.Uri): Promise<void> {
    const settingsDirUri = vscode.Uri.joinPath(moduleUri, ECLIPSE_SETTINGS_DIR);
    const prefsUri = vscode.Uri.joinPath(settingsDirUri, JDT_CORE_PREFS_FILE);
    await vscode.workspace.fs.createDirectory(settingsDirUri);
    await vscode.workspace.fs.writeFile(prefsUri, Buffer.from(JDT_CORE_PREFS_CONTENT));
}

async function resolveClasspathSourceEntries(moduleUri: vscode.Uri): Promise<string[]> {
    const configuredSourcePaths = getConfiguredJavaSourcePaths(moduleUri);
    const discoveredSourcePaths = await discoverJavaSourceRoots(moduleUri);

    const existingConfiguredPaths: string[] = [];
    for (const sourcePath of configuredSourcePaths) {
        const sourceUri = vscode.Uri.joinPath(moduleUri, ...sourcePath.split('/').filter(Boolean));
        if (await fileExists(sourceUri)) {
            existingConfiguredPaths.push(sourcePath);
        }
    }

    const sourcePaths = Array.from(
        new Set([...existingConfiguredPaths, ...discoveredSourcePaths])
    );

    if (sourcePaths.length === 0) {
        const srcUri = vscode.Uri.joinPath(moduleUri, 'src');
        return (await fileExists(srcUri))
            ? ['  <classpathentry kind="src" path="src"/>']
            : ['  <classpathentry kind="src" path="."/>'];
    }

    return sourcePaths.map(sourcePath => `  <classpathentry kind="src" path="${escapeXml(sourcePath)}"/>`);
}

function getConfiguredJavaSourcePaths(moduleUri: vscode.Uri): string[] {
    const configured = vscode.workspace
        .getConfiguration('modulemanager', moduleUri)
        .get<string[]>(JAVA_SOURCE_PATHS_SETTING);
    if (!Array.isArray(configured)) {
        return [];
    }

    return configured
        .filter((entry): entry is string => typeof entry === 'string')
        .map(normalizeRelativePath)
        .filter(entry => entry !== '' && entry !== '.');
}

async function discoverJavaSourceRoots(moduleUri: vscode.Uri): Promise<string[]> {
    const javaFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(moduleUri, '**/*.java'),
        JAVA_DISCOVERY_EXCLUDES
    );

    const roots = new Set<string>();
    for (const javaFile of javaFiles) {
        roots.add(await inferSourceRootFromJavaFile(moduleUri, javaFile));
    }

    return Array.from(roots).sort((left, right) => left.localeCompare(right));
}

async function inferSourceRootFromJavaFile(moduleUri: vscode.Uri, javaFileUri: vscode.Uri): Promise<string> {
    const content = Buffer.from(await vscode.workspace.fs.readFile(javaFileUri)).toString();
    const packageMatch = content.match(JAVA_PACKAGE_REGEX);
    const packagePath = packageMatch?.[1]?.replace(/\./g, '/');

    const relativeFilePath = normalizeRelativePath(path.relative(moduleUri.fsPath, javaFileUri.fsPath));
    const fileDirectory = relativeFilePath.includes('/')
        ? relativeFilePath.slice(0, relativeFilePath.lastIndexOf('/'))
        : '';

    if (packagePath && (fileDirectory === packagePath || fileDirectory.endsWith(`/${packagePath}`))) {
        const sourceRoot = fileDirectory.slice(0, fileDirectory.length - packagePath.length).replace(/\/$/, '');
        return sourceRoot || '.';
    }

    return fileDirectory || '.';
}

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
