/**
 * Kimi credential resolution for the `kimi` provider.
 *
 * The API key is read from (in priority order):
 * 1. the `KIMI_API_KEY` environment variable,
 * 2. pi's credential store (`auth.json` in the agent directory —
 *    `$PI_CODING_AGENT_DIR` or `~/.pi/agent`), entry `kimi`, written by
 *    `/login` as either `{ type: "api_key", key }` or `{ type: "oauth", access }`.
 *
 * The built-in `kimi-coding` entry is intentionally NOT consulted: this
 * extension manages its own provider identity.
 *
 * The key must never be written to logs, messages, fixtures, or any other
 * output.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const KIMI_PROVIDER = "kimi"
export const KIMI_API_KEY_ENV = "KIMI_API_KEY"

type EnvLike = Record<string, string | undefined>

export interface KimiCredentialsOptions {
  env?: EnvLike
  /** pi agent directory that contains auth.json (defaults from env/home). */
  agentDir?: string
}

export function defaultAgentDir(env: EnvLike): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim()
  return configured ? configured : join(homedir(), ".pi", "agent")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Resolve the Kimi API key. Returns `undefined` when no credential is
 * configured; never throws on a missing or corrupt auth.json.
 */
export function getKimiApiKey(options: KimiCredentialsOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const envKey = nonEmptyString(env[KIMI_API_KEY_ENV])
  if (envKey) return envKey

  const authPath = join(options.agentDir ?? defaultAgentDir(env), "auth.json")
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(authPath, "utf-8"))
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const entry = parsed[KIMI_PROVIDER]
  if (!isRecord(entry)) return undefined
  // pi stores { type: "api_key", key } for /login API keys and
  // { type: "oauth", access } for OAuth sessions; both authenticate as Bearer.
  return nonEmptyString(entry.key) ?? nonEmptyString(entry.access)
}

export const DEFAULT_KIMI_API_BASE = "https://api.kimi.com"
export const KIMI_API_BASE_ENV = "KIMI_API_BASE"

/**
 * Resolve the API root (no trailing slash, no path). The chat endpoint is
 * `${apiRoot()}/coding/v1`; usage and model-list endpoints hang below it.
 */
export function apiRoot(env: EnvLike = process.env): string {
  const override = nonEmptyString(env[KIMI_API_BASE_ENV])
  return (override ?? DEFAULT_KIMI_API_BASE).replace(/\/+$/, "")
}
