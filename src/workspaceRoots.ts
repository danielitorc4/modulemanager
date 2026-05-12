import * as path from 'path';
import * as vscode from 'vscode';
import { findModuleDescriptors } from './moduleDescriptors';

export function normalizePathForComparison(fsPath: string): string {
	return path.normalize(fsPath).replace(/\\/g, '/').toLowerCase();
}

function samePath(left: string, right: string): boolean {
	return normalizePathForComparison(left) === normalizePathForComparison(right);
}

export function isSamePath(left: string, right: string): boolean {
	return samePath(left, right);
}

export function isDescendantPath(parent: string, candidate: string): boolean {
	const normalizedParent = normalizePathForComparison(parent);
	const normalizedCandidate = normalizePathForComparison(candidate);
	if (normalizedParent === normalizedCandidate) {
		return false;
	}

	const relative = path.relative(normalizedParent, normalizedCandidate);
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function ensureModuleWorkspaceRoots(): Promise<{ added: number; updated: boolean }> {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	if (workspaceFolders.length === 0) {
		return { added: 0, updated: false };
	}

	const discoveredUris = new Map<string, vscode.Uri>();
	for (const workspaceFolder of workspaceFolders) {
		const modules = await findModuleDescriptors(workspaceFolder.uri);
		for (const module of modules) {
			discoveredUris.set(normalizePathForComparison(module.moduleUri.fsPath), module.moduleUri);
		}
	}

	const existing = new Set(workspaceFolders.map(folder => normalizePathForComparison(folder.uri.fsPath)));
	const missing = Array.from(discoveredUris.values()).filter(uri => !existing.has(normalizePathForComparison(uri.fsPath)));
	if (missing.length === 0) {
		return { added: 0, updated: false };
	}

	const added = vscode.workspace.updateWorkspaceFolders(
		workspaceFolders.length,
		0,
		...missing.map(uri => ({ uri, name: path.basename(uri.fsPath) }))
	);

	return { added: added ? missing.length : 0, updated: !!added };
}

export function getOrchestratorWorkspaceFolders(workspaceFolders: readonly vscode.WorkspaceFolder[]): vscode.WorkspaceFolder[] {
	return workspaceFolders.filter(candidate => {
		return !workspaceFolders.some(other => {
			if (other.index === candidate.index) {
				return false;
			}

			return isDescendantPath(other.uri.fsPath, candidate.uri.fsPath);
		});
	});
}
