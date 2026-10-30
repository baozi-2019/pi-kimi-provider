/**
 * Unit tests for src/render.ts — fixture-driven, hermetic, no network.
 * All payloads are fabricated; no real credentials or account data.
 */

// Pin UTC so reset-time formatting assertions are timezone independent.
process.env.TZ = "UTC"

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  formatResetTime,
  parseKimiUsageResponse,
  renderUsageLines,
  renderUsageText,
} from "../src/render.ts"

const FULL_RESPONSE = {
  usage: {
    limit: "100",
    used: "12",
    remaining: "88",
    resetTime: "2026-09-26T05:22:45Z",
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        used: "32",
        remaining: "68",
        resetTime: "2026-09-19T12:22:45Z",
      },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0.320641, reset_time: "2026-09-19T12:22:45Z" },
    limit_7d: { used_ratio: 0.115123, reset_time: "2026-09-26T05:22:45Z" },
  },
}

describe("parseKimiUsageResponse", () => {
  it("parses a full response with both windows", () => {
    const snapshot = parseKimiUsageResponse(FULL_RESPONSE)
    assert.equal(snapshot.fiveHour?.usedRatio, 0.320641)
    assert.equal(snapshot.fiveHour?.remaining, 68)
    assert.equal(snapshot.fiveHour?.limit, 100)
    assert.equal(snapshot.fiveHour?.resetAt, Date.parse("2026-09-19T12:22:45Z"))
    assert.equal(snapshot.sevenDay?.usedRatio, 0.115123)
    assert.equal(snapshot.sevenDay?.remaining, 88)
    assert.equal(snapshot.sevenDay?.limit, 100)
    assert.equal(snapshot.sevenDay?.resetAt, Date.parse("2026-09-26T05:22:45Z"))
  })

  it("marks the 7-day window absent when limit_7d is missing (new plans)", () => {
    const snapshot = parseKimiUsageResponse({
      usages: { limit_5h: { used_ratio: 0.5, reset_time: "2026-09-19T12:22:45Z" } },
      limits: FULL_RESPONSE.limits,
    })
    assert.equal(snapshot.fiveHour?.usedRatio, 0.5)
    assert.equal(snapshot.sevenDay, null)
  })

  it("treats a zero-stub limit_7d as absent rather than 0% used", () => {
    const snapshot = parseKimiUsageResponse({
      usages: {
        limit_5h: { used_ratio: 0.5 },
        limit_7d: { used_ratio: 0, reset_time: null },
      },
    })
    // New plans may return a zero stub: ratio 0 with no reset time means the
    // account has no weekly window at all (plan §5.2).
    assert.equal(snapshot.sevenDay, null)
  })

  it("keeps a genuine zero ratio with a valid reset time (old-plan week start)", () => {
    const snapshot = parseKimiUsageResponse({
      usages: {
        limit_5h: { used_ratio: 0.5 },
        limit_7d: { used_ratio: 0, reset_time: "2026-09-26T05:22:45Z" },
      },
    })
    assert.equal(snapshot.sevenDay?.usedRatio, 0)
    assert.notEqual(snapshot.sevenDay?.resetAt, null)
  })

  it("never fabricates values for missing or malformed fields", () => {
    const snapshot = parseKimiUsageResponse({
      usages: {
        limit_5h: { used_ratio: "not-a-number" },
        limit_7d: {},
      },
      usage: { limit: "soon", used: null },
      limits: [{ window: { duration: "300" }, detail: { limit: "100" } }],
    })
    assert.equal(snapshot.fiveHour?.usedRatio, null)
    assert.equal(snapshot.fiveHour?.limit, 100)
    assert.equal(snapshot.fiveHour?.used, null)
    assert.equal(snapshot.fiveHour?.remaining, null)
    assert.equal(snapshot.fiveHour?.resetAt, null)
    assert.equal(snapshot.sevenDay?.usedRatio, null)
    assert.equal(snapshot.sevenDay?.limit, null)
    assert.equal(snapshot.sevenDay?.resetAt, null)
  })

  it("rejects out-of-range ratios", () => {
    const snapshot = parseKimiUsageResponse({
      usages: { limit_5h: { used_ratio: 1.5 }, limit_7d: { used_ratio: -0.2 } },
    })
    assert.equal(snapshot.fiveHour?.usedRatio, null)
    assert.equal(snapshot.sevenDay?.usedRatio, null)
  })

  it("accepts numeric strings for ratios", () => {
    const snapshot = parseKimiUsageResponse({
      usages: { limit_5h: { used_ratio: "0.25" } },
    })
    assert.equal(snapshot.fiveHour?.usedRatio, 0.25)
  })

  it("picks the 300-minute entry from limits[] and ignores others", () => {
    const snapshot = parseKimiUsageResponse({
      usages: { limit_5h: { used_ratio: 0.1 } },
      limits: [
        {
          window: { duration: 60, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "5", used: "1", remaining: "4" },
        },
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "10", remaining: "90" },
        },
      ],
    })
    assert.equal(snapshot.fiveHour?.limit, 100)
    assert.equal(snapshot.fiveHour?.remaining, 90)
  })

  it("handles a completely empty payload", () => {
    const snapshot = parseKimiUsageResponse({})
    assert.equal(snapshot.fiveHour, null)
    assert.equal(snapshot.sevenDay, null)
    const alsoEmpty = parseKimiUsageResponse(undefined)
    assert.equal(alsoEmpty.fiveHour, null)
  })
})

describe("renderUsageText", () => {
  it("renders both windows in the documented format", () => {
    const text = renderUsageText(parseKimiUsageResponse(FULL_RESPONSE))
    assert.equal(
      text,
      "5-hour ██████░░░░░░░░░░░░░░ 32% used · 68/100 remaining · resets 2026-09-19 12:22\n" +
        "7-day  ██░░░░░░░░░░░░░░░░░░ 12% used · 88/100 remaining · resets 2026-09-26 05:22",
    )
  })

  it("renders only the 5-hour line when limit_7d is missing", () => {
    const snapshot = parseKimiUsageResponse({
      usages: { limit_5h: { used_ratio: 0.320641, reset_time: "2026-09-19T12:22:45Z" } },
      limits: FULL_RESPONSE.limits,
    })
    const lines = renderUsageLines(snapshot)
    assert.equal(lines.length, 1)
    assert.equal(
      lines[0],
      "5-hour ██████░░░░░░░░░░░░░░ 32% used · 68/100 remaining · resets 2026-09-19 12:22",
    )
  })

  it("shows unavailable instead of fabricating a zero bar", () => {
    const text = renderUsageText(
      parseKimiUsageResponse({
        usages: { limit_5h: {}, limit_7d: { used_ratio: null } },
      }),
    )
    const lines = text.split("\n")
    assert.equal(lines[0], "5-hour unavailable")
    assert.equal(lines[1], "7-day  unavailable")
    assert.doesNotMatch(text, /0% used/)
  })

  it("shows unavailable for both windows on an empty payload", () => {
    const text = renderUsageText(parseKimiUsageResponse({}))
    assert.equal(text, "5-hour unavailable")
  })

  it("omits the remaining/reset segments when only the ratio is known", () => {
    const text = renderUsageText(
      parseKimiUsageResponse({ usages: { limit_5h: { used_ratio: 0.5 } } }),
    )
    assert.equal(text, `5-hour ██████████░░░░░░░░░░ 50% used`)
  })

  it("omits only the missing segments", () => {
    const text = renderUsageText(
      parseKimiUsageResponse({
        usages: { limit_5h: { used_ratio: 0.5 } },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", used: "32", remaining: "68" },
          },
        ],
      }),
    )
    assert.equal(text, "5-hour ██████████░░░░░░░░░░ 50% used · 68/100 remaining")
  })
})

describe("formatResetTime", () => {
  it("formats as yyyy-MM-dd HH:mm (local time)", () => {
    const at = Date.parse("2026-09-26T05:07:45Z")
    assert.equal(formatResetTime(at), "2026-09-26 05:07")
  })
})
