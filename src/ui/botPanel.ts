import type { BotControl, BotStatus } from '../core/botTypes';
import { clock, dateTime, escapeHtml, lots as fmtLots, money, moneySigned, pct } from '../core/format';
import { displaySymbol } from '../core/instruments';
import { load, save } from '../core/storage';
import { $, setText } from './dom';
import type { App } from './context';
import { drawCurve } from './minicharts';

interface Saved {
  url: string;
  token: string;
  connected: boolean;
}

const POLL_MS = 5000;

/**
 * The "24/7 Bot" tab: a remote view of the headless bot through its token-protected API.
 * The bot must be reachable from this browser (same machine, VPN or SSH tunnel).
 */
export function initBotPanel(app: App): { render(): void } {
  const urlIn = $<HTMLInputElement>('bot-url');
  const tokenIn = $<HTMLInputElement>('bot-token');
  const stateEl = $('bot-state');
  const view = $('bot-view');
  const autoIn = $<HTMLInputElement>('bot-auto');
  const labIn = $<HTMLInputElement>('bot-lab');
  const saved = load<Saved>('bot');
  if (saved?.url) urlIn.value = saved.url;
  if (saved?.token) tokenIn.value = saved.token;
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: BotStatus | null = null;
  let connected = false;

  const base = () => urlIn.value.trim().replace(/\/+$/, '');

  function note(): void {
    const page = location.protocol;
    const parts = [
      'Shows the headless 24/7 bot (<code>npm run bot</code> or Docker) and lets you switch its autopilot and lab. The token is in <code>data/neonfx-token.txt</code> on the bot machine and is stored in this browser after connecting.',
    ];
    if (page === 'https:' && base().startsWith('http:')) {
      parts.unshift(
        '<b>This page is served over https, so the browser will block a plain http connection to the bot.</b> Open the terminal from the bot machine instead (<code>npm run dev</code>, then http://localhost:5173), or put the bot behind https.',
      );
    }
    $('bot-note').innerHTML = parts.join(' ');
  }

  async function call(path: string, init: RequestInit = {}): Promise<BotStatus> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(base() + path, {
        ...init,
        signal: ctrl.signal,
        headers: { 'x-neonfx-token': tokenIn.value.trim(), ...(init.body ? { 'content-type': 'application/json' } : {}) },
      });
      if (res.status === 401) throw new Error('Token rejected. Copy it from data/neonfx-token.txt on the bot machine');
      if (!res.ok) throw new Error(`The bot answered HTTP ${res.status}`);
      return (await res.json()) as BotStatus;
    } catch (e) {
      if (e instanceof Error && /Token|HTTP/.test(e.message)) throw e;
      throw new Error(`Can't reach the bot at ${base()}. Is it running, and is this the right address and port?`);
    } finally {
      clearTimeout(t);
    }
  }

  async function poll(): Promise<void> {
    try {
      last = await call('/api/status');
      connected = true;
      setText(stateEl, `Connected · updated ${clock(Date.now())}`);
      stateEl.className = 'ph-note pos';
      render();
    } catch (e) {
      setText(stateEl, e instanceof Error ? e.message : String(e));
      stateEl.className = 'ph-note neg';
      if (!last) view.hidden = true;
    }
    setText($('cnt-bot'), connected && last ? (last.autopilot.enabled ? 'ON' : 'OFF') : '—');
  }

  function start(): void {
    stop();
    save('bot', { url: base(), token: tokenIn.value.trim(), connected: true } satisfies Saved);
    $('bot-connect').hidden = true;
    $('bot-disconnect').hidden = false;
    setText(stateEl, 'Connecting...');
    stateEl.className = 'ph-note';
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  $('bot-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!/^https?:\/\/[^\s]+$/i.test(base())) {
      setText(stateEl, 'Enter an address like http://127.0.0.1:8787');
      stateEl.className = 'ph-note neg';
      return;
    }
    if (tokenIn.value.trim().length < 12) {
      setText(stateEl, 'Paste the token from data/neonfx-token.txt');
      stateEl.className = 'ph-note neg';
      return;
    }
    start();
  });
  $('bot-disconnect').addEventListener('click', () => {
    stop();
    connected = false;
    last = null;
    save('bot', { url: base(), token: tokenIn.value.trim(), connected: false } satisfies Saved);
    view.hidden = true;
    $('bot-connect').hidden = false;
    $('bot-disconnect').hidden = true;
    setText(stateEl, 'Disconnected');
    stateEl.className = 'ph-note';
    setText($('cnt-bot'), '—');
  });
  urlIn.addEventListener('input', note);

  async function control(c: BotControl): Promise<void> {
    try {
      last = await call('/api/control', { method: 'POST', body: JSON.stringify(c) });
      app.log(`24/7 bot: ${c.auto !== undefined ? `autopilot ${c.auto ? 'ON' : 'OFF'}` : `lab ${c.lab ? 'ON' : 'OFF'}`}`, 'ok');
      render();
    } catch (e) {
      app.toast('Bot', e instanceof Error ? e.message : String(e), 'err');
      render();
    }
  }
  autoIn.addEventListener('change', () => void control({ auto: autoIn.checked }));
  labIn.addEventListener('change', () => void control({ lab: labIn.checked }));

  function render(): void {
    const s = last;
    if (!s) return;
    view.hidden = false;
    setText($('cnt-bot'), s.autopilot.enabled ? 'ON' : 'OFF');
    if (app.prefs.tab !== 'bot') return;
    autoIn.checked = s.autopilot.enabled;
    labIn.checked = s.lab.running;
    const up = s.uptimeSec >= 86400 ? `${Math.floor(s.uptimeSec / 86400)}d ${Math.floor((s.uptimeSec % 86400) / 3600)}h` : `${Math.floor(s.uptimeSec / 3600)}h ${Math.floor((s.uptimeSec % 3600) / 60)}m`;
    setText($('bot-meta'), `${s.feed} · ${s.marketOpen ? 'market open' : 'market closed'} · up ${up} · ${s.autopilot.mode}, ${s.autopilot.timeframe}`);
    const a = s.account;
    const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    const tile = (k: string, v: string, cls = '', sub = '') =>
      `<div class="tile"><span class="k">${k}</span><span class="v ${cls}">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
    const b = s.broker;
    $('bot-tiles').innerHTML = [
      tile('Equity', money(a.equity)),
      tile('Balance', money(a.balance)),
      tile('Floating', moneySigned(a.floating), sign(a.floating)),
      tile('Day P/L', moneySigned(a.dayPnl), sign(a.dayPnl), pct(a.dayPnlPct, 2, true)),
      tile('Closed trades', String(a.trades)),
      tile('Lab', `${s.lab.tested}`, '', `${s.lab.perMinute}/min · gen ${s.lab.generation}`),
      ...(b ? [tile('Broker', b.connected ? 'OK' : 'ERROR', b.connected ? 'pos' : 'neg', escapeHtml(b.label))] : []),
    ].join('');
    drawCurve(
      $<HTMLCanvasElement>('bot-curve'),
      s.equityHistory.map((p) => p[1]),
      s.equityHistory[0]?.[1] ?? a.equity,
      'Collecting data: one point per hour',
    );
    $('bot-pos').innerHTML =
      '<thead><tr><th>#</th><th>Pair</th><th>Side</th><th class="r">Lots</th><th class="r">Entry</th><th class="r">S/L</th><th class="r">T/P</th><th class="r">P/L</th></tr></thead><tbody>' +
      (s.positions
        .map(
          (p) =>
            `<tr><td class="dim">${p.id}</td><td><b>${escapeHtml(displaySymbol(p.symbol))}</b>${p.autopilot ? ' <span class="badge probation">AUTO</span>' : ''}</td><td class="side-${p.side === 'buy' ? 'buy' : 'sell'}">${p.side.toUpperCase()}</td><td class="r">${fmtLots(p.lots)}</td><td class="r">${p.entry}</td><td class="r">${p.sl ?? '—'}</td><td class="r">${p.tp ?? '—'}</td><td class="r ${sign(p.pl)}">${moneySigned(p.pl)}</td></tr>`,
        )
        .join('') || '<tr><td colspan="8" class="dim">No open positions</td></tr>') +
      '</tbody>';
    $('bot-trades').innerHTML =
      '<thead><tr><th>Closed</th><th>Pair</th><th>Side</th><th class="r">Lots</th><th class="r">Net</th><th class="r">R</th><th>Reason</th></tr></thead><tbody>' +
      (s.recentTrades
        .map(
          (t) =>
            `<tr><td class="dim">${dateTime(t.closeTime)}</td><td><b>${escapeHtml(displaySymbol(t.symbol))}</b></td><td class="side-${t.side === 'buy' ? 'buy' : 'sell'}">${t.side.toUpperCase()}</td><td class="r">${fmtLots(t.lots)}</td><td class="r ${sign(t.net)}">${moneySigned(t.net)}</td><td class="r">${t.r === null ? '—' : t.r.toFixed(2)}</td><td class="dim">${escapeHtml(t.reason)}</td></tr>`,
        )
        .join('') || '<tr><td colspan="7" class="dim">No closed trades yet</td></tr>') +
      '</tbody>';
    $('bot-deps').innerHTML =
      '<thead><tr><th>Strategy</th><th>Status</th><th class="r">Trades</th><th class="r">Avg R</th><th class="r">Net</th><th class="r">Risk</th></tr></thead><tbody>' +
      (s.autopilot.deployments
        .map(
          (d) =>
            `<tr><td class="desc">${escapeHtml(d.strategy)}<span class="dim" style="display:block">${escapeHtml(d.note)}</span></td><td><span class="badge ${escapeHtml(d.status)}">${escapeHtml(d.status)}</span></td><td class="r">${d.liveTrades}</td><td class="r ${sign(d.avgR)}">${d.liveTrades ? d.avgR.toFixed(2) + 'R' : '—'}</td><td class="r ${sign(d.net)}">${d.liveTrades ? moneySigned(d.net) : '—'}</td><td class="r">${d.riskPct}%</td></tr>`,
        )
        .join('') || '<tr><td colspan="6" class="dim">Waiting for the lab</td></tr>') +
      '</tbody>';
    $('bot-lessons').innerHTML =
      s.autopilot.lessons
        .map((l) => `<li><span class="badge ${escapeHtml(l.status)}">${escapeHtml(l.status)}</span> ${escapeHtml(l.lesson)}<span class="dim">${escapeHtml(l.detail)}</span></li>`)
        .join('') || '<li class="dim">No lessons yet</li>';
    $('bot-lab').innerHTML =
      `<thead><tr><th>Strategy</th><th class="r">Train</th><th class="r">Valid</th><th class="r">Holdout</th><th class="r">Pairs +</th><th></th></tr></thead><tbody>` +
      (s.lab.best
        .map(
          (e) =>
            `<tr><td class="desc">${escapeHtml(e.strategy)}</td><td class="r">${e.trainR.toFixed(2)}R</td><td class="r">${e.validR.toFixed(2)}R</td><td class="r">${e.holdoutR.toFixed(2)}R</td><td class="r">${escapeHtml(e.pairsPositive)}</td><td>${e.robust ? '<span class="badge robust">robust</span>' : ''}</td></tr>`,
        )
        .join('') || '<tr><td colspan="6" class="dim">No candidates yet</td></tr>') +
      '</tbody>';
    const log = $('bot-log');
    const text = s.log.slice().reverse().join('\n');
    if (log.textContent !== text) log.textContent = text;
  }

  note();
  if (saved?.connected && saved.token) start();
  return { render };
}
