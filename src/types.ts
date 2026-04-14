export type ModuleType = 'basic' | 'maven' | 'gradle';

export interface ModuleConfig {
    name: string;
    type: ModuleType;
    createdAt: string;
    dependencies: string[];
    path?: string;
}

export interface DiscoveredModule {
    descriptor: ModuleConfig;
    moduleUri: import('vscode').Uri;
    modulePath: string;
}
