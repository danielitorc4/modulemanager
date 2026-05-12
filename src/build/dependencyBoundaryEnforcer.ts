import * as path from 'path';
import * as vscode from 'vscode';
import { ManagedModule } from '../types';
import type { DependencyViolation } from '../commands/dependencyManager';

const ENFORCEMENT_PACKAGE = 'modulemanager.enforcement';
const ENFORCEMENT_FILE_PREFIX = 'ModuleManagerDependencyViolation__';
const LEGACY_BLOCKER_PATTERN = '**/ModuleManagerDependencyViolationBlocker*.java';
const ENFORCEMENT_FILE_PATTERN = '**/modulemanager/enforcement/ModuleManagerDependencyViolation__*.java';
const SOURCE_SCAN_EXCLUDE = '**/{.git,.settings,node_modules,.modulemanager,target,build,out,bin,dist}/**';
const JAVA_PACKAGE_REGEX = /^\s*package\s+([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)*)\s*;/m;

export async function syncDependencyBoundaryEnforcement(
    modules: ManagedModule[],
    violations: DependencyViolation[]
): Promise<void> {
    const violationsByModule = new Map<string, DependencyViolation[]>();
    for (const violation of violations) {
        const violationsForModule = violationsByModule.get(violation.sourceModule) ?? [];
        violationsForModule.push(violation);
        violationsByModule.set(violation.sourceModule, violationsForModule);
    }

    for (const module of modules) {
        const moduleViolations = violationsByModule.get(module.descriptor.name) ?? [];
        await deleteLegacyBlockers(module.moduleUri);
        await syncModuleViolationFile(module, moduleViolations);
    }
}

async function syncModuleViolationFile(module: ManagedModule, violations: DependencyViolation[]): Promise<void> {
    // Always remove every previously generated enforcement file for this module
    // first — including files that older versions of the extension wrote at a
    // different source-root location. Otherwise a stale blocker at
    // `src/main/java/...` plus the user's flat `src/Foo.java` produces two
    // source roots and triggers "Cannot nest 'src/main/java' inside 'src'".
    await deleteAllEnforcementFiles(module.moduleUri);

    if (violations.length === 0) {
        return;
    }

    const sourceRootSegments = await resolveEnforcementSourceRootSegments(module.moduleUri);
    const enforcementDirUri = vscode.Uri.joinPath(
        module.moduleUri,
        ...sourceRootSegments,
        'modulemanager',
        'enforcement'
    );
    const className = `${ENFORCEMENT_FILE_PREFIX}${sanitizeJavaIdentifier(module.descriptor.name)}`;
    const fileUri = vscode.Uri.joinPath(enforcementDirUri, `${className}.java`);

    await vscode.workspace.fs.createDirectory(enforcementDirUri);

    const uniqueViolations = deduplicateViolations(violations);
    const detailLines = uniqueViolations.map((violation, index) =>
        `        String violation_${index + 1} = "${escapeJavaString(
            `${violation.sourceModule} imports ${violation.targetModule} via ${violation.importName}`
        )}";`
    );

    const source = [
        `package ${ENFORCEMENT_PACKAGE};`,
        '',
        `public final class ${className} {`,
        `    private ${className}() {}`,
        '',
        '    public static void enforceDependencyBoundary() {',
        ...detailLines,
        '        int compileFailure = "ModuleManager dependency boundary violation";',
        '    }',
        '}',
        ''
    ].join('\n');

    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(source));
}

async function deleteAllEnforcementFiles(moduleUri: vscode.Uri): Promise<void> {
    const pattern = new vscode.RelativePattern(moduleUri, ENFORCEMENT_FILE_PATTERN);
    const found = await vscode.workspace.findFiles(pattern);
    for (const fileUri of found) {
        await deleteIfExists(fileUri);
    }
}

/**
 * Picks the source-root path (as path segments) into which the enforcement
 * blocker class should be written. The goal is to put it inside the same
 * source root the user's own code already lives in, so JDTLS does not end up
 * with two overlapping source folders.
 */
async function resolveEnforcementSourceRootSegments(moduleUri: vscode.Uri): Promise<string[]> {
    const javaFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(moduleUri, '**/*.java'),
        SOURCE_SCAN_EXCLUDE
    );

    for (const javaFile of javaFiles) {
        const relativePath = path.relative(moduleUri.fsPath, javaFile.fsPath).replace(/\\/g, '/');
        // Skip any enforcement files (left over from a previous run or about to
        // be deleted) — they would otherwise lock us into the old layout.
        if (relativePath.includes('modulemanager/enforcement/')) {
            continue;
        }

        const content = Buffer.from(await vscode.workspace.fs.readFile(javaFile)).toString();
        const packageMatch = content.match(JAVA_PACKAGE_REGEX);
        const packagePath = packageMatch?.[1]?.replace(/\./g, '/');
        const fileDirectory = relativePath.includes('/')
            ? relativePath.slice(0, relativePath.lastIndexOf('/'))
            : '';

        let sourceRoot: string;
        if (packagePath && (fileDirectory === packagePath || fileDirectory.endsWith(`/${packagePath}`))) {
            sourceRoot = fileDirectory.slice(0, fileDirectory.length - packagePath.length).replace(/\/$/, '');
        } else {
            sourceRoot = fileDirectory;
        }

        return sourceRoot === '' ? ['.'] : sourceRoot.split('/');
    }

    // No user code yet — fall back to the conventional Maven layout when the
    // module was bootstrapped with src/main/java, otherwise the flat src/ root.
    if (await pathExists(vscode.Uri.joinPath(moduleUri, 'src', 'main', 'java'))) {
        return ['src', 'main', 'java'];
    }
    if (await pathExists(vscode.Uri.joinPath(moduleUri, 'src'))) {
        return ['src'];
    }
    return ['.'];
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function deleteLegacyBlockers(moduleUri: vscode.Uri): Promise<void> {
    const pattern = new vscode.RelativePattern(moduleUri, LEGACY_BLOCKER_PATTERN);
    const legacyBlockers = await vscode.workspace.findFiles(pattern);
    for (const blockerUri of legacyBlockers) {
        await deleteIfExists(blockerUri);
    }
}

function deduplicateViolations(violations: DependencyViolation[]): DependencyViolation[] {
    const seen = new Set<string>();
    const unique: DependencyViolation[] = [];

    for (const violation of violations) {
        const key = `${violation.sourceModule}::${violation.targetModule}::${violation.importName}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        unique.push(violation);
    }

    return unique;
}

function sanitizeJavaIdentifier(value: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9_]/g, '_');
    if (!sanitized) {
        return 'module';
    }

    if (/^[0-9]/.test(sanitized)) {
        return `_${sanitized}`;
    }

    return sanitized;
}

function escapeJavaString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
    try {
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
    } catch {
        // Keep deletion idempotent.
    }
}
