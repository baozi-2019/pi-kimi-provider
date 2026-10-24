/**
 * Unit tests for src/credentials.ts — hermetic, uses temp directories.
 * All keys are fabricated placeholders.
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { apiRoot, defaultAgentDir, getKimiApiKey } from "../src/credentials.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-kimi-provider-creds-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeAuth(contents: unknown): void {
  writeFileSync(join(dir, "auth.json"), JSON.stringify(contents))
}

describe("getKimiApiKey", () => {
  it("prefers the KIMI_API_KEY environment override", () => {
    writeAuth({ kimi: { type: "api_key", key: "sk-kimi-stored-fake" } })
    const key = getKimiApiKey({ env: { KIMI_API_KEY: "sk-kimi-env-fake" }, agentDir: dir })
    assert.equal(key, "sk-kimi-env-fake")
  })

  it("reads the kimi api_key entry from auth.json", () => {
    writeAuth({ kimi: { type: "api_key", key: "sk-kimi-stored-fake" } })
    assert.equal(getKimiApiKey({ env: {}, agentDir: dir }), "sk-kimi-stored-fake")
  })

  it("accepts an oauth access token as a Bearer credential", () => {
    writeAuth({ kimi: { type: "oauth", access: "kimi-oauth-fake-access" } })
    assert.equal(getKimiApiKey({ env: {}, agentDir: dir }), "kimi-oauth-fake-access")
  })

  it("never falls back to the built-in kimi-coding entry", () => {
    writeAuth({ "kimi-coding": { type: "api_key", key: "sk-kimi-coding-fake" } })
    assert.equal(getKimiApiKey({ env: {}, agentDir: dir }), undefined)
  })

  it("returns undefined when auth.json is missing", () => {
    assert.equal(getKimiApiKey({ env: {}, agentDir: dir }), undefined)
  })

  it("returns undefined when auth.json is corrupt", () => {
    writeFileSync(join(dir, "auth.json"), "{not json")
    assert.equal(getKimiApiKey({ env: {}, agentDir: dir }), undefined)
  })

  it("returns undefined when the kimi entry is absent or empty", () => {
    writeAuth({ other: { type: "api_key", key: "sk-other-fake" } })
    assert.equal(getKimiApiKey({ env: {}, agentDir: dir }), undefined)
    writeAuth({ kimi: { type: "api_key" } })
    assert.equal(getKimiApiKey({ env: {}, agentDir: dir }), undefined)
  })

  it("ignores a blank KIMI_API_KEY and falls back to auth.json", () => {
    writeAuth({ kimi: { type: "api_key", key: "sk-kimi-stored-fake" } })
    const key = getKimiApiKey({ env: { KIMI_API_KEY: "   " }, agentDir: dir })
    assert.equal(key, "sk-kimi-stored-fake")
  })
})

describe("defaultAgentDir", () => {
  it("honors PI_CODING_AGENT_DIR and falls back to ~/.pi/agent", () => {
    assert.equal(defaultAgentDir({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" }), "/tmp/custom-agent")
    const fallback = defaultAgentDir({})
    assert.match(fallback, /\.pi[/\\]agent$/)
  })
})

describe("apiRoot", () => {
  it("defaults to the China endpoint", () => {
    assert.equal(apiRoot({}), "https://api.kimi.com")
  })

  it("honors KIMI_API_BASE and strips trailing slashes", () => {
    assert.equal(apiRoot({ KIMI_API_BASE: "https://api.kimi.ai/" }), "https://api.kimi.ai")
    assert.equal(apiRoot({ KIMI_API_BASE: "http://127.0.0.1:8080//" }), "http://127.0.0.1:8080")
  })

  it("ignores a blank override", () => {
    assert.equal(apiRoot({ KIMI_API_BASE: "  " }), "https://api.kimi.com")
  })
})
