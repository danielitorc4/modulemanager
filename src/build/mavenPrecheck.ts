import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';

const MAVEN_VERSION_ARGS = ['-v'];
const MAVEN_VERSION_TIMEOUT_MS = 8_000;

type MavenExecutableSource = 'wrapper' | 'vscode-setting' | 'path';

export interface MavenExecutableResolution {
	command: string;
	source: MavenExecutableSource;
}

export type MavenPrecheckFailureKind = 'environment' | 'location';

export interface MavenPrecheckFailure {
	kind: MavenPrecheckFailureKind;
	message: string;
}

export type MavenPrecheckResult =
	| {
		ok: true;
		resolution: MavenExecutableResolution;
		pomUri: vscode.Uri;
	}
	| {
		ok: false;
		failure: MavenPrecheckFailure;
	};

export async function precheckMavenModule(
	moduleUri: vscode.Uri,
	workspaceUri: vscode.Uri
): Promise<MavenPrecheckResult> {
	const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
	if (!(await fileExists(pomUri))) {
		return {
			ok: false,
			failure: {
				kind: 'location',
				message:
					`Maven precheck (location error): ${CONFIG_PATHS.POM_XML} is missing in "${moduleUri.fsPath}". ` +
					`Run Maven from a folder that contains ${CONFIG_PATHS.POM_XML}, or use "-f <path-to-pom.xml>".`
			}
		};
	}

	const resolution = await resolveMavenExecutable(moduleUri, workspaceUri);
	if (!resolution) {
		return {
			ok: false,
			failure: {
				kind: 'environment',
				message:
					'Maven precheck (environment error): Maven executable was not found. ' +
					'Expected one of: module/workspace mvnw wrapper, "maven.executable.path", or "mvn" in PATH. ' +
					'Maven modules should be compiled and executed with Maven to keep classpath resolution complete.'
			}
		};
	}

	return {
		ok: true,
		resolution,
		pomUri
	};
}

export function buildMavenArgsForPom(pomUri: vscode.Uri, goals: string[]): string[] {
	return ['-f', pomUri.fsPath, ...goals];
}

async function resolveMavenExecutable(
	moduleUri: vscode.Uri,
	workspaceUri: vscode.Uri
): Promise<MavenExecutableResolution | null> {
	for (const candidate of getWrapperCandidates(moduleUri, workspaceUri)) {
		if (!(await fileExists(candidate))) {
			continue;
		}

		if (await canExecuteMaven(candidate.fsPath, path.dirname(candidate.fsPath))) {
			return { command: candidate.fsPath, source: 'wrapper' };
		}
	}

	const configuredMavenPath = readConfiguredMavenPath(workspaceUri);
	if (configuredMavenPath && (await canExecuteMaven(configuredMavenPath))) {
		return { command: configuredMavenPath, source: 'vscode-setting' };
	}

	if (await canExecuteMaven('mvn')) {
		return { command: 'mvn', source: 'path' };
	}

	return null;
}

function getWrapperCandidates(moduleUri: vscode.Uri, workspaceUri: vscode.Uri): vscode.Uri[] {
	const candidateDirectories = [moduleUri];
	if (workspaceUri.fsPath !== moduleUri.fsPath) {
		candidateDirectories.push(workspaceUri);
	}

	const executableNames = process.platform === 'win32'
		? ['mvnw.cmd', 'mvnw.bat', 'mvnw']
		: ['mvnw'];

	const seen = new Set<string>();
	const candidates: vscode.Uri[] = [];
	for (const directory of candidateDirectories) {
		for (const executableName of executableNames) {
			const candidate = vscode.Uri.joinPath(directory, executableName);
			if (seen.has(candidate.fsPath)) {
				continue;
			}
			seen.add(candidate.fsPath);
			candidates.push(candidate);
		}
	}

	return candidates;
}

function readConfiguredMavenPath(workspaceUri: vscode.Uri): string | null {
	const configured = vscode.workspace
		.getConfiguration('maven', workspaceUri)
		.get<string>('executable.path')
		?.trim();

	if (!configured) {
		return null;
	}

	return stripWrappingQuotes(configured);
}

function stripWrappingQuotes(value: string): string {
	if (value.length < 2) {
		return value;
	}

	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
		return value.slice(1, -1);
	}

	return value;
}

async function canExecuteMaven(command: string, cwd?: string): Promise<boolean> {
	return new Promise(resolve => {
		const useShell = shouldUseShellForMavenCheck(command);
		execFile(
			command,
			MAVEN_VERSION_ARGS,
			{ cwd, windowsHide: true, timeout: MAVEN_VERSION_TIMEOUT_MS, shell: useShell },
			(error, _stdout, stderr) => {
				if (!error) {
					resolve(true);
					return;
				}

				const errno = (error as NodeJS.ErrnoException).code;
				if (errno === 'ENOENT' || errno === 'EACCES' || errno === 'ENOEXEC') {
					resolve(false);
					return;
				}

				if (process.platform === 'win32' && isWindowsCommandNotFound(stderr)) {
					resolve(false);
					return;
				}

				resolve(true);
			}
		);
	});
}

function shouldUseShellForMavenCheck(command: string): boolean {
	if (process.platform !== 'win32') {
		return false;
	}

	const normalized = command.toLowerCase();
	if (normalized.endsWith('.cmd') || normalized.endsWith('.bat')) {
		return true;
	}

	const baseName = path.basename(normalized);
	return baseName === 'mvn' || baseName === 'mvnw';
}

function isWindowsCommandNotFound(stderr: string | Buffer): boolean {
	const stderrText = Buffer.isBuffer(stderr) ? stderr.toString() : stderr;
	return /is not recognized as an internal or external command/i.test(stderrText);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
