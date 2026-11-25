export interface TradeLike {
  net: number;
  closeTime: number;
  symbol?: string;
  r?: number | null;
}

export interface PerfStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  net: number;
  /** Gross profit / gross loss. Infinity when there are wins and no losses; NaN with no trades. */
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  /** Average win / average loss. */
  payoff: number;
  /** Average net result per trade. */
  expectancy: number;
  largestWin: number;
  largestLoss: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  /** Mean R multiple over trades that had a stop at entry. */
  avgR: number;
  /** Van Tharp's System Quality Number on net results (capped at 100 trades). */
  sqn: number;
  /** Closed-trade balance curve, starting with the start balance. */
  curve: number[];
}

/** Performance statistics for closed trades (sorted by close time internally). */
export function computeStats(trades: readonly TradeLike[], startBalance: number): PerfStats {
  const list = [...trades].sort((a, b) => a.closeTime - b.closeTime);
  let wins = 0;
  let losses = 0;
  let gp = 0;
  let gl = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let bal = startBalance;
  let peak = startBalance;
  let maxDd = 0;
  let maxDdPct = 0;
  let cw = 0;
  let cl = 0;
  let mcw = 0;
  let mcl = 0;
  let rSum = 0;
  let rN = 0;
  const curve = [startBalance];
  for (const t of list) {
    if (t.net > 0) {
      wins++;
      gp += t.net;
      largestWin = Math.max(largestWin, t.net);
      cw++;
      cl = 0;
    } else if (t.net < 0) {
      losses++;
      gl += -t.net;
      largestLoss = Math.min(largestLoss, t.net);
      cl++;
      cw = 0;
    } else {
      cw = 0;
      cl = 0;
    }
    mcw = Math.max(mcw, cw);
    mcl = Math.max(mcl, cl);
    if (typeof t.r === 'number' && Number.isFinite(t.r)) {
      rSum += t.r;
      rN++;
    }
    bal += t.net;
    curve.push(bal);
    if (bal > peak) peak = bal;
    const dd = peak - bal;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }
  const n = list.length;
  const net = gp - gl;
  const avgWin = wins ? gp / wins : 0;
  const avgLoss = losses ? gl / losses : 0;
  let sqn = 0;
  if (n >= 2) {
    const mean = net / n;
    const variance = list.reduce((a, t) => a + (t.net - mean) ** 2, 0) / (n - 1);
    const sd = Math.sqrt(variance);
    sqn = sd > 0 ? (Math.sqrt(Math.min(n, 100)) * mean) / sd : 0;
  }
  return {
    trades: n,
    wins,
    losses,
    winRate: n ? wins / n : 0,
    grossProfit: gp,
    grossLoss: gl,
    net,
    profitFactor: n === 0 ? NaN : gl === 0 ? (gp > 0 ? Infinity : NaN) : gp / gl,
    avgWin,
    avgLoss,
    payoff: avgLoss > 0 ? avgWin / avgLoss : NaN,
    expectancy: n ? net / n : 0,
    largestWin,
    largestLoss,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct * 100,
    maxConsecWins: mcw,
    maxConsecLosses: mcl,
    avgR: rN ? rSum / rN : NaN,
    sqn,
    curve,
  };
}

export interface SymbolBreakdown {
  symbol: string;
  trades: number;
  winRate: number;
  net: number;
}

export function bySymbol(trades: readonly TradeLike[]): SymbolBreakdown[] {
  const m = new Map<string, { n: number; w: number; net: number }>();
  for (const t of trades) {
    const k = t.symbol ?? '?';
    const e = m.get(k) ?? { n: 0, w: 0, net: 0 };
    e.n++;
    if (t.net > 0) e.w++;
    e.net += t.net;
    m.set(k, e);
  }
  return [...m.entries()]
    .map(([symbol, e]) => ({ symbol, trades: e.n, winRate: e.w / e.n, net: e.net }))
    .sort((a, b) => b.net - a.net);
}
