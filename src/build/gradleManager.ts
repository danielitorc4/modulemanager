import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { DiscoveredModule } from '../types';

const MANAGED_SECTION_START = '    // modulemanager:managed-dependencies:start';
const MANAGED_SECTION_END = '    // modulemanager:managed-dependencies:end';
const MANAGED_SECTION_REGEX = /\/\/\s*modulemanager:managed-dependencies:start[\s\S]*?\/\/\s*modulemanager:managed-dependencies:end/;

export async function syncModuleDependencies(
    moduleUri: vscode.Uri,
    dependencyNames: string[],
    allModules: DiscoveredModule[]
): Promise<void> {
    const gradleUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.BUILD_GRADLE);
    const buildGradleContent = Buffer.from(await vscode.workspace.fs.readFile(gradleUri)).toString();

    const moduleNames = new Set(allModules.map(module => module.descriptor.name));
    const dependencies = Array.from(new Set(dependencyNames)).filter(name => moduleNames.has(name));

    const managedSection = buildManagedSection(dependencies);
    if (!MANAGED_SECTION_REGEX.test(buildGradleContent)) {
        vscode.window.showWarningMessage(
            `Skipping dependency sync for ${gradleUri.fsPath}: managed dependency section markers were not found. ` +
            `Expected markers: "${MANAGED_SECTION_START}" and "${MANAGED_SECTION_END}".`
        );
        return;
    }

    const updatedContent = buildGradleContent.replace(MANAGED_SECTION_REGEX, managedSection);
    if (updatedContent === buildGradleContent) {
        return;
    }

    await vscode.workspace.fs.writeFile(gradleUri, Buffer.from(updatedContent));
}

function buildManagedSection(dependencies: string[]): string {
    const dependencyLines = dependencies.map(name => `    implementation project(':${name}')`);
    return [
        MANAGED_SECTION_START,
        ...(dependencyLines.length > 0 ? dependencyLines : ['    // no modulemanager dependencies']),
        MANAGED_SECTION_END
    ].join('\n');
}
