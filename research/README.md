# Research: is there an edge to trade?

Scripts that test trading ideas on real price history, each on data the method never saw.
They run in their own container next to the bot (`run.sh`, one CPU), not inside it.

| Script | Question |
| --- | --- |
| `trend_daily.py` | Does following the 1 / 3 / 12-month trend across 16 pairs pay, over 20 years of daily closes? |
| `ml_hourly.py` | Can a model that learns price action from ~35 descriptions of the market trade hourly bars at a profit (walk-forward, costs included)? |
| `ml_signal.py` | Is anything predictable in hourly bars before costs, and how does it compare with what a trade costs? |
| `ml_daily.py` | The learning model on 20 years of daily closes: 2009-2026 all unseen. |
| `ml_lab.py` | One bench for the learning model on hourly, 4-hour and daily bars: trades its most confident 10 / 5 / 2 / 1% of situations, next to random entries, with a breakdown of where the result comes from. |
| `carry_daily.py` | Does holding high-interest currencies against low-interest ones pay, after the broker's mark-up on overnight financing? |
| `fx_styles.py` | Do value (purchasing power) and dollar carry improve on carry, alone or together? With the bar the combination had to clear. |
| `mt5/NeonfxExport.mq5` + `icm_import.py` | Export a broker's own history from MetaTrader 5 (bars, real spreads from ticks, swap rates) and check it before use. |

## Findings (26 November 2026, Yahoo Finance history, 16 pairs)

| Approach | Unseen data | Result |
| --- | --- | --- |
| The lab's rule-based strategies (hourly) | last 204 days | −0.10 to −0.13R per trade; holdout-tested picks +0.02R in one run, −0.11R in the next |
| Trend following, daily | 20 years | Sharpe −0.03 before costs, −0.29 after costs and financing; every lookback from 10 to 252 days negative |
| Learning model, daily | 18 years | IC +0.005 (1 day) and −0.013 (5 days): no predictive power; loses after costs like random picks |
| Learning model, hourly | 22 months, 656 trades | −0.02R (±0.04) per trade after costs, against −0.15R for random entries |
| Predictability of hourly bars | 4 folds | IC +0.01 to +0.04 at every horizon; top/bottom 10% earn +0.6 pips (1 h) to +3.4 pips (24 h) before a cost of 2.3 pips |

### Does a different risk:reward help? (hourly learning model, same walk-forward)

| Stop / target (ATR), max hold | Trades | Model | Random entries |
| --- | --- | --- | --- |
| 1.5 / 1.5 (1:1), 24 h | 493 | +0.02R (±0.04), 57% wins | −0.15R, 49% wins |
| 1.5 / 3 (1:2), 48 h | 592 | −0.04R (±0.06), 36% wins | −0.06R, 35% wins |
| 3 / 6 (1:2), 96 h | 1518 | −0.07R (±0.03), 36% wins | −0.08R, 35% wins |

The model's skill is in small, short moves: at 1:1 it wins clearly more often than chance, at
1:2 it is no better than random entries. (The 1:1 row is a rerun with entry thresholds set
relative to the base win rate; the first run gave −0.02R over 656 trades. Both are zero within
the margin.) Account size and risk per trade only scale the result: on a 10,000 account at 1%
risk these three rows come to about +970, −2,260 and −10,400.

**Reading it.** Nothing here makes money on unseen data. The hourly learning model is the one
lead: it beats random entries by about 0.13R and roughly earns back its costs. That evidence
is thin: 2.8 years of free quote data, overlapping samples at the 24-hour horizon (the only one
where the edge exceeds costs on paper), and a 1-hour signal small enough to be noise in the
quotes. The decisive test is the same scripts on the broker's own history with its real
spreads.

## Broker data (27 November 2026, IC Markets EU demo, MetaTrader 5)

The export gives 16 years of hourly bars (from October 2010) for 12 of the 16 pairs, 2 years
for USDCAD, AUDJPY, CADJPY and AUDNZD, and real daily bars from 1996-2004 on. Spreads are
measured from two weeks of ticks, per hour of the broker's clock: EUR/USD about 0.06 pips by
day and 5 pips in the hour of the daily rollover; crosses 0.3-0.8 pips by day and 13-28 pips at
the rollover. With commission and slippage a EUR/USD trade costs about 1.1 pips, not the 1.6
assumed before. Trades are filled as at a broker: a buy opens at the ask and closes at the bid.

Seven tests were written down in `variants_icm.sh` before any of them ran. Unseen data: 12
years for hourly and 4-hour bars (a new model every year, trained on the 4 years before), 25
years for daily bars.

| Test (most confident 1% unless noted) | Trades | Model | Random entries |
| --- | --- | --- | --- |
| Daily bars 1:1, swing | 2878 (top 10%) | −0.01R (±0.02) | −0.01R |
| Daily bars 1:2, swing | 2196 (top 10%) | −0.02R (±0.03) | −0.06R |
| Trend following on daily closes, 30 years | | Sharpe +0.15 before costs, −0.07 after costs and financing; single lookbacks −0.43 to +0.05 | |
| 4-hour bars 1:1, long-term picture | 668 | −0.05R (±0.04) | −0.07R |
| 4-hour bars 1:2, long-term picture | 552 | +0.03R (±0.06) | +0.01R |
| Hourly 1:2 | 2230 | +0.03R (±0.03) | −0.10R |
| Hourly 1:1, as first run | 3394 | **+0.11R (±0.02)**: an artefact, see below | −0.13R |
| Hourly 1:1, no entries around the rollover | 2349 | +0.02R (±0.02) | −0.07R |
| Hourly 1:1, no entries around the rollover and flat before it | 2322 | **0.00R (±0.02)** | −0.09R |
| The same with doubled spreads and 0.5 pip extra cost | 2419 | −0.05R (±0.02) | −0.08R |

**Reading it.** Still nothing that makes money. The hourly model is real in one sense: in every
version it beats random entries by 0.04-0.09R, on 12 years it never saw. That is worth about
what a trade costs, so it ends at zero, and below zero when costs are a little higher than
measured. Swing trading on daily bars, the 4-hour scale, the long-term picture and 1:2 added
nothing. On the earlier Yahoo data the hourly 1:1 model's top 1% made +0.07R over 578 trades;
the broker data, with six times the history, does not confirm it.

## Carry (27 November 2026)

A different source of return from predicting prices: hold the currencies with the highest
central-bank rate against those with the lowest and collect the difference every night. Ranked
once a month on the rate at the end of the month before; rates from the Bank for International
Settlements. The broker's cut is read from its own swap rates: what a buyer pays and a seller
receives differ by 2.2% a year, so 1.1% a year per unit of money held in a pair.

| Top 2 against bottom 2, each side as large as the account | IC Markets closes, 7 currencies, 30 years | Yahoo closes, 8 currencies, 24 years |
| --- | --- | --- |
| Before costs | +4.2%/yr at 11% vol, Sharpe 0.37 | +3.8%/yr, Sharpe 0.33 |
| After the mark-up, held as crosses (cheapest) | +3.1%/yr, Sharpe 0.27 (t = 1.5) | +2.8%/yr, Sharpe 0.24 (t = 1.2) |
| After the mark-up, each currency against the dollar | +2.3%/yr, Sharpe 0.20 (t = 1.1) | +2.1%/yr, Sharpe 0.18 (t = 0.9) |
| Worst drop (2008) | −45% | −45% |
| Last five years, after the mark-up | +1.5%/yr | +1.5%/yr |

Top 3 against bottom 3 and highest against lowest give the same picture, a little weaker. With
40 random rankings in place of the interest rates the same code makes −0.3%/yr on average
(never more than +2.3%), so the result comes from the rates and not from the machinery.

**Reading it.** This is the first thing in this folder that is positive after costs on two
data sets, and it is no discovery: nearly all of it is the interest itself (3.7% a year
collected on average), and the exchange rate has not taken it back. But it is small, it is
not statistically firm after the mark-up, and it is paid for with rare, deep losses when
markets panic. After the broker's cut it earns about what a savings account pays, with a
−45% year in the history. For the euro the rate series is the main refinancing rate, which
overstates euro interest by about half a point in 2014-2022.

### Can a crash filter make carry safer?

Three well-known ways of stepping aside, written down (and committed) before they were run,
each using only what was known the day before and looked at once a week. Figures are after
trading costs and the broker's mark-up, for the main basket.

| | IC Markets closes | Yahoo closes |
| --- | --- | --- |
| No filter | +3.1%/yr, Sharpe 0.27, worst drop −45%, 2008: −32% | +2.8%/yr, Sharpe 0.24, worst drop −45%, 2008: −32% |
| 1. Smaller when the basket gets rough (size = typical / current 21-day volatility, at most 1) | +2.5%/yr, Sharpe 0.31, worst drop −26%, 2008: −18% | +2.3%/yr, Sharpe 0.29, worst drop −22%, 2008: −14% |
| 2. Out when currencies are restless (top quarter of 21-day FX volatility so far) | +2.1%/yr, Sharpe 0.26, worst drop −36%, 2008: −19% | +1.8%/yr, Sharpe 0.22, worst drop −30%, 2008: −16% |
| 3. Out after three losing months | +1.9%/yr, Sharpe 0.24, worst drop −34%, 2008: −8% | +1.8%/yr, Sharpe 0.23, worst drop −27%, 2008: −5% |

Against the unfiltered basket held at the filter's own average size all the time, no filter
adds return (−0.0 to −0.6%/yr, every |t| below 0.5). What filter 1 does add is a smoother
ride: at 87-89% average size its worst drop is −22 to −26%, where a constant position of that
size would have dropped −40%. That holds for look-backs of 10 to 63 days (Sharpe 0.27-0.33,
worst drop −21 to −28%), so it does not hang on the 21 days chosen in advance.

**Reading it.** Shrinking the position when the basket turns rough about halves the worst
loss for half a point of return a year. It makes carry easier to live with, not more
profitable: still about +2.4% a year after the broker's cut.

### Can other documented styles improve it? (`fx_styles.py`)

Two more styles with published evidence, a candidate for the bot and the bar it had to clear,
all committed before the first run: **value** (buy the two currencies whose real value in
dollars fell most against their own level of five years ago, sell the two that rose most;
consumer prices from the BIS, used three months late), **dollar carry** (all other currencies
against the dollar, bought while their average rate is above the US rate) and the candidate:
the three in equal parts with the volatility filter. The bar: a Sharpe ratio of at least 0.5
after trading costs and the broker's mark-up, on both data sets.

| After all costs | IC Markets closes, 2003-2026 | Both data sets, 2009-2026 |
| --- | --- | --- |
| Carry | +3.2%/yr, Sharpe 0.28 | Sharpe 0.44-0.46 |
| Value | −1.3%/yr, Sharpe −0.14 | Sharpe 0.06-0.12 |
| Dollar carry | −0.3%/yr, Sharpe −0.03 | Sharpe 0.03-0.05 |
| Carry + value, half each | +1.5%/yr at 5.8% vol, Sharpe 0.26 | Sharpe 0.49-0.51 |
| All three, a third each | +1.0%/yr at 4.9% vol, Sharpe 0.21 | Sharpe 0.46-0.47 |
| **The candidate** (all three + filter) | +0.4%/yr at 3.0% vol, Sharpe 0.14, worst drop −12% | Yahoo: +2.0%/yr at 4.7% vol, Sharpe 0.42 |

**The bar is not reached** on either data set (0.14 and 0.42). Value and dollar carry earn
nothing here on their own; mixed with carry they lower the risk and the return alike, so the
Sharpe ratio stays where carry already was. The Yahoo run looks better only because its history
starts after the 2008 crash: over the same years (from 2009) the two sources agree to within
0.05 on every line. Carry on its own remains the one positive result, at about a savings
account's return. It is not built into the bot.

## Three traps this folder already fell into

1. **Asking the data source for "all" daily history returns monthly bars.** The first trend
   test ran on 277 rows per pair and reported a Sharpe above 5. `fetch_daily` now asks in
   4-year pieces and `trend_daily.py` refuses data with fewer than 200 bars a year.
2. **The source's daily open / high / low are not a normal bar.** Since about 2011 its daily
   "close" is the price at the start of the day and the high and low cover the day after. A
   first version of `ml_daily.py` built features on them and "earned" 190% a year. Daily work
   uses the close column only. Hourly bars were checked and are normal.

3. **Broker bars are bid prices, and the bid drops when the spread opens up.** Around the daily
   rollover the spread goes from a fraction of a pip to 5-28 pips for a few minutes. The bid
   sinks without the market moving, and comes back. A test that buys at "bid at the open plus
   the hour's average spread" in the hour after the rollover buys far below the real ask and
   books the recovery as profit. The first hourly run on broker data made +0.11R per trade with
   t = 6.8; the breakdown by entry hour showed a third of the trades in that one hour at
   +0.32R and nothing anywhere else. `ml_lab.py` now prints that breakdown for every run, and
   `SKIP_HOURS` / `FLAT_HOUR` keep trades away from the rollover.

One more slip, without effect on the conclusions: `trend_daily.py` refreshes Yahoo files in the
folder it is given, and so replaced the four short broker files in `icm/daily` after the other
tests had run. `NOFETCH=1` now keeps it away from broker data; the trend figures above are from
the rerun on broker closes only.

A result that looks too good is a bug until proven otherwise: `ml_daily.py` prints a warning
when a model ranks better than any honest daily model can.

## Running

```sh
# on the server, next to the bot
cd /opt/neonfx-research
./run.sh trend   trend_daily.py daily     # writes trend.log
./run.sh ml      ml_hourly.py   hourly    # hourly CSVs as written by scripts/fetch-history.mjs
./run.sh signal  ml_signal.py   hourly
./run.sh mldaily ml_daily.py    daily
./variants.sh; ./variants2.sh             # the learning model on Yahoo data, several time scales

# broker data: run mt5/NeonfxExport.mq5 in MetaTrader 5, copy MQL5/Files/neonfx/* to icm_raw/
docker run --rm -v /opt/neonfx-research:/work -w /work neonfx-research python icm_import.py icm_raw icm hourly
./variants_icm.sh                         # the pre-registered tests
./check_icm.sh; ./check2_icm.sh           # where the hourly result comes from; away from the rollover
docker run --rm -v /opt/neonfx-research:/work -w /work neonfx-research python carry_daily.py icm/daily rates icm_raw/meta.csv
docker run --rm -v /opt/neonfx-research:/work -w /work neonfx-research python fx_styles.py icm/daily rates icm_raw/meta.csv
```
