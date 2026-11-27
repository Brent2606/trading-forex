#!/bin/sh
# Is the hourly result on broker data real? The same test again with a breakdown of where the
# result comes from, and once more with no entries around the daily rollover.
cd /opt/neonfx-research
export SPREADS=/work/icm/spreads.json CPU_SHARES=512
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "icm/hourly icm/daily"; }
LONG="STEP_MONTHS=12 MIN_TRAIN_MONTHS=48 TRAIN_MONTHS=48"
v icm_h1_11_where TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=0 $LONG
v icm_h1_11_quiet TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=0 SKIP_HOURS=23,0,1 $LONG
echo ALLDONE > check_icm.done
