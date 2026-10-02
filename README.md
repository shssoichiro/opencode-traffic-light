# OpenCode Traffic Light

A TUI plugin that adds a status indicator to your terminal title bar, giving you a quick visual cue of what OpenCode is doing.

## Status Colors

| Color | Meaning |
|-------|---------|
| 🟢 Green | Fully idle, or waiting for permission/question input |
| 🟡 Yellow | Thinking/reasoning, or foreground idle with background work remaining |
| 🔴 Red | Foreground running tools or producing text |

Red means the newest assistant message has a streaming/running tool call, or has produced text — a text part counts as active for the whole turn (behavior preserved from V1).

After an agent responds, Yellow remains while a subagent or shell command is running anywhere in its session family (the root session and its children). This also applies when viewing a child session. Pending permission/question input anywhere in that family takes priority and shows Green; unrelated sessions do not count.

The indicator follows OpenCode's reactive cache: reopening or reconnecting may briefly show Green before task state loads. It does not track unmanaged detached processes or shells at locations OpenCode has not loaded.

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
- `🟡 OC | My Session` — thinking or background work remaining
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
