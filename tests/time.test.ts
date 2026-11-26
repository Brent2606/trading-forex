import { describe, expect, it } from 'vitest';
import { aggregate, bucketStart, type Candle } from '../src/core/candles';
import {
  HOUR,
  isFxOpen,
  isRollover,
  isSessionOpen,
  MIN,
  nextFxChange,
  nyOffsetMs,
  SESSION_MULT,
  SESSIONS,
  tradingDayKey,
  zonedParts,
} from '../src/core/time';

function intlNyOffset(t: number): number {
  const p = zonedParts(t, 'America/New_York');
  const d = new Date(t);
  let diff = (p.hour - d.getUTCHours()) * 60 + (p.minute - d.getUTCMinutes());
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  return diff * MIN;
}

describe('New York time', () => {
  it('matches the IANA tz database hourly across 2024–2028', () => {
    const start = Date.UTC(2024, 0, 1);
    const end = Date.UTC(2028, 11, 31);
    for (let t = start; t < end; t += HOUR) {
      expect(nyOffsetMs(t), new Date(t).toISOString()).toBe(intlNyOffset(t));
    }
  }, 30_000);

  it('switches at the documented 2026 instants', () => {
    // DST starts Sunday 8 March 2026 07:00 UTC, ends Sunday 1 Nov 2026 06:00 UTC
    expect(nyOffsetMs(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5 * HOUR);
    expect(nyOffsetMs(Date.UTC(2026, 2, 8, 7, 0))).toBe(-4 * HOUR);
    expect(nyOffsetMs(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4 * HOUR);
    expect(nyOffsetMs(Date.UTC(2026, 10, 1, 6, 0))).toBe(-5 * HOUR);
  });
});

describe('FX market hours', () => {
  it('closes Friday 17:00 New York in winter (22:00 UTC)', () => {
    expect(isFxOpen(Date.UTC(2026, 10, 27, 21, 59))).toBe(true);
    expect(isFxOpen(Date.UTC(2026, 10, 27, 22, 0))).toBe(false);
    expect(isFxOpen(Date.UTC(2026, 10, 28, 12, 0))).toBe(false); // Saturday
    expect(isFxOpen(Date.UTC(2026, 10, 29, 21, 59))).toBe(false); // Sunday before open
    expect(isFxOpen(Date.UTC(2026, 10, 29, 22, 0))).toBe(true); // Sunday 17:00 NY
  });

  it('closes Friday 17:00 New York in summer (21:00 UTC)', () => {
    expect(isFxOpen(Date.UTC(2026, 6, 10, 20, 59))).toBe(true);
    expect(isFxOpen(Date.UTC(2026, 6, 10, 21, 0))).toBe(false);
    expect(isFxOpen(Date.UTC(2026, 6, 12, 21, 0))).toBe(true);
  });

  it('is open midweek', () => {
    expect(isFxOpen(Date.UTC(2026, 10, 25, 3, 0))).toBe(true);
  });

  it('finds the next open/close', () => {
    expect(nextFxChange(Date.UTC(2026, 10, 27, 12, 30))).toBe(Date.UTC(2026, 10, 27, 22, 0));
    expect(nextFxChange(Date.UTC(2026, 10, 28, 12, 0))).toBe(Date.UTC(2026, 10, 29, 22, 0));
  });

  it('rolls the trading day at 17:00 New York', () => {
    const sunEve = Date.UTC(2026, 10, 29, 22, 0);
    const monNoon = Date.UTC(2026, 10, 30, 12, 0);
    const monEve = Date.UTC(2026, 10, 30, 22, 0);
    expect(tradingDayKey(sunEve)).toBe(tradingDayKey(monNoon));
    expect(tradingDayKey(monEve)).toBe(tradingDayKey(monNoon) + 1);
  });

  it('detects the rollover window', () => {
    expect(isRollover(Date.UTC(2026, 10, 25, 21, 50))).toBe(true); // 16:50 NY
    expect(isRollover(Date.UTC(2026, 10, 25, 22, 10))).toBe(true); // 17:10 NY
    expect(isRollover(Date.UTC(2026, 10, 25, 22, 20))).toBe(false);
    expect(isRollover(Date.UTC(2026, 10, 25, 23, 50))).toBe(false);
    expect(isRollover(Date.UTC(2026, 10, 25, 12, 0))).toBe(false);
  });

  it('normalises the intraday volatility profile', () => {
    const ms = SESSION_MULT.reduce((a, m) => a + m * m, 0) / 24;
    expect(ms).toBeCloseTo(1, 10);
  });
});

describe('sessions', () => {
  const byName = (n: string) => SESSIONS.find((s) => s.name === n)!;
  it('knows who is open on Wednesday 25 Nov 2026 09:00 UTC', () => {
    const t = Date.UTC(2026, 10, 25, 9, 0);
    expect(isSessionOpen(byName('LONDON'), t)).toBe(true); // 09:00 GMT
    expect(isSessionOpen(byName('TOKYO'), t)).toBe(false); // 18:00 JST (closed)
    expect(isSessionOpen(byName('NEW YORK'), t)).toBe(false); // 04:00 EST
    expect(isSessionOpen(byName('SYDNEY'), t)).toBe(false); // 20:00 AEDT
  });
  it('overlap London/New York at 14:00 UTC', () => {
    const t = Date.UTC(2026, 10, 25, 14, 0);
    expect(isSessionOpen(byName('LONDON'), t)).toBe(true);
    expect(isSessionOpen(byName('NEW YORK'), t)).toBe(true);
  });
  it('everything is closed on Saturday', () => {
    const t = Date.UTC(2026, 10, 28, 10, 0);
    for (const s of SESSIONS) expect(isSessionOpen(s, t)).toBe(false);
  });
});

describe('bar alignment', () => {
  it('aligns H4/D1 bars to the New York close', () => {
    // Winter: 17:00 NY = 22:00 UTC
    const t = Date.UTC(2026, 10, 25, 12, 34);
    expect(bucketStart(t, 'D1')).toBe(Date.UTC(2026, 10, 24, 22, 0));
    expect(bucketStart(t, 'H4')).toBe(Date.UTC(2026, 10, 25, 10, 0));
    expect(bucketStart(t, 'H1')).toBe(Date.UTC(2026, 10, 25, 12, 0));
    expect(bucketStart(t, 'M15')).toBe(Date.UTC(2026, 10, 25, 12, 30));
    // Summer: 17:00 NY = 21:00 UTC
    const s = Date.UTC(2026, 6, 15, 20, 30);
    expect(bucketStart(s, 'D1')).toBe(Date.UTC(2026, 6, 14, 21, 0));
  });

  it('aggregates OHLCV correctly', () => {
    const base = Date.UTC(2026, 10, 25, 12, 0);
    const m1: Candle[] = [
      { t: base, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 },
      { t: base + MIN, o: 1.5, h: 3, l: 1.2, c: 2.5, v: 4 },
      { t: base + 5 * MIN, o: 2.5, h: 2.6, l: 2.0, c: 2.1, v: 1 },
    ];
    const m5 = aggregate(m1, 'M5');
    expect(m5).toEqual([
      { t: base, o: 1, h: 3, l: 0.5, c: 2.5, v: 7 },
      { t: base + 5 * MIN, o: 2.5, h: 2.6, l: 2.0, c: 2.1, v: 1 },
    ]);
  });
});
