# ModuleManager

A Visual Studio Code extension for managing project modules with IntelliJ IDEA-like structure and dependency management.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [Usage](#usage)
  - [Creating Modules](#creating-modules)
  - [Module Structure](#module-structure)
  - [Managing Dependencies](#managing-dependencies)
- [Configuration](#configuration)
  - [Root Configuration](#root-configuration)
  - [Module Configuration](#module-configuration)
  - [Module Registry](#module-registry)
- [Architecture](#architecture)
  - [Module Independence](#module-independence)
  - [Composite Projects](#composite-projects)
- [Development](#development)
  - [Prerequisites](#prerequisites)
  - [Building](#building)
  - [Testing](#testing)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Overview

ModuleManager brings IntelliJ IDEA's powerful module system to Visual Studio Code. It allows developers to organize large projects into independent, manageable modules with explicit dependency declarations, preventing accidental coupling and naming conflicts.

## Features

- **Structured Module Creation**: Generate modules with predefined folder layouts (src, test, resources, lib)
- **Module Independence**: Modules are isolated by default, similar to IntelliJ IDEA's module system
- **Explicit Dependencies**: Declare module dependencies explicitly when needed
- **Automatic Configuration**: Updates TypeScript/JavaScript configuration files automatically
- **Multi-root Workspace Support**: Seamlessly works with VSCode multi-root workspaces
- **Path Aliases**: Clean imports using `@ModuleName/*` syntax
- **IntelliSense Support**: Full autocompletion and type checking across modules

## Installation

### From Source

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/modulemanager.git
   cd modulemanager
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Compile the extension:
   ```bash
   npm run compile
   ```

4. Press `F5` in VSCode to open the Extension Development Host

### From Marketplace

*Coming soon*

## Getting Started

1. Open a workspace folder in VSCode
2. Right-click in the Explorer pane
3. Select "Create Module" from the context menu
4. Follow the prompts to configure your module

The extension will automatically configure your project for module independence.

## Usage

### Creating Modules

#### Via Context Menu

1. Right-click on any folder in the Explorer
2. Select **Create Module**
3. Choose the parent directory for the module
4. Enter a module name (alphanumeric, hyphens, and underscores only)
5. Select module type:
   - **Basic Module**: Simple module structure
   - **Maven Module**: Maven-based structure (coming soon)
   - **Gradle Module**: Gradle-based structure (coming soon)

#### Via Command Palette

1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Type "Create Module"
3. Follow the same steps as above

### Module Structure

Each created module follows this structure:

```
ModuleName/
├── jsconfig.json           # Module-specific configuration
├── .module                 # Module marker (hidden by default)
├── src/                    # Source code
├── test/                   # Test files
├── resources/              # Resource files
├── lib/                    # External libraries
└── README.md               # Module documentation
```

### Managing Dependencies

By default, modules cannot access code from other modules. This prevents accidental dependencies and keeps modules loosely coupled.

#### Adding a Dependency

To allow ModuleB to use code from ModuleA:

1. Open `ModuleB/jsconfig.json` (or `tsconfig.json`)
2. Add ModuleA to the `references` array:

```json
{
  "compilerOptions": {
    "composite": true,
    "baseUrl": ".",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../ModuleA" }
  ]
}
```

3. Now you can import from ModuleA in ModuleB:

```javascript
import { Something } from '@ModuleA/something';
```

#### Automated Dependency Management

Automated dependency management commands are planned for version 0.3.0:
- `Add Module Dependency`
- `Remove Module Dependency`
- `List Module Dependencies`

## Configuration

### Root Configuration

The extension creates or updates a root `jsconfig.json` or `tsconfig.json` at your workspace root:

**jsconfig.json**
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@ModuleA/*": ["src/ModuleA/src/*"],
      "@ModuleB/*": ["src/ModuleB/src/*"]
    }
  },
  "references": [
    { "path": "./src/ModuleA" },
    { "path": "./src/ModuleB" }
  ]
}
```

This configuration provides:
- Global view of all modules
- Path aliases for clean imports
- Module references for composite projects

### Module Configuration

Each module has its own configuration with `composite: true`:

**ModuleA/jsconfig.json**
```json
{
  "compilerOptions": {
    "composite": true,
    "baseUrl": ".",
    "rootDir": "./src",
    "outDir": "./dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "module": "ESNext",
    "target": "ES2020",
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"],
  "references": []
}
```

Key settings:
- `composite: true`: Enables independent compilation
- `references: []`: Empty by default (dependencies added manually)
- `outDir`: Separate output directory for each module

### Module Registry

The extension maintains a registry at `.vscode/modules.json`:

```json
{
  "modules": [
    {
      "name": "ModuleA",
      "type": "basic",
      "createdAt": "2025-10-28T10:30:00.000Z",
      "structure": ["src", "test", "resources", "lib", "README.md"]
    },
    {
      "name": "ModuleB",
      "type": "basic",
      "createdAt": "2025-10-28T11:45:00.000Z",
      "structure": ["src", "test", "resources", "lib", "README.md"]
    }
  ]
}
```

### VSCode Settings

The extension updates `.vscode/settings.json` to hide internal files:

```json
{
  "files.exclude": {
    "**/.module": true
  }
}
```

### Git Configuration

The extension updates `.gitignore` to exclude:
- `.module` files
- Compiled output (`dist/`)
- TypeScript build info (`*.tsbuildinfo`)

## Architecture

### Module Independence

ModuleManager implements true module independence inspired by IntelliJ IDEA:

**Without Dependencies:**
```
ModuleA ─ ✗ ─ ModuleB
```
ModuleA cannot import from ModuleB, and vice versa.

**With Explicit Dependency:**
```
ModuleA ← ✓ ─ ModuleB
```
After adding ModuleA to ModuleB's references, ModuleB can import from ModuleA.

This architecture prevents:
- Circular dependencies
- Unintended coupling
- Namespace collisions
- Spaghetti code in large projects

### Composite Projects

The extension uses TypeScript/JavaScript's composite project feature:

1. **Root Project**: Maintains global view and path mappings
2. **Module Projects**: Independent compilation units with `composite: true`
3. **Project References**: Explicit dependency graph via `references` array

Benefits:
- Faster incremental builds
- Better IDE performance
- Clear dependency boundaries
- Parallel compilation (when supported)

## Development

### Prerequisites

- Node.js >= 16.x
- npm >= 8.x
- Visual Studio Code >= 1.104.0

### Building

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode for development
npm run watch

# Package for production
npm run package
```

### Testing

```bash
# Run all tests
npm test

# Run specific test suite
npm run test -- --grep "Module Creation"

# Compile tests
npm run compile-tests

# Watch tests
npm run watch-tests
```

### Running the Extension

1. Open the project in VSCode
2. Press `F5` to launch Extension Development Host
3. Open a test workspace in the new window
4. The extension will be active and ready to use

### Debugging

The extension includes launch configurations for debugging:

- **Run Extension**: Launch the extension in debug mode
- **Extension Tests**: Run and debug tests

Set breakpoints in TypeScript files and use VSCode's debugging tools normally.

## Roadmap

### Version 0.2.0 (Current)

- [x] Basic module creation with folder structure
- [x] Multi-root workspace support
- [x] Automatic jsconfig/tsconfig configuration
- [x] Module independence via composite projects
- [x] Path alias support for clean imports
- [x] VSCode settings and gitignore management

### Version 0.3.0

- [ ] Command: Add Module Dependency
- [ ] Command: Remove Module Dependency  
- [ ] Command: List Module Dependencies
- [ ] Dependency graph visualization
- [ ] Module renaming
- [ ] Module deletion with cleanup

### Version 0.4.0

- [ ] Maven module template
- [ ] Gradle module template
- [ ] Auto-generation of build files (pom.xml, build.gradle)
- [ ] Java project structure support

### Version 0.5.0

- [ ] Custom module templates
- [ ] Template import/export
- [ ] Module scaffolding with code generation

### Version 1.0.0

- [ ] Stable API for extensions
- [ ] Import existing modules from IntelliJ projects
- [ ] Module refactoring tools
- [ ] Complete documentation
- [ ] VSCode Marketplace publication

## Contributing

Contributions are welcome! Please follow these guidelines:

### Reporting Issues

- Use the GitHub issue tracker
- Include VSCode version and extension version
- Provide reproduction steps
- Include relevant configuration files

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Code Style

- Follow existing TypeScript conventions
- Use meaningful variable and function names
- Add comments for complex logic
- Update documentation for user-facing changes

### Testing

- Add tests for new features
- Ensure all tests pass before submitting PR
- Aim for >80% code coverage

## License

[MIT License](.github/MIT%20License.txt)

## Author

[Danielitorc4]

## Acknowledgments

This extension is inspired by IntelliJ IDEA's module system and aims to bring similar functionality to Visual Studio Code.