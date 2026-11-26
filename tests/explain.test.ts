import { describe, expect, it } from 'vitest';
import { strategyById, ALL_SESSIONS, normalize, type Genome } from '../src/core/genome';
import { explainEntry, rebuildEntry } from '../src/core/explain';
import { fromCloses } from './helpers';

const H = 3_600_000;
const base: Genome = { strategy: 'rsi-revert', params: { period: 14, lower: 30, upper: 70 }, slAtr: 2, tpAtr: 3, trend: 0, exitOnOpposite: true, sessions: ALL_SESSIONS, vol: 0 };

/** A quiet market, a sharp fall, then a recovery: RSI dips under 30 and climbs back. */
function dipAndRecover(): number[] {
  const c: number[] = [];
  for (let i = 0; i < 360; i++) c.push(1.1 + Math.sin(i / 5) * 0.0008);
  for (let i = 0; i < 12; i++) c.push(c[c.length - 1] - 0.0012);
  for (let i = 0; i < 12; i++) c.push(c[c.length - 1] + 0.0009);
  return c;
}

describe('explainEntry', () => {
  it('reports the RSI readings behind a mean-reversion buy', () => {
    const g = normalize(base);
    const candles = fromCloses(dipAndRecover());
    const sig = strategyById('rsi-revert')!.signals(candles, g.params);
    const i = sig.findIndex((v, k) => k > 360 && v === 1);
    expect(i).toBeGreaterThan(360);
    const why = explainEntry(g, candles, i, 'buy', 'H1');
    expect(why).toMatchObject({ tf: 'H1', side: 'buy', barTime: candles[i].t, trend: null, sessions: ALL_SESSIONS, exitOnOpposite: true });
    expect(why.signal.k).toBe('rsi-revert');
    if (why.signal.k === 'rsi-revert') {
      expect(why.signal.prev).toBeLessThan(30);
      expect(why.signal.now).toBeGreaterThanOrEqual(30);
    }
    expect(why.atr).toBeGreaterThan(0);
  });

  it('includes the trend filter and other strategy families', () => {
    const candles = fromCloses(Array.from({ length: 400 }, (_, i) => 1.1 + i * 0.0002));
    const ema = explainEntry(normalize({ ...base, strategy: 'ema-cross', params: { fast: 10, slow: 50 }, trend: 200 }), candles, 399, 'buy', 'H1');
    expect(ema.trend).toMatchObject({ period: 200 });
    expect(ema.trend!.ema).toBeLessThan(ema.close);
    expect(ema.signal).toMatchObject({ k: 'ema-cross', fast: 10, slow: 50 });
    expect(explainEntry(normalize({ ...base, strategy: 'bb-breakout', params: { period: 20, mult: 2 } }), candles, 399, 'buy', 'H1').signal.k).toBe('bb-breakout');
    expect(explainEntry(normalize({ ...base, strategy: 'macd-cross', params: { fast: 12, slow: 26, signal: 9 } }), candles, 399, 'buy', 'H1').signal.k).toBe('macd-cross');
  });
});

describe('rebuildEntry', () => {
  it('finds the signal bar before the open time, and refuses when history disagrees', () => {
    const g = normalize(base);
    const candles = fromCloses(dipAndRecover());
    const sig = strategyById('rsi-revert')!.signals(candles, g.params);
    const i = sig.findIndex((v, k) => k > 360 && v === 1);
    const openTime = candles[i].t + H + 1500; // just after the signal bar closed
    const why = rebuildEntry(g, candles, openTime, 'buy', 'H1');
    expect(why).toEqual(explainEntry(g, candles.slice(0, i + 1), i, 'buy', 'H1'));
    expect(rebuildEntry(g, candles, openTime, 'sell', 'H1')).toBeNull();
    expect(rebuildEntry(g, candles, openTime + 3 * H, 'buy', 'H1')).toBeNull();
    expect(rebuildEntry(g, candles.slice(0, 100), candles[90].t, 'buy', 'H1')).toBeNull();
  });
});
