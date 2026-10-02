// Behavior-parity tests for the OpenCode V2 port. The fake context is confined
// to this file; casts live at that boundary only. Reactivity uses the real
// Solid client runtime (see the --conditions=browser test script).
import { afterEach, beforeEach, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { Plugin } from "@opencode/plugin/tui"
import type { LocationRef } from "@opencode/client"
import plugin, {
  computeTrafficLight,
  formatSessionTitle,
  type TrafficLightPart,
} from "../src/index"

// --- deterministic timer queue -------------------------------------------

type Scheduled = { id: number; fn: () => void; cancelled: boolean }
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let scheduled: Scheduled[] = []
let nextTimerId = 1

function useFakeTimers() {
  scheduled = []
  globalThis.setTimeout = ((fn: () => void) => {
    const item: Scheduled = { id: nextTimerId++, fn, cancelled: false }
    scheduled.push(item)
    return item.id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    for (const item of scheduled) if (item.id === id) item.cancelled = true
  }) as unknown as typeof clearTimeout
}

function flushTimers() {
  const pending = scheduled.filter((item) => !item.cancelled)
  scheduled = []
  for (const item of pending) item.fn()
}

function pendingTimerCount() {
  return scheduled.filter((item) => !item.cancelled).length
}

function restoreTimers() {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}

beforeEach(useFakeTimers)
afterEach(() => {
  restoreTimers()
  delete process.env.OPENCODE_DISABLE_TERMINAL_TITLE
})

// --- fake plugin context ---------------------------------------------------

type RouteState =
  | { type: "home" }
  | { type: "session"; sessionID: string }
  | { type: "plugin"; id: string; name: string }

type Part = { type: string; state?: { status?: string }; text?: string }
type Msg = { type: string; content?: Part[] }
type Shell = { id: string; status: string; metadata: { sessionID?: unknown } }

type FakeCommand = { id?: string; run: (input?: string) => unknown }
type FakeLayer = { commands?: FakeCommand[] }

function createHarness(
  route: RouteState = { type: "session", sessionID: "ses_a" },
  location: LocationRef | null = { directory: "/plugin" },
) {
  const [routeState, setRouteState] = createStore<RouteState>(route)
  const [state, setState] = createStore<{
    sessions: Record<string, { title?: string; parentID?: string; location?: LocationRef }>
    families: Record<string, string[]>
    shells: Record<string, Shell[]>
    statuses: Record<string, string>
    messages: Record<string, Msg[]>
    permissions: Record<string, unknown[] | undefined>
    forms: Record<string, unknown[] | undefined>
  }>({ sessions: {}, families: {}, shells: {}, statuses: {}, messages: {}, permissions: {}, forms: {} })
  const [settings, setSettings] = createStore<{ enabled?: unknown }>({ enabled: true })

  const titles: string[] = []
  const toasts: { message: string; variant?: string }[] = []
  const storageKeys: string[] = []
  const layers: (() => FakeLayer)[] = []

  let claim: { render: (input: unknown) => unknown } | undefined
  let rendererDestroyed = false
  let storageError: Error | undefined
  let updateGate: Promise<void> | undefined
  let dispose: (() => void) | undefined

  const context = {
    location: location ?? undefined,
    renderer: {
      get isDestroyed() {
        return rendererDestroyed
      },
      setTerminalTitle(title: string) {
        titles.push(title)
      },
    },
    storage: {
      store(key: string, _options: { initial: object }) {
        storageKeys.push(key)
        const update = async (mutation: (draft: { enabled?: unknown }) => void) => {
          if (updateGate) await updateGate
          if (storageError) throw storageError
          const draft: { enabled?: unknown } = { enabled: settings.enabled }
          mutation(draft)
          setSettings({ enabled: draft.enabled })
        }
        return [settings, update] as const
      },
    },
    data: {
      session: {
        get: (id: string) => state.sessions[id],
        family(id: string) {
          let root = id
          while (state.sessions[root]?.parentID) root = state.sessions[root]!.parentID!
          return state.families[root] ?? []
        },
        status: (id: string) => state.statuses[id] ?? "idle",
        message: { list: (id: string) => state.messages[id] ?? [] },
        permission: { list: (id: string) => state.permissions[id] },
        form: { list: (id: string) => state.forms[id] },
      },
      shell: { list: (ref?: LocationRef) => state.shells[ref?.directory ?? "/default"] ?? [] },
      location: { default: () => ({ directory: "/default" }) },
    },
    ui: {
      slot(c: { render: (input: unknown) => unknown }) {
        claim = c
        return () => undefined
      },
      router: { current: () => routeState },
      toast: {
        show(options: { message: string; variant?: string }) {
          toasts.push(options)
        },
      },
    },
    keymap: {
      layer(fn: () => FakeLayer) {
        layers.push(fn)
      },
    },
  } as unknown as Plugin.Context

  return {
    context,
    titles,
    toasts,
    storageKeys,
    layers,
    setState,
    setSettings,
    getSettings: () => ({ enabled: settings.enabled }),
    claimRegistered: () => claim !== undefined,
    navigate: (next: RouteState) => setRouteState(reconcile(next)),
    simulateHostTitle: (title: string) => titles.push(title),
    destroyRenderer: () => {
      rendererDestroyed = true
    },
    setStorageError: (error: Error | undefined) => {
      storageError = error
    },
    setUpdateGate: (gate: Promise<void> | undefined) => {
      updateGate = gate
    },
    mount() {
      if (!claim) throw new Error("slot was never registered")
      const render = claim.render
      createRoot((d) => {
        dispose = d
        render({})
      })
    },
    unmount() {
      dispose?.()
      dispose = undefined
    },
    toggleCommand(): FakeCommand {
      const layer = layers.at(-1)
      if (!layer) throw new Error("no keymap layer registered")
      const command = layer().commands?.find((c) => c.id === "traffic_light.toggle")
      if (!command) throw new Error("toggle command missing")
      return command
    },
  }
}

// --- 1. pure color/title policy --------------------------------------------

test("traffic_light_v2_preserves_color_and_title_policy", () => {
  const running = { enabled: true, sessionStatus: "running", pendingInput: false }
  const user = { type: "user" }
  const synthetic = { type: "synthetic" }
  const assistant = { type: "assistant" }
  const tool = (status: string): TrafficLightPart => ({ type: "tool", state: { status } })

  // disabled -> no color
  expect(
    computeTrafficLight({ ...running, enabled: false, messages: [assistant], parts: [{ type: "text" }] }),
  ).toBeNull()

  // idle or missing status -> green even with active-looking content
  const activeLooking = { messages: [assistant], parts: [tool("running")] }
  expect(computeTrafficLight({ ...running, ...activeLooking, sessionStatus: "idle" })).toBe("green")
  expect(computeTrafficLight({ ...running, ...activeLooking, sessionStatus: undefined })).toBe("green")

  // running without messages -> green
  expect(computeTrafficLight({ ...running, messages: [] })).toBe("green")
  expect(computeTrafficLight({ ...running })).toBe("green")

  // pending permission/question -> green even with an active tool
  expect(computeTrafficLight({ ...running, ...activeLooking, pendingInput: true })).toBe("green")

  // only user/synthetic messages -> yellow
  expect(computeTrafficLight({ ...running, messages: [user, synthetic] })).toBe("yellow")

  // assistant without parts or reasoning-only -> yellow
  expect(computeTrafficLight({ ...running, messages: [assistant], parts: [] })).toBe("yellow")
  expect(computeTrafficLight({ ...running, messages: [assistant] })).toBe("yellow")
  expect(computeTrafficLight({ ...running, messages: [assistant], parts: [{ type: "reasoning" }] })).toBe("yellow")

  // tool states: streaming/running are active, completed/error are not
  expect(computeTrafficLight({ ...running, messages: [assistant], parts: [tool("streaming")] })).toBe("red")
  expect(computeTrafficLight({ ...running, messages: [assistant], parts: [tool("running")] })).toBe("red")
  expect(computeTrafficLight({ ...running, messages: [assistant], parts: [tool("completed")] })).toBe("yellow")
  expect(computeTrafficLight({ ...running, messages: [assistant], parts: [tool("error")] })).toBe("yellow")

  // text presence -> red while running, even empty text
  expect(computeTrafficLight({ ...running, messages: [assistant], parts: [{ type: "text", text: "" }] })).toBe("red")

  // newest assistant decides: an earlier red assistant followed by a
  // reasoning-only assistant is yellow (caller passes the newest parts)
  expect(
    computeTrafficLight({ ...running, messages: [assistant, assistant], parts: [{ type: "reasoning" }] }),
  ).toBe("yellow")

  // titles
  expect(formatSessionTitle("My Session", "green")).toBe("\u{1F7E2} OC | My Session")
  expect(formatSessionTitle("My Session", "yellow")).toBe("\u{1F7E1} OC | My Session")
  expect(formatSessionTitle("My Session", "red")).toBe("\u{1F534} OC | My Session")
  expect(formatSessionTitle(undefined, "green")).toBe("\u{1F7E2} OpenCode")
  expect(formatSessionTitle("   ", "red")).toBe("\u{1F534} OpenCode")
  // disabled: no emoji and no leading space
  expect(formatSessionTitle("My Session", null)).toBe("OC | My Session")
  expect(formatSessionTitle(undefined, null)).toBe("OpenCode")

  // legacy truncation: >40 UTF-16 code units -> first 37 + "..."
  const exact40 = "a".repeat(40)
  expect(formatSessionTitle(exact40, null)).toBe(`OC | ${exact40}`)
  expect(formatSessionTitle("a".repeat(41), null)).toBe(`OC | ${"a".repeat(37)}...`)

  // inputs are never mutated
  const frozen = Object.freeze({
    enabled: true,
    sessionStatus: "running",
    messages: Object.freeze([{ type: "assistant" } as const]),
    pendingInput: false,
    parts: Object.freeze([{ type: "tool", state: { status: "running" } } as const]),
  })
  expect(computeTrafficLight(frozen)).toBe("red")
})

test("computeTrafficLight_background_activity_obeys_priority", () => {
  const input = {
    enabled: true,
    sessionStatus: "idle",
    pendingInput: false,
    backgroundActive: true,
    messages: [{ type: "assistant" }],
    parts: [{ type: "text" as const, text: "Task started." }],
  }
  expect(computeTrafficLight(input)).toBe("yellow")
  expect(computeTrafficLight({ ...input, backgroundActive: false })).toBe("green")
  expect(computeTrafficLight({ ...input, pendingInput: true })).toBe("green")
  expect(computeTrafficLight({ ...input, enabled: false })).toBeNull()
  expect(computeTrafficLight({ ...input, sessionStatus: "running" })).toBe("red")
  expect(
    computeTrafficLight({
      ...input,
      sessionStatus: "running",
      parts: [{ type: "tool", state: { status: "running" } }],
    }),
  ).toBe("red")
  expect(computeTrafficLight({ ...input, sessionStatus: undefined })).toBe("yellow")
  expect(computeTrafficLight({ ...input, messages: [] })).toBe("yellow")
  expect(computeTrafficLight({ ...input, messages: undefined })).toBe("yellow")
  expect(
    computeTrafficLight({ ...input, parts: [{ type: "tool", state: { status: "running" } }] }),
  ).toBe("yellow")
})

// --- 2. reactive lifecycle --------------------------------------------------

test("plugin_tracks_family_background_activity", async () => {
  const h = createHarness()
  h.setState("sessions", {
    ses_a: { title: "Parent", location: { directory: "/parent" } },
    ses_child: { title: "Child", parentID: "ses_a", location: { directory: "/child" } },
    ses_sibling: { parentID: "ses_a", location: { directory: "/parent" } },
  })
  h.setState("families", "ses_a", ["ses_a", "ses_child", "ses_sibling"])
  h.setState("messages", "ses_a", [{ type: "assistant", content: [{ type: "text", text: "Started." }] }])
  await plugin.setup(h.context)
  h.mount()
  try {
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | Parent")

    h.setState("statuses", "ses_child", "running")
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | Parent")
    h.setState("statuses", "ses_child", "idle")
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | Parent")

    // Background shells have an owner, but no required background flag.
    const parentShell = { id: "sh_parent", status: "running", metadata: { sessionID: "ses_a" } }
    const childShell = { id: "sh_child", status: "running", metadata: { sessionID: "ses_child" } }
    h.setState("shells", "/parent", [parentShell])
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | Parent")
    h.setState("statuses", "ses_child", "running")
    h.setState("shells", "/parent", [])
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | Parent")
    h.setState("shells", "/child", [childShell])
    h.setState("statuses", "ses_child", "idle")
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | Parent")

    h.setState("statuses", "ses_child", "running")
    h.setState("shells", "/child", [])
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | Parent")
    h.setState("statuses", "ses_child", "idle")
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | Parent")

    for (const status of ["exited", "timeout", "killed"]) {
      h.setState("shells", "/parent", [{ ...parentShell, status }])
      flushTimers()
      expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | Parent")
    }
    h.setState("shells", "/parent", [
      { id: "sh_other", status: "running", metadata: { sessionID: "ses_other" } },
      { id: "sh_no_owner", status: "running", metadata: {} },
      { id: "sh_bad_owner", status: "running", metadata: { sessionID: 123 } },
    ])
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | Parent")
    const beforeOtherSession = h.titles.length
    h.setState("statuses", "ses_other", "running")
    flushTimers()
    expect(h.titles.length).toBe(beforeOtherSession)

    // An idle child observes its running parent or siblings, not unrelated roots.
    h.navigate({ type: "session", sessionID: "ses_child" })
    h.setState("statuses", "ses_a", "running")
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | Child")
    h.setState("statuses", "ses_a", "idle")
    h.setState("statuses", "ses_sibling", "running")
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | Child")

    // Any known family member needing input wins over background activity.
    h.setState("permissions", "ses_a", [{ id: "per_parent" }])
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | Child")
    h.setState("permissions", "ses_a", undefined)
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | Child")
    h.setState("forms", "ses_sibling", [{ id: "frm_sibling" }])
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | Child")
    h.setState("forms", "ses_sibling", undefined)
    h.setState("statuses", "ses_sibling", "idle")
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | Child")
  } finally {
    h.unmount()
  }
})

test("plugin_tracks_family_background_activity_before_hydration", async () => {
  const h = createHarness()
  h.setState("statuses", "ses_child", "running")
  await plugin.setup(h.context)
  h.mount()
  try {
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")
    h.setState("families", "ses_a", ["ses_child"])
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OpenCode")
    h.setState("statuses", "ses_child", "idle")
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")

    const shell = { id: "sh_self", status: "running", metadata: { sessionID: "ses_a" } }
    // The displayed session counts even when the family cache omits it.
    h.setState("shells", "/plugin", [shell])
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OpenCode")
    h.setState("sessions", "ses_a", { location: { directory: "/parent" } })
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")
    h.setState("shells", "/parent", [{ ...shell, metadata: { sessionID: "ses_child" } }])
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OpenCode")
  } finally {
    h.unmount()
  }

  const withoutLocation = createHarness({ type: "session", sessionID: "ses_a" }, null)
  withoutLocation.setState("shells", "/default", [
    { id: "sh_self", status: "running", metadata: { sessionID: "ses_a" } },
  ])
  await plugin.setup(withoutLocation.context)
  withoutLocation.mount()
  try {
    flushTimers()
    expect(withoutLocation.titles.at(-1)).toBe("\u{1F7E1} OpenCode")
  } finally {
    withoutLocation.unmount()
  }
})

test("plugin_reacts_to_local_state_and_disposes_pending_work", async () => {
  const h = createHarness()
  const cleanup = await plugin.setup(h.context)
  expect(typeof cleanup).toBe("function")
  expect(h.storageKeys).toEqual(["traffic_light_enabled"])
  expect(h.claimRegistered()).toBe(true)

  // initial mount schedules a title without any server event
  h.mount()
  expect(pendingTimerCount()).toBe(1)
  flushTimers()
  expect(h.titles).toEqual(["\u{1F7E2} OpenCode"])

  // status/message transitions; the two writes coalesce into one title update
  const beforeTransitions = h.titles.length
  h.setState("statuses", "ses_a", "running")
  h.setState("messages", "ses_a", [{ type: "user" }])
  expect(pendingTimerCount()).toBe(1)
  flushTimers()
  expect(h.titles.length).toBe(beforeTransitions + 1)
  expect(h.titles.at(-1)).toBe("\u{1F7E1} OpenCode")

  h.setState("messages", "ses_a", [
    { type: "user" },
    { type: "assistant", content: [{ type: "tool", state: { status: "streaming" } }] },
  ])
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F534} OpenCode")

  h.setState("messages", "ses_a", [
    { type: "user" },
    { type: "assistant", content: [{ type: "tool", state: { status: "completed" } }] },
  ])
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E1} OpenCode")

  // session rename
  h.setState("sessions", "ses_a", { title: "My Session" })
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | My Session")

  // undefined permission/form lists are safe; hydrated lists change the color
  h.setState("permissions", "ses_a", [{ id: "per_1" }])
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | My Session")
  h.setState("permissions", "ses_a", undefined)
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | My Session")
  h.setState("forms", "ses_a", [{ id: "frm_1" }])
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E2} OC | My Session")
  h.setState("forms", "ses_a", undefined)
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | My Session")

  // another session's activity does not trigger updates
  const titlesSoFar = h.titles.length
  h.setState("statuses", "ses_b", "running")
  h.setState("messages", "ses_b", [{ type: "assistant", content: [{ type: "text" }] }])
  expect(pendingTimerCount()).toBe(0)
  flushTimers()
  expect(h.titles.length).toBe(titlesSoFar)

  // navigation: home and plugin pages show the plain title
  h.navigate({ type: "home" })
  flushTimers()
  expect(h.titles.at(-1)).toBe("OpenCode")
  h.navigate({ type: "plugin", id: "plg_a", name: "alpha" })
  flushTimers()
  expect(h.titles.at(-1)).toBe("OpenCode")

  // plugin page A -> B on a reconciled store: the effect must rerun even
  // though `type` is unchanged, so the deferred write still wins
  h.navigate({ type: "plugin", id: "plg_b", name: "beta" })
  expect(pendingTimerCount()).toBe(1)
  h.simulateHostTitle("OC | beta")
  flushTimers()
  expect(h.titles.at(-1)).toBe("OpenCode")

  // back to the session restores the colored title
  h.navigate({ type: "session", sessionID: "ses_a" })
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E1} OC | My Session")

  // switching routes cancels the stale pending write
  h.setState("messages", "ses_a", [{ type: "user" }, { type: "assistant", content: [{ type: "text" }] }])
  expect(pendingTimerCount()).toBe(1)
  const beforeSwitch = h.titles.length
  h.navigate({ type: "home" })
  flushTimers()
  expect(h.titles.slice(beforeSwitch)).toEqual(["OpenCode"])

  // unmount with a pending timer: cleanup cancels it and nothing writes after
  h.navigate({ type: "session", sessionID: "ses_a" })
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F534} OC | My Session")
  h.setState("statuses", "ses_a", "idle")
  expect(pendingTimerCount()).toBe(1)
  const titlesBeforeUnmount = [...h.titles]
  h.unmount()
  expect(pendingTimerCount()).toBe(0)
  h.setState("messages", "ses_a", [{ type: "user" }])
  flushTimers()
  expect(h.titles).toEqual(titlesBeforeUnmount)

  // remount registers exactly one command layer and one live effect
  const layersBefore = h.layers.length
  h.mount()
  expect(h.layers.length).toBe(layersBefore + 1)
  flushTimers()
  const afterRemount = h.titles.length
  h.setState("statuses", "ses_a", "running")
  flushTimers()
  expect(h.titles.length).toBe(afterRemount + 1)

  // a destroyed renderer receives no write
  h.destroyRenderer()
  h.setState("statuses", "ses_a", "idle")
  flushTimers()
  expect(h.titles.length).toBe(afterRemount + 1)
})

// --- 3. persisted toggle + env opt-out --------------------------------------

test("plugin_background_updates_preserve_title_lifecycle", async () => {
  const h = createHarness()
  h.setState("families", "ses_a", ["ses_a", "ses_child"])
  h.setState("statuses", "ses_a", "running")
  h.setState("messages", "ses_a", [{ type: "assistant", content: [{ type: "text" }] }])
  await plugin.setup(h.context)
  h.mount()
  try {
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F534} OpenCode")
    const beforeIdle = h.titles.length
    h.setState("statuses", "ses_child", "running")
    h.setState("statuses", "ses_a", "idle")
    expect(pendingTimerCount()).toBe(1)
    flushTimers()
    expect(h.titles.length).toBe(beforeIdle + 1)
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OpenCode")

    await h.toggleCommand().run()
    flushTimers()
    expect(h.titles.at(-1)).toBe("OpenCode")
    await h.toggleCommand().run()
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OpenCode")

    h.navigate({ type: "session", sessionID: "ses_other" })
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")
    const beforeFamilyUpdate = h.titles.length
    h.setState("statuses", "ses_child", "idle")
    expect(pendingTimerCount()).toBe(0)
    flushTimers()
    expect(h.titles.length).toBe(beforeFamilyUpdate)

    h.navigate({ type: "session", sessionID: "ses_a" })
    h.setState("statuses", "ses_child", "running")
    h.navigate({ type: "home" })
    flushTimers()
    expect(h.titles.at(-1)).toBe("OpenCode")

    h.navigate({ type: "session", sessionID: "ses_a" })
    flushTimers()
    expect(h.titles.at(-1)).toBe("\u{1F7E1} OpenCode")
    h.setState("statuses", "ses_child", "idle")
    expect(pendingTimerCount()).toBe(1)
    const beforeUnmount = [...h.titles]
    h.unmount()
    expect(pendingTimerCount()).toBe(0)
    h.setState("statuses", "ses_child", "running")
    flushTimers()
    expect(h.titles).toEqual(beforeUnmount)
  } finally {
    h.unmount()
  }
})

test("plugin_persists_toggle_and_honors_environment_opt_out", async () => {
  const h = createHarness()
  await plugin.setup(h.context)
  h.mount()
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")

  // toggle off: persisted, exact toast, plain title without leading space
  await h.toggleCommand().run()
  expect(h.getSettings().enabled).toBe(false)
  expect(h.toasts.at(-1)).toEqual({ message: "Traffic light disabled", variant: "info" })
  flushTimers()
  expect(h.titles.at(-1)).toBe("OpenCode")

  // toggle back on
  await h.toggleCommand().run()
  expect(h.getSettings().enabled).toBe(true)
  expect(h.toasts.at(-1)).toEqual({ message: "Traffic light enabled", variant: "info" })
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")

  // preference survives a remount through the same store
  await h.toggleCommand().run()
  flushTimers()
  h.unmount()
  h.mount()
  flushTimers()
  expect(h.titles.at(-1)).toBe("OpenCode")

  // an external store update (second TUI instance) refreshes the title
  h.setSettings({ enabled: true })
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")

  // invalid or missing enabled defaults to enabled
  h.setSettings({ enabled: "off" })
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")
  h.setSettings({ enabled: undefined })
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")

  // overlapping toggles must not lose an update: the inversion has to happen
  // inside the mutation against the freshly loaded value
  let resolveFirst!: () => void
  h.setUpdateGate(new Promise<void>((resolve) => (resolveFirst = resolve)))
  const first = Promise.resolve(h.toggleCommand().run())
  const second = Promise.resolve(h.toggleCommand().run())
  resolveFirst()
  h.setUpdateGate(undefined)
  await Promise.all([first, second])
  expect(h.getSettings().enabled).toBe(true)
  expect(h.toasts.slice(-2).map((t) => t.message)).toEqual([
    "Traffic light disabled",
    "Traffic light enabled",
  ])

  // a rejected persistence keeps the effective state and shows only an error
  h.setStorageError(new Error("disk locked"))
  const toastsBefore = h.toasts.length
  await h.toggleCommand().run()
  expect(h.getSettings().enabled).not.toBe(false)
  expect(h.toasts.length).toBe(toastsBefore + 1)
  expect(h.toasts.at(-1)).toEqual({ message: "Could not save traffic light preference", variant: "error" })
  flushTimers()
  expect(h.titles.at(-1)).toBe("\u{1F7E2} OpenCode")
  h.setStorageError(undefined)

  // an update that completes after unmount cannot write or toast
  let release!: () => void
  h.setUpdateGate(new Promise<void>((resolve) => (release = resolve)))
  const pendingRun = Promise.resolve(h.toggleCommand().run())
  h.unmount()
  release()
  await pendingRun
  flushTimers()
  expect(h.toasts.length).toBe(toastsBefore + 1)
  h.setUpdateGate(undefined)

  // OPENCODE_DISABLE_TERMINAL_TITLE=1: nothing is registered or written
  process.env.OPENCODE_DISABLE_TERMINAL_TITLE = "1"
  const off = createHarness()
  const offCleanup = await plugin.setup(off.context)
  expect(offCleanup).toBeUndefined()
  expect(off.storageKeys).toEqual([])
  expect(off.claimRegistered()).toBe(false)
  flushTimers()
  expect(off.titles).toEqual([])

  // other values keep the plugin active
  process.env.OPENCODE_DISABLE_TERMINAL_TITLE = "0"
  const zero = createHarness()
  await plugin.setup(zero.context)
  expect(zero.claimRegistered()).toBe(true)
  zero.mount()
  flushTimers()
  expect(zero.titles.at(-1)).toBe("\u{1F7E2} OpenCode")
})
