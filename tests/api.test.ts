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
