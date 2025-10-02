import * as vscode from 'vscode';
/**
 * Creates a new directory (folder) on a given path, and adds it to the list of directories.
 * 
 * @returns A Promise that resolves to void when the directory is created and added to the list.
 */
export async function createDirectory(): Promise<void> {
    const getSelectedDirectory = (): string | null => vscode.window.activeTextEditor?.document.uri.fsPath ?? null;

    const promptUserToSelectDirectory = async (): Promise<vscode.Uri | null> => {
        const selectedDirectory = getSelectedDirectory();
        const uri = await vscode.window.showOpenDialog({
            openLabel: 'Select Directory',
            defaultUri: vscode.Uri.file(selectedDirectory ?? ''),
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false
        });

        return uri?.[0] ?? null;
    };

    const uri = await promptUserToSelectDirectory();

    if (!uri) {
        return;
    }

    const folderName = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new directory:',
        value: `New Directory ${new Date().toLocaleString().replace(/[^\w\s]/g, '')}`,
        validateInput: input => !input || input.trim() === '' ? 'Directory name cannot be empty.' : null
    });

    if (!folderName) {
        return;
    }

    const newDir = vscode.Uri.joinPath(uri, folderName);
    await vscode.workspace.fs.createDirectory(newDir);
}

