# ModuleManager

ModuleManager is a VS Code extension for organizing Java code into independent modules with explicit dependencies.

## Overview

- Creates Java modules with a predictable structure.
- Stores module definitions in `.module.json`.
- Keeps modules isolated unless a dependency is explicitly declared.
- Syncs Eclipse metadata (`.project`, `.classpath`) from module descriptors.
- For Maven/Gradle modules, only syncs the marked `modulemanager:managed-dependencies` section in `pom.xml`/`build.gradle`, preserving manual dependencies outside that section.
- Runs a Maven precheck when creating Maven modules (checks `pom.xml` location and Maven availability via `mvnw`, `maven.executable.path`, or `mvn` in PATH).
- Updates workspace Java settings so Maven import/build sync stays enabled and simple Java projects can reference local `lib/**/*.jar` dependencies.

## Quick Start

1. Open a workspace folder in VS Code.
2. In Explorer, run **Create Module**.
3. Choose a name and module type (`basic`, `maven`, or `gradle`).
4. Add dependencies only when needed.

Each module gets its own `.module.json`, and metadata is synchronized automatically.

## Module Structure

```text
ModuleName/
  .module.json
  .project
  .classpath
  src/main/java/
  src/main/resources/
  src/test/java/
  README.md
```

## Dependency Model

- No declared dependency: cross-module imports are treated as violations.
- Declared dependency: imports are allowed.
- Circular dependencies are blocked when adding dependencies.

Example descriptor:

```json
{
  "name": "orders",
  "type": "basic",
  "createdAt": "2026-04-13T12:00:00.000Z",
  "dependencies": ["billing"]
}
```

## Commands

- Create Module
- Add Module Dependency
- Remove Module Dependency
- Show Module Dependencies
- Validate Module Dependencies

Validation scans Java imports and can guide/fix missing dependency declarations.

## Maven-first Workflow

For modules with `pom.xml`, compile and run with Maven so classpath resolution comes from Maven dependencies instead of a plain `bin` classpath.

Example:

```bash
mvn -f pom.xml clean compile
mvn -f pom.xml test
```

## Development

```bash
npm install
npm run compile
npm run compile-tests
npm test
```

## License

[MIT License](.github/MIT%20License.txt)

## Author

[Danielitorc4]