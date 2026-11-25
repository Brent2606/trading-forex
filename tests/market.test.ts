import { describe, expect, it } from 'vitest';
import { bucketStart, TIMEFRAMES } from '../src/core/candles';
import { FALLBACK_RATES, INSTRUMENTS } from '../src/core/instruments';
import { bidAsk, H1_HISTORY_BARS, isValidSnapshot, M1_HISTORY_BARS, MarketSim, sanitizeRates } from '../src/core/market';
import { DAY, isFxOpen, MIN } from '../src/core/time';

const NOW = Date.UTC(2026, 10, 25, 14, 37, 21); // Wednesday
const seed = { rates: FALLBACK_RATES, source: 'builtin' as const, label: 'test' };
const sim = new MarketSim(seed, NOW, 12345);

describe('market simulator', () => {
  it('anchors final prices to the seed rates', () => {
    const r = FALLBACK_RATES;
    const expectMid = (s: string, v: number, tol: number) => expect(Math.abs(sim.quote(s)!.mid - v)).toBeLessThan(tol);
    expectMid('EURUSD', 1 / r.EUR, 0.0001);
    expectMid('USDJPY', r.JPY, 0.01);
    expectMid('GBPJPY', r.JPY / r.GBP, 0.02);
    expectMid('AUDNZD', r.NZD / r.AUD, 0.0002);
  });

  it('keeps cross rates consistent with the USD legs (no triangular arbitrage)', () => {
    sim.advanceTo(NOW + 5 * MIN);
    const m = (s: string) => sim.quote(s)!.mid;
    expect(m('EURJPY') / (m('EURUSD') * m('USDJPY'))).toBeCloseTo(1, 4);
    expect(m('EURGBP') / (m('EURUSD') / m('GBPUSD'))).toBeCloseTo(1, 4);
    expect(m('CADJPY') / (m('USDJPY') / m('USDCAD'))).toBeCloseTo(1, 4);
  });

  it('quotes have ask − bid exactly equal to the spread, at quote precision', () => {
    for (const inst of INSTRUMENTS) {
      const q = sim.quote(inst.symbol)!;
      const f = 10 ** inst.digits;
      expect(Number.isInteger(Math.round(q.bid * f * 1e6) / 1e6)).toBe(true);
      expect(Math.round((q.ask - q.bid) * f)).toBe(Math.round(q.spread * 10));
      expect(q.ask).toBeGreaterThan(q.bid);
    }
  });

  it('generates enough well-formed history on every timeframe', () => {
    for (const inst of INSTRUMENTS) {
      const c = sim.candles[inst.symbol];
      expect(c.M1.length).toBeGreaterThanOrEqual(M1_HISTORY_BARS);
      expect(c.H1.length).toBeGreaterThanOrEqual(H1_HISTORY_BARS);
      expect(c.D1.length).toBeGreaterThan(240);
      for (const tf of TIMEFRAMES) {
        const s = c[tf];
        for (let i = 0; i < s.length; i++) {
          const b = s[i];
          expect(b.h).toBeGreaterThanOrEqual(Math.max(b.o, b.c));
          expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
          expect(bucketStart(b.t, tf)).toBe(b.t);
          if (i > 0) expect(b.t).toBeGreaterThan(s[i - 1].t);
        }
      }
    }
  }, 30_000);

  it('has no history bars while the market is closed', () => {
    const c = sim.candles.EURUSD;
    const advanced = NOW; // bars after NOW came from live ticks
    for (const b of c.H1) if (b.t < advanced - DAY) expect(isFxOpen(b.t)).toBe(true);
    for (const b of c.M1) if (b.t < advanced) expect(isFxOpen(b.t)).toBe(true);
  });

  it('timeframes agree with each other', () => {
    const c = sim.candles.GBPUSD;
    const last = c.M1[c.M1.length - 1].c;
    for (const tf of TIMEFRAMES) expect(c[tf][c[tf].length - 1].c).toBe(last);
    // The last complete H1 bar built from M1 equals the M1 bars inside it.
    const h = c.H1[c.H1.length - 3];
    const inside = c.M1.filter((b) => b.t >= h.t && b.t < h.t + 3_600_000);
    if (inside.length) {
      expect(h.o).toBe(inside[0].o);
      expect(h.c).toBe(inside[inside.length - 1].c);
      expect(h.h).toBe(Math.max(...inside.map((b) => b.h)));
      expect(h.l).toBe(Math.min(...inside.map((b) => b.l)));
    }
  });

  it('produces realistic daily volatility', () => {
    const d = sim.candles.EURUSD.D1;
    const rets: number[] = [];
    for (let i = 1; i < d.length - 1; i++) rets.push(Math.log(d[i].c / d[i - 1].c));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    expect(sd).toBeGreaterThan(0.002);
    expect(sd).toBeLessThan(0.012);
  });

  it('advances live and forms new bars', () => {
    const s = new MarketSim(seed, NOW, 7);
    const before = s.candles.EURUSD.M1.length;
    let steps = 0;
    s.advanceTo(NOW + 3 * MIN, () => steps++);
    expect(steps).toBeGreaterThan(600);
    expect(s.time).toBe(NOW + 3 * MIN);
    expect(s.candles.EURUSD.M1.length).toBeGreaterThanOrEqual(before + 3);
    expect(s.quote('EURUSD')!.t).toBe(NOW + 3 * MIN);
  });

  it('catches up after a long pause without blowing up', () => {
    const s = new MarketSim(seed, NOW, 9);
    const t0 = performance.now();
    s.advanceTo(NOW + 2 * DAY);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(s.time).toBe(NOW + 2 * DAY);
    const q = s.quote('EURUSD')!;
    expect(q.mid).toBeGreaterThan(0.9);
    expect(q.mid).toBeLessThan(1.4);
  });

  it('is deterministic for a given seed', () => {
    const a = new MarketSim(seed, NOW, 42);
    const b = new MarketSim(seed, NOW, 42);
    expect(a.candles.USDJPY.H1.slice(0, 50)).toEqual(b.candles.USDJPY.H1.slice(0, 50));
  });

  it('snapshots rates that reproduce current mids', () => {
    const r = sim.snapshotRates();
    expect(r.USD).toBeCloseTo(1, 12);
    expect(1 / r.EUR).toBeCloseTo(sim.quote('EURUSD')!.mid, 3);
  });
});

describe('snapshots', () => {
  it('restores the same market and keeps running', () => {
    const a = new MarketSim(seed, NOW, 31);
    a.advanceTo(NOW + 20 * MIN);
    const snap = JSON.parse(JSON.stringify(a.snapshot()));
    expect(isValidSnapshot(snap)).toBe(true);
    const b = new MarketSim(seed, 0, 99, snap);
    expect(b.time).toBe(a.time);
    for (const inst of INSTRUMENTS) {
      expect(b.quote(inst.symbol)).toEqual(a.quote(inst.symbol));
      expect(b.candles[inst.symbol].H1.slice(-50)).toEqual(a.candles[inst.symbol].H1.slice(-50));
      expect(b.candles[inst.symbol].M1.slice(-30)).toEqual(a.candles[inst.symbol].M1.slice(-30));
    }
    const lastH1 = b.candles.EURUSD.H1.length;
    b.advanceTo(b.time + 2 * 3_600_000);
    expect(b.candles.EURUSD.H1.length).toBeGreaterThan(lastH1);
    expect(b.isOpen()).toBe(true);
  });

  it('rejects broken snapshots', () => {
    const snap = new MarketSim(seed, NOW, 5).snapshot();
    expect(isValidSnapshot({ ...snap, x: [1, 2] })).toBe(false);
    expect(isValidSnapshot({ ...snap, bars: { ...snap.bars, EURUSD: { h1: [1, 2, 3], m1: [] } } })).toBe(false);
    expect(isValidSnapshot(null)).toBe(false);
  });
});

describe('market hours', () => {
  const FRI = Date.UTC(2026, 10, 27, 21, 30); // Friday 16:30 New York (winter)
  const CLOSE = Date.UTC(2026, 10, 27, 22, 0);
  const REOPEN = Date.UTC(2026, 10, 29, 22, 0); // Sunday 17:00 New York

  it('freezes prices over the weekend and gaps at the reopen', () => {
    const s = new MarketSim(seed, FRI, 3);
    s.advanceTo(Date.UTC(2026, 10, 28, 12, 0)); // Saturday noon
    expect(s.isOpen()).toBe(false);
    expect(s.time).toBe(Date.UTC(2026, 10, 28, 12, 0));
    const frozen = s.quote('EURUSD')!;
    expect(frozen.t).toBeLessThanOrEqual(CLOSE);
    s.advanceTo(Date.UTC(2026, 10, 29, 12, 0)); // Sunday morning
    expect(s.quote('EURUSD')).toEqual(frozen);
    s.advanceTo(REOPEN + 30 * MIN);
    expect(s.isOpen()).toBe(true);
    expect(s.quote('EURUSD')!.t).toBe(REOPEN + 30 * MIN);
    for (const tf of TIMEFRAMES) {
      for (const b of s.candles.EURUSD[tf]) {
        expect(b.t >= CLOSE && b.t < REOPEN && bucketStart(b.t, tf) === b.t && tf !== 'D1' && tf !== 'H4').toBe(false);
      }
    }
    const h1 = s.candles.EURUSD.H1;
    expect(h1[h1.length - 1].t).toBe(REOPEN);
    expect(h1[h1.length - 2].t).toBe(CLOSE - 3_600_000);
  });

  it('can keep running for weekend practice', () => {
    const s = new MarketSim(seed, FRI, 3);
    s.respectHours = false;
    s.advanceTo(Date.UTC(2026, 10, 28, 1, 0));
    expect(s.isOpen()).toBe(true);
    expect(s.candles.EURUSD.H1.some((b) => b.t >= CLOSE)).toBe(true);
  });

  it('starts closed when created on a weekend', () => {
    const s = new MarketSim(seed, Date.UTC(2026, 10, 28, 9, 0), 4);
    expect(s.isOpen()).toBe(false);
    const before = s.quote('GBPUSD')!.mid;
    s.advanceTo(Date.UTC(2026, 10, 28, 20, 0));
    expect(s.quote('GBPUSD')!.mid).toBe(before);
  });
});

describe('helpers', () => {
  it('bidAsk uses integer pipettes', () => {
    expect(bidAsk(1.1000012, 5, 6)).toEqual({ bid: 1.09997, ask: 1.10003 });
    expect(bidAsk(150.0, 3, 8)).toEqual({ bid: 149.996, ask: 150.004 });
  });
  it('sanitizeRates', () => {
    expect(sanitizeRates(null)).toBeNull();
    expect(sanitizeRates({ EUR: 0.9 })).toBeNull();
    expect(sanitizeRates({ ...FALLBACK_RATES, JPY: -1 })).toBeNull();
    const noUsd: Record<string, number> = { ...FALLBACK_RATES };
    delete noUsd.USD;
    expect(sanitizeRates(noUsd)?.USD).toBe(1);
  });
});
