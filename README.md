# NEONFX — forex paper-trading terminal

A neon trading cockpit for practising forex: a live simulated price feed for 16 pairs,
pro-style charting, an order ticket that sizes every trade from your risk, a risk guard
that stops you blowing up, a backtester that also runs on real broker data, and
performance analytics.

> **Read this first.** This is a *paper-trading* terminal. Prices come from a market
> simulator, not a broker, and no real orders are sent anywhere. No software can guarantee
> profits: most retail FX accounts lose money. What this terminal does is make the habits
> that keep traders alive (fixed-fraction risk, stops on every trade, a daily loss limit,
> testing ideas on real data before risking money) the default path.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run bot        # the headless 24/7 bot (see below)
npm run build      # production build in dist/
npm run build:single   # one self-contained HTML file in dist-single/
```

Requires Node 20+. No runtime dependencies; everything is TypeScript + Canvas.

## What's in the terminal

| Area | What it does |
| --- | --- |
| **Market watch** | 16 majors and crosses with bid/ask in dealing-board format (big figure, pips, pipette), live spread and day change. Click a row to chart and trade it. |
| **Chart** | Candles, Heikin-Ashi or line. M1–D1. EMA 20/50/200, Bollinger Bands, tick volume, and an RSI / MACD / Stochastic pane. Your positions, stops, targets, pending orders and alerts are drawn as lines. Drag to pan, wheel to zoom, double-click for live. Hovering BUY/SELL previews the planned entry, stop and target on the chart. |
| **Order ticket** | Market, limit and stop orders. Size by **risk %** (lots calculated from the stop distance, incl. commission) or by lots. Stop from 1.5 × ATR in one click, target as 1R/2R/3R, trailing stops. Live preview of pip value, margin, money at risk, reward and reward:risk before you click. Optional confirmation step (on by default). |
| **Risk guard** | Requires a stop on every trade, caps risk per trade (default 2%), limits open positions, and locks trading for the rest of the day after a daily loss limit (default 5%), optionally closing everything. |
| **Positions / orders / history** | Live P/L in money and pips, break-even, close half, reverse, edit SL/TP/trailing, close all / winners / losers. History records R-multiples, max favourable/adverse excursion and the close reason. Copy history as CSV. |
| **Performance** | Net P/L, win rate, profit factor, expectancy, average R, payoff ratio, max drawdown, streaks, SQN, balance curve, per-pair breakdown. |
| **Backtester** | EMA crossover, RSI mean reversion, Bollinger breakout, MACD cross and Donchian breakout, with ATR stops/targets, risk-based sizing, trend filter, spread and commission. No look-ahead: signals on a bar's close fill at the next bar's open, and a bar that touches both stop and target counts as a loss. Trades are marked on the chart. |
| **Real data import** | Load OHLC CSV exports from MetaTrader 4/5, Dukascopy, HistData or TradingView (or any `time,open,high,low,close` file) and backtest on real history. |
| **Technical pulse & scanner** | A 17-indicator consensus gauge (10 moving averages + RSI, Stochastic, MACD, CCI, ADX, Williams %R, Momentum) for the chart, and a heat grid of every pair on M15/H1/H4/D1. It describes the chart; it is not a forecast. |
| **Sessions, strength, correlation** | Sydney/Tokyo/London/New York sessions from the real time-zone database (DST-correct), with overlaps; a currency-strength meter; a correlation heatmap so you can see when two trades are really one bet. |
| **Alerts** | Price alerts with sound, drawn on the chart. |
| **Autopilot & lab** | Automated trading of the strategies a non-stop genetic search finds, with probation, promotion, benching and lessons learned from losing trades. See below. |
| **Command line** | `buy eurusd 1% sl 20 tp 40`, `sell limit gbpjpy 0.5 @187.20 sl 30`, `close losers`, `be all`, `chart usdjpy h4`, `alert eurusd > 1.0850`, `auto on`, `lab on`, `help`. |

### Keyboard

`Shift+B` buy · `Shift+S` sell (uses the ticket) · `1`–`6` timeframe · `[` `]` previous/next pair ·
`/` command line · `Esc` cancel a pending confirmation.

## Autopilot, strategy lab and learning

The **Autopilot** tab (or `auto on` / `lab on` on the command line) automates everything:

* **Strategy lab**: a genetic search that keeps generating, mutating and crossing strategy
  "genomes" (strategy type and parameters, ATR stop/target, trend filter, allowed sessions,
  volatility filter). Each one is backtested on every pair and judged in R (profit per unit
  of risk) with walk-forward validation: it evolves on the first 60% of history, is ranked on
  the next 20%, and the last 20% (holdout) is never used for ranking. The leaderboard keeps
  one entry per signal rule and re-tests entries as new data arrives.
* **Autopilot**: trades the best strategies on the paper account. *Explore* deploys
  validated strategies; *Strict* also requires the holdout test. Every strategy starts on
  **probation** at 0.25% risk, is **promoted** to full risk after 15+ live trades with a
  positive average, scaled by its live results, and is **benched** for good after a
  significantly negative record, 7 losses in a row or a 10R drawdown. A stronger candidate
  can replace an untested probation strategy (at most every 10 minutes). Portfolio limits:
  max open positions, max positions per currency, no opposite positions on one pair, and the
  risk guard still applies.
* **Learning from mistakes**: every autopilot trade is journaled with its context (session,
  volatility, trend alignment, spread). When losses cluster in one condition, the learner
  proposes a lesson ("avoid the Asia session"), tests it against history, and adopts it only
  if history agrees. Lessons expire after 21 days and must prove themselves again.

**Honest limits.** Testing thousands of variants always produces some that look great by
luck. On simulated prices there is no real edge, so the live record will bench them: that is
the learning loop working. The backtester charges spread, commission and stop slippage
(0.2×ATR, calibrated so that random strategies on random prices break even before costs),
but history is never a guarantee. For research that means something, import real broker
history (Backtest tab, or `data/history/` for the bot) and still let strategies prove
themselves on paper first.

## 24/7 draaien (Nederlands)

De browserversie handelt alleen zolang het tabblad open staat. Voor echt 24/7 draai je de
**headless bot** op een computer die altijd aan staat (VPS, thuisserver, Raspberry Pi). De bot
draait dezelfde markt, papieren rekening, autopilot en strategie-lab, slaat alles op in
`data/` en gaat na een herstart verder waar hij was.

```bash
npm install
npm run bot                 # bouwen en starten
# of met Docker, start automatisch opnieuw na een crash of reboot:
npm run bot:docker          # = npm run bot:build && docker compose up -d --build
```

* Statuspagina: http://127.0.0.1:8787/ (JSON op `/status`). Alleen-lezen, en standaard
  alleen bereikbaar op die machine. Gebruik een VPN of SSH-tunnel om hem van buitenaf te
  bekijken; zet de poort niet open naar internet.
* Echte data: zet CSV-exports (MetaTrader, Dukascopy, HistData, TradingView) in
  `data/history/`. Het lab onderzoekt dan op echte koersen in plaats van de simulator.
* Logboek: `data/neonfx.log`. Toestand: `data/neonfx-state.json`.
* Instellingen via omgevingsvariabelen (zie `docker-compose.yml`): `NEONFX_AUTO`, `NEONFX_LAB`,
  `NEONFX_MODE` (`explore`/`strict`), `NEONFX_RISK`, `NEONFX_TF` (`H1`/`H4`),
  `NEONFX_LAB_DUTY` (0.1–1, aandeel CPU-tijd voor het lab), `NEONFX_PORT`, `NEONFX_HOST`,
  `NEONFX_DATA`.

De bot handelt met papiergeld op de gesimuleerde feed. Er gaan geen echte orders naar een broker.

## How the price feed works

The simulator (`src/core/market.ts`) models each currency's value, not each pair, so
every cross is always consistent with its USD legs (EUR/JPY = EUR/USD × USD/JPY, no
triangular arbitrage) and correlations between pairs emerge naturally. Moves come from a
dollar factor, a risk-on/risk-off factor, a European bloc, a commodity bloc and
idiosyncratic noise, with an intraday liquidity profile, stochastic volatility regimes and
occasional news-style jumps. Daily volatility per pair lands in the realistic 0.4–0.9% range.

* At start-up it anchors to the latest **ECB reference rates** (via frankfurter.app) when
  the network allows, otherwise to built-in reference rates. After the first session it
  resumes from your last prices so open positions stay consistent.
* It generates ~250 trading days of H1 history and 3 days of M1 history, skipping the
  weekend close, and aggregates every timeframe from those so they always agree. H4 and D1
  bars use the New York close (17:00 ET), like most FX brokers.
* Spreads widen around the 17:00 New York rollover and in thin hours.
* It is a random walk with no predictable edge. Backtests on simulated data show how a
  strategy behaves mechanically, not whether it makes money. Use the CSV import for that.

## The paper account

* USD account, default $10,000, leverage 1:30, $3.50 commission per lot per side
  (all adjustable under *Risk & account*).
* Longs fill at the ask and close at the bid; shorts the reverse. Stops fill at the market
  price when touched (so a gap fills worse than the stop, as in real life).
* P/L and margin are converted to USD at live rates, including crosses.
* Margin call warning below 100% margin level; stop-out closes the biggest loser below 50%.
* Hedging is allowed (several positions per pair), each with full margin.
* State is saved in your browser's local storage.

Not modelled: overnight swap/rollover interest, broker requotes and partial fills.

## Project layout

```
src/core/       pure, tested logic
  market.ts       currency-factor market simulator
  account.ts      order/position engine, margin, stop-out, risk guard
  risk.ts         position sizing and trade preview
  indicators.ts   SMA, EMA, RSI, MACD, Bollinger, ATR, Stochastic, CCI, ADX, Williams %R
  backtest.ts     strategies and the event-driven backtester
  genome.ts       strategy genomes: mutation, crossover, market context
  lab.ts          genetic search with walk-forward validation
  autopilot.ts    automated trading, probation/promotion/benching, lessons
  signals.ts      technical consensus
  analytics.ts    currency strength, correlation
  csv.ts          OHLC import for common broker formats
  command.ts      command-line parser
  time.ts         FX market hours, New York close, sessions
src/ui/         DOM + canvas UI (chart, ticket, desk, analysis, backtest, autopilot)
bot/            the headless 24/7 bot (Node) with a read-only status page
tests/          vitest suites for everything in src/core
```

## Going live

Wiring this to a real broker (for example a REST/streaming API with a practice account)
means replacing `MarketSim` as the quote source and `TradingEngine.submit/close/modify`
with broker calls. Do that against a demo account first, and keep the risk guard on.
