import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRequest, loadOrCreateToken, tokenOk } from '../bot/api';
import type { BotControl, BotStatus } from '../src/core/botTypes';

const TOKEN = 'secret-token-123456';
const controls: BotControl[] = [];
const status = { time: 'now', autopilot: { enabled: false } } as unknown as BotStatus;
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((rq, rs) =>
    handleRequest(rq, rs, { token: TOKEN, status: () => status, page: () => '<html>ok</html>', control: (c) => controls.push(c) }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('bot API', () => {
  it('compares tokens safely', () => {
    expect(tokenOk(TOKEN, TOKEN)).toBe(true);
    expect(tokenOk('secret-token-123457', TOKEN)).toBe(false);
    expect(tokenOk('short', TOKEN)).toBe(false);
    expect(tokenOk(undefined, TOKEN)).toBe(false);
    expect(tokenOk('', '')).toBe(false);
  });

  it('requires the token for /api routes and allows cross-origin reads with it', async () => {
    const denied = await fetch(`${base}/api/status`);
    expect(denied.status).toBe(401);
    const wrong = await fetch(`${base}/api/status`, { headers: { 'x-neonfx-token': 'nope-nope-nope-nope' } });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base}/api/status`, { headers: { 'x-neonfx-token': TOKEN } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    expect(await ok.json()).toEqual(status);
  });

  it('answers CORS preflight', async () => {
    const r = await fetch(`${base}/api/control`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-headers')).toMatch(/x-neonfx-token/);
  });

  it('applies only valid control fields', async () => {
    controls.length = 0;
    const r = await fetch(`${base}/api/control`, {
      method: 'POST',
      headers: { 'x-neonfx-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ auto: true, lab: 'yes', evil: 1 }),
    });
    expect(r.status).toBe(200);
    expect(controls).toEqual([{ auto: true }]);
    const bad = await fetch(`${base}/api/control`, { method: 'POST', headers: { 'x-neonfx-token': TOKEN }, body: '{oops' });
    expect(bad.status).toBe(400);
    const noToken = await fetch(`${base}/api/control`, { method: 'POST', body: '{"auto":false}' });
    expect(noToken.status).toBe(401);
    expect(controls).toHaveLength(1);
  });

  it('keeps the local status page and JSON without CORS', async () => {
    const page = await fetch(`${base}/`);
    expect(await page.text()).toContain('ok');
    const s = await fetch(`${base}/status`);
    expect(s.status).toBe(200);
    expect(s.headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`${base}/status`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('creates and reuses a token file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nfx-'));
    const a = loadOrCreateToken(dir, undefined);
    expect(a.created).toBe(true);
    expect(a.token.length).toBeGreaterThanOrEqual(20);
    expect(readFileSync(a.file, 'utf8').trim()).toBe(a.token);
    const b = loadOrCreateToken(dir, undefined);
    expect(b).toEqual({ ...a, created: false });
    expect(loadOrCreateToken(dir, 'my-own-long-token').token).toBe('my-own-long-token');
    expect(loadOrCreateToken(dir, 'short').token).toBe(a.token);
  });
});

describe('bot API for the terminal', () => {
  it('only serves pages to local host names and injects the token', async () => {
    const { injectToken, localHost } = await import('../bot/api');
    expect(localHost('localhost:8787')).toBe(true);
    expect(localHost('127.0.0.1:8787')).toBe(true);
    expect(localHost('[::1]:8787')).toBe(true);
    expect(localHost('evil.example.com')).toBe(false);
    expect(localHost(undefined)).toBe(true);
    expect(injectToken('<html><head><title>x</title></head></html>', 'abc_DEF-123456')).toBe(
      '<html><head><meta name="neonfx-bot" content="abc_DEF-123456"><title>x</title></head></html>',
    );
    expect(injectToken('<head>', 'a"><script>')).toBe('<head><meta name="neonfx-bot" content="ascript">');
    // fetch() won't override Host, so use node:http for the rebinding case.
    const { request } = await import('node:http');
    const code = await new Promise<number>((resolve) => {
      const u = new URL(base);
      request({ host: u.hostname, port: u.port, path: '/', headers: { host: 'evil.example.com' } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      }).end();
    });
    expect(code).toBe(403);
  });

  it('validates engine operations', async () => {
    const { parseEngineOp } = await import('../bot/api');
    expect(parseEngineOp({ op: 'submit', req: { symbol: 'EURUSD', side: 'buy', units: 1000, type: 'market', slPips: 20, tpPips: null } })).toEqual({
      op: 'submit',
      req: { symbol: 'EURUSD', side: 'buy', units: 1000, type: 'market', slPips: 20, tpPips: null, trailPips: null },
    });
    expect(parseEngineOp({ op: 'submit', req: { symbol: 'EURUSD', side: 'hold', units: 1000, type: 'market' } })).toBeNull();
    expect(parseEngineOp({ op: 'submit', req: { symbol: 'EURUSD', side: 'buy', units: -5, type: 'market' } })).toBeNull();
    expect(parseEngineOp({ op: 'close', id: 1002 })).toEqual({ op: 'close', id: 1002 });
    expect(parseEngineOp({ op: 'closeIds', ids: [1, 'x'] })).toBeNull();
    expect(parseEngineOp({ op: 'modify', id: 5, changes: { sl: 1.1, tp: null } })).toEqual({ op: 'modify', id: 5, changes: { sl: 1.1, tp: null } });
    expect(parseEngineOp({ op: 'reset' })).toBeNull();
    const cfg = parseEngineOp({
      op: 'config',
      guard: { enabled: true, requireStopLoss: true, maxRiskPct: 500, dailyLossPct: 5, maxPositions: 0, autoFlatten: false },
      leverage: 30,
      commissionPerLot: 3.5,
    });
    expect(cfg).toMatchObject({ op: 'config', guard: { maxRiskPct: 100, maxPositions: 1 }, leverage: 30 });
  });

  it('routes market, live and engine calls behind the token', async () => {
    const { handleRequest: hr } = await import('../bot/api');
    const ops: unknown[] = [];
    const srv = createServer((rq, rs) =>
      hr(rq, rs, {
        token: TOKEN,
        status: () => status,
        page: () => 'page',
        control: () => undefined,
        terminal: () => '<html><head></head><body>terminal</body></html>',
        market: () => ({ time: 1, label: 'SIM', real: false, open: true, quotes: [], candles: {} }),
        live: (h) => ({ time: 1, label: 'SIM', real: false, open: true, quotes: [], state: {} as never, historyFrom: h, owned: [], notesRev: 1 }),
        engine: (op) => {
          ops.push(op);
          return op.op === 'close' ? { ok: false, error: 'Position #9 not found' } : { ok: true };
        },
      }),
    );
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const h = { 'x-neonfx-token': TOKEN, 'content-type': 'application/json' };
    try {
      expect(await (await fetch(`${b}/`)).text()).toContain(`<meta name="neonfx-bot" content="${TOKEN}">`);
      expect(await (await fetch(`${b}/classic`)).text()).toBe('page');
      expect((await fetch(`${b}/api/market`)).status).toBe(401);
      expect(((await (await fetch(`${b}/api/market`, { headers: h })).json()) as { label: string }).label).toBe('SIM');
      expect(((await (await fetch(`${b}/api/live?h=7`, { headers: h })).json()) as { historyFrom: number }).historyFrom).toBe(7);
      const ok = await (await fetch(`${b}/api/engine`, { method: 'POST', headers: h, body: JSON.stringify({ op: 'breakEven', id: 3 }) })).json();
      expect(ok).toEqual({ ok: true });
      const no = await (await fetch(`${b}/api/engine`, { method: 'POST', headers: h, body: JSON.stringify({ op: 'close', id: 9 }) })).json();
      expect(no).toEqual({ ok: false, error: 'Position #9 not found' });
      expect((await fetch(`${b}/api/engine`, { method: 'POST', headers: h, body: '{"op":"reset"}' })).status).toBe(400);
      expect(ops).toEqual([{ op: 'breakEven', id: 3 }, { op: 'close', id: 9 }]);
    } finally {
      srv.close();
    }
  });
});
