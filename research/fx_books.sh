#!/bin/sh
# The currency model whose direction was measured (stop and target, nothing open around the rollover),
# once per random seed, with every trade written to fxbooks/ so that whatif_costs.py can ask: what would
# the same trades have earned at other costs, and on the cheapest pairs only?
cd /opt/neonfx-research
export SPREADS=/work/icm/spreads.json CPU_SHARES=512 MATCHED=1 BOOKS=/work/fxbooks
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "icm/hourly icm/daily"; }
SET="TF=H1 SL_ATR=1.5 TP_ATR=1.5 HORIZON=24 HTF=0 SKIP_HOURS=23,0,1 FLAT_HOUR=23 SPLIT_YEAR=2021 STEP_MONTHS=12 MIN_TRAIN_MONTHS=48 TRAIN_MONTHS=48"
for seed in 7 11 23; do v fx_flat_s$seed SEED=$seed $SET; done
echo ALLDONE > fx_books.done
