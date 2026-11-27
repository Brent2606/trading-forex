#!/bin/sh
# The same tests on the broker's own history (IC Markets demo, exported from MetaTrader 5 with
# mt5/NeonfxExport.mq5 and read in by icm_import.py): 16 years of hourly bars, 27 years of real
# daily bars, spreads measured from ticks, fills at bid / ask.
# This list was written down before any of these results existed.
cd /opt/neonfx-research
export SPREADS=/work/icm/spreads.json CPU_SHARES=512
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "icm/hourly icm/daily"; }
LONG="STEP_MONTHS=12 MIN_TRAIN_MONTHS=48 TRAIN_MONTHS=48"   # a new model every year, trained on the 4 years before
v icm_d1_11_htf  TF=D1 DAILY_OHLC=1 SL_ATR=1   TP_ATR=1   HORIZON=10 HTF=1
v icm_d1_12_htf  TF=D1 DAILY_OHLC=1 SL_ATR=1   TP_ATR=2   HORIZON=15 HTF=1
v icm_h1_11_base TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=0 $LONG
v icm_h4_11_htf  TF=H4 SL_ATR=1.5 TP_ATR=1.5 HORIZON=30 HTF=1 $LONG
v icm_h4_12_htf  TF=H4 SL_ATR=1.5 TP_ATR=3   HORIZON=30 HTF=1 $LONG
v icm_h1_12_base TF=H1 SL_ATR=1.5 TP_ATR=3   HORIZON=48 HTF=0 $LONG
v icm_h1_11_htf  TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=1 $LONG
NOFETCH=1 ./run.sh icm_trend trend_daily.py icm/daily
echo ALLDONE > variants_icm.done
