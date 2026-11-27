#!/bin/sh
# Follow-up on the stacking test, fixed after the candidate was chosen by its rule (8-hour hold,
# most confident 1%, clock features on): the same run with doubled spreads and half a pip of
# extra cost per trade. Nothing else is changed.
cd /opt/neonfx-research
while [ ! -f stack_icm.done ]; do sleep 20; done
export SPREADS=/work/icm/spreads.json CPU_SHARES=512
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "icm/hourly icm/daily"; }
SET="TF=H1 EXIT=time SKIP_HOURS=23,0,1 SL_ATR=1.5 TP_ATR=1.5 HTF=0 SPLIT_YEAR=2021 STEP_MONTHS=12 MIN_TRAIN_MONTHS=48 TRAIN_MONTHS=48"
v icm_stack_8h_clock_stress HORIZON=8 CLOCK=1 SPREAD_MULT=2 EXTRA_COST_PIPS=0.5 $SET
echo ALLDONE > stack2_icm.done
