/**
 * cTrader Open API integration for the 24/7 bot (DEMO accounts only), JSON over WebSocket.
 *
 *   NEONFX_CTRADER_CLIENT_ID      Open API application client id (required)
 *   NEONFX_CTRADER_CLIENT_SECRET  Open API application client secret (required)
 *   NEONFX_CTRADER_ACCESS_TOKEN   access token for your cTrader ID (required the first time)
 *   NEONFX_CTRADER_REFRESH_TOKEN  refresh token (required the first time)
 *   NEONFX_CTRADER_ACCOUNT        trader login (account number) to use (optional: first demo account)
 *
 * With these set the bot runs on the broker's real streaming prices and candle history instead of
 * the simulator. The bot keeps paper-trading its own account; no orders are sent to cTrader.
 * Access tokens last ~30 days; the bot refreshes them itself and stores the new pair in
 * <data>/ctrader-tokens.json (the environment values are only the starting point).
 * Live accounts and the live endpoint are deliberately refused.
 */
import { aggregate, applyTick, TIMEFRAMES, type Candle, type Timeframe } from '../src/core/candles';
import { getInstrument, INSTRUMENTS } from '../src/core/instruments';
import type { MidLookup, Quote } from '../src/core/rates';
import { isFxOpen } from '../src/core/time';

export const CTRADER_DEMO = 'wss://demo.ctraderapi.com:5036';

/** Payload types used (cTrader Open API ProtoOAPayloadType / ProtoPayloadType). */
export const PT = {
  HEARTBEAT: 51,
  ERROR_RES: 50,
  APP_AUTH_REQ: 2100,
  APP_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  SUBSCRIBE_SPOTS_REQ: 2127,
  SUBSCRIBE_SPOTS_RES: 2128,
  SPOT_EVENT: 2131,
  TRENDBARS_REQ: 2137,
  TRENDBARS_RES: 2138,
  OA_ERROR_RES: 2142,
  TOKEN_INVALIDATED_EVENT: 2147,
  CLIENT_DISCONNECT_EVENT: 2148,
  ACCOUNT_LIST_REQ: 2149,
  ACCOUNT_LIST_RES: 2150,
  REFRESH_TOKEN_REQ: 2173,
  REFRESH_TOKEN_RES: 2174,
} as const;

/** ProtoOATrendbarPeriod values. */
const PERIOD = { M1: 1, H1: 9 } as const;
const PRICE_SCALE = 100_000;
const MIN = 60_000;

const DAY = 86_400_000;

/** Demo endpoint, or a local ws:// URL for testing. The live endpoint is refused. */
export function resolveCtraderUrl(override?: string): string {
  const url = (override || CTRADER_DEMO).trim();
  const u = new URL(url);
  if (/(^|\.)live\.ctraderapi\.com$/i.test(u.hostname) || /^live\d*\./i.test(u.hostname)) {
    throw new CTraderError('Live cTrader endpoints are not allowed. NEONFX only connects to demo accounts.', 'LIVE_REFUSED');
  }
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) {
    throw new CTraderError(`Unsupported cTrader URL ${url}`, 'BAD_URL');
  }
  return url;
}

export class CTraderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CTraderError';
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Unix ms when the access token expires (0 = unknown). */
  expiresAt: number;
}

/** Minimal WebSocket surface, so tests can inject a fake. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

const defaultWs: WsFactory = (url) => {
  const W = (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket;
  if (!W) throw new CTraderError('This Node.js has no WebSocket support (Node 22+ needed)', 'NO_WS');
  return new W(url);
};

interface Envelope {
  clientMsgId?: string;
  payloadType: number;
  payload?: Record<string, unknown>;
}

const num = (v: unknown): number => (typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN);

/** One JSON WebSocket connection to the cTrader Open API with request/response matching. */
export class CTraderClient {
  private ws: WsLike | null = null;
  private seq = 0;
  private readonly pending = new Map<string, { resolve: (p: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastHistory = 0;
  onEvent: (payloadType: number, payload: Record<string, unknown>) => void = () => {};
  onClose: (reason: string) => void = () => {};

  constructor(
    readonly url: string,
    private readonly wsFactory: WsFactory = defaultWs,
    private readonly timeoutMs = 15_000,
    private readonly historyGapMs = 250,
  ) {}

  get connected(): boolean {
    return this.ws !== null;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = this.wsFactory(this.url);
      ws.onopen = () => {
        opened = true;
        this.ws = ws;
        this.heartbeat = setInterval(() => this.sendRaw({ payloadType: PT.HEARTBEAT, payload: {} }), 10_000);
        resolve();
      };
      ws.onmessage = (ev) => this.handle(ev.data);
      ws.onerror = () => {
        if (!opened) reject(new CTraderError(`Could not connect to ${this.url}`, 'CONNECT'));
      };
      ws.onclose = () => {
        const was = this.ws === ws;
        this.teardown('connection closed');
        if (!opened) reject(new CTraderError(`Connection to ${this.url} closed`, 'CONNECT'));
        else if (was) this.onClose('connection closed');
      };
    });
  }

  close(): void {
    const ws = this.ws;
    this.teardown('closed by bot');
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }

  private teardown(reason: string): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.ws = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CTraderError(reason, 'DISCONNECTED'));
    }
    this.pending.clear();
  }

  private sendRaw(msg: Envelope): void {
    if (!this.ws) throw new CTraderError('Not connected to cTrader', 'DISCONNECTED');
    this.ws.send(JSON.stringify(msg));
  }

  private handle(data: unknown): void {
    let msg: Envelope;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data)) as Envelope;
    } catch {
      return;
    }
    const payload = msg.payload ?? {};
    const p = msg.clientMsgId ? this.pending.get(msg.clientMsgId) : undefined;
    if (p) {
      this.pending.delete(msg.clientMsgId!);
      clearTimeout(p.timer);
      if (msg.payloadType === PT.OA_ERROR_RES || msg.payloadType === PT.ERROR_RES) {
        const code = String(payload.errorCode ?? 'ERROR');
        p.reject(new CTraderError(`cTrader ${code}${payload.description ? `: ${String(payload.description)}` : ''}`, code));
      } else p.resolve(payload);
      return;
    }
    if (msg.payloadType !== PT.HEARTBEAT) this.onEvent(msg.payloadType, payload);
  }

  /** Sends a request and resolves with the matching response payload. */
  request(payloadType: number, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const clientMsgId = `nfx_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new CTraderError(`cTrader did not answer request ${payloadType} in time`, 'TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(clientMsgId, { resolve, reject, timer });
      try {
        this.sendRaw({ clientMsgId, payloadType, payload });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(clientMsgId);
        reject(e as Error);
      }
    });
  }

  /** Historical requests are limited to 5 per second per connection: keep them 250 ms apart. */
  async history(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const wait = this.lastHistory + this.historyGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastHistory = Date.now();
    return this.request(PT.TRENDBARS_REQ, payload);
  }
}

/** Converts a ProtoOATrendbar to a candle (prices are integers in 1/100000). */
export function trendbarToCandle(b: Record<string, unknown>, digits: number): Candle | null {
  const low = num(b.low);
  const ts = num(b.utcTimestampInMinutes);
  if (!Number.isFinite(low) || !Number.isFinite(ts)) return null;
  const f = 10 ** digits;
  const px = (v: number) => Math.round((v / PRICE_SCALE) * f) / f;
  const o = px(low + (num(b.deltaOpen) || 0));
  const h = px(low + (num(b.deltaHigh) || 0));
  const c = px(low + (num(b.deltaClose) || 0));
  const l = px(low);
  if (!(l > 0)) return null;
  return { t: ts * MIN, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: num(b.volume) || 0 } as Candle;
}

/** Strips broker suffixes and separators: "EURUSD.r", "EUR/USD", "EURUSDm" → "EURUSD". */
export function normalizeBrokerSymbol(name: string): string | null {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
  for (const inst of INSTRUMENTS) if (letters === inst.symbol) return inst.symbol;
  for (const inst of INSTRUMENTS) if (letters.startsWith(inst.symbol) && letters.length <= 8) return inst.symbol;
  return null;
}

export interface CTraderConfig {
  clientId: string;
  clientSecret: string;
  tokens: Tokens;
  account?: string;
  url?: string;
  wsFactory?: WsFactory;
  /** Called whenever cTrader issues a new access/refresh token pair. */
  saveTokens?: (t: Tokens) => void;
  log?: (m: string) => void;
  h1Bars?: number;
  m1Bars?: number;
  /** Pause between history requests (cTrader allows 5 per second). */
  historyGapMs?: number;
}

interface SymbolInfo {
  symbol: string;
  symbolId: number;
  digits: number;
}

// ---------------------------------------------------------------------------
// Real-price market: cTrader spots and trendbars behind the simulator's interface.
// ---------------------------------------------------------------------------

export class CTraderMarket {
  readonly real = true;
  label = 'cTrader demo · real prices';
  time = Date.now();
  error = '';
  accountLabel = '';
  readonly candles: Record<string, Record<Timeframe, Candle[]>> = {};
  private readonly quotes: Record<string, Quote> = {};
  private readonly symbols = new Map<number, SymbolInfo>();
  private client: CTraderClient | null = null;
  private accountId = 0;
  private lastSpot = 0;
  private fresh = false;
  private stopped = false;
  private reconnectDelay = 2_000;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: (m: string) => void;

  private constructor(private readonly cfg: CTraderConfig) {
    this.log = cfg.log ?? (() => {});
  }

  /** Connects, authorizes a demo account, loads history for the 16 pairs and subscribes to prices. */
  static async create(cfg: CTraderConfig): Promise<CTraderMarket> {
    const m = new CTraderMarket(cfg);
    await m.connectAndAuth(true);
    await m.loadHistory(cfg.h1Bars ?? 5000, cfg.m1Bars ?? 1440);
    await m.subscribe();
    return m;
  }

  private async connectAndAuth(first: boolean): Promise<void> {
    const client = new CTraderClient(resolveCtraderUrl(this.cfg.url), this.cfg.wsFactory, 15_000, this.cfg.historyGapMs ?? 250);
    client.onEvent = (t, p) => this.onEvent(t, p);
    client.onClose = (r) => this.onDisconnect(r);
    await client.connect();
    this.client = client;
    try {
      await client.request(PT.APP_AUTH_REQ, { clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret });
      if (this.cfg.tokens.expiresAt && this.cfg.tokens.expiresAt - Date.now() < 3 * DAY) await this.refreshTokens();
      let list: Record<string, unknown>;
      try {
        list = await client.request(PT.ACCOUNT_LIST_REQ, { accessToken: this.cfg.tokens.accessToken });
      } catch (e) {
        if (!(e instanceof CTraderError) || !/TOKEN|ACCESS/i.test(e.code)) throw e;
        await this.refreshTokens();
        list = await client.request(PT.ACCOUNT_LIST_REQ, { accessToken: this.cfg.tokens.accessToken });
      }
      const accounts = (list.ctidTraderAccount as Record<string, unknown>[] | undefined) ?? [];
      const demo = accounts.filter((a) => a.isLive !== true);
      const wanted = this.cfg.account?.trim();
      const acc = wanted ? demo.find((a) => String(a.traderLogin) === wanted || String(a.ctidTraderAccountId) === wanted) : demo[0];
      if (!acc) {
        const liveOnly = accounts.length > 0 && demo.length === 0;
        throw new CTraderError(
          liveOnly
            ? 'This cTrader ID only has live accounts. NEONFX only uses demo accounts.'
            : wanted
              ? `Demo account ${wanted} not found for this cTrader ID`
              : 'No demo account found for this cTrader ID',
          'NO_DEMO_ACCOUNT',
        );
      }
      this.accountId = num(acc.ctidTraderAccountId);
      await client.request(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: this.accountId, accessToken: this.cfg.tokens.accessToken });
      this.accountLabel = `${String(acc.brokerTitleShort ?? 'demo')} ${String(acc.traderLogin ?? this.accountId)}`;
      this.label = `cTrader demo · ${this.accountLabel}`;
      if (first) await this.loadSymbols();
      this.scheduleRefresh();
    } catch (e) {
      client.close();
      this.client = null;
      throw e;
    }
  }

  private async refreshTokens(): Promise<void> {
    const r = await this.client!.request(PT.REFRESH_TOKEN_REQ, { refreshToken: this.cfg.tokens.refreshToken });
    const accessToken = String(r.accessToken ?? '');
    const refreshToken = String(r.refreshToken ?? '');
    if (!accessToken || !refreshToken) throw new CTraderError('cTrader returned no new token', 'REFRESH_FAILED');
    const expiresIn = num(r.expiresIn);
    this.cfg.tokens = { accessToken, refreshToken, expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 30 * DAY) };
    this.cfg.saveTokens?.(this.cfg.tokens);
    this.log('cTrader access token refreshed');
  }

  /** Refresh the access token a few days before it expires, without dropping the connection. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const exp = this.cfg.tokens.expiresAt || Date.now() + 27 * DAY;
    const due = Math.min(Math.max(exp - 3 * DAY - Date.now(), 60_000), 2 ** 31 - 1);
    this.refreshTimer = setTimeout(() => {
      this.refreshTokens()
        .then(() => this.client?.request(PT.ACCOUNT_AUTH_REQ, { ctidTraderAccountId: this.accountId, accessToken: this.cfg.tokens.accessToken }).catch(() => {}))
        .catch((e) => this.log(`cTrader token refresh failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => this.scheduleRefresh());
    }, due);
    this.refreshTimer.unref?.();
  }

  private async loadSymbols(): Promise<void> {
    const list = await this.client!.request(PT.SYMBOLS_LIST_REQ, { ctidTraderAccountId: this.accountId, includeArchivedSymbols: false });
    const found = new Map<string, number>();
    for (const s of (list.symbol as Record<string, unknown>[] | undefined) ?? []) {
      if (s.enabled === false) continue;
      const sym = normalizeBrokerSymbol(String(s.symbolName ?? ''));
      if (!sym) continue;
      const exact = String(s.symbolName ?? '').toUpperCase().replace(/[^A-Z]/g, '') === sym;
      if (!found.has(sym) || exact) found.set(sym, num(s.symbolId));
    }
    const missing = INSTRUMENTS.filter((i) => !found.has(i.symbol)).map((i) => i.symbol);
    if (missing.length) throw new CTraderError(`The broker does not offer: ${missing.join(', ')}`, 'MISSING_SYMBOLS');
    const ids = [...found.values()];
    const detail = await this.client!.request(PT.SYMBOL_BY_ID_REQ, { ctidTraderAccountId: this.accountId, symbolId: ids });
    const digitsById = new Map<number, number>();
    for (const s of (detail.symbol as Record<string, unknown>[] | undefined) ?? []) digitsById.set(num(s.symbolId), num(s.digits));
    for (const [symbol, symbolId] of found) {
      const inst = getInstrument(symbol);
      const d = digitsById.get(symbolId);
      this.symbols.set(symbolId, { symbol, symbolId, digits: Number.isFinite(d) && d! > 0 ? d! : inst.digits });
    }
  }

  private async bars(info: SymbolInfo, period: number, want: number, windowMs: number, maxRequests: number): Promise<Candle[]> {
    const byTime = new Map<number, Candle>();
    let to = Date.now();
    for (let i = 0; i < maxRequests && byTime.size < want; i++) {
      const from = to - windowMs;
      const r = await this.client!.history({ ctidTraderAccountId: this.accountId, symbolId: info.symbolId, period, fromTimestamp: from, toTimestamp: to });
      for (const b of (r.trendbar as Record<string, unknown>[] | undefined) ?? []) {
        const c = trendbarToCandle(b, info.digits);
        if (c) byTime.set(c.t, c);
      }
      to = from;
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-want);
  }

  /** Long hourly history per pair for strategy research; filled by loadResearch(). */
  readonly research: Record<string, Candle[]> = {};
  /** True once every pair has its research history. */
  researchReady = false;

  /**
   * Loads years of the broker's own hourly bars for the strategy lab (the live series keep
   * their shorter history, so start-up and the terminal stay fast). Safe to call again to
   * refresh; on an error the previous research history stays in use.
   */
  async loadResearch(h1Bars = 18_000): Promise<number> {
    let min = Infinity;
    for (const info of this.symbols.values()) {
      if (this.stopped) return 0;
      if (!this.client) throw new CTraderError('Not connected to cTrader', 'DISCONNECTED');
      const c = await this.bars(info, PERIOD.H1, h1Bars, 35 * DAY, Math.ceil(h1Bars / 500) + 8);
      if (c.length < 3000) throw new CTraderError(`cTrader returned only ${c.length} hourly bars of research history for ${info.symbol}`, 'SHORT_HISTORY');
      this.research[info.symbol] = c;
      min = Math.min(min, c.length);
    }
    this.researchReady = Object.keys(this.research).length === this.symbols.size;
    return this.researchReady ? min : 0;
  }

  private async loadHistory(h1: number, m1: number): Promise<void> {
    for (const info of this.symbols.values()) {
      const hours = await this.bars(info, PERIOD.H1, h1, 35 * DAY, Math.ceil(h1 / 500) + 4);
      const minutes = await this.bars(info, PERIOD.M1, m1, 2 * DAY, 6);
      if (hours.length < 300) throw new CTraderError(`cTrader returned only ${hours.length} hourly bars for ${info.symbol}`, 'SHORT_HISTORY');
      this.candles[info.symbol] = {
        M1: minutes,
        M5: aggregate(minutes, 'M5'),
        M15: aggregate(minutes, 'M15'),
        H1: hours,
        H4: aggregate(hours, 'H4'),
        D1: aggregate(hours, 'D1'),
      };
      // Seed a quote from the last close so the bot has a price before the first spot arrives.
      const last = hours[hours.length - 1];
      const inst = getInstrument(info.symbol);
      if (last && !this.quotes[info.symbol]) {
        const half = (inst.spread * inst.pip) / 2;
        this.quotes[info.symbol] = { symbol: info.symbol, bid: last.c - half, ask: last.c + half, mid: last.c, spread: inst.spread, t: last.t };
      }
    }
  }

  private async subscribe(): Promise<void> {
    await this.client!.request(PT.SUBSCRIBE_SPOTS_REQ, {
      ctidTraderAccountId: this.accountId,
      symbolId: [...this.symbols.keys()],
      subscribeToSpotTimestamp: true,
    });
  }

  private onEvent(type: number, p: Record<string, unknown>): void {
    if (type === PT.SPOT_EVENT) this.onSpot(p);
    else if (type === PT.TOKEN_INVALIDATED_EVENT) {
      this.error = `cTrader token invalidated: ${String(p.reason ?? '')}`;
      this.log(this.error);
      this.client?.close();
      this.onDisconnect('token invalidated');
    } else if (type === PT.CLIENT_DISCONNECT_EVENT) {
      this.log(`cTrader disconnected the bot: ${String(p.reason ?? '')}`);
    }
  }

  /** Applies a spot event: bid/ask are optional and only sent when they change. */
  onSpot(p: Record<string, unknown>): void {
    const info = this.symbols.get(num(p.symbolId));
    if (!info) return;
    const inst = getInstrument(info.symbol);
    const prev = this.quotes[info.symbol];
    const f = 10 ** info.digits;
    const px = (v: unknown) => Math.round((num(v) / PRICE_SCALE) * f) / f;
    const bid = p.bid !== undefined ? px(p.bid) : prev?.bid;
    const ask = p.ask !== undefined ? px(p.ask) : prev?.ask;
    if (!(bid && bid > 0) || !(ask && ask >= bid)) return;
    const ts = num(p.timestamp);
    const t = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
    this.quotes[info.symbol] = { symbol: info.symbol, bid, ask, mid: (bid + ask) / 2, spread: Math.round(((ask - bid) / inst.pip) * 10) / 10, t };
    if (bid !== prev?.bid) for (const tf of TIMEFRAMES) applyTick(this.candles[info.symbol][tf], t, bid, tf, 1);
    this.time = Date.now();
    this.lastSpot = this.time;
    this.fresh = true;
    if (this.error) {
      this.log('cTrader prices are flowing again');
      this.error = '';
    }
  }

  private onDisconnect(reason: string): void {
    this.client = null;
    if (this.stopped) return;
    if (!this.error) this.error = `cTrader ${reason}`;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5 * MIN);
    this.log(`cTrader ${reason}; reconnecting in ${Math.round(delay / 1000)}s. Trading pauses until prices return`);
    const t = setTimeout(() => void this.reconnect(), delay);
    t.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.stopped || this.client) return;
    try {
      await this.connectAndAuth(false);
      await this.subscribe();
      this.reconnectDelay = 2_000;
      this.log('cTrader reconnected');
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.onDisconnect('reconnect failed');
    }
  }

  quote(symbol: string): Quote | undefined {
    return this.quotes[symbol];
  }

  readonly mid: MidLookup = (symbol) => this.quotes[symbol]?.mid;

  series(symbol: string, tf: Timeframe): Candle[] {
    return this.candles[symbol][tf];
  }

  /** Trading allowed only while connected, during FX hours, with a price seen in the last 2 minutes. */
  isOpen(): boolean {
    return this.client !== null && Date.now() - this.lastSpot < 2 * MIN && isFxOpen(Date.now());
  }

  /** Calls onStep once when new prices arrived since the last call. */
  advanceTo(_now: number, onStep?: () => void): void {
    if (!this.fresh) return;
    this.fresh = false;
    onStep?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.client?.close();
    this.client = null;
  }
}

