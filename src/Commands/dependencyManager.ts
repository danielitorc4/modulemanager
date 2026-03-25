import * as vscode from 'vscode';
import * as path from 'path';

interface ModuleDependency {
    moduleName: string;
    modulePath: string;
    dependencies: string[];
}

/**
 * Adds a dependency from one module to another
 * Validates against circular dependencies before adding
 */
export async function addModuleDependency(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
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
export async function removeModuleDependency(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
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
export async function showModuleDependencies(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
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
 * Gets all modules in the workspace with their dependencies
 */
async function getAllModules(workspaceUri: vscode.Uri): Promise<ModuleDependency[]> {
    const modules: ModuleDependency[] = [];

    // Read modules.json
    const modulesJsonUri = vscode.Uri.joinPath(workspaceUri, '.vscode', 'modules.json');
    try {
        const data = await vscode.workspace.fs.readFile(modulesJsonUri);
        const modulesConfig = JSON.parse(Buffer.from(data).toString());

        for (const moduleConfig of modulesConfig.modules) {
            // Find the module directory
            const modulePath = await findModulePath(workspaceUri, moduleConfig.name);
            if (!modulePath) {
                continue;
            }

            // Read dependencies from module config
            const dependencies = await getModuleDependencies(vscode.Uri.file(modulePath));

            modules.push({
                moduleName: moduleConfig.name,
                modulePath: path.relative(workspaceUri.fsPath, modulePath),
                dependencies
            });
        }
    } catch (error) {
        console.error('Error reading modules:', error);
    }

    return modules;
}

/**
 * Finds the full path of a module by name
 */
async function findModulePath(workspaceUri: vscode.Uri, moduleName: string): Promise<string | null> {
    // Search in common locations
    const possiblePaths = [
        path.join(workspaceUri.fsPath, moduleName),
        path.join(workspaceUri.fsPath, 'src', moduleName),
        path.join(workspaceUri.fsPath, 'modules', moduleName)
    ];

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

            // Add reference if it doesn't exist
            const refExists = config.references.some((ref: any) =>
                ref.path === relativePath || ref.path === `./${relativePath}`
            );

            if (!refExists) {
                config.references.push({ path: `../${path.basename(targetModulePath)}` });
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
    const targetModuleName = path.basename(targetModulePath);
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
                const refPath = ref.path.replace(/^\.\.\//, '');
                return refPath !== targetModuleName;
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