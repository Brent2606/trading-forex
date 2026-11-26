import { STRATEGIES, type Strategy } from './backtest';
import type { Candle } from './candles';
import { atr, ema } from './indicators';
import type { Rng } from './rng';

/**
 * A strategy "genome": everything that defines one tradable rule set. The lab evolves
 * these; the autopilot trades them. Every gene has a bounded range so search stays sane.
 */
export interface Genome {
  strategy: string;
  params: Record<string, number>;
  /** Stop distance in ATR(14) multiples. */
  slAtr: number;
  /** Target distance in ATR(14) multiples; 0 = no fixed target. */
  tpAtr: number;
  /** Trade only with this EMA's direction; 0 = off. */
  trend: number;
  exitOnOpposite: boolean;
  /** Bit mask of allowed entry sessions (see SESSION_NAMES). */
  sessions: number;
  /** 0 = any volatility, 1 = skip high volatility, 2 = skip low volatility. */
  vol: 0 | 1 | 2;
}

/** UTC-hour session buckets. */
export const SESSION_NAMES = ['Asia', 'London', 'London/NY overlap', 'New York', 'Late'] as const;
export const ALL_SESSIONS = (1 << SESSION_NAMES.length) - 1;
export const VOL_NAMES = ['low', 'normal', 'high'] as const;

export function sessionBucket(t: number): number {
  const h = new Date(t).getUTCHours();
  return h < 7 ? 0 : h < 12 ? 1 : h < 16 ? 2 : h < 21 ? 3 : 4;
}

type Range = [min: number, max: number, step: number];

/** Search ranges per strategy parameter (narrower than what a human may type). */
export const SEARCH: Record<string, Record<string, Range>> = {
  'ema-cross': { fast: [3, 60, 1], slow: [10, 250, 1] },
  'rsi-revert': { period: [2, 30, 1], lower: [10, 40, 1], upper: [60, 90, 1] },
  'bb-breakout': { period: [10, 60, 1], mult: [1, 3.5, 0.1] },
  'macd-cross': { fast: [4, 24, 1], slow: [15, 60, 1], signal: [3, 18, 1] },
  donchian: { period: [5, 120, 1] },
  'bb-revert': { period: [10, 60, 1], mult: [1.5, 3.5, 0.1] },
  momentum: { period: [6, 120, 1], thr: [1.5, 8, 0.1] },
  'session-breakout': { open: [5, 14, 1], hours: [3, 10, 1] },
};
const SL: Range = [0.8, 4, 0.1];
const TP: Range = [1, 8, 0.1];
const TRENDS = [0, 50, 100, 200];

const snap = (v: number, [min, max, step]: Range) => {
  const c = Math.min(max, Math.max(min, v));
  return Math.round(Math.round((c - min) / step) * step * 1e6) / 1e6 + min;
};
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const uniform = (rng: Rng, r: Range) => snap(r[0] + rng.next() * (r[1] - r[0]), r);
const pick = <T>(rng: Rng, a: readonly T[]): T => a[Math.floor(rng.next() * a.length) % a.length];

export function strategyById(id: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

/** Clamps every gene into range, snaps to steps and enforces parameter constraints. */
export function normalize(g: Genome): Genome {
  const ranges = SEARCH[g.strategy] ?? {};
  const params: Record<string, number> = {};
  for (const [k, r] of Object.entries(ranges)) params[k] = round6(snap(g.params[k] ?? r[0], r));
  if (g.strategy === 'ema-cross' || g.strategy === 'macd-cross') {
    if (params.fast >= params.slow - 2) {
      const lo = Math.min(params.fast, params.slow);
      const hi = Math.max(params.fast, params.slow);
      params.fast = lo;
      params.slow = Math.max(hi, lo + 3);
      const r = ranges.slow;
      if (params.slow > r[1]) {
        params.slow = r[1];
        params.fast = Math.min(params.fast, r[1] - 3);
      }
    }
  }
  const sessions = g.sessions & ALL_SESSIONS;
  return {
    strategy: g.strategy,
    params,
    slAtr: round6(snap(g.slAtr, SL)),
    tpAtr: g.tpAtr <= 0 ? 0 : round6(snap(g.tpAtr, TP)),
    trend: TRENDS.includes(g.trend) ? g.trend : 0,
    exitOnOpposite: !!g.exitOnOpposite,
    sessions: sessions === 0 ? ALL_SESSIONS : sessions,
    vol: g.vol === 1 || g.vol === 2 ? g.vol : 0,
  };
}

export function randomGenome(rng: Rng): Genome {
  const strategy = pick(rng, Object.keys(SEARCH));
  const params: Record<string, number> = {};
  for (const [k, r] of Object.entries(SEARCH[strategy])) params[k] = uniform(rng, r);
  return normalize({
    strategy,
    params,
    slAtr: uniform(rng, SL),
    tpAtr: rng.next() < 0.25 ? 0 : uniform(rng, TP),
    trend: pick(rng, TRENDS),
    exitOnOpposite: rng.next() < 0.6,
    // Mostly all sessions; sometimes a random subset.
    sessions: rng.next() < 0.6 ? ALL_SESSIONS : 1 + Math.floor(rng.next() * ALL_SESSIONS),
    vol: pick(rng, [0, 0, 1, 2] as const),
  });
}

/** Returns a mutated copy; each gene changes with probability `rate`. */
export function mutate(g: Genome, rng: Rng, rate = 0.35): Genome {
  const out: Genome = { ...g, params: { ...g.params } };
  const ranges = SEARCH[g.strategy];
  let changed = false;
  const hit = () => {
    const h = rng.next() < rate;
    changed ||= h;
    return h;
  };
  for (const [k, r] of Object.entries(ranges)) {
    if (hit()) out.params[k] = out.params[k] + rng.normal() * (r[1] - r[0]) * 0.12;
  }
  if (hit()) out.slAtr += rng.normal() * 0.5;
  if (hit()) out.tpAtr = out.tpAtr === 0 ? uniform(rng, TP) : rng.next() < 0.15 ? 0 : out.tpAtr + rng.normal() * 1;
  if (hit()) out.trend = pick(rng, TRENDS);
  if (hit()) out.exitOnOpposite = !out.exitOnOpposite;
  if (hit()) out.sessions ^= 1 << Math.floor(rng.next() * SESSION_NAMES.length);
  if (hit()) out.vol = pick(rng, [0, 1, 2] as const);
  if (!changed) out.slAtr += rng.normal() * 0.3;
  return normalize(out);
}

/** Uniform crossover. Parameters only mix between parents of the same strategy type. */
export function crossover(a: Genome, b: Genome, rng: Rng): Genome {
  const coin = <T>(x: T, y: T) => (rng.next() < 0.5 ? x : y);
  const params = a.strategy === b.strategy ? Object.fromEntries(Object.keys(a.params).map((k) => [k, coin(a.params[k], b.params[k])])) : { ...a.params };
  return normalize({
    strategy: a.strategy,
    params,
    slAtr: coin(a.slAtr, b.slAtr),
    tpAtr: coin(a.tpAtr, b.tpAtr),
    trend: coin(a.trend, b.trend),
    exitOnOpposite: coin(a.exitOnOpposite, b.exitOnOpposite),
    sessions: coin(a.sessions, b.sessions),
    vol: coin(a.vol, b.vol),
  });
}

/**
 * Two genomes are "the same bet" when they use the same strategy and every parameter is
 * within 10% of its search range of the other's (e.g. RSI 40/90 vs 40/89).
 */
export function similarSignal(a: Genome, b: Genome): boolean {
  if (a.strategy !== b.strategy) return false;
  const ranges = SEARCH[a.strategy] ?? {};
  for (const [k, [min, max]] of Object.entries(ranges)) {
    if (Math.abs((a.params[k] ?? 0) - (b.params[k] ?? 0)) > 0.1 * (max - min)) return false;
  }
  return true;
}

/** Stable short id (FNV-1a) of a genome's content. */
export function genomeId(g: Genome): string {
  const keys = Object.keys(g.params).sort();
  const s = [g.strategy, ...keys.map((k) => `${k}=${g.params[k]}`), g.slAtr, g.tpAtr, g.trend, g.exitOnOpposite ? 1 : 0, g.sessions, g.vol].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function describeGenome(g: Genome): string {
  const s = strategyById(g.strategy);
  const p = g.params;
  const core =
    g.strategy === 'ema-cross'
      ? `EMA ${p.fast}/${p.slow} cross`
      : g.strategy === 'rsi-revert'
        ? `RSI(${p.period}) ${p.lower}/${p.upper} reversion`
        : g.strategy === 'bb-breakout'
          ? `BB(${p.period}, ${p.mult}) breakout`
          : g.strategy === 'macd-cross'
            ? `MACD ${p.fast}/${p.slow}/${p.signal} cross`
            : g.strategy === 'donchian'
              ? `Donchian ${p.period} breakout`
              : g.strategy === 'bb-revert'
                ? `BB(${p.period}, ${p.mult}) reversion`
                : g.strategy === 'momentum'
                  ? `Momentum(${p.period}, ${p.thr})`
                  : g.strategy === 'session-breakout'
                    ? `Range(${p.open}h UTC, ${p.hours}) breakout`
                    : (s?.name ?? g.strategy);
  const parts = [core, `SL ${g.slAtr}×ATR`, g.tpAtr ? `TP ${g.tpAtr}×ATR` : 'no TP'];
  if (g.trend) parts.push(`EMA${g.trend} trend`);
  if (g.exitOnOpposite) parts.push('exit on flip');
  if (g.sessions !== ALL_SESSIONS) {
    parts.push(SESSION_NAMES.filter((_, i) => g.sessions & (1 << i)).join('+'));
  }
  if (g.vol === 1) parts.push('skip high vol');
  if (g.vol === 2) parts.push('skip low vol');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Per-bar market context shared by the lab (history) and the autopilot (live).
// ---------------------------------------------------------------------------

export interface Features {
  session: Uint8Array;
  /** 0 low / 1 normal / 2 high volatility (ATR percentile over the last 250 bars). */
  vol: Uint8Array;
  ema200: Float64Array;
  atr: Float64Array;
}

const VOL_WINDOW = 250;

export function computeFeatures(c: readonly Candle[]): Features {
  const n = c.length;
  const a = atr(c, 14);
  const closes = new Float64Array(n);
  for (let i = 0; i < n; i++) closes[i] = c[i].c;
  const session = new Uint8Array(n);
  const vol = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    session[i] = sessionBucket(c[i].t);
    if (Number.isNaN(a[i])) continue;
    let below = 0;
    let total = 0;
    for (let j = Math.max(0, i - VOL_WINDOW + 1); j <= i; j++) {
      if (Number.isNaN(a[j])) continue;
      total++;
      if (a[j] < a[i]) below++;
    }
    if (total < 50) continue;
    const pct = below / total;
    vol[i] = pct < 1 / 3 ? 0 : pct > 2 / 3 ? 2 : 1;
  }
  return { session, vol, ema200: ema(closes, 200), atr: a };
}

/** Session and volatility genes. */
export function entryAllowed(g: Genome, f: Features, i: number): boolean {
  if (!(g.sessions & (1 << f.session[i]))) return false;
  if (g.vol === 1 && f.vol[i] === 2) return false;
  if (g.vol === 2 && f.vol[i] === 0) return false;
  return true;
}

export interface TradeContext {
  session: number;
  vol: number;
  /** Trade direction agrees with the 200 EMA. */
  withTrend: boolean;
  /** Spread was more than 1.5× normal at entry (live only). */
  wideSpread: boolean;
}

export function contextAt(f: Features, c: readonly Candle[], i: number, side: 'buy' | 'sell', wideSpread = false): TradeContext {
  const e = f.ema200[i];
  const withTrend = Number.isNaN(e) ? true : side === 'buy' ? c[i].c >= e : c[i].c <= e;
  return { session: f.session[i], vol: f.vol[i], withTrend, wideSpread };
}

/**
 * The genome's entry decision on bar i (evaluated on its close): the strategy signal,
 * then the trend filter, then session / volatility genes. Mirrors the backtester.
 */
export function signalAt(g: Genome, c: readonly Candle[], f: Features, i: number, sig?: Int8Array): 'buy' | 'sell' | null {
  const strat = strategyById(g.strategy);
  if (!strat) return null;
  const s = (sig ?? strat.signals(c, g.params))[i];
  if (!s) return null;
  const side = s > 0 ? 'buy' : 'sell';
  if (g.trend > 0) {
    const closes = new Float64Array(c.length);
    for (let k = 0; k < c.length; k++) closes[k] = c[k].c;
    const t = ema(closes, g.trend)[i];
    if (Number.isNaN(t) || (side === 'buy' ? !(c[i].c > t) : !(c[i].c < t))) return null;
  }
  return entryAllowed(g, f, i) ? side : null;
}
