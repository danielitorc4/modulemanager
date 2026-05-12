import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { ManagedModule } from '../types';

const MANAGED_SECTION_START = '    // modulemanager:managed-dependencies:start';
const MANAGED_SECTION_END = '    // modulemanager:managed-dependencies:end';
const MANAGED_SECTION_REGEX = /\/\/\s*modulemanager:managed-dependencies:start[\s\S]*?\/\/\s*modulemanager:managed-dependencies:end/;
const MANAGED_OUTPUT_START = '// modulemanager:managed-output:start';
const MANAGED_OUTPUT_END = '// modulemanager:managed-output:end';
const MANAGED_OUTPUT_REGEX = /\/\/\s*modulemanager:managed-output:start[\s\S]*?\/\/\s*modulemanager:managed-output:end/;
const DEPENDENCIES_BLOCK_REGEX = /(dependencies\s*\{)/;

export async function syncModuleDependencies(
    moduleUri: vscode.Uri,
    dependencyNames: string[],
    allModules: ManagedModule[],
    outputDirectory: string
): Promise<void> {
    const gradleUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.BUILD_GRADLE);
    const buildGradleContent = Buffer.from(await vscode.workspace.fs.readFile(gradleUri)).toString();

    const moduleNames = new Set(allModules.map(module => module.descriptor.name));
    const dependencies = Array.from(new Set(dependencyNames)).filter(name => moduleNames.has(name));

    const managedSection = buildManagedSection(dependencies);
    const managedOutputSection = buildManagedOutputSection(outputDirectory);

    const withDependencies = upsertManagedDependenciesSection(buildGradleContent, managedSection);
    const updatedContent = upsertManagedOutputSection(withDependencies, managedOutputSection);
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

function buildManagedOutputSection(outputDirectory: string): string {
    const normalizedOutputDirectory = outputDirectory.replace(/\\/g, '/');
    return [
        MANAGED_OUTPUT_START,
        `layout.buildDirectory = file('${normalizedOutputDirectory}')`,
        MANAGED_OUTPUT_END
    ].join('\n');
}

function upsertManagedDependenciesSection(content: string, section: string): string {
    if (MANAGED_SECTION_REGEX.test(content)) {
        return content.replace(MANAGED_SECTION_REGEX, section);
    }

    if (DEPENDENCIES_BLOCK_REGEX.test(content)) {
        return content.replace(DEPENDENCIES_BLOCK_REGEX, `$1\n${section}`);
    }

    return `${content.trimEnd()}\n\n` + [
        'dependencies {',
        section,
        '}',
        ''
    ].join('\n');
}

function upsertManagedOutputSection(content: string, section: string): string {
    if (MANAGED_OUTPUT_REGEX.test(content)) {
        return content.replace(MANAGED_OUTPUT_REGEX, section);
    }

    return `${content.trimEnd()}\n\n${section}\n`;
}
