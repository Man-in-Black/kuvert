# syntax=docker/dockerfile:1

# Vorgefertigtes Bündel statt der Build-Stufe verwenden (GitLab-CI: Kaniko baut arm64 ohne Emulation).
ARG APP_IMAGE=bundle

# ───────────────────────── Build ─────────────────────────
# Läuft immer auf der Architektur des Build-Rechners (schnell, auch beim arm64-Build) und
# stellt ALLES zusammen, wofür Befehle laufen müssen – die Laufzeit-Stufe kopiert nur noch.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS app
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

# Anwendung mit Produktions-Abhängigkeiten nach /out/app (reines JavaScript bzw. Binaries für alle
# Plattformen, daher unabhängig von der Zielarchitektur)
RUN mkdir -p /out/app/shared /out/app/server /out/app/web /out/data \
 && cp package.json package-lock.json /out/app/ \
 && cp shared/package.json /out/app/shared/ \
 && cp server/package.json /out/app/server/ \
 && cp web/package.json /out/app/web/ \
 && cd /out/app \
 && npm ci --omit=dev --workspace server --no-audit --no-fund --ignore-scripts \
 && npm cache clean --force \
 && cp -r /app/shared/src shared/src \
 && cp -r /app/server/dist server/dist \
 && cp -r /app/server/assets server/assets \
 && cp -r /app/web/dist web/dist

# Systempakete je Zielarchitektur nach /out/rootfs-<arch> entpacken (ohne sie auszuführen):
# openssl: S/MIME · ca-certificates: TLS & Zertifikatsprüfung · tini: sauberes Signal-Handling
RUN set -e; nativ=$(dpkg --print-architecture); \
    for a in amd64 arm64; do [ "$a" = "$nativ" ] || dpkg --add-architecture "$a"; done; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    for a in amd64 arm64; do \
      mkdir -p /tmp/deb-$a /out/rootfs-$a/etc/ssl /out/rootfs-$a/usr/share; \
      (cd /tmp/deb-$a && apt-get download openssl:$a libssl3:$a tini:$a); \
      for d in /tmp/deb-$a/*.deb; do dpkg -x "$d" /out/rootfs-$a; done; \
      cp -a /etc/ssl/certs /out/rootfs-$a/etc/ssl/; \
      cp -a /usr/share/ca-certificates /out/rootfs-$a/usr/share/; \
      rm -rf /out/rootfs-$a/usr/share/doc /out/rootfs-$a/usr/share/man; \
      for top in bin lib lib64 sbin; do [ ! -e /out/rootfs-$a/$top ] || { echo "rootfs-$a/$top würde den usrmerge-Link überschreiben" >&2; exit 1; }; done; \
      test -x /out/rootfs-$a/usr/bin/tini && test -x /out/rootfs-$a/usr/bin/openssl; \
    done; \
    rm -rf /var/lib/apt/lists/* /tmp/deb-*

# Nur das Ergebnis (klein, für die GitLab-CI als eigenes Image)
FROM scratch AS bundle
COPY --from=app /out /out

FROM ${APP_IMAGE} AS appsrc

# ───────────────────────── Laufzeit ─────────────────────────
# Keine RUN-Befehle: lässt sich für jede Architektur ohne Emulation bauen.
FROM node:24-bookworm-slim AS runtime
ARG TARGETARCH

COPY --from=appsrc /out/rootfs-${TARGETARCH}/ /

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIST=/app/web/dist

COPY --from=appsrc /out/app ./
COPY --from=appsrc --chown=node:node /out/data /data

USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
