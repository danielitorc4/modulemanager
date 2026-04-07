# Change Log

All notable changes to the "modulemanager" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Dependency graph visualization
- Module renaming

## [0.3.0] - 2026-04-07

- Added commands: Add Module Dependency, Remove Module Dependency, Show Module Dependencies.
- Added command: Validate Module Dependencies (detects missing dependencies from import usage with one-click fix).
- Added startup activation and workspace reconciliation for deleted modules.
- Added automatic cleanup of deleted modules from `.vscode/modules.json`.
- Added automatic cleanup of deleted modules from root `tsconfig.json` and `jsconfig.json` references/path aliases.
- Improved create module context behavior to use right-click folder directly.