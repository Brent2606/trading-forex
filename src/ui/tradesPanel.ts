/**
 * The "Trades" tab and the "Why this trade?" panel.
 *
 * Lists every trade on the account (open and closed, newest first, grouped by day). Selecting
 * one moves the chart to it, draws it (entry, exit, stop and target zone, the strategy's own
 * indicator) and explains in plain language why it was taken and how it ended.
 */
import type { ClosedTrade, CloseReason, Position } from '../core/account';
import { TF_MS } from '../core/candles';
import type { EntryWhy, SignalFact, TradeNote } from '../core/explain';
import { escapeHtml, hm, lots as fmtLots, money, moneySigned, pips as fmtPips, price as fmtPrice } from '../core/format';
import { SESSION_NAMES } from '../core/genome';
import { getLang } from '../core/i18n';
import { displaySymbol, getInstrument, unitsToLots } from '../core/instruments';
import type { ChartMarker, ChartStudy, TradeZone } from './chart';
import type { App } from './context';
import { $, setText } from './dom';

export interface NoteSource {
  get(positionId: number): TradeNote | undefined;
  /** probation / active / benched / retired, by deployment id. */
  status(dep: string): string | undefined;
}

export interface TradesPanel {
  /** Rebuilds the list (after a trade opened, closed or changed). */
  render(): void;
  /** Refreshes live values of open trades. */
  tick(): void;
  select(key: string | null): void;
  /** What the chart should draw for the pair and timeframe it shows now. */
  chart(): { zone: TradeZone | null; markers: ChartMarker[]; study: ChartStudy | null };
}

interface Row {
  key: string;
  positionId: number;
  symbol: string;
  side: 'buy' | 'sell';
  units: number;
  entry: number;
  openTime: number;
  closeTime: number | null;
  exit: number | null;
  net: number;
  pips: number;
  r: number | null;
  reason: CloseReason | null;
  sl: number | null;
  tp: number | null;
  risk: number | null;
}

/** English or Dutch, following the terminal's language switch. */
const L = (en: string, nl: string) => (getLang() === 'nl' ? nl : en);
const cls = (v: number) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const n1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');

/** "43 minutes", "8 hours 26 min", "2 days 3 hours": a duration in everyday words. */
function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} ${m === 1 ? L('minute', 'minuut') : L('minutes', 'minuten')}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ${h === 1 ? L('hour', 'uur') : L('hours', 'uur')}${m % 60 ? ` ${m % 60} min` : ''}`;
  const d = Math.floor(h / 24);
  return `${d} ${L('days', 'dagen')}${h % 24 ? ` ${h % 24} ${L('hours', 'uur')}` : ''}`;
}

const SESSIONS_NL = ['Azië', 'Londen', 'Londen + New York', 'New York', 'late avond'];
const sessionName = (i: number) => (getLang() === 'nl' ? SESSIONS_NL[i] : SESSION_NAMES[i]) ?? '—';

/** Short everyday name of a strategy type. */
export function strategyName(id: string | null): string {
  switch (id) {
    case 'rsi-revert':
      return L('Rebound after a sharp move (RSI)', 'Terugveer na een harde beweging (RSI)');
    case 'ema-cross':
      return L('Trend following (average crossover)', 'Trend volgen (kruising van gemiddelden)');
    case 'bb-breakout':
      return L('Breakout (Bollinger Bands)', 'Uitbraak (Bollinger Bands)');
    case 'macd-cross':
      return L('Momentum turn (MACD)', 'Omslag in momentum (MACD)');
    case 'donchian':
      return L('Breakout of a new high or low', 'Uitbraak naar een nieuwe top of bodem');
    case null:
      return L('Manual (placed by you)', 'Handmatig (door jou geplaatst)');
    default:
      return L('Strategy from the lab', 'Strategie uit het lab');
  }
}

function strategyIdea(id: string): string {
  switch (id) {
    case 'rsi-revert':
      return L(
        'After an unusually sharp fall prices often bounce back a little, and after a sharp rise they often dip. This strategy waits until such a move runs out of steam and then trades the bounce.',
        'Na een ongewoon harde daling veert de koers vaak een stukje terug, en na een harde stijging zakt hij vaak iets in. Deze strategie wacht tot zo’n beweging uitgewerkt lijkt en speelt dan in op de terugveer.',
      );
    case 'ema-cross':
      return L(
        'Compares a fast and a slow moving average of the price. When the fast one crosses the slow one, a new trend may be starting, and the strategy follows it.',
        'Vergelijkt een snel en een langzaam gemiddelde van de koers. Kruist het snelle het langzame, dan kan er een nieuwe trend beginnen en gaat de strategie mee.',
      );
    case 'bb-breakout':
      return L(
        'The Bollinger Bands mark the normal range of the price. A close outside the bands is a breakout, and the strategy trades in its direction.',
        'De Bollinger Bands geven het normale bereik van de koers aan. Sluit de koers erbuiten, dan is dat een uitbraak en handelt de strategie in die richting.',
      );
    case 'macd-cross':
      return L(
        'The MACD measures momentum: whether the price is speeding up or slowing down. When it crosses its signal line, momentum is turning, and the strategy follows.',
        'De MACD meet het momentum: versnelt of vertraagt de koers. Kruist hij zijn signaallijn, dan slaat het momentum om en gaat de strategie mee.',
      );
    case 'donchian':
      return L(
        'Watches the highest and lowest price of the last bars. A close above that high (or below that low) is a breakout, and the strategy trades in its direction.',
        'Kijkt naar de hoogste en laagste koers van de laatste kaarsen. Sluit de koers boven die top (of onder die bodem), dan is dat een uitbraak en handelt de strategie in die richting.',
      );
    default:
      return L('A rule set found and tested by the strategy lab.', 'Een set regels die het strategielab heeft gevonden en getest.');
  }
}

const STATUS = (s: string | undefined): [string, string] => {
  switch (s) {
    case 'active':
      return [L('Active', 'Actief'), 'active'];
    case 'probation':
      return [L('On probation', 'Op proef'), 'probation'];
    case 'benched':
      return [L('Paused', 'Gepauzeerd'), 'benched'];
    case 'retired':
      return [L('Replaced', 'Vervangen'), 'expired'];
    default:
      return ['', ''];
  }
};

function reasonText(r: CloseReason | null): string {
  switch (r) {
    case null:
      return L('Running', 'Loopt nog');
    case 'tp':
      return L('Target hit', 'Winstdoel geraakt');
    case 'sl':
      return L('Stop loss hit', 'Stop-loss geraakt');
    case 'trail':
      return L('Trailing stop hit', 'Meeschuivende stop geraakt');
    case 'signal':
      return L('Signal reversed', 'Signaal draaide om');
    case 'manual':
      return L('Closed by hand', 'Handmatig gesloten');
    case 'guard':
      return L('Closed by the risk guard', 'Gesloten door de risk guard');
    case 'stopout':
      return L('Stop-out (margin)', 'Stop-out (marge)');
    case 'reverse':
      return L('Reversed', 'Omgedraaid');
  }
}

function dayLabel(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return L('Today', 'Vandaag');
  if (d.toDateString() === y.toDateString()) return L('Yesterday', 'Gisteren');
  const s = d.toLocaleDateString(getLang() === 'nl' ? 'nl-NL' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function when(t: number): string {
  const d = new Date(t);
  if (d.toDateString() === new Date().toDateString()) return `${L('today', 'vandaag')} ${hm(t)}`;
  return `${d.toLocaleDateString(getLang() === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'short' })} ${hm(t)}`;
}

/** The strategy's own reading in two steps: what built up, and what triggered the entry. */
function signalSteps(w: EntryWhy, digits: number): string[] {
  const f: SignalFact = w.signal;
  const buy = w.side === 'buy';
  const px = (v: number) => fmtPrice(v, digits);
  const bar = `${hm(w.barTime)}–${hm(w.barTime + TF_MS[w.tf])}`;
  switch (f.k) {
    case 'rsi-revert':
      return buy
        ? [
            L(
              `The RSI (${f.period}) measures on a scale of 0–100 how hard the price has fallen or risen. It had dropped to <b>${n1(f.prev)}</b>, below the line of <b>${f.lower}</b>: the price had fallen hard ("oversold").`,
              `De RSI (${f.period}) meet op een schaal van 0–100 hoe hard de koers is gedaald of gestegen. Hij was gezakt tot <b>${n1(f.prev)}</b>, onder de grens van <b>${f.lower}</b>: de koers was hard gedaald ("oververkocht").`,
            ),
            L(
              `When the candle of ${bar} closed, the RSI had climbed back to <b>${n1(f.now)}</b>, above ${f.lower} again. That is the buy signal: the fall seems to be over and the strategy counts on a bounce.`,
              `Toen de kaars van ${bar} sloot, was de RSI teruggeklommen naar <b>${n1(f.now)}</b>, weer boven ${f.lower}. Dat is het koopsignaal: de daling lijkt uitgewerkt en de strategie rekent op een terugveer.`,
            ),
          ]
        : [
            L(
              `The RSI (${f.period}) measures on a scale of 0–100 how hard the price has fallen or risen. It had risen to <b>${n1(f.prev)}</b>, above the line of <b>${f.upper}</b>: the price had risen hard ("overbought").`,
              `De RSI (${f.period}) meet op een schaal van 0–100 hoe hard de koers is gedaald of gestegen. Hij was opgelopen tot <b>${n1(f.prev)}</b>, boven de grens van <b>${f.upper}</b>: de koers was hard gestegen ("overgekocht").`,
            ),
            L(
              `When the candle of ${bar} closed, the RSI had dropped back to <b>${n1(f.now)}</b>, below ${f.upper} again. That is the sell signal: the rise seems to be over and the strategy counts on a dip.`,
              `Toen de kaars van ${bar} sloot, was de RSI teruggezakt naar <b>${n1(f.now)}</b>, weer onder ${f.upper}. Dat is het verkoopsignaal: de stijging lijkt uitgewerkt en de strategie rekent op een terugval.`,
            ),
          ];
    case 'ema-cross':
      return [
        L(
          `Before the signal the fast average (EMA ${f.fast}: ${px(f.fastPrev)}) was ${buy ? 'below' : 'above'} the slow one (EMA ${f.slow}: ${px(f.slowPrev)}).`,
          `Vóór het signaal lag het snelle gemiddelde (EMA ${f.fast}: ${px(f.fastPrev)}) ${buy ? 'onder' : 'boven'} het langzame (EMA ${f.slow}: ${px(f.slowPrev)}).`,
        ),
        L(
          `When the candle of ${bar} closed, the fast average (<b>${px(f.fastNow)}</b>) had crossed ${buy ? 'above' : 'below'} the slow one (<b>${px(f.slowNow)}</b>). That is the ${buy ? 'buy' : 'sell'} signal: a ${buy ? 'rising' : 'falling'} trend may be starting.`,
          `Toen de kaars van ${bar} sloot, was het snelle gemiddelde (<b>${px(f.fastNow)}</b>) ${buy ? 'boven' : 'onder'} het langzame (<b>${px(f.slowNow)}</b>) gekruist. Dat is het ${buy ? 'koop' : 'verkoop'}signaal: er kan een ${buy ? 'stijgende' : 'dalende'} trend beginnen.`,
        ),
      ];
    case 'bb-breakout':
      return [
        L(
          `The Bollinger Bands (period ${f.period}, width ${f.mult}×) marked the normal range of the price: from ${px(f.lower)} to ${px(f.upper)}. The candle before still closed inside it (${px(f.prevClose)}).`,
          `De Bollinger Bands (periode ${f.period}, breedte ${f.mult}×) gaven het normale bereik van de koers aan: van ${px(f.lower)} tot ${px(f.upper)}. De kaars ervoor sloot daar nog binnen (${px(f.prevClose)}).`,
        ),
        L(
          `The candle of ${bar} closed at <b>${px(w.close)}</b>, ${buy ? `above the upper band (${px(f.upper)})` : `below the lower band (${px(f.lower)})`}. That is a breakout, and the strategy goes ${buy ? 'up' : 'down'} with it.`,
          `De kaars van ${bar} sloot op <b>${px(w.close)}</b>, ${buy ? `boven de bovenste band (${px(f.upper)})` : `onder de onderste band (${px(f.lower)})`}. Dat is een uitbraak, en de strategie gaat mee ${buy ? 'omhoog' : 'omlaag'}.`,
        ),
      ];
    case 'macd-cross':
      return [
        L(
          `The MACD (${f.fast}, ${f.slow}, ${f.signal}) measures momentum. Before the signal the MACD line was ${buy ? 'below' : 'above'} its signal line.`,
          `De MACD (${f.fast}, ${f.slow}, ${f.signal}) meet het momentum. Vóór het signaal lag de MACD-lijn ${buy ? 'onder' : 'boven'} zijn signaallijn.`,
        ),
        L(
          `When the candle of ${bar} closed, the MACD line had crossed ${buy ? 'above' : 'below'} the signal line. That is the ${buy ? 'buy' : 'sell'} signal: momentum is turning ${buy ? 'up' : 'down'}.`,
          `Toen de kaars van ${bar} sloot, was de MACD-lijn ${buy ? 'boven' : 'onder'} de signaallijn gekruist. Dat is het ${buy ? 'koop' : 'verkoop'}signaal: het momentum draait ${buy ? 'omhoog' : 'omlaag'}.`,
        ),
      ];
    case 'donchian':
      return [
        L(
          `Over the ${f.period} candles before, the highest price was ${px(f.high)} and the lowest ${px(f.low)}. The candle before still closed between them (${px(f.prevClose)}).`,
          `In de ${f.period} kaarsen ervoor was de hoogste koers ${px(f.high)} en de laagste ${px(f.low)}. De kaars ervoor sloot daar nog tussen (${px(f.prevClose)}).`,
        ),
        L(
          `The candle of ${bar} closed at <b>${px(w.close)}</b>, ${buy ? `above that high (${px(f.high)})` : `below that low (${px(f.low)})`}. A new ${buy ? 'high' : 'low'} is a breakout, and the strategy goes ${buy ? 'up' : 'down'} with it.`,
          `De kaars van ${bar} sloot op <b>${px(w.close)}</b>, ${buy ? `boven die top (${px(f.high)})` : `onder die bodem (${px(f.low)})`}. Een nieuwe ${buy ? 'top' : 'bodem'} is een uitbraak, en de strategie gaat mee ${buy ? 'omhoog' : 'omlaag'}.`,
        ),
      ];
    default:
      return [L(`The strategy gave a ${buy ? 'buy' : 'sell'} signal when the candle of ${bar} closed.`, `De strategie gaf een ${buy ? 'koop' : 'verkoop'}signaal toen de kaars van ${bar} sloot.`)];
  }
}

/** The extra conditions the strategy checked before entering. */
function conditions(w: EntryWhy, digits: number): string[] {
  const out: string[] = [];
  const buy = w.side === 'buy';
  if (w.trend) {
    out.push(
      L(
        `<b>With the trend.</b> The price (${fmtPrice(w.close, digits)}) was ${buy ? 'above' : 'below'} its average of the last ${w.trend.period} hours (${fmtPrice(w.trend.ema, digits)}), so the trade goes with the larger trend.`,
        `<b>Met de trend mee.</b> De koers (${fmtPrice(w.close, digits)}) lag ${buy ? 'boven' : 'onder'} zijn gemiddelde van de laatste ${w.trend.period} uur (${fmtPrice(w.trend.ema, digits)}), dus de trade gaat met de grotere trend mee.`,
      ),
    );
  }
  const allowed = SESSION_NAMES.map((_, i) => i).filter((i) => w.sessions & (1 << i));
  if (allowed.length < SESSION_NAMES.length) {
    out.push(
      L(
        `<b>Right time of day.</b> The signal came during the ${sessionName(w.session)} session. This strategy only trades during: ${allowed.map(sessionName).join(', ')}.`,
        `<b>Juiste moment van de dag.</b> Het signaal viel in de sessie ${sessionName(w.session)}. Deze strategie handelt alleen tijdens: ${allowed.map(sessionName).join(', ')}.`,
      ),
    );
  }
  const vol = [L('calm', 'rustig'), L('normal', 'normaal'), L('very lively', 'erg beweeglijk')][w.vol] ?? '';
  if (w.volRule === 1) {
    out.push(
      L(
        `<b>Market not too wild.</b> The market was ${vol}. This strategy skips very lively markets.`,
        `<b>Markt niet te wild.</b> De markt was ${vol}. Deze strategie slaat erg beweeglijke markten over.`,
      ),
    );
  } else if (w.volRule === 2) {
    out.push(
      L(
        `<b>Enough movement.</b> The market was ${vol}. This strategy skips very calm markets.`,
        `<b>Genoeg beweging.</b> De markt was ${vol}. Deze strategie slaat hele rustige markten over.`,
      ),
    );
  }
  return out;
}

function studyFor(w: EntryWhy): ChartStudy {
  const f = w.signal;
  const s: ChartStudy = {};
  if (f.k === 'rsi-revert') s.rsi = { period: f.period, lower: f.lower, upper: f.upper };
  else if (f.k === 'ema-cross') s.emas = [f.fast, f.slow];
  else if (f.k === 'bb-breakout') s.bb = { period: f.period, mult: f.mult };
  else if (f.k === 'macd-cross') s.macd = { fast: f.fast, slow: f.slow, signal: f.signal };
  else if (f.k === 'donchian') s.channel = f.period;
  if (w.trend) s.trend = w.trend.period;
  return s;
}

/** What the coloured elements on the chart mean, for this strategy. */
function chartLegend(w: EntryWhy | null, closed: boolean): string[] {
  const out = [
    L('<i class="lg lg-in"></i> <b>IN</b>: where the trade started', '<i class="lg lg-in"></i> <b>IN</b>: hier begon de trade'),
    closed
      ? L('<i class="lg lg-out"></i> <b>OUT</b>: where the trade ended', '<i class="lg lg-out"></i> <b>UIT</b>: hier eindigde de trade')
      : '',
    L('<i class="lg lg-tp"></i> green area: from the entry to the target', '<i class="lg lg-tp"></i> groen vlak: van de instap tot het winstdoel'),
    L('<i class="lg lg-sl"></i> red area: from the entry to the stop loss', '<i class="lg lg-sl"></i> rood vlak: van de instap tot de stop-loss'),
  ];
  if (w) {
    out.push(L('<i class="lg lg-sig"></i> yellow bar: the candle that gave the signal', '<i class="lg lg-sig"></i> gele balk: de kaars die het signaal gaf'));
    const f = w.signal;
    if (f.k === 'rsi-revert')
      out.push(
        L(
          `Below the chart: the RSI (${f.period}) with the lines at ${f.lower} and ${f.upper}`,
          `Onder de grafiek: de RSI (${f.period}) met de grenzen op ${f.lower} en ${f.upper}`,
        ),
      );
    if (f.k === 'ema-cross') out.push(L(`Blue and yellow lines: the averages EMA ${f.fast} and EMA ${f.slow}`, `Blauwe en gele lijn: de gemiddelden EMA ${f.fast} en EMA ${f.slow}`));
    if (f.k === 'bb-breakout') out.push(L('Purple band: the Bollinger Bands', 'Paarse band: de Bollinger Bands'));
    if (f.k === 'macd-cross') out.push(L('Below the chart: the MACD line and its signal line', 'Onder de grafiek: de MACD-lijn en zijn signaallijn'));
    if (f.k === 'donchian') out.push(L(`Dashed blue lines: the high and low of the last ${f.period} candles`, `Blauwe stippellijnen: de top en bodem van de laatste ${f.period} kaarsen`));
    if (w.trend) out.push(L(`Purple line: the trend average (EMA ${w.trend.period})`, `Paarse lijn: het trendgemiddelde (EMA ${w.trend.period})`));
  }
  return out.filter(Boolean);
}

export function initTrades(app: App, notes: NoteSource): TradesPanel {
  const body = $('tr-body');
  const panel = $('explain');
  const exBody = $('explain-body');
  let selected: string | null = null;
  let rows: Row[] = [];
  let listSig = '';
  let explainSig = '';

  function build(): Row[] {
    const e = app.engine;
    const out: Row[] = [];
    for (const p of e.state.positions as readonly Position[]) {
      out.push({
        key: `p${p.id}`,
        positionId: p.id,
        symbol: p.symbol,
        side: p.side,
        units: p.units,
        entry: p.entry,
        openTime: p.openTime,
        closeTime: null,
        exit: null,
        net: e.floating(p),
        pips: e.floatingPips(p),
        r: null,
        reason: null,
        sl: p.sl,
        tp: p.tp,
        risk: p.initialRisk,
      });
    }
    for (const t of (e.state.history as readonly ClosedTrade[]).slice(-300)) {
      const note = notes.get(t.positionId);
      const inst = getInstrument(t.symbol);
      const dir = t.side === 'buy' ? 1 : -1;
      const level = (pips: number | null | undefined, sign: number) => (pips ? Math.round((t.entry + sign * dir * pips * inst.pip) * 10 ** inst.digits) / 10 ** inst.digits : null);
      out.push({
        key: `c${t.id}`,
        positionId: t.positionId,
        symbol: t.symbol,
        side: t.side,
        units: t.units,
        entry: t.entry,
        openTime: t.openTime,
        closeTime: t.closeTime,
        exit: t.exit,
        net: t.net,
        pips: t.pips,
        r: t.r,
        reason: t.reason,
        sl: level(note?.slPips, -1),
        tp: level(note?.tpPips, 1),
        risk: t.r !== null && Math.abs(t.r) > 0.001 ? Math.abs(t.net / t.r) : null,
      });
    }
    out.sort((a, b) => b.openTime - a.openTime);
    return out;
  }

  const sideHtml = (s: 'buy' | 'sell') => `<span class="side-${s}">${s === 'buy' ? L('BUY', 'KOOP') : L('SELL', 'VERKOOP')}</span>`;
  const statusHtml = (r: Row) =>
    r.reason === null
      ? `<span class="badge probation">${reasonText(null)}</span>`
      : `<span class="${r.net >= 0 ? 'pos' : 'neg'}">${r.net >= 0 ? '✓' : '✕'}</span> ${reasonText(r.reason)}`;

  function render(): void {
    rows = build();
    // A selected open trade that just closed: keep it selected as a closed trade.
    if (selected && !rows.some((r) => r.key === selected) && selected.startsWith('p')) {
      const id = Number(selected.slice(1));
      selected = rows.find((r) => r.positionId === id && r.closeTime !== null)?.key ?? null;
    }
    const today = rows.filter((r) => new Date(r.openTime).toDateString() === new Date().toDateString());
    setText($('cnt-tr'), String(today.length));
    $('tr-empty').hidden = rows.length > 0;
    const totalToday = today.reduce((a, r) => a + r.net, 0);
    $('tr-sum').innerHTML = rows.length
      ? `${L('Today', 'Vandaag')}: ${today.length} ${today.length === 1 ? 'trade' : 'trades'} · <span class="${cls(totalToday)}">${moneySigned(totalToday)}</span>`
      : '';
    setText($('tr-hint'), L('Click a trade to see it on the chart, with the reason it was taken.', 'Klik op een trade om hem op de grafiek te zien, met de reden waarom hij is genomen.'));
    const sig = rows.map((r) => `${r.key}:${r.closeTime ?? ''}`).join('|') + `|${selected}|${getLang()}|${new Date().toDateString()}`;
    if (sig !== listSig || app.prefs.tab === 'trades') {
      listSig = sig;
      let html = '';
      let day = '';
      for (const r of rows) {
        const d = new Date(r.openTime).toDateString();
        if (d !== day) {
          day = d;
          const same = rows.filter((x) => new Date(x.openTime).toDateString() === d);
          const sum = same.reduce((a, x) => a + x.net, 0);
          html += `<tr class="tr-day"><td colspan="7"><b>${dayLabel(r.openTime)}</b> · ${same.length} ${same.length === 1 ? 'trade' : 'trades'} · <span class="${cls(sum)}">${moneySigned(sum)}</span></td></tr>`;
        }
        const note = notes.get(r.positionId);
        html += `<tr data-k="${r.key}" class="${r.key === selected ? 'sel' : ''}" tabindex="0">
          <td>${hm(r.openTime)}</td>
          <td><b>${displaySymbol(r.symbol)}</b></td>
          <td>${sideHtml(r.side)}</td>
          <td class="tr-strat">${escapeHtml(strategyName(note ? note.strategy : null))}</td>
          <td class="dim" data-c="dur">${span((r.closeTime ?? Date.now()) - r.openTime)}</td>
          <td class="r ${cls(r.net)}" data-c="net">${moneySigned(r.net)}</td>
          <td>${statusHtml(r)}</td>
        </tr>`;
      }
      body.innerHTML = html;
    }
    renderExplain();
  }

  function tick(): void {
    if (!rows.some((r) => r.closeTime === null)) return;
    const e = app.engine;
    for (const r of rows) {
      if (r.closeTime !== null) continue;
      const p = e.state.positions.find((x) => x.id === r.positionId);
      if (!p) continue;
      r.net = e.floating(p);
      r.pips = e.floatingPips(p);
      r.sl = p.sl;
      r.tp = p.tp;
      const row = body.querySelector<HTMLElement>(`tr[data-k="${r.key}"]`);
      const cell = row?.querySelector<HTMLElement>('[data-c="net"]');
      if (cell) {
        setText(cell, moneySigned(r.net));
        cell.className = `r ${cls(r.net)}`;
      }
      const dcell = row?.querySelector<HTMLElement>('[data-c="dur"]');
      if (dcell) setText(dcell, span(Date.now() - r.openTime));
    }
    if (selected && rows.find((r) => r.key === selected)?.closeTime === null) renderExplain();
  }

  function renderExplain(): void {
    const r = rows.find((x) => x.key === selected);
    panel.hidden = !r;
    if (!r) {
      explainSig = '';
      return;
    }
    const inst = getInstrument(r.symbol);
    const px = (v: number) => fmtPrice(v, inst.digits);
    const note = notes.get(r.positionId);
    const w = note?.why ?? null;
    const buy = r.side === 'buy';
    const open = r.closeTime === null;
    const [stLabel, stCls] = STATUS(note ? notes.status(note.dep) : undefined);
    const dur = span((r.closeTime ?? Date.now()) - r.openTime);
    const slP = r.sl !== null ? Math.abs(r.entry - r.sl) / inst.pip : null;
    const tpP = r.tp !== null ? Math.abs(r.tp - r.entry) / inst.pip : null;

    const parts: string[] = [];
    let step = 0;
    const title = (en: string, nl: string) => `${++step} · ${L(en, nl)}`;
    parts.push(`<div class="ex-head">
      <div class="ex-title"><b>${displaySymbol(r.symbol)}</b> ${sideHtml(r.side)} <span class="dim">${fmtLots(unitsToLots(r.units))} lots</span></div>
      <div class="ex-result ${cls(r.net)}" id="ex-result">${moneySigned(r.net)}</div>
      <div class="ex-sub" id="ex-sub">${L('Opened', 'Geopend')} ${when(r.openTime)}${open ? ` · ${L('running for', 'loopt al')} ${dur}` : ` · ${L('closed', 'gesloten')} ${hm(r.closeTime!)} (${L('after', 'na')} ${dur})`}</div>
      <button type="button" class="btn ex-show" id="explain-show">${L('Show on the chart', 'Toon op de grafiek')}</button>
    </div>`);

    // 1. the strategy
    if (note) {
      parts.push(`<div class="ex-sec"><div class="mini-h">${title('The strategy', 'De strategie')}${stLabel ? ` <span class="badge ${stCls}">${stLabel}</span>` : ''}</div>
        <p><b>${escapeHtml(strategyName(note.strategy))}</b></p>
        <p>${strategyIdea(note.strategy)}</p>
        <p class="ex-tech" title="${L('Technical description', 'Technische omschrijving')}">${escapeHtml(note.desc)}</p></div>`);
    } else {
      parts.push(`<div class="ex-sec"><div class="mini-h">${title('Who placed it?', 'Wie plaatste hem?')}</div>
        <p>${L(
          'This trade was placed by hand (from the order ticket or the command line), not by a strategy of the bot. So there is no strategy explanation.',
          'Deze trade is met de hand geplaatst (via het orderticket of de commandoregel), niet door een strategie van de bot. Er is dus geen strategie-uitleg.',
        )}</p></div>`);
    }

    // 2. the signal
    if (w) {
      const steps = signalSteps(w, inst.digits);
      const conds = conditions(w, inst.digits);
      parts.push(`<div class="ex-sec"><div class="mini-h">${title('Why it entered', 'Waarom hij instapte')}</div>
        <ol class="ex-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
        ${conds.length ? `<ul class="ex-checks">${conds.map((c) => `<li>${c}</li>`).join('')}</ul>` : ''}
        <p>${L(
          `Right after that candle closed, the bot ${buy ? 'bought' : 'sold'} at <b>${px(r.entry)}</b>.`,
          `Direct na het sluiten van die kaars ${buy ? 'kocht' : 'verkocht'} de bot op <b>${px(r.entry)}</b>.`,
        )}</p></div>`);
    } else if (note) {
      parts.push(`<div class="ex-sec"><div class="mini-h">${title('Why it entered', 'Waarom hij instapte')}</div>
        <p>${L(
          'The strategy gave a signal on the hourly chart. The exact readings of that moment were not kept for this older trade.',
          'De strategie gaf een signaal op de uurgrafiek. De exacte meetwaarden van dat moment zijn voor deze oudere trade niet bewaard.',
        )}</p></div>`);
    }

    // 3. the plan
    const plan: string[] = [];
    if (r.sl !== null && slP !== null) {
      plan.push(
        L(
          `<b class="neg">Stop loss ${px(r.sl)}</b>: ${n1(slP)} pips ${buy ? 'below' : 'above'} the entry${w ? ` (${w.slAtr}× the average hourly move)` : ''}. If the price gets there, the trade closes at a loss so the loss stays small.`,
          `<b class="neg">Stop-loss ${px(r.sl)}</b>: ${n1(slP)} pips ${buy ? 'onder' : 'boven'} de instap${w ? ` (${w.slAtr}× de gemiddelde uurbeweging)` : ''}. Komt de koers daar, dan sluit de trade met verlies, zodat het verlies klein blijft.`,
        ),
      );
    }
    if (r.tp !== null && tpP !== null) {
      plan.push(
        L(
          `<b class="pos">Target ${px(r.tp)}</b>: ${n1(tpP)} pips ${buy ? 'above' : 'below'} the entry${w && w.tpAtr ? ` (${w.tpAtr}× the average hourly move)` : ''}. If the price gets there, the trade closes with a profit.`,
          `<b class="pos">Winstdoel ${px(r.tp)}</b>: ${n1(tpP)} pips ${buy ? 'boven' : 'onder'} de instap${w && w.tpAtr ? ` (${w.tpAtr}× de gemiddelde uurbeweging)` : ''}. Komt de koers daar, dan sluit de trade met winst.`,
        ),
      );
    } else if (note) {
      plan.push(L('<b>No fixed target</b>: the trade runs until the stop is hit or the signal reverses.', '<b>Geen vast winstdoel</b>: de trade loopt tot de stop wordt geraakt of het signaal omdraait.'));
    }
    if (w?.exitOnOpposite) plan.push(L('It also closes early if the strategy gives the opposite signal.', 'Hij sluit ook eerder als de strategie het omgekeerde signaal geeft.'));
    if (r.risk !== null && r.risk > 0) {
      plan.push(
        L(
          `<b>At risk: ${money(r.risk)}</b>${note?.riskPct ? ` (${note.riskPct}% of the account)` : ''}. That is the most this trade can lose if the stop is hit.`,
          `<b>Risico: ${money(r.risk)}</b>${note?.riskPct ? ` (${note.riskPct}% van de rekening)` : ''}. Dat is wat deze trade maximaal kost als de stop wordt geraakt.`,
        ),
      );
    }
    if (plan.length) parts.push(`<div class="ex-sec"><div class="mini-h">${title('The plan at entry', 'Het plan bij de instap')}</div><ul class="ex-plan">${plan.map((p) => `<li>${p}</li>`).join('')}</ul></div>`);

    // 4. the outcome
    let outcome: string;
    const rTxt = r.r !== null ? L(` That is ${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R: ${Math.abs(Math.round(r.r * 100))}% of the amount at risk.`, ` Dat is ${r.r >= 0 ? '+' : ''}${r.r.toFixed(2)}R: ${Math.abs(Math.round(r.r * 100))}% van het ingezette risico.`) : '';
    if (open) {
      outcome = L(
        `The trade is still running. Right now it stands at <b class="${cls(r.net)}">${moneySigned(r.net)}</b> (${fmtPips(r.pips)} pips). The bot watches the stop and the target by itself.`,
        `De trade loopt nog. De tussenstand is <b class="${cls(r.net)}">${moneySigned(r.net)}</b> (${fmtPips(r.pips)} pips). De bot bewaakt de stop en het winstdoel vanzelf.`,
      );
    } else {
      const res = `<b class="${cls(r.net)}">${moneySigned(r.net)}</b> (${fmtPips(r.pips)} pips)`;
      const at = px(r.exit!);
      switch (r.reason) {
        case 'tp':
          outcome = L(`After ${dur} the price reached the target and the trade closed at ${at}: ${res}.${rTxt}`, `Na ${dur} bereikte de koers het winstdoel en sloot de trade op ${at}: ${res}.${rTxt}`);
          break;
        case 'sl':
          outcome = L(
            `After ${dur} the price hit the stop loss and the trade closed at ${at}: ${res}.${rTxt} Losses like this are part of it: no strategy wins every time, which is why every trade has a stop.`,
            `Na ${dur} raakte de koers de stop-loss en sloot de trade op ${at}: ${res}.${rTxt} Zulke verliezen horen erbij: geen strategie wint altijd, daarom heeft elke trade een stop.`,
          );
          break;
        case 'trail':
          outcome = L(`After ${dur} the trailing stop was hit and the trade closed at ${at}: ${res}.${rTxt}`, `Na ${dur} werd de meeschuivende stop geraakt en sloot de trade op ${at}: ${res}.${rTxt}`);
          break;
        case 'signal':
          outcome = L(`After ${dur} the strategy gave the opposite signal and closed the trade at ${at}: ${res}.${rTxt}`, `Na ${dur} gaf de strategie het omgekeerde signaal en sloot hij de trade op ${at}: ${res}.${rTxt}`);
          break;
        case 'manual':
          outcome = L(`After ${dur} the trade was closed by hand at ${at}: ${res}.`, `Na ${dur} is de trade met de hand gesloten op ${at}: ${res}.`);
          break;
        default:
          outcome = L(`After ${dur} the trade closed at ${at} (${reasonText(r.reason).toLowerCase()}): ${res}.`, `Na ${dur} sloot de trade op ${at} (${reasonText(r.reason).toLowerCase()}): ${res}.`);
      }
    }
    parts.push(`<div class="ex-sec"><div class="mini-h">${open ? title('Where it stands now', 'Hoe het er nu voor staat') : title('How it went', 'Hoe het afliep')}</div><p id="ex-outcome">${outcome}</p></div>`);

    // 5. reading the chart
    parts.push(`<div class="ex-sec"><div class="mini-h">${L('On the chart', 'Op de grafiek')}</div><ul class="ex-legend">${chartLegend(w, !open).map((x) => `<li>${x}</li>`).join('')}</ul></div>`);

    const html = parts.join('');
    // An open trade changes every tick: update only the live numbers then, so buttons and
    // text selection inside the panel survive.
    const stat = `${r.key}|${getLang()}|${r.sl}|${r.tp}|${note ? note.dep : ''}|${stLabel}|${!!w}`;
    if (stat === explainSig && open) {
      const live = document.createElement('div');
      live.innerHTML = html;
      for (const id of ['ex-result', 'ex-sub', 'ex-outcome']) {
        const from = live.querySelector(`#${id}`);
        const to = exBody.querySelector(`#${id}`);
        if (from && to && to.innerHTML !== from.innerHTML) {
          to.innerHTML = from.innerHTML;
          to.className = from.className;
        }
      }
      return;
    }
    explainSig = stat;
    if (exBody.innerHTML !== html) exBody.innerHTML = html;
  }

  function showOnChart(r: Row): void {
    const note = notes.get(r.positionId);
    app.select(r.symbol, note?.why?.tf ?? 'H1');
    // Let the chart take the new data before moving it.
    requestAnimationFrame(() => app.chart.focus(r.openTime, r.closeTime ?? Date.now()));
  }

  function select(key: string | null): void {
    const was = selected;
    selected = key && rows.some((r) => r.key === key) ? key : null;
    for (const tr of body.querySelectorAll<HTMLElement>('tr[data-k]')) tr.classList.toggle('sel', tr.dataset.k === selected);
    listSig = '';
    renderExplain();
    const r = rows.find((x) => x.key === selected);
    if (r) {
      showOnChart(r);
      panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (was) app.chart.goLive();
  }

  body.addEventListener('click', (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>('tr[data-k]')?.dataset.k;
    if (k) select(k === selected ? null : k);
  });
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const k = (e.target as HTMLElement).closest<HTMLElement>('tr[data-k]')?.dataset.k;
    if (k) {
      e.preventDefault();
      select(k);
    }
  });
  $('explain-close').addEventListener('click', () => select(null));
  exBody.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#explain-show')) return;
    const r = rows.find((x) => x.key === selected);
    if (r) showOnChart(r);
  });

  function chart(): { zone: TradeZone | null; markers: ChartMarker[]; study: ChartStudy | null } {
    if (app.chartSource !== 'live') return { zone: null, markers: [], study: null };
    const sym = app.prefs.symbol;
    const th = getComputedStyle(document.documentElement);
    const c = (n: string, fb: string) => th.getPropertyValue(n).trim() || fb;
    const up = c('--up', '#00f0b5');
    const down = c('--down', '#ff2f7d');
    const warn = c('--warn', '#ffc23d');
    const dim = c('--dim', '#8f88bf');
    const sel = rows.find((r) => r.key === selected);
    const markers: ChartMarker[] = [];
    for (const r of rows) {
      if (r.symbol !== sym) continue;
      const isSel = r === sel;
      const buy = r.side === 'buy';
      markers.push({ t: r.openTime, price: r.entry, dir: buy ? 'up' : 'down', color: buy ? up : down, ...(isSel ? { label: 'IN' } : {}) });
      if (r.closeTime !== null && r.exit !== null) {
        markers.push({
          t: r.closeTime,
          price: r.exit,
          dir: buy ? 'down' : 'up',
          color: r.net >= 0 ? warn : dim,
          ...(isSel ? { label: `${L('OUT', 'UIT')} ${moneySigned(r.net)}` } : {}),
        });
      }
    }
    if (!sel || sel.symbol !== sym) return { zone: null, markers, study: null };
    const w = notes.get(sel.positionId)?.why ?? null;
    const sameTf = !!w && w.tf === app.prefs.tf;
    return {
      zone: {
        t0: sel.openTime,
        t1: sel.closeTime,
        entry: sel.entry,
        exit: sel.exit,
        sl: sel.sl,
        tp: sel.tp,
        signalT: sameTf ? w!.barTime : null,
        // An open position already has its own labelled price lines.
        labels: sel.closeTime === null ? null : { entry: L('ENTRY', 'INSTAP'), sl: L('STOP', 'STOP'), tp: L('TARGET', 'DOEL') },
      },
      markers,
      study: sameTf ? studyFor(w!) : null,
    };
  }

  return { render, tick, select, chart };
}
