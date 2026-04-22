// This file functions as an index to re-export all command modules for easier imports elsewhere in the application.

export { createModule, isModule, getRegisteredModules, updateVSCodeSettings } from './createModule';
export { addModuleDependency, removeModuleDependency, showModuleDependencies, validateModuleDependencies } from './dependencyManager';
export { collectJavaDependencyViolations } from './dependencyManager';
export type { DependencyViolation } from './dependencyManager';

