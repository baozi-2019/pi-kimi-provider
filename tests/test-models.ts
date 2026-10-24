/**
 * Unit tests for src/models.ts — hermetic, fetch is injected where possible.
 * All keys and payloads are fabricated.
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import {
  buildModelsFromIds,
  fetchRemoteModelIds,
  getLastModelsRefresh,
  parseModelsResponse,
  refreshKimiModels,
  STATIC_KIMI_MODELS,
} from "../src/models.ts"

describe("static catalog", () => {
  it("contains the six documented model ids", () => {
    assert.deepEqual(
      STATIC_KIMI_MODELS.map((model) => model.id),
      [
        "k3.1-pro",
        "k3.1-pro-highspeed",
        "k3",
        "k3-256k",
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
      ],
    )
  })

  it("marks k3.1-pro thinking as non-disableable with low/high/max levels", () => {
    const model = STATIC_KIMI_MODELS.find((entry) => entry.id === "k3.1-pro")
    assert.equal(model?.reasoning, true)
    assert.equal(model?.thinkingLevelMap?.off, null)
    assert.equal(model?.thinkingLevelMap?.low, "low")
    assert.equal(model?.thinkingLevelMap?.high, "high")
    assert.equal(model?.thinkingLevelMap?.max, "max")
  })

  it("allows the documented off fallback for K3 and K2.8", () => {
    for (const id of ["k3", "k3-256k", "kimi-for-coding"]) {
      const model = STATIC_KIMI_MODELS.find((entry) => entry.id === id)
      assert.equal(model?.thinkingLevelMap?.off, "off", id)
    }
  })

  it("kimi-for-coding-highspeed leaves fixed thinking to upstream", () => {
    const model = STATIC_KIMI_MODELS.find((entry) => entry.id === "kimi-for-coding-highspeed")
    // pi must not expose/send an adjustable effort; upstream keeps Thinking:ON.
    assert.equal(model?.reasoning, false)
    assert.equal(model?.thinkingLevelMap, undefined)
  })

  it("never fabricates per-token costs (subscription quota)", () => {
    for (const model of STATIC_KIMI_MODELS) {
      assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    }
  })
})

describe("parseModelsResponse", () => {
  it("extracts ids from an OpenAI-style response", () => {
    const ids = parseModelsResponse({
      object: "list",
      data: [{ id: "k3.1-pro" }, { id: "k3" }],
    })
    assert.deepEqual(ids, ["k3.1-pro", "k3"])
  })

  it("accepts bare string entries and dedupes", () => {
    const ids = parseModelsResponse({ data: ["k3", { id: "k3" }, { id: " k3-256k " }] })
    assert.deepEqual(ids, ["k3", "k3-256k"])
  })

  it("returns null for malformed payloads", () => {
    assert.equal(parseModelsResponse(null), null)
    assert.equal(parseModelsResponse({}), null)
    assert.equal(parseModelsResponse({ data: [] }), null)
    assert.equal(parseModelsResponse({ data: [{ name: "no-id" }] }), null)
  })
})

describe("buildModelsFromIds", () => {
  it("reuses static definitions for known ids", () => {
    const models = buildModelsFromIds(["k3.1-pro"])
    assert.equal(models[0]?.name, "Kimi K3.1 Pro")
    assert.equal(models[0]?.contextWindow, 1_048_576)
  })

  it("gives unknown ids a conservative generic definition", () => {
    const models = buildModelsFromIds(["future-model"])
    assert.equal(models[0]?.id, "future-model")
    assert.equal(models[0]?.reasoning, false)
    assert.deepEqual(models[0]?.input, ["text"])
  })
})

describe("fetchRemoteModelIds", () => {
  const key = "sk-kimi-fake-test-key"

  it("GETs {baseUrl}/models with a Bearer header", async () => {
    let seenUrl = ""
    let seenAuth = ""
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      seenUrl = String(input)
      seenAuth = new Headers(init?.headers).get("authorization") ?? ""
      return new Response(JSON.stringify({ data: [{ id: "k3" }] }), { status: 200 })
    }
    const result = await fetchRemoteModelIds({
      apiKey: key,
      baseUrl: "https://api.kimi.com/coding/v1",
      fetchImpl,
    })
    assert.deepEqual(result, { ok: true, ids: ["k3"] })
    assert.equal(seenUrl, "https://api.kimi.com/coding/v1/models")
    assert.equal(seenAuth, `Bearer ${key}`)
  })

  it("reports HTTP failures without the key", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("nope", { status: 404 })
    const result = await fetchRemoteModelIds({
      apiKey: key,
      baseUrl: "https://api.kimi.com/coding/v1",
      fetchImpl,
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /404/)
    assert.doesNotMatch(result.message, new RegExp(key))
  })

  it("reports unreadable payloads", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    const result = await fetchRemoteModelIds({
      apiKey: key,
      baseUrl: "https://api.kimi.com/coding/v1",
      fetchImpl,
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.message, /unreadable/)
  })

  it("redacts the key from network error messages", async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error(`connect failed for ${key}`)
    }
    const result = await fetchRemoteModelIds({
      apiKey: key,
      baseUrl: "https://api.kimi.com/coding/v1",
      fetchImpl,
    })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.doesNotMatch(result.message, new RegExp(key))
  })

  it("honors caller cancellation separately from the timeout", async () => {
    const controller = new AbortController()
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    const pending = fetchRemoteModelIds({
      apiKey: key,
      baseUrl: "https://api.kimi.com/coding/v1",
      fetchImpl,
      signal: controller.signal,
    })
    controller.abort()
    const result = await pending
    assert.deepEqual(result, { ok: false, message: "model refresh aborted" })
  })
})

describe("refreshKimiModels", () => {
  let dir: string
  let savedAgentDir: string | undefined
  let savedApiKey: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-kimi-provider-models-"))
    savedAgentDir = process.env.PI_CODING_AGENT_DIR
    savedApiKey = process.env.KIMI_API_KEY
    process.env.PI_CODING_AGENT_DIR = dir
    delete process.env.KIMI_API_KEY
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir
    if (savedApiKey === undefined) delete process.env.KIMI_API_KEY
    else process.env.KIMI_API_KEY = savedApiKey
  })

  it("returns the static catalog without network access", async () => {
    const models = await refreshKimiModels({
      allowNetwork: false,
      signal: new AbortController().signal,
    })
    assert.deepEqual(
      models.map((model) => model.id),
      STATIC_KIMI_MODELS.map((model) => model.id),
    )
    assert.equal(getLastModelsRefresh()?.source, "offline")
  })

  it("keeps the static catalog when no credential exists", async () => {
    delete process.env.KIMI_API_KEY
    const models = await refreshKimiModels({
      allowNetwork: true,
      signal: new AbortController().signal,
    })
    assert.deepEqual(
      models.map((model) => model.id),
      STATIC_KIMI_MODELS.map((model) => model.id),
    )
    const state = getLastModelsRefresh()
    assert.equal(state?.source, "static")
    assert.match(state?.error ?? "", /no credential/)
  })

  it("uses the pi-resolved credential when provided", async () => {
    // No KIMI_API_KEY, no auth.json for `kimi`: only context.credential can
    // authenticate. Point KIMI_API_BASE at a local mock to serve /models.
    const { createServer } = await import("node:http")
    const server = createServer((req, res) => {
      if (req.url === "/coding/v1/models" && req.headers.authorization === "Bearer ctx-token") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data: [{ id: "k3.1-pro" }, { id: "brand-new-model" }] }))
        return
      }
      res.writeHead(401)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    process.env.KIMI_API_BASE = `http://127.0.0.1:${port}`
    try {
      const models = await refreshKimiModels({
        allowNetwork: true,
        credential: { type: "oauth", access: "ctx-token" },
        signal: new AbortController().signal,
      })
      assert.deepEqual(
        models.map((model) => model.id),
        ["k3.1-pro", "brand-new-model"],
      )
      assert.equal(getLastModelsRefresh()?.source, "remote")
    } finally {
      delete process.env.KIMI_API_BASE
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("falls back to the static catalog when the endpoint fails", async () => {
    const { createServer } = await import("node:http")
    const server = createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    process.env.KIMI_API_BASE = `http://127.0.0.1:${port}`
    process.env.KIMI_API_KEY = "sk-kimi-fake-test-key"
    try {
      const models = await refreshKimiModels({
        allowNetwork: true,
        signal: new AbortController().signal,
      })
      assert.deepEqual(
        models.map((model) => model.id),
        STATIC_KIMI_MODELS.map((model) => model.id),
      )
      const state = getLastModelsRefresh()
      assert.equal(state?.source, "static")
      assert.match(state?.error ?? "", /404/)
    } finally {
      delete process.env.KIMI_API_BASE
      delete process.env.KIMI_API_KEY
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("prefers context.baseUrl over the default root", async () => {
    const { createServer } = await import("node:http")
    let seenUrl = ""
    const server = createServer((req, res) => {
      seenUrl = req.url ?? ""
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "k3" }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    process.env.KIMI_API_KEY = "sk-kimi-fake-test-key"
    try {
      await refreshKimiModels({
        allowNetwork: true,
        baseUrl: `http://127.0.0.1:${port}/coding/v1`,
        signal: new AbortController().signal,
      })
      assert.equal(seenUrl, "/coding/v1/models")
    } finally {
      delete process.env.KIMI_API_KEY
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it("does not overwrite the last refresh state after caller cancellation", async () => {
    const { createServer } = await import("node:http")
    let markRequestSeen: (() => void) | undefined
    const requestSeen = new Promise<void>((resolve) => {
      markRequestSeen = resolve
    })
    const server = createServer((req, res) => {
      markRequestSeen?.()
      req.on("close", () => res.end())
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const before = getLastModelsRefresh()
    const controller = new AbortController()
    try {
      const pending = refreshKimiModels({
        allowNetwork: true,
        baseUrl: `http://127.0.0.1:${port}/coding/v1`,
        credential: { type: "api_key", key: "sk-kimi-fake-test-key" },
        signal: controller.signal,
      })
      await requestSeen
      controller.abort()
      const models = await pending
      assert.deepEqual(
        models.map((model) => model.id),
        STATIC_KIMI_MODELS.map((model) => model.id),
      )
      assert.equal(getLastModelsRefresh(), before)
    } finally {
      controller.abort()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
