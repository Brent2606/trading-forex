import { runBacktest } from './backtest';
import type { Candle } from './candles';
import {
  computeFeatures,
  contextAt,
  coreKey,
  crossover,
  describeGenome,
  entryAllowed,
  genomeId,
  mutate,
  randomGenome,
  strategyById,
  type Features,
  type Genome,
  type TradeContext,
} from './genome';
import { Rng } from './rng';

/**
 * STRATEGY LAB
 *
 * A genetic search over strategy genomes with walk-forward validation:
 *   train   (first 60% of every dataset)  – the only data evolution optimises on
 *   valid.  (next 20%)                    – ranks the hall of fame
 *   holdout (last 20%)                    – never used for ranking; a final honesty gate
 * Results are measured in R (profit / money risked), pooled across all datasets, so a
 * rule must work on many pairs at once. Testing thousands of variants always produces
 * lucky winners; that is why the autopilot still demands live proof before full risk.
 */

export type QuoteConv = { kind: 'one' } | { kind: 'inverse' } | { kind: 'const'; k: number };

export interface Dataset {
  symbol: string;
  candles: Candle[];
  pip: number;
  spreadPips: number;
  conv: QuoteConv;
}

export interface SegmentStats {
  n: number;
  meanR: number;
  sdR: number;
  /** Van Tharp SQN: mean/sd × √min(n, 100). */
  sqn: number;
  /** Sum of winning R / |sum of losing R|. */
  pf: number;
  netR: number;
  winRate: number;
}

export interface Evaluation {
  id: string;
  genome: Genome;
  desc: string;
  train: SegmentStats;
  val: SegmentStats;
  hold: SegmentStats;
  /** Evolution fitness (train only). */
  fitness: number;
  /** Hall-of-fame rank: consistency across train and validation. */
  score: number;
  validated: boolean;
  robust: boolean;
  at: number;
  dataVersion: number;
}

export interface LabStats {
  generation: number;
  tested: number;
  bestScore: number;
  lastImprovement: number;
  dataKind: 'sim' | 'real';
  dataLabel: string;
  bars: number;
  dataVersion: number;
}

export interface LabConfig {
  popSize: number;
  hofSize: number;
  commissionPerLot: number;
  minTrades: number;
}

export const DEFAULT_LAB: LabConfig = { popSize: 24, hofSize: 12, commissionPerLot: 3.5, minTrades: 30 };

export function convFn(c: QuoteConv): (p: number) => number {
  if (c.kind === 'inverse') return (p) => 1 / p;
  if (c.kind === 'const') {
    const k = c.k;
    return () => k;
  }
  return () => 1;
}

export function segmentStats(rs: readonly number[]): SegmentStats {
  const n = rs.length;
  if (n === 0) return { n: 0, meanR: 0, sdR: 0, sqn: 0, pf: NaN, netR: 0, winRate: 0 };
  let sum = 0;
  let win = 0;
  let loss = 0;
  let wins = 0;
  for (const r of rs) {
    sum += r;
    if (r > 0) {
      win += r;
      wins++;
    } else loss -= r;
  }
  const mean = sum / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    meanR: mean,
    sdR: sd,
    sqn: sd > 0 ? (mean / sd) * Math.sqrt(Math.min(n, 100)) : 0,
    pf: loss > 0 ? win / loss : win > 0 ? Infinity : NaN,
    netR: sum,
    winRate: wins / n,
  };
}

export function gates(train: SegmentStats, val: SegmentStats, hold: SegmentStats): { validated: boolean; robust: boolean } {
  const validated = train.meanR > 0 && val.meanR > 0 && val.n >= 20 && val.pf >= 1.1;
  const robust = validated && hold.meanR > 0 && hold.n >= 20 && val.sqn >= 1 && train.sqn >= 1;
  return { validated, robust };
}

/** Extra veto on an entry (used to test "lessons" against history). */
export type ExtraFilter = (ctx: TradeContext) => boolean;

const featureCache = new WeakMap<Candle[], Features>();
export function featuresFor(candles: Candle[]): Features {
  let f = featureCache.get(candles);
  if (!f) {
    f = computeFeatures(candles);
    featureCache.set(candles, f);
  }
  return f;
}

export interface SegmentedR {
  train: number[];
  val: number[];
  hold: number[];
}

/** Runs the genome on every dataset and splits trade R-multiples into the three segments. */
/**
 * Stop slippage used by the lab, in ATR multiples. Calibrated so that random strategies on
 * random (simulated) prices break even before costs instead of showing a false edge.
 */
export let LAB_STOP_SLIP_ATR = 0.2;
export function setLabStopSlip(v: number): void {
  LAB_STOP_SLIP_ATR = v;
}

export function genomeR(g: Genome, datasets: readonly Dataset[], commissionPerLot: number, extra?: ExtraFilter): SegmentedR {
  const out: SegmentedR = { train: [], val: [], hold: [] };
  const strategy = strategyById(g.strategy);
  if (!strategy) return out;
  for (const ds of datasets) {
    const c = ds.candles;
    const n = c.length;
    if (n < 300) continue;
    const f = featuresFor(c);
    const b1 = Math.floor(n * 0.6);
    const b2 = Math.floor(n * 0.8);
    const r = runBacktest({
      candles: c,
      strategy,
      params: g.params,
      pip: ds.pip,
      spreadPips: ds.spreadPips,
      commissionPerLot,
      startBalance: 100_000,
      riskPct: 0.5,
      fixedLots: 0.1,
      slAtr: g.slAtr,
      tpAtr: g.tpAtr,
      exitOnOpposite: g.exitOnOpposite,
      allowLong: true,
      allowShort: true,
      trendFilter: g.trend,
      leverage: 500,
      quoteToUsd: convFn(ds.conv),
      stopSlipAtr: LAB_STOP_SLIP_ATR,
      allowEntry: (i, side) => entryAllowed(g, f, i) && (!extra || extra(contextAt(f, c, i, side))),
    });
    for (const t of r.trades) {
      if (!(t.risk > 0)) continue;
      const R = t.net / t.risk;
      if (!Number.isFinite(R)) continue;
      // Entry happens on the bar after the signal; attribute by the signal bar.
      const i = t.entryIdx - 1;
      (i < b1 ? out.train : i < b2 ? out.val : out.hold).push(R);
    }
  }
  return out;
}

export function evaluateGenome(g: Genome, datasets: readonly Dataset[], cfg: LabConfig, dataVersion = 0): Evaluation {
  const seg = genomeR(g, datasets, cfg.commissionPerLot);
  const train = segmentStats(seg.train);
  const val = segmentStats(seg.val);
  const hold = segmentStats(seg.hold);
  const penalty = train.n < cfg.minTrades ? (cfg.minTrades - train.n) * 0.08 : 0;
  const fitness = train.sqn - penalty;
  const score = train.n < 20 || val.n < 10 ? -Infinity : Math.min(train.sqn, val.sqn);
  return {
    id: genomeId(g),
    genome: g,
    desc: describeGenome(g),
    train,
    val,
    hold,
    fitness,
    score,
    ...gates(train, val, hold),
    at: Date.now(),
    dataVersion,
  };
}

export class Lab {
  readonly cfg: LabConfig;
  stats: LabStats = {
    generation: 0,
    tested: 0,
    bestScore: -Infinity,
    lastImprovement: 0,
    dataKind: 'sim',
    dataLabel: '',
    bars: 0,
    dataVersion: 0,
  };
  readonly blacklist = new Set<string>();
  private readonly rng: Rng;
  private datasets: Dataset[] = [];
  private pop: Evaluation[] = [];
  private queue: Genome[] = [];
  private hofList: Evaluation[] = [];
  private seen = new Set<string>();
  private steps = 0;

  constructor(seed: number, cfg: LabConfig = DEFAULT_LAB) {
    this.rng = new Rng(seed);
    this.cfg = cfg;
  }

  setData(datasets: Dataset[], kind: 'sim' | 'real', label: string): void {
    this.datasets = datasets.filter((d) => d.candles.length >= 300);
    this.stats.dataKind = kind;
    this.stats.dataLabel = label;
    this.stats.bars = this.datasets.reduce((a, d) => a + d.candles.length, 0);
    this.stats.dataVersion++;
  }

  hasData(): boolean {
    return this.datasets.length > 0;
  }

  data(): readonly Dataset[] {
    return this.datasets;
  }

  restore(hof: Evaluation[], stats?: Partial<LabStats>): void {
    this.hofList = hof.filter((e) => e && e.genome && strategyById(e.genome.strategy)).map((e) => ({ ...e, dataVersion: -1 }));
    if (stats) {
      this.stats.generation = stats.generation ?? 0;
      this.stats.tested = stats.tested ?? 0;
      this.stats.bestScore = stats.bestScore ?? -Infinity;
      this.stats.lastImprovement = stats.lastImprovement ?? 0;
    }
    for (const e of this.hofList) this.seen.add(e.id);
  }

  hof(): Evaluation[] {
    return this.hofList;
  }

  ban(id: string): void {
    this.blacklist.add(id);
    this.hofList = this.hofList.filter((e) => e.id !== id);
  }

  /** Evaluates one candidate (or re-checks a stale hall-of-fame entry). Returns null without data. */
  step(): Evaluation | null {
    if (!this.datasets.length) return null;
    this.steps++;
    if (this.steps % 10 === 0) {
      const stale = this.hofList.find((e) => e.dataVersion !== this.stats.dataVersion);
      if (stale) {
        const e = evaluateGenome(stale.genome, this.datasets, this.cfg, this.stats.dataVersion);
        this.hofList = this.hofList.filter((x) => x.id !== stale.id);
        this.addToHof(e);
        return e;
      }
    }
    if (!this.queue.length) this.breed();
    const g = this.queue.shift()!;
    const e = evaluateGenome(g, this.datasets, this.cfg, this.stats.dataVersion);
    this.stats.tested++;
    this.pop.push(e);
    this.addToHof(e);
    return e;
  }

  private addToHof(e: Evaluation): void {
    if (this.blacklist.has(e.id) || !(e.score > 0) || e.train.meanR <= 0) return;
    // One entry per signal rule keeps the leaderboard diverse instead of 12 near-copies.
    const key = coreKey(e.genome);
    const twin = this.hofList.find((x) => x.id !== e.id && coreKey(x.genome) === key);
    if (twin && twin.score >= e.score) return;
    this.hofList = this.hofList.filter((x) => x.id !== e.id && x !== twin);
    this.hofList.push(e);
    this.hofList.sort((a, b) => b.score - a.score);
    this.hofList.length = Math.min(this.hofList.length, this.cfg.hofSize);
    if (e.score > this.stats.bestScore && this.hofList.includes(e)) {
      this.stats.bestScore = e.score;
      this.stats.lastImprovement = Date.now();
    }
  }

  private fresh(g: Genome): Genome {
    let x = g;
    for (let k = 0; k < 6 && (this.seen.has(genomeId(x)) || this.blacklist.has(genomeId(x))); k++) x = mutate(x, this.rng, 0.5);
    if (this.seen.size > 20_000) this.seen.clear();
    this.seen.add(genomeId(x));
    return x;
  }

  private breed(): void {
    const size = this.cfg.popSize;
    if (this.pop.length < size) {
      // First generation: random genomes plus mutations of the restored hall of fame.
      for (const e of this.hofList.slice(0, 4)) this.queue.push(this.fresh(mutate(e.genome, this.rng)));
      while (this.queue.length < size) this.queue.push(this.fresh(randomGenome(this.rng)));
      if (this.stats.generation === 0) this.stats.generation = 1;
      return;
    }
    this.stats.generation++;
    const ranked = [...this.pop].sort((a, b) => b.fitness - a.fitness);
    const parents = [...ranked.slice(0, Math.ceil(size / 2)), ...this.hofList];
    const tournament = (): Genome => {
      let best: Evaluation | null = null;
      for (let k = 0; k < 3; k++) {
        const c = parents[Math.floor(this.rng.next() * parents.length) % parents.length];
        if (!best || c.fitness > best.fitness) best = c;
      }
      return best!.genome;
    };
    for (let k = 0; k < size; k++) {
      const roll = this.rng.next();
      let child: Genome;
      if (roll < 0.15) child = randomGenome(this.rng);
      else if (roll < 0.5) child = mutate(crossover(tournament(), tournament(), this.rng), this.rng, 0.2);
      else child = mutate(tournament(), this.rng);
      this.queue.push(this.fresh(child));
    }
    this.pop = ranked.slice(0, Math.ceil(size / 2));
  }
}

/**
 * Tests a lesson ("avoid trades in condition X") against history: compares the total R
 * on validation + holdout data with and without the veto. The lesson is confirmed only
 * when the vetoed trades lost money in history too.
 */
export function checkLessonOnHistory(
  genomes: readonly Genome[],
  datasets: readonly Dataset[],
  commissionPerLot: number,
  blocks: (ctx: TradeContext) => boolean,
): { before: number; after: number; removed: number } {
  // before - after = the total R of the trades the lesson would have vetoed.
  let before = 0;
  let after = 0;
  let nBefore = 0;
  let nAfter = 0;
  for (const g of genomes) {
    const a = genomeR(g, datasets, commissionPerLot);
    const b = genomeR(g, datasets, commissionPerLot, (ctx) => !blocks(ctx));
    for (const r of [...a.val, ...a.hold]) {
      before += r;
      nBefore++;
    }
    for (const r of [...b.val, ...b.hold]) {
      after += r;
      nAfter++;
    }
  }
  return { before, after, removed: nBefore - nAfter };
}

/** Lesson validator shared by the browser worker and the 24/7 bot. */
export function validateLessonOnHistory(
  genomes: readonly Genome[],
  datasets: readonly Dataset[],
  commissionPerLot: number,
  blocks: (ctx: TradeContext) => boolean,
): { ok: boolean; detail: string } {
  if (!genomes.length || !datasets.length) return { ok: false, detail: 'No strategies or history to check against' };
  const { before, after, removed } = checkLessonOnHistory(genomes, datasets, commissionPerLot, blocks);
  const vetoed = before - after;
  if (removed < 10) return { ok: false, detail: `History has only ${removed} such trades: not enough to confirm` };
  return vetoed < 0
    ? { ok: true, detail: `History agrees: those ${removed} trades lost ${vetoed.toFixed(1)}R in total` }
    : { ok: false, detail: `History disagrees: those ${removed} trades made ${vetoed >= 0 ? '+' : ''}${vetoed.toFixed(1)}R in total` };
}
