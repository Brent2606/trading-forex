import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { BotControl, BotStatus } from '../src/core/botTypes';

/**
 * HTTP routes of the bot.
 *   GET  /              the bot dashboard (same machine only, no token; reads /status)
 *   GET  /classic       the plain server-rendered status page
 *   GET  /status        status JSON (no token, no cross-origin access)
 *   GET  /api/status    status JSON for the terminal (token + CORS)
 *   POST /api/control   {"auto": bool, "lab": bool} (token + CORS)
 * The token is sent as the `x-neonfx-token` header.
 */
export interface ApiDeps {
  token: string;
  status(): BotStatus;
  page(): string;
  classicPage?: () => string;
  control(c: BotControl): void;
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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-neonfx-token',
  'access-control-allow-private-network': 'true',
  'access-control-max-age': '600',
};

function json(rs: ServerResponse, code: number, body: unknown, cors: boolean): void {
  rs.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(cors ? CORS : {}),
  }).end(JSON.stringify(body));
}

export function handleRequest(rq: IncomingMessage, rs: ServerResponse, deps: ApiDeps): void {
  const url = (rq.url ?? '/').split('?')[0];
  const isApi = url.startsWith('/api/');
  if (isApi && rq.method === 'OPTIONS') {
    rs.writeHead(204, CORS).end();
    return;
  }
  if (isApi && !tokenOk(String(rq.headers['x-neonfx-token'] ?? ''), deps.token)) {
    json(rs, 401, { error: 'Missing or wrong token. It is in data/neonfx-token.txt on the bot machine.' }, true);
    return;
  }
  if (rq.method === 'GET' && url === '/api/status') return json(rs, 200, deps.status(), true);
  if (rq.method === 'POST' && url === '/api/control') {
    let body = '';
    let tooBig = false;
    rq.on('data', (c: Buffer) => {
      body += c.toString('utf8');
      if (body.length > 1024) {
        tooBig = true;
        rq.destroy();
      }
    });
    rq.on('end', () => {
      if (tooBig) return;
      let c: BotControl;
      try {
        const raw = JSON.parse(body || '{}') as Record<string, unknown>;
        c = {};
        if (typeof raw.auto === 'boolean') c.auto = raw.auto;
        if (typeof raw.lab === 'boolean') c.lab = raw.lab;
      } catch {
        json(rs, 400, { error: 'Body must be JSON like {"auto": true}' }, true);
        return;
      }
      deps.control(c);
      json(rs, 200, deps.status(), true);
    });
    return;
  }
  if (isApi) return json(rs, 404, { error: 'not found' }, true);
  if (rq.method !== 'GET') {
    rs.writeHead(405).end();
    return;
  }
  if (url === '/status') return json(rs, 200, deps.status(), false);
  if (url === '/classic' && deps.classicPage) {
    rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(deps.classicPage());
    return;
  }
  if (url === '/') {
    rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(deps.page());
    return;
  }
  rs.writeHead(404).end('not found');
}
