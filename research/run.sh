#!/bin/sh
# Builds the research image once and runs one script next to the bot, limited to one CPU.
# Usage: run.sh <name> <script.py> <data folder inside /work>
cd /opt/neonfx-research
docker image inspect neonfx-research >/dev/null 2>&1 || docker build -q -t neonfx-research . >/dev/null
docker rm -f "neonfx-research-$1" >/dev/null 2>&1
docker run --rm --name "neonfx-research-$1" --cpus 1 --cpu-shares 128 -v /opt/neonfx-research:/work -w /work neonfx-research sh -c "python -u $2 $3; echo ==DONE" > "/opt/neonfx-research/$1.log" 2>&1
