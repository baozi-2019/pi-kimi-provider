/**
 * Kimi Code (subscription) OAuth flow for the `kimi` provider.
 *
 * RFC 8628 device authorization grant against https://auth.kimi.com with JSON
 * responses. The access token authenticates requests to
 * https://api.kimi.com/coding as an `Authorization: Bearer` header.
 *
 * Ported from pi-ai's built-in `kimi-coding` OAuth flow (not exported through
 * a public subpath, so it cannot be imported directly). Uses the same public
 * client_id.
 *
 * Secrets (device codes, access/refresh tokens) are never logged or embedded
 * in error messages.
 */

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com"
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60
const DEFAULT_POLL_INTERVAL_SECONDS = 5
const REQUEST_TIMEOUT_MS = 30 * 1000
const REFRESH_MAX_RETRIES = 3
const MINIMUM_INTERVAL_MS = 1000
// RFC 8628 section 3.5: `slow_down` means the polling interval must increase by 5 seconds.
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  intervalSeconds: number
  expiresInSeconds: number
}

export interface OAuthToken {
  access: string
  refresh: string
  /** Epoch milliseconds at which the access token expires. */
  expires: number
}

function getOauthHost(): string {
  const override = process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST
  return (override?.trim() ? override.trim() : DEFAULT_OAUTH_HOST).replace(/\/+$/, "")
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
}

function formUrlEncode(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString()
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const json: unknown = await response.json()
    return json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The verification URI is opened in the user's browser; only http(s) URLs are trusted. */
function trustedHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    return url.href
  } catch {
    return null
  }
}

async function startDeviceAuthorization(
  oauthHost: string,
  signal: AbortSignal,
): Promise<DeviceAuthorization> {
  const response = await fetch(`${oauthHost}/api/oauth/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formUrlEncode({ client_id: CLIENT_ID }),
    signal: requestSignal(signal),
  })
  if (!response.ok) {
    throw new Error(`Kimi Code device authorization failed with status ${response.status}`)
  }
  const json = await readJson(response)
  const deviceCode = json?.device_code
  const userCode = json?.user_code
  const verificationUri = json?.verification_uri
  const verificationUriComplete = json?.verification_uri_complete
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof verificationUriComplete !== "string" ||
    !trustedHttpUrl(verificationUriComplete) ||
    !trustedHttpUrl(verificationUri)
  ) {
    throw new Error("Invalid Kimi Code device authorization response (missing fields)")
  }
  const interval = json?.interval
  const expiresIn = json?.expires_in
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    intervalSeconds:
      typeof interval === "number" && Number.isFinite(interval) && interval > 0
        ? interval
        : DEFAULT_POLL_INTERVAL_SECONDS,
    expiresInSeconds:
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn
        : DEVICE_CODE_TIMEOUT_SECONDS,
  }
}

/** Exported for tests. Throws when mandatory token fields are absent. */
export function parseTokenResponse(
  json: Record<string, unknown> | null,
  operation: string,
): OAuthToken {
  const accessToken = json?.access_token
  const refreshToken = json?.refresh_token
  const expiresIn = json?.expires_in
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof refreshToken !== "string" ||
    !refreshToken ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error(`Kimi Code token ${operation} response missing fields`)
  }
  return {
    access: accessToken,
    refresh: refreshToken,
    expires: Date.now() + expiresIn * 1000,
  }
}

type PollOutcome =
  | { status: "complete"; value: OAuthToken }
  | { status: "pending" }
  | { status: "slow_down"; intervalSeconds?: number }
  | { status: "failed"; message: string }

async function pollDeviceToken(
  oauthHost: string,
  device: DeviceAuthorization,
  signal: AbortSignal,
): Promise<PollOutcome> {
  const response = await fetch(`${oauthHost}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formUrlEncode({
      client_id: CLIENT_ID,
      device_code: device.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    signal: requestSignal(signal),
  })
  if (response.status >= 500) {
    return {
      status: "failed",
      message: `Kimi Code device token request failed with status ${response.status}`,
    }
  }
  const json = await readJson(response)
  if (response.ok && typeof json?.access_token === "string") {
    try {
      return { status: "complete", value: parseTokenResponse(json, "poll") }
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) }
    }
  }
  const error = json?.error
  const description =
    typeof json?.error_description === "string" ? `: ${json.error_description}` : ""
  if (error === "authorization_pending") return { status: "pending" }
  if (error === "slow_down") {
    const interval = json?.interval
    return {
      status: "slow_down",
      intervalSeconds:
        typeof interval === "number" && Number.isFinite(interval) && interval > 0
          ? interval
          : undefined,
    }
  }
  if (error === "expired_token") {
    return {
      status: "failed",
      message: "Kimi Code device authorization expired. Please restart login.",
    }
  }
  if (error === "access_denied") {
    return { status: "failed", message: "Kimi Code login was denied." }
  }
  return {
    status: "failed",
    message: `Kimi Code device token request failed (status ${response.status})${
      typeof error === "string" ? `: ${error}${description}` : ""
    }`,
  }
}

function abortableSleep(ms: number, signal: AbortSignal, cancelMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(cancelMessage))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(new Error(cancelMessage))
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const CANCEL_MESSAGE = "Login cancelled"
const TIMEOUT_MESSAGE = "Device flow timed out"

async function pollForToken(
  oauthHost: string,
  device: DeviceAuthorization,
  signal: AbortSignal,
): Promise<OAuthToken> {
  const deadline = Date.now() + device.expiresInSeconds * 1000
  let intervalMs = Math.max(MINIMUM_INTERVAL_MS, Math.floor(device.intervalSeconds * 1000))
  let slowDownResponses = 0

  // Wait before the first poll: the user needs time to open the browser.
  await abortableSleep(Math.min(intervalMs, deadline - Date.now()), signal, CANCEL_MESSAGE)

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error(CANCEL_MESSAGE)
    const result = await pollDeviceToken(oauthHost, device, signal)
    if (result.status === "complete") return result.value
    if (result.status === "failed") throw new Error(result.message)
    if (result.status === "slow_down") {
      slowDownResponses += 1
      intervalMs =
        typeof result.intervalSeconds === "number"
          ? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
          : Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS)
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    await abortableSleep(Math.min(intervalMs, remainingMs), signal, CANCEL_MESSAGE)
  }
  throw new Error(
    slowDownResponses > 0
      ? "Device flow timed out after one or more slow_down responses. This is often caused by clock drift."
      : TIMEOUT_MESSAGE,
  )
}

function isRetryableRefreshFailure(response: Response): boolean {
  return response.status === 429 || response.status >= 500
}

/** Exported for tests and for the provider's refreshToken hook. */
export async function refreshOAuthToken(
  refreshTokenValue: string,
  signal: AbortSignal,
): Promise<OAuthToken> {
  const oauthHost = getOauthHost()
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await abortableSleep(1000 * 2 ** (attempt - 1), signal, CANCEL_MESSAGE)
    }
    if (signal.aborted) throw new Error(CANCEL_MESSAGE)
    let response: Response
    try {
      response = await fetch(`${oauthHost}/api/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: formUrlEncode({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshTokenValue,
        }),
        signal: requestSignal(signal),
      })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      continue
    }
    const json = await readJson(response)
    if (response.ok) return parseTokenResponse(json, "refresh")
    // Unauthorized: the stored credential is dead; pi clears it and prompts re-login.
    if (response.status === 401 || response.status === 403 || json?.error === "invalid_grant") {
      const description =
        typeof json?.error_description === "string" ? `: ${json.error_description}` : ""
      throw new Error(
        `Kimi Code token refresh unauthorized (status ${response.status})${description}`,
      )
    }
    if (isRetryableRefreshFailure(response) && attempt < REFRESH_MAX_RETRIES) {
      lastError = new Error(`Kimi Code token refresh failed with status ${response.status}`)
      continue
    }
    throw new Error(`Kimi Code token refresh failed with status ${response.status}`)
  }
  throw lastError ?? new Error("Kimi Code token refresh failed")
}

export interface DeviceCodeNotification {
  userCode: string
  verificationUri: string
  intervalSeconds?: number
  expiresInSeconds?: number
}

/**
 * Run the full device-code login. `onDeviceCode` receives the user code and
 * verification URL exactly once; `signal` aborts the flow (user cancel).
 */
export async function loginWithDeviceCode(options: {
  onDeviceCode: (info: DeviceCodeNotification) => void
  signal?: AbortSignal
}): Promise<OAuthToken> {
  const signal = options.signal ?? new AbortController().signal
  const oauthHost = getOauthHost()
  const device = await startDeviceAuthorization(oauthHost, signal)
  options.onDeviceCode({
    userCode: device.userCode,
    verificationUri: device.verificationUriComplete,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
  })
  return pollForToken(oauthHost, device, signal)
}
