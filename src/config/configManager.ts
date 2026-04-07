import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Updates project configuration to include the new module with independence
 * Uses TypeScript/JavaScript composite projects for module isolation
 */
export async function updateProjectConfig(workspaceUri: vscode.Uri, moduleUri: vscode.Uri, moduleName: string): Promise<void> {
    const relativePath = path.relative(workspaceUri.fsPath, moduleUri.fsPath);
    const isTypeScript = await hasTypeScriptConfig(workspaceUri);
    
    // Create module-specific config (for independence)
    await createModuleConfig(moduleUri, moduleName, isTypeScript);

    // Update root config (for global view and path mappings)
    if (isTypeScript) {
        await updateRootTsConfig(workspaceUri, relativePath, moduleName);
    } else {
        await updateRootJsConfig(workspaceUri, relativePath, moduleName);
    }

    // Update VSCode settings and gitignore
    await updateVSCodeSettings(workspaceUri);
    await updateGitignore(workspaceUri);
}

/**
 * Removes a module's path mapping and reference from root config files.
 */
export async function removeModuleFromProjectConfig(
    workspaceUri: vscode.Uri,
    moduleName: string,
    modulePath?: string
): Promise<void> {
    const configUris = [
        vscode.Uri.joinPath(workspaceUri, 'tsconfig.json'),
        vscode.Uri.joinPath(workspaceUri, 'jsconfig.json')
    ];

    for (const configUri of configUris) {
        await removeModuleFromRootConfig(configUri, moduleName, modulePath);
    }
}

/**
 * Creates a module-specific jsconfig.json or tsconfig.json with composite: true
 * This ensures module independence
 */
async function createModuleConfig(moduleUri: vscode.Uri, moduleName: string, useTypeScript: boolean): Promise<void> {
    const tsconfigUri = vscode.Uri.joinPath(moduleUri, 'tsconfig.json');
    const jsconfigUri = vscode.Uri.joinPath(moduleUri, 'jsconfig.json');

    const config = {
        compilerOptions: {
            composite: true,
            baseUrl: ".",
            rootDir: "./src",
            outDir: "./dist",
            declaration: true,
            declarationMap: true,
            sourceMap: true,
            module: "ESNext",
            target: "ES2020",
            moduleResolution: "node"
        },
        include: ["src/**/*"],
        exclude: ["node_modules", "dist"],
        references: [] // Empty by default - dependencies added manually
    };

    const configUri = useTypeScript ? tsconfigUri : jsconfigUri;
    const configContent = JSON.stringify(config, null, 2);
    
    try {
        await vscode.workspace.fs.writeFile(configUri, Buffer.from(configContent));
        console.log(`Created ${useTypeScript ? 'tsconfig' : 'jsconfig'}.json for module ${moduleName}`);
    } catch (error) {
        vscode.window.showWarningMessage(`Could not create module config: ${error}`);
    }
}

/**
 * Checks if the workspace uses TypeScript
 */
async function hasTypeScriptConfig(workspaceUri: vscode.Uri): Promise<boolean> {
    const tsconfigUri = vscode.Uri.joinPath(workspaceUri, 'tsconfig.json');
    try {
        await vscode.workspace.fs.stat(tsconfigUri);
        return true;
    } catch {
        return false;
    }
}

/**
 * Updates root tsconfig.json to include module references and path mappings
 */
async function updateRootTsConfig(workspaceUri: vscode.Uri, modulePath: string, moduleName: string): Promise<void> {
    const tsconfigUri = vscode.Uri.joinPath(workspaceUri, 'tsconfig.json');
    
    let config: any;
    
    try {
        // Read existing config
        const configData = await vscode.workspace.fs.readFile(tsconfigUri);
        const configText = Buffer.from(configData).toString();
        const cleanJson = configText.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
        config = JSON.parse(cleanJson);
    } catch {
        // Create new root config
        config = {
            compilerOptions: {
                baseUrl: ".",
                paths: {}
            },
            references: []
        };
    }

    // Ensure necessary structures exist
    if (!config.compilerOptions) {
        config.compilerOptions = {};
    }
    if (!config.compilerOptions.paths) {
        config.compilerOptions.paths = {};
    }
    if (!config.references) {
        config.references = [];
    }

    // Add path mapping for clean imports
    const pathKey = `@${moduleName}/*`;
    const pathValue = [`${modulePath}/src/*`];
    config.compilerOptions.paths[pathKey] = pathValue;

    // Add module reference (for composite projects)
    const referenceExists = config.references.some((ref: any) => ref.path === `./${modulePath}`);
    if (!referenceExists) {
        config.references.push({ path: `./${modulePath}` });
    }

    // Write updated config
    const updatedConfig = JSON.stringify(config, null, 2);
    await vscode.workspace.fs.writeFile(tsconfigUri, Buffer.from(updatedConfig));
    
    vscode.window.showInformationMessage('Updated tsconfig.json with new module.');
}

/**
 * Updates root jsconfig.json (same logic as TypeScript)
 */
async function updateRootJsConfig(workspaceUri: vscode.Uri, modulePath: string, moduleName: string): Promise<void> {
    const jsconfigUri = vscode.Uri.joinPath(workspaceUri, 'jsconfig.json');
    
    let config: any;
    
    try {
        const configData = await vscode.workspace.fs.readFile(jsconfigUri);
        const configText = Buffer.from(configData).toString();
        const cleanJson = configText.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
        config = JSON.parse(cleanJson);
    } catch {
        // Create new root config
        config = {
            compilerOptions: {
                baseUrl: ".",
                paths: {}
            },
            references: []
        };
    }

    // Ensure structures
    if (!config.compilerOptions) {
        config.compilerOptions = { baseUrl: ".", paths: {} };
    }
    if (!config.compilerOptions.paths) {
        config.compilerOptions.paths = {};
    }
    if (!config.references) {
        config.references = [];
    }

    // Add path mapping
    const pathKey = `@${moduleName}/*`;
    const pathValue = [`${modulePath}/src/*`];
    config.compilerOptions.paths[pathKey] = pathValue;

    // Add reference
    const referenceExists = config.references.some((ref: any) => ref.path === `./${modulePath}`);
    if (!referenceExists) {
        config.references.push({ path: `./${modulePath}` });
    }

    // Write config
    const updatedConfig = JSON.stringify(config, null, 2);
    await vscode.workspace.fs.writeFile(jsconfigUri, Buffer.from(updatedConfig));
    
    vscode.window.showInformationMessage('Updated jsconfig.json with new module.');
}

async function removeModuleFromRootConfig(
    configUri: vscode.Uri,
    moduleName: string,
    modulePath?: string
): Promise<void> {
    let config: any;

    try {
        const configData = await vscode.workspace.fs.readFile(configUri);
        const configText = Buffer.from(configData).toString();
        const cleanJson = configText.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
        config = JSON.parse(cleanJson);
    } catch {
        return;
    }

    if (config.compilerOptions?.paths) {
        delete config.compilerOptions.paths[`@${moduleName}/*`];
    }

    if (Array.isArray(config.references)) {
        const candidatePaths = new Set<string>();
        if (modulePath) {
            candidatePaths.add(normalizeRefPath(modulePath));
        }
        candidatePaths.add(normalizeRefPath(moduleName));
        candidatePaths.add(normalizeRefPath(`src/${moduleName}`));
        candidatePaths.add(normalizeRefPath(`modules/${moduleName}`));

        config.references = config.references.filter((ref: any) => {
            if (!ref || typeof ref.path !== 'string') {
                return true;
            }

            const refPath = normalizeRefPath(ref.path);
            return !candidatePaths.has(refPath) && path.basename(refPath) !== moduleName;
        });
    }

    await vscode.workspace.fs.writeFile(configUri, Buffer.from(JSON.stringify(config, null, 2)));
}

function normalizeRefPath(refPath: string): string {
    const normalized = refPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return normalized;
}

/**
 * Updates VSCode settings to hide internal module files
 */
async function updateVSCodeSettings(workspaceUri: vscode.Uri): Promise<void> {
    const vscodeDir = vscode.Uri.joinPath(workspaceUri, '.vscode');
    const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');
    
    try {
        // Ensure .vscode directory exists
        try {
            await vscode.workspace.fs.createDirectory(vscodeDir);
        } catch {
            // Already exists
        }

        let settings: any = {};
        
        try {
            const settingsData = await vscode.workspace.fs.readFile(settingsUri);
            const settingsText = Buffer.from(settingsData).toString();
            const cleanJson = settingsText.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
            settings = JSON.parse(cleanJson);
        } catch {
            // New settings file
        }

        // Hide .module files from explorer
        if (!settings['files.exclude']) {
            settings['files.exclude'] = {};
        }
        settings['files.exclude']['**/.module'] = true;

        const updatedSettings = JSON.stringify(settings, null, 2);
        await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(updatedSettings));

    } catch (error) {
        console.error('Could not update VSCode settings:', error);
    }
}

/**
 * Updates .gitignore to exclude module internal files
 */
async function updateGitignore(workspaceUri: vscode.Uri): Promise<void> {
    const gitignoreUri = vscode.Uri.joinPath(workspaceUri, '.gitignore');
    
    const gitignoreEntries = [
        '',
        '# ModuleManager - Internal module files',
        '**/.module',
        '**/dist/',
        '**/*.tsbuildinfo'
    ];

    try {
        let existingContent = '';
        
        try {
            const gitignoreData = await vscode.workspace.fs.readFile(gitignoreUri);
            existingContent = Buffer.from(gitignoreData).toString();
        } catch {
            // .gitignore doesn't exist
        }

        // Check if ModuleManager section exists
        if (!existingContent.includes('# ModuleManager')) {
            let newContent = existingContent;
            if (existingContent && !existingContent.endsWith('\n')) {
                newContent += '\n';
            }
            newContent += gitignoreEntries.join('\n') + '\n';

            await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(newContent));
        }

    } catch (error) {
        console.error('Could not update .gitignore:', error);
    }
}

/**
 * Adds a dependency from one module to another
 * Updates the dependent module's config to reference the dependency
 */
export async function addModuleDependency(
    moduleUri: vscode.Uri,
    dependencyModulePath: string
): Promise<void> {
    const configFiles = ['tsconfig.json', 'jsconfig.json'];
    
    for (const configFile of configFiles) {
        const configUri = vscode.Uri.joinPath(moduleUri, configFile);
        
        try {
            const configData = await vscode.workspace.fs.readFile(configUri);
            const configText = Buffer.from(configData).toString();
            const cleanJson = configText.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
            const config = JSON.parse(cleanJson);

            if (!config.references) {
                config.references = [];
            }

            // Calculate relative path from module to dependency
            const relativePath = path.relative(
                path.dirname(configUri.fsPath),
                dependencyModulePath
            ).replace(/\\/g, '/');

            // Check if reference already exists
            const refExists = config.references.some((ref: any) => 
                ref.path === relativePath || ref.path === `./${relativePath}`
            );

            if (!refExists) {
                config.references.push({ path: relativePath });
                
                const updatedConfig = JSON.stringify(config, null, 2);
                await vscode.workspace.fs.writeFile(configUri, Buffer.from(updatedConfig));
                
                vscode.window.showInformationMessage(`Added module dependency in ${configFile}`);
            }

            return; // Found and updated
        } catch {
            // Try next config file
            continue;
        }
    }

    vscode.window.showWarningMessage('Could not find module config file to update.');
}