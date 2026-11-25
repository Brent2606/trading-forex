import { defaultParams, runBacktest, STRATEGIES, type Strategy } from '../core/backtest';
import { TIMEFRAMES, type Timeframe } from '../core/candles';
import { parseCsv } from '../core/csv';
import { escapeHtml, integer, money, moneySigned, pct, ratio } from '../core/format';
import { ACCOUNT_CCY, displaySymbol, findInstrument, getInstrument } from '../core/instruments';
import { convert } from '../core/rates';
import { $, setText } from './dom';
import type { App } from './context';
import { drawCurve } from './minicharts';

export function tfForBarMs(ms: number): Timeframe {
  if (ms <= 60_000) return 'M1';
  if (ms <= 300_000) return 'M5';
  if (ms <= 900_000) return 'M15';
  if (ms <= 3_600_000) return 'H1';
  if (ms <= 14_400_000) return 'H4';
  return 'D1';
}

export function initBacktest(app: App): { onChartChange(): void } {
  const sel = $<HTMLSelectElement>('bt-strategy');
  const src = $<HTMLSelectElement>('bt-source');
  const paramsEl = $('bt-params');
  sel.innerHTML = STRATEGIES.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  const current = (): Strategy => STRATEGIES.find((s) => s.id === sel.value) ?? STRATEGIES[0];

  function renderParams(): void {
    const s = current();
    paramsEl.innerHTML = s.params
      .map(
        (p) =>
          `<label>${p.label} <input type="number" data-k="${p.key}" value="${p.def}" min="${p.min}" max="${p.max}" step="${p.step}" /></label>`,
      )
      .join('');
    setText($('bt-blurb'), s.blurb);
  }
  sel.addEventListener('change', renderParams);
  renderParams();

  const tfSel = $<HTMLSelectElement>('bt-tf');
  const btTf = (): Timeframe => (TIMEFRAMES as readonly string[]).includes(tfSel.value) ? (tfSel.value as Timeframe) : 'H1';
  src.addEventListener('change', () => (tfSel.disabled = src.value === 'csv'));

  function describeSource(): string {
    if (src.value === 'csv' && app.csv) return `${app.csv.name} (${integer(app.csv.candles.length)} bars)`;
    return `${displaySymbol(app.prefs.symbol)} ${btTf()} (simulated)`;
  }

  $('bt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const strategy = current();
    const params = defaultParams(strategy);
    for (const inp of paramsEl.querySelectorAll<HTMLInputElement>('input[data-k]')) {
      const v = Number(inp.value);
      if (Number.isFinite(v)) params[inp.dataset.k!] = v;
    }
    const n = (id: string, fb: number) => {
      const v = Number($<HTMLInputElement>(id).value);
      return Number.isFinite(v) && v >= 0 ? v : fb;
    };
    const useCsv = src.value === 'csv' && app.csv !== null;
    const settings = app.engine.state.settings;
    let candles;
    let pip: number;
    let spreadPips: number;
    let quoteToUsd: (p: number) => number;
    let key: string;
    let note = '';
    if (useCsv) {
      const csv = app.csv!;
      candles = csv.candles;
      pip = csv.pip;
      const inst = csv.symbol ? findInstrument(csv.symbol) : undefined;
      spreadPips = inst ? inst.spread : 1;
      if (inst && inst.quote === ACCOUNT_CCY) quoteToUsd = () => 1;
      else if (inst && inst.base === ACCOUNT_CCY) quoteToUsd = (p) => 1 / p;
      else if (inst) {
        const k = convert(1, inst.quote, ACCOUNT_CCY, app.market.mid);
        quoteToUsd = () => k;
        note = `P/L converted from ${inst.quote} at today's rate. `;
      } else {
        quoteToUsd = () => 1;
        note = 'Pair not recognised from the file name: P/L assumes the quote currency is USD. ';
      }
      note += `Spread ${spreadPips} pips. `;
      key = 'csv';
    } else {
      const inst = getInstrument(app.prefs.symbol);
      candles = app.market.series(app.prefs.symbol, btTf()).slice();
      pip = inst.pip;
      spreadPips = inst.spread;
      if (inst.quote === ACCOUNT_CCY) quoteToUsd = () => 1;
      else if (inst.base === ACCOUNT_CCY) quoteToUsd = (p) => 1 / p;
      else {
        const k = convert(1, inst.quote, ACCOUNT_CCY, app.market.mid);
        quoteToUsd = () => k;
      }
      key = `live:${app.prefs.symbol}:${btTf()}`;
      note =
        'Simulated prices are a random walk, so no strategy has a real edge here and costs make most of them lose. Import real broker data (CSV) to test an idea for real. ';
    }
    if (candles.length < 50) {
      app.toast('Backtest', 'Need at least 50 bars', 'err');
      return;
    }
    const t0 = performance.now();
    const r = runBacktest({
      candles,
      strategy,
      params,
      pip,
      spreadPips,
      commissionPerLot: settings.commissionPerLot,
      startBalance: settings.startBalance,
      riskPct: n('bt-risk', 1),
      fixedLots: n('bt-lots', 0.1),
      slAtr: n('bt-sl', 2),
      tpAtr: n('bt-tp', 3),
      exitOnOpposite: $<HTMLInputElement>('bt-opp').checked,
      allowLong: $<HTMLInputElement>('bt-long').checked,
      allowShort: $<HTMLInputElement>('bt-short').checked,
      trendFilter: Math.round(n('bt-trend', 0)),
      leverage: settings.leverage,
      quoteToUsd,
    });
    const ms = performance.now() - t0;
    const s = r.stats;
    const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    const tile = (k: string, v: string, cls = '', sub = '') =>
      `<div class="tile"><span class="k">${k}</span><span class="v ${cls}">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
    $('bt-tiles').innerHTML = [
      tile('Net P/L', moneySigned(s.net), sign(s.net), pct(r.returnPct, 2, true)),
      tile('Trades', String(s.trades), '', `${s.wins}W · ${s.losses}L`),
      tile('Win rate', s.trades ? pct(s.winRate * 100, 1) : '—'),
      tile('Profit factor', ratio(s.profitFactor), s.profitFactor > 1 ? 'pos' : s.profitFactor < 1 ? 'neg' : ''),
      tile('Expectancy', s.trades ? moneySigned(s.expectancy) : '—', sign(s.expectancy), 'per trade'),
      tile('Max drawdown', pct(r.maxDrawdownPct, 2), r.maxDrawdownPct > 20 ? 'neg' : '', money(r.maxDrawdown)),
      tile('Avg win', s.wins ? money(s.avgWin) : '—', s.wins ? 'pos' : ''),
      tile('Avg loss', s.losses ? money(-s.avgLoss) : '—', s.losses ? 'neg' : ''),
      tile('Exposure', pct(r.exposurePct, 0), '', 'time in market'),
      tile('Buy & hold', pct(r.buyHoldPct, 2, true), sign(r.buyHoldPct), 'price change'),
    ].join('');
    drawCurve($<HTMLCanvasElement>('bt-curve'), r.equity, settings.startBalance, 'No bars');
    const lowSample = s.trades < 30 ? `Only ${s.trades} trades: too few to trust. ` : '';
    setText(
      $('bt-note'),
      `${strategy.name} on ${describeSource()} · ${integer(candles.length)} bars in ${ms.toFixed(0)} ms. ${lowSample}${note}Entries fill at the next bar's open with spread and commission; stops are assumed hit before targets inside a bar.`,
    );
    const th = getComputedStyle(document.documentElement);
    const up = th.getPropertyValue('--up').trim() || '#00f0b5';
    const down = th.getPropertyValue('--down').trim() || '#ff2f7d';
    const warn = th.getPropertyValue('--warn').trim() || '#ffc23d';
    app.marks = {
      key,
      markers: r.trades.flatMap((t) => [
        { t: candles[t.entryIdx].t, price: t.side === 'buy' ? candles[t.entryIdx].l : candles[t.entryIdx].h, dir: t.side === 'buy' ? ('up' as const) : ('down' as const), color: t.side === 'buy' ? up : down },
        { t: candles[t.exitIdx].t, price: t.side === 'buy' ? candles[t.exitIdx].h : candles[t.exitIdx].l, dir: t.side === 'buy' ? ('down' as const) : ('up' as const), color: t.net >= 0 ? warn : '#8f88bf' },
      ]),
    };
    if (useCsv && app.chartSource !== 'csv') app.showCsvOnChart();
    if (!useCsv && (app.chartSource !== 'live' || app.prefs.tf !== btTf())) app.select(app.prefs.symbol, btTf());
    app.log(
      `Backtest ${strategy.name} on ${describeSource()}: ${s.trades} trades, net ${moneySigned(s.net)}, PF ${ratio(s.profitFactor)}, max DD ${pct(r.maxDrawdownPct, 1)}`,
      s.net >= 0 ? 'ok' : 'warn',
    );
  });

  $('bt-clear-marks').addEventListener('click', () => {
    app.marks = null;
  });

  $<HTMLInputElement>('bt-file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 60 * 1024 * 1024) {
      app.toast('Import', 'File is larger than 60 MB', 'err');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => app.toast('Import', 'Could not read the file', 'err');
    reader.onload = () => {
      try {
        const res = parseCsv(String(reader.result ?? ''), file.name);
        app.csv = { ...res, name: file.name };
        const opt = src.querySelector<HTMLOptionElement>('option[value="csv"]')!;
        opt.disabled = false;
        opt.textContent = `Imported: ${file.name}`;
        src.value = 'csv';
        tfSel.disabled = true;
        const first = new Date(res.candles[0].t).toISOString().slice(0, 16).replace('T', ' ');
        const last = new Date(res.candles[res.candles.length - 1].t).toISOString().slice(0, 16).replace('T', ' ');
        $('bt-csv-info').innerHTML = `Imported <b>${escapeHtml(file.name)}</b>: ${integer(res.candles.length)} bars, ${first} → ${last} UTC, bar ≈ ${tfForBarMs(res.barMs)}, pair ${res.symbol ? displaySymbol(res.symbol) : 'unknown'}, pip ${res.pip}${res.skipped ? `, ${res.skipped} rows skipped` : ''}.`;
        app.showCsvOnChart();
        app.toast('Imported', `${integer(res.candles.length)} bars from ${file.name}`, 'ok');
      } catch (err) {
        app.toast('Import failed', err instanceof Error ? err.message : String(err), 'err');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  });

  return {
    onChartChange: () => {
      if (src.value === 'chart') setText($('bt-blurb'), current().blurb);
    },
  };
}
