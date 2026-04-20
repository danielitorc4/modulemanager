# ModuleManager

ModuleManager is a VS Code extension for organizing Java code into independent modules with explicit dependencies.

## Overview

- Creates Java modules (basic, Maven, or Gradle) with a predictable structure.
- Stores module definitions in `.module.json`.
- Keeps modules isolated unless a dependency is explicitly declared.
- Syncs Eclipse metadata (`.project`, `.classpath`) from module descriptors automatically.
- For Maven/Gradle modules, only syncs the marked `modulemanager:managed-dependencies` section in `pom.xml`/`build.gradle`, preserving manual dependencies outside that section.
- Runs a Maven precheck when creating Maven modules (checks `pom.xml` location and Maven availability via `mvnw`, `maven.executable.path`, or `mvn` in PATH) and stops creation if the precheck fails.
- Rejects module creation when the target directory already exists to prevent destructive rollback on pre-existing folders.
- Validates cross-module Java imports in real time — undeclared imports are flagged as diagnostics and a compile-blocking Java file is generated to enforce the dependency contract at build time.
- Detects and blocks circular dependencies when adding module dependencies.
- Updates workspace Java settings based on discovered module types (Maven keys only when Maven modules exist; build configuration auto-update for Maven/Gradle; managed referenced library patterns for basic modules).
- Uses safe JSON-with-comments parsing for descriptors/settings and skips settings writes if `.vscode/settings.json` cannot be parsed as a JSON object.
- Automatically triggers a Java project reload (`java.reloadProjects` / `java.cleanWorkspace`) after syncing, with a 15-second cache to avoid hammering the Java extension.

## Quick Start

1. Open a workspace folder in VS Code.
2. In Explorer, right-click and run **Create Module**, or open the Command Palette (`Ctrl+Shift+P`) and type **Create Module**.
3. Choose a name and module type (`basic`, `maven`, or `gradle`).
4. Add dependencies only when needed — modules are fully isolated by default.

Each module gets its own `.module.json`, and metadata is synchronized automatically.

## Module Structure

```text
ModuleName/
  .module.json              ← Module descriptor (hidden in Explorer)
  .project                  ← Eclipse project metadata (basic modules)
  .classpath                ← Eclipse classpath metadata (basic modules)
  src/main/java/
  src/main/resources/
  src/test/java/
  pom.xml                   ← Maven modules only
  build.gradle              ← Gradle modules only
  README.md
```

## Module Types

| Type | Description |
|------|-------------|
| `basic` | Eclipse-managed Java module. Classpath and project references are fully auto-generated from `.module.json`. |
| `maven` | Maven module with a generated `pom.xml`. Requires Maven (`mvnw`, `maven.executable.path`, or `mvn` in PATH) at creation time. |
| `gradle` | Gradle module with a generated `build.gradle`. |

## Dependency Model

- **No declared dependency**: cross-module imports are treated as violations. A diagnostic error is raised on the import line, and a compile-blocking Java file is generated inside the offending module.
- **Declared dependency**: imports are allowed and Eclipse/Maven/Gradle metadata is updated accordingly.
- **Circular dependencies**: blocked at the point of adding a dependency — a DFS graph check is run before committing.

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

| Command | Description |
|---------|-------------|
| **Create Module** | Creates a new module with directory structure and descriptor. Available via Explorer context menu and Command Palette. |
| **Add Module Dependency** | Declares a dependency between two modules. Checks for circular dependencies before saving. |
| **Remove Module Dependency** | Removes a declared dependency between modules. |
| **Show Module Dependencies** | Opens a Markdown document listing all modules, their dependencies, and any detected cycles. |
| **Validate Module Dependencies** | Scans Java imports across all modules, detects undeclared cross-module usage, and offers one-click fixes. |

## Dependency Enforcement

When a Java file imports a class from a module that is not declared as a dependency, the extension:

1. Raises a VS Code **diagnostic error** on the import line.
2. Generates `src/main/java/modulemanager/generated/ModuleManagerDependencyViolationBlocker.java` with an intentional type mismatch, causing Java compilation to fail until the violation is resolved.

This runs on a 350 ms debounce whenever a `.java` or `.module.json` file is opened, changed, or saved.

## Build File Sync

**Basic modules** — `.project` and `.classpath` XML are fully managed and regenerated from `.module.json`. Project names follow the pattern `modulemanager.<relative.dotted.path>`.

**Maven modules** — only the `<!-- modulemanager:managed-dependencies:start/end -->` section in `pom.xml` is rewritten. Dependencies outside this block are untouched.

**Gradle modules** — only the `// modulemanager:managed-dependencies:start/end` block in `build.gradle` is rewritten, injecting `implementation project(':name')` lines.

## Maven-first Workflow

For modules with `pom.xml`, compile and run with Maven so classpath resolution comes from Maven dependencies rather than a plain `bin` classpath.

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

Press `F5` in VS Code to open the Extension Development Host and test the extension live.

## Requirements

- VS Code >= 1.104.0
- Node.js >= 16.x
- For Maven modules: Maven available via `mvnw`, `maven.executable.path` setting, or `mvn` in PATH.

## License

[MIT License](.github/MIT%20License.txt)

## Author

[Danielitorc4]
