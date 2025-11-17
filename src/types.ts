export interface ModuleConfig {
    name: string;
    type: 'basic' | 'maven' | 'gradle';
    createdAt: string;
    structure: string[];
    path?: string; 
}

export interface ProjectModules {
    modules: Record<string, ModuleConfig>; // name → config
}

export interface ModuleRegistry {
    modules: Record<string, {
        name: string;
        type: string;
        path: string;
        createdAt: string;
    }>;
}