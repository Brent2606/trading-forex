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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshState, parseState, TradingEngine, type EngineEvent } from '../src/core/account';
import { Autopilot, freshAutopilotState, liveMean, parseAutopilotState, type ApLogKind, type Lesson } from '../src/core/autopilot';
import { parseCsv } from '../src/core/csv';
import { csvDataset, marketDatasets } from '../src/core/datasets';
import { escapeHtml, money, moneySigned } from '../src/core/format';
import type { Genome } from '../src/core/genome';
import { displaySymbol, FALLBACK_RATES, INSTRUMENTS, unitsToLots } from '../src/core/instruments';
import type { Dataset, Evaluation, LabStats } from '../src/core/lab';
import { createLabHost, type LabOut } from '../src/core/labHost';
import { isValidSnapshot, MarketSim, sanitizeRates, type MarketSeed, type MarketSnapshot } from '../src/core/market';
import { randomSeed } from '../src/core/rng';
import { DAY, isFxOpen, nextFxChange, tradingDayKey } from '../src/core/time';
import { bucketStart, TF_MS } from '../src/core/candles';
import { channelsFromEnv, createNotifier } from './notify';
import { setLang, trLines } from '../src/core/i18n';
import { freshMirrorState, OandaClient, OandaMarket, OandaMirror, resolveBaseUrl, type MirrorState } from './oanda';
import type { Candle, Timeframe } from '../src/core/candles';
import type { MidLookup, Quote } from '../src/core/rates';
import { handleRequest, loadOrCreateToken } from './api';
import { CTraderMarket, type Tokens } from './ctrader';
import type { BotControl, BotStatus, CandleRow, EngineOp, EngineOpResult, LiveDump, MarketDump } from '../src/core/botTypes';

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
  mirror?: MirrorState;
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

/** What the bot needs from a price source: the simulator or OANDA's real prices. */
interface BotMarket {
  readonly time: number;
  readonly label: string;
  readonly real: boolean;
  quote(symbol: string): Quote | undefined;
  mid: MidLookup;
  series(symbol: string, tf: Timeframe): Candle[];
  isOpen(): boolean;
  advanceTo(now: number, onStep?: () => void): void;
}

const maskId = (id: string) => id.replace(/\d(?=\d{3})/g, '•');

// ---- cTrader tokens: the environment gives the first pair; refreshed pairs are kept on disk.
const CTRADER_TOKENS_FILE = join(DATA, 'ctrader-tokens.json');
function loadCtraderTokens(): Tokens | null {
  try {
    const t = JSON.parse(readFileSync(CTRADER_TOKENS_FILE, 'utf8')) as Tokens & { seedRefresh?: string };
    // A new refresh token in the environment (re-authorised by hand) wins over the stored pair.
    const envRefresh = env.NEONFX_CTRADER_REFRESH_TOKEN;
    if (t.accessToken && t.refreshToken && (!envRefresh || envRefresh === t.seedRefresh)) return t;
  } catch {
    /* none stored yet */
  }
  if (!env.NEONFX_CTRADER_ACCESS_TOKEN || !env.NEONFX_CTRADER_REFRESH_TOKEN) return null;
  return { accessToken: env.NEONFX_CTRADER_ACCESS_TOKEN, refreshToken: env.NEONFX_CTRADER_REFRESH_TOKEN, expiresAt: 0 };
}
function saveCtraderTokens(t: Tokens): void {
  const tmp = `${CTRADER_TOKENS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...t, seedRefresh: env.NEONFX_CTRADER_REFRESH_TOKEN ?? '' }), { mode: 0o600 });
  renameSync(tmp, CTRADER_TOKENS_FILE);
}

async function main(): Promise<void> {
  const saved = loadSaved();
  log(`NEONFX bot starting · data ${DATA}`);
  if (env.NEONFX_LANG === 'nl') setLang('nl');
  const notifier = createNotifier(channelsFromEnv(env), env.NEONFX_NOTIFY === 'all' ? 'all' : 'important', (m) => log(m, 'warn'), 1500, trLines);
  log(notifier.channels ? `Notifications: ${notifier.channels} channel(s), level ${notifier.level}` : 'Notifications: none configured (see README)');

  // ---- price source: OANDA practice (real prices) or the simulator
  let sim: MarketSim | null = null;
  let oanda: { client: OandaClient; account: string; market: OandaMarket } | null = null;
  let brokerError = '';
  if (env.NEONFX_OANDA_TOKEN) {
    try {
      const client = new OandaClient(resolveBaseUrl(env.NEONFX_OANDA_URL), env.NEONFX_OANDA_TOKEN);
      const account = env.NEONFX_OANDA_ACCOUNT || (await client.firstAccount());
      log(`Connecting to OANDA practice account ${maskId(account)}: loading real price history...`);
      const om = await OandaMarket.create(client, account, (m) => log(m, 'warn'));
      om.start(1000);
      oanda = { client, account, market: om };
      log(`OANDA connected: real prices and ${om.candles.EURUSD.H1.length} hourly bars per pair`, 'ok');
    } catch (e) {
      brokerError = e instanceof Error ? e.message : String(e);
      log(`OANDA unavailable: ${brokerError}. Falling back to the simulator`, 'err');
      notifier.send(`NEONFX · OANDA unavailable: ${brokerError}. Running on the simulator instead.`, 'broker', true);
    }
  }
  // ---- price source: cTrader demo account (real broker prices)
  let ctrader: CTraderMarket | null = null;
  if (!oanda && env.NEONFX_CTRADER_CLIENT_ID && env.NEONFX_CTRADER_CLIENT_SECRET) {
    try {
      const tokens = loadCtraderTokens();
      if (!tokens) throw new Error('No cTrader tokens: set NEONFX_CTRADER_ACCESS_TOKEN and NEONFX_CTRADER_REFRESH_TOKEN');
      log('Connecting to cTrader demo account: loading real price history (this takes a minute)...');
      ctrader = await CTraderMarket.create({
        clientId: env.NEONFX_CTRADER_CLIENT_ID,
        clientSecret: env.NEONFX_CTRADER_CLIENT_SECRET,
        tokens,
        account: env.NEONFX_CTRADER_ACCOUNT,
        url: env.NEONFX_CTRADER_URL,
        saveTokens: saveCtraderTokens,
        log: (m) => log(m, 'warn'),
      });
      log(`cTrader connected (${ctrader.accountLabel}): real prices and ${ctrader.candles.EURUSD.H1.length} hourly bars per pair`, 'ok');
    } catch (e) {
      brokerError = e instanceof Error ? e.message : String(e);
      log(`cTrader unavailable: ${brokerError}. Falling back to the simulator`, 'err');
      notifier.send(`NEONFX · cTrader unavailable: ${brokerError}. Running on the simulator instead.`, 'broker', true);
    }
  }
  let market: BotMarket;
  const snap = oanda || ctrader ? null : loadMarketSnapshot();
  if (oanda) market = oanda.market;
  else if (ctrader) market = ctrader;
  else {
    const seed = snap ? snap.seed : await chooseSeed(saved);
    const s = new MarketSim(seed, Date.now(), randomSeed(), snap ?? undefined);
    sim = s;
    market = {
      get time() {
        return s.time;
      },
      label: `SIM · ${s.seed.label}`,
      real: false,
      quote: (x) => s.quote(x),
      mid: s.mid,
      series: (x, tf) => s.series(x, tf),
      isOpen: () => s.isOpen(),
      advanceTo: (n, f) => s.advanceTo(n, f),
    };
  }
  log(`Price source: ${market.label}`);
  const engine = new TradingEngine(parseState(saved.account) ?? freshState(), {
    quote: (s) => market.quote(s),
    mid: market.mid,
    now: () => market.time,
    isOpen: () => market.isOpen(),
  });
  if (snap && sim) {
    const behind = (Date.now() - snap.time) / 3_600_000;
    log(`Market history restored (${sim.candles.EURUSD.H1.length} hourly bars). Simulating the ${behind.toFixed(1)} hours the bot was off...`);
    sim.advanceTo(Date.now(), () => engine.onTick());
  }
  const mirror =
    oanda && flag(env.NEONFX_OANDA_TRADE, false)
      ? new OandaMirror(
          oanda.client,
          oanda.account,
          saved.mirror ?? freshMirrorState(),
          engine,
          market.mid,
          Math.max(1, Number(env.NEONFX_OANDA_MAX_UNITS) || 100_000),
          (m, important) => {
            log(m, important ? 'err' : 'info');
            if (important) notifier.send(`NEONFX · ${m}`, 'broker', true);
          },
        )
      : null;
  if (mirror) {
    await mirror.refreshAccount();
    log(`OANDA order mirroring ON: account ${mirror.currency} NAV ${mirror.nav ?? '?'}`, 'ok');
  } else if (oanda) log('OANDA order mirroring OFF (prices only). Set NEONFX_OANDA_TRADE=on to copy trades to the practice account');
  const apState = parseAutopilotState(saved.autopilot) ?? freshAutopilotState();
  // Auto-trading is locked ON unless NEONFX_AUTO_LOCK=off: the bot is meant to trade 24/7.
  const AUTO_LOCK = flag(env.NEONFX_AUTO_LOCK, true);
  apState.config.enabled = AUTO_LOCK || flag(env.NEONFX_AUTO, true);
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
    // With a broker feed, the longer CSV history (if any) still beats the broker's ~10 months of bars.
    if (market.real && !real.datasets.length) {
      apState.config.labData = 'sim';
      const ds = marketDatasets((s, tf) => market.series(s, tf), apState.config.tf, apState.config.universe, market.mid);
      const label = `${market.label} ${apState.config.tf}, ${ds.length} pairs (real prices)`;
      if (label !== dataLabel) log(`LAB researching ${label}`);
      dataLabel = label;
      labIn({ type: 'data', datasets: ds, kind: 'real', label: dataLabel });
      return;
    }
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
      if (mirror) void mirror.onOpen(p);
    } else if (e.type === 'close') {
      const t = e.trade;
      const msg = `CLOSED #${t.positionId} ${displaySymbol(t.symbol)} ${moneySigned(t.net)} (${t.r === null ? '-' : t.r.toFixed(2) + 'R'}) · ${t.reason}`;
      log(msg, t.net >= 0 ? 'ok' : 'warn');
      notifier.send(`NEONFX · ${msg}`, 'close', t.reason === 'stopout');
      autopilot.onClose(t);
      if (mirror) void mirror.onClose(t);
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
      market: { t: market.time, rates: sim ? sim.snapshotRates() : (saved.market?.rates ?? null) },
      mirror: mirror?.state,
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
    if (AUTO_LOCK && !apState.config.enabled) {
      apState.config.enabled = true;
      log('Autopilot was off; switched back ON (auto-trading is locked on)', 'warn');
    }
    if (apState.config.enabled) autopilot.sync(hof.filter((e) => e.dataVersion === labStats?.dataVersion), labStats?.tested ?? 0);
    if (apState.blacklist.length > banned) {
      labIn({ type: 'ban', ids: apState.blacklist.slice(banned) });
      banned = apState.blacklist.length;
    }
  }, 5000);
  setInterval(refreshData, 30 * 60_000);
  setInterval(persist, 30_000);
  setInterval(() => sim && saveMarketSnapshot(sim), 60 * 60_000);
  if (mirror) {
    setInterval(() => void mirror.syncStops(), 15_000);
    setInterval(() => void mirror.refreshAccount(), 60_000);
  }
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
      feed: market.label,
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
      broker: oanda
        ? {
            connected: !oanda.market.error,
            label: `practice ${maskId(oanda.account)} · ${mirror ? 'mirroring trades' : 'prices only'}`,
            mirror: !!mirror,
            nav: mirror?.nav ?? null,
            openTrades: mirror?.openTrades ?? 0,
            error: oanda.market.error || mirror?.error || '',
          }
        : ctrader
          ? { connected: !ctrader.error, label: `${ctrader.label} · prices only`, mirror: false, nav: null, openTrades: 0, error: ctrader.error }
          : brokerError
            ? { connected: false, label: env.NEONFX_CTRADER_CLIENT_ID ? 'cTrader unavailable' : 'OANDA unavailable', mirror: false, nav: null, openTrades: 0, error: brokerError }
            : null,
      log: recent.slice(-40),
      summary: (() => {
        const hist = engine.state.history;
        const now = Date.now();
        const tf = apState.config.tf as Timeframe;
        const open = isFxOpen(now);
        return {
          startBalance: engine.state.settings.startBalance,
          totalNet: Math.round(hist.reduce((a, t) => a + t.net, 0) * 100) / 100,
          wins: hist.filter((t) => t.net > 0).length,
          losses: hist.filter((t) => t.net <= 0).length,
          autoLocked: AUTO_LOCK,
          dayLocked: engine.state.guard.enabled && engine.state.day.locked,
          dayLockReason: engine.state.day.lockReason,
          nextDecision: bucketStart(now, tf) + TF_MS[tf],
          marketOpensAt: open ? null : nextFxChange(now),
          realPrices: market.real,
          labData: dataLabel,
        };
      })(),
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
    if (c.auto === false && AUTO_LOCK) {
      log('Request to switch the autopilot OFF ignored: auto-trading is locked on (NEONFX_AUTO_LOCK)', 'warn');
    } else if (c.auto !== undefined && c.auto !== apState.config.enabled) {
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
  // ---- the NEONFX terminal, served by the bot and connected to its account
  const terminalFile = [
    env.NEONFX_UI,
    join(dirname(fileURLToPath(import.meta.url)), 'terminal.html'),
    join(process.cwd(), 'dist-single', 'index.html'),
  ].find((f): f is string => !!f && existsSync(f));
  let terminalHtml: string | null = null;
  const terminal = () => {
    if (!terminalFile) return null;
    try {
      terminalHtml ??= readFileSync(terminalFile, 'utf8');
    } catch {
      terminalHtml = null;
    }
    return terminalHtml;
  };
  const rows = (cs: readonly Candle[]): CandleRow[] => cs.map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]);
  const quotes = () => INSTRUMENTS.map((i) => market.quote(i.symbol)).filter((q): q is Quote => !!q);
  const marketDump = (): MarketDump => ({
    time: market.time,
    label: market.label,
    real: market.real,
    open: market.isOpen(),
    quotes: quotes(),
    candles: Object.fromEntries(INSTRUMENTS.map((i) => [i.symbol, { H1: rows(market.series(i.symbol, 'H1')), M1: rows(market.series(i.symbol, 'M1')) }])),
  });
  const live = (from: number): LiveDump => {
    const st = engine.state;
    const historyFrom = from <= st.history.length ? from : 0;
    return {
      time: market.time,
      label: market.label,
      real: market.real,
      open: market.isOpen(),
      quotes: quotes(),
      state: { ...st, history: st.history.slice(historyFrom) },
      historyFrom,
      owned: Object.keys(autopilot.state.owned).map(Number),
    };
  };
  const res = (r: { ok: boolean; error?: string }): EngineOpResult => (r.ok ? { ok: true } : { ok: false, error: r.error ?? 'Rejected' });
  const engineOp = (op: EngineOp): EngineOpResult => {
    let out: EngineOpResult;
    switch (op.op) {
      case 'submit':
        out = res(engine.submit(op.req));
        if (out.ok) log(`MANUAL ${op.req.side.toUpperCase()} ${unitsToLots(op.req.units)} ${displaySymbol(op.req.symbol)} ${op.req.type} from the terminal`);
        break;
      case 'close':
        out = res(engine.close(op.id, op.units));
        break;
      case 'closeIds': {
        const ids = new Set(op.ids);
        engine.closeWhere((p) => ids.has(p.id));
        out = { ok: true };
        break;
      }
      case 'modify':
        out = res(engine.modify(op.id, op.changes));
        break;
      case 'breakEven':
        out = res(engine.breakEven(op.id));
        break;
      case 'reverse':
        out = res(engine.reverse(op.id));
        break;
      case 'cancelOrder':
        out = res(engine.cancelOrder(op.id, 'Cancelled from the terminal'));
        break;
      case 'config':
        engine.state.guard = { ...op.guard };
        engine.state.settings.leverage = op.leverage;
        engine.state.settings.commissionPerLot = op.commissionPerLot;
        log(`Risk settings changed from the terminal: guard ${op.guard.enabled ? 'ON' : 'OFF'}, max risk ${op.guard.maxRiskPct}%, daily limit ${op.guard.dailyLossPct}%, max ${op.guard.maxPositions} positions, leverage 1:${op.leverage}`);
        out = { ok: true };
        break;
    }
    persist();
    return out;
  };
  createServer((rq, rs) =>
    handleRequest(rq, rs, { token: access.token, status, page, control, terminal, market: marketDump, live, engine: engineOp }),
  )
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
    if (sim) saveMarketSnapshot(sim);
    oanda?.market.stop();
    ctrader?.stop();
    notifier.send(`NEONFX bot stopped (${sig}). Equity ${money(engine.metrics().equity)}. State saved.`, 'stop', true);
    await notifier.flush(8000);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log(`Crash: ${e.stack ?? e.message}`, 'err');
    persist();
    if (sim) saveMarketSnapshot(sim);
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
