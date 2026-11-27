#!/bin/sh
# The variants decided on before looking at any of them: the learning model on three time
# scales, with 1:1 and 1:2 targets, with and without the longer-term picture. Fast ones first.
cd /opt/neonfx-research
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "hourly daily"; }
v d1_11_htf        TF=D1 SL_ATR=1   TP_ATR=1   HORIZON=10 HTF=1
v d1_12_htf        TF=D1 SL_ATR=1   TP_ATR=2   HORIZON=15 HTF=1
v h4_11_htf        TF=H4 SL_ATR=1.5 TP_ATR=1.5 HORIZON=30 HTF=1
v h4_12_htf        TF=H4 SL_ATR=1.5 TP_ATR=3   HORIZON=30 HTF=1
v h1_11_base       TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=0
v h1_11_htf        TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=1
v h1_11_htf_majors TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=1 PAIRSET=majors
v h1_12_htf        TF=H1 SL_ATR=1.5 TP_ATR=3   HORIZON=48 HTF=1
echo ALLDONE > variants.done
