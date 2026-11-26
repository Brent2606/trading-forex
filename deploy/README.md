# Server deployment (Hetzner VPS, Docker)

The bot runs in Docker on the server at `/opt/neonfx`, a git checkout of `main`.

| File | Installed as | What it does |
| --- | --- | --- |
| `neonfx-update` | `/usr/local/bin/` | Pulls `main`, rebuilds and restarts the bot. Run it after pushing. |
| `neonfx-watchdog` | `/usr/local/bin/` | Restarts the container when Docker marks it unhealthy (cron, every 5 min). |
| `neonfx-backup` | `/usr/local/bin/` | Daily backup of `data/` to `/opt/neonfx-backups` (keeps 14 days). |
| `neonfx-history` | `/usr/local/bin/` | Weekly download of real hourly history for the strategy lab. |
| `neonfx-set-ctrader` | `/usr/local/bin/` | Asks for the cTrader Open API keys and stores them in `/opt/neonfx/.env`. |
| `neonfx-set-oanda` | `/usr/local/bin/` | Same for an OANDA practice token. |
| `cron.neonfx` | `/etc/cron.d/neonfx` | Schedules the jobs above. |

The terminal is served by the bot on `127.0.0.1:8787` on the server only. Reach it from your own
computer through an SSH tunnel: `ssh -N -L 8787:127.0.0.1:8787 root@<server>`, then open
http://localhost:8787. Secrets live in `/opt/neonfx/.env` (root only) and `data/`, never in git.
