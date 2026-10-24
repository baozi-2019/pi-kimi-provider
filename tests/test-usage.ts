/**
 * Unit tests for src/usage.ts — hermetic, fetch is injected.
 * All keys and payloads are fabricated.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { createUsageThrottle, fetchKimiUsage, redactSensitiveText } from "../src/usage.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("fetchKimiUsage", () => {
  it("fetches and returns the raw usage payload", async () => {
    let seenUrl = ""
    let seenAuth = ""
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seenUrl = String(input)
      seenAuth = new Headers(init?.headers).get("authorization") ?? ""
      return jsonResponse({ usages: { limit_5h: { used_ratio: 0.5 } } })
    }
    const result = await fetchKimiUsage({ apiKey: "sk-kimi-fake-test-key", fetchImpl })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.data, { usages: { limit_5h: { used_ratio: 0.5 } } })
    }
    assert.equal(seenUrl, "https://api.kimi.com/coding/v1/usages")
    assert.equal(seenAuth, "Bearer sk-kimi-fake-test-key")
  })

  it("honors the apiBase override (used by tests and self-hosters)", async () => {
    let seenUrl = ""
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      seenUrl = String(input)
      return jsonResponse({ usages: {} })
    }
    const result = await fetchKimiUsage({
      apiKey: "sk-kimi-fake-test-key",
      apiBase: "http://127.0.0.1:8080/",
      fetchImpl,
    })
    assert.equal(result.ok, true)
    assert.equal(seenUrl, "http://127.0.0.1:8080/coding/v1/usages")
  })

  it("explains 401 as a rejected API key", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ error: "unauthorized" }, 401)
    const result = await fetchKimiUsage({ apiKey: "sk-kimi-fake-test-key", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "http")
    assert.match(result.error.message, /401/)
    assert.match(result.error.message, /rejected the API key/i)
    assert.doesNotMatch(result.error.message, /sk-kimi-fake-test-key/)
  })

  it("explains 429 as rate limiting", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ error: "slow down" }, 429)
    const result = await fetchKimiUsage({ apiKey: "sk-kimi-fake-test-key", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "http")
    assert.match(result.error.message, /429/)
    assert.match(result.error.message, /rate limited/i)
  })

  it("reports other HTTP failures with their status", async () => {
    const fetchImpl = async (): Promise<Response> => jsonResponse({ error: "boom" }, 503)
    const result = await fetchKimiUsage({ apiKey: "sk-kimi-fake-test-key", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "http")
    assert.match(result.error.message, /503/)
  })

  it("times out when the request never resolves", async () => {
    const start = Date.now()
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        )
      })
    }
    const result = await fetchKimiUsage({
      apiKey: "sk-kimi-fake-test-key",
      fetchImpl,
      timeoutMs: 30,
    })
    const elapsed = Date.now() - start
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "timeout")
    assert.match(result.error.message, /timed out after 30ms/)
    assert.ok(elapsed < 1_000, `elapsed ${elapsed}ms exceeded the timeout budget`)
  })

  it("redacts the API key from network error messages", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error("connect failed for sk-kimi-fake-test-key via proxy")
    }
    const result = await fetchKimiUsage({ apiKey: "sk-kimi-fake-test-key", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "network")
    assert.doesNotMatch(result.error.message, /sk-kimi-fake-test-key/)
    assert.match(result.error.message, /Failed to reach the Kimi usage endpoint/)
  })

  it("reports unreadable JSON instead of crashing", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response("not json", { status: 200, headers: { "content-type": "text/html" } })
    const result = await fetchKimiUsage({ apiKey: "sk-kimi-fake-test-key", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error.message, /unreadable/i)
  })

  it("rejects a missing API key as a config error without fetching", async () => {
    let called = false
    const fetchImpl = async (): Promise<Response> => {
      called = true
      return jsonResponse({})
    }
    const result = await fetchKimiUsage({ apiKey: "", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "config")
    assert.equal(called, false)
  })
})

describe("createUsageThrottle", () => {
  it("allows the first call and refuses repeats within the interval", () => {
    let now = 1_000
    const throttle = createUsageThrottle(5_000, () => now)
    assert.deepEqual(throttle.tryAcquire(), { allowed: true })

    now = 3_000
    const denied = throttle.tryAcquire()
    assert.equal(denied.allowed, false)
    if (!denied.allowed) assert.equal(denied.retryAfterMs, 3_000)

    now = 6_500
    assert.deepEqual(throttle.tryAcquire(), { allowed: true })
  })

  it("defaults to a 5 second interval", () => {
    let now = 0
    const throttle = createUsageThrottle(undefined, () => now)
    throttle.tryAcquire()
    now = 4_999
    assert.equal(throttle.tryAcquire().allowed, false)
    now = 5_000
    assert.equal(throttle.tryAcquire().allowed, true)
  })
})

describe("redactSensitiveText", () => {
  it("redacts bearer tokens and sk- keys", () => {
    assert.equal(redactSensitiveText("Bearer abcdef1234567890 failed"), "Bearer [redacted] failed")
    assert.equal(redactSensitiveText("key sk-abcdefghijklmnop bad"), "key [redacted] bad")
  })

  it("redacts the exact api key wherever it appears", () => {
    assert.equal(redactSensitiveText("401 for short-key", "short-key"), "401 for [redacted]")
  })
})
