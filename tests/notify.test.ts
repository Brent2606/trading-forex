import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { channelsFromEnv, createNotifier } from '../bot/notify';

let server: Server;
let base = '';
const received: { url: string; type: string; body: string }[] = [];
let failNext = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(500).end();
        return;
      }
      received.push({ url: req.url ?? '', type: String(req.headers['content-type']), body });
      res.writeHead(req.url === '/bad' ? 403 : 200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('notifications', () => {
  it('builds channels from the environment', () => {
    const ch = channelsFromEnv({
      NEONFX_TELEGRAM_TOKEN: 'TOKEN',
      NEONFX_TELEGRAM_CHAT: '42',
      NEONFX_DISCORD_WEBHOOK: 'https://discord.example/x',
      NEONFX_NTFY_URL: 'https://ntfy.example/topic',
    });
    expect(ch.map((c) => c.name)).toEqual(['telegram', 'discord', 'ntfy']);
    expect(ch[0].url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    expect(JSON.parse(ch[0].body('hi', 'e').body)).toEqual({ chat_id: '42', text: 'hi', disable_web_page_preview: true });
    expect(JSON.parse(ch[1].body('hi', 'e').body)).toEqual({ content: 'hi' });
    expect(ch[2].body('hi', 'e')).toEqual({ body: 'hi', contentType: 'text/plain; charset=utf-8' });
    expect(channelsFromEnv({ NEONFX_TELEGRAM_TOKEN: 'only-token' })).toHaveLength(0);
  });

  it('delivers in order, filters by level and retries server errors', async () => {
    received.length = 0;
    const logs: string[] = [];
    const n = createNotifier(
      channelsFromEnv({ NEONFX_DISCORD_WEBHOOK: `${base}/discord`, NEONFX_WEBHOOK: `${base}/hook` }),
      'important',
      (m) => logs.push(m),
      10,
    );
    failNext = 1;
    n.send('first', 'start', true);
    n.send('a fill', 'fill', false); // filtered: level is "important"
    n.send('second', 'report', true);
    await n.flush();
    const discord = received.filter((r) => r.url === '/discord').map((r) => JSON.parse(r.body).content);
    expect(discord).toEqual(['first', 'second']);
    const hook = received.filter((r) => r.url === '/hook').map((r) => JSON.parse(r.body));
    expect(hook.map((h) => h.event)).toEqual(['start', 'report']);
    expect(logs).toHaveLength(0);
  });

  it('sends everything at level "all", truncates long messages and reports refusals once', async () => {
    received.length = 0;
    const logs: string[] = [];
    const n = createNotifier(channelsFromEnv({ NEONFX_NTFY_URL: `${base}/ntfy`, NEONFX_SLACK_WEBHOOK: `${base}/bad` }), 'all', (m) => logs.push(m), 10);
    n.send('x'.repeat(5000), 'fill', false);
    await n.flush();
    const ntfy = received.find((r) => r.url === '/ntfy')!;
    expect(ntfy.type).toMatch(/text\/plain/);
    expect(ntfy.body.length).toBeLessThanOrEqual(3500);
    expect(logs.some((l) => /slack refused \(HTTP 403\)/.test(l))).toBe(true);
  });

  it('does nothing without channels', async () => {
    const n = createNotifier([], 'all', () => undefined);
    n.send('x', 'e', true);
    await n.flush(100);
    expect(n.channels).toBe(0);
  });
});
