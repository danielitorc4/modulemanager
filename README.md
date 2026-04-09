# ModuleManager

ModuleManager is a Visual Studio Code extension that brings IntelliJ-style Java module isolation to VSCode.

## What this extension does

- Uses .module.json as the only source of truth.
- Generates Eclipse metadata per module:
  - .project
  - .classpath
- Enforces explicit module dependencies at the editor classpath level.
- Supports three Java module flavors:
  - basic: extension-managed Eclipse metadata only
  - maven: user-managed pom.xml, extension-managed dependency block
  - gradle: user-managed build.gradle, extension-managed dependency block

## Descriptor schema policy

This version uses a strict descriptor schema.

Only these fields are supported in .module.json:
- name
- type
- createdAt
- dependencies

Any other fields make the descriptor invalid and it will be ignored until corrected.

## Descriptor format

Each module root must contain .module.json:

```json
{
  "name": "orders",
  "type": "basic",
  "createdAt": "2026-04-09T12:00:00.000Z",
  "dependencies": ["billing"]
}
```

Rules:
- name: letters, numbers, hyphen, underscore
- type: basic | maven | gradle
- dependencies: module names declared in this workspace

## Module structure

Created modules use Java layout:

```text
module-name/
  .module.json
  src/main/java
  src/main/resources
  src/test/java
  README.md
```

## Commands

- Create Module
- Add Module Dependency
- Remove Module Dependency
- Show Module Dependencies
- Validate Module Dependencies

Validation scans Java imports under src/**/*.java and offers one-click dependency fixes.

## Metadata sync behavior

On module create/update/delete, the extension synchronizes all modules and updates:
- .project (project metadata and project references)
- .classpath (source folders and declared module dependency entries)
- pom.xml dependencies block for maven modules (if pom.xml exists)
- build.gradle dependencies block for gradle modules (if build.gradle exists)

After sync, the extension triggers java.reloadProjects (with java.cleanWorkspace fallback).

## Development

```bash
npm install
npm run compile
npm run compile-tests
npm test
```

## Notes

- files.exclude only affects Explorer visibility; it does not change jdt.ls behavior.
- Isolation depends on generated metadata and declared dependencies, not hidden files.
- Java reload commands are executed only when provided by the Java extension; without JDK/Red Hat Java activation they are skipped.
