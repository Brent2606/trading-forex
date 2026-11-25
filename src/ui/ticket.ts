import { atr, lastValue } from '../core/indicators';
import { displaySymbol, getInstrument, roundPrice } from '../core/instruments';
import { escapeHtml, lots as fmtLots, money, price as fmtPrice, integer } from '../core/format';
import { previewTrade } from '../core/risk';
import { $, pressSeg, priceHtml, setText } from './dom';
import type { App, OrderIntent, OrderKind } from './context';
import { sizeOrder } from './orders';

export interface Ticket {
  tick(): void;
  refresh(): void;
  trigger(side: 'buy' | 'sell'): void;
  cancelConfirm(): void;
  confirmPending(): boolean;
}

export function initTicket(app: App): Ticket {
  const t = app.prefs.ticket;
  const typeSeg = $('tk-type');
  const modeSeg = $('tk-mode');
  const priceRow = $('tk-price-row');
  const priceIn = $<HTMLInputElement>('tk-price');
  const sizeIn = $<HTMLInputElement>('tk-size');
  const slIn = $<HTMLInputElement>('tk-sl');
  const tpIn = $<HTMLInputElement>('tk-tp');
  const trailOn = $<HTMLInputElement>('tk-trail-on');
  const trailIn = $<HTMLInputElement>('tk-trail');
  const confirmOn = $<HTMLInputElement>('tk-confirm-on');
  const buyBtn = $<HTMLButtonElement>('tk-buy');
  const sellBtn = $<HTMLButtonElement>('tk-sell');
  const bidEl = $('tk-bid');
  const askEl = $('tk-ask');
  const spreadEl = $('tk-spread');
  const warnEl = $('tk-warn');
  const confirmBox = $('tk-confirm');
  const confirmText = $('tk-confirm-text');
  const prev = $('tk-preview');
  let pending: 'buy' | 'sell' | null = null;
  let lastBid = '';
  let lastAsk = '';

  const rows: Record<string, HTMLElement> = {};
  const defs: [string, string, boolean][] = [
    ['size', 'Size', false],
    ['units', 'Units', false],
    ['pip', 'Pip value', false],
    ['margin', 'Margin', false],
    ['risk', 'Risk', false],
    ['reward', 'Reward', false],
    ['rr', 'Reward : risk', false],
    ['comm', 'Commission', false],
    ['buy', 'Buy stops', true],
    ['sell', 'Sell stops', true],
  ];
  prev.innerHTML = defs
    .map(([k, label, wide]) => `<div class="${wide ? 'wide' : ''}"><dt>${label}</dt><dd id="pv-${k}">—</dd></div>`)
    .join('');
  for (const [k] of defs) rows[k] = $(`pv-${k}`);

  const save = () => app.savePrefs();
  const num = (el: HTMLInputElement) => {
    const v = Number(el.value);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };

  function syncInputs(): void {
    pressSeg(typeSeg, t.type);
    pressSeg(modeSeg, t.mode);
    priceRow.hidden = t.type === 'market';
    sizeIn.step = t.mode === 'risk' ? '0.1' : '0.01';
    sizeIn.value = String(t.mode === 'risk' ? t.risk : t.lots);
    sizeIn.setAttribute('aria-label', t.mode === 'risk' ? 'Risk percent of equity' : 'Lots');
    slIn.value = t.sl ? String(t.sl) : '';
    tpIn.value = t.tp ? String(t.tp) : '';
    trailOn.checked = t.trailOn;
    trailIn.value = String(t.trail);
    trailIn.disabled = !t.trailOn;
    confirmOn.checked = t.confirm;
    setText($('tk-pair'), displaySymbol(app.prefs.symbol));
    const suffix = t.type === 'market' ? '' : ` ${t.type.toUpperCase()}`;
    setText($('tk-buy-label'), `BUY${suffix}`);
    setText($('tk-sell-label'), `SELL${suffix}`);
  }

  function fillPrice(): void {
    const inst = getInstrument(app.prefs.symbol);
    const q = app.market.quote(app.prefs.symbol);
    if (q) priceIn.value = fmtPrice(q.mid, inst.digits);
  }

  typeSeg.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v as OrderKind | undefined;
    if (!v) return;
    t.type = v;
    if (v !== 'market' && !priceIn.value) fillPrice();
    syncInputs();
    save();
    tick();
  });
  modeSeg.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('button')?.dataset.v;
    if (v !== 'risk' && v !== 'lots') return;
    t.mode = v;
    syncInputs();
    save();
    tick();
  });
  sizeIn.addEventListener('input', () => {
    if (t.mode === 'risk') t.risk = num(sizeIn);
    else t.lots = num(sizeIn);
    save();
    tick();
  });
  slIn.addEventListener('input', () => {
    t.sl = num(slIn);
    save();
    tick();
  });
  tpIn.addEventListener('input', () => {
    t.tp = num(tpIn);
    save();
    tick();
  });
  trailOn.addEventListener('change', () => {
    t.trailOn = trailOn.checked;
    trailIn.disabled = !t.trailOn;
    save();
    tick();
  });
  trailIn.addEventListener('input', () => {
    t.trail = num(trailIn);
    save();
    tick();
  });
  confirmOn.addEventListener('change', () => {
    t.confirm = confirmOn.checked;
    save();
  });
  priceIn.addEventListener('input', () => tick());
  $('tk-price-fill').addEventListener('click', () => {
    fillPrice();
    tick();
  });
  $('tk-atr').addEventListener('click', () => {
    const inst = getInstrument(app.prefs.symbol);
    const a = lastValue(atr(app.market.series(app.prefs.symbol, app.prefs.tf), 14));
    if (!Number.isFinite(a)) return;
    t.sl = Math.max(0.5, Math.round(((a * 1.5) / inst.pip) * 10) / 10);
    syncInputs();
    save();
    tick();
    app.log(`Stop set to 1.5 × ATR(14) on ${app.prefs.tf} = ${t.sl} pips`, 'info');
  });
  $('tk-rr').addEventListener('click', (e) => {
    const r = Number((e.target as HTMLElement).closest('button')?.dataset.v);
    if (!r || !t.sl) return;
    t.tp = Math.round(t.sl * r * 10) / 10;
    syncInputs();
    save();
    tick();
  });

  function intent(side: 'buy' | 'sell'): OrderIntent {
    return {
      side,
      type: t.type,
      symbol: app.prefs.symbol,
      lots: t.mode === 'lots' ? t.lots : undefined,
      riskPct: t.mode === 'risk' ? t.risk : undefined,
      price: t.type === 'market' ? undefined : Number(priceIn.value),
      slPips: t.sl > 0 ? t.sl : null,
      tpPips: t.tp > 0 ? t.tp : null,
      trailPips: t.trailOn && t.trail > 0 ? t.trail : null,
    };
  }

  function describe(side: 'buy' | 'sell'): string {
    const o = intent(side);
    const s = sizeOrder(app.engine, app.market, o);
    const size = s.ok ? `${fmtLots(s.lots)} lots` : '?';
    const where = o.type === 'market' ? 'at market' : `${o.type} @ ${o.price}`;
    const parts = [`${side.toUpperCase()} ${size} ${displaySymbol(o.symbol)} ${where}`];
    if (o.slPips) parts.push(`SL ${o.slPips}p`);
    if (o.tpPips) parts.push(`TP ${o.tpPips}p`);
    if (o.trailPips) parts.push(`trail ${o.trailPips}p`);
    return parts.join(' · ');
  }

  function trigger(side: 'buy' | 'sell'): void {
    if (t.confirm) {
      pending = side;
      confirmText.textContent = describe(side) + '?';
      confirmBox.hidden = false;
      $('tk-confirm-yes').focus();
      return;
    }
    app.placeOrder(intent(side));
  }

  function confirmPending(): boolean {
    if (!pending) return false;
    const side = pending;
    cancelConfirm();
    app.placeOrder(intent(side));
    return true;
  }

  function cancelConfirm(): void {
    pending = null;
    confirmBox.hidden = true;
  }

  buyBtn.addEventListener('click', () => trigger('buy'));
  sellBtn.addEventListener('click', () => trigger('sell'));
  $('tk-confirm-yes').addEventListener('click', () => confirmPending());
  $('tk-confirm-no').addEventListener('click', () => cancelConfirm());
  for (const [btn, side] of [
    [buyBtn, 'buy'],
    [sellBtn, 'sell'],
  ] as const) {
    btn.addEventListener('pointerenter', () => (app.ghost = side));
    btn.addEventListener('pointerleave', () => (app.ghost = null));
    btn.addEventListener('focus', () => (app.ghost = side));
    btn.addEventListener('blur', () => (app.ghost = null));
  }

  function tick(): void {
    const sym = app.prefs.symbol;
    const inst = getInstrument(sym);
    const q = app.market.quote(sym);
    if (!q) return;
    const bidS = fmtPrice(q.bid, inst.digits);
    const askS = fmtPrice(q.ask, inst.digits);
    if (bidS !== lastBid) {
      bidEl.innerHTML = priceHtml(q.bid, inst.digits);
      lastBid = bidS;
    }
    if (askS !== lastAsk) {
      askEl.innerHTML = priceHtml(q.ask, inst.digits);
      lastAsk = askS;
    }
    setText(spreadEl, q.spread.toFixed(1));
    spreadEl.classList.toggle('neg', q.spread > inst.spread * 2);

    const m = app.engine.metrics();
    const g = app.engine.state.guard;
    const warns: string[] = [];
    const bad: string[] = [];
    const o = intent('buy');
    const sized = sizeOrder(app.engine, app.market, o);
    const stop = o.slPips || o.trailPips || null;

    // Pending order validity per side
    if (t.type !== 'market') {
      const px = Number(priceIn.value);
      const valid = Number.isFinite(px) && px > 0;
      const buyOk = valid && (t.type === 'limit' ? px < q.ask : px > q.ask);
      const sellOk = valid && (t.type === 'limit' ? px > q.bid : px < q.bid);
      buyBtn.disabled = !buyOk;
      sellBtn.disabled = !sellOk;
      buyBtn.title = buyOk ? '' : `A buy ${t.type} must be ${t.type === 'limit' ? 'below' : 'above'} the ask`;
      sellBtn.title = sellOk ? '' : `A sell ${t.type} must be ${t.type === 'limit' ? 'above' : 'below'} the bid`;
      if (!valid) bad.push('Enter an entry price for the pending order');
    } else {
      buyBtn.disabled = false;
      sellBtn.disabled = false;
      buyBtn.title = '';
      sellBtn.title = '';
    }

    if (!sized.ok) {
      bad.push(sized.error);
      for (const k of ['size', 'units', 'pip', 'margin', 'risk', 'reward', 'rr', 'comm']) setText(rows[k], '—');
    } else {
      const entry = t.type === 'market' ? q.ask : Number(priceIn.value) || q.ask;
      const pv = previewTrade({
        inst,
        side: 'buy',
        units: sized.units,
        entry,
        slPips: stop,
        tpPips: o.tpPips ?? null,
        equity: m.equity,
        leverage: app.engine.state.settings.leverage,
        commissionPerLotSide: app.engine.state.settings.commissionPerLot,
        mid: app.market.mid,
      });
      setText(rows.size, `${fmtLots(sized.lots)} lots`);
      setText(rows.units, integer(sized.units));
      setText(rows.pip, money(pv.pipValue));
      setText(rows.margin, money(pv.margin));
      setText(rows.comm, money(pv.commission));
      setText(rows.risk, pv.riskUsd === null ? 'no stop' : `${money(pv.riskUsd)} · ${pv.riskPct!.toFixed(2)}%`);
      rows.risk.className = pv.riskPct !== null && g.enabled && pv.riskPct > g.maxRiskPct ? 'neg' : '';
      setText(rows.reward, pv.rewardUsd === null ? 'no target' : money(pv.rewardUsd));
      setText(rows.rr, pv.rr === null ? '—' : `${pv.rr.toFixed(2)} : 1`);
      rows.rr.className = pv.rr === null ? '' : pv.rr >= 1.5 ? 'pos' : pv.rr < 1 ? 'neg' : '';
      if (pv.margin > m.freeMargin) bad.push(`Margin ${money(pv.margin)} exceeds free margin ${money(m.freeMargin)}`);
      if (g.enabled && pv.riskPct !== null && pv.riskPct > g.maxRiskPct + 1e-9) {
        bad.push(`Risk ${pv.riskPct.toFixed(2)}% is above the guard limit of ${g.maxRiskPct}%`);
      }
      if (pv.rr !== null && pv.rr < 1) warns.push('The target is closer than the stop (reward : risk below 1)');
    }
    const fmtStops = (side: 'buy' | 'sell') => {
      const e = t.type === 'market' ? (side === 'buy' ? q.ask : q.bid) : Number(priceIn.value);
      if (!Number.isFinite(e) || e <= 0) return '—';
      const dir = side === 'buy' ? 1 : -1;
      const sl = stop ? fmtPrice(roundPrice(e - dir * stop * inst.pip, inst.digits), inst.digits) : '—';
      const tp = o.tpPips ? fmtPrice(roundPrice(e + dir * o.tpPips * inst.pip, inst.digits), inst.digits) : '—';
      return `SL ${sl} · TP ${tp}`;
    };
    setText(rows.buy, fmtStops('buy'));
    setText(rows.sell, fmtStops('sell'));
    if (g.enabled && g.requireStopLoss && !stop) bad.push('Risk guard requires a stop loss or trailing stop');
    if (g.enabled && app.engine.state.day.locked) bad.push(`Trading locked: ${app.engine.state.day.lockReason}`);
    if (!app.market.isOpen() && t.type === 'market') bad.push('Market closed for the weekend. Pending orders can still be placed');
    if (q.spread > inst.spread * 2) warns.push(`Spread is wide right now (${q.spread.toFixed(1)} pips)`);
    const html = [...bad.map((b) => `<div class="bad">✕ ${escapeHtml(b)}</div>`), ...warns.map((w) => `<div>! ${escapeHtml(w)}</div>`)].join('');
    if (warnEl.innerHTML !== html) warnEl.innerHTML = html;
  }

  syncInputs();
  return {
    tick,
    refresh: () => {
      syncInputs();
      if (t.type !== 'market') fillPrice();
      lastBid = '';
      lastAsk = '';
      cancelConfirm();
      tick();
    },
    trigger,
    cancelConfirm,
    confirmPending,
  };
}
