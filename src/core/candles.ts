import { DAY, HOUR, MIN, nyOffsetMs } from './time';

export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1';
export const TIMEFRAMES: readonly Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

export const TF_MS: Record<Timeframe, number> = {
  M1: MIN,
  M5: 5 * MIN,
  M15: 15 * MIN,
  H1: HOUR,
  H4: 4 * HOUR,
  D1: DAY,
};

export interface Candle {
  /** Bar open time (UTC ms). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Tick volume. */
  v: number;
}

/**
 * Start time of the bar containing t. Intraday bars up to H1 align to UTC;
 * H4 and D1 bars align to the 17:00 New York rollover (the "New York close"
 * convention used by most FX brokers), so there is no stray Sunday daily bar.
 */
export function bucketStart(t: number, tf: Timeframe): number {
  const p = TF_MS[tf];
  if (tf === 'H4' || tf === 'D1') {
    const off = nyOffsetMs(t) + 7 * HOUR;
    return Math.floor((t + off) / p) * p - off;
  }
  return Math.floor(t / p) * p;
}

/** Aggregates time-sorted candles into a higher timeframe. */
export function aggregate(src: readonly Candle[], tf: Timeframe): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const b of src) {
    const s = bucketStart(b.t, tf);
    if (!cur || cur.t !== s) {
      cur = { t: s, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    } else {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  return out;
}

/**
 * Applies a price tick to a series. Returns true when a new bar was started.
 * Ticks older than the last bar are ignored.
 */
export function applyTick(series: Candle[], t: number, price: number, tf: Timeframe, vol = 1): boolean {
  const s = bucketStart(t, tf);
  const last = series[series.length - 1];
  if (last && last.t === s) {
    if (price > last.h) last.h = price;
    if (price < last.l) last.l = price;
    last.c = price;
    last.v += vol;
    return false;
  }
  if (last && s < last.t) return false;
  series.push({ t: s, o: price, h: price, l: price, c: price, v: vol });
  return true;
}

/** Heikin-Ashi transform. */
export function heikinAshi(src: readonly Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    const c = (b.o + b.h + b.l + b.c) / 4;
    const o = i === 0 ? (b.o + b.c) / 2 : (out[i - 1].o + out[i - 1].c) / 2;
    out.push({ t: b.t, o, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), c, v: b.v });
  }
  return out;
}

export function closes(src: readonly Candle[]): Float64Array {
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i].c;
  return out;
}
