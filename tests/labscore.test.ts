import { describe, expect, it } from 'vitest';
import { FALLBACK_RATES } from '../src/core/instruments';
import { cautiousSqn, DEFAULT_LAB, evaluateGenome, Lab, leaderboardOrder, MIN_VAL_TRADES, segmentStats, type Dataset } from '../src/core/lab';
import { MarketSim } from '../src/core/market';

describe('cautious SQN', () => {
  it('does not explode for a handful of trades that never lost', () => {
    // Ten wins of about 0.29R: almost no spread, so the plain SQN is absurd.
    const neverLost = Array.from({ length: 10 }, (_, i) => 0.288 + (i % 2) * 0.004);
    expect(segmentStats(neverLost).sqn).toBeGreaterThan(100);
    const c = cautiousSqn(neverLost);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(3);
  });

  it('barely moves a strategy that already has losses on record', () => {
    // 100 trades at 2:1 with a 45% win rate.
    const mixed = Array.from({ length: 100 }, (_, i) => (i % 20 < 9 ? 2 : -1));
    const plain = segmentStats(mixed).sqn;
    const c = cautiousSqn(mixed);
    expect(c).toBeLessThan(plain);
    expect(c).toBeGreaterThan(plain * 0.9);
  });

  it('lets more trades count as more evidence, up to 400', () => {
    const one = Array.from({ length: 20 }, (_, i) => (i % 20 < 9 ? 2 : -1));
    const rep = (k: number) => Array.from({ length: k }, () => one).flat();
    expect(cautiousSqn(rep(20))).toBeGreaterThan(cautiousSqn(rep(5)) * 1.8); // 400 vs 100 trades
    expect(cautiousSqn(rep(40))).toBeCloseTo(cautiousSqn(rep(20)), 1); // beyond the cap: no more credit
  });

  it('is zero without trades and negative when one loss would sink the sample', () => {
    expect(cautiousSqn([])).toBe(0);
    expect(cautiousSqn([0.1, 0.1, 0.1])).toBeLessThan(0);
  });
});

describe('ranking', () => {
  const sim = new MarketSim({ rates: FALLBACK_RATES, source: 'builtin', label: 't' }, Date.UTC(2026, 10, 25, 12), 77);
  const datasets: Dataset[] = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'].map((s) => ({
    symbol: s,
    candles: sim.candles[s].H1.slice(-2500),
    pip: s.endsWith('JPY') ? 0.01 : 0.0001,
    spreadPips: 1,
    conv: s.startsWith('USD') ? { kind: 'inverse' } : { kind: 'one' },
  }));

  it('only ranks strategies with enough validation trades, on the cautious SQN', () => {
    const lab = new Lab(11, { ...DEFAULT_LAB, popSize: 12 });
    lab.setData(datasets, 'sim', 't');
    let ranked = 0;
    for (let k = 0; k < 400 && (k < 60 || ranked === 0); k++) {
      const e = lab.step()!;
      if (e.train.n < 20 || e.val.n < MIN_VAL_TRADES) expect(e.score).toBe(-Infinity);
      else {
        ranked++;
        expect(Number.isFinite(e.score)).toBe(true);
      }
      // The same genome under the classic ranking can still be ranked with 10 validation trades.
      const classic = evaluateGenome(e.genome, datasets, { ...DEFAULT_LAB, cautious: false });
      if (classic.train.n >= 20 && classic.val.n >= 10) expect(Number.isFinite(classic.score)).toBe(true);
    }
    expect(ranked).toBeGreaterThan(0);
    for (const e of lab.hof()) expect(e.val.n).toBeGreaterThanOrEqual(MIN_VAL_TRADES);
  });

  it('puts holdout-tested strategies first and spreads the board over families', () => {
    const lab = new Lab(3, { ...DEFAULT_LAB, hofSize: 6 });
    lab.setData(datasets, 'sim', 't');
    for (let k = 0; k < 600; k++) lab.step();
    const hof = lab.hof();
    for (let k = 1; k < hof.length; k++) expect(leaderboardOrder(hof[k - 1], hof[k])).toBeLessThanOrEqual(0);
    const firstPlain = hof.findIndex((e) => !e.robust);
    if (firstPlain >= 0) expect(hof.slice(firstPlain).some((e) => e.robust)).toBe(false);
    const families = new Map<string, number>();
    for (const e of hof) families.set(e.genome.strategy, (families.get(e.genome.strategy) ?? 0) + 1);
    for (const n of families.values()) expect(n).toBeLessThanOrEqual(2); // a third of 6
    // The order function itself: robust beats a higher score.
    const a = { robust: true, validated: true, score: 1 } as never;
    const b = { robust: false, validated: true, score: 9 } as never;
    expect(leaderboardOrder(a, b)).toBeLessThan(0);
    expect(leaderboardOrder(b, a)).toBeGreaterThan(0);
  });

  it('starts the best score over when the data changes', () => {
    const lab = new Lab(5);
    lab.restore([], { bestScore: 174.61, tested: 10 });
    expect(lab.stats.bestScore).toBe(-Infinity);
    expect(lab.stats.tested).toBe(10);
    lab.setData(datasets, 'sim', 'a');
    lab.stats.bestScore = 3;
    lab.setData(datasets, 'sim', 'b');
    expect(lab.stats.bestScore).toBe(-Infinity);
  });
});
