#!/bin/sh
# The strictest version of the hourly test: no entries around the daily rollover and every trade
# closed an hour before it, so wide night-time spreads cannot play any part. Then the same with
# doubled spreads and half a pip of extra cost per trade.
cd /opt/neonfx-research
while [ ! -f check_icm.done ]; do sleep 20; done
for f in ml_lab.py run.sh; do cp -p next/$f .$f.tmp && mv -f .$f.tmp $f; done; chmod +x run.sh
export SPREADS=/work/icm/spreads.json CPU_SHARES=512
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "icm/hourly icm/daily"; }
LONG="STEP_MONTHS=12 MIN_TRAIN_MONTHS=48 TRAIN_MONTHS=48"
v icm_h1_11_flat        TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=0 SKIP_HOURS=23,0,1 FLAT_HOUR=23 $LONG
v icm_h1_11_flat_stress TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=0 SKIP_HOURS=23,0,1 FLAT_HOUR=23 SPREAD_MULT=2 EXTRA_COST_PIPS=0.5 $LONG
echo ALLDONE > check2_icm.done
