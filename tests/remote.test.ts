import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshState, type EngineEvent } from '../src/core/account';
import type { LiveDump, MarketDump } from '../src/core/botTypes';
import { INSTRUMENTS } from '../src/core/instruments';
import { RemoteEngine, RemoteMarket } from '../src/ui/remote';

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 25, 10);

function dump(): MarketDump {
  const candles: MarketDump['candles'] = {};
  for (const i of INSTRUMENTS) {
    const p = i.symbol.endsWith('JPY') ? 150 : 1.1;
    candles[i.symbol] = {
      H1: Array.from({ length: 48 }, (_, k) => [T0 - (48 - k) * H, p, p + 0.001, p - 0.001, p, 10] as [number, number, number, number, number, number]),
      M1: Array.from({ length: 120 }, (_, k) => [T0 - (120 - k) * 60_000, p, p, p, p, 1] as [number, number, number, number, number, number]),
    };
  }
  return { time: T0, label: 'SIM · test', real: false, open: true, quotes: quotes(0), candles };
}

function quotes(shift: number) {
  return INSTRUMENTS.map((i) => {
    const p = (i.symbol.endsWith('JPY') ? 150 : 1.1) + shift;
    return { symbol: i.symbol, bid: p, ask: p + i.pip, mid: p + i.pip / 2, spread: 1, t: T0 + 1000 };
  });
}

function live(state = freshState(), historyFrom = 0, owned: number[] = []): LiveDump {
  return { time: T0 + 1000, label: 'SIM · test', real: false, open: true, quotes: quotes(0), state: JSON.parse(JSON.stringify(state)), historyFrom, owned, notesRev: 1 };
}

const link = { base: 'http://localhost:8787', token: 'token-123456789' };
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const market = new RemoteMarket(dump());
  const view = { quote: (s: string) => market.quote(s), mid: market.mid, now: () => market.time, isOpen: () => market.isOpen() };
  const engine = new RemoteEngine(freshState(), view, link);
  const events: EngineEvent[] = [];
  engine.on((e) => events.push(e));
  return { market, engine, events };
}

describe('RemoteMarket', () => {
  it('builds all timeframes from the bot history and extends candles with new prices', () => {
    const { market } = setup();
    expect(market.series('EURUSD', 'H1')).toHaveLength(48);
    expect(market.series('EURUSD', 'M5').length).toBeGreaterThan(20);
    expect(market.series('EURUSD', 'D1').length).toBeGreaterThan(1);
    expect(market.quote('EURUSD')?.bid).toBe(1.1);
    let steps = 0;
    market.advanceTo(0, () => steps++);
    expect(steps).toBe(0);
    market.apply({ time: T0 + 5000, label: 'SIM · test', real: false, open: true, quotes: quotes(0.002).map((q) => ({ ...q, t: T0 + 5000 })) });
    market.advanceTo(0, () => steps++);
    expect(steps).toBe(1);
    const last = market.series('EURUSD', 'M1').at(-1)!;
    expect(last.c).toBeCloseTo(1.102, 6);
    market.connected = false;
    expect(market.isOpen()).toBe(false);
  });
});

describe('RemoteEngine', () => {
  it('runs manual actions on the mirror and sends them to the bot', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { engine, events } = setup();
    engine.sync(live());
    const r = engine.submit({ symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 20, tpPips: 40, trailPips: null });
    expect(r.ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['open']);
    const id = engine.state.positions[0].id;
    engine.reverse(id);
    engine.closeWhere(() => true);
    await new Promise((res) => setTimeout(res, 0));
    // Nested closes inside reverse / closeWhere are not sent separately.
    expect(sent.map((o) => (o as { op: string }).op)).toEqual(['submit', 'reverse', 'closeIds']);
  });

  it('reports refusals and never runs stops or resets locally', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: false, error: 'Risk guard: trading locked for today' }), { status: 200 }));
    const { engine } = setup();
    const refusals: string[] = [];
    engine.onRejected = (m) => refusals.push(m);
    engine.sync(live());
    engine.submit({ symbol: 'EURUSD', side: 'sell', units: 10_000, type: 'market', slPips: 20, tpPips: null, trailPips: null });
    await new Promise((res) => setTimeout(res, 0));
    expect(refusals).toEqual(['Risk guard: trading locked for today']);
    engine.reset();
    expect(refusals.at(-1)).toMatch(/cannot be reset/);
  });

  it('takes over the bot state and announces what the bot did, once', () => {
    const { engine, events } = setup();
    const bot = freshState();
    bot.positions.push({ id: 1500, symbol: 'GBPUSD', side: 'buy', units: 3000, entry: 1.27, openTime: T0, sl: 1.26, tp: 1.29, trailPips: null, slPips: 100, tpPips: 200, trailed: false, openCommission: 0.1, initialRisk: 30, mfe: 0, mae: 0, fromOrder: null } as never);
    bot.nextId = 1501;
    expect(engine.sync(live(bot, 0, [1500]))).toBe(true); // first sync: no events for what already existed
    expect(events).toHaveLength(0);
    expect(engine.owned.has(1500)).toBe(true);

    const later = JSON.parse(JSON.stringify(bot)) as typeof bot;
    later.positions = [];
    later.history.push({ id: 1501, positionId: 1500, symbol: 'GBPUSD', side: 'buy', units: 3000, entry: 1.27, exit: 1.29, openTime: T0, closeTime: T0 + H, pips: 200, gross: 60, commission: 0.2, net: 59.8, reason: 'tp', r: 2, mfe: 200, mae: 5 });
    later.balance += 59.8;
    later.nextId = 1502;
    engine.sync(live(later, 0, []));
    expect(events.map((e) => e.type)).toEqual(['close']);
    expect(engine.confirmed).toBe(1);
    // An incremental poll only carries new trades.
    engine.sync({ ...live({ ...later, history: [] }, 1, []) });
    expect(engine.state.history).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});
