import { aggregate, applyTick, TIMEFRAMES, type Candle, type Timeframe } from './candles';
import { CURRENCIES, INSTRUMENTS, type Ccy, type Instrument } from './instruments';
import type { MidLookup, Quote } from './rates';
import { Rng } from './rng';
import { DAY, HOUR, isFxOpen, isRollover, MIN, nextFxChange, sessionMultiplier } from './time';

/**
 * MARKET SIMULATOR
 *
 * Each currency has a log "value" x_c. A pair's mid price is exp(x_base - x_quote),
 * so every cross rate is always consistent with the USD legs (no triangular
 * arbitrage) and correlations between pairs emerge naturally from shared factors:
 * a dollar factor, a risk-on/risk-off factor, a European bloc and a commodity bloc,
 * plus idiosyncratic noise, rare jumps ("news spikes"), stochastic volatility
 * regimes and an intraday liquidity profile.
 *
 * It is a random walk: it has no predictable edge by construction.
 */

export interface MarketSeed {
  /** Units of each currency per 1 USD (USD = 1). */
  rates: Record<Ccy, number>;
  source: 'ecb' | 'resumed' | 'builtin';
  /** Human readable description of where the anchor prices came from. */
  label: string;
}

/**
 * Everything needed to continue a simulated market later: the currency state and the bar
 * history (H1 for research, recent M1 for short charts). Bars are flat [t,o,h,l,c,v,...].
 */
export interface MarketSnapshot {
  v: 1;
  time: number;
  x: number[];
  lv: number;
  wasClosed: boolean;
  seed: MarketSeed;
  bars: Record<string, { h1: number[]; m1: number[] }>;
}

const flatten = (bars: readonly Candle[]): number[] => {
  const out: number[] = [];
  for (const b of bars) out.push(b.t, b.o, b.h, b.l, b.c, b.v);
  return out;
};
const unflatten = (a: readonly number[]): Candle[] => {
  const out: Candle[] = [];
  for (let i = 0; i + 5 < a.length; i += 6) out.push({ t: a[i], o: a[i + 1], h: a[i + 2], l: a[i + 3], c: a[i + 4], v: a[i + 5] });
  return out;
};

/** Validates a snapshot read from disk. */
export function isValidSnapshot(s: unknown): s is MarketSnapshot {
  if (!s || typeof s !== 'object') return false;
  const m = s as MarketSnapshot;
  if (m.v !== 1 || !Number.isFinite(m.time) || !Array.isArray(m.x) || m.x.length !== CURRENCIES.length) return false;
  if (!m.x.every(Number.isFinite) || !Number.isFinite(m.lv) || !m.seed || !m.bars) return false;
  for (const inst of INSTRUMENTS) {
    const b = m.bars[inst.symbol];
    if (!b || !Array.isArray(b.h1) || !Array.isArray(b.m1) || b.h1.length % 6 || b.m1.length % 6 || b.h1.length < 6 * 300) return false;
    if (!b.h1.every(Number.isFinite) || !b.m1.every(Number.isFinite)) return false;
  }
  return true;
}

export interface VolEvent {
  t: number;
  ccy: Ccy;
  /** Size of the jump in percent (signed, + means the currency strengthened). */
  pct: number;
}

interface Factor {
  vol: number;
  load: Partial<Record<Ccy, number>>;
}

/** Daily volatilities (fractions). */
const FACTORS: Factor[] = [
  { vol: 0.003, load: { USD: 1 } },
  { vol: 0.005, load: { AUD: 0.8, NZD: 0.8, CAD: 0.45, GBP: 0.2, EUR: 0.1, JPY: -0.7, CHF: -0.4 } },
  { vol: 0.003, load: { EUR: 1, CHF: 0.6, GBP: 0.5 } },
  { vol: 0.0025, load: { AUD: 0.6, NZD: 0.55, CAD: 0.6 } },
];
const IDIO: Record<Ccy, number> = {
  USD: 0.0012,
  EUR: 0.0015,
  GBP: 0.0022,
  JPY: 0.003,
  CHF: 0.002,
  AUD: 0.002,
  CAD: 0.002,
  NZD: 0.0024,
};
const JUMP_RATE_PER_DAY = 0.3;
const JUMP_SIZE = 0.0008;
/**
 * Volatility regime: log-OU process with a compensated jump term (each news jump
 * lifts log-vol by JUMP_VOL_BUMP, offset by a constant downward drift so the mean
 * stays at zero). REGIME_VAR is the stationary variance, used to normalise the
 * regime multiplier to a mean square of ~1.
 */
const REGIME_K = 1.5;
const REGIME_ETA = 0.6;
const JUMP_VOL_BUMP = 0.2;
const TOTAL_JUMP_RATE = 8 * JUMP_RATE_PER_DAY;
const REGIME_VAR =
  (REGIME_ETA * REGIME_ETA) / (2 * REGIME_K) + (JUMP_VOL_BUMP * JUMP_VOL_BUMP * TOTAL_JUMP_RATE) / (2 * REGIME_K);
/** Weekend gap shock, expressed as an equivalent number of trading days of variance. */
const WEEKEND_GAP_DAYS = 0.12;
/** Average tick-volume rate (ticks per second) at a session multiplier of 1. */
const TICKS_PER_SEC = 2;

export const M1_HISTORY_BARS = 3 * 24 * 60;
export const H1_HISTORY_BARS = 250 * 24;
const SUB_M1 = 4;
const SUB_H1 = 12;
/** Live simulation step. */
export const STEP_MS = 250;
const MAX_CATCHUP_STEPS = 20_000;
const MAX_BARS: Record<Timeframe, number> = { M1: 20_000, M5: 10_000, M15: 10_000, H1: 12_000, H4: 6_000, D1: 3_000 };

const NC = CURRENCIES.length;
const CCY_INDEX = Object.fromEntries(CURRENCIES.map((c, i) => [c, i])) as Record<Ccy, number>;
const FACTOR_LOADS: Float64Array[] = FACTORS.map((f) => {
  const a = new Float64Array(NC);
  for (const [c, l] of Object.entries(f.load)) a[CCY_INDEX[c as Ccy]] = l as number;
  return a;
});
const IDIO_ARR = Float64Array.from(CURRENCIES.map((c) => IDIO[c]));

export function spreadPipettes(inst: Instrument, regime: number, t: number): number {
  let s = inst.spread * (0.75 + 0.25 * regime);
  if (isRollover(t)) s *= 4;
  else {
    const h = Math.floor((((t % DAY) + DAY) % DAY) / HOUR);
    if (h >= 21 || h < 1) s *= 1.6;
  }
  return Math.max(1, Math.round(s * 10));
}

/** Integer-pipette bid/ask around a mid price, so ask - bid is exactly the spread. */
export function bidAsk(mid: number, digits: number, pipettes: number): { bid: number; ask: number } {
  const f = 10 ** digits;
  const bidInt = Math.round(mid * f - pipettes / 2);
  return { bid: bidInt / f, ask: (bidInt + pipettes) / f };
}

export class MarketSim {
  readonly seed: MarketSeed;
  readonly instruments: readonly Instrument[] = INSTRUMENTS;
  /** Simulation clock (UTC ms). */
  time: number;
  readonly candles: Record<string, Record<Timeframe, Candle[]>> = {};
  readonly quotes: Record<string, Quote> = {};
  readonly events: VolEvent[] = [];

  private readonly rng: Rng;
  private readonly x = new Float64Array(NC);
  private readonly dx = new Float64Array(NC);
  private lv = 0;
  private live = false;
  /**
   * Follow real FX hours: no price moves from Friday 17:00 to Sunday 17:00 New York, then a
   * weekend gap at the reopen. Turn off only for weekend practice.
   */
  respectHours = true;
  private wasClosed = false;
  private nextChange = 0;
  private readonly bi: Int32Array;
  private readonly qi: Int32Array;

  /**
   * Generates fresh history ending at `now`, or continues from a snapshot (then call
   * advanceTo(Date.now()) to simulate the time the snapshot was not running).
   */
  constructor(seed: MarketSeed, now: number, rngSeed: number, snapshot?: MarketSnapshot) {
    this.seed = snapshot ? snapshot.seed : seed;
    this.rng = new Rng(rngSeed);
    this.bi = Int32Array.from(INSTRUMENTS.map((i) => CCY_INDEX[i.base]));
    this.qi = Int32Array.from(INSTRUMENTS.map((i) => CCY_INDEX[i.quote]));
    if (snapshot) {
      this.time = snapshot.time;
      snapshot.x.forEach((v, c) => (this.x[c] = v));
      this.lv = snapshot.lv;
      for (const inst of INSTRUMENTS) {
        const b = snapshot.bars[inst.symbol];
        const m1 = unflatten(b.m1);
        const h1 = unflatten(b.h1);
        this.candles[inst.symbol] = {
          M1: m1,
          M5: aggregate(m1, 'M5'),
          M15: aggregate(m1, 'M15'),
          H1: h1,
          H4: aggregate(h1, 'H4'),
          D1: aggregate(h1, 'D1'),
        };
      }
      this.live = true;
      this.updateQuotes(this.time, false);
      this.wasClosed = snapshot.wasClosed;
      return;
    }
    const end = Math.floor(now / MIN) * MIN;
    this.time = end;
    this.generateHistory(end);
    this.live = true;
    this.updateQuotes(end, false);
    this.wasClosed = !isFxOpen(end);
  }

  /** A compact copy of the market for saving (last `maxH1` hourly and `maxM1` minute bars). */
  snapshot(maxH1 = 6500, maxM1 = 1440): MarketSnapshot {
    const bars: MarketSnapshot['bars'] = {};
    for (const inst of INSTRUMENTS) {
      const c = this.candles[inst.symbol];
      bars[inst.symbol] = { h1: flatten(c.H1.slice(-maxH1)), m1: flatten(c.M1.slice(-maxM1)) };
    }
    return { v: 1, time: this.time, x: [...this.x], lv: this.lv, wasClosed: this.wasClosed, seed: this.seed, bars };
  }

  /** Whether prices are moving right now. */
  isOpen(): boolean {
    return !this.respectHours || isFxOpen(this.time);
  }

  /** Next open/close instant of the real FX market (cached). */
  private boundary(): number {
    if (this.time >= this.nextChange) this.nextChange = nextFxChange(this.time);
    return this.nextChange;
  }

  /** Current volatility regime multiplier (mean-square 1). */
  regime(): number {
    return Math.exp(this.lv - REGIME_VAR);
  }

  quote(symbol: string): Quote | undefined {
    return this.quotes[symbol];
  }

  readonly mid: MidLookup = (symbol) => this.quotes[symbol]?.mid;

  series(symbol: string, tf: Timeframe): Candle[] {
    return this.candles[symbol][tf];
  }

  /** Units of each currency per USD at the current mid prices (for resuming later). */
  snapshotRates(): Record<Ccy, number> {
    const usd = this.x[CCY_INDEX.USD];
    const out = {} as Record<Ccy, number>;
    for (const c of CURRENCIES) out[c] = Math.exp(usd - this.x[CCY_INDEX[c]]);
    return out;
  }

  /**
   * Advances the simulation clock to `now`, calling `onStep` after every price step.
   * Closed-market time is skipped in one jump (prices stay frozen), and the reopen
   * gets a weekend gap, exactly like the generated history.
   */
  advanceTo(now: number, onStep?: () => void): void {
    for (let guard = 0; guard < 16 && this.time < now; guard++) {
      if (this.respectHours && !isFxOpen(this.time)) {
        this.wasClosed = true;
        const reopen = this.boundary();
        if (reopen > now) {
          this.time = now;
          return;
        }
        this.time = reopen;
      }
      if (this.wasClosed) {
        this.shock(WEEKEND_GAP_DAYS, this.time);
        this.wasClosed = false;
      }
      const close = this.respectHours ? this.boundary() : Infinity;
      const end = Math.min(now, close);
      const closing = end === close;
      const gap = end - this.time;
      if (gap <= 0) continue;
      if (gap < STEP_MS && !closing) return;
      const steps = Math.max(1, Math.min(Math.floor(gap / STEP_MS), MAX_CATCHUP_STEPS));
      const dt = gap / steps;
      for (let i = 0; i < steps; i++) {
        const last = i === steps - 1;
        const t = last ? end : this.time + dt;
        this.shock(dt / DAY, t);
        this.time = t;
        // The tick at the closing bell belongs to the last open bar, not a new one.
        this.updateQuotes(t, true, last && closing ? t - 1 : t);
        onStep?.();
      }
      if (end === now) return;
    }
  }

  // -------------------------------------------------------------------------

  private shock(dtDays: number, t: number): void {
    const rng = this.rng;
    const s = Math.sqrt(dtDays) * sessionMultiplier(t) * this.regime();
    const dx = this.dx;
    dx.fill(0);
    for (let f = 0; f < FACTORS.length; f++) {
      const z = rng.normal() * FACTORS[f].vol * s;
      const load = FACTOR_LOADS[f];
      for (let c = 0; c < NC; c++) dx[c] += load[c] * z;
    }
    for (let c = 0; c < NC; c++) {
      dx[c] += IDIO_ARR[c] * s * rng.normal();
      if (rng.next() < JUMP_RATE_PER_DAY * dtDays) {
        const j = JUMP_SIZE * rng.normal() * (1 + this.regime() * 0.5);
        dx[c] += j;
        this.lv += JUMP_VOL_BUMP;
        if (this.live) {
          this.events.push({ t, ccy: CURRENCIES[c], pct: j * 100 });
          if (this.events.length > 30) this.events.shift();
        }
      }
    }
    for (let c = 0; c < NC; c++) this.x[c] += dx[c];
    this.lv +=
      (-REGIME_K * this.lv - JUMP_VOL_BUMP * TOTAL_JUMP_RATE) * dtDays + REGIME_ETA * Math.sqrt(dtDays) * rng.normal();
  }

  private updateQuotes(t: number, ticks: boolean, candleT = t): void {
    const regime = this.regime();
    for (let p = 0; p < INSTRUMENTS.length; p++) {
      const inst = INSTRUMENTS[p];
      const mid = Math.exp(this.x[this.bi[p]] - this.x[this.qi[p]]);
      const pipettes = spreadPipettes(inst, regime, t);
      const { bid, ask } = bidAsk(mid, inst.digits, pipettes);
      const prev = this.quotes[inst.symbol];
      this.quotes[inst.symbol] = {
        symbol: inst.symbol,
        bid,
        ask,
        mid: (bid + ask) / 2,
        spread: pipettes / 10,
        t,
      };
      if (ticks) {
        const vol = prev && prev.bid !== bid ? 1 : 0;
        const byTf = this.candles[inst.symbol];
        for (const tf of TIMEFRAMES) {
          const series = byTf[tf];
          if (applyTick(series, candleT, bid, tf, vol) && series.length > MAX_BARS[tf]) series.shift();
        }
      }
    }
  }

  /**
   * Builds ~250 trading days of H1 history plus 3 trading days of M1 history ending
   * at `end`, skipping weekend closures, then anchors the path so the final prices
   * equal the seed rates exactly. Higher timeframes are aggregated from these, so
   * every timeframe is consistent with every other.
   */
  private generateHistory(end: number): void {
    const minutes: number[] = [];
    for (let t = end - MIN; ; t -= MIN) {
      if (!isFxOpen(t)) continue;
      minutes.push(t);
      if (minutes.length >= M1_HISTORY_BARS && t % HOUR === 0) break;
    }
    minutes.reverse();
    const hours: number[] = [];
    for (let t = minutes[0] - HOUR; hours.length < H1_HISTORY_BARS; t -= HOUR) {
      if (isFxOpen(t)) hours.push(t);
    }
    hours.reverse();

    const nP = INSTRUMENTS.length;
    const h1Raw: Candle[][] = INSTRUMENTS.map(() => []);
    const m1Raw: Candle[][] = INSTRUMENTS.map(() => []);
    const pairVolFactor = INSTRUMENTS.map(() => 0.7 + 0.6 * this.rng.next());
    const lp = (p: number) => this.x[this.bi[p]] - this.x[this.qi[p]];
    let lastEnd = hours[0];

    const runBar = (t: number, barMs: number, sub: number, out: Candle[][]) => {
      if (t - lastEnd >= HOUR) this.shock(WEEKEND_GAP_DAYS, t);
      const bars: Candle[] = [];
      for (let p = 0; p < nP; p++) {
        const o = lp(p);
        bars.push({ t, o, h: o, l: o, c: o, v: 0 });
      }
      const subMs = barMs / sub;
      let ticks = 0;
      for (let s = 0; s < sub; s++) {
        const ts = t + s * subMs;
        this.shock(subMs / DAY, ts);
        ticks += (subMs / 1000) * TICKS_PER_SEC * sessionMultiplier(ts) * this.regime() * (0.5 + this.rng.next());
        for (let p = 0; p < nP; p++) {
          const v = lp(p);
          const b = bars[p];
          if (v > b.h) b.h = v;
          if (v < b.l) b.l = v;
          b.c = v;
        }
      }
      for (let p = 0; p < nP; p++) {
        bars[p].v = Math.max(1, Math.round(ticks * pairVolFactor[p]));
        out[p].push(bars[p]);
      }
      lastEnd = t + barMs;
    };

    for (const t of hours) runBar(t, HOUR, SUB_H1, h1Raw);
    for (const t of minutes) runBar(t, MIN, SUB_M1, m1Raw);

    // Anchor: shift every currency so the final mids equal the seed rates.
    const k = new Float64Array(NC);
    for (let c = 0; c < NC; c++) {
      k[c] = Math.log(1 / this.seed.rates[CURRENCIES[c]]) - this.x[c];
      this.x[c] += k[c];
    }

    for (let p = 0; p < nP; p++) {
      const inst = INSTRUMENTS[p];
      const off = k[this.bi[p]] - k[this.qi[p]];
      const pipettes = Math.max(1, Math.round(inst.spread * 10));
      const toBid = (v: number) => bidAsk(Math.exp(v + off), inst.digits, pipettes).bid;
      const fix = (bars: Candle[]) => {
        for (const b of bars) {
          b.o = toBid(b.o);
          b.h = toBid(b.h);
          b.l = toBid(b.l);
          b.c = toBid(b.c);
        }
      };
      fix(h1Raw[p]);
      fix(m1Raw[p]);
      const m1 = m1Raw[p];
      const h1 = h1Raw[p].concat(aggregate(m1, 'H1'));
      this.candles[inst.symbol] = {
        M1: m1,
        M5: aggregate(m1, 'M5'),
        M15: aggregate(m1, 'M15'),
        H1: h1,
        H4: aggregate(h1, 'H4'),
        D1: aggregate(h1, 'D1'),
      };
    }
  }
}

/** Validates an external rates object (units per USD) and returns a clean copy, or null. */
export function sanitizeRates(raw: unknown): Record<Ccy, number> | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const out = {} as Record<Ccy, number>;
  for (const c of CURRENCIES) {
    const v = c === 'USD' ? (src.USD ?? 1) : src[c];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    out[c] = v;
  }
  if (Math.abs(out.USD - 1) > 1e-9) {
    const usd = out.USD;
    for (const c of CURRENCIES) out[c] /= usd;
  }
  return out;
}
