import type { Candle } from './candles';
import { CURRENCIES, type Ccy, type Instrument } from './instruments';

/**
 * Currency strength: for each currency, the average % change over the lookback of every
 * pair that contains it (sign-flipped when it is the quote currency).
 */
export function currencyStrength(
  instruments: readonly Instrument[],
  series: (symbol: string) => readonly Candle[],
  lookback: number,
): Record<Ccy, number> {
  const sum = Object.fromEntries(CURRENCIES.map((c) => [c, 0])) as Record<Ccy, number>;
  const cnt = Object.fromEntries(CURRENCIES.map((c) => [c, 0])) as Record<Ccy, number>;
  for (const inst of instruments) {
    const s = series(inst.symbol);
    if (s.length < 2) continue;
    const from = s[Math.max(0, s.length - 1 - lookback)].c;
    const to = s[s.length - 1].c;
    const pct = ((to - from) / from) * 100;
    sum[inst.base] += pct;
    cnt[inst.base]++;
    sum[inst.quote] -= pct;
    cnt[inst.quote]++;
  }
  const out = {} as Record<Ccy, number>;
  for (const c of CURRENCIES) out[c] = cnt[c] ? sum[c] / cnt[c] : 0;
  return out;
}

/** Log returns of closes keyed by bar time. */
function returnsByTime(s: readonly Candle[], lookback: number): Map<number, number> {
  const m = new Map<number, number>();
  const start = Math.max(1, s.length - lookback);
  for (let i = start; i < s.length; i++) m.set(s[i].t, Math.log(s[i].c / s[i - 1].c));
  return m;
}

/** Pearson correlation of two equal-length samples (NaN if undefined). */
export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va === 0 || vb === 0 ? NaN : cov / Math.sqrt(va * vb);
}

/** Correlation matrix of bar returns, aligned on bar time. */
export function correlationMatrix(
  symbols: readonly string[],
  series: (symbol: string) => readonly Candle[],
  lookback: number,
): number[][] {
  const rets = symbols.map((s) => returnsByTime(series(s), lookback));
  return symbols.map((_, i) =>
    symbols.map((__, j) => {
      if (i === j) return 1;
      const a: number[] = [];
      const b: number[] = [];
      for (const [t, r] of rets[i]) {
        const o = rets[j].get(t);
        if (o !== undefined) {
          a.push(r);
          b.push(o);
        }
      }
      return pearson(a, b);
    }),
  );
}
