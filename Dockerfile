# MASTERCLIP OS — single-container deployment.
#
# Docker rather than a native Node runtime for one reason: this application is
# not a web app that happens to touch video. ffmpeg and ffprobe are load-bearing
# — they render, probe, measure and transcode on the critical path, and QC is
# meaningless without them — so the runtime has to be one where they are
# genuinely installed rather than smuggled in as a downloaded binary.
FROM node:22-slim

# ffmpeg for rendering and QC; ca-certificates for outbound provider calls.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/bin
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Manifests first, so a change to source does not invalidate the dependency
# layer. Every workspace package.json is needed for the install to resolve.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.base.json vitest.config.ts ./

RUN pnpm install --frozen-lockfile

# Produces dist/{api,worker,masterclip,seed}.js and apps/web/dist.
RUN pnpm build

# Sandbox by default: this posture refuses every billable submission outright,
# independent of budgets. A deployment that should spend money sets
# MASTERCLIP_MODE=live deliberately, and is still bound by LIVE_SPEND_CAP_USD.
ENV NODE_ENV=production \
    MASTERCLIP_MODE=sandbox \
    API_HOST=0.0.0.0

EXPOSE 4310
CMD ["node", "scripts/serve.mjs"]
