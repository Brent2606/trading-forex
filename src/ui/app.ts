import { freshState, parseState, TradingEngine, type EngineEvent } from '../core/account';
import { Autopilot, freshAutopilotState, parseAutopilotState } from '../core/autopilot';
import type { Evaluation, LabStats } from '../core/lab';
import { checkAlerts, inferCondition, validateAlert, type PriceAlert } from '../core/alerts';
import { TIMEFRAMES, type Candle, type Timeframe } from '../core/candles';
import { HELP_LINES, parseCommand, type Command } from '../core/command';
import { clock, duration, escapeHtml, lots as fmtLots, money, moneySigned, pct, pips as fmtPips, price as fmtPrice } from '../core/format';
import { displaySymbol, FALLBACK_RATES, getInstrument, INSTRUMENTS, unitsToLots } from '../core/instruments';
import { MarketSim, sanitizeRates, type MarketSeed } from '../core/market';
import { randomSeed } from '../core/rng';
import { load, save } from '../core/storage';
import { DAY, nextFxChange } from '../core/time';
import { initAnalysis } from './analysis';
import { initAutopilotPanel } from './autopilotPanel';
import { initBotPanel } from './botPanel';
import { LabClient } from './labClient';
import { initBacktest, tfForBarMs } from './backtestPanel';
import { CandleChart, type PriceLine } from './chart';
import { loadPrefs, type App, type OrderIntent, type SoundKind, type ToastKind } from './context';
import { initDesk } from './desk';
import { $, pressSeg, priceHtml, setSigned, setText } from './dom';
import { sizeOrder } from './orders';
import { initTicket } from './ticket';
import { detectLang, getLang, setLang, tr, type Lang } from '../core/i18n';
import { applyLang, startTranslation } from './i18nDom';

const TICK_MS = 250;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---------------------------------------------------------------- price seed

async function fetchEcbRates(timeoutMs: number): Promise<{ rates: MarketSeed['rates']; date: string } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,CHF,AUD,CAD,NZD', {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { rates?: Record<string, number>; date?: string };
    const rates = sanitizeRates({ USD: 1, ...(j.rates ?? {}) });
    if (!rates) return null;
    return { rates, date: typeof j.date === 'string' ? j.date.slice(0, 10) : '' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface SavedMarket {
  t: number;
  rates: unknown;
}

async function chooseSeed(say: (s: string) => Promise<void>): Promise<MarketSeed> {
  const saved = load<SavedMarket>('market');
  if (saved && typeof saved.t === 'number' && Date.now() - saved.t < 7 * DAY) {
    const rates = sanitizeRates(saved.rates);
    if (rates) {
      await say('> RESUMING FROM YOUR LAST SESSION PRICES ......... OK');
      return { rates, source: 'resumed', label: 'resumed last session' };
    }
  }
  await say('> FETCHING ECB REFERENCE RATES ...');
  const ecb = await fetchEcbRates(2500);
  if (ecb) {
    await say(`  ECB ${ecb.date} · 1 USD = ${ecb.rates.EUR.toFixed(4)} EUR · ${ecb.rates.JPY.toFixed(2)} JPY ... OK`);
    return { rates: ecb.rates, source: 'ecb', label: `ECB ${ecb.date}` };
  }
  await say('  OFFLINE · USING BUILT-IN REFERENCE RATES ......... OK');
  return { rates: FALLBACK_RATES, source: 'builtin', label: 'built-in rates' };
}

// ---------------------------------------------------------------- sound

let audio: AudioContext | null = null;
function initAudioOnGesture(): void {
  const start = () => {
    if (!audio) {
      try {
        audio = new AudioContext();
      } catch {
        audio = null;
      }
    }
    audio?.resume().catch(() => undefined);
  };
  window.addEventListener('pointerdown', start, { once: true, capture: true });
  window.addEventListener('keydown', start, { once: true, capture: true });
}
function blip(freqs: number[], dur: number, type: OscillatorType, gain = 0.05): void {
  if (!audio || audio.state !== 'running') return;
  const t0 = audio.currentTime;
  freqs.forEach((f, i) => {
    const o = audio!.createOscillator();
    const g = audio!.createGain();
    o.type = type;
    o.frequency.value = f;
    const s = t0 + i * dur;
    g.gain.setValueAtTime(0, s);
    g.gain.linearRampToValueAtTime(gain, s + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
    o.connect(g).connect(audio!.destination);
    o.start(s);
    o.stop(s + dur + 0.02);
  });
}
const SOUNDS: Record<SoundKind, () => void> = {
  fill: () => blip([880, 1320], 0.07, 'square', 0.035),
  win: () => blip([660, 880, 1320], 0.08, 'triangle', 0.06),
  loss: () => blip([440, 330, 220], 0.09, 'sawtooth', 0.03),
  alert: () => blip([1200, 0, 1200, 0, 1200], 0.07, 'square', 0.04),
  error: () => blip([180, 140], 0.09, 'sawtooth', 0.04),
  click: () => blip([1400], 0.03, 'square', 0.02),
};

// ---------------------------------------------------------------- boot

export async function boot(): Promise<void> {
  const savedLang = load<Lang>('lang');
  setLang(savedLang === 'nl' || savedLang === 'en' ? savedLang : detectLang(navigator.language));
  document.documentElement.lang = getLang();
  startTranslation(document.body);
  const bootEl = $('boot');
  const bootLog = $('boot-log');
  let fast = reducedMotion();
  bootEl.addEventListener('click', () => (fast = true));
  const say = async (line: string) => {
    bootLog.textContent += tr(line) + '\n';
    await new Promise((r) => setTimeout(r, fast ? 0 : 140));
  };
  const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  await say('> NEONFX CORE v1.0 ................................. OK');
  const seed = await chooseSeed(say);
  await say('> SYNTHESIZING 250 TRADING DAYS × 16 PAIRS ...');
  await paint();
  const market = new MarketSim(seed, Date.now(), randomSeed());
  await say('  CROSS RATES LOCKED · NO TRIANGULAR ARBITRAGE ...... OK');
  const state = parseState(load('account')) ?? freshState();
  await say(`> RISK ENGINE ARMED · STOP-OUT ${state.settings.stopOutLevel}% · GUARD ${state.guard.enabled ? 'ON' : 'OFF'}`);
  await say('> PAPER TRADING. NO REAL MONEY IS AT RISK.');
  start(market, state);
  bootEl.classList.add('done');
  setTimeout(() => (bootEl.hidden = true), fast ? 0 : 400);
}

// ---------------------------------------------------------------- app

function start(market: MarketSim, state: ReturnType<typeof freshState>): void {
  initAudioOnGesture();
  const prefs = loadPrefs();
  market.respectHours = !prefs.weekendPractice;
  const engine = new TradingEngine(state, {
    quote: (s) => market.quote(s),
    mid: market.mid,
    now: () => market.time,
    isOpen: () => market.isOpen(),
  });
  const alertsRaw = load<PriceAlert[]>('alerts');
  const alerts: PriceAlert[] = Array.isArray(alertsRaw)
    ? alertsRaw.filter((a) => a && INSTRUMENTS.some((i) => i.symbol === a.symbol) && typeof a.price === 'number')
    : [];
  let alertId = alerts.reduce((m, a) => Math.max(m, a.id), 0);
  const chart = new CandleChart($<HTMLCanvasElement>('chart'), $('chart-wrap'));
  let accountDirty = false;

  // ---- toasts & log
  const toastsEl = $('toasts');
  const logEl = $('cmd-log');
  function toast(title: string, body: string, kind: ToastKind): void {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<b>${escapeHtml(title)}</b>${escapeHtml(body)}`;
    el.addEventListener('click', () => el.remove());
    toastsEl.prepend(el);
    while (toastsEl.children.length > 4) toastsEl.lastElementChild?.remove();
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 4200);
  }
  function log(text: string, kind: ToastKind = 'info'): void {
    const line = document.createElement('div');
    line.className = `l-${kind}`;
    line.innerHTML = `<span class="ts">${clock(Date.now())}</span>${escapeHtml(text)}`;
    logEl.append(line);
    while (logEl.children.length > 200) logEl.firstElementChild?.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  const app: App = {
    market,
    engine,
    prefs,
    alerts,
    chart,
    chartSource: 'live',
    csv: null,
    marks: null,
    ghost: null,
    select,
    showCsvOnChart,
    chartKey: () => (app.chartSource === 'csv' ? 'csv' : `live:${prefs.symbol}:${prefs.tf}`),
    chartCandles: (): readonly Candle[] =>
      app.chartSource === 'csv' && app.csv ? app.csv.candles : market.series(prefs.symbol, prefs.tf),
    toast,
    log,
    sound: (k) => {
      if (prefs.sound) SOUNDS[k]();
    },
    savePrefs: () => save('ui', prefs),
    saveAccount: () => {
      accountDirty = true;
    },
    saveAlerts: () => save('alerts', alerts),
    deskChanged: () => desk.render(),
    placeOrder,
    nextAlertId: () => ++alertId,
    setTab,
    positionTag: () => null,
  };

  // ---- order placement (ticket, command line, keyboard)
  function placeOrder(o: OrderIntent): boolean {
    const sized = sizeOrder(engine, market, o);
    const fail = (msg: string) => {
      toast('Order rejected', msg, 'err');
      log(`REJECTED: ${msg}`, 'err');
      app.sound('error');
      return false;
    };
    if (!sized.ok) return fail(sized.error);
    const r = engine.submit({
      symbol: o.symbol,
      side: o.side,
      units: sized.units,
      type: o.type,
      price: o.price,
      slPips: o.slPips ?? null,
      tpPips: o.tpPips ?? null,
      trailPips: o.trailPips ?? null,
    });
    if (!r.ok) return fail(r.error);
    return true;
  }

  // ---- engine events
  engine.on((e: EngineEvent) => {
    switch (e.type) {
      case 'open': {
        const p = e.position;
        const inst = getInstrument(p.symbol);
        const msg = `${p.side.toUpperCase()} ${fmtLots(unitsToLots(p.units))} ${displaySymbol(p.symbol)} @ ${fmtPrice(p.entry, inst.digits)}${p.sl !== null ? ` · SL ${fmtPrice(p.sl, inst.digits)}` : ''}${p.tp !== null ? ` · TP ${fmtPrice(p.tp, inst.digits)}` : ''}`;
        toast(p.fromOrder ? `Order #${p.fromOrder} filled` : 'Filled', `#${p.id} ${msg}`, 'ok');
        log(`FILLED #${p.id} ${msg}`, 'ok');
        app.sound('fill');
        break;
      }
      case 'close': {
        const t = e.trade;
        const reason = { manual: 'closed', sl: 'stop loss', tp: 'take profit', trail: 'trailing stop', stopout: 'STOP-OUT', guard: 'risk guard', reverse: 'reversed', signal: 'strategy exit' }[t.reason];
        const msg = `#${t.positionId} ${displaySymbol(t.symbol)} ${moneySigned(t.net)} (${fmtPips(t.pips)} pips) · ${reason}`;
        toast(t.net >= 0 ? 'Closed in profit' : 'Closed at a loss', msg, t.net >= 0 ? 'ok' : t.reason === 'stopout' ? 'err' : 'warn');
        log(`CLOSED ${msg}`, t.net >= 0 ? 'ok' : 'warn');
        app.sound(t.net >= 0 ? 'win' : 'loss');
        break;
      }
      case 'order': {
        const o = e.order;
        const msg = `#${o.id} ${o.side.toUpperCase()} ${o.type.toUpperCase()} ${fmtLots(unitsToLots(o.units))} ${displaySymbol(o.symbol)} @ ${fmtPrice(o.price, getInstrument(o.symbol).digits)}`;
        toast('Order placed', msg, 'info');
        log(`PLACED ${msg}`, 'info');
        app.sound('click');
        break;
      }
      case 'cancel':
        toast('Order cancelled', `#${e.order.id} ${displaySymbol(e.order.symbol)}: ${e.reason}`, 'warn');
        log(`CANCELLED #${e.order.id}: ${e.reason}`, 'warn');
        break;
      case 'margin-call':
        toast('Margin call', `Margin level ${e.level.toFixed(0)}%. Stop-out at ${engine.state.settings.stopOutLevel}%`, 'err');
        log(`MARGIN CALL: level ${e.level.toFixed(0)}%`, 'err');
        app.sound('alert');
        break;
      case 'guard-lock':
        toast('Trading locked', `Risk guard: ${e.reason}. New orders are blocked until the next trading day.`, 'err');
        log(`RISK GUARD LOCK: ${e.reason}`, 'err');
        app.sound('alert');
        break;
      case 'reset':
        toast('Account reset', `Balance ${money(engine.state.balance)}`, 'info');
        log(`Account reset to ${money(engine.state.balance)}`, 'info');
        desk.renderRisk();
        break;
      case 'modify':
        break;
    }
    accountDirty = true;
    deskDirty = true;
  });

  // ---- header
  const mEls = {
    balance: $('m-balance'),
    equity: $('m-equity'),
    floating: $('m-floating'),
    day: $('m-day'),
    margin: $('m-margin'),
    free: $('m-free'),
    level: $('m-level'),
  };
  function renderHeader(): void {
    const m = engine.metrics();
    setText(mEls.balance, money(m.balance));
    setText(mEls.equity, money(m.equity));
    setSigned(mEls.floating, moneySigned(m.floating), m.floating);
    setSigned(mEls.day, `${moneySigned(m.dayPnl)} · ${pct(m.dayPnlPct, 2, true)}`, m.dayPnl);
    setText(mEls.margin, money(m.margin));
    setText(mEls.free, money(m.freeMargin));
    setText(mEls.level, Number.isFinite(m.marginLevel) ? `${m.marginLevel.toFixed(0)}%` : '—');
    mEls.level.classList.toggle('neg', m.marginLevel < engine.state.settings.marginCallLevel);
    const g = $('guard-chip');
    const d = engine.state.day;
    const gs = !engine.state.guard.enabled ? ['GUARD OFF', 'chip'] : d.locked ? ['GUARD LOCKED', 'chip bad'] : ['GUARD ARMED', 'chip ok'];
    setText(g, gs[0]);
    if (g.className !== gs[1]) g.className = gs[1];
  }
  const feed = $('feed-chip');
  feed.textContent = `SIM · ${market.seed.label}`;
  feed.className = 'chip info';
  feed.title =
    'Prices come from a simulator anchored to ' +
    (market.seed.source === 'ecb' ? 'European Central Bank reference rates.' : market.seed.source === 'resumed' ? 'your last session.' : 'built-in reference rates.') +
    ' It is not a live market feed.';

  // ---- language
  const langBtn = $('lang-toggle');
  const syncLangBtn = () => {
    langBtn.textContent = getLang() === 'nl' ? 'NL' : 'EN';
    langBtn.title = getLang() === 'nl' ? 'Language: Nederlands. Click for English' : 'Language: English. Click for Dutch';
    if (getLang() === 'nl') langBtn.title = tr(langBtn.title);
  };
  langBtn.addEventListener('click', () => {
    setLang(getLang() === 'nl' ? 'en' : 'nl');
    save('lang', getLang());
    applyLang();
    syncLangBtn();
    chart.refresh();
    analysis.renderTech();
    desk.render();
    apPanel.render();
    botPanel.render();
    renderTape();
    if (prefs.tab === 'performance') desk.renderPerformance();
    log(getLang() === 'nl' ? 'Taal: Nederlands' : 'Language: English', 'info');
  });
  syncLangBtn();

  // ---- fx & sound toggles
  const fxBtn = $('fx-toggle');
  const sndBtn = $('sound-toggle');
  function applyFx(): void {
    document.documentElement.classList.toggle('fx-off', !prefs.fx);
    fxBtn.setAttribute('aria-pressed', String(prefs.fx));
    sndBtn.setAttribute('aria-pressed', String(prefs.sound));
    chart.glow = prefs.fx;
    chart.request();
  }
  fxBtn.addEventListener('click', () => {
    prefs.fx = !prefs.fx;
    applyFx();
    app.savePrefs();
  });
  sndBtn.addEventListener('click', () => {
    prefs.sound = !prefs.sound;
    applyFx();
    app.savePrefs();
    if (prefs.sound) SOUNDS.click();
  });
  applyFx();

  // ---- ticker tape
  const track = $('tape-track');
  const tapeCells: { sym: string; px: HTMLElement; chg: HTMLElement }[] = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const inst of INSTRUMENTS) {
      const item = document.createElement('span');
      item.className = 'tape-item';
      item.innerHTML = `<b>${displaySymbol(inst.symbol)}</b><span></span><span></span>`;
      track.append(item);
      tapeCells.push({ sym: inst.symbol, px: item.children[1] as HTMLElement, chg: item.children[2] as HTMLElement });
    }
  }
  function dayChange(sym: string): number {
    const d1 = market.series(sym, 'D1');
    const q = market.quote(sym);
    const bar = d1[d1.length - 1];
    return bar && q ? ((q.bid - bar.o) / bar.o) * 100 : 0;
  }
  function renderTape(): void {
    for (const c of tapeCells) {
      const q = market.quote(c.sym);
      if (!q) continue;
      setText(c.px, fmtPrice(q.bid, getInstrument(c.sym).digits));
      const ch = dayChange(c.sym);
      setSigned(c.chg, `${ch >= 0 ? '▲' : '▼'} ${pct(Math.abs(ch), 2)}`, ch);
    }
  }

  // ---- market watch
  const watchBody = $('watch-body');
  watchBody.innerHTML = INSTRUMENTS.map(
    (i) =>
      `<tr data-s="${i.symbol}"><td class="pair">${i.base}<small>/${i.quote}</small></td><td class="r" data-c="bid"></td><td class="r" data-c="ask"></td><td class="r dim" data-c="spr"></td><td class="r" data-c="chg"></td></tr>`,
  ).join('');
  const watchRows = new Map<string, { tr: HTMLElement; bid: HTMLElement; ask: HTMLElement; spr: HTMLElement; chg: HTMLElement; last: number; flip: boolean }>();
  for (const tr of watchBody.querySelectorAll<HTMLTableRowElement>('tr')) {
    const q = (c: string) => tr.querySelector<HTMLElement>(`[data-c="${c}"]`)!;
    watchRows.set(tr.dataset.s!, { tr, bid: q('bid'), ask: q('ask'), spr: q('spr'), chg: q('chg'), last: NaN, flip: false });
  }
  watchBody.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-s]');
    if (tr) select(tr.dataset.s!);
  });
  function renderWatch(full = false): void {
    for (const inst of INSTRUMENTS) {
      const r = watchRows.get(inst.symbol)!;
      const q = market.quote(inst.symbol);
      if (!q) continue;
      if (q.bid !== r.last || full) {
        const dir = Number.isNaN(r.last) ? 0 : Math.sign(q.bid - r.last);
        r.bid.innerHTML = priceHtml(q.bid, inst.digits);
        r.ask.innerHTML = priceHtml(q.ask, inst.digits);
        if (dir !== 0 && prefs.fx) {
          r.flip = !r.flip;
          const cls = dir > 0 ? (r.flip ? 'fu1' : 'fu2') : r.flip ? 'fd1' : 'fd2';
          r.bid.className = `r ${cls}`;
          r.ask.className = `r ${cls}`;
        }
        r.last = q.bid;
      }
      setText(r.spr, q.spread.toFixed(1));
      const ch = dayChange(inst.symbol);
      setSigned(r.chg, pct(ch, 2, true), ch);
      r.tr.classList.toggle('sel', app.chartSource === 'live' && inst.symbol === prefs.symbol);
    }
  }

  // ---- chart toolbar
  const symSel = $<HTMLSelectElement>('chart-symbol');
  function renderSymbolOptions(): void {
    symSel.innerHTML =
      INSTRUMENTS.map((i) => `<option value="${i.symbol}">${displaySymbol(i.symbol)}</option>`).join('') +
      (app.csv ? `<option value="__csv">CSV · ${escapeHtml(app.csv.name)}</option>` : '');
    symSel.value = app.chartSource === 'csv' ? '__csv' : prefs.symbol;
  }
  symSel.addEventListener('change', () => {
    if (symSel.value === '__csv') showCsvOnChart();
    else select(symSel.value);
  });
  const tfSeg = $('tf-seg');
  tfSeg.innerHTML = TIMEFRAMES.map((tf, i) => `<button type="button" data-v="${tf}" title="${tf} (key ${i + 1})">${tf}</button>`).join('');
  tfSeg.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v as Timeframe | undefined;
    if (v) select(prefs.symbol, v);
  });
  const typeSeg = $('type-seg');
  typeSeg.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v;
    if (v !== 'candles' && v !== 'heikin' && v !== 'line') return;
    prefs.chartType = v;
    chart.type = v;
    pressSeg(typeSeg, v);
    chart.refresh();
    app.savePrefs();
  });
  const ovSeg = $('ov-seg');
  function syncOverlayButtons(): void {
    for (const b of ovSeg.querySelectorAll<HTMLButtonElement>('button[data-v]')) {
      b.setAttribute('aria-pressed', String(prefs.overlays[b.dataset.v as keyof typeof prefs.overlays]));
    }
  }
  ovSeg.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v as keyof typeof prefs.overlays | undefined;
    if (!v) return;
    prefs.overlays[v] = !prefs.overlays[v];
    chart.overlays = { ...prefs.overlays };
    syncOverlayButtons();
    chart.request();
    app.savePrefs();
  });
  const lowerSel = $<HTMLSelectElement>('lower-sel');
  lowerSel.addEventListener('change', () => {
    prefs.lower = lowerSel.value as typeof prefs.lower;
    chart.lower = prefs.lower;
    chart.request();
    app.savePrefs();
  });
  $('zoom-in').addEventListener('click', () => chart.zoom(1.25));
  $('zoom-out').addEventListener('click', () => chart.zoom(1 / 1.25));
  $('go-live').addEventListener('click', () => chart.goLive());
  const goLiveBtn = $('go-live');
  chart.onFollowChange = (f) => goLiveBtn.setAttribute('aria-pressed', String(f));
  goLiveBtn.setAttribute('aria-pressed', 'true');

  chart.type = prefs.chartType;
  chart.overlays = { ...prefs.overlays };
  chart.lower = prefs.lower;
  pressSeg(typeSeg, prefs.chartType);
  syncOverlayButtons();
  lowerSel.value = prefs.lower;

  function loadChart(reset: boolean): void {
    if (app.chartSource === 'csv' && app.csv) {
      chart.title = `CSV ${app.csv.symbol ? displaySymbol(app.csv.symbol) : app.csv.name}`;
      chart.setQuote(null, null);
      chart.setData(app.csv.candles, app.csv.digits, tfForBarMs(app.csv.barMs), reset);
      setText($('chart-note'), `${app.csv.candles.length} imported bars · not live`);
    } else {
      const inst = getInstrument(prefs.symbol);
      chart.title = displaySymbol(prefs.symbol);
      chart.setData(market.series(prefs.symbol, prefs.tf), inst.digits, prefs.tf, reset);
      setText($('chart-note'), '');
    }
    pressSeg(tfSeg, app.chartSource === 'csv' ? '' : prefs.tf);
    renderSymbolOptions();
  }

  function select(symbol: string, tf: Timeframe = prefs.tf): void {
    const changed = symbol !== prefs.symbol || tf !== prefs.tf || app.chartSource !== 'live';
    prefs.symbol = symbol;
    prefs.tf = tf;
    app.chartSource = 'live';
    app.savePrefs();
    if (changed) {
      loadChart(true);
      ticket.refresh();
      analysis.renderTech();
      renderWatch(true);
    }
  }

  function showCsvOnChart(): void {
    if (!app.csv) return;
    apPanel.csvAvailable();
    app.chartSource = 'csv';
    loadChart(true);
    analysis.renderTech();
    renderWatch(true);
  }

  // ---- chart lines
  function chartLines(): PriceLine[] {
    if (app.chartSource !== 'live') return [];
    const th = getComputedStyle(document.documentElement);
    const c = (n: string, fb: string) => th.getPropertyValue(n).trim() || fb;
    const up = c('--up', '#00f0b5');
    const down = c('--down', '#ff2f7d');
    const warn = c('--warn', '#ffc23d');
    const accent = c('--accent', '#8a6bff');
    const dim = c('--dim', '#8f88bf');
    const lines: PriceLine[] = [];
    const sym = prefs.symbol;
    for (const p of engine.state.positions) {
      if (p.symbol !== sym) continue;
      const pl = engine.floating(p);
      lines.push({
        price: p.entry,
        color: p.side === 'buy' ? up : down,
        label: `#${p.id} ${p.side.toUpperCase()} ${fmtLots(unitsToLots(p.units))}  ${moneySigned(pl)}`,
        dash: [],
      });
      if (p.sl !== null) lines.push({ price: p.sl, color: down, label: `SL #${p.id}${p.trailPips ? ' trailing' : ''}` });
      if (p.tp !== null) lines.push({ price: p.tp, color: up, label: `TP #${p.id}` });
    }
    for (const o of engine.state.orders) {
      if (o.symbol !== sym) continue;
      lines.push({ price: o.price, color: warn, label: `#${o.id} ${o.side.toUpperCase()} ${o.type.toUpperCase()} ${fmtLots(unitsToLots(o.units))}`, dash: [2, 3] });
    }
    for (const a of alerts) {
      if (a.symbol !== sym || a.triggeredAt !== null) continue;
      lines.push({ price: a.price, color: accent, label: `ALERT ${a.cond === 'above' ? '≥' : '≤'}`, dash: [8, 3, 2, 3] });
    }
    if (app.ghost) {
      const t = prefs.ticket;
      const q = market.quote(sym);
      const inst = getInstrument(sym);
      if (q) {
        const entry = t.type === 'market' ? (app.ghost === 'buy' ? q.ask : q.bid) : Number(($<HTMLInputElement>('tk-price')).value);
        if (Number.isFinite(entry) && entry > 0) {
          const dir = app.ghost === 'buy' ? 1 : -1;
          const stop = t.sl > 0 ? t.sl : t.trailOn ? t.trail : 0;
          lines.push({ price: entry, color: dim, label: `PLAN ${app.ghost.toUpperCase()}`, dash: [1, 3] });
          if (stop) lines.push({ price: entry - dir * stop * inst.pip, color: down, label: `PLAN SL ${stop}p`, dash: [1, 3] });
          if (t.tp > 0) lines.push({ price: entry + dir * t.tp * inst.pip, color: up, label: `PLAN TP ${t.tp}p`, dash: [1, 3] });
        }
      }
    }
    return lines;
  }

  // ---- tabs
  const tabs = $('tabs');
  function setTab(tab: string): void {
    prefs.tab = tab;
    for (const b of tabs.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    }
    for (const p of document.querySelectorAll<HTMLElement>('.tabpane')) p.hidden = p.dataset.pane !== tab;
    if (tab === 'performance') desk.renderPerformance();
    if (tab === 'scanner') analysis.renderScanner();
    if (tab === 'correlation') analysis.renderCorrelation();
    if (tab === 'risk') desk.renderRisk();
    if (tab === 'autopilot') apPanel.render();
    if (tab === 'bot') botPanel.render();
    app.savePrefs();
  }
  tabs.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]')?.dataset.tab;
    if (t) setTab(t);
  });
  const maxBtn = $('desk-max');
  const applyDeskMax = () => {
    $('app').classList.toggle('desk-max', prefs.deskMax);
    maxBtn.setAttribute('aria-pressed', String(prefs.deskMax));
    maxBtn.title = prefs.deskMax ? 'Give the chart more room' : 'Give the desk more room';
  };
  maxBtn.addEventListener('click', () => {
    prefs.deskMax = !prefs.deskMax;
    applyDeskMax();
    app.savePrefs();
  });
  applyDeskMax();

  // ---- command line
  const cmdForm = $('cmd-form');
  const cmdInput = $<HTMLInputElement>('cmd-input');
  const history: string[] = [];
  let hIdx = -1;
  cmdForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = cmdInput.value.trim();
    if (!text) return;
    history.push(text);
    hIdx = history.length;
    cmdInput.value = '';
    log(`> ${text}`, 'info');
    runCommand(parseCommand(text));
  });
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && history.length) {
      hIdx = Math.max(0, hIdx - 1);
      cmdInput.value = history[hIdx] ?? '';
      e.preventDefault();
    } else if (e.key === 'ArrowDown' && history.length) {
      hIdx = Math.min(history.length, hIdx + 1);
      cmdInput.value = history[hIdx] ?? '';
      e.preventDefault();
    } else if (e.key === 'Escape') cmdInput.blur();
  });

  function runCommand(c: Command): void {
    const t = prefs.ticket;
    switch (c.kind) {
      case 'error':
        log(c.message, 'err');
        app.sound('error');
        return;
      case 'help':
        for (const l of HELP_LINES) log(l, 'info');
        log('Keys: Shift+B buy · Shift+S sell · 1–6 timeframe · [ ] previous/next pair · / command line · Esc cancel', 'info');
        return;
      case 'clear':
        logEl.innerHTML = '';
        return;
      case 'order': {
        const explicitStops = c.slPips !== undefined || c.tpPips !== undefined || c.trailPips !== undefined;
        const o: OrderIntent = {
          side: c.side,
          type: c.type,
          symbol: c.symbol ?? prefs.symbol,
          price: c.price,
          slPips: explicitStops ? (c.slPips ?? null) : t.sl > 0 ? t.sl : null,
          tpPips: explicitStops ? (c.tpPips ?? null) : t.tp > 0 ? t.tp : null,
          trailPips: explicitStops ? (c.trailPips ?? null) : t.trailOn && t.trail > 0 ? t.trail : null,
        };
        if (c.lots !== undefined) o.lots = c.lots;
        else if (c.riskPct !== undefined) o.riskPct = c.riskPct;
        else if (t.mode === 'risk') o.riskPct = t.risk;
        else o.lots = t.lots;
        if (!explicitStops && (o.slPips || o.tpPips || o.trailPips)) {
          log(`Using ticket stops: SL ${o.slPips ?? '—'} · TP ${o.tpPips ?? '—'}${o.trailPips ? ` · trail ${o.trailPips}` : ''}`, 'info');
        }
        placeOrder(o);
        return;
      }
      case 'close': {
        const tg = c.target;
        let closed;
        if (tg === 'all') closed = engine.closeWhere(() => true);
        else if (tg === 'winners') closed = engine.closeWhere((p) => engine.floating(p) > 0);
        else if (tg === 'losers') closed = engine.closeWhere((p) => engine.floating(p) < 0);
        else if ('id' in tg) {
          const r = engine.close(tg.id);
          if (!r.ok) log(r.error, 'err');
          return;
        } else closed = engine.closeWhere((p) => p.symbol === tg.symbol);
        log(`Closed ${closed.length} position${closed.length === 1 ? '' : 's'}`, closed.length ? 'ok' : 'warn');
        return;
      }
      case 'breakeven': {
        const ids = c.target === 'all' ? engine.state.positions.map((p) => p.id) : [c.target.id];
        for (const id of ids) {
          const r = engine.breakEven(id);
          log(r.ok ? `#${id} stop → break-even ${r.value.sl}` : r.error, r.ok ? 'ok' : 'warn');
        }
        if (!ids.length) log('No open positions', 'warn');
        return;
      }
      case 'cancel': {
        const ids = c.target === 'all' ? engine.state.orders.map((o) => o.id) : [c.target.id];
        for (const id of ids) {
          const r = engine.cancelOrder(id, 'Cancelled by you');
          if (!r.ok) log(r.error, 'err');
        }
        if (!ids.length) log('No pending orders', 'warn');
        return;
      }
      case 'reverse': {
        const r = engine.reverse(c.id);
        if (!r.ok) {
          log(r.error, 'err');
          app.sound('error');
        }
        return;
      }
      case 'chart':
        select(c.symbol ?? prefs.symbol, c.tf ?? prefs.tf);
        log(`Chart ${displaySymbol(prefs.symbol)} ${prefs.tf}`, 'info');
        return;
      case 'alert': {
        const symbol = c.symbol ?? prefs.symbol;
        const q = market.quote(symbol)!;
        const cond = c.cond ?? inferCondition(c.price, q.bid);
        const err = validateAlert(cond, c.price, q.bid);
        if (err) {
          log(err, 'err');
          return;
        }
        alerts.push({ id: ++alertId, symbol, cond, price: c.price, createdAt: Date.now(), triggeredAt: null });
        app.saveAlerts();
        desk.render();
        log(`Alert: ${displaySymbol(symbol)} bid ${cond === 'above' ? '≥' : '≤'} ${c.price}`, 'ok');
        return;
      }
      case 'risk':
        t.mode = 'risk';
        t.risk = c.pct;
        app.savePrefs();
        ticket.refresh();
        log(`Ticket sizing: ${c.pct}% of equity per trade`, 'ok');
        return;
      case 'auto':
        if (c.on === undefined) {
          const n = autopilot.liveDeployments().length;
          log(`Autopilot is ${autopilot.config.enabled ? 'ON' : 'OFF'} · ${n} strateg${n === 1 ? 'y' : 'ies'} deployed · lab ${autopilot.config.lab ? 'searching' : 'paused'}`, 'info');
        } else apPanel.setEnabled(c.on);
        return;
      case 'lab':
        if (c.on === undefined) {
          const s = lab.stats;
          log(s ? `Lab: generation ${s.generation}, ${s.tested} strategies tested, ${lab.hof.length} on the leaderboard (${s.dataLabel})` : 'Lab starting', 'info');
        } else apPanel.setLab(c.on);
        return;
      case 'reset':
        if (!c.confirmed) {
          log('This wipes positions, orders and history. Type "reset confirm" (or "reset 25000 confirm").', 'warn');
          return;
        }
        engine.reset(c.balance ?? engine.state.settings.startBalance);
        return;
    }
  }

  // ---- keyboard
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const typing = target.matches('input, select, textarea');
    if (e.key === 'Escape') {
      ticket.cancelConfirm();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      cmdInput.focus();
    } else if (e.key === 'B' && e.shiftKey) {
      ticket.trigger('buy');
    } else if (e.key === 'S' && e.shiftKey) {
      ticket.trigger('sell');
    } else if (e.key >= '1' && e.key <= '6') {
      select(prefs.symbol, TIMEFRAMES[Number(e.key) - 1]);
    } else if (e.key === '[' || e.key === ']') {
      const i = INSTRUMENTS.findIndex((x) => x.symbol === prefs.symbol);
      const n = INSTRUMENTS.length;
      select(INSTRUMENTS[(i + (e.key === ']' ? 1 : -1) + n) % n].symbol);
    }
  });

  // ---- autopilot + strategy lab
  const apSaved = parseAutopilotState(load('autopilot')) ?? freshAutopilotState();
  const labSaved = load<{ hof?: Evaluation[]; stats?: Partial<LabStats> }>('lab');
  const lab = new LabClient({
    type: 'init',
    seed: randomSeed(),
    commission: engine.state.settings.commissionPerLot,
    hof: Array.isArray(labSaved?.hof) ? labSaved.hof : [],
    stats: labSaved?.stats ?? {},
    blacklist: apSaved.blacklist,
  });
  const autopilot = new Autopilot(apSaved, {
    engine,
    series: (s, tf) => market.series(s, tf),
    quote: (s) => market.quote(s),
    mid: market.mid,
    now: () => market.time,
    validate: (lesson, genomes) => lab.validate(lesson, genomes),
    log: (msg, kind) => log(msg, kind),
  });
  engine.on((e) => {
    if (e.type === 'close') autopilot.onClose(e.trade);
  });
  app.positionTag = (id) => (autopilot.state.owned[String(id)] ? 'AUTO' : null);

  // ---- modules
  const ticket = initTicket(app);
  const desk = initDesk(app);
  const analysis = initAnalysis(app);
  initBacktest(app);
  const apPanel = initAutopilotPanel(app, autopilot, lab);
  const botPanel = initBotPanel(app);
  let deskDirty = false;

  loadChart(true);
  setTab(prefs.tab);
  renderHeader();
  renderWatch(true);
  renderTape();
  ticket.tick();
  analysis.renderTech();
  analysis.renderSessions();
  analysis.renderStrength();
  log('NEONFX online. Paper trading on a simulated feed. Type "help" for commands.', 'ok');
  log(`Price anchor: ${market.seed.label}. Spreads widen at the 17:00 New York rollover.`, 'info');

  // ---- persistence
  let flushes = 0;
  function flush(): void {
    if (accountDirty) {
      save('account', engine.state);
      accountDirty = false;
    }
    save('market', { t: market.time, rates: market.snapshotRates() });
    save('autopilot', autopilot.state);
    if (flushes++ % 10 === 0 && lab.stats) save('lab', { hof: lab.hof, stats: lab.stats });
  }
  setInterval(flush, 3000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);

  // ---- main loop
  let lastEvent = market.events.length ? market.events[market.events.length - 1].t : 0;
  let slow = 0;
  setInterval(() => {
    // Orders, stops and alerts are evaluated on every simulation step, so nothing is
    // skipped when the browser throttles a background tab and the loop catches up.
    const fired: PriceAlert[] = [];
    market.advanceTo(Date.now(), () => {
      engine.onTick();
      if (alerts.length) fired.push(...checkAlerts(alerts, (s) => market.quote(s), market.time));
    });
    autopilot.onTick();
    for (const a of fired) {
      const msg = `${displaySymbol(a.symbol)} bid ${a.cond === 'above' ? '≥' : '≤'} ${a.price}`;
      toast('Price alert', msg, 'warn');
      log(`ALERT ${msg}`, 'warn');
      app.sound('alert');
    }
    if (fired.length) {
      app.saveAlerts();
      deskDirty = true;
    }
    for (const ev of market.events) {
      if (ev.t <= lastEvent) continue;
      lastEvent = ev.t;
      log(`VOLATILITY SPIKE (sim) ${ev.ccy} ${ev.pct >= 0 ? '+' : ''}${ev.pct.toFixed(2)}%`, 'warn');
    }
    if (engine.state.positions.length) accountDirty = true;
    if (deskDirty) {
      desk.render();
      deskDirty = false;
    } else desk.tick();

    renderHeader();
    renderWatch();
    ticket.tick();
    if (app.chartSource === 'live') {
      const q = market.quote(prefs.symbol);
      chart.setQuote(q?.bid ?? null, q?.ask ?? null);
      chart.refresh();
    }
    chart.lines = chartLines();
    chart.markers = app.marks && app.marks.key === app.chartKey() ? app.marks.markers : [];
    chart.request();

    slow++;
    if (slow % 4 === 0) {
      const closed = !market.isOpen();
      const note = $('chart-note');
      if (closed && app.chartSource === 'live') {
        setText(note, `MARKET CLOSED · reopens in ${duration(nextFxChange(Date.now()) - Date.now())}`);
        note.classList.add('neg');
      } else if (note.classList.contains('neg')) {
        note.classList.remove('neg');
        setText(note, '');
      }
      setText(feed, `SIM · ${closed ? 'CLOSED' : market.seed.label}${market.respectHours ? '' : ' · WEEKEND PRACTICE'}`);
      const clk = $('clock');
      const html = `${clock(Date.now())}<small>UTC ${new Date().toISOString().slice(11, 16)}</small>`;
      if (clk.innerHTML !== html) clk.innerHTML = html;
      renderTape();
      analysis.renderSessions();
    }
    if (slow % 8 === 0) {
      analysis.renderTech();
      analysis.renderStrength();
      apPanel.tick();
    }
    if (slow % 20 === 0 && prefs.tab === 'scanner') analysis.renderScanner();
    if (slow % 40 === 0 && prefs.tab === 'correlation') analysis.renderCorrelation();
  }, TICK_MS);
}
