export const CONFIG_PATHS = {
    TSCONFIG: 'tsconfig.json',
    JSCONFIG: 'jsconfig.json',
    MODULE_DESCRIPTOR: '.module.json'
} as const;

export const REGEX = {
    JSON_COMMENTS: /\/\*[\s\S]*?\*\/|\/\/.*/g,
    MODULE_NAME: /^[a-zA-Z0-9-_]+$/
} as const;
