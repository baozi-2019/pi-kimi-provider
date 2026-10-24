/**
 * Model catalog for the `kimi` provider.
 *
 * The static catalog mirrors the official Kimi Code documentation
 * (https://www.kimi.com/code/docs/kimi-code/models.html): k3.1-pro,
 * k3.1-pro-highspeed, k3, k3-256k, kimi-for-coding (K2.8 Preview) and
 * kimi-for-coding-highspeed (K2.7 Code Highspeed).
 *
 * `/kimi-refresh` (and pi's own model refresh) tries the undocumented
 * OpenAI-style `GET {base}/models` endpoint; on any failure the static
 * catalog stays in effect. Remote ids unknown to the static catalog get a
 * conservative generic definition (text only, no reasoning effort).
 *
 * All models use the OpenAI Responses API (officially recommended for the
 * K3.1 family). The Responses API does not accept video input, so `input`
 * is text+image even where the model itself supports video.
 */

import { apiRoot, getKimiApiKey, KIMI_API_KEY_ENV } from "./credentials.ts"

export const KIMI_PROVIDER = "kimi"
export const KIMI_CHAT_BASE_PATH = "/coding/v1"
export const KIMI_MODELS_TIMEOUT_MS = 10_000

/** Structural shape of a chat model config accepted by pi.registerProvider. */
export interface KimiModelConfig {
  type: "chat"
  id: string
  name: string
  reasoning: boolean
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
  >
  input: ("text" | "image")[]
  inputLimits?: unknown
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  compat?: Record<string, unknown>
}

/** Kimi Code is subscription-quota based; per-token costs are not billed. */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** openai-responses compatibility flags, matching verified upstream behavior. */
const RESPONSES_COMPAT: Record<string, unknown> = {
  supportsDeveloperRole: false,
  supportsStrictMode: false,
  supportsMidConvoSystemMessages: true,
  supportsMaxOutputTokens: true,
}

/** Image preprocessing limits, copied from pi's built-in kimi-coding catalog. */
const IMAGE_INPUT_LIMITS = {
  images: {
    resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 },
  },
} as const

/**
 * K3 / K2.8 accept low/high/max and also accept off=none (the documented
 * fallback to K2.8 without thinking). K3.1 Pro rejects off with HTTP 400.
 * Pi-only medium/xhigh levels stay hidden rather than being silently remapped.
 */
const ADJUSTABLE_THINKING = {
  off: "none",
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
} as const

const FORCED_THINKING = { ...ADJUSTABLE_THINKING, off: null } as const

function chatModel(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  thinkingLevelMap: KimiModelConfig["thinkingLevelMap"],
  reasoning = true,
): KimiModelConfig {
  return {
    type: "chat",
    id,
    name,
    reasoning,
    thinkingLevelMap,
    input: ["text", "image"],
    inputLimits: IMAGE_INPUT_LIMITS,
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens,
    compat: { ...RESPONSES_COMPAT },
  }
}

export const STATIC_KIMI_MODELS: KimiModelConfig[] = [
  chatModel("k3.1-pro", "Kimi K3.1 Pro", 1_048_576, 131_072, { ...FORCED_THINKING }),
  chatModel("k3.1-pro-highspeed", "Kimi K3.1 Pro Highspeed", 1_048_576, 131_072, {
    ...FORCED_THINKING,
  }),
  chatModel("k3", "Kimi K3", 1_048_576, 131_072, { ...ADJUSTABLE_THINKING }),
  chatModel("k3-256k", "Kimi K3-256K", 262_144, 131_072, { ...ADJUSTABLE_THINKING }),
  chatModel("kimi-for-coding", "Kimi For Coding (K2.8 Preview)", 1_048_576, 32_768, {
    ...ADJUSTABLE_THINKING,
  }),
  // reasoning=false suppresses pi's effort selector and reasoning request
  // field; K2.7 Highspeed itself remains Thinking:ON by upstream default.
  chatModel(
    "kimi-for-coding-highspeed",
    "Kimi For Coding Highspeed (K2.7)",
    262_144,
    32_768,
    undefined,
    false,
  ),
]

const STATIC_BY_ID = new Map(STATIC_KIMI_MODELS.map((model) => [model.id, model]))

/** Conservative fallback for remote ids the static catalog does not know. */
function genericModel(id: string): KimiModelConfig {
  return {
    type: "chat",
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: 262_144,
    maxTokens: 32_768,
    compat: { ...RESPONSES_COMPAT },
  }
}

// ---------------------------------------------------------------------------
// Remote model list (undocumented OpenAI-style GET {base}/models endpoint)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Extract model ids from an OpenAI-style /models response. Null = unusable. */
export function parseModelsResponse(raw: unknown): string[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return null
  const ids: string[] = []
  for (const entry of raw.data) {
    if (typeof entry === "string" && entry.trim()) ids.push(entry.trim())
    else if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
      ids.push(entry.id.trim())
    }
  }
  return ids.length > 0 ? [...new Set(ids)] : null
}

/** Map remote ids onto the static catalog; unknown ids get generic defs. */
export function buildModelsFromIds(ids: string[]): KimiModelConfig[] {
  return ids.map((id) => STATIC_BY_ID.get(id) ?? genericModel(id))
}

export type FetchModelsResult = { ok: true; ids: string[] } | { ok: false; message: string }

export async function fetchRemoteModelIds(options: {
  apiKey: string
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<FetchModelsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? KIMI_MODELS_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const requestSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${options.apiKey}` },
      signal: requestSignal,
    })
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}` }
    }
    const ids = parseModelsResponse(await response.json())
    if (!ids) return { ok: false, message: "unreadable model list" }
    return { ok: true, ids }
  } catch (error) {
    const reason = options.signal?.aborted
      ? "model refresh aborted"
      : controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error)
    // Never leak the key through error text.
    return { ok: false, message: reason.split(options.apiKey).join("[redacted]") }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Provider refresh hook + last-refresh state for /kimi-refresh reporting
// ---------------------------------------------------------------------------

export interface KimiModelsRefreshState {
  at: number
  source: "remote" | "static" | "offline"
  modelIds: string[]
  /** Sanitized failure reason when source is "static" after a failed fetch. */
  error?: string
}

let lastRefresh: KimiModelsRefreshState | undefined

/** Last refresh outcome, for the /kimi-refresh command to report. */
export function getLastModelsRefresh(): KimiModelsRefreshState | undefined {
  return lastRefresh
}

export interface RefreshModelsContextLike {
  credential?: { type: string; key?: string; access?: string }
  allowNetwork: boolean
  baseUrl?: string
  signal: AbortSignal
}

function credentialKey(credential: RefreshModelsContextLike["credential"]): string | undefined {
  if (!credential) return undefined
  const value = credential.key ?? credential.access
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * ProviderConfig.refreshModels implementation. The returned list replaces the
 * extension-provided models; the static catalog is both the offline answer
 * and the failure fallback, so this never throws.
 */
export async function refreshKimiModels(
  context: RefreshModelsContextLike,
): Promise<KimiModelConfig[]> {
  const staticIds = STATIC_KIMI_MODELS.map((model) => model.id)
  if (!context.allowNetwork) {
    lastRefresh = { at: Date.now(), source: "offline", modelIds: staticIds }
    return STATIC_KIMI_MODELS
  }
  if (context.signal.aborted) return STATIC_KIMI_MODELS

  const apiKey = credentialKey(context.credential) ?? getKimiApiKey()
  if (!apiKey) {
    lastRefresh = {
      at: Date.now(),
      source: "static",
      modelIds: staticIds,
      error: `no credential (set ${KIMI_API_KEY_ENV} or run /login)`,
    }
    return STATIC_KIMI_MODELS
  }

  const baseUrl = context.baseUrl ?? `${apiRoot()}${KIMI_CHAT_BASE_PATH}`
  const result = await fetchRemoteModelIds({ apiKey, baseUrl, signal: context.signal })
  // pi may abort a stale/background refresh. Its result must not overwrite
  // the report from a newer or explicitly requested refresh.
  if (context.signal.aborted) return STATIC_KIMI_MODELS
  if (!result.ok) {
    lastRefresh = {
      at: Date.now(),
      source: "static",
      modelIds: staticIds,
      error: result.message,
    }
    return STATIC_KIMI_MODELS
  }

  const models = buildModelsFromIds(result.ids)
  lastRefresh = { at: Date.now(), source: "remote", modelIds: result.ids }
  return models
}
