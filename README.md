# OpenCode Traffic Light

A TUI plugin that adds a status indicator to your terminal title bar, giving you a quick visual cue of what OpenCode is doing.

## Status Colors

| Color | Meaning |
|-------|---------|
| 🟢 Green | Idle, waiting for input, or pending permission/question |
| 🟡 Yellow | Busy but no active tool or text output (thinking/reasoning) |
| 🔴 Red | Running tools or producing text |

Red means the newest assistant message has a streaming/running tool call, or has produced text — a text part counts as active for the whole turn (behavior preserved from V1).

![demo](https://cdn.jsdelivr.net/gh/niushuai1991/opencode-traffic-light@main/demo.gif)

## Requirements

- OpenCode **V2** (`>= 2.0.19 < 3`). This is a CLI (terminal) plugin: it is configured in `cli.json`, not `opencode.json`.
- Still on OpenCode V1? Pin the last V1 release (`opencode-traffic-light@1.0.2`) in your V1 `tui.json`. Version 2.x does not load in V1.

## Installation

Add the package to your **global CLI config**: `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`). Merge it into the existing file — don't replace unrelated settings:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["opencode-traffic-light"]
}
```

That's it. OpenCode installs the plugin on next terminal start. The terminal title will look like:

- `🟢 OC | My Session` — idle
- `🟡 OC | My Session` — thinking
- `🔴 OC | My Session` — working

Outside a session (home or a plugin page), the title stays plain `OpenCode`.

> **Upgrading from 1.x:** V2 uses a new plugin-scoped storage namespace, so the saved toggle resets to enabled once on upgrade. If you had the traffic light disabled, toggle it off again after upgrading.

### Toggle

Run **"Toggle traffic light"** from the command palette to enable or disable the traffic light. The preference persists across restarts and live-syncs between running TUI instances.

### Environment Variable

Set `OPENCODE_DISABLE_TERMINAL_TITLE=1` to prevent the plugin from modifying the terminal title. Nothing is registered when it is set.

> **Limitation:** OpenCode V2 does not expose the native `terminal.title` setting to plugins, so this plugin cannot follow the built-in terminal-title toggle. Use the environment variable above as the supported opt-out.

## Development

```sh
bun install
bun run test       # parity + lifecycle tests (Bun, real Solid reactivity)
bun run typecheck  # strict tsc --noEmit
```

## License

MIT
