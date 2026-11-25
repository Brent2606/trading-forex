import { TIMEFRAMES, type Timeframe } from './candles';
import { normalizeSymbol } from './instruments';

export type CloseTarget = 'all' | 'winners' | 'losers' | { id: number } | { symbol: string };

export type Command =
  | {
      kind: 'order';
      side: 'buy' | 'sell';
      type: 'market' | 'limit' | 'stop';
      symbol?: string;
      lots?: number;
      riskPct?: number;
      price?: number;
      slPips?: number;
      tpPips?: number;
      trailPips?: number;
    }
  | { kind: 'close'; target: CloseTarget }
  | { kind: 'breakeven'; target: 'all' | { id: number } }
  | { kind: 'cancel'; target: 'all' | { id: number } }
  | { kind: 'reverse'; id: number }
  | { kind: 'chart'; symbol?: string; tf?: Timeframe }
  | { kind: 'alert'; symbol?: string; cond?: 'above' | 'below'; price: number }
  | { kind: 'risk'; pct: number }
  | { kind: 'reset'; confirmed: boolean; balance?: number }
  | { kind: 'auto'; on?: boolean }
  | { kind: 'lab'; on?: boolean }
  | { kind: 'help' }
  | { kind: 'clear' }
  | { kind: 'error'; message: string };

export const HELP_LINES: readonly string[] = [
  'buy eurusd 0.5 sl 20 tp 40      market buy 0.5 lots, stop 20 pips, target 40',
  'sell gbpjpy 1% sl 30 tp 60       size from risk: 1% of equity at the stop',
  'buy limit eurusd 0.2 @1.0800 sl 15   pending limit (also: buy stop, sell limit, sell stop)',
  'buy eurusd trail 15              trailing stop of 15 pips',
  'buy                              uses the ticket pair, size and stops',
  'close all | winners | losers | 1004 | eurusd',
  'be 1004 | be all                 move stop to break-even',
  'rev 1004                         reverse a position',
  'cancel 1007 | cancel all         cancel pending orders',
  'chart gbpusd h4 | eurjpy | m15   switch chart pair / timeframe',
  'alert eurusd > 1.0850            price alert (> or <, or omit to auto-detect)',
  'risk 1.5                         set ticket risk to 1.5% of equity',
  'reset confirm | reset 25000 confirm   reset the paper account',
  'auto on | auto off | auto        autopilot: trade the lab\'s strategies automatically',
  'lab on | lab off | lab           strategy lab: search for better strategies non-stop',
  'clear | help',
];

const NUM = /^(\d+\.?\d*|\.\d+)$/;

function num(tok: string | undefined): number | undefined {
  if (tok === undefined) return undefined;
  const t = tok.replace(/(pips?|p)$/, '');
  return NUM.test(t) ? Number(t) : undefined;
}

function tfOf(tok: string): Timeframe | undefined {
  const u = tok.toUpperCase();
  return (TIMEFRAMES as readonly string[]).includes(u) ? (u as Timeframe) : undefined;
}

const err = (message: string): Command => ({ kind: 'error', message });

export function parseCommand(input: string): Command {
  const tokens = input
    .toLowerCase()
    .replace(/=/g, ' ')
    .replace(/@/g, ' @ ')
    .replace(/([<>])/g, ' $1 ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return err('Type "help" for commands');
  const head = tokens.shift()!;

  const om = head.match(/^(buy|sell|long|short)[-_]?(limit|stop|market|mkt)?$/);
  if (om) return parseOrder(om[1] === 'buy' || om[1] === 'long' ? 'buy' : 'sell', om[2], tokens);

  switch (head) {
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'clear':
    case 'cls':
      return { kind: 'clear' };
    case 'flatten':
      return { kind: 'close', target: 'all' };
    case 'close':
    case 'x': {
      const a = tokens[0];
      if (!a) return err('close what? e.g. "close all", "close 1004", "close eurusd"');
      if (a === 'all') return { kind: 'close', target: 'all' };
      if (a === 'winners' || a === 'profit' || a === 'profits') return { kind: 'close', target: 'winners' };
      if (a === 'losers' || a === 'loss' || a === 'losses') return { kind: 'close', target: 'losers' };
      const id = a.replace(/^#/, '');
      if (/^\d+$/.test(id)) return { kind: 'close', target: { id: Number(id) } };
      const sym = normalizeSymbol(a);
      if (sym) return { kind: 'close', target: { symbol: sym } };
      return err(`Unknown close target "${a}"`);
    }
    case 'be':
    case 'breakeven': {
      const a = tokens[0]?.replace(/^#/, '');
      if (a === 'all') return { kind: 'breakeven', target: 'all' };
      if (a && /^\d+$/.test(a)) return { kind: 'breakeven', target: { id: Number(a) } };
      return err('be <position id> or be all');
    }
    case 'cancel': {
      const a = tokens[0]?.replace(/^#/, '');
      if (a === 'all') return { kind: 'cancel', target: 'all' };
      if (a && /^\d+$/.test(a)) return { kind: 'cancel', target: { id: Number(a) } };
      return err('cancel <order id> or cancel all');
    }
    case 'rev':
    case 'reverse': {
      const a = tokens[0]?.replace(/^#/, '');
      if (a && /^\d+$/.test(a)) return { kind: 'reverse', id: Number(a) };
      return err('rev <position id>');
    }
    case 'chart':
    case 'tf':
    case 'c': {
      let symbol: string | undefined;
      let tf: Timeframe | undefined;
      for (const t of tokens) {
        const s = normalizeSymbol(t);
        const f = tfOf(t);
        if (s) symbol = s;
        else if (f) tf = f;
        else return err(`"${t}" is not a pair or timeframe (M1 M5 M15 H1 H4 D1)`);
      }
      if (!symbol && !tf) return err('chart <pair> [timeframe], e.g. "chart gbpusd h4"');
      return { kind: 'chart', symbol, tf };
    }
    case 'alert': {
      let symbol: string | undefined;
      let cond: 'above' | 'below' | undefined;
      let price: number | undefined;
      for (const t of tokens) {
        const s = normalizeSymbol(t);
        if (s) symbol = s;
        else if (t === '>' || t === 'above' || t === '>=') cond = 'above';
        else if (t === '<' || t === 'below' || t === '<=') cond = 'below';
        else if (num(t) !== undefined) price = num(t);
        else return err(`Unexpected "${t}" in alert`);
      }
      if (price === undefined || price <= 0) return err('alert <pair> > <price>, e.g. "alert eurusd > 1.0850"');
      return { kind: 'alert', symbol, cond, price };
    }
    case 'risk': {
      const v = num(tokens[0]?.replace('%', ''));
      if (v === undefined || v <= 0 || v > 100) return err('risk <percent>, e.g. "risk 1"');
      return { kind: 'risk', pct: v };
    }
    case 'auto':
    case 'autopilot':
    case 'lab': {
      const a = tokens[0];
      const on = a === 'on' || a === 'start' ? true : a === 'off' || a === 'stop' ? false : undefined;
      if (a !== undefined && on === undefined) return err(`${head} on | off`);
      return head === 'lab' ? { kind: 'lab', on } : { kind: 'auto', on };
    }
    case 'reset': {
      let balance: number | undefined;
      let confirmed = false;
      for (const t of tokens) {
        if (t === 'confirm' || t === 'yes') confirmed = true;
        else if (num(t.replace(/[$,]/g, '')) !== undefined) balance = num(t.replace(/[$,]/g, ''));
        else return err(`Unexpected "${t}" in reset`);
      }
      if (balance !== undefined && (balance < 100 || balance > 100_000_000)) {
        return err('Starting balance must be between 100 and 100,000,000');
      }
      return { kind: 'reset', confirmed, balance };
    }
  }

  // Bare pair and/or timeframe: "eurusd", "h4", "gbpjpy m15"
  const all = [head, ...tokens];
  if (all.every((t) => normalizeSymbol(t) || tfOf(t))) {
    const symbol = all.map((t) => normalizeSymbol(t)).find(Boolean);
    const tf = all.map(tfOf).find(Boolean);
    return { kind: 'chart', symbol, tf };
  }
  return err(`Unknown command "${head}". Type "help"`);
}

function parseOrder(side: 'buy' | 'sell', typeRaw: string | undefined, tokens: string[]): Command {
  let type: 'market' | 'limit' | 'stop' | undefined =
    typeRaw === 'limit' ? 'limit' : typeRaw === 'stop' ? 'stop' : typeRaw ? 'market' : undefined;
  if (!type && (tokens[0] === 'limit' || tokens[0] === 'stop' || tokens[0] === 'market' || tokens[0] === 'mkt')) {
    const t = tokens.shift()!;
    type = t === 'limit' ? 'limit' : t === 'stop' ? 'stop' : 'market';
  }
  type ??= 'market';
  const cmd: Extract<Command, { kind: 'order' }> = { kind: 'order', side, type };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const key = t === 'ts' || t === 'trailing' ? 'trail' : t;
    if (key === 'sl' || key === 'tp' || key === 'trail') {
      const v = num(tokens[++i]);
      if (v === undefined || v <= 0) return err(`${key} needs a positive number of pips, e.g. "${key} 20"`);
      if (key === 'sl') cmd.slPips = v;
      else if (key === 'tp') cmd.tpPips = v;
      else cmd.trailPips = v;
      continue;
    }
    if (t === '@' || t === 'at') {
      const v = num(tokens[++i]);
      if (v === undefined || v <= 0) return err('@ needs a price, e.g. "@1.0850"');
      cmd.price = v;
      continue;
    }
    const sym = normalizeSymbol(t);
    if (sym) {
      cmd.symbol = sym;
      continue;
    }
    if (t.endsWith('%')) {
      const v = num(t.slice(0, -1));
      if (v === undefined || v <= 0 || v > 100) return err('Risk must be between 0 and 100%');
      cmd.riskPct = v;
      continue;
    }
    const lots = num(t.replace(/(lots?|l)$/, ''));
    if (lots !== undefined) {
      if (lots <= 0) return err('Lots must be positive');
      cmd.lots = lots;
      continue;
    }
    return err(`Unexpected "${t}" in order`);
  }
  if (cmd.lots !== undefined && cmd.riskPct !== undefined) return err('Give either lots or risk %, not both');
  if (cmd.type !== 'market' && cmd.price === undefined) return err(`A ${side} ${cmd.type} needs a price, e.g. "@1.0850"`);
  if (cmd.type === 'market' && cmd.price !== undefined) {
    return err(`Market orders fill at the current price. Use "${side} limit" or "${side} stop" with @price`);
  }
  return cmd;
}
