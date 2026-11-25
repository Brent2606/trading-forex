import type { Candle } from './candles';

/**
 * Technical indicators. Every function returns arrays aligned 1:1 with its input,
 * with NaN during the warm-up period. Inputs may start with NaNs (e.g. an EMA of
 * an indicator line); leading NaNs are skipped.
 */

type Series = ArrayLike<number>;

function nanArray(n: number): Float64Array {
  return new Float64Array(n).fill(NaN);
}

/** Simple moving average; NaN whenever the window contains a NaN. */
export function sma(v: Series, n: number): Float64Array {
  const out = nanArray(v.length);
  if (n < 1) return out;
  let sum = 0;
  let nans = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (Number.isNaN(x)) nans++;
    else sum += x;
    if (i >= n) {
      const y = v[i - n];
      if (Number.isNaN(y)) nans--;
      else sum -= y;
    }
    if (i >= n - 1 && nans === 0) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average seeded with the SMA of the first n valid values. */
export function ema(v: Series, n: number): Float64Array {
  const out = nanArray(v.length);
  if (n < 1) return out;
  let start = 0;
  while (start < v.length && Number.isNaN(v[start])) start++;
  if (start + n > v.length) return out;
  let seed = 0;
  for (let i = start; i < start + n; i++) seed += v[i];
  let prev = seed / n;
  out[start + n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = start + n; i < v.length; i++) {
    const x = v[i];
    if (Number.isNaN(x)) {
      out[i] = prev;
      continue;
    }
    prev = x * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(close: Series, n = 14): Float64Array {
  const out = nanArray(close.length);
  if (close.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const value = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[n] = value(gain, loss);
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = value(gain, loss);
  }
  return out;
}

export interface MacdResult {
  macd: Float64Array;
  signal: Float64Array;
  hist: Float64Array;
}

export function macd(close: Series, fast = 12, slow = 26, signalN = 9): MacdResult {
  const f = ema(close, fast);
  const s = ema(close, slow);
  const line = nanArray(close.length);
  for (let i = 0; i < close.length; i++) {
    if (!Number.isNaN(f[i]) && !Number.isNaN(s[i])) line[i] = f[i] - s[i];
  }
  const signal = ema(line, signalN);
  const hist = nanArray(close.length);
  for (let i = 0; i < close.length; i++) {
    if (!Number.isNaN(signal[i])) hist[i] = line[i] - signal[i];
  }
  return { macd: line, signal, hist };
}

export interface BandsResult {
  mid: Float64Array;
  upper: Float64Array;
  lower: Float64Array;
}

/** Bollinger Bands using the population standard deviation (as defined by Bollinger). */
export function bollinger(close: Series, n = 20, k = 2): BandsResult {
  const mid = sma(close, n);
  const upper = nanArray(close.length);
  const lower = nanArray(close.length);
  for (let i = n - 1; i < close.length; i++) {
    const m = mid[i];
    if (Number.isNaN(m)) continue;
    let ss = 0;
    for (let j = i - n + 1; j <= i; j++) ss += (close[j] - m) ** 2;
    const sd = Math.sqrt(ss / n);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}

export function trueRange(c: readonly Candle[]): Float64Array {
  const out = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) {
    const b = c[i];
    if (i === 0) out[i] = b.h - b.l;
    else {
      const pc = c[i - 1].c;
      out[i] = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    }
  }
  return out;
}

/** Wilder's Average True Range. */
export function atr(c: readonly Candle[], n = 14): Float64Array {
  const out = nanArray(c.length);
  if (c.length < n) return out;
  const tr = trueRange(c);
  let a = 0;
  for (let i = 0; i < n; i++) a += tr[i];
  a /= n;
  out[n - 1] = a;
  for (let i = n; i < c.length; i++) {
    a = (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

/** Highest value over the n values ending at i (inclusive). */
export function highest(v: Series, n: number): Float64Array {
  const out = nanArray(v.length);
  for (let i = n - 1; i < v.length; i++) {
    let m = -Infinity;
    for (let j = i - n + 1; j <= i; j++) if (v[j] > m) m = v[j];
    out[i] = m;
  }
  return out;
}

export function lowest(v: Series, n: number): Float64Array {
  const out = nanArray(v.length);
  for (let i = n - 1; i < v.length; i++) {
    let m = Infinity;
    for (let j = i - n + 1; j <= i; j++) if (v[j] < m) m = v[j];
    out[i] = m;
  }
  return out;
}

export interface StochResult {
  k: Float64Array;
  d: Float64Array;
}

/** Slow stochastic oscillator. */
export function stochastic(c: readonly Candle[], kPeriod = 14, kSmooth = 3, dPeriod = 3): StochResult {
  const highs = c.map((b) => b.h);
  const lows = c.map((b) => b.l);
  const hh = highest(highs, kPeriod);
  const ll = lowest(lows, kPeriod);
  const raw = nanArray(c.length);
  for (let i = kPeriod - 1; i < c.length; i++) {
    const range = hh[i] - ll[i];
    raw[i] = range === 0 ? 50 : (100 * (c[i].c - ll[i])) / range;
  }
  const k = sma(raw, kSmooth);
  const d = sma(k, dPeriod);
  return { k, d };
}

/** Commodity Channel Index. */
export function cci(c: readonly Candle[], n = 20): Float64Array {
  const tp = c.map((b) => (b.h + b.l + b.c) / 3);
  const m = sma(tp, n);
  const out = nanArray(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
    md /= n;
    out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
  }
  return out;
}

/** Williams %R (−100..0). */
export function williamsR(c: readonly Candle[], n = 14): Float64Array {
  const hh = highest(
    c.map((b) => b.h),
    n,
  );
  const ll = lowest(
    c.map((b) => b.l),
    n,
  );
  const out = nanArray(c.length);
  for (let i = n - 1; i < c.length; i++) {
    const range = hh[i] - ll[i];
    out[i] = range === 0 ? -50 : (-100 * (hh[i] - c[i].c)) / range;
  }
  return out;
}

export function momentum(close: Series, n = 10): Float64Array {
  const out = nanArray(close.length);
  for (let i = n; i < close.length; i++) out[i] = close[i] - close[i - n];
  return out;
}

export interface AdxResult {
  adx: Float64Array;
  plusDI: Float64Array;
  minusDI: Float64Array;
}

/** Wilder's ADX with +DI / −DI. */
export function adx(c: readonly Candle[], n = 14): AdxResult {
  const len = c.length;
  const adxOut = nanArray(len);
  const plusDI = nanArray(len);
  const minusDI = nanArray(len);
  if (len <= 2 * n) return { adx: adxOut, plusDI, minusDI };
  let trN = 0;
  let pN = 0;
  let mN = 0;
  const dx = nanArray(len);
  for (let i = 1; i < len; i++) {
    const up = c[i].h - c[i - 1].h;
    const down = c[i - 1].l - c[i].l;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    const pc = c[i - 1].c;
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - pc), Math.abs(c[i].l - pc));
    if (i <= n) {
      trN += tr;
      pN += pdm;
      mN += mdm;
      if (i < n) continue;
    } else {
      trN = trN - trN / n + tr;
      pN = pN - pN / n + pdm;
      mN = mN - mN / n + mdm;
    }
    const p = trN === 0 ? 0 : (100 * pN) / trN;
    const m = trN === 0 ? 0 : (100 * mN) / trN;
    plusDI[i] = p;
    minusDI[i] = m;
    dx[i] = p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  }
  // First ADX = mean of the first n DX values (indices n .. 2n-1).
  let a = 0;
  for (let i = n; i < 2 * n; i++) a += dx[i];
  a /= n;
  adxOut[2 * n - 1] = a;
  for (let i = 2 * n; i < len; i++) {
    a = (a * (n - 1) + dx[i]) / n;
    adxOut[i] = a;
  }
  return { adx: adxOut, plusDI, minusDI };
}

/** Last non-NaN value of a series, or NaN. */
export function lastValue(v: Series): number {
  for (let i = v.length - 1; i >= 0; i--) if (!Number.isNaN(v[i])) return v[i];
  return NaN;
}
