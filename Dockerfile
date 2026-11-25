# NEONFX 24/7 bot: paper trading, autopilot and strategy lab without a browser.
# The bot is one self-contained file with no runtime dependencies. Build it first:
#   npm install && npm run bot:build        (or simply: npm run bot:docker)
FROM node:22-alpine
WORKDIR /app
COPY dist-bot/neonfx-bot.mjs ./neonfx-bot.mjs
ENV NODE_ENV=production \
    NEONFX_DATA=/app/data \
    NEONFX_HOST=0.0.0.0 \
    NEONFX_PORT=8787
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
EXPOSE 8787
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s CMD wget -qO- http://127.0.0.1:8787/status > /dev/null || exit 1
CMD ["node", "neonfx-bot.mjs"]
