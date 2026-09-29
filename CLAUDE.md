# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An OpenCode **V2 CLI (TUI) plugin** that adds a 🟢🟡🔴 traffic-light status indicator to the terminal title bar. Single-file plugin at `src/index.ts` — no build step; OpenCode consumes the TypeScript source directly through the `./tui` package export. V2-only: V1 users stay on the 1.x release.

## Architecture

The entire plugin lives in `src/index.ts`. Key design:

- **`computeTrafficLight(input)`** — Pure function (structural types, no SDK imports) that decides the color from session state. V2 shapes: messages are discriminated by `type` (not V1 `role`); assistant parts come from the newest assistant message's `content`; tool activity is `state.status === "streaming" | "running"` (V1 used `pending`/`running`). Exported for tests.
- **`formatSessionTitle(title, color)`** — Pure title formatter: `OpenCode` for blank titles, `OC | <title>` for named titles, legacy truncation over 40 UTF-16 code units to first 37 + `...`, emoji prefix unless disabled (disabled has no leading space — a V1 quirk intentionally dropped). Exported for tests.
- **`Plugin.define({ id, setup })`** from `@opencode/plugin/tui` — V2 CLI plugin entrypoint. `setup` exits early when `OPENCODE_DISABLE_TERMINAL_TITLE=1`, creates the persisted toggle (`storage.store("traffic_light_enabled")`, plugin-scoped, does NOT migrate the V1 kv value), and registers a non-rendering `app` slot.
- **Slot ownership** — The null-rendering slot exists so the keymap layer (palette command `traffic_light.toggle`) and the title `createEffect` are created under a Solid owner and disposed on plugin unload/hot-reload. Do not move them into `setup` itself: `setup` runs without a component owner.
- **Title effect** — Reads route/session/messages/permissions/forms/storage reactively and computes the title synchronously; only the `renderer.setTerminalTitle` write is deferred with `setTimeout(fn, 0)` so it lands after OpenCode's own title effect, coalescing rapid changes into one write. The route is shallow-spread (`{ ...current() }`) so plugin-page name changes retrigger even though `type` stays `"plugin"`.
- **No event subscriptions, no polling** — the V2 client cache is reactive; updates flow through it. (V1 subscribed to 14 events; that machinery is gone.)

## Color Decision Priority (highest first)

1. `enabled === false` → `null` (plain title still written, no emoji)
2. Session idle or no status → 🟢 green
3. No messages → 🟢 green
4. Pending permission or form (V2 replacement for questions) → 🟢 green
5. No assistant message or empty parts → 🟡 yellow
6. Active tool part (`streaming`/`running`) in newest assistant message → 🔴 red
7. Text part present in newest assistant message → 🔴 red (presence, not still-streaming — V1 parity)
8. Default → 🟡 yellow

## Package Entry and Versioning

`exports["./tui"]` → `./src/index.ts`; there is deliberately no root/server export (CLI-only plugin). Peers: `@opencode/plugin >=2.0.19 <3`, `solid-js >=1.9.0 <2` (the host provides both at runtime — never bundle them). Version 2.0.0 is the breaking V2 migration; V1 remains available as 1.0.2. Installed via `plugins` in the **global** `cli.json`.

## Tests and Typecheck

- `bun run test` — Bun test runner over `tests/index.test.ts` against a fake `Plugin.Context`. The `--conditions=browser` flag is required: without it Bun resolves solid-js to its inert server build and reactivity silently does nothing.
- `bun run typecheck` — strict `tsc --noEmit`; tsconfig sets `"types": ["bun"]` because TypeScript 7 here does not auto-include `@types`.
- Dev dependencies pin SDK 2.0.19 / OpenTUI 0.5.12 / solid-js 1.9.12 (OpenTUI's exact Solid peer) purely for type resolution.
