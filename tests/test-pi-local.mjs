#!/usr/bin/env node
/**
 * Local end-to-end test: loads the real extension through the pi CLI in an
 * isolated HOME while the Kimi usage and models endpoints are replaced by a
 * deterministic local mock server. All keys and payloads are fabricated.
 *
 * Skips automatically when pi is not on PATH; set PI_LOCAL_REQUIRED=1 to turn
 * the skip into a failure (CI).
 */

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(__dirname, "..")
const EXT_PATH = resolve(PROJECT_DIR, "index.ts")
const FAKE_KEY = "sk-kimi-e2e-fake-key"

function findPiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN
  const localBin = resolve(PROJECT_DIR, "node_modules", ".bin")
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => resolve(entry, "pi"))
    .filter((candidate) => !candidate.startsWith(localBin))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try next PATH entry.
    }
  }
  return undefined
}

const PI_BIN = findPiBinary()
if (!PI_BIN) {
  if (process.env.PI_LOCAL_REQUIRED === "1") {
    console.error("[pi-local] FAIL - pi is required but not on PATH and PI_BIN is unset")
    process.exit(1)
  }
  console.log("[pi-local] SKIP — pi is not on PATH")
  process.exit(0)
}

const piCheck = spawnSync(PI_BIN, ["--help"], { stdio: "ignore" })
if (piCheck.error) {
  if (process.env.PI_LOCAL_REQUIRED === "1") {
    console.error(`[pi-local] FAIL - pi failed to start: ${piCheck.error.message}`)
    process.exit(1)
  }
  console.log(`[pi-local] SKIP — pi failed to start: ${piCheck.error.message}`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Mock Kimi endpoints. `scenario` switches the fabricated usage response;
// /coding/v1/models always returns the same small remote catalog.
// ---------------------------------------------------------------------------

let scenario = "full"
let usageRequestCount = 0
let modelsRequestCount = 0
let chatRequestCount = 0
let lastAuthorization = ""
let lastChatPayload

const FULL_RESPONSE = {
  usage: { limit: "100", used: "12", remaining: "88", resetTime: "2026-09-26T05:22:45Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "32", remaining: "68", resetTime: "2026-09-19T12:22:45Z" },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0.320641, reset_time: "2026-09-19T12:22:45Z" },
    limit_7d: { used_ratio: 0.115123, reset_time: "2026-09-26T05:22:45Z" },
  },
}

const NO_7D_RESPONSE = {
  limits: FULL_RESPONSE.limits,
  usages: { limit_5h: { used_ratio: 0.320641, reset_time: "2026-09-19T12:22:45Z" } },
}

const REMOTE_MODELS = {
  object: "list",
  data: [{ id: "k3.1-pro" }, { id: "kimi-for-coding" }, { id: "brand-new-model" }],
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname
  if (req.method === "GET" && pathname === "/coding/v1/usages") {
    usageRequestCount += 1
    lastAuthorization = req.headers.authorization ?? ""
    if (scenario === "unauthorized") {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(scenario === "no7d" ? NO_7D_RESPONSE : FULL_RESPONSE))
    return
  }
  if (req.method === "POST" && pathname === "/coding/v1/responses") {
    chatRequestCount += 1
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      lastChatPayload = JSON.parse(body)
    })
    // Keep the model response pending until the test aborts the agent run.
    return
  }
  if (req.method === "GET" && pathname === "/coding/v1/models") {
    modelsRequestCount += 1
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(REMOTE_MODELS))
    return
  }
  res.writeHead(404)
  res.end("Not found")
})

await new Promise((resolve) => server.listen(0, resolve))
const address = server.address()
const port = typeof address === "object" && address ? address.port : 0
const apiBase = `http://127.0.0.1:${port}`

const tempHome = mkdtempSync(join(tmpdir(), "pi-kimi-provider-home-"))
const agentDir = join(tempHome, "custom-pi-agent")
mkdirSync(agentDir, { recursive: true })
writeFileSync(
  join(agentDir, "auth.json"),
  JSON.stringify({ kimi: { type: "api_key", key: FAKE_KEY } }),
)

const env = {
  ...process.env,
  HOME: tempHome,
  USERPROFILE: tempHome,
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: join(tempHome, "sessions"),
  KIMI_API_BASE: apiBase,
}
delete env.KIMI_API_KEY

// ---------------------------------------------------------------------------
// RPC session helper: drives an isolated pi instance over the JSON protocol.
// ---------------------------------------------------------------------------

function startRpcSession(timeoutMs = 30_000) {
  const child = spawn(PI_BIN, ["--no-extensions", "--mode", "rpc", "-e", EXT_PATH], {
    cwd: PROJECT_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })

  let buffer = ""
  let stderr = ""
  const events = []
  const waiters = []

  const publish = (event) => {
    events.push(event)
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (!waiter.predicate(event)) continue
      waiters.splice(index, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(event)
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8")
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        publish(JSON.parse(line))
      } catch {
        // Ignore non-JSON output.
      }
    }
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf-8")
  })

  const waitFor = (predicate, fromIndex = 0) =>
    new Promise((resolve, reject) => {
      const existing = events.slice(fromIndex).find(predicate)
      if (existing) {
        resolve(existing)
        return
      }
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`RPC event timeout. stderr: ${stderr.slice(-500)}`))
      }, timeoutMs)
      waiters.push({ predicate, resolve, timer })
    })

  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`)

  const runCommand = async (id, command) => {
    const fromIndex = events.length
    send({ id, type: "prompt", message: command })
    await waitFor((event) => event.type === "response" && event.id === id && event.success)
    return waitFor(
      (event) => event.type === "extension_ui_request" && event.method === "notify",
      fromIndex,
    )
  }

  return {
    send,
    waitFor,
    runCommand,
    stderr: () => stderr,
    eventCount: () => events.length,
    close: () => child.kill(),
  }
}

const isNotify = (text) => (event) =>
  event.type === "extension_ui_request" &&
  event.method === "notify" &&
  typeof event.message === "string" &&
  event.message.includes(text)

async function waitForCondition(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the mock server state")
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

try {
  // -- Session 1: full fixture, command registration, throttle -------------
  console.log("[pi-local] /kimi-usage renders both windows through the real extension")
  scenario = "full"
  const first = startRpcSession()

  first.send({ id: "commands", type: "get_commands" })
  const commandsResponse = await first.waitFor(
    (event) => event.type === "response" && event.id === "commands",
  )
  const commandNames = commandsResponse.data?.commands?.map((command) => command.name) ?? []
  assert.ok(commandNames.includes("kimi-usage"), JSON.stringify(commandNames))
  assert.ok(commandNames.includes("kimi-refresh"), JSON.stringify(commandNames))

  console.log("[pi-local] the kimi provider exposes its six static models")
  first.send({ id: "models", type: "get_available_models" })
  const modelsResponse = await first.waitFor(
    (event) => event.type === "response" && event.id === "models",
  )
  const kimiModels = (modelsResponse.data?.models ?? []).filter((m) => m.provider === "kimi")
  assert.deepEqual(
    kimiModels.map((m) => m.id),
    [
      "k3.1-pro",
      "k3.1-pro-highspeed",
      "k3",
      "k3-256k",
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
    ],
  )
  assert.ok(kimiModels.every((m) => m.api === "openai-responses"))

  usageRequestCount = 0
  const full = await first.runCommand("usage-1", "/kimi-usage")
  assert.match(full.message, /5-hour █+░+ 32% used · 68\/100 remaining · resets \d{2}:\d{2}/)
  assert.match(full.message, /7-day\s+█+░+ 12% used · 88\/100 remaining · resets \d{2}-\d{2}/)
  assert.equal(lastAuthorization, `Bearer ${FAKE_KEY}`)
  assert.equal(usageRequestCount, 1)

  console.log("[pi-local] a repeat within 5s is throttled without a new request")
  const throttled = await first.runCommand("usage-2", "/kimi-usage")
  assert.match(throttled.message, /wait \ds before checking again/i)
  assert.equal(usageRequestCount, 1)

  console.log("[pi-local] /kimi-refresh applies the remote model list")
  modelsRequestCount = 0
  const refreshed = await first.runCommand("refresh-1", "/kimi-refresh")
  assert.match(refreshed.message, /refreshed from server/)
  assert.match(refreshed.message, /brand-new-model/)
  assert.match(refreshed.message, /added: brand-new-model/)
  assert.match(refreshed.message, /removed: .*k3/)
  assert.ok(modelsRequestCount >= 1)
  first.send({ id: "models-after-refresh", type: "get_available_models" })
  const refreshedModelsResponse = await first.waitFor(
    (event) => event.type === "response" && event.id === "models-after-refresh",
  )
  const refreshedKimiModels = (refreshedModelsResponse.data?.models ?? []).filter(
    (m) => m.provider === "kimi",
  )
  assert.deepEqual(
    refreshedKimiModels.map((m) => m.id),
    ["k3.1-pro", "kimi-for-coding", "brand-new-model"],
  )
  first.close()

  // -- Session 2: new-plan fixture without limit_7d -------------------------
  console.log("[pi-local] missing limit_7d renders only the 5-hour line")
  scenario = "no7d"
  const second = startRpcSession()
  const no7d = await second.runCommand("usage-no7d", "/kimi-usage")
  assert.match(no7d.message, /5-hour █+░+ 32% used/)
  assert.doesNotMatch(no7d.message, /7-day/)
  second.close()

  // -- Session 3: 401 from the endpoint --------------------------------------
  console.log("[pi-local] a 401 surfaces a clear error notification")
  scenario = "unauthorized"
  const third = startRpcSession()
  const unauthorized = await third.runCommand("usage-401", "/kimi-usage")
  assert.equal(
    unauthorized.notifyType,
    "error",
    `expected an error-level notification, got fields: ${Object.keys(unauthorized).join(",")}`,
  )
  assert.match(unauthorized.message, /401/)
  assert.match(unauthorized.message, /rejected the API key/i)
  third.close()

  // -- Session 4: query while the main agent request is still pending --------
  console.log("[pi-local] /kimi-usage runs while the main agent is busy")
  scenario = "full"
  const fourth = startRpcSession()
  fourth.send({
    id: "set-fixed-thinking-model",
    type: "set_model",
    provider: "kimi",
    modelId: "kimi-for-coding-highspeed",
  })
  const modelSet = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "set-fixed-thinking-model",
  )
  assert.equal(modelSet.success, true)

  fourth.send({ id: "fixed-thinking-levels", type: "get_available_thinking_levels" })
  const fixedThinkingLevels = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "fixed-thinking-levels",
  )
  assert.deepEqual(fixedThinkingLevels.data?.levels, ["off"])

  const previousChatRequestCount = chatRequestCount
  fourth.send({ id: "busy-prompt", type: "prompt", message: "hold the response open" })
  const busyPrompt = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "busy-prompt",
  )
  assert.equal(busyPrompt.success, true)
  await waitForCondition(
    () => chatRequestCount === previousChatRequestCount + 1 && lastChatPayload !== undefined,
  )
  assert.equal(lastChatPayload.reasoning, undefined)

  usageRequestCount = 0
  const duringBusyRun = await fourth.runCommand("usage-busy", "/kimi-usage")
  assert.match(duringBusyRun.message, /5-hour █+░+ 32% used/)
  assert.equal(usageRequestCount, 1)
  assert.equal(chatRequestCount, previousChatRequestCount + 1)

  const abortEventIndex = fourth.eventCount()
  fourth.send({ id: "abort-busy", type: "abort" })
  await fourth.waitFor(
    (event) => event.type === "response" && event.id === "abort-busy" && event.success,
  )
  await fourth.waitFor((event) => event.type === "agent_settled", abortEventIndex)

  console.log("[pi-local] K2.8 think:off sends the Kimi-supported off effort")
  fourth.send({
    id: "set-adjustable-model",
    type: "set_model",
    provider: "kimi",
    modelId: "kimi-for-coding",
  })
  const adjustableModelSet = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "set-adjustable-model",
  )
  assert.equal(adjustableModelSet.success, true)
  fourth.send({ id: "set-thinking-off", type: "set_thinking_level", level: "off" })
  const thinkingOffSet = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "set-thinking-off",
  )
  assert.equal(thinkingOffSet.success, true)

  lastChatPayload = undefined
  const previousOffRequestCount = chatRequestCount
  fourth.send({ id: "off-prompt", type: "prompt", message: "inspect the off effort" })
  const offPrompt = await fourth.waitFor(
    (event) => event.type === "response" && event.id === "off-prompt",
  )
  assert.equal(offPrompt.success, true)
  await waitForCondition(
    () => chatRequestCount === previousOffRequestCount + 1 && lastChatPayload !== undefined,
  )
  assert.equal(lastChatPayload.reasoning?.effort, "off")

  const abortOffEventIndex = fourth.eventCount()
  fourth.send({ id: "abort-off", type: "abort" })
  await fourth.waitFor(
    (event) => event.type === "response" && event.id === "abort-off" && event.success,
  )
  await fourth.waitFor((event) => event.type === "agent_settled", abortOffEventIndex)
  fourth.close()

  // -- No credential leaks anywhere ------------------------------------------
  const combined = [first, second, third, fourth].map((session) => session.stderr()).join("\n")
  assert.doesNotMatch(combined, new RegExp(FAKE_KEY))

  console.log("[pi-local] PASS")
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(tempHome, { recursive: true, force: true })
}
