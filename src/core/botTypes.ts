import type { AccountState, GuardSettings, OrderRequest } from './account';
import type { TradeNote } from './explain';
import type { Quote } from './rates';

/** A candle as a compact array: [time, open, high, low, close, volume]. */
export type CandleRow = [number, number, number, number, number, number];

/** GET /api/market: everything the terminal needs to draw the bot's market once at start-up. */
export interface MarketDump {
  time: number;
  label: string;
  real: boolean;
  open: boolean;
  quotes: Quote[];
  /** Hourly and minute history per pair; the terminal aggregates the other timeframes. */
  candles: Record<string, { H1: CandleRow[]; M1: CandleRow[] }>;
}

/** GET /api/live?h=<history length the terminal has>: prices and the bot's account, polled every second. */
export interface LiveDump {
  time: number;
  label: string;
  real: boolean;
  open: boolean;
  quotes: Quote[];
  /** The bot's account; `history` holds only the trades after index `historyFrom`. */
  state: AccountState;
  historyFrom: number;
  /** Ids of positions the autopilot opened. */
  owned: number[];
  /** Changes when a trade note was added: fetch /api/notes again. */
  notesRev: number;
}

/** GET /api/notes: why each autopilot trade was taken, by position id. */
export interface NotesDump {
  rev: number;
  notes: Record<string, TradeNote>;
  /** Status of each strategy (deployment id): probation, active, benched or retired. */
  status: Record<string, string>;
}

/** POST /api/engine: the terminal's manual actions on the bot's account. */
export type EngineOp =
  | { op: 'submit'; req: OrderRequest }
  | { op: 'close'; id: number; units?: number }
  | { op: 'closeIds'; ids: number[] }
  | { op: 'modify'; id: number; changes: { sl?: number | null; tp?: number | null; trailPips?: number | null } }
  | { op: 'breakEven'; id: number }
  | { op: 'reverse'; id: number }
  | { op: 'cancelOrder'; id: number }
  | { op: 'config'; guard: GuardSettings; leverage: number; commissionPerLot: number };

export type EngineOpResult = { ok: true } | { ok: false; error: string };

/** The JSON the 24/7 bot serves at /api/status (shared by the bot and the terminal). */
export interface BotStatus {
  time: string;
  uptimeSec: number;
  feed: string;
  marketOpen: boolean;
  equityHistory: [number, number][];
  account: {
    balance: number;
    equity: number;
    floating: number;
    margin: number;
    freeMargin: number;
    marginLevel: number | null;
    dayPnl: number;
    dayPnlPct: number;
    trades: number;
  };
  positions: { id: number; symbol: string; side: 'buy' | 'sell'; lots: number; entry: number; sl: number | null; tp: number | null; pl: number; autopilot: boolean }[];
  recentTrades: { closeTime: number; symbol: string; side: 'buy' | 'sell'; lots: number; net: number; r: number | null; reason: string }[];
  autopilot: {
    enabled: boolean;
    mode: string;
    timeframe: string;
    deployments: { strategy: string; status: string; note: string; liveTrades: number; avgR: number; net: number; riskPct: number }[];
    lessons: { lesson: string; status: string; detail: string }[];
    counters: Record<string, number>;
  };
  lab: {
    running: boolean;
    data: string;
    generation: number;
    tested: number;
    perMinute: number;
    best: { strategy: string; score: number; trainR: number; validR: number; holdoutR: number; pairsPositive: string; robust: boolean }[];
  };
  broker: { connected: boolean; label: string; mirror: boolean; nav: number | null; openTrades: number; error: string } | null;
  log: string[];
  /** Plain-language summary for the bot's own dashboard (optional for older bots). */
  summary?: {
    startBalance: number;
    totalNet: number;
    wins: number;
    losses: number;
    /** True when auto-trading cannot be switched off from a browser. */
    autoLocked: boolean;
    /** Risk guard locked trading for the rest of the day. */
    dayLocked: boolean;
    dayLockReason: string;
    /** Next moment (UTC ms) the autopilot evaluates closed bars. */
    nextDecision: number;
    /** When the FX market reopens (UTC ms), or null while it is open. */
    marketOpensAt: number | null;
    realPrices: boolean;
    labData: string;
  };
}

export interface BotControl {
  auto?: boolean;
  lab?: boolean;
}
