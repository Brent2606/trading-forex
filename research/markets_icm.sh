#!/bin/sh
# Gold, oil and stock indices: the tests whose rules, costs and bar were written into README.md
# before this data existed (commit "plan and bar for gold, oil and stock indices").
# Data: mt5/NeonfxExportMarkets.mq5 -> mkt_raw/ -> icm_import_markets.py -> mkt/ (all checks passed).
cd /opt/neonfx-research
export SPREADS=/work/mkt/spreads.json CPU_SHARES=512 MARKETS=1 BOOKS=/work/mkt/books
py() { name=$1; shift; docker run --rm --name "neonfx-research-$name" --cpus 1 --cpu-shares 512 -e SPREADS -e MARKETS -e SPREAD_MULT -e MIN_YEARS -v /opt/neonfx-research:/work -w /work neonfx-research sh -c "python -u $*; echo ==DONE" > "$name.log" 2>&1; }
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "mkt/hourly mkt/daily"; }
rm -rf mkt/books
# Step 1: the cost of a trade as a share of the hourly move, next to currencies.
SPREADS= MARKETS= py mkt_costs markets_costs.py mkt icm
# Step 2: the chart-pattern rules, and the same with doubled spreads and slippage.
py mkt_patterns patterns.py mkt/hourly
SPREAD_MULT=2 py mkt_patterns_stress patterns.py mkt/hourly
# Step 3: the learning model, two settings, three seeds each, then the stress runs.
SET="TF=H1 HTF=0 CLOCK=1 SKIP_HOURS=23,0,1 SL_ATR=1.5 TP_ATR=1.5 SPLIT_YEAR=2021 STEP_MONTHS=12 MIN_TRAIN_MONTHS=48 TRAIN_MONTHS=48"
for seed in 7 11 23; do
  v mkt_m1_s$seed HORIZON=24 FLAT_HOUR=23 SEED=$seed $SET
  v mkt_m2_s$seed EXIT=time HORIZON=4 SEED=$seed $SET
done
v mkt_m1_stress HORIZON=24 FLAT_HOUR=23 SEED=7 SPREAD_MULT=2 $SET
v mkt_m2_stress EXIT=time HORIZON=4 SEED=7 SPREAD_MULT=2 $SET
SPREADS= MARKETS= py mkt_verdict markets_verdict.py mkt/books
echo ALLDONE > markets_icm.done
