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
