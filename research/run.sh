#!/bin/sh
# Builds the research image once and runs one script next to the bot, limited to one CPU.
# Usage: run.sh <name> <script.py> <data folder inside /work>   (the settings of ml_lab.py are passed through from the environment)
cd /opt/neonfx-research
docker image inspect neonfx-research >/dev/null 2>&1 || docker build -q -t neonfx-research . >/dev/null
docker rm -f "neonfx-research-$1" >/dev/null 2>&1
docker run --rm --name "neonfx-research-$1" --cpus 1 --cpu-shares "${CPU_SHARES:-128}" -e SL_ATR -e TP_ATR -e HORIZON -e TF -e HTF -e PAIRSET -e LABEL -e SPREADS -e DAILY_OHLC -e STEP_MONTHS -e MIN_TRAIN_MONTHS -e TRAIN_MONTHS -e SKIP_HOURS -e FLAT_HOUR -e SPREAD_MULT -e EXTRA_COST_PIPS -e NOFETCH -e EXIT -e CLOCK -e SPLIT_YEAR -v /opt/neonfx-research:/work -w /work neonfx-research sh -c "python -u $2 $3; echo ==DONE" > "/opt/neonfx-research/$1.log" 2>&1
