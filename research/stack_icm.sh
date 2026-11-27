#!/bin/sh
# Stacking small real effects. The clock tests (clock_effects.py) and the learning model each found
# something real that is smaller than the cost of a trade. Here the learning model gets the clock
# effects as extra input and trades within one broker day, with no stop or target: in, hold for a
# fixed number of hours, out. No trade is open during the rollover, so the bid-price trap and the
# interest booked overnight cannot play a part.
#
# Fixed before the first run (27 November 2026):
#   - two holding times, 4 and 8 hours, each with and without the clock features (the runs
#     without them only show what the features add);
#   - unseen years are reported in two blocks. The setting (holding time x confidence bucket,
#     clock features on) with the highest per-day t-value on the years up to 2021 is the one
#     candidate. It is worth proposing for the bot only if, on the years after 2021 and after
#     all costs, its Sharpe ratio is at least 0.5 and its per-day t-value at least 2.
cd /opt/neonfx-research
export SPREADS=/work/icm/spreads.json CPU_SHARES=512
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "icm/hourly icm/daily"; }
SET="TF=H1 EXIT=time SKIP_HOURS=23,0,1 SL_ATR=1.5 TP_ATR=1.5 HTF=0 SPLIT_YEAR=2021 STEP_MONTHS=12 MIN_TRAIN_MONTHS=48 TRAIN_MONTHS=48"
v icm_stack_4h_clock HORIZON=4 CLOCK=1 $SET
v icm_stack_8h_clock HORIZON=8 CLOCK=1 $SET
v icm_stack_4h_plain HORIZON=4 CLOCK=0 $SET
v icm_stack_8h_plain HORIZON=8 CLOCK=0 $SET
echo ALLDONE > stack_icm.done
