import * as vscode from 'vscode';
import { CONFIG_PATHS } from '../constants';
import { DiscoveredModule, ModuleConfig } from '../types';

const MODULE_GROUP_ID = 'com.modules';

export async function generateMinimalPom(moduleUri: vscode.Uri, descriptor: ModuleConfig): Promise<void> {
    const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
    const pomContent = [
        '<project>',
        '  <modelVersion>4.0.0</modelVersion>',
        `  <groupId>${MODULE_GROUP_ID}</groupId>`,
        `  <artifactId>${descriptor.name}</artifactId>`,
        '  <version>1.0.0</version>',
        '  <dependencies>',
        '    <!-- managed by ModuleManager -->',
        '  </dependencies>',
        '</project>',
        ''
    ].join('\n');

    await vscode.workspace.fs.writeFile(pomUri, Buffer.from(pomContent));
}

export async function syncModuleDependencies(
    moduleUri: vscode.Uri,
    dependencyNames: string[],
    allModules: DiscoveredModule[]
): Promise<void> {
    const pomUri = vscode.Uri.joinPath(moduleUri, CONFIG_PATHS.POM_XML);
    const pomContent = Buffer.from(await vscode.workspace.fs.readFile(pomUri)).toString();

    const moduleNames = new Set(allModules.map(module => module.descriptor.name));
    const dependencies = Array.from(new Set(dependencyNames)).filter(name => moduleNames.has(name));

    const dependencyBlock = dependencies
        .map(name => [
            '    <dependency>',
            `      <groupId>${MODULE_GROUP_ID}</groupId>`,
            `      <artifactId>${name}</artifactId>`,
            '      <version>1.0.0</version>',
            '    </dependency>'
        ].join('\n'))
        .join('\n');

    const managedDependencies = [
        '  <dependencies>',
        dependencyBlock || '    <!-- managed by ModuleManager -->',
        '  </dependencies>'
    ].join('\n');

    const dependenciesRegex = /<dependencies>[\s\S]*?<\/dependencies>/;
    let updatedContent: string;

    if (dependenciesRegex.test(pomContent)) {
        updatedContent = pomContent.replace(dependenciesRegex, managedDependencies);
    } else if (pomContent.includes('</project>')) {
        updatedContent = pomContent.replace('</project>', `${managedDependencies}\n</project>`);
    } else {
        updatedContent = `${pomContent.trimEnd()}\n${managedDependencies}\n`;
    }

    await vscode.workspace.fs.writeFile(pomUri, Buffer.from(updatedContent));
}
