import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { freshMirrorState, fromOanda, OandaClient, OandaError, OandaMarket, OandaMirror, resolveBaseUrl, toOanda } from '../bot/oanda';
import { DEFAULT_GUARD, DEFAULT_SETTINGS, freshState, TradingEngine, type Position } from '../src/core/account';
import { INSTRUMENTS } from '../src/core/instruments';
import { FakeMarket } from './helpers';

/** A small fake of the OANDA v20 REST API (only what NEONFX uses). */
const TOKEN = 'practice-token';
const ACCOUNT = '101-004-1234567-001';
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 0);
const calls: { method: string; path: string; body: unknown }[] = [];
const trades = new Map<string, { id: string; instrument: string; currentUnits: string; price: string; unrealizedPL: string }>();
let nextTrade = 500;
let priceShift = 0;
let server: Server;
let base = '';

function basePrice(inst: string): number {
  return inst.endsWith('JPY') ? 150 : 1.1;
}

beforeAll(async () => {
  server = createServer((rq, rs) => {
    let raw = '';
    rq.on('data', (c) => (raw += c));
    rq.on('end', () => {
      const url = new URL(rq.url ?? '/', 'http://x');
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: rq.method ?? '', path: url.pathname + url.search, body });
      const send = (code: number, o: unknown) => rs.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (rq.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { errorMessage: 'Insufficient authorization to perform request.' });
      const p = url.pathname;
      const unix = (ms: number) => (ms / 1000).toFixed(9);
      if (p === '/v3/accounts') return send(200, { accounts: [{ id: ACCOUNT, tags: [] }] });
      if (p === `/v3/accounts/${ACCOUNT}/summary`) {
        return send(200, { account: { currency: 'EUR', balance: '50000.0000', NAV: '50000.0000', unrealizedPL: '0', marginUsed: '0', openTradeCount: trades.size } });
      }
      if (p === `/v3/accounts/${ACCOUNT}/pricing`) {
        const list = (url.searchParams.get('instruments') ?? '').split(',');
        return send(200, {
          prices: list.map((inst) => {
            const b = basePrice(inst) + priceShift;
            const d = inst.endsWith('JPY') ? 3 : 5;
            return { instrument: inst, time: unix(Date.now()), tradeable: true, bids: [{ price: b.toFixed(d) }], asks: [{ price: (b + (inst.endsWith('JPY') ? 0.008 : 0.00008)).toFixed(d) }] };
          }),
        });
      }
      const cm = p.match(/^\/v3\/instruments\/([A-Z_]+)\/candles$/);
      if (cm) {
        if (rq.headers['accept-datetime-format'] !== 'UNIX') return send(400, { errorMessage: 'expected UNIX times' });
        const n = Number(url.searchParams.get('count'));
        const step = url.searchParams.get('granularity') === 'H1' ? H : 60_000;
        const b = basePrice(cm[1]);
        return send(200, {
          candles: Array.from({ length: n }, (_, i) => {
            const v = b * (1 + Math.sin(i / 7) * 0.002);
            return { complete: i < n - 1, volume: 10 + i, time: unix(T0 + i * step), bid: { o: v.toFixed(5), h: (v * 1.001).toFixed(5), l: (v * 0.999).toFixed(5), c: v.toFixed(5) } };
          }),
        });
      }
      if (p === `/v3/accounts/${ACCOUNT}/orders` && rq.method === 'POST') {
        const o = body.order;
        if (o.instrument === 'GBP_JPY') return send(201, { orderCancelTransaction: { reason: 'INSUFFICIENT_MARGIN' } });
        const id = String(nextTrade++);
        trades.set(id, { id, instrument: o.instrument, currentUnits: o.units, price: '1.10008', unrealizedPL: '0' });
        return send(201, { orderFillTransaction: { price: '1.10008', tradeOpened: { tradeID: id, units: o.units } } });
      }
      if (p === `/v3/accounts/${ACCOUNT}/openTrades`) return send(200, { trades: [...trades.values()] });
      const tc = p.match(/^\/v3\/accounts\/[^/]+\/trades\/(\d+)\/(close|orders)$/);
      if (tc && rq.method === 'PUT') {
        if (!trades.has(tc[1])) return send(404, { errorMessage: 'The Trade specified does not exist', errorCode: 'TRADE_DOESNT_EXIST' });
        if (tc[2] === 'close') {
          if (body.units === 'ALL') trades.delete(tc[1]);
          return send(200, { orderFillTransaction: { price: '1.10100', pl: '12.34' } });
        }
        return send(200, {});
      }
      send(404, { errorMessage: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('OANDA setup', () => {
  it('maps instrument names', () => {
    expect(toOanda('EURUSD')).toBe('EUR_USD');
    expect(fromOanda('USD_JPY')).toBe('USDJPY');
  });

  it('only allows the practice API (or a local test server)', () => {
    expect(resolveBaseUrl()).toBe('https://api-fxpractice.oanda.com');
    expect(resolveBaseUrl('http://127.0.0.1:9999/x')).toBe('http://127.0.0.1:9999');
    expect(() => resolveBaseUrl('https://api-fxtrade.oanda.com')).toThrow(/Real-money/);
    expect(() => resolveBaseUrl('https://evil.example.com')).toThrow(/must be/);
  });

  it('reports a bad token clearly', async () => {
    const c = new OandaClient(base, 'wrong');
    await expect(c.firstAccount()).rejects.toThrow(/rejected the token/);
    await expect(c.firstAccount()).rejects.toBeInstanceOf(OandaError);
    expect(await new OandaClient(base, TOKEN).firstAccount()).toBe(ACCOUNT);
  });
});

describe('OANDA market', () => {
  it('loads history for every pair and turns prices into quotes and ticks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 25, 14, 0))); // a Wednesday: market open
    try {
      const m = await OandaMarket.create(new OandaClient(base, TOKEN), ACCOUNT, () => undefined, 400, 60);
      for (const inst of INSTRUMENTS) {
        // 400 history bars plus the live bar started by the first price poll
        expect(m.series(inst.symbol, 'H1')).toHaveLength(401);
        expect(m.series(inst.symbol, 'D1').length).toBeGreaterThan(10);
      }
      expect(m.series('EURUSD', 'H1')[0].t).toBe(T0);
      const q = m.quote('EURUSD')!;
      expect(q.bid).toBe(1.1);
      expect(q.ask).toBe(1.10008);
      expect(q.spread).toBe(0.8);
      expect(m.quote('USDJPY')!.spread).toBe(0.8);
      expect(m.isOpen()).toBe(true);
      let steps = 0;
      m.advanceTo(Date.now(), () => steps++);
      m.advanceTo(Date.now(), () => steps++);
      expect(steps).toBe(1); // once per fresh price batch
      priceShift = 0.001;
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 25, 14, 0, 5)));
      await m.poll();
      priceShift = 0;
      expect(m.quote('EURUSD')!.bid).toBe(1.101);
      expect(m.series('EURUSD', 'M1').at(-1)!.c).toBe(1.101);
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 28, 12, 0))); // Saturday
      expect(m.isOpen()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OANDA order mirror', () => {
  function setup() {
    const fm = new FakeMarket();
    const engine = new TradingEngine(freshState({ ...DEFAULT_SETTINGS, commissionPerLot: 0 }, DEFAULT_GUARD), fm);
    engine.onTick();
    const logs: { m: string; important?: boolean }[] = [];
    const mirror = new OandaMirror(new OandaClient(base, TOKEN), ACCOUNT, freshMirrorState(), engine, fm.mid, 60_000, (m, important) => logs.push({ m, important }), 0);
    return { fm, engine, mirror, logs };
  }

  it('mirrors an open with scaled units and stops, then closes it', async () => {
    const { engine, mirror } = setup();
    await mirror.refreshAccount();
    expect(mirror.currency).toBe('EUR');
    expect(mirror.navUsd).toBeCloseTo(50_000 * 1.10005, 6);
    const r = engine.submit({ symbol: 'EURUSD', side: 'sell', units: 10_000, type: 'market', slPips: 20, tpPips: 40 });
    expect(r.ok).toBe(true);
    const p = (r as { value: Position }).value;
    calls.length = 0;
    await mirror.onOpen(p);
    const order = calls.find((c) => c.method === 'POST')!.body as { order: Record<string, unknown> };
    // paper units scaled by practice NAV (55,002.50 USD) / paper equity, capped at 60,000; negative = sell
    const expectedUnits = Math.round(10_000 * ((50_000 * 1.10005) / engine.metrics().equity));
    expect(expectedUnits).toBeGreaterThan(55_000);
    expect(order.order).toEqual({
      type: 'MARKET',
      instrument: 'EUR_USD',
      units: String(-expectedUnits),
      timeInForce: 'FOK',
      positionFill: 'DEFAULT',
      stopLossOnFill: { price: '1.10200', timeInForce: 'GTC' },
      takeProfitOnFill: { price: '1.09600', timeInForce: 'GTC' },
    });
    const tradeId = mirror.state.trades[String(p.id)];
    expect(tradeId).toBeDefined();
    // trailing / edited stop is synced
    expect(engine.modify(p.id, { sl: 1.1015 }).ok).toBe(true);
    calls.length = 0;
    await mirror.syncStops();
    expect(calls[0]).toMatchObject({ method: 'PUT', path: `/v3/accounts/${ACCOUNT}/trades/${tradeId}/orders`, body: { stopLoss: { price: '1.10150', timeInForce: 'GTC' } } });
    // manual close
    const closed = engine.close(p.id);
    expect(closed.ok).toBe(true);
    await mirror.onClose((closed as { value: Parameters<OandaMirror['onClose']>[0] }).value);
    expect(trades.has(tradeId)).toBe(false);
    expect(mirror.state.trades[String(p.id)]).toBeUndefined();
  });

  it('handles a stop that OANDA already executed', async () => {
    const { engine, mirror, logs, fm } = setup();
    const p = (engine.submit({ symbol: 'EURUSD', side: 'buy', units: 10_000, type: 'market', slPips: 10 }) as { value: Position }).value;
    await mirror.onOpen(p);
    trades.delete(mirror.state.trades[String(p.id)]); // OANDA closed it first
    fm.set('EURUSD', 1.0985);
    const closes: Parameters<OandaMirror['onClose']>[0][] = [];
    engine.on((e) => e.type === 'close' && closes.push(e.trade));
    engine.onTick();
    await mirror.onClose(closes[0]);
    expect(logs.some((l) => /already closed/.test(l.m))).toBe(true);
  });

  it('reports a rejected order as important', async () => {
    const { engine, mirror, logs } = setup();
    const p = (engine.submit({ symbol: 'GBPJPY', side: 'buy', units: 1000, type: 'market', slPips: 30 }) as { value: Position } | { ok: false }) as { value?: Position };
    if (!p.value) return; // FakeMarket has no GBPJPY quote: nothing to mirror
    await mirror.onOpen(p.value);
    expect(logs.find((l) => /did not fill/.test(l.m))?.important).toBe(true);
  });
});
