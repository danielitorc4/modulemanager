import * as vscode from 'vscode';

/**
 * Gets the currently selected directory from the file explorer,
 * or falls back to the workspace root if nothing is selected.
 */
export function getSelectedDirectory(): string | null {
    // Use the active text editor to get the currently selected directory
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        return activeEditor.document.uri.fsPath;
    }

    // If not available, use workspace root
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/**
 * Prompts the user to select a directory using a file dialog.
 * Defaults to the currently selected directory or workspace root.
 */
export async function promptUserToSelectDirectory(): Promise<vscode.Uri | null> {
    const selectedDirectory = getSelectedDirectory();
    const options: vscode.OpenDialogOptions = {
        defaultUri: vscode.Uri.file(selectedDirectory ?? ''),
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select Directory'
    };

    const uris = await vscode.window.showOpenDialog(options);
    return uris?.[0] ?? null;
}
