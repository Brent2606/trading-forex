#!/bin/sh
# Swing trading on 20 years of daily closes, and the trend test again with the corrected dates.
cd /opt/neonfx-research
while [ ! -f variants.done ]; do sleep 20; done
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "hourly daily"; }
v d1_11_htf  TF=D1 SL_ATR=2 TP_ATR=2 HORIZON=10 HTF=1
v d1_12_htf  TF=D1 SL_ATR=2 TP_ATR=4 HORIZON=20 HTF=1
v d1_12_base TF=D1 SL_ATR=2 TP_ATR=4 HORIZON=20 HTF=0
./run.sh trend trend_daily.py daily
echo ALLDONE > variants2.done
