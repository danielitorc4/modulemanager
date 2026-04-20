export const CONFIG_PATHS = {
    POM_XML: 'pom.xml',
    BUILD_GRADLE: 'build.gradle',
    MODULE_DESCRIPTOR: '.module.json',
    ECLIPSE_PROJECT: '.project',
    ECLIPSE_CLASSPATH: '.classpath'
} as const;

export const REGEX = {
    MODULE_NAME: /^[a-zA-Z0-9-_]+$/,
    JAVA_IMPORT: /^\s*import\s+(?:static\s+)?([a-zA-Z_][\w.]*)\s*;/gm
} as const;
