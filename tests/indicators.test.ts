import { describe, expect, it } from 'vitest';
import { applyTick, heikinAshi } from '../src/core/candles';
import {
  adx,
  atr,
  bollinger,
  cci,
  ema,
  highest,
  lastValue,
  lowest,
  macd,
  momentum,
  rsi,
  sma,
  stochastic,
  williamsR,
} from '../src/core/indicators';
import { bar, fromCloses } from './helpers';

// Wilder RSI worked example data (StockCharts "Relative Strength Index" article).
// The article's table rounds intermediate averages (0.24 / 0.10 -> 70.53); exact math gives
// avg gain 3.34/14 and avg loss 1.40/14 -> RSI 70.4641.
const RSI_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03,
  46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];

/** Straightforward independent Wilder RSI for cross-checking. */
function referenceRsi(c: number[], n: number): number[] {
  const out: number[] = [];
  const ch = c.slice(1).map((v, i) => v - c[i]);
  let g = ch.slice(0, n).reduce((a, d) => a + Math.max(d, 0), 0) / n;
  let l = ch.slice(0, n).reduce((a, d) => a + Math.max(-d, 0), 0) / n;
  out[n] = 100 - 100 / (1 + g / l);
  for (let i = n; i < ch.length; i++) {
    g = (g * (n - 1) + Math.max(ch[i], 0)) / n;
    l = (l * (n - 1) + Math.max(-ch[i], 0)) / n;
    out[i + 1] = 100 - 100 / (1 + g / l);
  }
  return out;
}

describe('moving averages', () => {
  it('sma', () => {
    const r = sma([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(r[1])).toBe(true);
    expect([...r.slice(2)]).toEqual([2, 3, 4]);
  });

  it('sma propagates NaN windows', () => {
    const r = sma([NaN, 1, 2, 3], 2);
    expect(Number.isNaN(r[1])).toBe(true);
    expect(r[2]).toBe(1.5);
    expect(r[3]).toBe(2.5);
  });

  it('ema seeds with the SMA then smooths', () => {
    const v = [2, 4, 6, 8, 10, 12];
    const r = ema(v, 3);
    expect(Number.isNaN(r[1])).toBe(true);
    expect(r[2]).toBeCloseTo(4, 12);
    expect(r[3]).toBeCloseTo(8 * 0.5 + 4 * 0.5, 12);
    expect(r[4]).toBeCloseTo(10 * 0.5 + 6 * 0.5, 12);
  });

  it('ema skips leading NaNs', () => {
    const r = ema([NaN, NaN, 3, 3, 3, 6], 3);
    expect(Number.isNaN(r[3])).toBe(true);
    expect(r[4]).toBe(3);
    expect(r[5]).toBeCloseTo(4.5, 12);
  });
});

describe('RSI', () => {
  it('matches the Wilder worked example', () => {
    const r = rsi(RSI_CLOSES, 14);
    for (let i = 0; i < 14; i++) expect(Number.isNaN(r[i])).toBe(true);
    expect(r[14]).toBeCloseTo(100 - 100 / (1 + 3.34 / 1.4), 9);
    expect(r[14]).toBeCloseTo(70.4641, 3);
    const ref = referenceRsi(RSI_CLOSES, 14);
    for (let i = 14; i < RSI_CLOSES.length; i++) expect(r[i]).toBeCloseTo(ref[i], 9);
  });
  it('is 100 for a rising series and 0 for a falling one', () => {
    expect(lastValue(rsi([1, 2, 3, 4, 5, 6, 7, 8], 3))).toBe(100);
    expect(lastValue(rsi([8, 7, 6, 5, 4, 3, 2, 1], 3))).toBe(0);
    expect(lastValue(rsi([5, 5, 5, 5, 5], 3))).toBe(50);
  });
});

describe('MACD', () => {
  it('is fast EMA − slow EMA with an EMA signal line', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 3 + i * 0.1);
    const m = macd(closes, 12, 26, 9);
    const f = ema(closes, 12);
    const s = ema(closes, 26);
    expect(m.macd[50]).toBeCloseTo(f[50] - s[50], 12);
    expect(Number.isNaN(m.signal[25 + 7])).toBe(true);
    expect(Number.isNaN(m.signal[25 + 8])).toBe(false);
    expect(m.hist[60]).toBeCloseTo(m.macd[60] - m.signal[60], 12);
  });
});

describe('Bollinger', () => {
  it('uses population standard deviation', () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    // mean 5, population sd 2
    expect(b.mid[7]).toBe(5);
    expect(b.upper[7]).toBeCloseTo(9, 12);
    expect(b.lower[7]).toBeCloseTo(1, 12);
  });
});

describe('ATR / ranges', () => {
  it('Wilder ATR', () => {
    const c = [bar(0, 10, 12, 9, 11), bar(1, 11, 13, 10, 12), bar(2, 12, 12.5, 8, 9), bar(3, 9, 10, 8.5, 9.5)];
    // TR: 3, 3, max(4.5, .5, 4)=4.5, max(1.5, 1, .5)=1.5
    const a = atr(c, 3);
    expect(a[2]).toBeCloseTo((3 + 3 + 4.5) / 3, 12);
    expect(a[3]).toBeCloseTo((3.5 * 2 + 1.5) / 3, 12);
  });
  it('highest / lowest', () => {
    expect([...highest([1, 3, 2, 5, 4], 2).slice(1)]).toEqual([3, 3, 5, 5]);
    expect([...lowest([1, 3, 2, 5, 4], 2).slice(1)]).toEqual([1, 2, 2, 4]);
  });
});

describe('oscillators', () => {
  const up = fromCloses(Array.from({ length: 80 }, (_, i) => 1 + i * 0.001));
  it('stochastic is 100 at the top of the range', () => {
    expect(lastValue(stochastic(up).k)).toBeCloseTo(100, 9);
  });
  it('Williams %R is 0 at the top of the range', () => {
    expect(lastValue(williamsR(up))).toBeCloseTo(0, 9);
  });
  it('CCI is positive in an uptrend', () => {
    expect(lastValue(cci(up))).toBeGreaterThan(100);
  });
  it('ADX shows a strong uptrend', () => {
    const r = adx(up, 14);
    expect(lastValue(r.adx)).toBeGreaterThan(50);
    expect(lastValue(r.plusDI)).toBeGreaterThan(lastValue(r.minusDI));
    for (const v of r.adx) if (!Number.isNaN(v)) expect(v).toBeLessThanOrEqual(100);
  });
  it('momentum', () => {
    expect([...momentum([1, 2, 4, 7], 2).slice(2)]).toEqual([3, 5]);
  });
});

describe('candles', () => {
  it('applyTick updates the current bar and opens new ones', () => {
    const s = [bar(0, 1, 1, 1, 1, 0)];
    expect(applyTick(s, 30_000, 1.2, 'M1')).toBe(false);
    expect(applyTick(s, 40_000, 0.9, 'M1')).toBe(false);
    expect(s[0]).toEqual({ t: 0, o: 1, h: 1.2, l: 0.9, c: 0.9, v: 2 });
    expect(applyTick(s, 60_000, 1.1, 'M1')).toBe(true);
    expect(s[1]).toEqual({ t: 60_000, o: 1.1, h: 1.1, l: 1.1, c: 1.1, v: 1 });
  });
  it('heikin-ashi', () => {
    const ha = heikinAshi([bar(0, 1, 3, 0, 2), bar(1, 2, 4, 1, 3)]);
    expect(ha[0].c).toBe(1.5);
    expect(ha[0].o).toBe(1.5);
    expect(ha[1].o).toBe(1.5);
    expect(ha[1].c).toBe(2.5);
    expect(ha[1].h).toBe(4);
    expect(ha[1].l).toBe(1);
  });
});
