/**
 * Parsing and rendering for the Kimi Coding usage response.
 *
 * Source fields (all defensively optional — the endpoint is undocumented):
 * - `usages.limit_5h.used_ratio` / `reset_time`  → 5-hour rolling window
 * - `usages.limit_7d.used_ratio` / `reset_time`  → weekly quota (old plans)
 * - `limits[]` entry with a 300-minute window    → 5-hour absolute amounts
 * - `usage`                                       → weekly absolute amounts
 *
 * Missing fields render as `unavailable` (or are omitted); no zeros are
 * ever fabricated.
 */

export interface KimiWindowUsage {
  /** 0..1 ratio from the API; null when absent or malformed. */
  usedRatio: number | null
  used: number | null
  limit: number | null
  remaining: number | null
  /** Reset instant in epoch milliseconds; null when absent or malformed. */
  resetAt: number | null
}

export interface KimiUsageSnapshot {
  /** null when the 5-hour section is entirely absent from the response. */
  fiveHour: KimiWindowUsage | null
  /** null when limit_7d is absent (new plans have no weekly quota). */
  sevenDay: KimiWindowUsage | null
}

export type ResetFormat = "clock" | "date"

const BAR_WIDTH = 20
const BAR_FILLED = "█"
const BAR_EMPTY = "░"
const FIVE_HOUR_WINDOW_MINUTES = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Ratios must be finite and within 0..1; anything else is treated as absent. */
function parseRatio(value: unknown): number | null {
  const ratio = toNumber(value)
  return ratio !== null && ratio >= 0 && ratio <= 1 ? ratio : null
}

function parseAmount(value: unknown): number | null {
  const amount = toNumber(value)
  return amount !== null && amount >= 0 ? amount : null
}

function parseResetTime(value: unknown): number | null {
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim()
    const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
    if (!Number.isFinite(parsed) || parsed < 0) return null
    // Bare numbers may be epoch seconds or milliseconds.
    return parsed >= 1e12 ? parsed : /^\d+$/.test(trimmed) ? parsed * 1000 : parsed
  }
  const numeric = toNumber(value)
  if (numeric === null || numeric < 0) return null
  return numeric >= 1e12 ? numeric : numeric * 1000
}

/** Find the limits[] entry for the 300-minute (5-hour) rolling window. */
function findFiveHourDetail(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw) || !Array.isArray(raw.limits)) return null
  for (const entry of raw.limits) {
    if (!isRecord(entry) || !isRecord(entry.window) || !isRecord(entry.detail)) continue
    if (toNumber(entry.window.duration) === FIVE_HOUR_WINDOW_MINUTES) return entry.detail
  }
  return null
}

function buildWindow(ratios: unknown, absolutes: Record<string, unknown> | null): KimiWindowUsage {
  const section = isRecord(ratios) ? ratios : null
  return {
    usedRatio: parseRatio(section?.used_ratio),
    used: parseAmount(absolutes?.used),
    limit: parseAmount(absolutes?.limit),
    remaining: parseAmount(absolutes?.remaining),
    resetAt:
      parseResetTime(section?.reset_time) ??
      (absolutes ? parseResetTime(absolutes.resetTime) : null),
  }
}

export function parseKimiUsageResponse(raw: unknown): KimiUsageSnapshot {
  const root = isRecord(raw) ? raw : null
  const usages = isRecord(root?.usages) ? root.usages : null
  const fiveHourDetail = findFiveHourDetail(root)
  const weeklyAbsolutes = isRecord(root?.usage) ? root.usage : null

  // The 5-hour window exists on every plan; consider it present when either
  // its ratio section or its limits[] detail exists.
  const fiveHour =
    usages?.limit_5h !== undefined || fiveHourDetail !== null
      ? buildWindow(usages?.limit_5h, fiveHourDetail)
      : null
  // The weekly quota exists only on old plans; limit_7d absent means the
  // account has no weekly window, not zero usage. New plans may also return
  // a zero stub ({used_ratio: 0} with no reset time) — per plan §5.2 that is
  // treated as absent too. A genuine week start on an old plan reports
  // ratio 0 together with a valid reset time, which stays a real 0%.
  const sevenDayRaw = usages?.limit_7d
  let sevenDay: KimiWindowUsage | null = null
  if (sevenDayRaw !== undefined) {
    const window = buildWindow(sevenDayRaw, weeklyAbsolutes)
    const isZeroStub = window.usedRatio === 0 && window.resetAt === null
    sevenDay = isZeroStub ? null : window
  }

  return { fiveHour, sevenDay }
}

function progressBar(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * BAR_WIDTH)
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_WIDTH - filled)
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** Local-time reset label: HH:MM for the 5-hour window, MM-DD for weekly. */
export function formatResetTime(resetAtMs: number, format: ResetFormat): string {
  const date = new Date(resetAtMs)
  if (format === "clock") return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function windowLine(
  label: string,
  window: KimiWindowUsage | null,
  resetFormat: ResetFormat,
): string {
  const name = label.padEnd(6)
  if (!window || window.usedRatio === null) return `${name} unavailable`

  const percent = Math.round(window.usedRatio * 100)
  let line = `${name} ${progressBar(window.usedRatio)} ${percent}% used`
  if (window.remaining !== null && window.limit !== null) {
    line += ` · ${formatAmount(window.remaining)}/${formatAmount(window.limit)} remaining`
  }
  if (window.resetAt !== null) {
    line += ` · resets ${formatResetTime(window.resetAt, resetFormat)}`
  }
  return line
}

export function renderUsageLines(snapshot: KimiUsageSnapshot): string[] {
  const lines = [windowLine("5-hour", snapshot.fiveHour, "clock")]
  if (snapshot.sevenDay !== null) {
    lines.push(windowLine("7-day", snapshot.sevenDay, "date"))
  }
  return lines
}

export function renderUsageText(snapshot: KimiUsageSnapshot): string {
  return renderUsageLines(snapshot).join("\n")
}
