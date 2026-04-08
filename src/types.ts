export interface ModuleConfig {
    name: string;
    type: 'basic' | 'maven' | 'gradle';
    createdAt: string;
    dependencies: string[];
    sourceRoot: string;
    structure?: string[];
    path?: string;
}

export interface DiscoveredModule {
    descriptor: ModuleConfig;
    moduleUri: import('vscode').Uri;
    modulePath: string;
}
