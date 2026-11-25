/**
 * NEONFX 24/7 BOT
 *
 * Headless version of the terminal for an always-on machine (VPS, home server, Raspberry Pi).
 * It runs the simulated market, the paper account, the autopilot and the strategy lab
 * continuously, saves its state to disk, and serves a read-only status page.
 *
 *   npm run bot                     # build + start
 *   docker compose up -d            # or run it in Docker with auto-restart
 *
 * Settings (environment variables):
 *   NEONFX_DATA      data folder (default ./data)       NEONFX_PORT  status port (8787)
 *   NEONFX_HOST      status host (127.0.0.1)            NEONFX_AUTO  on|off  (on)
 *   NEONFX_LAB       on|off (on)                        NEONFX_MODE  explore|strict (explore)
 *   NEONFX_RISK      risk % per trade (0.5)             NEONFX_TF    H1|H4 (H1)
 *   NEONFX_LAB_DUTY  share of CPU time for the lab, 0.1–1 (1)
 * Put real OHLC CSV exports in <data>/history/ and the lab researches on those instead.
 * Notifications (Telegram, Discord, Slack, ntfy, webhook): see bot/notify.ts and the README.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { freshState, parseState, TradingEngine, type EngineEvent } from '../src/core/account';
import { Autopilot, freshAutopilotState, liveMean, parseAutopilotState, type ApLogKind, type Lesson } from '../src/core/autopilot';
import { parseCsv } from '../src/core/csv';
import { csvDataset, marketDatasets } from '../src/core/datasets';
import { escapeHtml, money, moneySigned } from '../src/core/format';
import type { Genome } from '../src/core/genome';
import { displaySymbol, FALLBACK_RATES, unitsToLots } from '../src/core/instruments';
import type { Dataset, Evaluation, LabStats } from '../src/core/lab';
import { createLabHost, type LabOut } from '../src/core/labHost';
import { isValidSnapshot, MarketSim, sanitizeRates, type MarketSeed, type MarketSnapshot } from '../src/core/market';
import { randomSeed } from '../src/core/rng';
import { DAY, tradingDayKey } from '../src/core/time';
import { channelsFromEnv, createNotifier } from './notify';
import { handleRequest, loadOrCreateToken } from './api';
import type { BotControl, BotStatus } from '../src/core/botTypes';

const env = process.env;
const DATA = env.NEONFX_DATA ?? join(process.cwd(), 'data');
const HISTORY = join(DATA, 'history');
const STATE_FILE = join(DATA, 'neonfx-state.json');
const LOG_FILE = join(DATA, 'neonfx.log');
const MARKET_FILE = join(DATA, 'neonfx-market.json.gz');
const PORT = Number(env.NEONFX_PORT ?? 8787);
const HOST = env.NEONFX_HOST ?? '127.0.0.1';
const DUTY = Math.min(1, Math.max(0.1, Number(env.NEONFX_LAB_DUTY ?? 1) || 1));
const flag = (v: string | undefined, def: boolean) => (v === undefined ? def : /^(1|on|true|yes)$/i.test(v));

mkdirSync(HISTORY, { recursive: true });

// ---------------------------------------------------------------- logging
const recent: string[] = [];
function log(msg: string, kind: ApLogKind | 'ok' = 'info'): void {
  const line = `${new Date().toISOString()} [${kind.toUpperCase()}] ${msg}`;
  console.log(line);
  recent.push(line);
  if (recent.length > 200) recent.shift();
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + '.1');
    appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* logging must never stop the bot */
  }
}

// ---------------------------------------------------------------- state
interface Saved {
  version: 1;
  savedAt: number;
  account: unknown;
  autopilot: unknown;
  market: { t: number; rates: unknown };
  lab: { hof: Evaluation[]; stats: Partial<LabStats> };
  /** Hourly equity snapshots [time, equity]. */
  equity?: [number, number][];
  report?: { day: number; equity: number; trades: number };
}

function loadSaved(): Partial<Saved> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Saved;
  } catch {
    return {};
  }
}

async function chooseSeed(saved: Partial<Saved>): Promise<MarketSeed> {
  if (saved.market && Date.now() - saved.market.t < 7 * DAY) {
    const rates = sanitizeRates(saved.market.rates);
    if (rates) return { rates, source: 'resumed', label: 'resumed last session' };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD', { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const j = (await res.json()) as { rates?: Record<string, number>; date?: string };
      const rates = sanitizeRates({ USD: 1, ...(j.rates ?? {}) });
      if (rates) return { rates, source: 'ecb', label: `ECB ${String(j.date ?? '').slice(0, 10)}` };
    }
  } catch {
    /* offline */
  }
  return { rates: FALLBACK_RATES, source: 'builtin', label: 'built-in rates' };
}

function realDatasets(mid: MarketSim['mid']): { datasets: Dataset[]; names: string[] } {
  const datasets: Dataset[] = [];
  const names: string[] = [];
  for (const f of readdirSync(HISTORY)) {
    if (!/\.(csv|txt)$/i.test(f)) continue;
    try {
      const csv = parseCsv(readFileSync(join(HISTORY, f), 'utf8'), f);
      datasets.push(csvDataset(csv, mid));
      names.push(`${f} (${csv.candles.length} bars)`);
    } catch (e) {
      log(`Skipping ${f}: ${e instanceof Error ? e.message : String(e)}`, 'warn');
    }
  }
  return { datasets, names };
}

/** The simulated market of the previous run, so history and prices continue after a restart. */
function loadMarketSnapshot(): MarketSnapshot | null {
  try {
    const snap: unknown = JSON.parse(gunzipSync(readFileSync(MARKET_FILE)).toString('utf8'));
    if (isValidSnapshot(snap) && Date.now() - snap.time < 14 * DAY && snap.time <= Date.now()) return snap;
    log('Saved market history is too old or invalid; generating fresh history', 'warn');
  } catch {
    /* no snapshot yet */
  }
  return null;
}

function saveMarketSnapshot(market: MarketSim): void {
  try {
    writeFileSync(MARKET_FILE + '.tmp', gzipSync(JSON.stringify(market.snapshot())));
    renameSync(MARKET_FILE + '.tmp', MARKET_FILE);
  } catch (e) {
    log(`Could not save market history: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
}

async function main(): Promise<void> {
  const saved = loadSaved();
  const snap = loadMarketSnapshot();
  const seed = snap ? snap.seed : await chooseSeed(saved);
  log(`NEONFX bot starting · data ${DATA} · price anchor: ${seed.label}`);
  const notifier = createNotifier(channelsFromEnv(env), env.NEONFX_NOTIFY === 'all' ? 'all' : 'important', (m) => log(m, 'warn'));
  log(notifier.channels ? `Notifications: ${notifier.channels} channel(s), level ${notifier.level}` : 'Notifications: none configured (see README)');
  const market = new MarketSim(seed, Date.now(), randomSeed(), snap ?? undefined);
  const engine = new TradingEngine(parseState(saved.account) ?? freshState(), {
    quote: (s) => market.quote(s),
    mid: market.mid,
    now: () => market.time,
    isOpen: () => market.isOpen(),
  });
  if (snap) {
    const behind = (Date.now() - snap.time) / 3_600_000;
    log(`Market history restored (${market.candles.EURUSD.H1.length} hourly bars). Simulating the ${behind.toFixed(1)} hours the bot was off...`);
    market.advanceTo(Date.now(), () => engine.onTick());
  }
  const apState = parseAutopilotState(saved.autopilot) ?? freshAutopilotState();
  apState.config.enabled = flag(env.NEONFX_AUTO, true);
  apState.config.lab = flag(env.NEONFX_LAB, true);
  if (env.NEONFX_MODE === 'strict' || env.NEONFX_MODE === 'explore') apState.config.mode = env.NEONFX_MODE;
  if (env.NEONFX_RISK && Number(env.NEONFX_RISK) > 0) apState.config.riskPct = Math.min(2, Number(env.NEONFX_RISK));
  if (env.NEONFX_TF === 'H1' || env.NEONFX_TF === 'H4') apState.config.tf = env.NEONFX_TF;

  // ---- lab (in-process, time-sliced)
  let hof: Evaluation[] = [];
  let labStats: LabStats | null = null;
  let labRate = 0;
  let req = 0;
  const pending = new Map<number, (r: { ok: boolean; detail: string }) => void>();
  const labIn = createLabHost((m: LabOut) => {
    if (m.type === 'progress') {
      hof = m.hof;
      labStats = m.stats;
      labRate = m.rate;
    } else {
      pending.get(m.req)?.({ ok: m.ok, detail: m.detail });
      pending.delete(m.req);
    }
  });
  labIn({
    type: 'init',
    seed: randomSeed(),
    commission: engine.state.settings.commissionPerLot,
    hof: saved.lab?.hof ?? [],
    stats: saved.lab?.stats ?? {},
    blacklist: apState.blacklist,
  });
  let dataLabel = '';
  const refreshData = () => {
    const real = realDatasets(market.mid);
    if (real.datasets.length) {
      apState.config.labData = 'csv';
      const label = `real data: ${real.names.join(', ')}`;
      if (label !== dataLabel) {
        labIn({ type: 'data', datasets: real.datasets, kind: 'real', label });
        log(`LAB researching ${label}`);
      }
      dataLabel = label;
    } else {
      apState.config.labData = 'sim';
      const ds = marketDatasets((s, tf) => market.series(s, tf), apState.config.tf, apState.config.universe, market.mid);
      dataLabel = `simulated ${apState.config.tf}, ${ds.length} pairs`;
      labIn({ type: 'data', datasets: ds, kind: 'sim', label: dataLabel });
    }
  };
  refreshData();
  labIn({ type: 'run', on: apState.config.lab, duty: DUTY });

  const autopilot = new Autopilot(apState, {
    engine,
    series: (s, tf) => market.series(s, tf),
    quote: (s) => market.quote(s),
    mid: market.mid,
    now: () => market.time,
    validate: (lesson: Lesson, genomes: Genome[]) =>
      new Promise((resolve) => {
        const id = ++req;
        pending.set(id, resolve);
        labIn({ type: 'validate', req: id, lesson, genomes });
      }),
    log: (msg, kind) => {
      log(msg, kind);
      if (/^AUTOPILOT (deployed|promoted|demoted|benched|learned|upgrade)/.test(msg)) notifier.send(`NEONFX · ${msg.slice(10)}`, 'autopilot', true);
    },
  });

  engine.on((e: EngineEvent) => {
    if (e.type === 'open') {
      const p = e.position;
      const msg = `FILLED #${p.id} ${p.side.toUpperCase()} ${unitsToLots(p.units)} ${displaySymbol(p.symbol)} @ ${p.entry} SL ${p.sl ?? '-'} TP ${p.tp ?? '-'}`;
      log(msg, 'ok');
      notifier.send(`NEONFX · ${msg}`, 'fill', false);
    } else if (e.type === 'close') {
      const t = e.trade;
      const msg = `CLOSED #${t.positionId} ${displaySymbol(t.symbol)} ${moneySigned(t.net)} (${t.r === null ? '-' : t.r.toFixed(2) + 'R'}) · ${t.reason}`;
      log(msg, t.net >= 0 ? 'ok' : 'warn');
      notifier.send(`NEONFX · ${msg}`, 'close', t.reason === 'stopout');
      autopilot.onClose(t);
    } else if (e.type === 'guard-lock') {
      log(`RISK GUARD LOCK: ${e.reason}`, 'err');
      notifier.send(`NEONFX · Risk guard locked trading: ${e.reason}`, 'guard', true);
    } else if (e.type === 'margin-call') {
      log(`MARGIN CALL: ${e.level.toFixed(0)}%`, 'err');
      notifier.send(`NEONFX · MARGIN CALL: margin level ${e.level.toFixed(0)}%`, 'margin', true);
    } else if (e.type === 'cancel') log(`CANCELLED #${e.order.id}: ${e.reason}`, 'warn');
  });

  // ---- equity history and daily report
  const equityLog: [number, number][] = Array.isArray(saved.equity) ? saved.equity.slice(-24 * 180) : [];
  let report = saved.report ?? { day: tradingDayKey(market.time), equity: engine.metrics().equity, trades: engine.state.history.length };
  const sendDailyReport = () => {
    const m = engine.metrics();
    const closed = engine.state.history.slice(Math.min(report.trades, engine.state.history.length));
    const wins = closed.filter((t) => t.net > 0).length;
    const dayPnl = m.equity - report.equity;
    const deps = autopilot.state.deployments
      .map((d) => `  ${d.status.toUpperCase()} ${d.desc} · ${d.live.n} trades · ${liveMean(d.live) >= 0 ? '+' : ''}${liveMean(d.live).toFixed(2)}R`)
      .join('\n');
    const lessons = autopilot.state.lessons.filter((l) => l.status === 'active').map((l) => `  ${l.label}`).join('\n');
    const text = [
      `NEONFX daily report (paper trading)`,
      `Equity ${money(m.equity)} · day ${moneySigned(dayPnl)} (${report.equity > 0 ? ((dayPnl / report.equity) * 100).toFixed(2) : '0.00'}%)`,
      `Closed trades: ${closed.length} (${wins} won) · net ${moneySigned(closed.reduce((a, t) => a + t.net, 0))} · open now: ${engine.state.positions.length}`,
      `Strategies:\n${deps || '  none deployed'}`,
      `Lessons in force:\n${lessons || '  none'}`,
      `Lab: ${labStats?.tested ?? 0} tested, best score ${labStats && Number.isFinite(labStats.bestScore) ? labStats.bestScore.toFixed(2) : '-'} (${dataLabel})`,
    ].join('\n');
    log(text.replace(/\n/g, ' | '));
    notifier.send(text, 'report', true);
    report = { day: tradingDayKey(market.time), equity: m.equity, trades: engine.state.history.length };
  };
  setInterval(() => {
    const now = market.time;
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    if (!equityLog.length || equityLog[equityLog.length - 1][0] < hour) {
      equityLog.push([hour, Math.round(engine.metrics().equity * 100) / 100]);
      if (equityLog.length > 24 * 180) equityLog.shift();
    }
    if (tradingDayKey(now) !== report.day) sendDailyReport();
  }, 60_000);

  // ---- persistence
  const persist = () => {
    const data: Saved = {
      version: 1,
      savedAt: Date.now(),
      account: engine.state,
      autopilot: autopilot.state,
      market: { t: market.time, rates: market.snapshotRates() },
      lab: { hof, stats: labStats ?? {} },
      equity: equityLog,
      report,
    };
    try {
      writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data));
      renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
      log(`Could not save state: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  };

  // ---- loops
  let banned = 0;
  setInterval(() => {
    market.advanceTo(Date.now(), () => engine.onTick());
    autopilot.onTick();
  }, 1000);
  setInterval(() => {
    if (apState.config.enabled) autopilot.sync(hof.filter((e) => e.dataVersion === labStats?.dataVersion), labStats?.tested ?? 0);
    if (apState.blacklist.length > banned) {
      labIn({ type: 'ban', ids: apState.blacklist.slice(banned) });
      banned = apState.blacklist.length;
    }
  }, 5000);
  setInterval(refreshData, 30 * 60_000);
  setInterval(persist, 30_000);
  setInterval(() => saveMarketSnapshot(market), 60 * 60_000);
  setInterval(() => {
    const m = engine.metrics();
    log(
      `HEARTBEAT equity ${money(m.equity)} · ${engine.state.positions.length} open · ${autopilot.liveDeployments().length} strategies live · lab ${labStats?.tested ?? 0} tested (${labRate}/min), best ${labStats && Number.isFinite(labStats.bestScore) ? labStats.bestScore.toFixed(2) : '-'}`,
    );
  }, 15 * 60_000);

  // ---- status server (read-only)
  const status = (): BotStatus => {
    const m = engine.metrics();
    return {
      time: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      feed: `SIM · ${market.seed.label}`,
      marketOpen: market.isOpen(),
      equityHistory: equityLog.slice(-24 * 30),
      account: { ...m, marginLevel: Number.isFinite(m.marginLevel) ? m.marginLevel : null, trades: engine.state.history.length },
      positions: engine.state.positions.map((p) => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        lots: unitsToLots(p.units),
        entry: p.entry,
        sl: p.sl,
        tp: p.tp,
        pl: Math.round(engine.floating(p) * 100) / 100,
        autopilot: !!autopilot.state.owned[String(p.id)],
      })),
      recentTrades: engine.state.history
        .slice(-20)
        .reverse()
        .map((t) => ({ closeTime: t.closeTime, symbol: t.symbol, side: t.side, lots: unitsToLots(t.units), net: t.net, r: t.r, reason: t.reason })),
      autopilot: {
        enabled: apState.config.enabled,
        mode: apState.config.mode,
        timeframe: apState.config.tf,
        deployments: apState.deployments.map((d) => ({
          strategy: d.desc,
          status: d.status,
          note: d.note,
          liveTrades: d.live.n,
          avgR: Math.round(liveMean(d.live) * 100) / 100,
          net: Math.round(d.live.net * 100) / 100,
          riskPct: d.status === 'benched' ? 0 : autopilot.riskFor(d),
        })),
        lessons: apState.lessons.map((l) => ({ lesson: l.label, status: l.status, detail: l.detail })),
        counters: apState.counters,
      },
      lab: {
        running: apState.config.lab,
        data: dataLabel,
        generation: labStats?.generation ?? 0,
        tested: labStats?.tested ?? 0,
        perMinute: labRate,
        best: hof.slice(0, 5).map((e) => ({
          strategy: e.desc,
          score: Math.round(e.score * 100) / 100,
          trainR: Math.round(e.train.meanR * 1000) / 1000,
          validR: Math.round(e.val.meanR * 1000) / 1000,
          holdoutR: Math.round(e.hold.meanR * 1000) / 1000,
          pairsPositive: e.breadthN ? `${Math.round(e.breadth * e.breadthN)}/${e.breadthN}` : '-',
          robust: e.robust,
        })),
      },
      broker: null,
      log: recent.slice(-40),
    };
  };
  const sparkline = (pts: [number, number][]) => {
    if (pts.length < 2) return '<div style="color:#5d5788">Collecting data: one point per hour.</div>';
    const vs = pts.map((p) => p[1]);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const span = hi - lo || 1;
    const w = 600;
    const h = 90;
    const path = vs.map((v, i) => `${((i / (vs.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - lo) / span) * (h - 8)).toFixed(1)}`).join(' ');
    const col = vs[vs.length - 1] >= vs[0] ? '#00f0b5' : '#ff2f7d';
    return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;max-width:${w}px;height:auto;background:#0d0b19;border:1px solid #2a2452"><polyline fill="none" stroke="${col}" stroke-width="2" points="${path}"/></svg><div style="color:#8f88bf">${escapeHtml(money(lo))} – ${escapeHtml(money(hi))}</div>`;
  };
  const page = () => {
    const s = status();
    const row = (cells: (string | number)[]) => `<tr>${cells.map((c) => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="15"><title>NEONFX bot</title>
<style>body{margin:0;padding:16px;background:#07060d;color:#ece9ff;font:13px/1.45 ui-monospace,Menlo,monospace}h1{font:700 18px system-ui;color:#2de2ff;margin:0 0 4px}h2{font:600 12px system-ui;letter-spacing:.14em;text-transform:uppercase;color:#8f88bf;margin:18px 0 6px}table{border-collapse:collapse;width:100%;max-width:1100px}td{border-bottom:1px solid #2a2452;padding:4px 8px;vertical-align:top}.wrap{overflow-x:auto}pre{white-space:pre-wrap;color:#8f88bf;font-size:11px}</style></head><body>
<h1>NEONFX bot</h1><div>${escapeHtml(s.time)} · up ${Math.round(s.uptimeSec / 60)} min · ${escapeHtml(s.feed)} · paper trading</div>
${s.marketOpen ? '' : '<div style="color:#ffc23d">FX market closed for the weekend: prices are frozen until Sunday 17:00 New York.</div>'}
<h2>Equity (hourly, last 30 days)</h2>${sparkline(s.equityHistory)}
<h2>Account</h2><div class="wrap"><table>${row(['Equity', money(s.account.equity)])}${row(['Balance', money(s.account.balance)])}${row(['Floating', moneySigned(s.account.floating)])}${row(['Day P/L', moneySigned(s.account.dayPnl)])}${row(['Closed trades', s.account.trades])}</table></div>
<h2>Positions</h2><div class="wrap"><table>${s.positions.map((p) => row([`#${p.id}`, displaySymbol(p.symbol), p.side, p.lots, p.entry, `SL ${p.sl ?? '-'}`, `TP ${p.tp ?? '-'}`, moneySigned(p.pl), p.autopilot ? 'autopilot' : 'manual'])).join('') || row(['none'])}</table></div>
<h2>Autopilot (${s.autopilot.enabled ? 'ON' : 'OFF'}, ${escapeHtml(s.autopilot.mode)}, ${escapeHtml(s.autopilot.timeframe)})</h2><div class="wrap"><table>${s.autopilot.deployments.map((d) => row([d.strategy, d.status, `${d.liveTrades} trades`, `${d.avgR}R`, moneySigned(d.net), `${d.riskPct}%`, d.note])).join('') || row(['waiting for the lab'])}</table></div>
<h2>Lessons</h2><div class="wrap"><table>${s.autopilot.lessons.map((l) => row([l.status, l.lesson, l.detail])).join('') || row(['none yet'])}</table></div>
<h2>Lab (${escapeHtml(s.lab.data)})</h2><div>generation ${s.lab.generation} · ${s.lab.tested} tested · ${s.lab.perMinute}/min</div><div class="wrap"><table>${s.lab.best.map((b) => row([b.strategy, `score ${b.score}`, `train ${b.trainR}R`, `valid ${b.validR}R`, `holdout ${b.holdoutR}R`, b.robust ? 'robust' : ''])).join('')}</table></div>
<h2>Log</h2><pre>${escapeHtml(s.log.slice().reverse().join('\n'))}</pre></body></html>`;
  };
  const access = loadOrCreateToken(DATA, env.NEONFX_TOKEN);
  const control = (c: BotControl) => {
    if (c.auto !== undefined && c.auto !== apState.config.enabled) {
      apState.config.enabled = c.auto;
      const msg = `Autopilot switched ${c.auto ? 'ON' : 'OFF'} from the terminal`;
      log(msg);
      notifier.send(`NEONFX · ${msg}`, 'control', true);
    }
    if (c.lab !== undefined && c.lab !== apState.config.lab) {
      apState.config.lab = c.lab;
      labIn({ type: 'run', on: c.lab, duty: DUTY });
      log(`Lab switched ${c.lab ? 'ON' : 'OFF'} from the terminal`);
    }
    persist();
  };
  createServer((rq, rs) => handleRequest(rq, rs, { token: access.token, status, page, control }))
    .on('error', (e) => log(`Status server: ${e.message}`, 'err'))
    .listen(PORT, HOST, () =>
      log(
        `Status page on http://${HOST}:${PORT}/ · terminal API at /api (token ${access.created ? 'created' : 'stored'} in ${access.token === env.NEONFX_TOKEN ? 'NEONFX_TOKEN' : access.file})`,
      ),
    );

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: saving state and stopping`);
    persist();
    saveMarketSnapshot(market);
    notifier.send(`NEONFX bot stopped (${sig}). Equity ${money(engine.metrics().equity)}. State saved.`, 'stop', true);
    await notifier.flush(8000);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log(`Crash: ${e.stack ?? e.message}`, 'err');
    persist();
    saveMarketSnapshot(market);
    notifier.send(`NEONFX bot CRASHED: ${e.message}. It will restart if run under Docker or a service manager.`, 'crash', true);
    void notifier.flush(4000).finally(() => process.exit(1));
  });
  notifier.send(
    `NEONFX bot started · equity ${money(engine.metrics().equity)} · autopilot ${apState.config.enabled ? 'ON' : 'OFF'} · lab ${apState.config.lab ? 'ON' : 'OFF'} · ${market.isOpen() ? 'market open' : 'market closed (weekend)'}`,
    'start',
    true,
  );
  log(
    `Autopilot ${apState.config.enabled ? 'ON' : 'OFF'} (${apState.config.mode}, ${apState.config.riskPct}% risk, ${apState.config.tf}) · lab ${apState.config.lab ? 'ON' : 'OFF'} · ${engine.state.positions.length} open positions · balance ${money(engine.state.balance)}`,
  );
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, 'err');
  process.exit(1);
});
