/**
 * Mode-aware command output. TUI usage results are durable custom entries,
 * which render immediately without entering the agent transcript or steering
 * queue. Other UI output uses notifications; headless modes use stdout/stderr.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

export const KIMI_USAGE_ENTRY = "kimi-usage"

export type EmitKind = "info" | "warning" | "error"

export function makeEmit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  entryType?: string,
): (text: string, kind: EmitKind) => void {
  const tui = ctx.mode === "tui" && ctx.hasUI
  return (text, kind) => {
    if (tui && kind === "info" && entryType) {
      pi.appendEntry(entryType, { text })
    } else if (ctx.hasUI) {
      ctx.ui.notify(text, kind)
    } else if (kind === "error" || ctx.mode !== "print") {
      // JSON mode: stdout is the machine-readable event stream, so even
      // info output must go to stderr.
      // pi-lens-ignore: no-console-except-error
      console.error(text)
    } else {
      // pi-lens-ignore: no-console-except-error
      console.log(text)
    }
  }
}
