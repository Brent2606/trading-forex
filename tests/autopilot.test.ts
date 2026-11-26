import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GUARD, DEFAULT_SETTINGS, freshState, TradingEngine, type ClosedTrade } from '../src/core/account';
import {
  Autopilot,
  emptyLive,
  freshAutopilotState,
  lessonMatches,
  liveT,
  parseAutopilotState,
  type AutopilotDeps,
  type Deployment,
} from '../src/core/autopilot';
import type { Candle } from '../src/core/candles';
import { ALL_SESSIONS, genomeId, normalize, type Genome } from '../src/core/genome';
import { segmentStats, type Evaluation } from '../src/core/lab';
import { FakeMarket } from './helpers';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 23, 0);

/** Flat EURUSD-like candles; optionally the last closed bar breaks out upward. */
function series(n: number, breakout: boolean): Candle[] {
  const c: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const p = 1.1 + Math.sin(i / 3) * 0.0005;
    c.push({ t: T0 + i * H, o: p, h: p + 0.0006, l: p - 0.0006, c: p, v: 10 });
  }
  if (breakout) c[n - 2] = { t: T0 + (n - 2) * H, o: 1.1, h: 1.104, l: 1.0998, c: 1.1035, v: 10 };
  return c;
}

const donchian: Genome = normalize({
  strategy: 'donchian',
  params: { period: 20 },
  slAtr: 1.5,
  tpAtr: 3,
  trend: 0,
  exitOnOpposite: false,
  sessions: ALL_SESSIONS,
  vol: 0,
});

function evaluation(g: Genome, over: Partial<Evaluation> = {}): Evaluation {
  const s = segmentStats(Array.from({ length: 40 }, (_, i) => (i % 3 ? 1 : -1)));
  return { id: genomeId(g), genome: g, desc: 'x', train: s, val: s, hold: s, fitness: 2, score: 2, breadth: 1, breadthN: 4, validated: true, robust: true, at: 0, dataVersion: 0, ...over };
}

function setup(opts: { validate?: AutopilotDeps['validate'] } = {}) {
  const m = new FakeMarket();
  const engine = new TradingEngine(freshState({ ...DEFAULT_SETTINGS, commissionPerLot: 0 }, DEFAULT_GUARD), m);
  engine.onTick();
  let data: Record<string, Candle[]> = { EURUSD: series(400, false) };
  const logs: string[] = [];
  const ap = new Autopilot(freshAutopilotState({ enabled: true, universe: ['EURUSD'], tf: 'H1' }), {
    engine,
    series: (s) => data[s] ?? [],
    quote: m.quote,
    mid: m.mid,
    now: m.now,
    validate: opts.validate ?? (async () => ({ ok: true, detail: 'ok' })),
    log: (msg) => logs.push(msg),
  });
  engine.on((e) => {
    if (e.type === 'close') ap.onClose(e.trade);
  });
  return { m, engine, ap, logs, setData: (d: Record<string, Candle[]>) => (data = d) };
}

function closed(positionId: number, r: number, reason: ClosedTrade['reason'] = 'sl'): ClosedTrade {
  return { id: 1, positionId, symbol: 'EURUSD', side: 'buy', units: 1000, entry: 1, exit: 1, openTime: 0, closeTime: 0, pips: 0, gross: r, commission: 0, net: r, reason, r, mfe: 0, mae: 0 };
}

describe('deployment', () => {
  it('explore mode deploys up to the limit, preferring different strategy families', () => {
    const { ap } = setup();
    const gs = [
      donchian,
      normalize({ ...donchian, params: { period: 30 } }),
      normalize({ ...donchian, strategy: 'rsi-revert', params: { period: 14, lower: 30, upper: 70 } }),
      normalize({ ...donchian, strategy: 'ema-cross', params: { fast: 10, slow: 50 } }),
    ];
    ap.sync(gs.map((g) => evaluation(g, { robust: false })));
    expect(ap.state.deployments).toHaveLength(3);
    expect(new Set(ap.state.deployments.map((d) => d.genome.strategy)).size).toBe(3);
    expect(ap.state.deployments.every((d) => d.status === 'probation')).toBe(true);
  });

  it('waits until the lab has tested enough strategies, and explore still needs validation', () => {
    const { ap } = setup();
    ap.sync([evaluation(donchian)], 20);
    expect(ap.state.deployments).toHaveLength(0);
    ap.sync([evaluation(donchian, { validated: false, robust: false })], 500);
    expect(ap.state.deployments).toHaveLength(0);
    ap.sync([evaluation(donchian, { robust: false })], 500);
    expect(ap.state.deployments).toHaveLength(1);
  });

  it('swaps an untested probation strategy for a clearly stronger candidate, rate-limited', () => {
    const { ap, m } = setup();
    ap.state.config.maxDeployments = 1;
    ap.sync([evaluation(donchian, { score: 1 })]);
    const better = normalize({ ...donchian, strategy: 'ema-cross', params: { fast: 10, slow: 50 } });
    ap.sync([evaluation(better, { score: 1.1 })]);
    expect(ap.liveDeployments()[0].id).toBe(genomeId(donchian)); // not clearly better
    ap.sync([evaluation(better, { score: 3 })]);
    expect(ap.liveDeployments()[0].id).toBe(genomeId(better));
    expect(ap.state.blacklist).not.toContain(genomeId(donchian));
    const third = normalize({ ...donchian, strategy: 'macd-cross', params: { fast: 8, slow: 30, signal: 9 } });
    ap.sync([evaluation(third, { score: 9 })]);
    expect(ap.liveDeployments()[0].id).toBe(genomeId(better)); // within 10 minutes
    m.t += 11 * 60_000;
    ap.sync([evaluation(third, { score: 9 })]);
    expect(ap.liveDeployments()[0].id).toBe(genomeId(third));
  });

  it('never deploys two copies of the same signal rule', () => {
    const { ap } = setup();
    const twin = normalize({ ...donchian, slAtr: 3 });
    const near = normalize({ ...donchian, params: { period: 22 } });
    ap.sync([evaluation(donchian), evaluation(twin), evaluation(near)]);
    expect(ap.state.deployments).toHaveLength(1);
  });

  it('strict mode only deploys robust strategies', () => {
    const { ap } = setup();
    ap.state.config.mode = 'strict';
    ap.sync([evaluation(donchian, { robust: false })]);
    expect(ap.state.deployments).toHaveLength(0);
    ap.sync([evaluation(donchian, { robust: true })]);
    expect(ap.state.deployments).toHaveLength(1);
  });

  it('never redeploys a benched strategy', () => {
    const { ap } = setup();
    ap.state.blacklist.push(genomeId(donchian));
    ap.sync([evaluation(donchian)]);
    expect(ap.state.deployments).toHaveLength(0);
  });
});

describe('trading', () => {
  it('acts once per new closed bar and sizes from probation risk', () => {
    const { ap, engine, setData } = setup();
    ap.sync([evaluation(donchian)]);
    ap.onTick(); // first sight: remember the bar only
    expect(engine.state.positions).toHaveLength(0);
    setData({ EURUSD: series(401, true) });
    ap.onTick();
    expect(engine.state.positions).toHaveLength(1);
    const p = engine.state.positions[0];
    expect(p.side).toBe('buy');
    expect(ap.state.owned[String(p.id)].dep).toBe(genomeId(donchian));
    // risk ≈ 0.25% of equity
    expect(p.initialRisk! / engine.metrics().equity).toBeGreaterThan(0.002);
    expect(p.initialRisk! / engine.metrics().equity).toBeLessThanOrEqual(0.0026);
    ap.onTick(); // same bar again: nothing new
    expect(engine.state.positions).toHaveLength(1);
  });

  it('records why a trade was taken, and can rebuild that for older trades', () => {
    const { ap, engine, m, setData } = setup();
    ap.sync([evaluation(donchian)]);
    ap.onTick();
    setData({ EURUSD: series(401, true) });
    m.t = T0 + 400 * H + 2000; // two seconds into the bar after the breakout
    m.set('EURUSD', 1.1035, 1); // a fresh quote: a position's open time is its quote time
    ap.onTick();
    const p = engine.state.positions[0];
    const note = ap.state.notes[String(p.id)];
    expect(note).toMatchObject({ dep: genomeId(donchian), strategy: 'donchian', slPips: p.slPips, tpPips: p.tpPips, riskPct: 0.25 });
    const why = note.why!;
    expect(why).toMatchObject({ tf: 'H1', side: 'buy', barTime: T0 + 399 * H, slAtr: 1.5, tpAtr: 3 });
    expect(why.signal.k).toBe('donchian');
    if (why.signal.k === 'donchian') {
      expect(why.close).toBeGreaterThan(why.signal.high); // closed above the prior 20-bar high
      expect(why.signal.prevClose).toBeLessThanOrEqual(why.signal.high);
    }
    expect(ap.notesRev).toBe(1);

    // A trade from before notes existed: the same readings come back from price history.
    delete ap.state.notes[String(p.id)];
    expect(ap.backfillNotes()).toBe(1);
    expect(ap.state.notes[String(p.id)].why).toEqual(why);
    expect(ap.state.notes[String(p.id)].slPips).toBe(p.slPips);
    expect(ap.backfillNotes()).toBe(0);

    // When history no longer shows the signal, no (wrong) readings are stored.
    delete ap.state.notes[String(p.id)];
    setData({ EURUSD: series(401, false) });
    expect(ap.backfillNotes()).toBe(1);
    expect(ap.state.notes[String(p.id)]).toMatchObject({ strategy: 'donchian', why: null });
  });

  it('does nothing while disabled', () => {
    const { ap, engine, setData } = setup();
    ap.state.config.enabled = false;
    ap.sync([evaluation(donchian)]);
    ap.onTick();
    setData({ EURUSD: series(401, true) });
    ap.onTick();
    expect(engine.state.positions).toHaveLength(0);
  });

  it('respects active lessons (veto)', () => {
    const { ap, engine, setData } = setup();
    ap.sync([evaluation(donchian)]);
    ap.state.lessons.push({ id: 'trend:false', key: { f: 'trend', v: false }, label: 'x', n: 10, meanR: -1, restMeanR: 0, t: -3, status: 'active', createdAt: Date.now(), detail: '' });
    ap.state.lessons.push({ id: 'vol:2', key: { f: 'vol', v: 2 }, label: 'x', n: 10, meanR: -1, restMeanR: 0, t: -3, status: 'active', createdAt: Date.now(), detail: '' });
    ap.state.lessons.push({ id: 'vol:1', key: { f: 'vol', v: 1 }, label: 'x', n: 10, meanR: -1, restMeanR: 0, t: -3, status: 'active', createdAt: Date.now(), detail: '' });
    ap.state.lessons.push({ id: 'vol:0', key: { f: 'vol', v: 0 }, label: 'x', n: 10, meanR: -1, restMeanR: 0, t: -3, status: 'active', createdAt: Date.now(), detail: '' });
    ap.onTick();
    setData({ EURUSD: series(401, true) });
    ap.onTick();
    expect(engine.state.positions).toHaveLength(0);
    expect(ap.state.counters.vetoed).toBe(1);
  });

  it('caps open positions and currency exposure', () => {
    const { ap, engine, setData } = setup();
    ap.state.config.maxOpen = 0;
    ap.sync([evaluation(donchian)]);
    ap.onTick();
    setData({ EURUSD: series(401, true) });
    ap.onTick();
    expect(engine.state.positions).toHaveLength(0);
    expect(ap.state.counters.skipped).toBe(1);
  });
});

describe('learning from results', () => {
  function deployed() {
    const s = setup();
    s.ap.sync([evaluation(donchian)]);
    const d = s.ap.state.deployments[0];
    let id = 5000;
    const feed = (r: number, ctx = { session: 1, vol: 1, withTrend: true, wideSpread: false }) => {
      s.ap.state.owned[String(++id)] = { dep: d.id, ctx };
      s.ap.onClose(closed(id, r));
    };
    return { ...s, d, feed };
  }

  it('benches after 7 losses in a row and blacklists the genome', () => {
    const { d, feed, ap } = deployed();
    for (let k = 0; k < 6; k++) feed(k % 2 ? 0.2 : -1);
    expect(d.status).toBe('probation');
    for (let k = 0; k < 7; k++) feed(-0.5);
    expect(d.status).toBe('benched');
    expect(ap.state.blacklist).toContain(d.id);
  });

  it('benches a significantly negative record', () => {
    const { d, feed } = deployed();
    for (const r of [-1, -1, 0.5, -1, -1, 0.3, -1, -1]) feed(r);
    expect(d.status).toBe('benched');
    expect(d.note).toMatch(/significantly negative/);
  });

  it('promotes after 15 profitable live trades and raises risk', () => {
    const { d, feed, ap } = deployed();
    for (let k = 0; k < 15; k++) feed(k % 3 === 0 ? -1 : 1.2);
    expect(d.status).toBe('active');
    expect(ap.riskFor(d)).toBeGreaterThan(ap.state.config.riskPct);
    expect(ap.riskFor(d)).toBeLessThanOrEqual(ap.state.config.riskPct * 1.5);
  });

  it('demotes an active strategy whose live results fall well below its history', () => {
    const { d, feed, ap } = deployed();
    d.expected.valMeanR = 1.5;
    for (let k = 0; k < 15; k++) feed(k % 3 === 0 ? -1 : 1.2);
    expect(d.status).toBe('active');
    expect(d.stage.n).toBe(0);
    for (let k = 0; k < 20; k++) feed(k % 2 ? 0.4 : -0.3);
    expect(d.status).toBe('probation');
    expect(d.note).toMatch(/Demoted/);
    expect(ap.state.blacklist).not.toContain(d.id);
  });

  it('ignores manual closes', () => {
    const { d, ap } = deployed();
    ap.state.owned['9999'] = { dep: d.id, ctx: { session: 1, vol: 1, withTrend: true, wideSpread: false } };
    ap.onClose(closed(9999, -1, 'manual'));
    expect(d.live.n).toBe(0);
    expect(ap.state.journal).toHaveLength(0);
  });

  it('learns a lesson when losses cluster in one session and history agrees', async () => {
    const validate = vi.fn(async () => ({ ok: true, detail: 'History agrees' }));
    const { ap, feed } = deployed();
    (ap as unknown as { deps: AutopilotDeps }).deps.validate = validate;
    ap.state.deployments[0].status = 'active';
    // Asia (session 0) trades lose, others win.
    for (let k = 0; k < 40; k++) {
      const asia = k % 3 === 0;
      feed(asia ? -1 + (k % 2) * 0.1 : 0.8 + (k % 2) * 0.1, { session: asia ? 0 : 2, vol: 1, withTrend: true, wideSpread: false });
      ap.state.deployments[0].status = 'active';
      ap.state.deployments[0].live = emptyLive();
    }
    await ap.learn();
    const lesson = ap.state.lessons.find((l) => l.id === 'session:0');
    expect(lesson?.status).toBe('active');
    expect(validate).toHaveBeenCalled();
    expect(lessonMatches(lesson!.key, { session: 0, vol: 1, withTrend: true, wideSpread: false })).toBe(true);
  });

  it('rejects a lesson history does not support', async () => {
    const { ap, feed } = deployed();
    (ap as unknown as { deps: AutopilotDeps }).deps.validate = async () => ({ ok: false, detail: 'History disagrees' });
    for (let k = 0; k < 40; k++) {
      const asia = k % 3 === 0;
      feed(asia ? -1 : 0.9, { session: asia ? 0 : 2, vol: 1, withTrend: true, wideSpread: false });
      ap.state.deployments[0].status = 'active';
      ap.state.deployments[0].live = emptyLive();
    }
    await ap.learn();
    expect(ap.state.lessons.find((l) => l.id === 'session:0')?.status).toBe('rejected');
  });
});

describe('state', () => {
  it('round-trips and repairs', () => {
    const s = freshAutopilotState();
    expect(parseAutopilotState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseAutopilotState({ version: 2 })).toBeNull();
    const broken = { ...s, config: { ...s.config, universe: ['NOPE'] } };
    expect(parseAutopilotState(broken)!.config.universe.length).toBe(16);
  });
  it('t statistic', () => {
    const d: Deployment['live'] = emptyLive();
    for (const r of [1, 1, 1, -1]) {
      d.n++;
      d.sumR += r;
      d.sumR2 += r * r;
    }
    expect(liveT(d)).toBeCloseTo(0.5 / (1 / 2), 9);
  });
});
