/**
 * Command-output regression tests for UI paths not exercised by RPC mode.
 * All credentials and API payloads are fabricated.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

import registerExtension from "../index.ts"

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1]

describe("/kimi-usage TUI output", () => {
  it("uses immediate notify instead of idle waits or queued custom messages", async () => {
    let usageHandler: CommandOptions["handler"] | undefined
    const notifications: { text: string; kind: string }[] = []
    const pi = {
      registerProvider() {},
      registerMessageRenderer() {},
      registerCommand(name: string, options: CommandOptions) {
        if (name === "kimi-usage") usageHandler = options.handler
      },
      sendMessage() {
        throw new Error("sendMessage would queue the result behind the active agent turn")
      },
    } as unknown as ExtensionAPI
    registerExtension(pi)
    assert.ok(usageHandler)

    const ctx = {
      mode: "tui",
      hasUI: true,
      waitForIdle() {
        throw new Error("usage must not wait for the main agent")
      },
      ui: {
        notify(text: string, kind: string) {
          notifications.push({ text, kind })
        },
      },
    } as unknown as ExtensionCommandContext

    const originalFetch = globalThis.fetch
    const originalApiKey = process.env.KIMI_API_KEY
    process.env.KIMI_API_KEY = "sk-kimi-fake-command-test"
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ usages: { limit_5h: { used_ratio: 0.5 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })

    try {
      await usageHandler("", ctx)
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0]?.kind, "info")
      assert.match(notifications[0]?.text ?? "", /5-hour .*50% used/)
    } finally {
      globalThis.fetch = originalFetch
      if (originalApiKey === undefined) delete process.env.KIMI_API_KEY
      else process.env.KIMI_API_KEY = originalApiKey
    }
  })
})
