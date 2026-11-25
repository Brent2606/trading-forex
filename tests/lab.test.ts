import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/core/backtest';
import {
  ALL_SESSIONS,
  computeFeatures,
  coreKey,
  crossover,
  describeGenome,
  entryAllowed,
  genomeId,
  mutate,
  normalize,
  randomGenome,
  SEARCH,
  sessionBucket,
  signalAt,
  strategyById,
  type Genome,
} from '../src/core/genome';
import { FALLBACK_RATES } from '../src/core/instruments';
import {
  checkLessonOnHistory,
  DEFAULT_LAB,
  evaluateGenome,
  gates,
  Lab,
  segmentStats,
  validateLessonOnHistory,
  type Dataset,
} from '../src/core/lab';
import { MarketSim } from '../src/core/market';
import { Rng } from '../src/core/rng';

const sim = new MarketSim({ rates: FALLBACK_RATES, source: 'builtin', label: 't' }, Date.UTC(2026, 10, 25, 12), 77);
const datasets: Dataset[] = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'].map((s) => ({
  symbol: s,
  candles: sim.candles[s].H1.slice(-2500),
  pip: s.endsWith('JPY') ? 0.01 : 0.0001,
  spreadPips: 1,
  conv: s.startsWith('USD') ? { kind: 'inverse' } : { kind: 'one' },
}));

describe('genome', () => {
  const rng = new Rng(5);
  it('random genomes are normalised and inside the search space', () => {
    for (let k = 0; k < 300; k++) {
      const g = randomGenome(rng);
      expect(normalize(g)).toEqual(g);
      for (const [p, [min, max]] of Object.entries(SEARCH[g.strategy])) {
        expect(g.params[p]).toBeGreaterThanOrEqual(min);
        expect(g.params[p]).toBeLessThanOrEqual(max);
      }
      if (g.strategy === 'ema-cross' || g.strategy === 'macd-cross') expect(g.params.fast).toBeLessThan(g.params.slow - 2);
      expect(g.sessions).toBeGreaterThan(0);
      expect(g.slAtr).toBeGreaterThanOrEqual(0.8);
      expect(strategyById(g.strategy)).toBeDefined();
    }
  });

  it('mutation changes the genome and keeps it valid', () => {
    let changed = 0;
    for (let k = 0; k < 100; k++) {
      const g = randomGenome(rng);
      const m = mutate(g, rng);
      expect(normalize(m)).toEqual(m);
      if (genomeId(m) !== genomeId(g)) changed++;
    }
    expect(changed).toBeGreaterThan(90);
  });

  it('crossover mixes parents of the same family', () => {
    const a = normalize({ strategy: 'donchian', params: { period: 10 }, slAtr: 1, tpAtr: 2, trend: 0, exitOnOpposite: true, sessions: ALL_SESSIONS, vol: 0 });
    const b = normalize({ strategy: 'donchian', params: { period: 90 }, slAtr: 3, tpAtr: 0, trend: 200, exitOnOpposite: false, sessions: 1, vol: 2 });
    const seen = new Set<number>();
    for (let k = 0; k < 40; k++) seen.add(crossover(a, b, rng).params.period);
    expect([...seen].sort()).toEqual([10, 90]);
    const c = normalize({ ...a, strategy: 'rsi-revert', params: { period: 14, lower: 30, upper: 70 } });
    expect(crossover(c, a, rng).strategy).toBe('rsi-revert');
  });

  it('ids are stable and content based', () => {
    const g = randomGenome(new Rng(1));
    expect(genomeId(g)).toBe(genomeId(JSON.parse(JSON.stringify(g))));
    expect(genomeId({ ...g, slAtr: g.slAtr + 0.1 })).not.toBe(genomeId(g));
    expect(describeGenome(g).length).toBeGreaterThan(5);
  });

  it('session buckets (UTC)', () => {
    const at = (h: number) => sessionBucket(Date.UTC(2026, 0, 5, h));
    expect([0, 6, 7, 11, 12, 15, 16, 20, 21, 23].map(at)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('features: volatility bands and sessions', () => {
    const f = computeFeatures(datasets[0].candles);
    const counts = [0, 0, 0];
    for (const v of f.vol) counts[v]++;
    expect(counts[0]).toBeGreaterThan(300);
    expect(counts[2]).toBeGreaterThan(300);
    expect(f.session[100]).toBe(sessionBucket(datasets[0].candles[100].t));
  });

  it('live signals match the backtester entries exactly', () => {
    const r2 = new Rng(11);
    let checked = 0;
    for (let k = 0; k < 12; k++) {
      const g = { ...randomGenome(r2), exitOnOpposite: false };
      const c = datasets[k % datasets.length].candles;
      const f = computeFeatures(c);
      const strat = strategyById(g.strategy)!;
      const sig = strat.signals(c, g.params);
      const bt = runBacktest({
        candles: c,
        strategy: strat,
        params: g.params,
        pip: datasets[k % datasets.length].pip,
        spreadPips: 1,
        commissionPerLot: 0,
        startBalance: 100_000,
        riskPct: 0.5,
        fixedLots: 0.1,
        slAtr: g.slAtr,
        tpAtr: g.tpAtr,
        exitOnOpposite: false,
        allowLong: true,
        allowShort: true,
        trendFilter: g.trend,
        leverage: 500,
        quoteToUsd: () => 1,
        allowEntry: (i) => entryAllowed(g, f, i),
      });
      for (const t of bt.trades) {
        expect(signalAt(g, c, f, t.entryIdx - 1, sig)).toBe(t.side);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('lab statistics', () => {
  it('segment stats', () => {
    const s = segmentStats([1, -1, 2, -1]);
    expect(s.n).toBe(4);
    expect(s.meanR).toBe(0.25);
    expect(s.netR).toBe(1);
    expect(s.pf).toBe(1.5);
    expect(s.winRate).toBe(0.5);
    expect(s.sdR).toBeCloseTo(Math.sqrt((0.75 ** 2 + 1.25 ** 2 + 1.75 ** 2 + 1.25 ** 2) / 3), 12);
    expect(s.sqn).toBeCloseTo((0.25 / s.sdR) * 2, 12);
    expect(segmentStats([]).n).toBe(0);
  });

  it('gates', () => {
    const good = { ...segmentStats(Array.from({ length: 40 }, (_, i) => (i % 3 ? 1 : -1))) };
    const bad = segmentStats(Array.from({ length: 40 }, (_, i) => (i % 3 ? -1 : 1)));
    expect(gates(good, good, good)).toEqual({ validated: true, robust: true });
    expect(gates(good, good, bad)).toEqual({ validated: true, robust: false });
    expect(gates(good, bad, good).validated).toBe(false);
  });

  it('a stopped-out trade is exactly -1R (risk includes commission)', () => {
    const H = 3_600_000;
    const c = Array.from({ length: 40 }, (_, i) => ({ t: i * H, o: 1.1, h: 1.1001, l: 1.0999, c: 1.1, v: 1 }));
    c[25] = { t: 25 * H, o: 1.1, h: 1.1, l: 1.09, c: 1.095, v: 1 };
    const strat = { id: 's', name: 's', blurb: '', params: [], signals: (x: readonly unknown[]) => Object.assign(new Int8Array(x.length), { 20: 1 }) };
    const r = runBacktest({
      candles: c,
      strategy: strat,
      params: {},
      pip: 0.0001,
      spreadPips: 1,
      commissionPerLot: 3.5,
      startBalance: 10_000,
      riskPct: 1,
      fixedLots: 0.1,
      slAtr: 2,
      tpAtr: 0,
      exitOnOpposite: false,
      allowLong: true,
      allowShort: true,
      trendFilter: 0,
      leverage: 500,
      quoteToUsd: () => 1,
    });
    const t = r.trades[0];
    expect(t.reason).toBe('sl');
    expect(t.net / t.risk).toBeCloseTo(-1, 9);
  });
});

describe('Lab search', () => {
  it('evaluates candidates, keeps a sorted hall of fame and advances generations', () => {
    const lab = new Lab(3, { ...DEFAULT_LAB, popSize: 8, hofSize: 5 });
    expect(lab.step()).toBeNull();
    lab.setData(datasets, 'sim', 'test');
    for (let k = 0; k < 30; k++) expect(lab.step()).not.toBeNull();
    expect(lab.stats.tested).toBeGreaterThanOrEqual(27);
    expect(lab.stats.generation).toBeGreaterThanOrEqual(3);
    const hof = lab.hof();
    expect(hof.length).toBeLessThanOrEqual(5);
    for (let k = 1; k < hof.length; k++) expect(hof[k - 1].score).toBeGreaterThanOrEqual(hof[k].score);
    for (const e of hof) {
      expect(e.score).toBeGreaterThan(0);
      expect(e.train.meanR).toBeGreaterThan(0);
      expect(e.train.n + e.val.n + e.hold.n).toBeGreaterThan(0);
    }
  });

  it('keeps one leaderboard entry per signal rule', () => {
    const lab = new Lab(21, { ...DEFAULT_LAB, popSize: 10, hofSize: 12 });
    lab.setData(datasets, 'sim', 'x');
    for (let k = 0; k < 60; k++) lab.step();
    const keys = lab.hof().map((e) => coreKey(e.genome));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is deterministic for a seed', () => {
    const run = () => {
      const lab = new Lab(9, { ...DEFAULT_LAB, popSize: 6 });
      lab.setData(datasets, 'sim', 'x');
      return Array.from({ length: 8 }, () => lab.step()!.id);
    };
    expect(run()).toEqual(run());
  });

  it('never keeps banned genomes and restores a hall of fame', () => {
    const lab = new Lab(4, { ...DEFAULT_LAB, popSize: 6, hofSize: 6 });
    lab.setData(datasets, 'sim', 'x');
    for (let k = 0; k < 20; k++) lab.step();
    const top = lab.hof()[0];
    if (top) {
      lab.ban(top.id);
      expect(lab.hof().some((e) => e.id === top.id)).toBe(false);
    }
    const copy = new Lab(5);
    copy.restore(JSON.parse(JSON.stringify(lab.hof())), { tested: 99 });
    expect(copy.hof().length).toBe(lab.hof().length);
    expect(copy.stats.tested).toBe(99);
  });

  it('evaluation splits trades into train / validation / holdout', () => {
    const g = normalize({ strategy: 'ema-cross', params: { fast: 10, slow: 40 }, slAtr: 1.5, tpAtr: 3, trend: 0, exitOnOpposite: true, sessions: ALL_SESSIONS, vol: 0 });
    const e = evaluateGenome(g, datasets, DEFAULT_LAB);
    expect(e.train.n).toBeGreaterThan(e.val.n);
    expect(e.val.n).toBeGreaterThan(10);
    expect(e.hold.n).toBeGreaterThan(10);
    expect(e.id).toBe(genomeId(g));
  });

  it('checks lessons against history', () => {
    const g: Genome = normalize({ strategy: 'donchian', params: { period: 20 }, slAtr: 1.5, tpAtr: 2, trend: 0, exitOnOpposite: false, sessions: ALL_SESSIONS, vol: 0 });
    const none = checkLessonOnHistory([g], datasets, 3.5, () => false);
    expect(none.removed).toBe(0);
    expect(none.after).toBeCloseTo(none.before, 9);
    const all = checkLessonOnHistory([g], datasets, 3.5, () => true);
    expect(all.after).toBe(0);
    const v = validateLessonOnHistory([g], datasets, 3.5, (ctx) => ctx.session === 0);
    expect(typeof v.ok).toBe('boolean');
    expect(v.detail).toMatch(/History/);
    expect(validateLessonOnHistory([], datasets, 3.5, () => true).ok).toBe(false);
  });
});
