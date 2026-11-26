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
| **Backtester** | EMA crossover, RSI mean reversion, Bollinger breakout and reversion, MACD cross, Donchian breakout, momentum burst and session range breakout, with ATR stops/targets, risk-based sizing, trend filter, spread and commission. No look-ahead: signals on a bar's close fill at the next bar's open, and a bar that touches both stop and target counts as a loss. Trades are marked on the chart. |
| **Real data import** | Load OHLC CSV exports from MetaTrader 4/5, Dukascopy, HistData or TradingView (or any `time,open,high,low,close` file) and backtest on real history. |
| **Technical pulse & scanner** | A 17-indicator consensus gauge (10 moving averages + RSI, Stochastic, MACD, CCI, ADX, Williams %R, Momentum) for the chart, and a heat grid of every pair on M15/H1/H4/D1. It describes the chart; it is not a forecast. |
| **Sessions, strength, correlation** | Sydney/Tokyo/London/New York sessions from the real time-zone database (DST-correct), with overlaps; a currency-strength meter; a correlation heatmap so you can see when two trades are really one bet. |
| **Alerts** | Price alerts with sound, drawn on the chart. |
| **Trades & explanations** | Every trade per day. Click one to see it on the chart (entry, exit, target and stop zones, the signal candle, the strategy's own indicator) and read in plain language why it was taken and how it ended. |
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
  the next 20%, and the last 20% (holdout) is never used for ranking. Ranking uses a cautious
  SQN: every sample is scored as if its next trade were a full loss, more trades count as more
  evidence (up to 400), and a strategy needs at least 40 validation trades to be ranked at
  all. Without that, a handful of trades that never lost scores absurdly high and the search
  drifts to "wide stop, tiny target" rules whose rare big loss is simply not in the sample
  yet. On 2.8 years of real hourly data, strategies picked this way traded about ten times as
  often and lost far less on the unseen holdout than those picked on the plain SQN (but they
  still did not show a profit there: see the honest limits below). "Robust" also requires
  profits out-of-sample on at least 60% of the pairs, so one lucky trend can't carry a rule.
  The leaderboard keeps one entry per signal rule (near-copies count as one) and re-tests
  entries as new data arrives.
* **Autopilot**: trades the best strategies on the paper account. *Explore* deploys
  validated strategies (those that also passed the holdout first); *Strict* deploys only
  strategies that passed the holdout. Every strategy starts on
  **probation** at 0.25% risk, is **promoted** to full risk after 15+ live trades with a
  positive average, scaled by its live results, and is **benched** for good after a
  significantly negative record, 7 losses in a row or a 10R drawdown. An active strategy whose
  live results fall clearly below its historical promise is **demoted** back to probation.
  Near-identical strategies are never deployed together, and one strategy family gets at most
  a third of the slots (minimum two), because strategies of one family tend to trade the same
  moves. A stronger candidate
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
* De gesimuleerde markt (koershistorie en prijzen) wordt elk uur en bij afsluiten opgeslagen
  in `data/neonfx-market.json.gz`. Na een herstart simuleert de bot de tijd dat hij uit stond,
  inclusief stops en targets, zodat alles doorloopt.
* Echte data: zet CSV-exports (MetaTrader, Dukascopy, HistData, TradingView) in
  `data/history/`. Het lab onderzoekt dan op echte koersen in plaats van de simulator.
* Logboek: `data/neonfx.log`. Toestand: `data/neonfx-state.json`.
* De statuspagina toont ook een equity-grafiek (één punt per uur).
* Net als de echte markt ligt de bot stil van vrijdag 17:00 tot zondag 17:00 New Yorkse tijd.
* Meldingen in het Nederlands: `NEONFX_LANG=nl`.

### De terminal bij de bot (één rekening)

De bot serveert de terminal zelf op `http://127.0.0.1:8787/` (alleen op de machine van de bot).
Die terminal is meteen verbonden, zonder adres of token: hij toont de koersen en **de rekening van
de bot**. Posities, historie en prestaties zijn die van de bot, en wat je zelf via het orderticket
doet gaat naar dezelfde rekening. Draait de bot op een server, open de pagina dan via een
SSH-tunnel: `ssh -N -L 8787:127.0.0.1:8787 root@<server>` en ga naar http://localhost:8787.

* **Trades**: alle trades per dag. Klik op een trade: de grafiek springt ernaartoe (instap, uitstap,
  winstdoel en stop-loss, de signaalkaars en de indicator van de strategie zelf) en het paneel
  *Waarom deze trade?* legt in gewone taal uit welke strategie het was, welke meetwaarden het
  signaal gaven, wat het plan was en hoe het afliep. De bot legt die meetwaarden vast bij elke
  instap (`/api/notes`).
* **Autopilot 24/7**: de strategieën, lessen en het lab van de bot. Automatisch handelen staat
  vast aan (`NEONFX_AUTO_LOCK=on`, standaard); zet het op `off` om het vanuit de terminal te kunnen
  schakelen.
* De **?**-knop rechtsboven toont wat waar staat.
* De API (`/api/...`) werkt alleen met het token uit `data/neonfx-token.txt`; pagina's worden
  alleen aan lokale hostnamen geserveerd. Zet de poort niet open naar internet.
* De losse terminal (`npm run dev`) blijft een eigen oefenrekening in de browser; via het tabblad
  **24/7-bot** kan die ook met adres en token naar een bot kijken.

### Echte koersen via OANDA (demo-account)

Maak een gratis **practice**-account bij OANDA, genereer een API-token (Manage API Access) en zet:

```
NEONFX_OANDA_TOKEN=<je practice-token>
NEONFX_OANDA_ACCOUNT=<optioneel, anders de eerste rekening>
NEONFX_OANDA_TRADE=off        # "on" = trades ook op je demo-account plaatsen
NEONFX_OANDA_MAX_UNITS=100000 # grootste order (1 lot)
```

* Met alleen het token draait de bot op **echte koersen** (elke seconde) en echte koershistorie
  (~5000 uur-candles per paar). Het lab onderzoekt dan echte data en de papieren rekening handelt
  op echte prijzen.
* Met `NEONFX_OANDA_TRADE=on` worden de trades van de bot gespiegeld naar je demo-account: grootte
  geschaald naar je demosaldo, met stop en target die meelopen (trailing, break-even, wijzigingen).
* Alleen de demo-server (`api-fxpractice.oanda.com`) is toegestaan. Echte-geld-rekeningen worden
  bewust geweigerd. Werkt OANDA niet (verkeerd token, geen verbinding), dan valt de bot terug op de
  simulator en krijg je een melding.
* Getest tegen een nagebootste OANDA-API volgens de officiële v20-documentatie; test het eerst
  een paar dagen op je demo-account.

### Echte koersen via cTrader (demo-account)

Werkt met een cTrader-demo-account bij een broker (bijvoorbeeld Pepperstone of IC Markets) en een
app op https://openapi.ctrader.com (Applications → Add new app; Spotware keurt die eerst goed):

```
NEONFX_CTRADER_CLIENT_ID=<client id van je app>
NEONFX_CTRADER_CLIENT_SECRET=<client secret>
NEONFX_CTRADER_ACCESS_TOKEN=<access token uit de Sandbox/Playground>
NEONFX_CTRADER_REFRESH_TOKEN=<refresh token>
NEONFX_CTRADER_ACCOUNT=<rekeningnummer, optioneel: anders het eerste demo-account>
```

* De bot gebruikt dan de echte koersen, spreads en koershistorie van de broker. Hij blijft op zijn
  eigen papieren rekening handelen; er gaan geen orders naar de broker.
* Alleen demo-accounts en de demo-server: live-rekeningen worden geweigerd.
* Het lab zoekt dan op de koersgeschiedenis van de broker zelf: de bot haalt op de achtergrond
  ongeveer drie jaar uurdata op (en ververst die elke dag). Tot dat klaar is, of als het mislukt,
  gebruikt het lab de CSV's in `data/history/`.
* Tokens verlopen na ongeveer 30 dagen; de bot ververst ze zelf en bewaart ze in
  `data/ctrader-tokens.json`. Valt de verbinding weg, dan verbindt hij opnieuw en pauzeert het
  handelen tot er weer koersen zijn.
* Op een server: `deploy/neonfx-set-ctrader` vraagt de waarden en zet ze in `.env` (zie
  `deploy/README.md` voor de serverinstallatie, back-ups en updates).

### Taal

De terminal volgt de taal van je browser (Nederlands of Engels). Met de knop **NL/EN** rechtsboven
wissel je direct. Gangbare handelstermen (stop loss, take profit, spread, pips, lots) blijven zoals
Nederlandse traders ze gebruiken.

### Meldingen op je telefoon

De bot stuurt een bericht bij start/stop/crash, als een strategie wordt ingezet, gepromoveerd,
gedegradeerd of gebankt, bij een nieuwe les, bij een risk-guard-blokkade of margin call, en
elke handelsdag een **dagrapport**. Met `NEONFX_NOTIFY=all` krijg je ook elke fill en close.
Stel één of meer kanalen in (in `docker-compose.yml` of als omgevingsvariabele):

| Kanaal | Instellen |
| --- | --- |
| **Telegram** | Stuur `/newbot` naar @BotFather en kopieer de token. Stuur je bot een bericht en open `https://api.telegram.org/bot<TOKEN>/getUpdates` voor je `chat.id`. Zet `NEONFX_TELEGRAM_TOKEN` en `NEONFX_TELEGRAM_CHAT`. |
| **ntfy** (geen account nodig) | Installeer de ntfy-app, abonneer op een lang, willekeurig onderwerp en zet `NEONFX_NTFY_URL=https://ntfy.sh/<onderwerp>`. Iedereen die het onderwerp kent kan meelezen, dus kies iets onraadbaars. |
| **Discord** | Kanaalinstellingen → Integraties → Webhook. Zet `NEONFX_DISCORD_WEBHOOK`. |
| **Slack** | Incoming Webhook. Zet `NEONFX_SLACK_WEBHOOK`. |
| **Eigen systeem** | `NEONFX_WEBHOOK` ontvangt JSON `{"event","text","time"}`. |

Tokens worden alleen uit de omgeving gelezen en nooit gelogd. Zet ze niet in git.
* Instellingen via omgevingsvariabelen (zie `docker-compose.yml`): `NEONFX_AUTO`, `NEONFX_LAB`,
  `NEONFX_MODE` (`explore`/`strict`), `NEONFX_RISK`, `NEONFX_TF` (`H1`/`H4`),
  `NEONFX_LAB_DUTY` (0.1–1, aandeel CPU-tijd voor het lab), `NEONFX_PORT`, `NEONFX_HOST`,
  `NEONFX_DATA`.
* Sneller data verzamelen: `NEONFX_MAX_STRATEGIES` (strategieën tegelijk, standaard 3),
  `NEONFX_MAX_OPEN` (open posities van de autopilot, standaard 6) en `NEONFX_MAX_PER_CCY`
  (posities per valuta, standaard 3). Meer strategieën tegelijk geeft meer trades; elke strategie
  houdt zijn eigen regels en begint op proef met klein risico. De risk guard (maximaal aantal
  posities, dagelijkse verlieslimiet) blijft gelden.

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
* It follows real FX hours: prices freeze from Friday 17:00 to Sunday 17:00 New York time and
  the reopen gaps, like the generated history. Market orders and manual closes are refused
  while closed (pending orders can still be placed). *Risk & account → Weekend practice*
  keeps the simulator running for practice.
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
  i18n.ts         Dutch translation (dictionary + message patterns)
  time.ts         FX market hours, New York close, sessions
src/ui/         DOM + canvas UI (chart, ticket, desk, analysis, backtest, autopilot)
bot/            the headless 24/7 bot (Node): API, notifications, OANDA practice integration
tests/          vitest suites for everything in src/core
```

## Broker connection (OANDA practice) and remote view

* `NEONFX_OANDA_TOKEN` switches the bot from the simulator to OANDA's real prices and candle
  history; `NEONFX_OANDA_TRADE=on` mirrors its trades to the practice account (units scaled to
  the account's NAV, stops and targets attached and kept in sync). Only the practice API is
  allowed; real-money accounts are refused on purpose. See `bot/oanda.ts`.
* The terminal's **24/7 Bot** tab shows the bot through its token-protected API
  (`/api/status`, `/api/control`) and can switch its autopilot and lab.
* The simulated market of the bot is saved hourly and restored after a restart, so history and
  prices continue.

## Going live

Real-money trading is deliberately not supported. Run on a practice account for a long time,
keep the risk guard on, and remember that a strategy that worked on history or on a demo is
still not a guarantee.
