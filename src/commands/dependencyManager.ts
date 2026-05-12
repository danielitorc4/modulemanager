import * as path from 'path';
import * as vscode from 'vscode';
import { REGEX } from '../constants';
import { reconcileWorkspaceModel } from '../build/buildFileManager';
import { findModuleDescriptors, writeModuleDescriptor } from '../moduleDescriptors';
import { resolveManagementRootUri } from '../workspace/managedWorkspace';

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
	importName: string;
}

export interface DependencyViolation {
	fileUri: vscode.Uri;
	importName: string;
	sourceModule: string;
	sourceModulePath: string;
	targetModule: string;
	range: vscode.Range;
}

interface JavaImportMatch {
	importName: string;
	range: vscode.Range;
	isWildcard: boolean;
	isStaticMethod: boolean;
}

interface ModuleClassIndex {
	bySimpleName: Map<string, Set<string>>;
	byFullyQualifiedName: Map<string, string>;
}

/**
 * Adds a dependency from one module to another.
 */
export async function addModuleDependency(resourceUri?: vscode.Uri): Promise<void> {
	const managementRootUri = await resolveManagementRootUri(resourceUri);
	if (!managementRootUri) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}

	const modules = await getAllModules(managementRootUri);
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
		await reconcileWorkspaceModel(managementRootUri);

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
	const managementRootUri = await resolveManagementRootUri(resourceUri);
	if (!managementRootUri) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}

	const modules = await getAllModules(managementRootUri);
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
		await reconcileWorkspaceModel(managementRootUri);

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
	const managementRootUri = await resolveManagementRootUri(resourceUri);
	if (!managementRootUri) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}

	const modules = await getAllModules(managementRootUri);
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
	const managementRootUri = await resolveManagementRootUri(resourceUri);
	if (!managementRootUri) {
		vscode.window.showErrorMessage('No workspace folder open.');
		return;
	}

	const modules = await getAllModules(managementRootUri);
	if (modules.length < 2) {
		vscode.window.showInformationMessage('Not enough modules found to validate dependencies.');
		return;
	}

	const missingDependencies = await findMissingDependencies(managementRootUri, modules);
	if (missingDependencies.length === 0) {
		vscode.window.showInformationMessage('No missing module dependencies were detected.');
		return;
	}

	const selected = await vscode.window.showQuickPick(
		missingDependencies.map(item => ({
			label: `${item.sourceModule} -> ${item.targetModule}`,
			description: path.relative(managementRootUri.fsPath, item.filePath),
			detail: `Import: ${item.importName}`,
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
		await reconcileWorkspaceModel(managementRootUri);

		vscode.window.showInformationMessage(
			`Added dependency: "${selected.item.sourceModule}" now depends on "${selected.item.targetModule}".`
		);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to add dependency: ${error}`);
	}
}

export async function collectJavaDependencyViolations(workspaceUri: vscode.Uri): Promise<DependencyViolation[]> {
	const modules = await getAllModules(workspaceUri);
	if (modules.length < 2) {
		return [];
	}

	const moduleByName = new Map<string, ModuleDependency>();
	for (const module of modules) {
		moduleByName.set(module.moduleName, module);
	}

	const filesByModule = new Map<string, vscode.Uri[]>();
	for (const module of modules) {
		const sourceRootUri = vscode.Uri.file(path.join(workspaceUri.fsPath, module.modulePath));
		const pattern = new vscode.RelativePattern(sourceRootUri, 'src/**/*.java');
		filesByModule.set(module.moduleName, await vscode.workspace.findFiles(pattern));
	}

	const classIndex = await buildModuleClassIndex(modules, filesByModule);

	const violations: DependencyViolation[] = [];
	const seenKeys = new Set<string>();

	const recordViolation = (
		file: vscode.Uri,
		importName: string,
		sourceModule: ModuleDependency,
		targetModule: ModuleDependency,
		range: vscode.Range
	): void => {
		const key = `${file.toString()}::${sourceModule.moduleName}::${targetModule.moduleName}::${importName}::${range.start.line}:${range.start.character}`;
		if (seenKeys.has(key)) {
			return;
		}
		seenKeys.add(key);
		violations.push({
			fileUri: file,
			importName,
			sourceModule: sourceModule.moduleName,
			sourceModulePath: sourceModule.modulePath,
			targetModule: targetModule.moduleName,
			range
		});
	};

	for (const sourceModule of modules) {
		const files = filesByModule.get(sourceModule.moduleName) ?? [];

		for (const file of files) {
			const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString();
			const imports = extractJavaImportMatches(content);

			for (const importMatch of imports) {
				// Skip wildcard imports - we cannot determine which classes are imported
				if (importMatch.isWildcard) {
					continue;
				}

				// Skip static method imports - these are not class dependencies
				if (importMatch.isStaticMethod) {
					continue;
				}

				const targetModuleName = resolveTargetModule(
					importMatch.importName,
					moduleByName,
					classIndex,
					sourceModule.moduleName
				);
				if (!targetModuleName || targetModuleName === sourceModule.moduleName) {
					continue;
				}

				const targetModule = moduleByName.get(targetModuleName);
				if (!targetModule || sourceModule.dependencies.includes(targetModuleName)) {
					continue;
				}

				recordViolation(file, importMatch.importName, sourceModule, targetModule, importMatch.range);
			}

			// Also flag fully-qualified cross-module references that appear in
			// code without a matching import statement. Eclipse's access-rule
			// enforcement on the classpath is the authoritative check, but
			// JDTLS does not always propagate forbidden-reference diagnostics to
			// VS Code, so we publish our own and rely on the boundary blocker
			// file to break the build.
			const fqnReferences = extractFullyQualifiedCrossModuleReferences(content, moduleByName, sourceModule.moduleName);
			for (const reference of fqnReferences) {
				if (sourceModule.dependencies.includes(reference.targetModuleName)) {
					continue;
				}
				const targetModule = moduleByName.get(reference.targetModuleName);
				if (!targetModule) {
					continue;
				}
				recordViolation(file, reference.importName, sourceModule, targetModule, reference.range);
			}
		}
	}

	return violations;
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

	const managementRootUri = await resolveManagementRootUri(moduleUri);
	if (!managementRootUri) {
		throw new Error('No managed workspace root available');
	}

	const modules = await findModuleDescriptors(managementRootUri);
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
	const seenCycles = new Set<string>();
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
					const rawCycle = [...traversalPath.slice(cycleStart), dependency];
					const normalizedCycle = normalizeCycle(rawCycle);
					const cycleKey = normalizedCycle.join('->');
					if (!seenCycles.has(cycleKey)) {
						seenCycles.add(cycleKey);
						cycles.push(normalizedCycle);
					}
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

function normalizeCycle(cycle: string[]): string[] {
	if (cycle.length <= 1) {
		return cycle;
	}

	const closedCycle = cycle[0] === cycle[cycle.length - 1] ? [...cycle] : [...cycle, cycle[0]];
	const uniqueNodes = closedCycle.slice(0, -1);
	if (uniqueNodes.length === 0) {
		return closedCycle;
	}

	const rotations: string[][] = [];
	for (let index = 0; index < uniqueNodes.length; index++) {
		const rotation = uniqueNodes.slice(index).concat(uniqueNodes.slice(0, index));
		rotations.push(rotation);
	}

	rotations.sort((left, right) => left.join('->').localeCompare(right.join('->')));
	const canonicalRotation = rotations[0];
	return [...canonicalRotation, canonicalRotation[0]];
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
		const pattern = new vscode.RelativePattern(sourceRootUri, 'src/**/*.java');
		const files = await vscode.workspace.findFiles(pattern);

		for (const file of files) {
			const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString();
			const imports = extractJavaImportSpecifiers(content);

			for (const importSpecifier of imports) {
				const targetModuleName = extractJavaModuleName(importSpecifier, moduleByName);
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
						filePath: file.fsPath,
						importName: importSpecifier
					});
				}
			}
		}
	}

	return Array.from(missingDependencies.values());
}

export function extractJavaImportSpecifiers(source: string): string[] {
	const specifiers = new Set<string>();
	let match: RegExpExecArray | null;

	REGEX.JAVA_IMPORT.lastIndex = 0;
	while ((match = REGEX.JAVA_IMPORT.exec(source)) !== null) {
		// match[1] = "static " or undefined, match[2] = the actual import path
		const importPath = match[2]?.trim();
		if (!importPath) {
			continue;
		}

		if (importPath.startsWith('java.') || importPath.startsWith('javax.')) {
			continue;
		}

		// Strip wildcard suffix so module-name extraction works on "com.foo.*"
		const importName = importPath.endsWith('.*') ? importPath.slice(0, -2) : importPath;
		specifiers.add(importName);
	}

	return Array.from(specifiers);
}

interface FullyQualifiedCrossModuleReference {
	importName: string;
	targetModuleName: string;
	range: vscode.Range;
}

const JAVA_PACKAGE_DECLARATION_REGEX = /^\s*package\s+([a-zA-Z_][\w.]*)\s*;/m;
const JAVA_TYPE_DECLARATION_REGEX = /(?:^|[\s;{}])(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|sealed\s+|non-sealed\s+|static\s+|strictfp\s+|@interface\s+)*(?:class|interface|enum|record)\s+([A-Za-z_][\w$]*)/g;

async function buildModuleClassIndex(
	modules: ModuleDependency[],
	filesByModule: Map<string, vscode.Uri[]>
): Promise<ModuleClassIndex> {
	const bySimpleName = new Map<string, Set<string>>();
	const byFullyQualifiedName = new Map<string, string>();

	for (const module of modules) {
		const files = filesByModule.get(module.moduleName) ?? [];
		for (const file of files) {
			const raw = Buffer.from(await vscode.workspace.fs.readFile(file)).toString();
			const sanitized = stripJavaCommentsAndStrings(raw);

			const packageMatch = sanitized.match(JAVA_PACKAGE_DECLARATION_REGEX);
			const packageName = packageMatch?.[1] ?? '';

			JAVA_TYPE_DECLARATION_REGEX.lastIndex = 0;
			let typeMatch: RegExpExecArray | null;
			while ((typeMatch = JAVA_TYPE_DECLARATION_REGEX.exec(sanitized)) !== null) {
				const simpleName = typeMatch[1];
				if (!simpleName) {
					continue;
				}

				const fullyQualifiedName = packageName ? `${packageName}.${simpleName}` : simpleName;

				const owners = bySimpleName.get(simpleName) ?? new Set<string>();
				owners.add(module.moduleName);
				bySimpleName.set(simpleName, owners);

				// First declaration wins for FQN — duplicates would be a compile
				// error anyway and would not be silently swapped.
				if (!byFullyQualifiedName.has(fullyQualifiedName)) {
					byFullyQualifiedName.set(fullyQualifiedName, module.moduleName);
				}
			}
		}
	}

	return { bySimpleName, byFullyQualifiedName };
}

function resolveTargetModule(
	importSpec: string,
	moduleByName: Map<string, ModuleDependency>,
	classIndex: ModuleClassIndex,
	sourceModuleName: string
): string | null {
	// Convention-based prefix match still wins when it works — keeps the legacy
	// "package starts with module name" behaviour intact for projects that
	// follow it.
	const prefixMatch = extractJavaModuleName(importSpec, moduleByName);
	if (prefixMatch && prefixMatch !== sourceModuleName) {
		return prefixMatch;
	}

	// Authoritative match: a class declared inside another module is owned by
	// that module regardless of which package the file happens to declare. This
	// catches files placed in unconventional packages — including JDTLS
	// path-inferred packages like `main.java.Foo` when the .classpath source
	// root was guessed wrong by an external tool.
	const fqnOwner = classIndex.byFullyQualifiedName.get(importSpec);
	if (fqnOwner && fqnOwner !== sourceModuleName) {
		return fqnOwner;
	}

	const lastDot = importSpec.lastIndexOf('.');
	const simpleName = lastDot >= 0 ? importSpec.slice(lastDot + 1) : importSpec;
	const candidates = classIndex.bySimpleName.get(simpleName);
	if (!candidates) {
		return null;
	}

	const owners = Array.from(candidates).filter(name => name !== sourceModuleName);
	if (owners.length === 1) {
		return owners[0];
	}

	// Ambiguous: more than one module declares a class with this simple name.
	// We cannot safely pick a target without proper symbol resolution, so leave
	// it for JDTLS to flag.
	return null;
}

const JAVA_IDENTIFIER_PATTERN = /^[a-zA-Z_][\w]*$/;

export function extractFullyQualifiedCrossModuleReferences(
	source: string,
	moduleByName: Map<string, ModuleDependency>,
	ownModuleName: string
): FullyQualifiedCrossModuleReference[] {
	const candidateModuleNames = Array.from(moduleByName.keys()).filter(
		name => name !== ownModuleName && JAVA_IDENTIFIER_PATTERN.test(name)
	);
	if (candidateModuleNames.length === 0) {
		return [];
	}

	const sanitized = stripJavaCommentsAndStrings(source);
	const references: FullyQualifiedCrossModuleReference[] = [];
	const seen = new Set<string>();

	for (const moduleName of candidateModuleNames) {
		const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		// Match `<moduleName>.<ClassName>` where the class name starts with an
		// uppercase letter or underscore — this is the Java convention and avoids
		// false positives like `backend.foo` package references.
		const pattern = new RegExp(`(^|[^\\w.$])(${escaped})\\.([A-Z_][\\w$]*)`, 'g');

		let match: RegExpExecArray | null;
		while ((match = pattern.exec(sanitized)) !== null) {
			const prefix = match[1] ?? '';
			const moduleStart = match.index + prefix.length;
			const className = match[3];
			const importName = `${moduleName}.${className}`;
			const endOffset = moduleStart + moduleName.length + 1 + className.length;

			// Skip references that originate from a `package` declaration line.
			const lineStart = sanitized.lastIndexOf('\n', moduleStart) + 1;
			const lineHead = sanitized.slice(lineStart, moduleStart);
			if (/\bpackage\s+$/.test(lineHead)) {
				continue;
			}
			// Imports are already covered by extractJavaImportMatches — skip them here
			// so we do not produce duplicates on the same line.
			if (/\bimport\s+(static\s+)?$/.test(lineHead)) {
				continue;
			}

			const dedupeKey = `${importName}::${moduleStart}`;
			if (seen.has(dedupeKey)) {
				continue;
			}
			seen.add(dedupeKey);

			references.push({
				importName,
				targetModuleName: moduleName,
				range: new vscode.Range(
					offsetToPosition(source, moduleStart),
					offsetToPosition(source, endOffset)
				)
			});
		}
	}

	return references;
}

export function stripJavaCommentsAndStrings(source: string): string {
	const length = source.length;
	const out: string[] = new Array(length);
	let index = 0;

	const blank = (count: number): void => {
		for (let offset = 0; offset < count; offset++) {
			const character = source[index + offset];
			out[index + offset] = character === '\n' || character === '\r' ? character : ' ';
		}
		index += count;
	};

	while (index < length) {
		const current = source[index];
		const next = source[index + 1];

		if (current === '/' && next === '/') {
			let end = index;
			while (end < length && source[end] !== '\n' && source[end] !== '\r') {
				end++;
			}
			blank(end - index);
			continue;
		}

		if (current === '/' && next === '*') {
			let end = index + 2;
			while (end < length - 1 && !(source[end] === '*' && source[end + 1] === '/')) {
				end++;
			}
			end = Math.min(end + 2, length);
			blank(end - index);
			continue;
		}

		if (current === '"' || current === '\'') {
			const quote = current;
			let end = index + 1;
			while (end < length) {
				if (source[end] === '\\' && end + 1 < length) {
					end += 2;
					continue;
				}
				if (source[end] === quote) {
					end++;
					break;
				}
				if (source[end] === '\n') {
					break;
				}
				end++;
			}
			blank(end - index);
			continue;
		}

		out[index] = current;
		index++;
	}

	return out.join('');
}

function extractJavaImportMatches(source: string): JavaImportMatch[] {
	const matches: JavaImportMatch[] = [];
	let match: RegExpExecArray | null;

	REGEX.JAVA_IMPORT.lastIndex = 0;
	while ((match = REGEX.JAVA_IMPORT.exec(source)) !== null) {
		// match[1] = "static" or undefined
		// match[2] = import path (com.foo.Bar or com.foo.* or com.foo.Outer$Inner)
		const isStaticKeyword = !!match[1];
		const importPath = match[2]?.trim();
		
		if (!importPath) {
			continue;
		}

		// Skip java.* and javax.* imports
		if (importPath.startsWith('java.') || importPath.startsWith('javax.')) {
			continue;
		}

		const isWildcard = importPath.endsWith('.*');
		let importName = importPath;
		
		if (isWildcard) {
			// For wildcard imports like "com.foo.*", extract the package
			importName = importPath.slice(0, -2); // Remove ".*"
		}

		// Detect if this is a static method import (e.g., "static com.foo.Utils.method")
		// In Java, static imports can be:
		// - import static com.foo.Utils.method; (specific method)
		// - import static com.foo.Utils.*; (all static members)
		// We'll flag these as isStaticMethod if they have more than 3 segments
		// com.foo.Utils.method has 4 segments (likely a method)
		const segments = importName.split('.');
		const isStaticMethod = isStaticKeyword && segments.length > 3;

		const matchText = match[0] ?? '';
		const nameIndexWithinMatch = matchText.indexOf(importPath.replace(/\.\*$/, ''));
		if (nameIndexWithinMatch < 0) {
			continue;
		}

		const startOffset = match.index + nameIndexWithinMatch;
		const endOffset = startOffset + importName.length;
		
		matches.push({
			importName,
			range: new vscode.Range(offsetToPosition(source, startOffset), offsetToPosition(source, endOffset)),
			isWildcard,
			isStaticMethod
		});
	}

	return matches;
}

function offsetToPosition(source: string, offset: number): vscode.Position {
	const safeOffset = Math.max(0, Math.min(offset, source.length));
	const precedingText = source.slice(0, safeOffset);
	const lines = precedingText.split(/\r?\n/);
	const line = Math.max(0, lines.length - 1);
	const character = lines[lines.length - 1]?.length ?? 0;
	return new vscode.Position(line, character);
}

/**
 * Extracts module name from a Java import statement.
 * Uses longest-match strategy to handle nested module packages correctly.
 * Cache is built per-invocation to avoid stale lookups.
 */
export function extractJavaModuleName(
	importSpecifier: string,
	moduleByName: Map<string, ModuleDependency>
): string | null {
	// Build a sorted list of module names by length (longest first)
	// This ensures "core.utils" is matched before "core" for import "com.myapp.core.utils"
	const modulesByLength = Array.from(moduleByName.keys()).sort((a, b) => b.length - a.length);

	let bestMatch: string | null = null;
	let bestScore = -1;

	for (const moduleName of modulesByLength) {
		// Exact match: import name IS the module name
		if (importSpecifier === moduleName) {
			return moduleName;
		}

		// Direct prefix match: import.startsWith(moduleName + ".")
		// Example: import "com.myapp.core.User" matches module "com.myapp.core"
		const directPrefix = `${moduleName}.`;
		if (importSpecifier.startsWith(directPrefix)) {
			// Verify there's a valid class name after the prefix
			const afterPrefix = importSpecifier.slice(directPrefix.length);
			if (afterPrefix && /^[a-zA-Z_][\w$]*$/.test(afterPrefix.split('.')[0])) {
				return moduleName; // Return immediately since we sorted by length
			}
		}
	}

	return bestMatch;
}
