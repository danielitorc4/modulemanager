import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { ManagedModule } from '../types';

const MODULE_GROUP_ID = 'com.modules';
const MANAGED_SECTION_START = '<!-- modulemanager:managed-dependencies:start -->';
const MANAGED_SECTION_END = '<!-- modulemanager:managed-dependencies:end -->';
const MANAGED_SECTION_REGEX = /(^[ \t]*)<!--\s*modulemanager:managed-dependencies:start\s*-->[\s\S]*?^[ \t]*<!--\s*modulemanager:managed-dependencies:end\s*-->/m;
const MANAGED_SECTION_DELETION_WARNING = '<!-- WARNING: Do not delete or modify the markers around this section. -->';
const MANAGED_BUILD_START = '<!-- modulemanager:managed-build:start -->';
const MANAGED_BUILD_END = '<!-- modulemanager:managed-build:end -->';
const MANAGED_BUILD_REGEX = /(^[ \t]*)<!--\s*modulemanager:managed-build:start\s*-->[\s\S]*?^[ \t]*<!--\s*modulemanager:managed-build:end\s*-->/m;
const DEPENDENCIES_OPEN_REGEX = /(^[ \t]*)<dependencies>\s*$/m;
const BUILD_OPEN_REGEX = /(^[ \t]*)<build>\s*$/m;
const PROJECT_CLOSE_REGEX = /(^[ \t]*)<\/project>\s*$/m;

export async function syncModuleDependencies(
    moduleUri: vscode.Uri,
    dependencyNames: string[],
    allModules: ManagedModule[],
    outputDirectory: string
): Promise<void> {
    const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
    const pomContent = Buffer.from(await vscode.workspace.fs.readFile(pomUri)).toString();

    const moduleNames = new Set(allModules.map(module => module.descriptor.name));
    const dependencies = Array.from(new Set(dependencyNames)).filter(name => moduleNames.has(name));

    const withDependencies = upsertManagedDependencySection(pomContent, dependencies);
    const updatedContent = upsertManagedBuildSection(withDependencies, outputDirectory);
    if (updatedContent === pomContent) {
        return;
    }

    await vscode.workspace.fs.writeFile(pomUri, Buffer.from(updatedContent));
}

function buildManagedSection(dependencies: string[], indentation: string): string {
    const lineIndent = `${indentation}  `;
    const dependencyBlock = dependencies
        .map(name => [
            `${lineIndent}<dependency>`,
            `${lineIndent}  <groupId>${MODULE_GROUP_ID}</groupId>`,
            `${lineIndent}  <artifactId>${name}</artifactId>`,
            `${lineIndent}  <version>1.0.0</version>`,
            `${lineIndent}</dependency>`
        ].join('\n'))
        .join('\n');

    return [
        `${lineIndent}${MANAGED_SECTION_START}`,
        `${lineIndent}${MANAGED_SECTION_DELETION_WARNING}`,
        dependencyBlock || `${lineIndent}<!-- no modulemanager dependencies -->`,
        `${lineIndent}${MANAGED_SECTION_END}`
    ].join('\n');
}

function buildManagedBuildSection(outputDirectory: string, indentation: string): string {
    const lineIndent = `${indentation}  `;
    const normalizedOutputDirectory = outputDirectory.replace(/\\/g, '/');
    return [
        `${lineIndent}${MANAGED_BUILD_START}`,
        `${lineIndent}<directory>${escapeXml(normalizedOutputDirectory)}</directory>`,
        `${lineIndent}<outputDirectory>${escapeXml(`${normalizedOutputDirectory}/classes`)}</outputDirectory>`,
        `${lineIndent}<testOutputDirectory>${escapeXml(`${normalizedOutputDirectory}/test-classes`)}</testOutputDirectory>`,
        `${lineIndent}${MANAGED_BUILD_END}`
    ].join('\n');
}

function upsertManagedDependencySection(content: string, dependencies: string[]): string {
    const managedSectionMatch = content.match(MANAGED_SECTION_REGEX);
    if (managedSectionMatch) {
        const indentation = managedSectionMatch[1] ?? '';
        return content.replace(MANAGED_SECTION_REGEX, buildManagedSection(dependencies, indentation));
    }

    const dependenciesOpenMatch = content.match(DEPENDENCIES_OPEN_REGEX);
    if (dependenciesOpenMatch) {
        const indentation = dependenciesOpenMatch[1] ?? '';
        const section = buildManagedSection(dependencies, indentation);
        return content.replace(DEPENDENCIES_OPEN_REGEX, `${dependenciesOpenMatch[0]}\n${section}`);
    }

    const projectCloseMatch = content.match(PROJECT_CLOSE_REGEX);
    if (!projectCloseMatch) {
        return content;
    }

    const indentation = projectCloseMatch[1] ?? '';
    const dependenciesBlock = [
        `${indentation}  <dependencies>`,
        buildManagedSection(dependencies, `${indentation}  `),
        `${indentation}  </dependencies>`
    ].join('\n');

    return content.replace(PROJECT_CLOSE_REGEX, `${dependenciesBlock}\n${projectCloseMatch[0]}`);
}

function upsertManagedBuildSection(content: string, outputDirectory: string): string {
    const managedBuildMatch = content.match(MANAGED_BUILD_REGEX);
    if (managedBuildMatch) {
        const indentation = managedBuildMatch[1] ?? '';
        return content.replace(MANAGED_BUILD_REGEX, buildManagedBuildSection(outputDirectory, indentation));
    }

    const buildOpenMatch = content.match(BUILD_OPEN_REGEX);
    if (buildOpenMatch) {
        const indentation = buildOpenMatch[1] ?? '';
        const section = buildManagedBuildSection(outputDirectory, indentation);
        return content.replace(BUILD_OPEN_REGEX, `${buildOpenMatch[0]}\n${section}`);
    }

    const projectCloseMatch = content.match(PROJECT_CLOSE_REGEX);
    if (!projectCloseMatch) {
        return content;
    }

    const indentation = projectCloseMatch[1] ?? '';
    const buildBlock = [
        `${indentation}  <build>`,
        buildManagedBuildSection(outputDirectory, `${indentation}  `),
        `${indentation}  </build>`
    ].join('\n');

    return content.replace(PROJECT_CLOSE_REGEX, `${buildBlock}\n${projectCloseMatch[0]}`);
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
