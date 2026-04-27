import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { ManagedModule } from '../types';

const JAVA_CONTAINER = 'org.eclipse.jdt.launching.JRE_CONTAINER';
const ECLIPSE_SETTINGS_DIR = '.settings';
const JDT_CORE_PREFS_FILE = 'org.eclipse.jdt.core.prefs';
const JDT_CORE_PREFS_CONTENT = [
    'eclipse.preferences.version=1',
    'org.eclipse.jdt.core.compiler.problem.forbiddenReference=error',
    ''
].join('\n');

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
    const candidatePaths = ['src/main/java', 'src/test/java', 'src/main/resources'];
    const entries: string[] = [];

    for (const candidatePath of candidatePaths) {
        const candidateUri = vscode.Uri.joinPath(moduleUri, ...candidatePath.split('/'));
        if (await fileExists(candidateUri)) {
            entries.push(`  <classpathentry kind="src" path="${escapeXml(candidatePath)}"/>`);
        }
    }

    if (entries.length === 0) {
        entries.push('  <classpathentry kind="src" path="src/main/java"/>');
    }

    return entries;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}
