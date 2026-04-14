import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { DiscoveredModule } from '../types';

export async function syncModuleDependencies(
    moduleUri: vscode.Uri,
    dependencyNames: string[],
    allModules: DiscoveredModule[]
): Promise<void> {
    const gradleUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.BUILD_GRADLE);
    const buildGradleContent = Buffer.from(await vscode.workspace.fs.readFile(gradleUri)).toString();

    const moduleNames = new Set(allModules.map(module => module.descriptor.name));
    const dependencies = Array.from(new Set(dependencyNames)).filter(name => moduleNames.has(name));

    const dependencyBlock = dependencies
        .map(name => `    implementation project(':${name}')`)
        .join('\n');

    const managedDependencies = [
        'dependencies {',
        dependencyBlock || '    // managed by ModuleManager',
        '}'
    ].join('\n');

    const dependenciesRegex = /dependencies\s*\{[\s\S]*?\}/;
    const updatedContent = dependenciesRegex.test(buildGradleContent)
        ? buildGradleContent.replace(dependenciesRegex, managedDependencies)
        : `${buildGradleContent.trimEnd()}\n\n${managedDependencies}\n`;

    await vscode.workspace.fs.writeFile(gradleUri, Buffer.from(updatedContent));
}
