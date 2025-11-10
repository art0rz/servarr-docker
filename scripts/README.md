# Bootstrap Scripts

The `bootstrap.sh` script has been refactored into modular components for better maintainability.

## Structure

- **bootstrap.sh** (77 lines) - Main orchestrator script
- **scripts/utils.sh** (36 lines) - Shared utility functions
- **scripts/config.sh** (217 lines) - Interactive configuration and .env generation
- **scripts/setup.sh** (36 lines) - Directory creation and permissions
- **scripts/docker.sh** (41 lines) - Docker compose operations
- **scripts/qbittorrent-setup.sh** (164 lines) - qBittorrent configuration and completion message

## Benefits

1. **Modularity** - Each script has a single, clear responsibility
2. **Maintainability** - Easier to find and fix issues in specific areas
3. **Testability** - Individual modules can be tested independently
4. **Readability** - Smaller files are easier to understand

## Usage

The main `bootstrap.sh` script works exactly as before:

```bash
# Interactive setup
./bootstrap.sh

# Dry run mode
./bootstrap.sh --dry-run
```

All module scripts are sourced automatically by `bootstrap.sh` and don't need to be run individually.
