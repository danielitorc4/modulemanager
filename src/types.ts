export type ModuleType = 'basic' | 'maven' | 'gradle';

export interface ModuleOutputPaths {
    basicClasspathOutput: string;
    mavenBuildDirectory: string;
    gradleBuildDirectory: string;
}

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

export interface ManagedModule extends DiscoveredModule {
    resolvedType: ModuleType;
    projectName: string;
    outputPaths: ModuleOutputPaths;
}

export interface WorkspaceModuleTypeSummary {
    hasBasicModules: boolean;
    hasMavenModules: boolean;
    hasGradleModules: boolean;
}
