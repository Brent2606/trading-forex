import { describe, expect, it } from 'vitest';
import { SESSION_WINDOW_H, sessionRange, STRATEGIES } from '../src/core/backtest';
import { explainEntry } from '../src/core/explain';
import { ALL_SESSIONS, describeGenome, normalize, randomGenome, SEARCH, strategyById, type Genome } from '../src/core/genome';
import { Rng } from '../src/core/rng';
import { bar, fromCloses } from './helpers';

const H = 3_600_000;
const base: Omit<Genome, 'strategy' | 'params'> = { slAtr: 2, tpAtr: 3, trend: 0, exitOnOpposite: false, sessions: ALL_SESSIONS, vol: 0 };
const sig = (id: string, c: ReturnType<typeof fromCloses>, p: Record<string, number>) => strategyById(id)!.signals(c, p);

describe('new strategy families', () => {
  it('are known to the backtester and the lab search', () => {
    for (const id of ['bb-revert', 'momentum', 'session-breakout']) {
      expect(STRATEGIES.some((s) => s.id === id)).toBe(true);
      expect(SEARCH[id]).toBeDefined();
    }
    const rng = new Rng(9);
    const seen = new Set(Array.from({ length: 400 }, () => randomGenome(rng).strategy));
    expect(seen.size).toBe(Object.keys(SEARCH).length);
  });

  it('Bollinger reversion buys when price closes back inside after a drop below the band', () => {
    const closes = [...Array.from({ length: 60 }, (_, i) => 1.1 + Math.sin(i / 2) * 0.0003), 1.094, 1.0985, 1.0995];
    const c = fromCloses(closes);
    const s = sig('bb-revert', c, { period: 20, mult: 2 });
    expect(s[60]).toBe(0); // the drop itself: outside the band, no signal yet
    expect(s[61]).toBe(1); // back above the lower band
    const g = normalize({ ...base, strategy: 'bb-revert', params: { period: 20, mult: 2 } });
    const why = explainEntry(g, c, 61, 'buy', 'H1');
    expect(why.signal.k).toBe('bb-revert');
    if (why.signal.k === 'bb-revert') {
      expect(why.signal.prevClose).toBeLessThan(why.signal.prevLower);
      expect(why.close).toBeGreaterThanOrEqual(why.signal.lower);
    }
    expect(describeGenome(g)).toMatch(/^BB\(20, 2\) reversion · SL 2×ATR/);
    // Mirror image: a spike above the upper band that comes back is a sell.
    const up = fromCloses([...Array.from({ length: 60 }, (_, i) => 1.1 + Math.sin(i / 2) * 0.0003), 1.106, 1.1015, 1.1005]);
    expect(sig('bb-revert', up, { period: 20, mult: 2 })[61]).toBe(-1);
  });

  it('momentum joins a move that grows beyond the threshold, once', () => {
    const flat = Array.from({ length: 80 }, (_, i) => 1.1 + (i % 2) * 0.0002);
    const run = Array.from({ length: 12 }, (_, i) => 1.1 + (i + 1) * 0.0012);
    const c = fromCloses([...flat, ...run]);
    const s = sig('momentum', c, { period: 10, thr: 3 });
    const first = s.findIndex((v) => v !== 0);
    expect(first).toBeGreaterThanOrEqual(80);
    expect(s[first]).toBe(1);
    expect(Array.from(s).filter((v) => v === 1)).toHaveLength(1); // crossing the line, not every bar beyond it
    const g = normalize({ ...base, strategy: 'momentum', params: { period: 10, thr: 3 } });
    const why = explainEntry(g, c, first, 'buy', 'H1');
    expect(why.signal).toMatchObject({ k: 'momentum', period: 10, thr: 3 });
    if (why.signal.k === 'momentum') {
      expect(why.signal.move).toBeGreaterThan(3);
      expect(why.signal.prevMove).toBeLessThanOrEqual(3);
    }
    expect(describeGenome(g)).toMatch(/^Momentum\(10, 3\) · /);
  });

  it('session breakout trades the first close outside the range before the open hour', () => {
    // Monday 2 Nov 2026, hourly bars from 00:00 UTC. Quiet until 07:00, then a break up at 08:00.
    const t0 = Date.UTC(2026, 10, 2, 0);
    const c = Array.from({ length: 24 }, (_, i) => bar(t0 + i * H, 1.1, 1.1005, 1.0995, 1.1));
    c[8] = bar(t0 + 8 * H, 1.1, 1.1022, 1.0999, 1.102); // closes above the range high
    c[9] = bar(t0 + 9 * H, 1.102, 1.103, 1.1015, 1.1025); // still above: no second signal
    c[10] = bar(t0 + 10 * H, 1.1025, 1.1026, 1.098, 1.0985); // closes below the range low
    const p = { open: 7, hours: 6 };
    const r = sessionRange(c, p);
    expect(Array.from(r.signals).map((v, i) => (v ? `${i}:${v}` : '')).filter(Boolean)).toEqual(['8:1', '10:-1']);
    expect(r.high[8]).toBeCloseTo(1.1005, 9);
    expect(r.low[8]).toBeCloseTo(1.0995, 9);
    expect(Number.isNaN(r.high[6])).toBe(true); // before the open hour
    expect(Number.isNaN(r.high[7 + SESSION_WINDOW_H])).toBe(true); // after the window
    const g = normalize({ ...base, strategy: 'session-breakout', params: p });
    const why = explainEntry(g, c, 8, 'buy', 'H1');
    expect(why.signal).toMatchObject({ k: 'session-breakout', open: 7, hours: 6, high: 1.1005, low: 1.0995 });
    expect(describeGenome(g)).toMatch(/^Range\(7h UTC, 6\) breakout · /);
  });

  it('session breakout stays out when the range has too few bars (weekend or gap)', () => {
    const t0 = Date.UTC(2026, 10, 2, 0);
    // Only one bar before the open hour, then a breakout bar.
    const c = [bar(t0 + 6 * H, 1.1, 1.1005, 1.0995, 1.1), bar(t0 + 7 * H, 1.1, 1.103, 1.1, 1.1025), bar(t0 + 8 * H, 1.1025, 1.104, 1.102, 1.1035)];
    expect(Array.from(sessionRange(c, { open: 7, hours: 6 }).signals)).toEqual([0, 0, 0]);
  });

  it('every family only looks at bars up to the signal bar', () => {
    const closes = Array.from({ length: 400 }, (_, i) => 1.1 + Math.sin(i / 7) * 0.004 + Math.sin(i / 1.7) * 0.001);
    const c = fromCloses(closes, Date.UTC(2026, 10, 2, 0));
    for (const [id, p] of [
      ['bb-revert', { period: 20, mult: 2 }],
      ['momentum', { period: 12, thr: 2 }],
      ['session-breakout', { open: 7, hours: 6 }],
    ] as const) {
      const full = sig(id, c, p);
      const part = sig(id, c.slice(0, 300), p);
      expect(Array.from(part)).toEqual(Array.from(full.slice(0, 300)));
      expect(Array.from(full).some((v) => v !== 0)).toBe(true);
    }
  });
});
