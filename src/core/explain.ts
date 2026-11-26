/**
 * Why a trade was taken: the indicator readings behind an autopilot entry, recorded at the moment
 * of entry (and rebuilt from history for older trades). The terminal turns these facts into a
 * plain-language explanation next to the chart.
 */
import { sessionRange } from './backtest';
import { closes, type Candle, type Timeframe } from './candles';
import { computeFeatures, signalAt, type Genome } from './genome';
import { atr, bollinger, ema, highest, lowest, macd, rsi } from './indicators';

/** The strategy's own reading on the signal bar (`prev` = the bar before it). */
export type SignalFact =
  | { k: 'rsi-revert'; period: number; lower: number; upper: number; prev: number; now: number }
  | { k: 'ema-cross'; fast: number; slow: number; fastPrev: number; slowPrev: number; fastNow: number; slowNow: number }
  | { k: 'bb-breakout'; period: number; mult: number; upper: number; lower: number; prevClose: number }
  | { k: 'macd-cross'; fast: number; slow: number; signal: number; macdPrev: number; signalPrev: number; macdNow: number; signalNow: number }
  | { k: 'donchian'; period: number; high: number; low: number; prevClose: number }
  | { k: 'bb-revert'; period: number; mult: number; upper: number; lower: number; prevClose: number; prevUpper: number; prevLower: number }
  /** `move` / `prevMove`: the price change over `period` bars, in multiples of ATR(14). */
  | { k: 'momentum'; period: number; thr: number; move: number; prevMove: number }
  /** The high / low of the `hours` before `open` o'clock UTC. */
  | { k: 'session-breakout'; open: number; hours: number; high: number; low: number }
  | { k: 'other' };

export interface EntryWhy {
  tf: Timeframe;
  /** Open time of the bar whose close gave the signal. */
  barTime: number;
  side: 'buy' | 'sell';
  /** Close of the signal bar. */
  close: number;
  signal: SignalFact;
  /** Trend filter: the EMA the price had to be above (buy) or below (sell). */
  trend: { period: number; ema: number } | null;
  /** Session bucket of the signal bar and the sessions the strategy may trade (bit mask). */
  session: number;
  sessions: number;
  /** Volatility regime at entry (0 low / 1 normal / 2 high) and the strategy's rule (0 any / 1 skip high / 2 skip low). */
  vol: number;
  volRule: 0 | 1 | 2;
  /** ATR(14) on the signal bar, in price units, and the stop / target as ATR multiples. */
  atr: number;
  slAtr: number;
  tpAtr: number;
  exitOnOpposite: boolean;
}

/** What the terminal knows about one autopilot trade. */
export interface TradeNote {
  /** Deployment id and its technical description. */
  dep: string;
  desc: string;
  strategy: string;
  /** Null when the readings could not be rebuilt (older trade, changed price history). */
  why: EntryWhy | null;
  /** Stop and target distance at entry, in pips. */
  slPips: number | null;
  tpPips: number | null;
  /** Share of the account risked on this trade, in %. */
  riskPct: number | null;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;

function signalFact(g: Genome, c: readonly Candle[], i: number): SignalFact {
  const p = g.params;
  const cl = closes(c);
  const prevClose = r6(c[i - 1]?.c ?? NaN);
  switch (g.strategy) {
    case 'rsi-revert': {
      const r = rsi(cl, p.period);
      return { k: 'rsi-revert', period: p.period, lower: p.lower, upper: p.upper, prev: r2(r[i - 1]), now: r2(r[i]) };
    }
    case 'ema-cross': {
      const f = ema(cl, p.fast);
      const s = ema(cl, p.slow);
      return { k: 'ema-cross', fast: p.fast, slow: p.slow, fastPrev: r6(f[i - 1]), slowPrev: r6(s[i - 1]), fastNow: r6(f[i]), slowNow: r6(s[i]) };
    }
    case 'bb-breakout': {
      const bb = bollinger(cl, p.period, p.mult);
      return { k: 'bb-breakout', period: p.period, mult: p.mult, upper: r6(bb.upper[i]), lower: r6(bb.lower[i]), prevClose };
    }
    case 'macd-cross': {
      const m = macd(cl, p.fast, p.slow, p.signal);
      return {
        k: 'macd-cross',
        fast: p.fast,
        slow: p.slow,
        signal: p.signal,
        macdPrev: r6(m.macd[i - 1]),
        signalPrev: r6(m.signal[i - 1]),
        macdNow: r6(m.macd[i]),
        signalNow: r6(m.signal[i]),
      };
    }
    case 'donchian': {
      const n = Math.round(p.period);
      // The channel the close had to break: the prior N bars (not counting the signal bar).
      const hh = highest(
        c.map((b) => b.h),
        n,
      );
      const ll = lowest(
        c.map((b) => b.l),
        n,
      );
      return { k: 'donchian', period: n, high: r6(hh[i - 1]), low: r6(ll[i - 1]), prevClose };
    }
    case 'bb-revert': {
      const bb = bollinger(cl, p.period, p.mult);
      return { k: 'bb-revert', period: p.period, mult: p.mult, upper: r6(bb.upper[i]), lower: r6(bb.lower[i]), prevClose, prevUpper: r6(bb.upper[i - 1]), prevLower: r6(bb.lower[i - 1]) };
    }
    case 'momentum': {
      const n = Math.round(p.period);
      const a = atr(c, 14);
      const move = (k: number) => (k - n >= 0 && a[k] > 0 ? r2((c[k].c - c[k - n].c) / a[k]) : NaN);
      return { k: 'momentum', period: n, thr: p.thr, move: move(i), prevMove: move(i - 1) };
    }
    case 'session-breakout': {
      const sr = sessionRange(c, p);
      return { k: 'session-breakout', open: Math.round(p.open), hours: Math.round(p.hours), high: r6(sr.high[i]), low: r6(sr.low[i]) };
    }
    default:
      return { k: 'other' };
  }
}

/** The readings behind an entry on bar i of c (the bar whose close gave the signal). */
export function explainEntry(g: Genome, c: readonly Candle[], i: number, side: 'buy' | 'sell', tf: Timeframe): EntryWhy {
  const f = computeFeatures(c);
  const cl = closes(c);
  const t = g.trend > 0 ? ema(cl, g.trend)[i] : NaN;
  return {
    tf,
    barTime: c[i].t,
    side,
    close: r6(c[i].c),
    signal: signalFact(g, c, i),
    trend: g.trend > 0 && Number.isFinite(t) ? { period: g.trend, ema: r6(t) } : null,
    session: f.session[i],
    sessions: g.sessions,
    vol: f.vol[i],
    volRule: g.vol,
    atr: r6(atr(c, 14)[i]),
    slAtr: g.slAtr,
    tpAtr: g.tpAtr,
    exitOnOpposite: g.exitOnOpposite,
  };
}

/**
 * Rebuilds the readings of an older trade from price history: the signal bar is the last bar
 * that closed before the trade opened. Returns null when the history no longer shows the signal
 * (for example after the price source changed), so no wrong explanation is shown.
 */
export function rebuildEntry(g: Genome, series: readonly Candle[], openTime: number, side: 'buy' | 'sell', tf: Timeframe, slice = 900): EntryWhy | null {
  // Index of the bar that was forming when the trade opened.
  let lo = 0;
  let hi = series.length - 1;
  let forming = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= openTime) {
      forming = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const i = forming - 1;
  if (i < 300) return null;
  const from = Math.max(0, i + 1 - slice);
  const c = series.slice(from, i + 1);
  const k = c.length - 1;
  if (signalAt(g, c, computeFeatures(c), k) !== side) return null;
  return explainEntry(g, c, k, side, tf);
}
