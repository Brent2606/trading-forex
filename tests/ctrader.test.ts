import { afterEach, describe, expect, it } from 'vitest';
import {
  CTraderClient,
  CTraderError,
  CTraderMarket,
  normalizeBrokerSymbol,
  PT,
  resolveCtraderUrl,
  trendbarToCandle,
  type Tokens,
  type WsLike,
} from '../bot/ctrader';
import { INSTRUMENTS } from '../src/core/instruments';

const MIN = 60_000;
const H = 3_600_000;

/** In-memory fake of the cTrader Open API JSON endpoint (only what NEONFX uses). */
class FakeCtrader {
  sockets: FakeWs[] = [];
  received: { payloadType: number; payload: Record<string, unknown> }[] = [];
  accounts: Record<string, unknown>[] = [{ ctidTraderAccountId: 777, isLive: false, traderLogin: 5550001, brokerTitleShort: 'DemoBroker' }];
  validAccess = 'access-1';
  refreshCount = 0;
  failAppAuth = false;
  symbolNames = INSTRUMENTS.map((i) => `${i.symbol}.r`);

  factory = (url: string): WsLike => {
    const ws = new FakeWs(this, url);
    this.sockets.push(ws);
    queueMicrotask(() => ws.onopen?.());
    return ws;
  };

  get last(): FakeWs {
    return this.sockets[this.sockets.length - 1];
  }

  answer(ws: FakeWs, raw: string): void {
    const msg = JSON.parse(raw) as { clientMsgId?: string; payloadType: number; payload: Record<string, unknown> };
    this.received.push({ payloadType: msg.payloadType, payload: msg.payload });
    const reply = (payloadType: number, payload: Record<string, unknown>) =>
      queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify({ clientMsgId: msg.clientMsgId, payloadType, payload }) }));
    const err = (code: string) => reply(PT.OA_ERROR_RES, { errorCode: code, description: code.toLowerCase() });
    const p = msg.payload;
    switch (msg.payloadType) {
      case PT.HEARTBEAT:
        return;
      case PT.APP_AUTH_REQ:
        return this.failAppAuth || p.clientSecret !== 'secret' ? err('CH_CLIENT_AUTH_FAILURE') : reply(PT.APP_AUTH_RES, {});
      case PT.ACCOUNT_LIST_REQ:
        return p.accessToken !== this.validAccess
          ? err('CH_ACCESS_TOKEN_INVALID')
          : reply(PT.ACCOUNT_LIST_RES, { accessToken: p.accessToken, permissionScope: 1, ctidTraderAccount: this.accounts });
      case PT.REFRESH_TOKEN_REQ:
        if (p.refreshToken !== `refresh-${this.refreshCount + 1}`) return err('CH_ACCESS_TOKEN_INVALID');
        this.refreshCount++;
        this.validAccess = `access-${this.refreshCount + 1}`;
        return reply(PT.REFRESH_TOKEN_RES, { accessToken: this.validAccess, tokenType: 'bearer', expiresIn: 2628000, refreshToken: `refresh-${this.refreshCount + 1}` });
      case PT.ACCOUNT_AUTH_REQ:
        return p.accessToken !== this.validAccess ? err('CH_ACCESS_TOKEN_INVALID') : reply(PT.ACCOUNT_AUTH_RES, { ctidTraderAccountId: p.ctidTraderAccountId });
      case PT.SYMBOLS_LIST_REQ:
        return reply(PT.SYMBOLS_LIST_RES, {
          symbol: [
            ...this.symbolNames.map((n, i) => ({ symbolId: 100 + i, symbolName: n, enabled: true })),
            { symbolId: 999, symbolName: 'XAUUSD', enabled: true },
          ],
        });
      case PT.SYMBOL_BY_ID_REQ:
        return reply(PT.SYMBOL_BY_ID_RES, {
          symbol: (p.symbolId as number[]).map((id) => ({ symbolId: id, digits: this.symbolNames[id - 100]?.includes('JPY') ? 3 : 5 })),
        });
      case PT.TRENDBARS_REQ: {
        const from = p.fromTimestamp as number;
        const to = p.toTimestamp as number;
        const step = p.period === 9 ? H : MIN;
        const jpy = this.symbolNames[(p.symbolId as number) - 100]?.includes('JPY');
        const base = jpy ? 15_000_000 : 110_000;
        const bars = [];
        for (let t = Math.ceil(from / step) * step; t < to; t += step) {
          bars.push({ low: base, deltaOpen: 10, deltaHigh: 30, deltaClose: 20, utcTimestampInMinutes: t / MIN, volume: 5, period: p.period });
        }
        return reply(PT.TRENDBARS_RES, { ctidTraderAccountId: 777, period: p.period, trendbar: bars, symbolId: p.symbolId });
      }
      case PT.SUBSCRIBE_SPOTS_REQ:
        return reply(PT.SUBSCRIBE_SPOTS_RES, { ctidTraderAccountId: 777 });
      default:
        return err('UNKNOWN');
    }
  }

  /** Pushes an unsolicited event to the latest socket. */
  push(payloadType: number, payload: Record<string, unknown>): void {
    this.last.onmessage?.({ data: JSON.stringify({ payloadType, payload }) });
  }
}

class FakeWs implements WsLike {
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  closed = false;
  constructor(
    private readonly server: FakeCtrader,
    readonly url: string,
  ) {}
  send(data: string): void {
    if (!this.closed) this.server.answer(this, data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.());
  }
}

const tokens = (): Tokens => ({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 0 });
let markets: CTraderMarket[] = [];
afterEach(() => {
  for (const m of markets) m.stop();
  markets = [];
});

async function connect(fake: FakeCtrader, extra: Partial<Parameters<typeof CTraderMarket.create>[0]> = {}) {
  const m = await CTraderMarket.create({
    clientId: 'id',
    clientSecret: 'secret',
    tokens: tokens(),
    url: 'ws://127.0.0.1:1',
    wsFactory: fake.factory,
    h1Bars: 400,
    m1Bars: 200,
    historyGapMs: 0,
    ...extra,
  });
  markets.push(m);
  return m;
}

describe('cTrader helpers', () => {
  it('refuses live endpoints and plain remote ws', () => {
    expect(resolveCtraderUrl()).toBe('wss://demo.ctraderapi.com:5036');
    expect(() => resolveCtraderUrl('wss://live.ctraderapi.com:5036')).toThrow(CTraderError);
    expect(() => resolveCtraderUrl('ws://example.com:5036')).toThrow(CTraderError);
    expect(resolveCtraderUrl('ws://127.0.0.1:9999')).toBe('ws://127.0.0.1:9999');
  });

  it('maps broker symbol names to NEONFX pairs', () => {
    expect(normalizeBrokerSymbol('EURUSD')).toBe('EURUSD');
    expect(normalizeBrokerSymbol('EURUSD.r')).toBe('EURUSD');
    expect(normalizeBrokerSymbol('EUR/USD')).toBe('EURUSD');
    expect(normalizeBrokerSymbol('GBPJPYm')).toBe('GBPJPY');
    expect(normalizeBrokerSymbol('XAUUSD')).toBeNull();
    expect(normalizeBrokerSymbol('EURUSD_MINI_CONTRACT')).toBeNull();
  });

  it('rebuilds OHLC from relative trendbars', () => {
    const c = trendbarToCandle({ low: 108_512, deltaOpen: 10, deltaHigh: 40, deltaClose: 25, utcTimestampInMinutes: 29_000_000, volume: 12 }, 5)!;
    expect(c).toEqual({ t: 29_000_000 * MIN, o: 1.08522, h: 1.08552, l: 1.08512, c: 1.08537, v: 12 });
    const j = trendbarToCandle({ low: 15_012_300, deltaOpen: 0, deltaHigh: 5000, deltaClose: 2000, utcTimestampInMinutes: 1 }, 3)!;
    expect(j.l).toBe(150.123);
    expect(j.h).toBe(150.173);
  });

  it('matches responses to requests and surfaces cTrader errors', async () => {
    const fake = new FakeCtrader();
    const c = new CTraderClient('ws://127.0.0.1:1', fake.factory);
    await c.connect();
    await expect(c.request(PT.APP_AUTH_REQ, { clientId: 'id', clientSecret: 'nope' })).rejects.toMatchObject({ code: 'CH_CLIENT_AUTH_FAILURE' });
    await expect(c.request(PT.APP_AUTH_REQ, { clientId: 'id', clientSecret: 'secret' })).resolves.toEqual({});
    c.close();
  });
});

describe('CTraderMarket', () => {
  it('authorizes the demo account, loads history for all 16 pairs and streams prices', async () => {
    const fake = new FakeCtrader();
    const m = await connect(fake);
    expect(m.accountLabel).toBe('DemoBroker 5550001');
    for (const inst of INSTRUMENTS) {
      expect(m.series(inst.symbol, 'H1').length).toBe(400);
      expect(m.series(inst.symbol, 'M1').length).toBe(200);
      expect(m.series(inst.symbol, 'H4').length).toBeGreaterThan(50);
    }
    const order = fake.received.map((r) => r.payloadType).filter((t) => t !== PT.TRENDBARS_REQ);
    expect(order).toEqual([PT.APP_AUTH_REQ, PT.ACCOUNT_LIST_REQ, PT.ACCOUNT_AUTH_REQ, PT.SYMBOLS_LIST_REQ, PT.SYMBOL_BY_ID_REQ, PT.SUBSCRIBE_SPOTS_REQ]);
    const sub = fake.received.find((r) => r.payloadType === PT.SUBSCRIBE_SPOTS_REQ)!;
    expect((sub.payload.symbolId as number[]).length).toBe(16);
    expect(sub.payload.symbolId).not.toContain(999);

    // Spot: EURUSD is symbolId 100. Bid only, then ask only: the other side is kept.
    fake.push(PT.SPOT_EVENT, { ctidTraderAccountId: 777, symbolId: 100, bid: 108_500, ask: 108_507, timestamp: Date.now() });
    expect(m.quote('EURUSD')).toMatchObject({ bid: 1.085, ask: 1.08507, spread: 0.7 });
    fake.push(PT.SPOT_EVENT, { ctidTraderAccountId: 777, symbolId: 100, bid: 108_503 });
    expect(m.quote('EURUSD')).toMatchObject({ bid: 1.08503, ask: 1.08507 });
    // A crossed quote (bid above ask) is ignored.
    fake.push(PT.SPOT_EVENT, { ctidTraderAccountId: 777, symbolId: 100, bid: 108_600 });
    expect(m.quote('EURUSD')).toMatchObject({ bid: 1.08503, ask: 1.08507 });
    let steps = 0;
    m.advanceTo(Date.now(), () => steps++);
    m.advanceTo(Date.now(), () => steps++);
    expect(steps).toBe(1);
    expect(m.mid('EURUSD')).toBeCloseTo((1.08503 + 1.08507) / 2, 6);
  });

  it('only uses demo accounts', async () => {
    const fake = new FakeCtrader();
    fake.accounts = [{ ctidTraderAccountId: 1, isLive: true, traderLogin: 1 }];
    await expect(connect(fake)).rejects.toMatchObject({ code: 'NO_DEMO_ACCOUNT' });
    const mixed = new FakeCtrader();
    mixed.accounts = [
      { ctidTraderAccountId: 1, isLive: true, traderLogin: 111 },
      { ctidTraderAccountId: 2, isLive: false, traderLogin: 222, brokerTitleShort: 'B' },
    ];
    const m = await connect(mixed);
    expect(m.accountLabel).toBe('B 222');
    await expect(connect(new FakeCtrader(), { account: '999' })).rejects.toMatchObject({ code: 'NO_DEMO_ACCOUNT' });
  });

  it('refreshes an expired access token and stores the new pair', async () => {
    const fake = new FakeCtrader();
    fake.validAccess = 'access-2'; // access-1 has expired on the server
    const saved: Tokens[] = [];
    const m = await connect(fake, { saveTokens: (t) => saved.push({ ...t }) });
    expect(m.accountLabel).toBe('DemoBroker 5550001');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(saved[0].expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it('fails clearly when the broker misses a pair', async () => {
    const fake = new FakeCtrader();
    fake.symbolNames = fake.symbolNames.map((n) => (n.startsWith('AUDNZD') ? 'AUDCAD' : n));
    await expect(connect(fake)).rejects.toMatchObject({ code: 'MISSING_SYMBOLS' });
  });

  it('reconnects after the connection drops and resubscribes', async () => {
    const fake = new FakeCtrader();
    const m = await connect(fake);
    const before = fake.sockets.length;
    fake.last.close();
    await new Promise((r) => setTimeout(r, 2300));
    expect(fake.sockets.length).toBe(before + 1);
    const subs = fake.received.filter((r) => r.payloadType === PT.SUBSCRIBE_SPOTS_REQ);
    expect(subs.length).toBe(2);
    fake.push(PT.SPOT_EVENT, { symbolId: 101, bid: 127_000, ask: 127_009, timestamp: Date.now() });
    expect(m.quote('GBPUSD')?.bid).toBe(1.27);
    expect(m.error).toBe('');
  }, 10_000);
});
