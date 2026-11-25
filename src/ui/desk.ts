import type { ClosedTrade, Position } from '../core/account';
import { inferCondition, validateAlert } from '../core/alerts';
import {
  dateTime,
  escapeHtml,
  lots as fmtLots,
  money,
  moneySigned,
  pct,
  pips as fmtPips,
  price as fmtPrice,
  ratio,
} from '../core/format';
import { displaySymbol, getInstrument, INSTRUMENTS, MIN_UNITS, roundPrice, unitsToLots } from '../core/instruments';
import { bySymbol, computeStats } from '../core/stats';
import { $, setSigned, setText } from './dom';
import type { App } from './context';
import { drawCurve } from './minicharts';

export interface Desk {
  render(): void;
  tick(): void;
  renderPerformance(): void;
  renderRisk(): void;
}

const REASON: Record<string, string> = {
  manual: 'Manual',
  sl: 'Stop loss',
  tp: 'Take profit',
  trail: 'Trailing stop',
  stopout: 'STOP-OUT',
  guard: 'Risk guard',
  reverse: 'Reversed',
  signal: 'Strategy exit',
};

export function initDesk(app: App): Desk {
  const posBody = $('pos-body');
  const ordBody = $('ord-body');
  const histBody = $('hist-body');
  const alBody = $('al-body');
  const cells = new Map<number, { price: HTMLElement; pips: HTMLElement; pl: HTMLElement; sl: HTMLElement }>();
  const ordCells = new Map<number, HTMLElement>();
  const alCells = new Map<number, HTMLElement>();
  let editing: { id: number; sl: string; tp: string; trail: string } | null = null;

  const sideHtml = (s: 'buy' | 'sell') => `<span class="side-${s}">${s.toUpperCase()}</span>`;
  const px = (symbol: string, v: number | null) => (v === null ? '<span class="dim">—</span>' : fmtPrice(v, getInstrument(symbol).digits));

  // ---------------------------------------------------------------- positions
  function renderPositions(): void {
    const ps = app.engine.state.positions;
    cells.clear();
    setText($('cnt-pos'), String(ps.length));
    $('pos-empty').hidden = ps.length > 0;
    posBody.innerHTML = ps
      .map((p) => {
        const row = `<tr data-id="${p.id}">
          <td class="dim">${p.id}</td>
          <td><b>${displaySymbol(p.symbol)}</b>${app.positionTag(p.id) ? ` <span class="badge probation" title="Opened by the autopilot">${app.positionTag(p.id)}</span>` : ''}</td>
          <td>${sideHtml(p.side)}</td>
          <td class="r">${fmtLots(unitsToLots(p.units))}</td>
          <td class="r">${px(p.symbol, p.entry)}</td>
          <td class="r" data-c="price"></td>
          <td class="r" data-c="sl"></td>
          <td class="r">${px(p.symbol, p.tp)}</td>
          <td class="r" data-c="pips"></td>
          <td class="r" data-c="pl"></td>
          <td><span class="act">
            <button type="button" data-a="be" title="Move stop to break-even">BE</button>
            <button type="button" data-a="half" title="Close half the position">HALF</button>
            <button type="button" data-a="rev" title="Reverse">REV</button>
            <button type="button" data-a="edit" title="Edit stop / target">EDIT</button>
            <button type="button" data-a="close" class="x" title="Close" aria-label="Close position ${p.id}">✕</button>
          </span></td></tr>`;
        if (editing && editing.id === p.id) {
          return (
            row +
            `<tr class="edit-row" data-edit="${p.id}"><td colspan="11"><span class="inl">
              <label>S/L <input type="number" step="any" data-f="sl" value="${escapeHtml(editing.sl)}" /></label>
              <label>T/P <input type="number" step="any" data-f="tp" value="${escapeHtml(editing.tp)}" /></label>
              <label>Trail pips <input type="number" step="0.1" min="0" data-f="trail" value="${escapeHtml(editing.trail)}" /></label>
              <button type="button" class="btn ok" data-a="save">Save</button>
              <button type="button" class="btn" data-a="cancel">Cancel</button>
              <span class="dim">Empty = none</span></span></td></tr>`
          );
        }
        return row;
      })
      .join('');
    for (const tr of posBody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')) {
      const id = Number(tr.dataset.id);
      const q = (c: string) => tr.querySelector<HTMLElement>(`[data-c="${c}"]`)!;
      cells.set(id, { price: q('price'), pips: q('pips'), pl: q('pl'), sl: q('sl') });
    }
    tickPositions();
  }

  function tickPositions(): void {
    let total = 0;
    for (const p of app.engine.state.positions) {
      const c = cells.get(p.id);
      const pl = app.engine.floating(p);
      total += pl;
      if (!c) continue;
      const inst = getInstrument(p.symbol);
      setText(c.price, fmtPrice(app.engine.exitPrice(p), inst.digits));
      c.sl.innerHTML = px(p.symbol, p.sl) + (p.trailPips ? ` <span class="dim" title="Trailing ${p.trailPips} pips">⇡</span>` : '');
      const pp = app.engine.floatingPips(p);
      setSigned(c.pips, fmtPips(pp), pp);
      setSigned(c.pl, moneySigned(pl), pl);
    }
    const el = $('pos-total');
    if (app.engine.state.positions.length) setSigned(el, `Floating ${moneySigned(total)}`, total);
    else setText(el, '');
  }

  posBody.addEventListener('input', (e) => {
    const inp = e.target as HTMLInputElement;
    if (!editing || !inp.dataset.f) return;
    editing[inp.dataset.f as 'sl' | 'tp' | 'trail'] = inp.value;
  });
  posBody.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
    if (!btn) return;
    const tr = btn.closest('tr')!;
    const id = Number(tr.dataset.id ?? tr.dataset.edit);
    const p = app.engine.state.positions.find((x) => x.id === id);
    if (!p) return;
    const a = btn.dataset.a;
    const report = (r: { ok: boolean; error?: string }) => {
      if (!r.ok) {
        app.toast('Rejected', r.error ?? '', 'err');
        app.log(r.error ?? '', 'err');
        app.sound('error');
      }
    };
    if (a === 'close') report(app.engine.close(id));
    else if (a === 'half') {
      const half = Math.floor(p.units / 2 / MIN_UNITS) * MIN_UNITS;
      if (half < MIN_UNITS) report({ ok: false, error: `#${id} is too small to split` });
      else report(app.engine.close(id, half));
    } else if (a === 'be') {
      const r = app.engine.breakEven(id);
      report(r);
      if (r.ok) app.log(`#${id} stop moved to break-even ${r.value.sl}`, 'ok');
    } else if (a === 'rev') report(app.engine.reverse(id));
    else if (a === 'edit') {
      const inst = getInstrument(p.symbol);
      editing = {
        id,
        sl: p.sl === null ? '' : fmtPrice(p.sl, inst.digits),
        tp: p.tp === null ? '' : fmtPrice(p.tp, inst.digits),
        trail: p.trailPips === null ? '' : String(p.trailPips),
      };
      renderPositions();
      return;
    } else if (a === 'cancel') {
      editing = null;
      renderPositions();
      return;
    } else if (a === 'save' && editing) {
      const parse = (s: string) => (s.trim() === '' ? null : Number(s));
      const sl = parse(editing.sl);
      const tp = parse(editing.tp);
      const trail = parse(editing.trail);
      if ([sl, tp, trail].some((v) => v !== null && (!Number.isFinite(v) || v <= 0))) {
        report({ ok: false, error: 'Enter positive numbers or leave a field empty' });
        return;
      }
      const r = app.engine.modify(id, { sl, tp, trailPips: trail });
      report(r);
      if (r.ok) {
        editing = null;
        app.log(`#${id} modified: SL ${r.value.sl ?? '—'} · TP ${r.value.tp ?? '—'}${r.value.trailPips ? ` · trail ${r.value.trailPips}p` : ''}`, 'ok');
        renderPositions();
      }
      return;
    }
  });

  document.querySelector('[data-pane="positions"] .pane-tools')!.addEventListener('click', (e) => {
    const which = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-close]')?.dataset.close;
    if (!which) return;
    const pred =
      which === 'all'
        ? () => true
        : which === 'winners'
          ? (p: Position) => app.engine.floating(p) > 0
          : (p: Position) => app.engine.floating(p) < 0;
    const closed = app.engine.closeWhere(pred);
    app.log(`Closed ${closed.length} position${closed.length === 1 ? '' : 's'} (${which})`, closed.length ? 'ok' : 'info');
  });

  // ---------------------------------------------------------------- orders
  function renderOrders(): void {
    const os = app.engine.state.orders;
    ordCells.clear();
    setText($('cnt-ord'), String(os.length));
    $('ord-empty').hidden = os.length > 0;
    ordBody.innerHTML = os
      .map(
        (o) => `<tr data-id="${o.id}">
        <td class="dim">${o.id}</td>
        <td><b>${displaySymbol(o.symbol)}</b></td>
        <td>${sideHtml(o.side)} ${o.type.toUpperCase()}</td>
        <td class="r">${fmtLots(unitsToLots(o.units))}</td>
        <td class="r">${px(o.symbol, o.price)}</td>
        <td class="r" data-c="dist"></td>
        <td class="r">${o.slPips ?? (o.trailPips ? `trail ${o.trailPips}` : '—')}</td>
        <td class="r">${o.tpPips ?? '—'}</td>
        <td class="dim">${dateTime(o.createdAt)}</td>
        <td><span class="act"><button type="button" class="x" data-a="cancel" aria-label="Cancel order ${o.id}">✕</button></span></td>
      </tr>`,
      )
      .join('');
    for (const tr of ordBody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')) {
      ordCells.set(Number(tr.dataset.id), tr.querySelector<HTMLElement>('[data-c="dist"]')!);
    }
    tickOrders();
  }

  function tickOrders(): void {
    for (const o of app.engine.state.orders) {
      const el = ordCells.get(o.id);
      const q = app.market.quote(o.symbol);
      if (!el || !q) continue;
      const ref = o.side === 'buy' ? q.ask : q.bid;
      setText(el, `${fmtPips(Math.abs(o.price - ref) / getInstrument(o.symbol).pip, false)} p`);
    }
  }

  ordBody.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a="cancel"]');
    if (!btn) return;
    app.engine.cancelOrder(Number(btn.closest('tr')!.dataset.id), 'Cancelled by you');
  });

  // ---------------------------------------------------------------- history
  function renderHistory(): void {
    const hs = app.engine.state.history;
    $('hist-empty').hidden = hs.length > 0;
    const shown = hs.slice(-300).reverse();
    histBody.innerHTML = shown
      .map(
        (t) => `<tr>
        <td class="dim">${dateTime(t.closeTime)}</td>
        <td class="dim">${t.positionId}</td>
        <td><b>${displaySymbol(t.symbol)}</b></td>
        <td>${sideHtml(t.side)}</td>
        <td class="r">${fmtLots(unitsToLots(t.units))}</td>
        <td class="r">${px(t.symbol, t.entry)}</td>
        <td class="r">${px(t.symbol, t.exit)}</td>
        <td class="r ${t.pips > 0 ? 'pos' : t.pips < 0 ? 'neg' : ''}">${fmtPips(t.pips)}</td>
        <td class="r ${t.net > 0 ? 'pos' : t.net < 0 ? 'neg' : ''}">${moneySigned(t.net)}</td>
        <td class="r">${t.r === null ? '<span class="dim">—</span>' : (t.r >= 0 ? '+' : '') + t.r.toFixed(2)}</td>
        <td class="${t.reason === 'stopout' ? 'neg' : 'dim'}">${REASON[t.reason] ?? t.reason}</td>
      </tr>`,
      )
      .join('');
    setText($('hist-note'), hs.length ? `${hs.length} trades${hs.length > 300 ? ' (newest 300 shown)' : ''}` : '');
  }

  function historyCsv(hs: readonly ClosedTrade[]): string {
    const head = 'close_time,open_time,position,symbol,side,lots,entry,exit,pips,gross,commission,net,r,reason';
    const rows = hs.map((t) =>
      [
        new Date(t.closeTime).toISOString(),
        new Date(t.openTime).toISOString(),
        t.positionId,
        t.symbol,
        t.side,
        unitsToLots(t.units),
        t.entry,
        t.exit,
        t.pips,
        t.gross.toFixed(2),
        t.commission.toFixed(2),
        t.net.toFixed(2),
        t.r === null ? '' : t.r.toFixed(3),
        t.reason,
      ].join(','),
    );
    return [head, ...rows].join('\n');
  }

  $('hist-copy').addEventListener('click', () => {
    const text = historyCsv(app.engine.state.history);
    const box = $<HTMLTextAreaElement>('hist-copybox');
    const fallback = () => {
      box.hidden = false;
      box.value = text;
      box.focus();
      box.select();
      app.toast('Copy', 'Clipboard unavailable. The CSV is selected below: press Ctrl/Cmd + C.', 'warn');
    };
    try {
      navigator.clipboard.writeText(text).then(
        () => app.toast('Copied', `${app.engine.state.history.length} trades copied as CSV`, 'ok'),
        fallback,
      );
    } catch {
      fallback();
    }
  });

  // ---------------------------------------------------------------- performance
  function renderPerformance(): void {
    const hs = app.engine.state.history;
    const start = app.engine.state.settings.startBalance;
    const s = computeStats(hs, start);
    const tile = (k: string, v: string, cls = '', sub = '') =>
      `<div class="tile"><span class="k">${k}</span><span class="v ${cls}">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
    const sign = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
    $('perf-tiles').innerHTML = [
      tile('Net P/L', moneySigned(s.net), sign(s.net), pct((s.net / start) * 100, 2, true) + ' of start'),
      tile('Trades', String(s.trades), '', `${s.wins} won · ${s.losses} lost`),
      tile('Win rate', s.trades ? pct(s.winRate * 100, 1) : '—'),
      tile('Profit factor', ratio(s.profitFactor), s.profitFactor > 1 ? 'pos' : s.profitFactor < 1 ? 'neg' : ''),
      tile('Expectancy', s.trades ? moneySigned(s.expectancy) : '—', sign(s.expectancy), 'per trade'),
      tile('Avg R', Number.isNaN(s.avgR) ? '—' : (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R', Number.isNaN(s.avgR) ? '' : sign(s.avgR)),
      tile('Avg win', s.wins ? money(s.avgWin) : '—', s.wins ? 'pos' : ''),
      tile('Avg loss', s.losses ? money(-s.avgLoss) : '—', s.losses ? 'neg' : '', `payoff ${ratio(s.payoff)}`),
      tile('Max drawdown', s.trades ? pct(s.maxDrawdownPct, 2) : '—', s.maxDrawdownPct > 10 ? 'neg' : '', money(s.maxDrawdown)),
      tile('Best trade', s.wins ? moneySigned(s.largestWin) : '—', s.wins ? 'pos' : ''),
      tile('Worst trade', s.losses ? moneySigned(s.largestLoss) : '—', s.losses ? 'neg' : ''),
      tile('Streaks', s.trades ? `${s.maxConsecWins}W · ${s.maxConsecLosses}L` : '—', '', 'longest runs'),
      tile('SQN', s.trades >= 2 ? s.sqn.toFixed(2) : '—', '', 'system quality'),
    ].join('');
    drawCurve($<HTMLCanvasElement>('perf-curve'), s.curve, start, 'Close a trade to start the balance curve');
    const pairs = bySymbol(hs);
    $('perf-pairs').innerHTML = pairs.length
      ? `<thead><tr><th>Pair</th><th class="r">Trades</th><th class="r">Win %</th><th class="r">Net</th></tr></thead><tbody>${pairs
          .map(
            (p) =>
              `<tr><td><b>${displaySymbol(p.symbol)}</b></td><td class="r">${p.trades}</td><td class="r">${(p.winRate * 100).toFixed(0)}%</td><td class="r ${sign(p.net)}">${moneySigned(p.net)}</td></tr>`,
          )
          .join('')}</tbody>`
      : '<tbody><tr><td class="dim">No closed trades yet</td></tr></tbody>';
  }

  // ---------------------------------------------------------------- alerts
  const alSym = $<HTMLSelectElement>('al-symbol');
  alSym.innerHTML = INSTRUMENTS.map((i) => `<option value="${i.symbol}">${displaySymbol(i.symbol)}</option>`).join('');
  $('al-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const symbol = alSym.value;
    const price = Number($<HTMLInputElement>('al-price').value);
    const q = app.market.quote(symbol);
    if (!q || !(price > 0)) {
      app.toast('Alert', 'Enter a positive price', 'err');
      return;
    }
    const sel = $<HTMLSelectElement>('al-cond').value;
    const cond = sel === 'auto' ? inferCondition(price, q.bid) : (sel as 'above' | 'below');
    const err = validateAlert(cond, price, q.bid);
    if (err) {
      app.toast('Alert', err, 'err');
      return;
    }
    const inst = getInstrument(symbol);
    app.alerts.push({ id: app.nextAlertId(), symbol, cond, price: roundPrice(price, inst.digits), createdAt: Date.now(), triggeredAt: null });
    app.saveAlerts();
    renderAlerts();
    app.log(`Alert set: ${displaySymbol(symbol)} bid ${cond === 'above' ? '≥' : '≤'} ${price}`, 'info');
  });
  alSym.addEventListener('change', () => {
    const q = app.market.quote(alSym.value);
    if (q) $<HTMLInputElement>('al-price').value = fmtPrice(q.bid, getInstrument(alSym.value).digits);
  });

  function renderAlerts(): void {
    alCells.clear();
    const list = app.alerts;
    setText($('cnt-al'), String(list.filter((a) => a.triggeredAt === null).length));
    $('al-empty').hidden = list.length > 0;
    alBody.innerHTML = list
      .map(
        (a) => `<tr data-id="${a.id}">
        <td><b>${displaySymbol(a.symbol)}</b></td>
        <td>bid ${a.cond === 'above' ? '≥' : '≤'}</td>
        <td class="r">${px(a.symbol, a.price)}</td>
        <td class="r" data-c="dist"></td>
        <td class="${a.triggeredAt ? 'warn' : 'dim'}">${a.triggeredAt ? `Hit ${dateTime(a.triggeredAt)}` : 'Watching'}</td>
        <td><span class="act"><button type="button" class="x" data-a="del" aria-label="Delete alert">✕</button></span></td>
      </tr>`,
      )
      .join('');
    for (const tr of alBody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')) {
      alCells.set(Number(tr.dataset.id), tr.querySelector<HTMLElement>('[data-c="dist"]')!);
    }
    tickAlerts();
  }
  function tickAlerts(): void {
    for (const a of app.alerts) {
      const el = alCells.get(a.id);
      const q = app.market.quote(a.symbol);
      if (!el || !q) continue;
      setText(el, a.triggeredAt ? '—' : `${fmtPips(Math.abs(a.price - q.bid) / getInstrument(a.symbol).pip, false)} p`);
    }
  }
  alBody.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a="del"]');
    if (!btn) return;
    const id = Number(btn.closest('tr')!.dataset.id);
    app.alerts.splice(
      app.alerts.findIndex((a) => a.id === id),
      1,
    );
    app.saveAlerts();
    renderAlerts();
  });

  // ---------------------------------------------------------------- risk & account
  const gEnabled = $<HTMLInputElement>('g-enabled');
  const gSl = $<HTMLInputElement>('g-sl');
  const gRisk = $<HTMLInputElement>('g-risk');
  const gDaily = $<HTMLInputElement>('g-daily');
  const gMax = $<HTMLInputElement>('g-max');
  const gFlat = $<HTMLInputElement>('g-flatten');
  const aLev = $<HTMLSelectElement>('a-lev');
  const aComm = $<HTMLInputElement>('a-comm');
  const aStart = $<HTMLInputElement>('a-start');

  function renderRisk(): void {
    const g = app.engine.state.guard;
    const s = app.engine.state.settings;
    gEnabled.checked = g.enabled;
    gSl.checked = g.requireStopLoss;
    gRisk.value = String(g.maxRiskPct);
    gDaily.value = String(g.dailyLossPct);
    gMax.value = String(g.maxPositions);
    gFlat.checked = g.autoFlatten;
    aLev.value = String(s.leverage);
    aComm.value = String(s.commissionPerLot);
    aStart.value = String(s.startBalance);
    $<HTMLInputElement>('a-weekend').checked = app.prefs.weekendPractice;
    tickRisk();
  }
  function tickRisk(): void {
    const d = app.engine.state.day;
    const g = app.engine.state.guard;
    const m = app.engine.metrics();
    const limit = g.dailyLossPct > 0 ? (d.startEquity * g.dailyLossPct) / 100 : 0;
    const html = [
      `Trading day P/L: <span class="${m.dayPnl >= 0 ? 'pos' : 'neg'}">${moneySigned(m.dayPnl)} (${pct(m.dayPnlPct, 2, true)})</span>`,
      g.enabled && limit > 0 ? `Daily loss budget left: ${money(Math.max(0, limit + m.dayPnl))} of ${money(limit)}` : 'Daily loss limit: off',
      `Trades opened today: ${d.trades}`,
      !g.enabled
        ? '<span class="warn">Guard is OFF. Nothing stops an oversized trade.</span>'
        : d.locked
          ? `<span class="neg">LOCKED: ${escapeHtml(d.lockReason)}. Unlocks at the 17:00 New York rollover.</span>`
          : '<span class="pos">Guard armed</span>',
    ].join('<br />');
    const el = $('guard-status');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  const clampNum = (el: HTMLInputElement, min: number, max: number, fb: number) => {
    const v = Number(el.value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb;
  };
  $('guard-form').addEventListener('change', () => {
    const g = app.engine.state.guard;
    g.enabled = gEnabled.checked;
    g.requireStopLoss = gSl.checked;
    g.maxRiskPct = clampNum(gRisk, 0, 100, g.maxRiskPct);
    g.dailyLossPct = clampNum(gDaily, 0, 100, g.dailyLossPct);
    g.maxPositions = Math.round(clampNum(gMax, 1, 200, g.maxPositions));
    g.autoFlatten = gFlat.checked;
    app.saveAccount();
    renderRisk();
    app.log(`Risk guard ${g.enabled ? 'ON' : 'OFF'} · max risk ${g.maxRiskPct}% · daily limit ${g.dailyLossPct}% · max ${g.maxPositions} positions`, 'info');
  });
  $('guard-form').addEventListener('submit', (e) => e.preventDefault());
  $('acct-form').addEventListener('submit', (e) => e.preventDefault());
  $('acct-form').addEventListener('change', (e) => {
    const s = app.engine.state.settings;
    if (e.target === aLev) s.leverage = Number(aLev.value) || s.leverage;
    if (e.target === aComm) s.commissionPerLot = clampNum(aComm, 0, 100, s.commissionPerLot);
    if (e.target === aStart) s.startBalance = Math.round(clampNum(aStart, 100, 100_000_000, s.startBalance));
    if (e.target === $('a-weekend')) {
      app.prefs.weekendPractice = $<HTMLInputElement>('a-weekend').checked;
      app.market.respectHours = !app.prefs.weekendPractice;
      app.savePrefs();
      app.log(app.prefs.weekendPractice ? 'Weekend practice ON: the simulator keeps running when the real market is closed' : 'The simulator follows real FX market hours again', 'info');
    }
    app.saveAccount();
    renderRisk();
  });
  $('a-reset').addEventListener('click', () => {
    $('a-reset-confirm').hidden = false;
  });
  $('a-reset-no').addEventListener('click', () => {
    $('a-reset-confirm').hidden = true;
  });
  $('a-reset-yes').addEventListener('click', () => {
    $('a-reset-confirm').hidden = true;
    app.engine.reset(Math.round(clampNum(aStart, 100, 100_000_000, app.engine.state.settings.startBalance)));
  });

  function render(): void {
    renderPositions();
    renderOrders();
    renderHistory();
    renderAlerts();
    if (app.prefs.tab === 'performance') renderPerformance();
    tickRisk();
  }

  render();
  renderRisk();
  return {
    render,
    tick: () => {
      tickPositions();
      tickOrders();
      tickAlerts();
      if (app.prefs.tab === 'risk') tickRisk();
    },
    renderPerformance,
    renderRisk,
  };
}
