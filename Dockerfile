# syntax=docker/dockerfile:1

# ───────────────────────── Build ─────────────────────────
# Läuft immer auf der Architektur des Build-Rechners (schnell, auch beim arm64-Build);
# das Ergebnis (JavaScript, statische Dateien) ist plattformunabhängig.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# --ignore-scripts: better-sqlite3 bringt vorkompilierte Binaries mit, esbuild nutzt optionale Plattformpakete
RUN npm ci --no-audit --no-fund --ignore-scripts

COPY shared shared
COPY server server
COPY web web
RUN npm run build --workspace web \
 && npm run build --workspace server

# ───────────────────────── Laufzeit ─────────────────────────
FROM node:24-bookworm-slim AS runtime

# openssl: S/MIME · ca-certificates: TLS & Zertifikatsprüfung · tini: sauberes Signal-Handling
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --no-audit --no-fund --ignore-scripts \
 && npm cache clean --force

COPY --from=build /app/shared/src shared/src
COPY --from=build /app/server/dist server/dist
# S/MIME-Wurzelzertifikate (E-Mail-Vertrauensbit), siehe server/assets/smime-roots.pem
COPY server/assets server/assets
COPY --from=build /app/web/dist web/dist

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
