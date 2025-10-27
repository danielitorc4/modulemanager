import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Updates TypeScript or JavaScript configuration to include the new module
 */
export async function updateProjectConfig(workspaceUri: vscode.Uri, modulePath: string): Promise<void> {
    // Try to update tsconfig.json first, then jsconfig.json
    const tsconfigUpdated = await updateTsConfig(workspaceUri, modulePath);
    
    if (!tsconfigUpdated) {
        await updateJsConfig(workspaceUri, modulePath);
    }

    // Update VSCode settings to hide .module files
    await updateVSCodeSettings(workspaceUri);

    // Update or create .gitignore
    await updateGitignore(workspaceUri);
}

/**
 * Updates tsconfig.json to include the module in the compilation
 */
async function updateTsConfig(workspaceUri: vscode.Uri, modulePath: string): Promise<boolean> {
    const tsconfigUri = vscode.Uri.joinPath(workspaceUri, 'tsconfig.json');
    
    try {
        // Check if tsconfig.json exists
        const configData = await vscode.workspace.fs.readFile(tsconfigUri);
        const configText = Buffer.from(configData).toString();
        
        // Parse JSON (handling comments using a simple approach)
        let config: any;
        try {
            // Remove comments for parsing
            const cleanJson = configText.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
            config = JSON.parse(cleanJson);
        } catch {
            vscode.window.showWarningMessage('Could not parse tsconfig.json. Please add module paths manually.');
            return false;
        }

        // Ensure include array exists
        if (!config.include) {
            config.include = [];
        }

        // Add module paths to include
        const modulePattern = `${modulePath}/**/*`;
        if (!config.include.includes(modulePattern)) {
            config.include.push(modulePattern);
        }

        // Ensure compilerOptions and paths exist for better IntelliSense
        if (!config.compilerOptions) {
            config.compilerOptions = {};
        }
        if (!config.compilerOptions.paths) {
            config.compilerOptions.paths = {};
        }

        // Add path mapping for cleaner imports (e.g., @moduleName/*)
        const moduleName = path.basename(modulePath);
        const pathKey = `@${moduleName}/*`;
        const pathValue = [`${modulePath}/src/*`];
        
        if (!config.compilerOptions.paths[pathKey]) {
            config.compilerOptions.paths[pathKey] = pathValue;
        }

        // Write back (pretty printed)
        const updatedConfig = JSON.stringify(config, null, 2);
        await vscode.workspace.fs.writeFile(tsconfigUri, Buffer.from(updatedConfig));
        
        vscode.window.showInformationMessage('Updated tsconfig.json to include new module.');
        return true;

    } catch (error) {
        // tsconfig.json doesn't exist or couldn't be read
        return false;
    }
}

/**
 * Updates jsconfig.json (similar to tsconfig.json)
 */
async function updateJsConfig(workspaceUri: vscode.Uri, modulePath: string): Promise<boolean> {
    const jsconfigUri = vscode.Uri.joinPath(workspaceUri, 'jsconfig.json');
    
    try {
        // Try to read existing jsconfig.json
        let config: any;
        try {
            const configData = await vscode.workspace.fs.readFile(jsconfigUri);
            const configText = Buffer.from(configData).toString();
            const cleanJson = configText.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
            config = JSON.parse(cleanJson);
        } catch {
            // Create new jsconfig.json if it doesn't exist
            config = {
                compilerOptions: {
                    baseUrl: ".",
                    paths: {}
                },
                include: []
            };
        }

        // Ensure include array exists
        if (!config.include) {
            config.include = [];
        }

        // Add module paths
        const modulePattern = `${modulePath}/**/*`;
        if (!config.include.includes(modulePattern)) {
            config.include.push(modulePattern);
        }

        // Add path mapping
        if (!config.compilerOptions) {
            config.compilerOptions = { baseUrl: ".", paths: {} };
        }
        if (!config.compilerOptions.paths) {
            config.compilerOptions.paths = {};
        }

        const moduleName = path.basename(modulePath);
        const pathKey = `@${moduleName}/*`;
        const pathValue = [`${modulePath}/src/*`];
        
        if (!config.compilerOptions.paths[pathKey]) {
            config.compilerOptions.paths[pathKey] = pathValue;
        }

        // Write config
        const updatedConfig = JSON.stringify(config, null, 2);
        await vscode.workspace.fs.writeFile(jsconfigUri, Buffer.from(updatedConfig));
        
        vscode.window.showInformationMessage('Updated jsconfig.json to include new module.');
        return true;

    } catch (error) {
        vscode.window.showWarningMessage('Could not update jsconfig.json. Module created but IntelliSense may not work properly.');
        return false;
    }
}

/**
 * Updates VSCode settings to hide .module files
 */
async function updateVSCodeSettings(workspaceUri: vscode.Uri): Promise<void> {
    const vscodeDir = vscode.Uri.joinPath(workspaceUri, '.vscode');
    const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');
    
    try {
        // Ensure .vscode directory exists
        try {
            await vscode.workspace.fs.createDirectory(vscodeDir);
        } catch {
            // Directory already exists
        }

        let settings: any = {};
        
        try {
            // Try to read existing settings
            const settingsData = await vscode.workspace.fs.readFile(settingsUri);
            const settingsText = Buffer.from(settingsData).toString();
            const cleanJson = settingsText.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
            settings = JSON.parse(cleanJson);
        } catch {
            // Settings file doesn't exist, will create new one
        }

        // Add .module to files.exclude
        if (!settings['files.exclude']) {
            settings['files.exclude'] = {};
        }
        
        settings['files.exclude']['**/.module'] = true;

        // Write settings
        const updatedSettings = JSON.stringify(settings, null, 2);
        await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(updatedSettings));

    } catch (error) {
        // Non-critical, just log
        console.error('Could not update VSCode settings:', error);
    }
}

/**
 * Updates .gitignore to include module-related files
 */
async function updateGitignore(workspaceUri: vscode.Uri): Promise<void> {
    const gitignoreUri = vscode.Uri.joinPath(workspaceUri, '.gitignore');
    
    const gitignoreEntries = [
        '# ModuleManager',
        '**/.module'
    ];

    try {
        let existingContent = '';
        
        try {
            const gitignoreData = await vscode.workspace.fs.readFile(gitignoreUri);
            existingContent = Buffer.from(gitignoreData).toString();
        } catch {
            // .gitignore doesn't exist
        }

        // Check if entries already exist
        let needsUpdate = false;
        let newContent = existingContent;

        for (const entry of gitignoreEntries) {
            if (!existingContent.includes(entry)) {
                needsUpdate = true;
            }
        }

        if (needsUpdate) {
            // Add entries
            if (existingContent && !existingContent.endsWith('\n')) {
                newContent += '\n';
            }
            newContent += '\n' + gitignoreEntries.join('\n') + '\n';

            await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(newContent));
        }

    } catch (error) {
        // Non-critical
        console.error('Could not update .gitignore:', error);
    }
}