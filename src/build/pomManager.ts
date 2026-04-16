import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { DiscoveredModule } from '../types';

const MODULE_GROUP_ID = 'com.modules';
const MANAGED_SECTION_START = '<!-- modulemanager:managed-dependencies:start -->';
const MANAGED_SECTION_END = '<!-- modulemanager:managed-dependencies:end -->';
const MANAGED_SECTION_REGEX = /(^[ \t]*)<!--\s*modulemanager:managed-dependencies:start\s*-->[\s\S]*?^[ \t]*<!--\s*modulemanager:managed-dependencies:end\s*-->/m;
const MANAGED_SECTION_DELETION_WARNING = '<!-- WARNING: Do not delete or modify the markers around this section. -->';

export async function syncModuleDependencies(
    moduleUri: vscode.Uri,
    dependencyNames: string[],
    allModules: DiscoveredModule[]
): Promise<void> {
    const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
    const pomContent = Buffer.from(await vscode.workspace.fs.readFile(pomUri)).toString();

    const moduleNames = new Set(allModules.map(module => module.descriptor.name));
    const dependencies = Array.from(new Set(dependencyNames)).filter(name => moduleNames.has(name));

    const managedSectionMatch = pomContent.match(MANAGED_SECTION_REGEX);
    if (!managedSectionMatch) {
        console.warn(
            `Managed dependency section markers not found in ${pomUri.fsPath}. ` +
            'Skipping pom.xml dependency synchronization.'
        );
        return;
    }

    const indentation = managedSectionMatch[1] ?? '';
    const managedSection = buildManagedSection(dependencies, indentation);

    const updatedContent = pomContent.replace(MANAGED_SECTION_REGEX, managedSection);
    if (updatedContent === pomContent) {
        return;
    }

    await vscode.workspace.fs.writeFile(pomUri, Buffer.from(updatedContent));
}

function buildManagedSection(dependencies: string[], indentation: string): string {
    const dependencyBlock = dependencies
        .map(name => [
            `${indentation}<dependency>`,
            `${indentation}  <groupId>${MODULE_GROUP_ID}</groupId>`,
            `${indentation}  <artifactId>${name}</artifactId>`,
            `${indentation}  <version>1.0.0</version>`,
            `${indentation}</dependency>`
        ].join('\n'))
        .join('\n');

    return [
        `${indentation}${MANAGED_SECTION_START}`,
        `${indentation}${MANAGED_SECTION_DELETION_WARNING}`,
        dependencyBlock || `${indentation}<!-- no modulemanager dependencies -->`,
        `${indentation}${MANAGED_SECTION_END}`
    ].join('\n');
}
