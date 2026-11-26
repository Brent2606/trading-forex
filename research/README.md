# Research: is there an edge to trade?

Scripts that test trading ideas on real price history, each on data the method never saw.
They run in their own container next to the bot (`run.sh`, one CPU), not inside it.

| Script | Question |
| --- | --- |
| `trend_daily.py` | Does following the 1 / 3 / 12-month trend across 16 pairs pay, over 20 years of daily closes? |
| `ml_hourly.py` | Can a model that learns price action from ~35 descriptions of the market trade hourly bars at a profit (walk-forward, costs included)? |
| `ml_signal.py` | Is anything predictable in hourly bars before costs, and how does it compare with what a trade costs? |
| `ml_daily.py` | The learning model on 20 years of daily closes: 2009-2026 all unseen. |

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

## Two traps this folder already fell into

1. **Asking the data source for "all" daily history returns monthly bars.** The first trend
   test ran on 277 rows per pair and reported a Sharpe above 5. `fetch_daily` now asks in
   4-year pieces and `trend_daily.py` refuses data with fewer than 200 bars a year.
2. **The source's daily open / high / low are not a normal bar.** Since about 2011 its daily
   "close" is the price at the start of the day and the high and low cover the day after. A
   first version of `ml_daily.py` built features on them and "earned" 190% a year. Daily work
   uses the close column only. Hourly bars were checked and are normal.

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
```
