import * as path from 'path';
import * as vscode from 'vscode';
import { syncWorkspaceModuleConfigs } from '../config/configManager';
import { findModuleDescriptors, writeModuleDescriptor } from '../moduleDescriptors';
import { resolveWorkspaceFolder } from '../utils/utils';

interface ModuleDependency {
	moduleName: string;
	modulePath: string;
	moduleUri: vscode.Uri;
	dependencies: string[];
}

interface MissingDependency {
	sourceModule: string;
	sourceModulePath: string;
	targetModule: string;
	targetModulePath: string;
	filePath: string;
}

/**
 * Adds a dependency from one module to another.
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
		modules.map(module => ({
			label: module.moduleName,
			description: module.modulePath,
			module
		})),
		{ placeHolder: 'Select module that needs a dependency' }
	);
	if (!sourceModule) {
		return;
	}

	const availableTargets = modules.filter(
		module =>
			module.moduleName !== sourceModule.module.moduleName &&
			!sourceModule.module.dependencies.includes(module.moduleName)
	);

	if (availableTargets.length === 0) {
		vscode.window.showWarningMessage(`Module "${sourceModule.module.moduleName}" already depends on all other modules.`);
		return;
	}

	const targetModule = await vscode.window.showQuickPick(
		availableTargets.map(module => ({
			label: module.moduleName,
			description: module.modulePath,
			module
		})),
		{ placeHolder: 'Select dependency to add' }
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
		await updateDescriptorDependencies(sourceModule.module.moduleUri, dependencies =>
			Array.from(new Set([...dependencies, targetModule.module.moduleName]))
		);
		await syncWorkspaceModuleConfigs(workspaceFolder.uri);

		vscode.window.showInformationMessage(
			`Added dependency: "${sourceModule.module.moduleName}" now depends on "${targetModule.module.moduleName}".`
		);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to add dependency: ${error}`);
	}
}

/**
 * Removes a dependency from a module.
 */
export async function removeModuleDependency(resourceUri?: vscode.Uri): Promise<void> {
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

	const modulesWithDeps = modules.filter(module => module.dependencies.length > 0);
	if (modulesWithDeps.length === 0) {
		vscode.window.showInformationMessage('No modules have dependencies to remove.');
		return;
	}

	const selectedModule = await vscode.window.showQuickPick(
		modulesWithDeps.map(module => ({
			label: module.moduleName,
			description: `Dependencies: ${module.dependencies.join(', ')}`,
			module
		})),
		{ placeHolder: 'Select module to remove dependency from' }
	);
	if (!selectedModule) {
		return;
	}

	const dependencyToRemove = await vscode.window.showQuickPick(
		selectedModule.module.dependencies.map(dependency => ({
			label: dependency,
			dependency
		})),
		{ placeHolder: 'Select dependency to remove' }
	);
	if (!dependencyToRemove) {
		return;
	}

	try {
		await updateDescriptorDependencies(selectedModule.module.moduleUri, dependencies =>
			dependencies.filter(dependency => dependency !== dependencyToRemove.dependency)
		);
		await syncWorkspaceModuleConfigs(workspaceFolder.uri);

		vscode.window.showInformationMessage(
			`Removed dependency: "${selectedModule.module.moduleName}" no longer depends on "${dependencyToRemove.dependency}".`
		);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to remove dependency: ${error}`);
	}
}

/**
 * Shows all module dependencies in the project.
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

	let output = '# Module Dependencies\n\n';

	for (const module of modules) {
		output += `## ${module.moduleName}\n`;
		output += `Path: ${module.modulePath}\n`;

		if (module.dependencies.length === 0) {
			output += 'Dependencies: None\n';
		} else {
			output += 'Dependencies:\n';
			for (const dependency of module.dependencies) {
				output += `  - ${dependency}\n`;
			}
		}
		output += '\n';
	}

	const cycles = detectAllCircularDependencies(modules);
	if (cycles.length > 0) {
		output += '## ⚠️ Circular Dependencies Detected\n\n';
		for (const cycle of cycles) {
			output += `- ${cycle.join(' → ')}\n`;
		}
	}

	const doc = await vscode.workspace.openTextDocument({
		content: output,
		language: 'markdown'
	});
	await vscode.window.showTextDocument(doc);
}

/**
 * Validates imports across modules and offers one-click fix to add missing dependencies.
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
			detail: 'Add missing dependency',
			item
		})),
		{ placeHolder: 'Select a missing dependency to fix' }
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
		const sourceModule = modules.find(module => module.moduleName === selected.item.sourceModule);
		if (!sourceModule) {
			throw new Error('Source module not found');
		}

		await updateDescriptorDependencies(sourceModule.moduleUri, dependencies =>
			Array.from(new Set([...dependencies, selected.item.targetModule]))
		);
		await syncWorkspaceModuleConfigs(workspaceFolder.uri);

		vscode.window.showInformationMessage(
			`Added dependency: "${selected.item.sourceModule}" now depends on "${selected.item.targetModule}".`
		);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to add dependency: ${error}`);
	}
}

async function getAllModules(workspaceUri: vscode.Uri): Promise<ModuleDependency[]> {
	const discoveredModules = await findModuleDescriptors(workspaceUri);
	return discoveredModules.map(module => ({
		moduleName: module.descriptor.name,
		modulePath: module.modulePath,
		moduleUri: module.moduleUri,
		dependencies: module.descriptor.dependencies.filter(dependency => dependency !== module.descriptor.name)
	}));
}

async function updateDescriptorDependencies(
	moduleUri: vscode.Uri,
	updateDependencies: (dependencies: string[]) => string[]
): Promise<void> {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(moduleUri);
	if (!workspaceFolder) {
		throw new Error('No workspace folder found for module');
	}

	const modules = await findModuleDescriptors(workspaceFolder.uri);
	const descriptorEntry = modules.find(module => module.moduleUri.fsPath === moduleUri.fsPath);
	if (!descriptorEntry) {
		throw new Error('Module descriptor not found');
	}

	const updatedDependencies = Array.from(new Set(updateDependencies(descriptorEntry.descriptor.dependencies)));
	await writeModuleDescriptor(moduleUri, {
		...descriptorEntry.descriptor,
		dependencies: updatedDependencies
	});
}

/**
 * Checks if adding a dependency would create a circular dependency.
 */
async function checkCircularDependency(
	modules: ModuleDependency[],
	sourceModule: string,
	targetModule: string
): Promise<boolean> {
	const graph = new Map<string, string[]>();
	for (const module of modules) {
		graph.set(module.moduleName, module.dependencies);
	}

	const sourceDependencies = graph.get(sourceModule) || [];
	graph.set(sourceModule, [...sourceDependencies, targetModule]);

	return canReach(graph, targetModule, sourceModule, new Set());
}

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

	for (const dependency of dependencies) {
		if (canReach(graph, dependency, to, visited)) {
			return true;
		}
	}

	return false;
}

function detectAllCircularDependencies(modules: ModuleDependency[]): string[][] {
	const graph = new Map<string, string[]>();
	for (const module of modules) {
		graph.set(module.moduleName, module.dependencies);
	}

	const cycles: string[][] = [];
	const visited = new Set<string>();
	const stack = new Set<string>();

	function dfs(node: string, traversalPath: string[]): void {
		visited.add(node);
		stack.add(node);
		traversalPath.push(node);

		const dependencies = graph.get(node) || [];
		for (const dependency of dependencies) {
			if (!visited.has(dependency)) {
				dfs(dependency, [...traversalPath]);
			} else if (stack.has(dependency)) {
				const cycleStart = traversalPath.indexOf(dependency);
				if (cycleStart !== -1) {
					cycles.push([...traversalPath.slice(cycleStart), dependency]);
				}
			}
		}

		stack.delete(node);
	}

	for (const module of modules) {
		if (!visited.has(module.moduleName)) {
			dfs(module.moduleName, []);
		}
	}

	return cycles;
}

async function findMissingDependencies(
	workspaceUri: vscode.Uri,
	modules: ModuleDependency[]
): Promise<MissingDependency[]> {
	const moduleByName = new Map<string, ModuleDependency>();
	for (const module of modules) {
		moduleByName.set(module.moduleName, module);
	}

	const missingDependencies = new Map<string, MissingDependency>();

	for (const sourceModule of modules) {
		const sourceRootUri = vscode.Uri.file(path.join(workspaceUri.fsPath, sourceModule.modulePath));
		const pattern = new vscode.RelativePattern(sourceRootUri, 'src/**/*.{ts,tsx,js,jsx}');
		const files = await vscode.workspace.findFiles(pattern);

		for (const file of files) {
			const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString();
			const imports = extractImportSpecifiers(content);

			for (const importSpecifier of imports) {
				const targetModuleName = extractAliasedModuleName(importSpecifier);
				if (!targetModuleName || targetModuleName === sourceModule.moduleName) {
					continue;
				}

				const targetModule = moduleByName.get(targetModuleName);
				if (!targetModule || sourceModule.dependencies.includes(targetModuleName)) {
					continue;
				}

				const key = `${sourceModule.moduleName}->${targetModuleName}`;
				if (!missingDependencies.has(key)) {
					missingDependencies.set(key, {
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

	return Array.from(missingDependencies.values());
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
