export const CONFIG_PATHS = {
    POM_XML: 'pom.xml',
    BUILD_GRADLE: 'build.gradle',
    MODULE_DESCRIPTOR: '.module.json'
} as const;

export const REGEX = {
    JSON_COMMENTS: /\/\*[\s\S]*?\*\/|\/\/.*/g,
    MODULE_NAME: /^[a-zA-Z0-9-_]+$/
} as const;
