import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_PATHS, REGEX } from '../constants';
import { findModuleDescriptors } from '../moduleDescriptors';
import { DiscoveredModule } from '../types';

/**
 * Synchronizes module and root project config files from declarative module descriptors.
 */
export async function syncWorkspaceModuleConfigs(workspaceUri: vscode.Uri): Promise<void> {
	const modules = await findModuleDescriptors(workspaceUri);
	const moduleByName = new Map(modules.map(module => [module.descriptor.name, module]));
	const useTypeScript = await hasTypeScriptConfig(workspaceUri);

	for (const module of modules) {
		await syncModuleConfig(workspaceUri, module, moduleByName, useTypeScript);
	}

	await syncRootConfig(workspaceUri, modules, useTypeScript);
	await updateVSCodeSettings(workspaceUri);
	await updateGitignore(workspaceUri);
}

/**
 * Backward-compatible entry point used by module creation flow.
 */
export async function updateProjectConfig(workspaceUri: vscode.Uri): Promise<void> {
	await syncWorkspaceModuleConfigs(workspaceUri);
}

/**
 * Backward-compatible entry point used by cleanup flows.
 */
export async function removeModuleFromProjectConfig(
	workspaceUri: vscode.Uri
): Promise<void> {
	await syncWorkspaceModuleConfigs(workspaceUri);
}

async function syncModuleConfig(
	workspaceUri: vscode.Uri,
	module: DiscoveredModule,
	moduleByName: Map<string, DiscoveredModule>,
	useTypeScript: boolean
): Promise<void> {
	const moduleConfigUri = await resolveModuleConfigUri(module.moduleUri, useTypeScript);
	const config = await readJsonConfig(moduleConfigUri, {
		compilerOptions: {
			composite: true,
			baseUrl: '.',
			rootDir: `./${module.descriptor.sourceRoot}`,
			outDir: './dist',
			declaration: true,
			declarationMap: true,
			sourceMap: true,
			module: 'ESNext',
			target: 'ES2020',
			moduleResolution: 'node'
		},
		include: [`${module.descriptor.sourceRoot}/**/*`],
		exclude: ['node_modules', 'dist'],
		references: []
	});

	config.compilerOptions = config.compilerOptions || {};
	config.compilerOptions.composite = true;
	config.compilerOptions.baseUrl = config.compilerOptions.baseUrl || '.';
	config.compilerOptions.rootDir = config.compilerOptions.rootDir || `./${module.descriptor.sourceRoot}`;
	config.include = config.include || [`${module.descriptor.sourceRoot}/**/*`];
	config.exclude = config.exclude || ['node_modules', 'dist'];

	const references = module.descriptor.dependencies
		.map(dependencyName => moduleByName.get(dependencyName))
		.filter((dependencyModule): dependencyModule is DiscoveredModule => Boolean(dependencyModule))
		.map(dependencyModule => {
			const relativePath = path
				.relative(module.moduleUri.fsPath, dependencyModule.moduleUri.fsPath)
				.replace(/\\/g, '/');
			return { path: normalizeRefPath(relativePath) };
		});

	config.references = references;
	await writeJsonConfig(moduleConfigUri, config);
}

async function syncRootConfig(
	workspaceUri: vscode.Uri,
	modules: DiscoveredModule[],
	useTypeScript: boolean
): Promise<void> {
	const rootConfigUri = vscode.Uri.joinPath(
		workspaceUri,
		useTypeScript ? CONFIG_PATHS.TSCONFIG : CONFIG_PATHS.JSCONFIG
	);
	const config = await readJsonConfig(rootConfigUri, {
		compilerOptions: {
			baseUrl: '.',
			paths: {}
		},
		references: []
	});

	config.compilerOptions = config.compilerOptions || {};
	config.compilerOptions.baseUrl = config.compilerOptions.baseUrl || '.';
	config.compilerOptions.paths = config.compilerOptions.paths || {};

	const modulePaths: Record<string, string[]> = {};
	for (const module of modules) {
		modulePaths[`@${module.descriptor.name}/*`] = [`${module.modulePath}/${module.descriptor.sourceRoot}/*`];
	}
	config.compilerOptions.paths = {
		...config.compilerOptions.paths,
		...modulePaths
	};

	config.references = modules.map(module => ({ path: `./${module.modulePath}` }));
	await writeJsonConfig(rootConfigUri, config);
}

async function resolveModuleConfigUri(moduleUri: vscode.Uri, useTypeScript: boolean): Promise<vscode.Uri> {
	const tsconfigUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.TSCONFIG);
	const jsconfigUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.JSCONFIG);

	for (const candidate of [tsconfigUri, jsconfigUri]) {
		try {
			await vscode.workspace.fs.stat(candidate);
			return candidate;
		} catch {
			// Continue checking alternatives.
		}
	}

	return useTypeScript ? tsconfigUri : jsconfigUri;
}

async function hasTypeScriptConfig(workspaceUri: vscode.Uri): Promise<boolean> {
	const tsconfigUri = vscode.Uri.joinPath(workspaceUri, CONFIG_PATHS.TSCONFIG);
	try {
		await vscode.workspace.fs.stat(tsconfigUri);
		return true;
	} catch {
		return false;
	}
}

async function readJsonConfig(uri: vscode.Uri, fallbackValue: any): Promise<any> {
	try {
		const data = await vscode.workspace.fs.readFile(uri);
		const configText = Buffer.from(data).toString();
		return JSON.parse(configText.replace(REGEX.JSON_COMMENTS, ''));
	} catch {
		return fallbackValue;
	}
}

async function writeJsonConfig(uri: vscode.Uri, value: any): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(value, null, 2)));
}

function normalizeRefPath(refPath: string): string {
	return refPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Updates VSCode settings to hide internal module files
 */
async function updateVSCodeSettings(workspaceUri: vscode.Uri): Promise<void> {
	const vscodeDir = vscode.Uri.joinPath(workspaceUri, '.vscode');
	const settingsUri = vscode.Uri.joinPath(vscodeDir, 'settings.json');

	try {
		try {
			await vscode.workspace.fs.createDirectory(vscodeDir);
		} catch {
			// Already exists.
		}

		let settings: any = {};
		try {
			const settingsData = await vscode.workspace.fs.readFile(settingsUri);
			const settingsText = Buffer.from(settingsData).toString();
			settings = JSON.parse(settingsText.replace(REGEX.JSON_COMMENTS, ''));
		} catch {
			// Initialize empty settings.
		}

		if (!settings['files.exclude']) {
			settings['files.exclude'] = {};
		}
		settings['files.exclude'][`**/${CONFIG_PATHS.MODULE_DESCRIPTOR}`] = true;

		await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(settings, null, 2)));
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
		`**/${CONFIG_PATHS.MODULE_DESCRIPTOR}`,
		'**/dist/',
		'**/*.tsbuildinfo'
	];

	try {
		let existingContent = '';
		try {
			const gitignoreData = await vscode.workspace.fs.readFile(gitignoreUri);
			existingContent = Buffer.from(gitignoreData).toString();
		} catch {
			// .gitignore doesn't exist.
		}

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
