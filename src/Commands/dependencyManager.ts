import * as vscode from 'vscode';
import * as path from 'path';
import { resolveWorkspaceFolder } from '../utils/utils';

interface ModuleDependency {
    moduleName: string;
    modulePath: string;
    dependencies: string[];
}

type RegistryModule = {
    name: string;
    path?: string;
};

interface MissingDependency {
    sourceModule: string;
    sourceModulePath: string;
    targetModule: string;
    targetModulePath: string;
    filePath: string;
}

/**
 * Adds a dependency from one module to another
 * Validates against circular dependencies before adding
 */
export async function addModuleDependency(resourceUri?: vscode.Uri): Promise<void> {
    const workspaceFolder = await resolveWorkspaceFolder(resourceUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const modules = await getAllModules(workspaceFolder.uri);
    if (modules.length === 0) {
        vscode.window.showWarningMessage('No modules found in the project.');
        return;
    }

    const sourceModule = await vscode.window.showQuickPick(
        modules.map(m => ({
            label: m.moduleName,
            description: m.modulePath,
            module: m
        })),
        {
            placeHolder: 'Select module that needs a dependency'
        }
    );

    if (!sourceModule) {
        return;
    }

    const availableTargets = modules.filter(m => 
        m.moduleName !== sourceModule.module.moduleName &&
        !sourceModule.module.dependencies.includes(m.moduleName)
    );

    if (availableTargets.length === 0) {
        vscode.window.showWarningMessage(`Module "${sourceModule.module.moduleName}" already depends on all other modules.`);
        return;
    }

    const targetModule = await vscode.window.showQuickPick(
        availableTargets.map(m => ({
            label: m.moduleName,
            description: m.modulePath,
            module: m
        })),
        {
            placeHolder: 'Select dependency to add'
        }
    );

    if (!targetModule) {
        return;
    }

    const wouldCreateCycle = await checkCircularDependency(
        modules,
        sourceModule.module.moduleName,
        targetModule.module.moduleName
    );

    if (wouldCreateCycle) {
        vscode.window.showErrorMessage(
            `Cannot add dependency: This would create a circular dependency between "${sourceModule.module.moduleName}" and "${targetModule.module.moduleName}".`
        );
        return;
    }

    try {
        await addDependencyToConfig(
            workspaceFolder.uri,
            sourceModule.module.modulePath,
            targetModule.module.modulePath
        );

        vscode.window.showInformationMessage(
            `Added dependency: "${sourceModule.module.moduleName}" now depends on "${targetModule.module.moduleName}".`
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to add dependency: ${error}`);
    }
}

/**
 * Removes a dependency from a module
 */
export async function removeModuleDependency(resourceUri?: vscode.Uri): Promise<void> {
    const workspaceFolder = await resolveWorkspaceFolder(resourceUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    // Step 1: Get all modules
    const modules = await getAllModules(workspaceFolder.uri);
    if (modules.length === 0) {
        vscode.window.showWarningMessage('No modules found in the project.');
        return;
    }

    // Step 2: Select module
    const modulesWithDeps = modules.filter(m => m.dependencies.length > 0);
    if (modulesWithDeps.length === 0) {
        vscode.window.showInformationMessage('No modules have dependencies to remove.');
        return;
    }

    const selectedModule = await vscode.window.showQuickPick(
        modulesWithDeps.map(m => ({
            label: m.moduleName,
            description: `Dependencies: ${m.dependencies.join(', ')}`,
            module: m
        })),
        {
            placeHolder: 'Select module to remove dependency from'
        }
    );

    if (!selectedModule) {
        return;
    }

    // Step 3: Select dependency to remove
    const dependencyToRemove = await vscode.window.showQuickPick(
        selectedModule.module.dependencies.map(dep => ({
            label: dep,
            dependency: dep
        })),
        {
            placeHolder: 'Select dependency to remove'
        }
    );

    if (!dependencyToRemove) {
        return;
    }

    // Step 4: Remove the dependency
    try {
        const targetModule = modules.find(m => m.moduleName === dependencyToRemove.dependency);
        if (!targetModule) {
            throw new Error('Target module not found');
        }

        await removeDependencyFromConfig(
            workspaceFolder.uri,
            selectedModule.module.modulePath,
            targetModule.modulePath
        );

        vscode.window.showInformationMessage(
            `Removed dependency: "${selectedModule.module.moduleName}" no longer depends on "${dependencyToRemove.dependency}".`
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to remove dependency: ${error}`);
    }
}

/**
 * Shows all module dependencies in the project
 */
export async function showModuleDependencies(resourceUri?: vscode.Uri): Promise<void> {
    const workspaceFolder = await resolveWorkspaceFolder(resourceUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const modules = await getAllModules(workspaceFolder.uri);
    if (modules.length === 0) {
        vscode.window.showWarningMessage('No modules found in the project.');
        return;
    }

    // Build dependency tree display
    let output = '# Module Dependencies\n\n';
    
    for (const module of modules) {
        output += `## ${module.moduleName}\n`;
        output += `Path: ${module.modulePath}\n`;
        
        if (module.dependencies.length === 0) {
            output += 'Dependencies: None\n';
        } else {
            output += `Dependencies:\n`;
            for (const dep of module.dependencies) {
                output += `  - ${dep}\n`;
            }
        }
        output += '\n';
    }

    // Check for circular dependencies
    const cycles = detectAllCircularDependencies(modules);
    if (cycles.length > 0) {
        output += '## ⚠️ Circular Dependencies Detected\n\n';
        for (const cycle of cycles) {
            output += `- ${cycle.join(' → ')}\n`;
        }
    }

    // Show in a new document
    const doc = await vscode.workspace.openTextDocument({
        content: output,
        language: 'markdown'
    });
    await vscode.window.showTextDocument(doc);
}

/**
 * Validates imports across modules and offers a one-click fix to add missing dependencies.
 */
export async function validateModuleDependencies(resourceUri?: vscode.Uri): Promise<void> {
    const workspaceFolder = await resolveWorkspaceFolder(resourceUri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const modules = await getAllModules(workspaceFolder.uri);
    if (modules.length < 2) {
        vscode.window.showInformationMessage('Not enough modules found to validate dependencies.');
        return;
    }

    const missingDependencies = await findMissingDependencies(workspaceFolder.uri, modules);
    if (missingDependencies.length === 0) {
        vscode.window.showInformationMessage('No missing module dependencies were detected.');
        return;
    }

    const selected = await vscode.window.showQuickPick(
        missingDependencies.map(item => ({
            label: `${item.sourceModule} -> ${item.targetModule}`,
            description: path.relative(workspaceFolder.uri.fsPath, item.filePath),
            detail: 'Add missing dependency reference',
            item
        })),
        {
            placeHolder: 'Select a missing dependency to fix'
        }
    );

    if (!selected) {
        return;
    }

    const wouldCreateCycle = await checkCircularDependency(
        modules,
        selected.item.sourceModule,
        selected.item.targetModule
    );

    if (wouldCreateCycle) {
        vscode.window.showErrorMessage(
            `Cannot add dependency ${selected.item.sourceModule} -> ${selected.item.targetModule}: this would create a circular dependency.`
        );
        return;
    }

    try {
        await addDependencyToConfig(
            workspaceFolder.uri,
            selected.item.sourceModulePath,
            selected.item.targetModulePath
        );

        vscode.window.showInformationMessage(
            `Added dependency: "${selected.item.sourceModule}" now depends on "${selected.item.targetModule}".`
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to add dependency: ${error}`);
    }
}

/**
 * Gets all modules in the workspace with their dependencies
 */
async function getAllModules(workspaceUri: vscode.Uri): Promise<ModuleDependency[]> {
    const modules: ModuleDependency[] = [];

    // Read modules.json
    const modulesJsonUri = vscode.Uri.joinPath(workspaceUri, '.vscode', 'modules.json');
    try {
        const data = await vscode.workspace.fs.readFile(modulesJsonUri);
        const modulesConfig = JSON.parse(Buffer.from(data).toString());
        const moduleEntries = getRegistryModules(modulesConfig);

        for (const moduleConfig of moduleEntries) {
            // Find the module directory
            const modulePath = await findModulePath(workspaceUri, moduleConfig.name, moduleConfig.path);
            if (!modulePath) {
                continue;
            }

            // Read dependencies from module config
            const dependencies = await getModuleDependencies(vscode.Uri.file(modulePath));

            modules.push({
                moduleName: moduleConfig.name,
                modulePath: path.relative(workspaceUri.fsPath, modulePath).replace(/\\/g, '/'),
                dependencies
            });
        }
    } catch (error) {
        console.error('Error reading modules:', error);
    }

    return modules;
}

function getRegistryModules(modulesConfig: any): RegistryModule[] {
    const registryModules = modulesConfig?.modules;

    if (Array.isArray(registryModules)) {
        return registryModules
            .filter((entry: any) => typeof entry?.name === 'string')
            .map((entry: any) => ({
                name: entry.name,
                path: typeof entry.path === 'string' ? entry.path : undefined
            }));
    }

    if (registryModules && typeof registryModules === 'object') {
        return Object.values(registryModules)
            .filter((entry: any) => typeof entry?.name === 'string')
            .map((entry: any) => ({
                name: entry.name,
                path: typeof entry.path === 'string' ? entry.path : undefined
            }));
    }

    return [];
}

/**
 * Finds the full path of a module by name
 */
async function findModulePath(
    workspaceUri: vscode.Uri,
    moduleName: string,
    storedModulePath?: string
): Promise<string | null> {
    const possiblePaths: string[] = [];

    if (storedModulePath) {
        possiblePaths.push(path.join(workspaceUri.fsPath, storedModulePath));
    }

    // Legacy fallback locations for older registry entries.
    possiblePaths.push(
        path.join(workspaceUri.fsPath, moduleName),
        path.join(workspaceUri.fsPath, 'src', moduleName),
        path.join(workspaceUri.fsPath, 'modules', moduleName)
    );

    for (const possiblePath of possiblePaths) {
        try {
            const moduleMarker = vscode.Uri.file(path.join(possiblePath, '.module'));
            await vscode.workspace.fs.stat(moduleMarker);
            return possiblePath;
        } catch {
            continue;
        }
    }

    return null;
}

/**
 * Gets dependencies from a module's config file
 */
async function getModuleDependencies(moduleUri: vscode.Uri): Promise<string[]> {
    const configFiles = ['tsconfig.json', 'jsconfig.json'];
    
    for (const configFile of configFiles) {
        try {
            const configUri = vscode.Uri.joinPath(moduleUri, configFile);
            const data = await vscode.workspace.fs.readFile(configUri);
            const config = JSON.parse(Buffer.from(data).toString());

            if (config.references && Array.isArray(config.references)) {
                // Extract module names from reference paths
                return config.references.map((ref: any) => {
                    const refPath = ref.path.replace(/^\.\.\//, '');
                    return path.basename(refPath);
                });
            }
        } catch {
            continue;
        }
    }

    return [];
}

/**
 * Checks if adding a dependency would create a circular dependency
 */
async function checkCircularDependency(
    modules: ModuleDependency[],
    sourceModule: string,
    targetModule: string
): Promise<boolean> {
    // Build dependency graph
    const graph = new Map<string, string[]>();
    for (const module of modules) {
        graph.set(module.moduleName, module.dependencies);
    }

    // Simulate adding the new dependency
    const sourceDeps = graph.get(sourceModule) || [];
    graph.set(sourceModule, [...sourceDeps, targetModule]);

    // Check if targetModule can reach sourceModule (which would create a cycle)
    return canReach(graph, targetModule, sourceModule, new Set());
}

/**
 * Checks if 'from' can reach 'to' in the dependency graph (DFS)
 */
function canReach(
    graph: Map<string, string[]>,
    from: string,
    to: string,
    visited: Set<string>
): boolean {
    if (from === to) {
        return true;
    }

    if (visited.has(from)) {
        return false;
    }

    visited.add(from);

    const dependencies = graph.get(from) || [];
    for (const dep of dependencies) {
        if (canReach(graph, dep, to, visited)) {
            return true;
        }
    }

    return false;
}

/**
 * Detects all circular dependencies in the project
 */
function detectAllCircularDependencies(modules: ModuleDependency[]): string[][] {
    const graph = new Map<string, string[]>();
    for (const module of modules) {
        graph.set(module.moduleName, module.dependencies);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recStack = new Set<string>();

    function dfs(node: string, path: string[]): void {
        visited.add(node);
        recStack.add(node);
        path.push(node);

        const deps = graph.get(node) || [];
        for (const dep of deps) {
            if (!visited.has(dep)) {
                dfs(dep, [...path]);
            } else if (recStack.has(dep)) {
                // Found a cycle
                const cycleStart = path.indexOf(dep);
                if (cycleStart !== -1) {
                    cycles.push([...path.slice(cycleStart), dep]);
                }
            }
        }

        recStack.delete(node);
    }

    for (const module of modules) {
        if (!visited.has(module.moduleName)) {
            dfs(module.moduleName, []);
        }
    }

    return cycles;
}

/**
 * Adds a dependency to a module's config file
 */
async function addDependencyToConfig(
    workspaceUri: vscode.Uri,
    sourceModulePath: string,
    targetModulePath: string
): Promise<void> {
    const sourceModuleUri = vscode.Uri.file(path.join(workspaceUri.fsPath, sourceModulePath));
    const configFiles = ['tsconfig.json', 'jsconfig.json'];

    for (const configFile of configFiles) {
        try {
            const configUri = vscode.Uri.joinPath(sourceModuleUri, configFile);
            const data = await vscode.workspace.fs.readFile(configUri);
            const config = JSON.parse(Buffer.from(data).toString());

            if (!config.references) {
                config.references = [];
            }

            // Calculate relative path from source to target
            const relativePath = path.relative(
                sourceModuleUri.fsPath,
                path.join(workspaceUri.fsPath, targetModulePath)
            ).replace(/\\/g, '/');
            const normalizedRelativePath = normalizeDependencyReferencePath(relativePath);

            // Add reference if it doesn't exist
            const refExists = config.references.some((ref: any) =>
                typeof ref?.path === 'string' && normalizeDependencyReferencePath(ref.path) === normalizedRelativePath
            );

            if (!refExists) {
                config.references.push({ path: normalizedRelativePath });
            }

            // Write updated config
            const updatedConfig = JSON.stringify(config, null, 2);
            await vscode.workspace.fs.writeFile(configUri, Buffer.from(updatedConfig));
            return;
        } catch {
            continue;
        }
    }

    throw new Error('Could not find module config file');
}

/**
 * Removes a dependency from a module's config file
 */
async function removeDependencyFromConfig(
    workspaceUri: vscode.Uri,
    sourceModulePath: string,
    targetModulePath: string
): Promise<void> {
    const sourceModuleUri = vscode.Uri.file(path.join(workspaceUri.fsPath, sourceModulePath));
    const canonicalTargetRef = normalizeDependencyReferencePath(
        path.relative(sourceModuleUri.fsPath, path.join(workspaceUri.fsPath, targetModulePath)).replace(/\\/g, '/')
    );
    const configFiles = ['tsconfig.json', 'jsconfig.json'];

    for (const configFile of configFiles) {
        try {
            const configUri = vscode.Uri.joinPath(sourceModuleUri, configFile);
            const data = await vscode.workspace.fs.readFile(configUri);
            const config = JSON.parse(Buffer.from(data).toString());

            if (!config.references || !Array.isArray(config.references)) {
                continue;
            }

            // Remove the reference
            config.references = config.references.filter((ref: any) => {
                if (typeof ref?.path !== 'string') {
                    return true;
                }

                return normalizeDependencyReferencePath(ref.path) !== canonicalTargetRef;
            });

            // Write updated config
            const updatedConfig = JSON.stringify(config, null, 2);
            await vscode.workspace.fs.writeFile(configUri, Buffer.from(updatedConfig));
            return;
        } catch {
            continue;
        }
    }

    throw new Error('Could not find module config file');
}

async function findMissingDependencies(
    workspaceUri: vscode.Uri,
    modules: ModuleDependency[]
): Promise<MissingDependency[]> {
    const moduleByName = new Map<string, ModuleDependency>();
    for (const module of modules) {
        moduleByName.set(module.moduleName, module);
    }

    const results = new Map<string, MissingDependency>();

    for (const sourceModule of modules) {
        const sourceModuleRoot = vscode.Uri.file(path.join(workspaceUri.fsPath, sourceModule.modulePath));
        const pattern = new vscode.RelativePattern(sourceModuleRoot, 'src/**/*.{ts,tsx,js,jsx}');
        const files = await vscode.workspace.findFiles(pattern);

        for (const file of files) {
            const data = await vscode.workspace.fs.readFile(file);
            const content = Buffer.from(data).toString();
            const imports = extractImportSpecifiers(content);

            for (const specifier of imports) {
                const targetModuleName = extractAliasedModuleName(specifier);
                if (!targetModuleName || targetModuleName === sourceModule.moduleName) {
                    continue;
                }

                const targetModule = moduleByName.get(targetModuleName);
                if (!targetModule) {
                    continue;
                }

                if (sourceModule.dependencies.includes(targetModuleName)) {
                    continue;
                }

                const key = `${sourceModule.moduleName}->${targetModuleName}`;
                if (!results.has(key)) {
                    results.set(key, {
                        sourceModule: sourceModule.moduleName,
                        sourceModulePath: sourceModule.modulePath,
                        targetModule: targetModule.moduleName,
                        targetModulePath: targetModule.modulePath,
                        filePath: file.fsPath
                    });
                }
            }
        }
    }

    return Array.from(results.values());
}

export function extractImportSpecifiers(source: string): string[] {
    const specifiers = new Set<string>();

    const importRegex = /import\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g;
    const dynamicImportRegex = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
    const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

    for (const regex of [importRegex, dynamicImportRegex, requireRegex]) {
        let match: RegExpExecArray | null;
        while ((match = regex.exec(source)) !== null) {
            if (match[1]) {
                specifiers.add(match[1]);
            }
        }
    }

    return Array.from(specifiers);
}

export function extractAliasedModuleName(importSpecifier: string): string | null {
    const aliasMatch = importSpecifier.match(/^@([^/]+)\//);
    return aliasMatch ? aliasMatch[1] : null;
}

export function normalizeDependencyReferencePath(refPath: string): string {
    return refPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}