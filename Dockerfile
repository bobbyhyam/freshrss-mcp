# Node 24 is the active LTS line (Krypton) as of 2026-08-17 — verified against
# https://nodejs.org/dist/index.json, grouped by major. Node 26 exists but is a
# current release, not LTS. The digest below is node:24-alpine (v24.19.0, npm 11.17.0).

# Build stage
#
# node:24-alpine is the ACTIVE LTS line, not the newest tag — roughly half of all
# Node majors never become LTS, so "newest" and "supported" are different things.
# What keeps this honest is a comparison, not a version number written down here:
# `node:lts-alpine` and `node:24-alpine` MUST resolve to the same digest. The day
# 24 leaves LTS they diverge, and that is visible; a hardcoded version in a comment
# is not. Verified 2026-09-01: both resolve to the digest below, Node 24.20.0.
# Refresh the digest and re-run that comparison together — a stale tag is
# invisible if only the digest is re-resolved.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
WORKDIR /app
ENV NODE_ENV=production

# CVE-2026-14456: the pinned base image carries OpenSSL 3.5.7-r0, and Alpine's
# fixed 3.5.8-r0 has not been rebuilt into node:24-alpine yet. Upgrading these
# two packages by name rather than running a blanket `apk upgrade` keeps the
# rest of the image exactly as the digest pins it. Drop this once the base
# image ships the fix.
RUN apk add --no-cache --upgrade libcrypto3 libssl3

# npm is not needed at runtime — the entrypoint is plain `node`, and the version
# in package.json is read with fs, not through npm. Its *vendored* dependencies
# were also the only source of HIGH/CRITICAL findings in this image on
# 2026-08-17 (brace-expansion, ip-address, tar, and undici 6.x — none of them
# ours; the application's own undici is 8.x). Deleting it is a smaller change
# than patching bundled modules in place, and it is why the Trivy gate in CI can
# stay strict instead of carrying an ignore list.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The server reports its version from package.json at runtime.
COPY package.json package-lock.json ./

# Ownership proof for the MCP Registry: must match server.json's name exactly.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/freshrss-mcp"

# Drop root: the node image ships an unprivileged `node` user (uid 1000).
USER node

# Fork: this image serves streamable HTTP, because the agentgateway container in
# front of it is distroless and cannot spawn a stdio child. The npm package and
# every `npx` run are unaffected — the default is still stdio, and this line is
# the whole of the difference. Override it with `-e FRESHRSS_TRANSPORT=stdio`
# to run the image the way upstream's runs.
ENV FRESHRSS_TRANSPORT=http
EXPOSE 8080

# `node -e` rather than curl or wget: the runtime stage deletes npm and carries
# no HTTP client this healthcheck can rely on, and node is already the
# entrypoint. Liveness only — /health says the listener is up and deliberately
# says nothing about FreshRSS.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# No child processes, so no init process is needed. The server starts without
# credentials (tools stay listable so registries and sandbox inspectors can
# introspect it); every call then fails with setup instructions instead of
# reaching the API.
ENTRYPOINT ["node", "dist/index.js"]
