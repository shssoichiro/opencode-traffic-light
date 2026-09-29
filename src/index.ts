import { Plugin } from "@opencode/plugin/tui"
import { createEffect, onCleanup } from "solid-js"

export type TrafficLightColor = "green" | "yellow" | "red"

// Structural inputs so the policy stays testable without SDK types. V2
// assistant content assigns directly: tool parts carry `state.status`
// ("streaming" | "running" | "completed" | "error"); text/reasoning parts are
// recognized by `type` alone.
export type TrafficLightPart =
  | { readonly type: "tool"; readonly state?: { readonly status?: string } }
  | { readonly type: "text"; readonly text?: string }
  | { readonly type: "reasoning"; readonly text?: string }

export type TrafficLightMessage = { readonly type: string }

export type TrafficLightInput = {
  readonly enabled: boolean
  readonly sessionStatus?: string
  readonly messages?: readonly TrafficLightMessage[]
  readonly pendingInput: boolean
  readonly parts?: readonly TrafficLightPart[]
}

export function computeTrafficLight(input: TrafficLightInput): TrafficLightColor | null {
  if (!input.enabled) return null
  if (!input.sessionStatus || input.sessionStatus === "idle") return "green"
  if (!input.messages || input.messages.length === 0) return "green"
  if (input.pendingInput) return "green"

  if (!input.messages.some((message) => message.type === "assistant")) return "yellow"
  if (!input.parts || input.parts.length === 0) return "yellow"

  // V1 parity: "streaming" replaces the old "pending" as the not-yet-running
  // tool state; both count as active.
  const hasActiveTool = input.parts.some(
    (part) =>
      part.type === "tool" && (part.state?.status === "running" || part.state?.status === "streaming"),
  )
  if (hasActiveTool) return "red"

  // V1 parity: text presence decides red, not whether the text is still growing.
  if (input.parts.some((part) => part.type === "text")) return "red"

  return "yellow"
}

export function statusEmoji(color: TrafficLightColor | null): string {
  if (color === "green") return "\u{1F7E2}"
  if (color === "yellow") return "\u{1F7E1}"
  if (color === "red") return "\u{1F534}"
  return ""
}

// V1 parity: blank titles fall back to "OpenCode"; titles over 40 UTF-16 code
// units truncate to 37 + "...". Disabled (null color) drops the emoji and the
// incidental leading space the V1 template string produced.
export function formatSessionTitle(title: string | undefined, color: TrafficLightColor | null): string {
  const base =
    !title || title.trim() === ""
      ? "OpenCode"
      : `OC | ${title.length > 40 ? title.slice(0, 37) + "..." : title}`
  const emoji = statusEmoji(color)
  return emoji ? `${emoji} ${base}` : base
}

export default Plugin.define({
  id: "opencode-traffic-light",
  setup(context) {
    // V1 parity: hard opt-out before registering anything. There is no public
    // V2 API for the native terminal.title setting, so this env var remains
    // the only supported guarantee against title writes.
    if (process.env.OPENCODE_DISABLE_TERMINAL_TITLE === "1") return

    // New plugin-scoped V2 storage namespace: the V1 boolean is not migrated,
    // so an upgrade starts enabled once (accepted behavior).
    const [settings, updateSettings] = context.storage.store("traffic_light_enabled", {
      initial: { enabled: true },
    })

    // The slot renders nothing visible. It exists so the keymap layer, title
    // effect, and cleanup below are created under a Solid owner and are
    // disposed when the plugin unloads or hot-reloads.
    return context.ui.slot({
      append: "app",
      render() {
        let timer: ReturnType<typeof setTimeout> | undefined
        let disposed = false

        const toast = (message: string, variant: "info" | "error") => {
          if (disposed || context.renderer.isDestroyed) return
          context.ui.toast.show({ message, variant })
        }

        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "traffic_light.toggle",
              title: "Toggle traffic light",
              group: "Plugin",
              palette: true,
              async run() {
                // Invert inside the mutation, against the freshly loaded
                // value: overlapping toggles must not lose an update.
                let next = settings.enabled !== false
                try {
                  await updateSettings((draft) => {
                    next = !(draft.enabled !== false)
                    draft.enabled = next
                  })
                } catch {
                  toast("Could not save traffic light preference", "error")
                  return
                }
                toast(`Traffic light ${next ? "enabled" : "disabled"}`, "info")
              },
            },
          ],
          bindings: [],
        }))

        createEffect(() => {
          // All reactive reads happen synchronously here; only the terminal
          // write is deferred one macrotask so it lands after OpenCode's own
          // title effect for this frame. Successive runs coalesce into a
          // single write. The route is shallow-spread so plugin-page name
          // changes are tracked even though `type` stays "plugin".
          const route = { ...context.ui.router.current() }
          const enabled = settings.enabled !== false
          let title: string
          if (route.type !== "session") {
            title = "OpenCode"
          } else {
            const sessionID = route.sessionID
            const session = context.data.session.get(sessionID)
            const messages = context.data.session.message.list(sessionID)
            const permissions = context.data.session.permission.list(sessionID)
            const forms = context.data.session.form.list(sessionID)
            const lastAssistant = [...messages]
              .reverse()
              .find((message) => message.type === "assistant")
            const color = computeTrafficLight({
              enabled,
              sessionStatus: context.data.session.status(sessionID),
              messages,
              pendingInput: (permissions?.length ?? 0) > 0 || (forms?.length ?? 0) > 0,
              parts:
                lastAssistant && "content" in lastAssistant ? lastAssistant.content : undefined,
            })
            title = formatSessionTitle(session?.title, color)
          }
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = undefined
            if (disposed || context.renderer.isDestroyed) return
            context.renderer.setTerminalTitle(title)
          }, 0)
        })

        onCleanup(() => {
          disposed = true
          if (timer !== undefined) clearTimeout(timer)
        })

        return null
      },
    })
  },
})
