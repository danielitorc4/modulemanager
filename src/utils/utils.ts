import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Gets the currently selected directory from the file explorer,
 * or falls back to the workspace root if nothing is selected.
 */
export function getSelectedDirectory(): string | null {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const editorPath = activeEditor.document.uri.fsPath;
        return path.dirname(editorPath);
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/**
 * Prompts the user to select a directory using a file dialog.
 * Defaults to the currently selected directory or workspace root.
 */
export async function promptUserToSelectDirectory(): Promise<vscode.Uri | null> {
    const selectedDirectory = getSelectedDirectory();

    const options: vscode.OpenDialogOptions = {
        defaultUri: selectedDirectory ? vscode.Uri.file(selectedDirectory) : undefined,
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select Directory'
    };

    const uris = await vscode.window.showOpenDialog(options);
    return uris?.[0] ?? null;
}

/**
 * Gets the workspace folder, prompting user if multiple folders exist.
 * Returns null if no workspace is open or user cancels selection.
 */
export async function getWorkspaceFolder(): Promise<vscode.WorkspaceFolder | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return null;
    }

    if (workspaceFolders.length === 1) {
        return workspaceFolders[0];
    }

    const selected = await vscode.window.showQuickPick(
        workspaceFolders.map(folder => ({
            label: folder.name,
            description: folder.uri.fsPath,
            folder: folder
        })),
        { placeHolder: 'Select workspace folder' }
    );
    
    return selected?.folder || null;
}

/**
 * Resolves the workspace folder for a command invocation.
 * Prefers explicit resource context, then active editor context, then prompts if ambiguous.
 */
export async function resolveWorkspaceFolder(resourceUri?: vscode.Uri): Promise<vscode.WorkspaceFolder | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return null;
    }

    if (resourceUri) {
        const fromResource = vscode.workspace.getWorkspaceFolder(resourceUri);
        if (fromResource) {
            return fromResource;
        }
    }

    const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
    if (activeEditorUri) {
        const fromEditor = vscode.workspace.getWorkspaceFolder(activeEditorUri);
        if (fromEditor) {
            return fromEditor;
        }
    }

    if (workspaceFolders.length === 1) {
        return workspaceFolders[0];
    }

    const selected = await vscode.window.showQuickPick(
        workspaceFolders.map(folder => ({
            label: folder.name,
            description: folder.uri.fsPath,
            folder
        })),
        { placeHolder: 'Select workspace folder' }
    );

    return selected?.folder ?? null;
}

export function stripJsonComments(input: string): string {
    let output = '';
    let inString = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escaped = false;

    for (let index = 0; index < input.length; index++) {
        const char = input[index];
        const nextChar = input[index + 1];

        if (inLineComment) {
            if (char === '\n' || char === '\r') {
                inLineComment = false;
                output += char;
            }
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && nextChar === '/') {
                inBlockComment = false;
                index++;
                continue;
            }

            if (char === '\n' || char === '\r') {
                output += char;
            }
            continue;
        }

        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }

        if (char === '/' && nextChar === '/') {
            inLineComment = true;
            index++;
            continue;
        }

        if (char === '/' && nextChar === '*') {
            inBlockComment = true;
            index++;
            continue;
        }

        output += char;
    }

    return output;
}

export function parseJsonWithComments<T = unknown>(input: string): T {
    return JSON.parse(stripJsonComments(input)) as T;
}



