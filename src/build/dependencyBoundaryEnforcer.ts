import * as vscode from 'vscode';
import { ManagedModule } from '../types';
import type { DependencyViolation } from '../commands/dependencyManager';

const ENFORCEMENT_PACKAGE = 'modulemanager.enforcement';
const ENFORCEMENT_FILE_PREFIX = 'ModuleManagerDependencyViolation__';
const LEGACY_BLOCKER_PATTERN = '**/ModuleManagerDependencyViolationBlocker*.java';

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
    const enforcementDirUri = vscode.Uri.joinPath(module.moduleUri, 'src', 'main', 'java', 'modulemanager', 'enforcement');
    const className = `${ENFORCEMENT_FILE_PREFIX}${sanitizeJavaIdentifier(module.descriptor.name)}`;
    const fileUri = vscode.Uri.joinPath(enforcementDirUri, `${className}.java`);

    if (violations.length === 0) {
        await deleteIfExists(fileUri);
        return;
    }

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
