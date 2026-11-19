FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY lib ./lib
COPY daemon/main.ts ./daemon/main.ts
USER node
CMD ["node", "daemon/main.ts"]
