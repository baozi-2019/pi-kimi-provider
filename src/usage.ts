/**
 * HTTP client for the Kimi Coding usage endpoint.
 *
 * `GET {apiRoot}/coding/v1/usages` with `Authorization: Bearer <key>`.
 * The endpoint is undocumented; every caller-visible failure is normalized
 * into a typed error with a sanitized message that never contains the key.
 *
 * Ported from pi-kimi-usage (same upstream contract), adjusted to resolve
 * the API root through src/credentials.ts (`kimi` provider credential chain).
 */

import { apiRoot } from "./credentials.ts"

export const KIMI_USAGE_PATH = "/coding/v1/usages"
export const KIMI_USAGE_TIMEOUT_MS = 10_000
export const KIMI_USAGE_THROTTLE_MS = 5_000

export type KimiUsageErrorKind = "config" | "http" | "timeout" | "network"

export type KimiUsageResult =
  { ok: true; data: unknown } | { ok: false; error: { kind: KimiUsageErrorKind; message: string } }

export interface FetchKimiUsageOptions {
  apiKey: string
  apiBase?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** Strip credential-shaped values from text surfaced to the user. */
export function redactSensitiveText(text: string, apiKey?: string): string {
  let out = text
  if (apiKey) out = out.split(apiKey).join("[redacted]")
  return out
    .replace(/Bearer\s+\S{8,}/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function httpErrorMessage(status: number, statusText: string): string {
  if (status === 401 || status === 403) {
    return `Kimi rejected the API key (HTTP ${status}). Run /login to refresh the kimi credential, or check KIMI_API_KEY.`
  }
  if (status === 429) {
    return "Kimi rate limited the usage request (HTTP 429). Try again in a moment."
  }
  return `Kimi usage request failed (HTTP ${status}${statusText ? ` ${statusText}` : ""}).`
}

export async function fetchKimiUsage(options: FetchKimiUsageOptions): Promise<KimiUsageResult> {
  if (!options.apiKey) {
    return { ok: false, error: { kind: "config", message: "No Kimi API key configured" } }
  }

  const base = (options.apiBase ?? apiRoot()).replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? KIMI_USAGE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(`${base}${KIMI_USAGE_PATH}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        ok: false,
        error: { kind: "http", message: httpErrorMessage(response.status, response.statusText) },
      }
    }
    try {
      return { ok: true, data: (await response.json()) as unknown }
    } catch {
      return {
        ok: false,
        error: { kind: "http", message: "Kimi returned an unreadable usage response" },
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        error: {
          kind: "timeout",
          message: `Kimi usage request timed out after ${timeoutMs}ms. Check your network and try again.`,
        },
      }
    }
    return {
      ok: false,
      error: {
        kind: "network",
        message: redactSensitiveText(
          `Failed to reach the Kimi usage endpoint: ${errorMessage(error)}`,
          options.apiKey,
        ),
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

export type ThrottleSlot = { allowed: true } | { allowed: false; retryAfterMs: number }

/**
 * Manual-refresh throttle: at most one fetch per `intervalMs`. There is no
 * result caching — a throttled call is refused, not served stale data.
 */
export function createUsageThrottle(
  intervalMs: number = KIMI_USAGE_THROTTLE_MS,
  now: () => number = Date.now,
): { tryAcquire: () => ThrottleSlot } {
  let lastAt = Number.NEGATIVE_INFINITY
  return {
    tryAcquire() {
      const current = now()
      const elapsed = current - lastAt
      if (elapsed < intervalMs) {
        return { allowed: false, retryAfterMs: intervalMs - elapsed }
      }
      lastAt = current
      return { allowed: true }
    },
  }
}
