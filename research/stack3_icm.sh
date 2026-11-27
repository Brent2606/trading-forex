#!/bin/sh
# Is the candidate (8-hour hold, most confident 1%, clock features) skill or luck? Written down
# after the control runs showed that it is the only one of the first sixteen cells that stayed
# positive after 2021. Two checks that tune nothing:
#   - the same run with two other random seeds for the model (the seed only changes which rows
#     and features each tree happens to see);
#   - the neighbouring holding times, 6 and 10 hours.
# If the edge is real, the most confident 1% should stay positive after 2021 in all four. If it
# swings to zero or below with another seed or a neighbouring holding time, it was luck.
cd /opt/neonfx-research
while [ ! -f stack2_icm.done ]; do sleep 20; done
export SPREADS=/work/icm/spreads.json CPU_SHARES=512
v() { name=$1; shift; env "$@" LABEL="$name" ./run.sh "$name" ml_lab.py "icm/hourly icm/daily"; }
SET="TF=H1 EXIT=time CLOCK=1 SKIP_HOURS=23,0,1 SL_ATR=1.5 TP_ATR=1.5 HTF=0 SPLIT_YEAR=2021 STEP_MONTHS=12 MIN_TRAIN_MONTHS=48 TRAIN_MONTHS=48"
v icm_stack_8h_seed11 HORIZON=8 SEED=11 $SET
v icm_stack_8h_seed23 HORIZON=8 SEED=23 $SET
v icm_stack_6h_clock  HORIZON=6 $SET
v icm_stack_10h_clock HORIZON=10 $SET
echo ALLDONE > stack3_icm.done
