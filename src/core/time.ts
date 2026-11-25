export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Day-of-month of the nth (1-based) Sunday of a UTC month. */
function nthSunday(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstDow) % 7);
  return firstSunday + (n - 1) * 7;
}

const dstCache = new Map<number, [number, number]>();

/** US daylight saving: 2nd Sunday of March 02:00 EST to 1st Sunday of November 02:00 EDT. */
function usDstRange(year: number): [number, number] {
  let r = dstCache.get(year);
  if (!r) {
    const start = Date.UTC(year, 2, nthSunday(year, 2, 2), 7); // 02:00 EST = 07:00 UTC
    const end = Date.UTC(year, 10, nthSunday(year, 10, 1), 6); // 02:00 EDT = 06:00 UTC
    r = [start, end];
    dstCache.set(year, r);
  }
  return r;
}

/** UTC offset of New York at instant t, in ms (-4h during DST, otherwise -5h). */
export function nyOffsetMs(t: number): number {
  const [s, e] = usDstRange(new Date(t).getUTCFullYear());
  return t >= s && t < e ? -4 * HOUR : -5 * HOUR;
}

/**
 * The spot FX market trades from Sunday 17:00 to Friday 17:00 New York time.
 * The trading day rolls over at 17:00 New York time.
 */
export function isFxOpen(t: number): boolean {
  const local = t + nyOffsetMs(t);
  const dow = (Math.floor(local / DAY) + 4) % 7; // 1970-01-01 was a Thursday (4)
  const h = Math.floor((((local % DAY) + DAY) % DAY) / HOUR);
  if (dow === 6) return false;
  if (dow === 5 && h >= 17) return false;
  if (dow === 0 && h < 17) return false;
  return true;
}

/** Integer key of the FX trading day containing t (rolls over at 17:00 New York). */
export function tradingDayKey(t: number): number {
  return Math.floor((t + nyOffsetMs(t) + 7 * HOUR) / DAY);
}

/**
 * A timestamp whose UTC calendar date is the FX trading day of t
 * (e.g. Sunday 17:00 NY onwards belongs to Monday).
 */
export function tradingDayDate(t: number): number {
  return t + nyOffsetMs(t) + 7 * HOUR;
}

/** Next instant (on an hour boundary, at or after t) when isFxOpen() flips. */
export function nextFxChange(t: number): number {
  const open = isFxOpen(t);
  let h = Math.ceil(t / HOUR) * HOUR;
  if (h === t) h += HOUR;
  for (let i = 0; i < 24 * 8; i++, h += HOUR) {
    if (isFxOpen(h) !== open) return h;
  }
  return h;
}

/**
 * Intraday liquidity profile by UTC hour. Normalised so that the mean squared
 * multiplier over a day is 1, which keeps the simulator's daily volatility on target.
 */
const RAW_SESSION_MULT = [
  0.75, 0.8, 0.8, 0.75, 0.7, 0.7, 0.8, 1.05, 1.2, 1.2, 1.1, 1.05, 1.25, 1.45, 1.45, 1.35, 1.15, 0.95, 0.85,
  0.75, 0.65, 0.5, 0.5, 0.65,
];
const NORM = Math.sqrt(RAW_SESSION_MULT.reduce((a, m) => a + m * m, 0) / 24);
export const SESSION_MULT = RAW_SESSION_MULT.map((m) => m / NORM);

export function sessionMultiplier(t: number): number {
  const h = Math.floor((((t % DAY) + DAY) % DAY) / HOUR);
  return SESSION_MULT[h];
}

/** True within ±15 minutes of the 17:00 New York rollover, when spreads widen. */
export function isRollover(t: number): boolean {
  const local = t + nyOffsetMs(t);
  const minOfDay = Math.floor((((local % DAY) + DAY) % DAY) / MIN);
  return minOfDay >= 16 * 60 + 45 && minOfDay < 17 * 60 + 15;
}

// ---------------------------------------------------------------------------
// Trading sessions (Sydney, Tokyo, London, New York) using real time zones.
// ---------------------------------------------------------------------------

export interface SessionDef {
  name: string;
  city: string;
  tz: string;
  /** Local opening hour (inclusive). */
  open: number;
  /** Local closing hour (exclusive). */
  close: number;
}

export const SESSIONS: readonly SessionDef[] = [
  { name: 'SYDNEY', city: 'Sydney', tz: 'Australia/Sydney', open: 7, close: 16 },
  { name: 'TOKYO', city: 'Tokyo', tz: 'Asia/Tokyo', open: 9, close: 18 },
  { name: 'LONDON', city: 'London', tz: 'Europe/London', open: 8, close: 17 },
  { name: 'NEW YORK', city: 'New York', tz: 'America/New_York', open: 8, close: 17 },
];

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday (0=Sun), hour and minute of instant t in time zone tz. */
export function zonedParts(t: number, tz: string): { dow: number; hour: number; minute: number } {
  let dow = 0;
  let hour = 0;
  let minute = 0;
  for (const p of zoneFormatter(tz).formatToParts(new Date(t))) {
    if (p.type === 'weekday') dow = DOW[p.value] ?? 0;
    else if (p.type === 'hour') hour = Number(p.value) % 24;
    else if (p.type === 'minute') minute = Number(p.value);
  }
  return { dow, hour, minute };
}

export function isSessionOpen(s: SessionDef, t: number): boolean {
  if (!isFxOpen(t)) return false;
  const { dow, hour } = zonedParts(t, s.tz);
  if (dow === 0 || dow === 6) return false;
  return hour >= s.open && hour < s.close;
}

/** Next instant (hour boundary) when the session's open/closed state changes. */
export function nextSessionChange(s: SessionDef, t: number): number {
  const open = isSessionOpen(s, t);
  let h = Math.ceil(t / HOUR) * HOUR;
  if (h === t) h += HOUR;
  for (let i = 0; i < 24 * 8; i++, h += HOUR) {
    if (isSessionOpen(s, h) !== open) return h;
  }
  return h;
}
