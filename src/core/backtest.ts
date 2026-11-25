import { closes, type Candle } from './candles';
import { atr, bollinger, ema, highest, lowest, macd, rsi } from './indicators';
import { LOT_UNITS, MIN_UNITS } from './instruments';
import { computeStats, type PerfStats } from './stats';

export interface ParamDef {
  key: string;
  label: string;
  def: number;
  min: number;
  max: number;
  step: number;
}

export interface Strategy {
  id: string;
  name: string;
  blurb: string;
  params: ParamDef[];
  /** +1 = long entry signal, -1 = short entry signal, 0 = none; evaluated on the close of bar i. */
  signals(c: readonly Candle[], p: Record<string, number>): Int8Array;
}

function crossSignals(n: number, a: ArrayLike<number>, b: ArrayLike<number>): Int8Array {
  const out = new Int8Array(n);
  for (let i = 1; i < n; i++) {
    if ([a[i], b[i], a[i - 1], b[i - 1]].some(Number.isNaN)) continue;
    if (a[i] > b[i] && a[i - 1] <= b[i - 1]) out[i] = 1;
    else if (a[i] < b[i] && a[i - 1] >= b[i - 1]) out[i] = -1;
  }
  return out;
}

export const STRATEGIES: readonly Strategy[] = [
  {
    id: 'ema-cross',
    name: 'EMA Crossover',
    blurb: 'Trend following. Long when the fast EMA crosses above the slow EMA, short on the cross below.',
    params: [
      { key: 'fast', label: 'Fast EMA', def: 20, min: 2, max: 200, step: 1 },
      { key: 'slow', label: 'Slow EMA', def: 50, min: 3, max: 400, step: 1 },
    ],
    signals(c, p) {
      const cl = closes(c);
      return crossSignals(c.length, ema(cl, p.fast), ema(cl, p.slow));
    },
  },
  {
    id: 'rsi-revert',
    name: 'RSI Mean Reversion',
    blurb: 'Fades extremes. Long when RSI climbs back above the oversold line, short when it drops back below overbought.',
    params: [
      { key: 'period', label: 'RSI period', def: 14, min: 2, max: 100, step: 1 },
      { key: 'lower', label: 'Oversold', def: 30, min: 1, max: 49, step: 1 },
      { key: 'upper', label: 'Overbought', def: 70, min: 51, max: 99, step: 1 },
    ],
    signals(c, p) {
      const r = rsi(closes(c), p.period);
      const out = new Int8Array(c.length);
      for (let i = 1; i < c.length; i++) {
        if (Number.isNaN(r[i]) || Number.isNaN(r[i - 1])) continue;
        if (r[i - 1] < p.lower && r[i] >= p.lower) out[i] = 1;
        else if (r[i - 1] > p.upper && r[i] <= p.upper) out[i] = -1;
      }
      return out;
    },
  },
  {
    id: 'bb-breakout',
    name: 'Bollinger Breakout',
    blurb: 'Volatility breakout. Long when price closes above the upper band, short when it closes below the lower band.',
    params: [
      { key: 'period', label: 'Period', def: 20, min: 5, max: 200, step: 1 },
      { key: 'mult', label: 'Std devs', def: 2, min: 0.5, max: 4, step: 0.1 },
    ],
    signals(c, p) {
      const cl = closes(c);
      const bb = bollinger(cl, p.period, p.mult);
      const out = new Int8Array(c.length);
      for (let i = 1; i < c.length; i++) {
        if (Number.isNaN(bb.upper[i - 1])) continue;
        if (cl[i] > bb.upper[i] && cl[i - 1] <= bb.upper[i - 1]) out[i] = 1;
        else if (cl[i] < bb.lower[i] && cl[i - 1] >= bb.lower[i - 1]) out[i] = -1;
      }
      return out;
    },
  },
  {
    id: 'macd-cross',
    name: 'MACD Signal Cross',
    blurb: 'Momentum. Long when the MACD line crosses above its signal line, short on the cross below.',
    params: [
      { key: 'fast', label: 'Fast', def: 12, min: 2, max: 100, step: 1 },
      { key: 'slow', label: 'Slow', def: 26, min: 3, max: 200, step: 1 },
      { key: 'signal', label: 'Signal', def: 9, min: 2, max: 50, step: 1 },
    ],
    signals(c, p) {
      const m = macd(closes(c), p.fast, p.slow, p.signal);
      return crossSignals(c.length, m.macd, m.signal);
    },
  },
  {
    id: 'donchian',
    name: 'Donchian Breakout',
    blurb: 'Classic channel breakout. Long on a close above the prior N-bar high, short on a close below the prior N-bar low.',
    params: [{ key: 'period', label: 'Channel', def: 20, min: 2, max: 300, step: 1 }],
    signals(c, p) {
      const n = Math.round(p.period);
      const hh = highest(
        c.map((b) => b.h),
        n,
      );
      const ll = lowest(
        c.map((b) => b.l),
        n,
      );
      const out = new Int8Array(c.length);
      for (let i = n; i < c.length; i++) {
        if (c[i].c > hh[i - 1] && c[i - 1].c <= hh[i - 1]) out[i] = 1;
        else if (c[i].c < ll[i - 1] && c[i - 1].c >= ll[i - 1]) out[i] = -1;
      }
      return out;
    },
  },
];

export function defaultParams(s: Strategy): Record<string, number> {
  return Object.fromEntries(s.params.map((p) => [p.key, p.def]));
}

export interface BacktestConfig {
  /** Bid-price candles. */
  candles: readonly Candle[];
  strategy: Strategy;
  params: Record<string, number>;
  pip: number;
  spreadPips: number;
  /** Commission per lot per side. */
  commissionPerLot: number;
  startBalance: number;
  /** Risk per trade in % of balance (used when slAtr > 0). */
  riskPct: number;
  /** Fixed size when there is no stop (slAtr = 0). */
  fixedLots: number;
  /** Stop distance in ATR(14) multiples; 0 = no stop. */
  slAtr: number;
  /** Target distance in ATR(14) multiples; 0 = no target. */
  tpAtr: number;
  exitOnOpposite: boolean;
  allowLong: boolean;
  allowShort: boolean;
  /** Only trade in the direction of this EMA (period); 0 = off. */
  trendFilter: number;
  leverage: number;
  /** Converts an amount in the quote currency to the account currency at the given price. */
  quoteToUsd: (price: number) => number;
}

export type BtExitReason = 'sl' | 'tp' | 'signal' | 'end';

export interface BtTrade {
  side: 'buy' | 'sell';
  entryIdx: number;
  exitIdx: number;
  entry: number;
  exit: number;
  units: number;
  pips: number;
  net: number;
  reason: BtExitReason;
}

export interface BacktestResult {
  trades: BtTrade[];
  /** Mark-to-market equity at each bar close. */
  equity: Float64Array;
  stats: PerfStats;
  /** Max drawdown measured on the bar-by-bar equity curve. */
  maxDrawdown: number;
  maxDrawdownPct: number;
  returnPct: number;
  buyHoldPct: number;
  exposurePct: number;
}

interface OpenPos {
  side: 'buy' | 'sell';
  entry: number;
  units: number;
  sl: number | null;
  tp: number | null;
  entryIdx: number;
  commOpen: number;
}

/**
 * Event-driven backtest on bar data with no look-ahead: signals are evaluated on a
 * bar's close and executed at the NEXT bar's open. Longs fill at the ask (bid + spread)
 * and exit at the bid; shorts the reverse. If a bar touches both stop and target,
 * the stop is assumed to have been hit first. Gaps fill at the open.
 */
export function runBacktest(cfg: BacktestConfig): BacktestResult {
  const c = cfg.candles;
  const n = c.length;
  const sig = cfg.strategy.signals(c, cfg.params);
  const a = atr(c, 14);
  const trend = cfg.trendFilter > 0 ? ema(closes(c), cfg.trendFilter) : null;
  const spread = cfg.spreadPips * cfg.pip;
  const commPerUnit = cfg.commissionPerLot / LOT_UNITS;
  const trades: BtTrade[] = [];
  const equity = new Float64Array(n);
  let balance = cfg.startBalance;
  let pos = null as OpenPos | null;
  let pendingEntry: { side: 'buy' | 'sell'; slDist: number | null; tpDist: number | null } | null = null;
  let pendingExit = false;
  let barsInMarket = 0;

  const close = (i: number, price: number, reason: BtExitReason) => {
    const p = pos!;
    const dir = p.side === 'buy' ? 1 : -1;
    const gross = (price - p.entry) * dir * p.units * cfg.quoteToUsd(price);
    const comm = commPerUnit * p.units;
    balance += gross - comm;
    trades.push({
      side: p.side,
      entryIdx: p.entryIdx,
      exitIdx: i,
      entry: p.entry,
      exit: price,
      units: p.units,
      pips: ((price - p.entry) * dir) / cfg.pip,
      net: gross - comm - p.commOpen,
      reason,
    });
    pos = null;
  };

  const open = (i: number, side: 'buy' | 'sell', slDist: number | null, tpDist: number | null) => {
    if (balance <= 0) return;
    const bid = c[i].o;
    const entry = side === 'buy' ? bid + spread : bid;
    const q2u = cfg.quoteToUsd(entry);
    let units: number;
    if (slDist !== null) {
      const riskUsd = (balance * cfg.riskPct) / 100;
      const perUnit = slDist * q2u + 2 * commPerUnit;
      units = Math.floor(riskUsd / perUnit / MIN_UNITS) * MIN_UNITS;
    } else {
      units = Math.round((cfg.fixedLots * LOT_UNITS) / MIN_UNITS) * MIN_UNITS;
    }
    const maxUnits = Math.floor((balance * cfg.leverage) / (entry * q2u) / MIN_UNITS) * MIN_UNITS;
    units = Math.min(units, maxUnits);
    if (units < MIN_UNITS) return;
    const dir = side === 'buy' ? 1 : -1;
    const commOpen = commPerUnit * units;
    balance -= commOpen;
    pos = {
      side,
      entry,
      units,
      sl: slDist !== null ? entry - dir * slDist : null,
      tp: tpDist !== null ? entry + dir * tpDist : null,
      entryIdx: i,
      commOpen,
    };
  };

  for (let i = 0; i < n; i++) {
    const b = c[i];
    if (i > 0) {
      if (pos && pendingExit) close(i, pos.side === 'buy' ? b.o : b.o + spread, 'signal');
      pendingExit = false;
      if (!pos && pendingEntry) open(i, pendingEntry.side, pendingEntry.slDist, pendingEntry.tpDist);
      pendingEntry = null;
    }

    if (pos) {
      const p: OpenPos = pos;
      if (p.side === 'buy') {
        const slHit = p.sl !== null && b.l <= p.sl;
        const tpHit = p.tp !== null && b.h >= p.tp;
        if (slHit) close(i, Math.min(p.sl!, b.o), 'sl');
        else if (tpHit) close(i, Math.max(p.tp!, b.o), 'tp');
      } else {
        const askO = b.o + spread;
        const slHit = p.sl !== null && b.h + spread >= p.sl;
        const tpHit = p.tp !== null && b.l + spread <= p.tp;
        if (slHit) close(i, Math.max(p.sl!, askO), 'sl');
        else if (tpHit) close(i, Math.min(p.tp!, askO), 'tp');
      }
    }

    const s = sig[i];
    if (s !== 0 && i < n - 1) {
      const side = s > 0 ? 'buy' : 'sell';
      let allowed = side === 'buy' ? cfg.allowLong : cfg.allowShort;
      if (allowed && trend) {
        allowed = !Number.isNaN(trend[i]) && (side === 'buy' ? b.c > trend[i] : b.c < trend[i]);
      }
      const atrV = a[i];
      const slDist = cfg.slAtr > 0 ? (Number.isNaN(atrV) ? NaN : cfg.slAtr * atrV) : null;
      const tpDist = cfg.tpAtr > 0 ? (Number.isNaN(atrV) ? NaN : cfg.tpAtr * atrV) : null;
      if (Number.isNaN(slDist) || Number.isNaN(tpDist)) allowed = false;
      const setup = allowed ? { side: side as 'buy' | 'sell', slDist, tpDist } : null;
      if (pos) {
        if (cfg.exitOnOpposite && pos.side !== side) {
          pendingExit = true;
          pendingEntry = setup;
        }
      } else if (setup) pendingEntry = setup;
    }

    if (pos) {
      barsInMarket++;
      const p: OpenPos = pos;
      const exitPx = p.side === 'buy' ? b.c : b.c + spread;
      const dir = p.side === 'buy' ? 1 : -1;
      equity[i] = balance + (exitPx - p.entry) * dir * p.units * cfg.quoteToUsd(exitPx);
    } else equity[i] = balance;
  }
  if (pos && n > 0) {
    const p: OpenPos = pos;
    close(n - 1, p.side === 'buy' ? c[n - 1].c : c[n - 1].c + spread, 'end');
    equity[n - 1] = balance;
  }

  let peak = cfg.startBalance;
  let maxDd = 0;
  let maxDdPct = 0;
  for (let i = 0; i < n; i++) {
    const e = equity[i];
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }
  const stats = computeStats(
    trades.map((t) => ({ net: t.net, closeTime: c[t.exitIdx].t })),
    cfg.startBalance,
  );
  return {
    trades,
    equity,
    stats,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct * 100,
    returnPct: ((balance - cfg.startBalance) / cfg.startBalance) * 100,
    buyHoldPct: n > 1 ? ((c[n - 1].c - c[0].c) / c[0].c) * 100 : 0,
    exposurePct: n ? (barsInMarket / n) * 100 : 0,
  };
}
