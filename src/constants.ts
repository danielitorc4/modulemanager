export const CONFIG_PATHS = {
    MODULES_JSON: '.vscode/modules.json',
    TSCONFIG: 'tsconfig.json',
    JSCONFIG: 'jsconfig.json',
    MODULE_MARKER: '.module'
} as const;

export const REGEX = {
    JSON_COMMENTS: /\/\*[\s\S]*?\*\/|\/\/.*/g,
    MODULE_NAME: /^[a-zA-Z0-9-_]+$/
} as const;