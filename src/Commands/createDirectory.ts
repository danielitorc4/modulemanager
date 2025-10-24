import * as vscode from 'vscode';

export async function createDirectory(): Promise<vscode.Uri | null> {
    const getSelectedDirectory = (): string | null => {
    // Intenta obtener el directorio desde el explorador de archivos
    // Si no hay, usa el workspace root
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
};

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
        return null;
    }

    const folderName = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new directory:',
        value: `New Directory ${new Date().toLocaleString().replace(/[^\w\s]/g, '')}`,
        validateInput: input => !input || input.trim() === '' ? 'Directory name cannot be empty.' : null
    });

    if (!folderName) {
        return null;
    }

    const newDir = vscode.Uri.joinPath(uri, folderName);

    try {
        await vscode.workspace.fs.createDirectory(newDir);
        vscode.window.showInformationMessage(`Directory "${folderName}" created successfully!`);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create directory: ${error}`);
    }


    return newDir;
}

