/**
 * pi-kimi-provider — self-contained `kimi` provider for the Kimi Code plan.
 *
 * - Registers provider `kimi` (OpenAI Responses API against
 *   {KIMI_API_BASE|https://api.kimi.com}/coding/v1) with API-key auth
 *   (KIMI_API_KEY env or /login) and Kimi Code OAuth device-code login.
 * - `/kimi-usage` renders 5-hour / 7-day quota bars (undocumented endpoint,
 *   ported from pi-kimi-usage).
 * - `/kimi-refresh` re-fetches the model list (undocumented GET /models),
 *   falling back to the built-in static catalog.
 *
 * Rendering: interactive and RPC sessions get non-blocking notifications;
 * print/json modes degrade to stdout/stderr.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

import { apiRoot, getKimiApiKey, KIMI_API_KEY_ENV, KIMI_PROVIDER } from "./src/credentials.ts"
import {
  getLastModelsRefresh,
  KIMI_CHAT_BASE_PATH,
  refreshKimiModels,
  STATIC_KIMI_MODELS,
} from "./src/models.ts"
import { loginWithDeviceCode, refreshOAuthToken } from "./src/oauth.ts"
import { parseKimiUsageResponse, renderUsageText } from "./src/render.ts"
import { createUsageThrottle, fetchKimiUsage } from "./src/usage.ts"

type EmitKind = "info" | "warning" | "error"

/** Immediate UI feedback must not enter the active agent's steering queue. */
function makeEmit(ctx: ExtensionCommandContext): (text: string, kind: EmitKind) => void {
  return (text, kind) => {
    if (ctx.hasUI) {
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

function requireApiKey(emit: (text: string, kind: EmitKind) => void): string | undefined {
  const apiKey = getKimiApiKey()
  if (!apiKey) {
    emit(
      `Kimi API key not found. Run /login and select kimi, or set ${KIMI_API_KEY_ENV}.`,
      "warning",
    )
  }
  return apiKey
}

export default function (pi: ExtensionAPI) {
  const usageThrottle = createUsageThrottle()
  const refreshThrottle = createUsageThrottle()

  // -------------------------------------------------------------------------
  // Provider `kimi`: OpenAI Responses API + API key / OAuth device-code login
  // -------------------------------------------------------------------------

  pi.registerProvider(KIMI_PROVIDER, {
    // Display name matches the provider id; the built-in kimi-coding provider
    // owns "Kimi For Coding", so a distinct name avoids a duplicate /login entry.
    name: "kimi",
    baseUrl: `${apiRoot()}${KIMI_CHAT_BASE_PATH}`,
    apiKey: `$${KIMI_API_KEY_ENV}`,
    authHeader: true,
    api: "openai-responses",
    models: STATIC_KIMI_MODELS,
    refreshModels: refreshKimiModels,
    oauth: {
      name: "kimi",
      isSubscription: true,
      async login(callbacks) {
        const token = await loginWithDeviceCode({
          onDeviceCode: (info) => callbacks.onDeviceCode(info),
          signal: callbacks.signal,
        })
        return {
          type: "oauth",
          access: token.access,
          refresh: token.refresh,
          expires: token.expires,
        }
      },
      async refreshToken(credentials, signal) {
        const token = await refreshOAuthToken(credentials.refresh, signal)
        return {
          type: "oauth",
          access: token.access,
          refresh: token.refresh,
          expires: token.expires,
        }
      },
      getApiKey: (credentials) => credentials.access,
    },
  })

  // -------------------------------------------------------------------------
  // /kimi-usage
  // -------------------------------------------------------------------------

  pi.registerCommand("kimi-usage", {
    description: "Show Kimi Coding plan usage (5-hour and 7-day limits)",
    handler: async (_args, ctx) => {
      // Usage is independent of the active agent run. Do not wait for idle:
      // pi executes extension commands immediately even while streaming.
      const emit = makeEmit(ctx)

      const apiKey = requireApiKey(emit)
      if (!apiKey) return

      const slot = usageThrottle.tryAcquire()
      if (!slot.allowed) {
        emit(
          `Kimi usage was just fetched. Please wait ${Math.ceil(slot.retryAfterMs / 1000)}s before checking again.`,
          "warning",
        )
        return
      }

      const result = await fetchKimiUsage({ apiKey })
      if (!result.ok) {
        emit(result.error.message, "error")
        return
      }
      emit(renderUsageText(parseKimiUsageResponse(result.data)), "info")
    },
  })

  // -------------------------------------------------------------------------
  // /kimi-refresh
  // -------------------------------------------------------------------------

  pi.registerCommand("kimi-refresh", {
    description: "Refresh the kimi provider model list (online, static catalog fallback)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle?.()
      const emit = makeEmit(ctx)

      const apiKey = requireApiKey(emit)
      if (!apiKey) return

      const slot = refreshThrottle.tryAcquire()
      if (!slot.allowed) {
        emit(
          `Kimi models were just refreshed. Please wait ${Math.ceil(slot.retryAfterMs / 1000)}s before refreshing again.`,
          "warning",
        )
        return
      }

      const before = STATIC_KIMI_MODELS.map((model) => model.id)
      const result = await ctx.modelRegistry.refresh({
        providers: [KIMI_PROVIDER],
        allowNetwork: true,
        force: true,
      })

      const failure = result.errors.get(KIMI_PROVIDER)
      if (result.aborted) {
        emit("Kimi model refresh was aborted.", "warning")
        return
      }
      if (failure) {
        emit(`Kimi model refresh failed: ${failure.message}`, "error")
        return
      }

      const state = getLastModelsRefresh()
      if (!state || state.source === "offline") {
        emit("Kimi model refresh ran offline; static catalog kept.", "warning")
        return
      }
      if (state.source === "static") {
        emit(
          `Kimi model list endpoint unavailable (${state.error ?? "unknown error"}); static catalog kept: ${state.modelIds.join(", ")}`,
          "warning",
        )
        return
      }

      const added = state.modelIds.filter((id) => !before.includes(id))
      const removed = before.filter((id) => !state.modelIds.includes(id))
      const parts = [`Kimi models refreshed from server: ${state.modelIds.join(", ")}`]
      if (added.length > 0) parts.push(`added: ${added.join(", ")}`)
      if (removed.length > 0) parts.push(`removed: ${removed.join(", ")}`)
      emit(parts.join("\n"), "info")
    },
  })
}
