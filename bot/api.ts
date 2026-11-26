import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BotControl, BotStatus, EngineOp, EngineOpResult, LiveDump, MarketDump } from '../src/core/botTypes';

/**
 * HTTP routes of the bot.
 *   GET  /              the NEONFX terminal, connected to this bot (or the plain status page
 *                       when the terminal build is missing). Same machine only, no token.
 *   GET  /classic       plain status page
 *   GET  /status        status JSON (no token, no cross-origin access)
 *   GET  /api/status    status JSON for the terminal (token + CORS)
 *   GET  /api/market    prices and candle history (token)
 *   GET  /api/live?h=n  prices and the account, history from index n (token)
 *   POST /api/engine    manual trading actions on the bot's account (token)
 *   POST /api/control   {"auto": bool, "lab": bool} (token + CORS)
 * The token is sent as the `x-neonfx-token` header. Pages are only served to local host
 * names (localhost, 127.0.0.1, [::1]); the port is only reachable through an SSH tunnel or VPN.
 */
export interface ApiDeps {
  token: string;
  status(): BotStatus;
  page(): string;
  control(c: BotControl): void;
  /** The terminal's HTML, or null when it was not built. */
  terminal?(): string | null;
  market?(): MarketDump;
  live?(historyFrom: number): LiveDump;
  engine?(op: EngineOp): EngineOpResult;
}

export function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** NEONFX_TOKEN if set, else the token saved in the data folder, else a new random one. */
export function loadOrCreateToken(dataDir: string, envToken: string | undefined): { token: string; file: string; created: boolean } {
  const file = join(dataDir, 'neonfx-token.txt');
  if (envToken && envToken.length >= 12) return { token: envToken, file, created: false };
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 12) return { token: t, file, created: false };
  }
  const token = randomBytes(18).toString('base64url');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  return { token, file, created: true };
}

/** Only local host names: stops DNS-rebinding pages from reading the terminal (and its token). */
export function localHost(host: string | undefined): boolean {
  if (!host) return true;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name.endsWith('.localhost');
}

/** Puts the bot's token into the terminal page so it connects by itself. */
export function injectToken(html: string, token: string): string {
  const meta = `<meta name="neonfx-bot" content="${token.replace(/[^A-Za-z0-9_-]/g, '')}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : meta + html;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-neonfx-token',
  'access-control-allow-private-network': 'true',
  'access-control-max-age': '600',
};

function json(rq: IncomingMessage, rs: ServerResponse, code: number, body: unknown, cors: boolean): void {
  let data: Buffer = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(cors ? CORS : {}) };
  if (data.length > 8192 && /\bgzip\b/.test(String(rq.headers['accept-encoding'] ?? ''))) {
    data = gzipSync(data);
    headers['content-encoding'] = 'gzip';
  }
  rs.writeHead(code, headers).end(data);
}

function readBody(rq: IncomingMessage, max: number, done: (body: string | null) => void): void {
  let body = '';
  let tooBig = false;
  rq.on('data', (c: Buffer) => {
    body += c.toString('utf8');
    if (body.length > max) {
      tooBig = true;
      rq.destroy();
    }
  });
  rq.on('end', () => done(tooBig ? null : body));
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optNum = (v: unknown) => v === undefined || v === null || num(v);

/** Validates the shape of an engine operation coming from the network. */
export function parseEngineOp(raw: unknown): EngineOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  switch (o.op) {
    case 'submit': {
      const r = o.req as Record<string, unknown> | undefined;
      if (!r || typeof r.symbol !== 'string' || (r.side !== 'buy' && r.side !== 'sell') || !num(r.units) || r.units <= 0) return null;
      if (r.type !== 'market' && r.type !== 'limit' && r.type !== 'stop') return null;
      if (!optNum(r.price) || !optNum(r.slPips) || !optNum(r.tpPips) || !optNum(r.trailPips)) return null;
      return {
        op: 'submit',
        req: {
          symbol: r.symbol,
          side: r.side,
          units: r.units,
          type: r.type,
          ...(num(r.price) ? { price: r.price } : {}),
          slPips: num(r.slPips) ? r.slPips : null,
          tpPips: num(r.tpPips) ? r.tpPips : null,
          trailPips: num(r.trailPips) ? r.trailPips : null,
        },
      };
    }
    case 'close':
      return num(o.id) ? { op: 'close', id: o.id, ...(num(o.units) ? { units: o.units } : {}) } : null;
    case 'closeIds':
      return Array.isArray(o.ids) && o.ids.length <= 500 && o.ids.every(num) ? { op: 'closeIds', ids: o.ids as number[] } : null;
    case 'modify': {
      const c = o.changes as Record<string, unknown> | undefined;
      if (!num(o.id) || !c || typeof c !== 'object') return null;
      const changes: { sl?: number | null; tp?: number | null; trailPips?: number | null } = {};
      for (const k of ['sl', 'tp', 'trailPips'] as const) {
        if (!(k in c)) continue;
        if (!optNum(c[k])) return null;
        changes[k] = (c[k] as number | null | undefined) ?? null;
      }
      return { op: 'modify', id: o.id, changes };
    }
    case 'breakEven':
    case 'reverse':
    case 'cancelOrder':
      return num(o.id) ? { op: o.op, id: o.id } : null;
    case 'config': {
      const g = o.guard as Record<string, unknown> | undefined;
      if (!g || typeof g.enabled !== 'boolean' || typeof g.requireStopLoss !== 'boolean' || typeof g.autoFlatten !== 'boolean') return null;
      if (!num(g.maxRiskPct) || !num(g.dailyLossPct) || !num(g.maxPositions) || !num(o.leverage) || !num(o.commissionPerLot)) return null;
      return {
        op: 'config',
        guard: {
          enabled: g.enabled,
          requireStopLoss: g.requireStopLoss,
          maxRiskPct: Math.min(100, Math.max(0, g.maxRiskPct)),
          dailyLossPct: Math.min(100, Math.max(0, g.dailyLossPct)),
          maxPositions: Math.round(Math.min(200, Math.max(1, g.maxPositions))),
          autoFlatten: g.autoFlatten,
        },
        leverage: Math.min(500, Math.max(1, o.leverage)),
        commissionPerLot: Math.min(100, Math.max(0, o.commissionPerLot)),
      };
    }
    default:
      return null;
  }
}

export function handleRequest(rq: IncomingMessage, rs: ServerResponse, deps: ApiDeps): void {
  const full = new URL(rq.url ?? '/', 'http://localhost');
  const url = full.pathname;
  const isApi = url.startsWith('/api/');
  if (isApi && rq.method === 'OPTIONS') {
    rs.writeHead(204, CORS).end();
    return;
  }
  // The terminal page carries the token, so pages are only served to local host names.
  if (!isApi && !localHost(rq.headers.host)) {
    rs.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
    return;
  }
  if (isApi && !tokenOk(String(rq.headers['x-neonfx-token'] ?? ''), deps.token)) {
    json(rq, rs, 401, { error: 'Missing or wrong token. It is in data/neonfx-token.txt on the bot machine.' }, true);
    return;
  }
  if (rq.method === 'GET' && url === '/api/status') return json(rq, rs, 200, deps.status(), true);
  if (rq.method === 'GET' && url === '/api/market' && deps.market) return json(rq, rs, 200, deps.market(), true);
  if (rq.method === 'GET' && url === '/api/live' && deps.live) {
    const h = Number(full.searchParams.get('h') ?? 0);
    return json(rq, rs, 200, deps.live(Number.isInteger(h) && h >= 0 ? h : 0), true);
  }
  if (rq.method === 'POST' && url === '/api/engine' && deps.engine) {
    readBody(rq, 4096, (body) => {
      if (body === null) return;
      let op: EngineOp | null = null;
      try {
        op = parseEngineOp(JSON.parse(body || '{}'));
      } catch {
        op = null;
      }
      if (!op) return json(rq, rs, 400, { ok: false, error: 'Invalid request' }, true);
      let result: EngineOpResult;
      try {
        result = deps.engine!(op);
      } catch (e) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      json(rq, rs, 200, result, true);
    });
    return;
  }
  if (rq.method === 'POST' && url === '/api/control') {
    readBody(rq, 1024, (body) => {
      if (body === null) return;
      let c: BotControl;
      try {
        const raw = JSON.parse(body || '{}') as Record<string, unknown>;
        c = {};
        if (typeof raw.auto === 'boolean') c.auto = raw.auto;
        if (typeof raw.lab === 'boolean') c.lab = raw.lab;
      } catch {
        json(rq, rs, 400, { error: 'Body must be JSON like {"auto": true}' }, true);
        return;
      }
      deps.control(c);
      json(rq, rs, 200, deps.status(), true);
    });
    return;
  }
  if (isApi) return json(rq, rs, 404, { error: 'not found' }, true);
  if (rq.method !== 'GET') {
    rs.writeHead(405).end();
    return;
  }
  if (url === '/status') return json(rq, rs, 200, deps.status(), false);
  const html = (body: string): void => {
    rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
  };
  if (url === '/') {
    const t = deps.terminal?.() ?? null;
    return html(t ? injectToken(t, deps.token) : deps.page());
  }
  if (url === '/classic') return html(deps.page());
  rs.writeHead(404).end('not found');
}
