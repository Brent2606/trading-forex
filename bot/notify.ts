/**
 * Push notifications for the 24/7 bot. Configure one or more channels with environment
 * variables; tokens are only read from the environment and never logged.
 *
 *   NEONFX_TELEGRAM_TOKEN + NEONFX_TELEGRAM_CHAT   Telegram bot (via @BotFather)
 *   NEONFX_DISCORD_WEBHOOK                         Discord channel webhook URL
 *   NEONFX_SLACK_WEBHOOK                           Slack incoming webhook URL
 *   NEONFX_NTFY_URL                                ntfy topic URL, e.g. https://ntfy.sh/my-secret-topic
 *   NEONFX_WEBHOOK                                 any URL; receives JSON {"event","text","time"}
 *   NEONFX_NOTIFY  important | all                 "all" also sends every fill and close
 */

export type NotifyLevel = 'important' | 'all';

export interface Channel {
  name: string;
  url: string;
  body(text: string, event: string): { body: string; contentType: string };
}

export interface Notifier {
  /** Number of configured channels. */
  readonly channels: number;
  readonly level: NotifyLevel;
  /** Queues a message. `important` messages are always sent; others only with level "all". */
  send(text: string, event: string, important: boolean): void;
  /** Resolves once the queue is empty (used on shutdown and in tests). */
  flush(timeoutMs?: number): Promise<void>;
}

const MAX_LEN = 3500;

export function channelsFromEnv(env: Record<string, string | undefined>): Channel[] {
  const out: Channel[] = [];
  const json = (o: unknown) => ({ body: JSON.stringify(o), contentType: 'application/json' });
  if (env.NEONFX_TELEGRAM_TOKEN && env.NEONFX_TELEGRAM_CHAT) {
    const chat = env.NEONFX_TELEGRAM_CHAT;
    out.push({
      name: 'telegram',
      url: `https://api.telegram.org/bot${env.NEONFX_TELEGRAM_TOKEN}/sendMessage`,
      body: (text) => json({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  }
  if (env.NEONFX_DISCORD_WEBHOOK) out.push({ name: 'discord', url: env.NEONFX_DISCORD_WEBHOOK, body: (text) => json({ content: text }) });
  if (env.NEONFX_SLACK_WEBHOOK) out.push({ name: 'slack', url: env.NEONFX_SLACK_WEBHOOK, body: (text) => json({ text }) });
  if (env.NEONFX_NTFY_URL) out.push({ name: 'ntfy', url: env.NEONFX_NTFY_URL, body: (text) => ({ body: text, contentType: 'text/plain; charset=utf-8' }) });
  if (env.NEONFX_WEBHOOK) {
    out.push({ name: 'webhook', url: env.NEONFX_WEBHOOK, body: (text, event) => json({ event, text, time: new Date().toISOString() }) });
  }
  return out;
}

/**
 * Sends messages one at a time (at most one every `gapMs` per channel) with two retries.
 * Failures are reported through `log` but never thrown: notifications must not stop trading.
 */
export function createNotifier(
  channels: Channel[],
  level: NotifyLevel,
  log: (msg: string) => void,
  gapMs = 1500,
): Notifier {
  const queue: { text: string; event: string }[] = [];
  let busy: Promise<void> | null = null;
  let warned = false;

  const post = async (ch: Channel, text: string, event: string) => {
    const { body, contentType } = ch.body(text, event);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        const res = await fetch(ch.url, { method: 'POST', headers: { 'content-type': contentType }, body, signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          log(`Notification to ${ch.name} refused (HTTP ${res.status}). Check its settings`);
          return;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!warned) {
      warned = true;
      log(`Notification to ${ch.name} failed after 3 attempts (further failures are not logged)`);
    }
  };

  const drain = async () => {
    while (queue.length) {
      const { text, event } = queue.shift()!;
      await Promise.all(channels.map((ch) => post(ch, text, event)));
      if (queue.length) await new Promise((r) => setTimeout(r, gapMs));
    }
  };

  return {
    channels: channels.length,
    level,
    send(text, event, important) {
      if (!channels.length || (!important && level !== 'all')) return;
      queue.push({ text: text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + '…' : text, event });
      if (queue.length > 50) queue.splice(0, queue.length - 50);
      if (!busy) busy = drain().finally(() => (busy = null));
    },
    async flush(timeoutMs = 15_000) {
      const t0 = Date.now();
      while ((busy || queue.length) && Date.now() - t0 < timeoutMs) {
        if (busy) await Promise.race([busy, new Promise((r) => setTimeout(r, 200))]);
        else await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}
