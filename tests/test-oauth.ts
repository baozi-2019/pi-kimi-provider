/**
 * Unit tests for src/oauth.ts — hermetic, uses a local mock OAuth server.
 * All codes and tokens are fabricated.
 */

import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { afterEach, beforeEach, describe, it } from "node:test"

import { loginWithDeviceCode, parseTokenResponse, refreshOAuthToken } from "../src/oauth.ts"

let server: Server
let port: number
let savedHost: string | undefined

type TokenHandler = (body: string) => { status: number; json: Record<string, unknown> }

let deviceHandler: () => { status: number; json: Record<string, unknown> }
let tokenHandler: TokenHandler
let tokenBodies: string[]

beforeEach(async () => {
  tokenBodies = []
  deviceHandler = () => ({
    status: 200,
    json: {
      device_code: "fake-device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://www.kimi.com/device",
      verification_uri_complete: "https://www.kimi.com/device?user_code=ABCD-EFGH",
      interval: 1,
      expires_in: 30,
    },
  })
  tokenHandler = () => ({
    status: 200,
    json: { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 },
  })

  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      if (req.method === "POST" && pathname === "/api/oauth/device_authorization") {
        const { status, json } = deviceHandler()
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(json))
        return
      }
      if (req.method === "POST" && pathname === "/api/oauth/token") {
        tokenBodies.push(body)
        const { status, json } = tokenHandler(body)
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(json))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  port = typeof address === "object" && address ? address.port : 0

  savedHost = process.env.KIMI_OAUTH_HOST
  process.env.KIMI_OAUTH_HOST = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  if (savedHost === undefined) delete process.env.KIMI_OAUTH_HOST
  else process.env.KIMI_OAUTH_HOST = savedHost
  await new Promise((resolve) => server.close(resolve))
})

describe("parseTokenResponse", () => {
  it("parses a complete token payload", () => {
    const before = Date.now()
    const token = parseTokenResponse(
      { access_token: "a", refresh_token: "r", expires_in: 3600 },
      "test",
    )
    assert.equal(token.access, "a")
    assert.equal(token.refresh, "r")
    assert.ok(token.expires >= before + 3_600_000)
  })

  it("rejects payloads missing mandatory fields", () => {
    assert.throws(() => parseTokenResponse({ access_token: "a" }, "test"), /missing fields/)
    assert.throws(() => parseTokenResponse(null, "test"), /missing fields/)
    assert.throws(
      () => parseTokenResponse({ access_token: "a", refresh_token: "r", expires_in: -1 }, "test"),
      /missing fields/,
    )
  })
})

describe("loginWithDeviceCode", () => {
  it("runs the device flow and reports the user code once", async () => {
    let polls = 0
    tokenHandler = () => {
      polls += 1
      if (polls === 1) return { status: 400, json: { error: "authorization_pending" } }
      return {
        status: 200,
        json: { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 },
      }
    }

    const notifications: string[] = []
    const token = await loginWithDeviceCode({
      onDeviceCode: (info) => notifications.push(`${info.userCode} @ ${info.verificationUri}`),
      signal: new AbortController().signal,
    })

    assert.equal(token.access, "fake-access")
    assert.equal(token.refresh, "fake-refresh")
    assert.deepEqual(notifications, ["ABCD-EFGH @ https://www.kimi.com/device?user_code=ABCD-EFGH"])
    assert.ok(polls >= 2)
    // Never send tokens or device codes back to endpoints other than the mock.
    for (const body of tokenBodies) {
      assert.match(body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/)
    }
  })

  it("aborts cleanly when the user cancels", async () => {
    tokenHandler = () => ({ status: 400, json: { error: "authorization_pending" } })
    const controller = new AbortController()
    const pending = loginWithDeviceCode({
      onDeviceCode: () => controller.abort(),
      signal: controller.signal,
    })
    await assert.rejects(pending, /cancelled/i)
  })

  it("fails when the device authorization response is malformed", async () => {
    deviceHandler = () => ({ status: 200, json: { unexpected: true } })
    await assert.rejects(
      loginWithDeviceCode({
        onDeviceCode: () => {},
        signal: new AbortController().signal,
      }),
      /missing fields/,
    )
  })

  it("surfaces access_denied as a denial", async () => {
    tokenHandler = () => ({ status: 400, json: { error: "access_denied" } })
    await assert.rejects(
      loginWithDeviceCode({
        onDeviceCode: () => {},
        signal: new AbortController().signal,
      }),
      /denied/i,
    )
  })
})

describe("refreshOAuthToken", () => {
  it("exchanges the refresh token for a new pair", async () => {
    const token = await refreshOAuthToken("fake-refresh", new AbortController().signal)
    assert.equal(token.access, "fake-access")
    assert.equal(token.refresh, "fake-refresh")
    assert.ok(tokenBodies[0]?.includes("grant_type=refresh_token"))
    assert.ok(tokenBodies[0]?.includes("refresh_token=fake-refresh"))
  })

  it("treats 401 as a dead credential without retrying", async () => {
    tokenHandler = () => ({ status: 401, json: { error: "invalid_grant" } })
    await assert.rejects(
      refreshOAuthToken("fake-refresh", new AbortController().signal),
      /unauthorized/,
    )
    assert.equal(tokenBodies.length, 1)
  })

  it("retries 5xx with backoff and succeeds", async () => {
    let calls = 0
    tokenHandler = () => {
      calls += 1
      if (calls < 3) return { status: 500, json: { error: "boom" } }
      return {
        status: 200,
        json: { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 },
      }
    }
    const token = await refreshOAuthToken("fake-refresh", new AbortController().signal)
    assert.equal(token.access, "fake-access")
    assert.equal(calls, 3)
  })

  it("gives up after the retry budget on persistent 5xx", async () => {
    tokenHandler = () => ({ status: 500, json: { error: "boom" } })
    await assert.rejects(
      refreshOAuthToken("fake-refresh", new AbortController().signal),
      /status 500/,
    )
    assert.equal(tokenBodies.length, 4) // initial + 3 retries
  })
})
