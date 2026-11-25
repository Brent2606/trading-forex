import type { ClosedTrade, Position, TradingEngine } from './account';
import type { Candle, Timeframe } from './candles';
import { atr } from './indicators';
import { ALL_SESSIONS, computeFeatures, contextAt, coreKey, describeGenome, SESSION_NAMES, signalAt, VOL_NAMES, type Genome, type TradeContext } from './genome';
import { findInstrument, getInstrument, INSTRUMENTS, lotsToUnits } from './instruments';
import type { Evaluation } from './lab';
import { pipValuePerLot, type MidLookup, type Quote } from './rates';
import { lotsForRisk } from './risk';

/**
 * AUTOPILOT
 *
 * Trades the lab's best genomes on the paper account and learns from the outcome:
 *  1. Deploy:   strategies start on PROBATION at reduced risk.
 *  2. Promote:  after ≥15 live trades with a positive average R they go ACTIVE at full risk,
 *               scaled by how well they do.
 *  3. Bench:    a significantly negative live record, 7 losses in a row or a 10R drawdown
 *               benches the strategy for good (and the lab will never propose it again).
 *  4. Lessons:  losing trades are journaled with their context (session, volatility, trend,
 *               spread). When losses cluster in one condition, a lesson ("avoid X") is
 *               proposed, tested against history, and only adopted if history agrees.
 *               Lessons expire after 21 days so stale beliefs do not pile up.
 */

export interface AutopilotConfig {
  /** Place trades automatically. */
  enabled: boolean;
  /** Keep the strategy lab searching. */
  lab: boolean;
  /** strict: deploy only strategies that pass every historical test incl. holdout. explore: validated ones. */
  mode: 'strict' | 'explore';
  riskPct: number;
  probationRiskPct: number;
  maxDeployments: number;
  maxOpen: number;
  maxPerCurrency: number;
  tf: Timeframe;
  universe: string[];
  labData: 'sim' | 'csv';
}

export interface LiveStats {
  n: number;
  sumR: number;
  sumR2: number;
  wins: number;
  net: number;
  consecLoss: number;
  cumR: number;
  peakR: number;
  maxDdR: number;
}

export interface Deployment {
  id: string;
  genome: Genome;
  desc: string;
  expected: { valMeanR: number; holdMeanR: number; score: number; robust: boolean };
  since: number;
  status: 'probation' | 'active' | 'benched';
  note: string;
  live: LiveStats;
}

export interface JournalEntry {
  positionId: number;
  dep: string;
  symbol: string;
  side: 'buy' | 'sell';
  openTime: number;
  closeTime: number;
  r: number;
  net: number;
  reason: string;
  ctx: TradeContext;
}

export type LessonKey = { f: 'session'; v: number } | { f: 'vol'; v: number } | { f: 'trend'; v: false } | { f: 'spread'; v: true };

export interface Lesson {
  id: string;
  key: LessonKey;
  label: string;
  n: number;
  meanR: number;
  restMeanR: number;
  t: number;
  status: 'pending' | 'active' | 'rejected' | 'expired';
  createdAt: number;
  detail: string;
}

export interface AutopilotState {
  version: 1;
  config: AutopilotConfig;
  deployments: Deployment[];
  retired: Deployment[];
  owned: Record<string, { dep: string; ctx: TradeContext }>;
  journal: JournalEntry[];
  lessons: Lesson[];
  lastBar: Record<string, number>;
  blacklist: string[];
  counters: { signals: number; orders: number; rejected: number; skipped: number; vetoed: number };
  /** Last time a probation strategy was swapped for a stronger candidate. */
  lastSwap: number;
}

export type ApLogKind = 'ok' | 'warn' | 'err' | 'info';

export interface AutopilotDeps {
  engine: TradingEngine;
  series(symbol: string, tf: Timeframe): readonly Candle[];
  quote(symbol: string): Quote | undefined;
  mid: MidLookup;
  now(): number;
  /** Tests a lesson against historical data. */
  validate(lesson: Lesson, genomes: Genome[]): Promise<{ ok: boolean; detail: string }>;
  log(msg: string, kind: ApLogKind): void;
}

export const DEFAULT_AUTOPILOT: AutopilotConfig = {
  enabled: false,
  lab: true,
  mode: 'explore',
  riskPct: 0.5,
  probationRiskPct: 0.25,
  maxDeployments: 3,
  maxOpen: 6,
  maxPerCurrency: 3,
  tf: 'H1',
  universe: INSTRUMENTS.map((i) => i.symbol),
  labData: 'sim',
};

const COUNTABLE = new Set(['sl', 'tp', 'trail', 'signal', 'stopout', 'guard']);
const JOURNAL_CAP = 600;
const LESSON_TTL = 21 * 86_400_000;
const MAX_ACTIVE_LESSONS = 4;
const SLICE = 900;
/** The lab must have tested this many strategies before anything is deployed. */
export const MIN_TESTED_BEFORE_DEPLOY = 150;
const SWAP_EVERY = 10 * 60_000;

export function emptyLive(): LiveStats {
  return { n: 0, sumR: 0, sumR2: 0, wins: 0, net: 0, consecLoss: 0, cumR: 0, peakR: 0, maxDdR: 0 };
}

export function freshAutopilotState(config: Partial<AutopilotConfig> = {}): AutopilotState {
  return {
    version: 1,
    config: { ...DEFAULT_AUTOPILOT, ...config },
    deployments: [],
    retired: [],
    owned: {},
    journal: [],
    lessons: [],
    lastBar: {},
    blacklist: [],
    counters: { signals: 0, orders: 0, rejected: 0, skipped: 0, vetoed: 0 },
    lastSwap: 0,
  };
}

export function parseAutopilotState(raw: unknown): AutopilotState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as AutopilotState;
  if (s.version !== 1 || !Array.isArray(s.deployments) || !Array.isArray(s.journal)) return null;
  const fresh = freshAutopilotState();
  const universe = Array.isArray(s.config?.universe) ? s.config.universe.filter((x) => findInstrument(x)) : fresh.config.universe;
  return {
    ...fresh,
    ...s,
    config: { ...fresh.config, ...(s.config ?? {}), universe: universe.length ? universe : fresh.config.universe },
    retired: Array.isArray(s.retired) ? s.retired : [],
    owned: s.owned && typeof s.owned === 'object' ? s.owned : {},
    lessons: Array.isArray(s.lessons) ? s.lessons : [],
    lastBar: s.lastBar && typeof s.lastBar === 'object' ? s.lastBar : {},
    blacklist: Array.isArray(s.blacklist) ? s.blacklist : [],
    counters: { ...fresh.counters, ...(s.counters ?? {}) },
    lastSwap: typeof s.lastSwap === 'number' ? s.lastSwap : 0,
  };
}

export function lessonLabel(k: LessonKey): string {
  switch (k.f) {
    case 'session':
      return `Avoid entries in the ${SESSION_NAMES[k.v]} session`;
    case 'vol':
      return `Avoid entries in ${VOL_NAMES[k.v]} volatility`;
    case 'trend':
      return 'Avoid trades against the 200 EMA';
    case 'spread':
      return 'Avoid entries when the spread is wide';
  }
}

export function lessonMatches(k: LessonKey, ctx: TradeContext): boolean {
  switch (k.f) {
    case 'session':
      return ctx.session === k.v;
    case 'vol':
      return ctx.vol === k.v;
    case 'trend':
      return !ctx.withTrend;
    case 'spread':
      return ctx.wideSpread;
  }
}

const lessonId = (k: LessonKey) => `${k.f}:${String(k.v)}`;

function addLive(l: LiveStats, r: number, net: number): void {
  l.n++;
  l.sumR += r;
  l.sumR2 += r * r;
  l.net += net;
  if (r > 0) {
    l.wins++;
    l.consecLoss = 0;
  } else l.consecLoss++;
  l.cumR += r;
  l.peakR = Math.max(l.peakR, l.cumR);
  l.maxDdR = Math.max(l.maxDdR, l.peakR - l.cumR);
}

export function liveMean(l: LiveStats): number {
  return l.n ? l.sumR / l.n : 0;
}

/** t-statistic of the live mean R against zero. */
export function liveT(l: LiveStats): number {
  if (l.n < 2) return 0;
  const mean = l.sumR / l.n;
  const variance = (l.sumR2 - l.n * mean * mean) / (l.n - 1);
  const sd = Math.sqrt(Math.max(variance, 1e-12));
  return mean / (sd / Math.sqrt(l.n));
}

export class Autopilot {
  state: AutopilotState;
  private readonly deps: AutopilotDeps;
  private sinceLearn = 0;
  private learning: Promise<void> | null = null;
  private rerun = false;

  constructor(state: AutopilotState, deps: AutopilotDeps) {
    this.state = state;
    this.deps = deps;
  }

  get config(): AutopilotConfig {
    return this.state.config;
  }

  liveDeployments(): Deployment[] {
    return this.state.deployments.filter((d) => d.status !== 'benched');
  }

  /** Money risked per trade (% of equity) for a deployment. */
  riskFor(d: Deployment): number {
    const c = this.config;
    if (d.status === 'probation') return c.probationRiskPct;
    const m = liveMean(d.live);
    const w = Math.min(1.5, Math.max(0.5, 1 + m * (Math.min(d.live.n, 30) / 30)));
    return Math.round(c.riskPct * w * 100) / 100;
  }

  /** Hall-of-fame entries this mode is allowed to deploy. */
  eligible(hof: readonly Evaluation[]): Evaluation[] {
    const banned = new Set(this.state.blacklist);
    const deployed = new Set(this.state.deployments.map((d) => d.id));
    return hof.filter((e) => !banned.has(e.id) && !deployed.has(e.id) && (this.config.mode === 'strict' ? e.robust : e.validated));
  }

  /**
   * Fills free deployment slots from the lab's hall of fame (best first), and swaps an
   * untested probation strategy for a clearly stronger candidate at most every 10 minutes.
   */
  sync(hof: readonly Evaluation[], tested = Infinity): void {
    if (tested < MIN_TESTED_BEFORE_DEPLOY) return;
    const st = this.state;
    // Retire benched deployments once their positions are closed.
    for (const d of [...st.deployments]) {
      if (d.status !== 'benched') continue;
      if (Object.values(st.owned).some((o) => o.dep === d.id)) continue;
      st.deployments.splice(st.deployments.indexOf(d), 1);
      st.retired.unshift(d);
      st.retired.length = Math.min(st.retired.length, 12);
    }
    const live = this.liveDeployments();
    let free = this.config.maxDeployments - live.length;
    const eligible = this.eligible(hof);
    if (free <= 0) {
      this.maybeSwap(eligible);
      return;
    }
    const deployed = new Set(st.deployments.map((d) => d.id));
    // Prefer variety: first one genome per strategy family, then fill remaining slots.
    const families = new Set(live.map((d) => d.genome.strategy));
    const deploy = (e: Evaluation) => {
      const d: Deployment = {
        id: e.id,
        genome: e.genome,
        desc: describeGenome(e.genome),
        expected: { valMeanR: e.val.meanR, holdMeanR: e.hold.meanR, score: e.score, robust: e.robust },
        since: this.deps.now(),
        status: 'probation',
        note: e.robust ? 'Passed every historical test; now proving itself live' : 'Validated in history, not on the holdout; small risk',
        live: emptyLive(),
      };
      st.deployments.push(d);
      deployed.add(d.id);
      families.add(d.genome.strategy);
      free--;
      this.deps.log(`AUTOPILOT deployed ${d.desc} on probation (${this.config.probationRiskPct}% risk)`, 'info');
    };
    const cores = new Set(live.map((d) => coreKey(d.genome)));
    for (const sameFamily of [false, true]) {
      for (const e of eligible) {
        if (free <= 0) return;
        if (deployed.has(e.id) || cores.has(coreKey(e.genome)) || (!sameFamily && families.has(e.genome.strategy))) continue;
        cores.add(coreKey(e.genome));
        deploy(e);
      }
    }
  }

  private maybeSwap(eligible: Evaluation[]): void {
    const now = this.deps.now();
    const best = eligible[0];
    if (!best || now - this.state.lastSwap < SWAP_EVERY) return;
    const replaceable = this.liveDeployments()
      .filter((d) => d.status === 'probation' && d.live.n < 5 && this.openOf(d.id).length === 0)
      .sort((a, b) => a.expected.score - b.expected.score)[0];
    if (!replaceable || best.score < replaceable.expected.score * 1.25 + 0.1) return;
    replaceable.status = 'benched';
    replaceable.note = `Replaced by a stronger candidate (score ${best.score.toFixed(2)} vs ${replaceable.expected.score.toFixed(2)})`;
    this.state.lastSwap = now;
    this.deps.log(`AUTOPILOT upgrade: ${replaceable.desc} makes room for a stronger candidate`, 'info');
    this.sync([best]);
  }

  private openOf(depId: string): Position[] {
    const owned = this.state.owned;
    return this.deps.engine.state.positions.filter((p) => owned[String(p.id)]?.dep === depId);
  }

  private autopilotPositions(): Position[] {
    const owned = this.state.owned;
    return this.deps.engine.state.positions.filter((p) => owned[String(p.id)]);
  }

  /** Call after every price update. Acts once per newly closed bar of the configured timeframe. */
  onTick(): void {
    const c = this.config;
    if (!c.enabled) return;
    const live = this.liveDeployments();
    for (const symbol of c.universe) {
      const series = this.deps.series(symbol, c.tf);
      if (series.length < 300) continue;
      const closed = series[series.length - 2];
      const key = `${symbol}:${c.tf}`;
      const seen = this.state.lastBar[key];
      if (seen === closed.t) continue;
      this.state.lastBar[key] = closed.t;
      // On first sight, just remember the bar: acting on an old bar would enter late.
      if (seen === undefined || !live.length) continue;
      this.onBar(symbol, series.slice(Math.max(0, series.length - 1 - SLICE), series.length - 1), live);
    }
  }

  private onBar(symbol: string, slice: Candle[], live: Deployment[]): void {
    const inst = getInstrument(symbol);
    const f = computeFeatures(slice);
    const i = slice.length - 1;
    const a = atr(slice, 14)[i];
    const q = this.deps.quote(symbol);
    if (!q || !Number.isFinite(a)) return;
    for (const d of live) {
      const side = signalAt(d.genome, slice, f, i);
      // Exits on an opposite signal.
      if (d.genome.exitOnOpposite) {
        const raw = signalAt({ ...d.genome, trend: 0, sessions: ALL_SESSIONS, vol: 0 }, slice, f, i);
        for (const p of this.openOf(d.id)) {
          if (p.symbol === symbol && raw && raw !== p.side) {
            const r = this.deps.engine.close(p.id, undefined, 'signal');
            if (r.ok) this.deps.log(`AUTOPILOT exit #${p.id} ${symbol} on opposite signal (${d.desc})`, 'info');
          }
        }
      }
      if (!side) continue;
      this.state.counters.signals++;
      const ctx = contextAt(f, slice, i, side, q.spread > inst.spread * 1.5);
      const veto = this.state.lessons.find((l) => l.status === 'active' && lessonMatches(l.key, ctx));
      if (veto) {
        this.state.counters.vetoed++;
        this.deps.log(`AUTOPILOT skipped ${side.toUpperCase()} ${symbol}: lesson "${veto.label}"`, 'info');
        continue;
      }
      const why = this.blockReason(d, symbol, side);
      if (why) {
        this.state.counters.skipped++;
        this.deps.log(`AUTOPILOT skipped ${side.toUpperCase()} ${symbol}: ${why}`, 'info');
        continue;
      }
      const slPips = Math.round(((d.genome.slAtr * a) / inst.pip) * 10) / 10;
      const tpPips = d.genome.tpAtr > 0 ? Math.round(((d.genome.tpAtr * a) / inst.pip) * 10) / 10 : null;
      const risk = this.riskFor(d);
      const lots = lotsForRisk({
        equity: this.deps.engine.metrics().equity,
        riskPct: risk,
        slPips,
        pipValuePerLot: pipValuePerLot(inst, this.deps.mid),
        commissionPerLotRoundTrip: 2 * this.deps.engine.state.settings.commissionPerLot,
      });
      if (lots <= 0) {
        this.state.counters.skipped++;
        this.deps.log(`AUTOPILOT skipped ${symbol}: ${risk}% risk is below 0.01 lots with a ${slPips}-pip stop`, 'warn');
        continue;
      }
      const r = this.deps.engine.submit({ symbol, side, units: lotsToUnits(lots), type: 'market', slPips, tpPips });
      if (!r.ok) {
        this.state.counters.rejected++;
        this.deps.log(`AUTOPILOT order rejected (${symbol}): ${r.error}`, 'warn');
        continue;
      }
      this.state.counters.orders++;
      this.state.owned[String(r.value.id)] = { dep: d.id, ctx };
    }
  }

  /** Portfolio-level checks before a new autopilot trade. */
  private blockReason(d: Deployment, symbol: string, side: 'buy' | 'sell'): string | null {
    const c = this.config;
    const mine = this.autopilotPositions();
    if (this.openOf(d.id).some((p) => p.symbol === symbol)) return 'already in a trade on this pair';
    if (mine.length >= c.maxOpen) return `max ${c.maxOpen} autopilot positions open`;
    if (mine.some((p) => p.symbol === symbol && p.side !== side)) return 'another strategy holds the opposite side';
    const inst = getInstrument(symbol);
    const dir = side === 'buy' ? 1 : -1;
    const exposure = new Map<string, number>();
    for (const p of mine) {
      const pi = getInstrument(p.symbol);
      const pd = p.side === 'buy' ? 1 : -1;
      exposure.set(pi.base, (exposure.get(pi.base) ?? 0) + pd);
      exposure.set(pi.quote, (exposure.get(pi.quote) ?? 0) - pd);
    }
    for (const [ccy, add] of [
      [inst.base, dir],
      [inst.quote, -dir],
    ] as const) {
      const next = (exposure.get(ccy) ?? 0) + add;
      if (Math.abs(next) > c.maxPerCurrency) return `${ccy} exposure would exceed ${c.maxPerCurrency} positions`;
    }
    return null;
  }

  /** Call for every closed trade (the engine's close event). */
  onClose(t: ClosedTrade): void {
    const key = String(t.positionId);
    const own = this.state.owned[key];
    if (!own) return;
    if (!this.deps.engine.state.positions.some((p) => p.id === t.positionId)) delete this.state.owned[key];
    const dep = [...this.state.deployments, ...this.state.retired].find((d) => d.id === own.dep);
    if (!COUNTABLE.has(t.reason) || t.r === null || !Number.isFinite(t.r)) {
      this.deps.log(`AUTOPILOT #${t.positionId} closed by hand (${t.reason}); not counted in learning`, 'info');
      return;
    }
    this.state.journal.push({
      positionId: t.positionId,
      dep: own.dep,
      symbol: t.symbol,
      side: t.side,
      openTime: t.openTime,
      closeTime: t.closeTime,
      r: t.r,
      net: t.net,
      reason: t.reason,
      ctx: own.ctx,
    });
    if (this.state.journal.length > JOURNAL_CAP) this.state.journal.splice(0, this.state.journal.length - JOURNAL_CAP);
    if (dep) {
      addLive(dep.live, t.r, t.net);
      this.judge(dep);
    }
    if (++this.sinceLearn >= 10) {
      this.sinceLearn = 0;
      void this.learn();
    }
  }

  /** Promotion and benching rules. */
  judge(d: Deployment): void {
    if (d.status === 'benched') return;
    const l = d.live;
    const mean = liveMean(l);
    const t = liveT(l);
    let bench = '';
    if (l.n >= 8 && t <= -1.3) bench = `live average ${mean.toFixed(2)}R over ${l.n} trades is significantly negative`;
    else if (l.consecLoss >= 7) bench = `${l.consecLoss} losses in a row`;
    else if (l.maxDdR >= 10) bench = `drawdown of ${l.maxDdR.toFixed(1)}R`;
    if (bench) {
      d.status = 'benched';
      d.note = `Benched: ${bench}`;
      if (!this.state.blacklist.includes(d.id)) this.state.blacklist.push(d.id);
      this.deps.log(`AUTOPILOT benched ${d.desc}: ${bench}`, 'warn');
      return;
    }
    if (d.status === 'probation' && l.n >= 15 && mean > 0) {
      d.status = 'active';
      d.note = `Promoted: +${mean.toFixed(2)}R average over ${l.n} live trades`;
      this.deps.log(`AUTOPILOT promoted ${d.desc} to full risk (${d.note})`, 'ok');
    }
  }

  /** Looks for conditions where losses cluster and proposes lessons. */
  learn(): Promise<void> {
    // A request during a running pass (e.g. while history is being checked) schedules one
    // more pass, so trades that closed in the meantime are never ignored.
    if (this.learning) {
      this.rerun = true;
      return this.learning;
    }
    this.learning = (async () => {
      try {
        do {
          this.rerun = false;
          await this.learnInner();
        } while (this.rerun);
      } finally {
        this.learning = null;
      }
    })();
    return this.learning;
  }

  private async learnInner(): Promise<void> {
    const st = this.state;
    const now = this.deps.now();
    for (const l of st.lessons) {
      if (l.status === 'active' && now - l.createdAt > LESSON_TTL) {
        l.status = 'expired';
        this.deps.log(`AUTOPILOT lesson expired, will be re-learned if still true: ${l.label}`, 'info');
      }
    }
    const entries = st.journal.slice(-300);
    if (entries.length < 25) return;
    const keys: LessonKey[] = [
      ...SESSION_NAMES.map((_, v) => ({ f: 'session', v }) as LessonKey),
      { f: 'vol', v: 0 },
      { f: 'vol', v: 1 },
      { f: 'vol', v: 2 },
      { f: 'trend', v: false },
      { f: 'spread', v: true },
    ];
    for (const key of keys) {
      const id = lessonId(key);
      if (st.lessons.some((l) => l.id === id && (l.status === 'active' || l.status === 'pending'))) continue;
      if (st.lessons.filter((l) => l.status === 'active' || l.status === 'pending').length >= MAX_ACTIVE_LESSONS) break;
      const S = entries.filter((e) => lessonMatches(key, e.ctx)).map((e) => e.r);
      const R = entries.filter((e) => !lessonMatches(key, e.ctx)).map((e) => e.r);
      if (S.length < 8 || R.length < 8) continue;
      const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      const v = (a: number[], mu: number) => a.reduce((x, y) => x + (y - mu) ** 2, 0) / (a.length - 1);
      const mS = m(S);
      const mR = m(R);
      const se = Math.sqrt(v(S, mS) / S.length + v(R, mR) / R.length) || 1e-9;
      const t = (mS - mR) / se;
      if (!(mS < -0.15 && t <= -1.5)) continue;
      const lesson: Lesson = {
        id,
        key,
        label: lessonLabel(key),
        n: S.length,
        meanR: mS,
        restMeanR: mR,
        t,
        status: 'pending',
        createdAt: now,
        detail: `Live: ${S.length} trades averaged ${mS.toFixed(2)}R vs ${mR.toFixed(2)}R otherwise`,
      };
      st.lessons = st.lessons.filter((l) => l.id !== id);
      st.lessons.unshift(lesson);
      st.lessons.length = Math.min(st.lessons.length, 20);
      this.deps.log(`AUTOPILOT suspects a pattern: ${lesson.label} (${lesson.detail}). Checking history...`, 'info');
      if (key.f === 'spread') {
        // History has no spread data: require stronger live evidence instead.
        const ok = t <= -2;
        this.settle(lesson, ok, ok ? 'Strong live evidence (history has no spread data)' : 'Not enough live evidence yet');
        continue;
      }
      const genomes = this.liveDeployments().map((d) => d.genome);
      try {
        const res = await this.deps.validate(lesson, genomes.length ? genomes : this.state.retired.slice(0, 3).map((d) => d.genome));
        this.settle(lesson, res.ok, res.detail);
      } catch (e) {
        this.settle(lesson, false, `Could not check history: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private settle(l: Lesson, ok: boolean, detail: string): void {
    l.status = ok ? 'active' : 'rejected';
    l.detail = `${l.detail}. ${detail}`;
    l.createdAt = this.deps.now();
    this.deps.log(`AUTOPILOT ${ok ? 'learned' : 'rejected'}: ${l.label}. ${detail}`, ok ? 'ok' : 'info');
  }
}
