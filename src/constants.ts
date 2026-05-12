export const CONFIG_PATHS = {
    POM_XML: 'pom.xml',
    BUILD_GRADLE: 'build.gradle',
    BUILD_GRADLE_KTS: 'build.gradle.kts',
    MODULE_DESCRIPTOR: '.module.json',
    ECLIPSE_PROJECT: '.project',
    ECLIPSE_CLASSPATH: '.classpath',
    CODE_WORKSPACE: 'modulemanager.code-workspace',
    VSCODE_DIR: '.vscode',
    SETTINGS_JSON: 'settings.json',
    MODULEMANAGER_DIR: '.modulemanager'
} as const;

export const REGEX = {
    MODULE_NAME: /^[a-zA-Z0-9-_]+$/,
    // Capture groups: (1) isStatic, (2) importPath, (3) isWildcard
    // Examples:
    // import com.foo.Bar;               → group 2: "com.foo.Bar"
    // import com.foo.*;                 → group 2: "com.foo", group 3: "*"
    // import static com.foo.Utils.method; → group 1: "static", group 2: "com.foo.Utils.method"
    JAVA_IMPORT: /^\s*import\s+(static\s+)?([a-zA-Z_][\w.$]*)\s*;/gm
} as const;
