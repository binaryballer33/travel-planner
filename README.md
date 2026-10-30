# shaqs-claude-plugins

A [Claude Code](https://claude.com/claude-code) plugin marketplace with Shaq's plugins. Each plugin lives in its
own folder under `plugins/` with its own `README.md`, `LICENSE` and version.

## Plugins

| Plugin | What it does | Install |
|---|---|---|
| [travel-planner](plugins/travel-planner) | Plans and prices a whole trip (flights, stays, cars, activities, food, buses and trains, weather, entry rules) and builds a self-contained HTML dashboard with direct links and a map. | `/plugin install travel-planner@shaqs-claude-plugins` |
| [session-monitor](plugins/session-monitor) | A live Session Monitor pane for Claude Code: network, CPU, memory and energy per command, clickable command output, a git commit and diff browser, and a project file explorer. | `/plugin install session-monitor@shaqs-claude-plugins` |

## Install

Add this marketplace once, then install any plugin from it:

```
/plugin marketplace add binaryballer33/shaqs-claude-plugins
/plugin install <plugin-name>@shaqs-claude-plugins
```

Update later with `/plugin marketplace update shaqs-claude-plugins`.

## Adding a plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json` (name, version, description, author, license) and put the
   plugin's skills, commands or agents beside it.
2. Add an entry for it to `.claude-plugin/marketplace.json` (`"source": "./plugins/<name>"`).
3. Give it a `README.md` and `LICENSE`, and add a row to the table above.

Test a plugin straight from its folder with `claude --plugin-dir <path to plugins/<name>>`.

## License

See each plugin's `LICENSE`; the repository root `LICENSE` covers the rest.
