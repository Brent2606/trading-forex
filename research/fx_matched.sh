#!/bin/sh
# How much of "the model beats random entries" on currencies is direction, and how much is only the
# choice of pair and hour? The two runs behind that statement once more, unchanged (same seed, so the
# same trades), with the extra yardstick printed: all entries in the same pair, hour and side that year.
cd /opt/neonfx-research
export SPREADS=/work/icm/spreads.json CPU_SHARES=512 MATCHED=1
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "icm/hourly icm/daily"; }
LONG="STEP_MONTHS=12 MIN_TRAIN_MONTHS=48 TRAIN_MONTHS=48"
v fx_matched_flat  TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=0 SKIP_HOURS=23,0,1 FLAT_HOUR=23 $LONG
v fx_matched_stack TF=H1 EXIT=time HORIZON=8 CLOCK=1 SKIP_HOURS=23,0,1 SL_ATR=1.5 TP_ATR=1.5 HTF=0 SPLIT_YEAR=2021 $LONG
echo ALLDONE > fx_matched.done
