# syntax=docker/dockerfile:1.7
#
# One image for staging, built by build-image.yml. The web container runs
# `next start`; the API container runs the Nitro bundle.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN yarn install --immutable
RUN yarn turbo build --filter=@fleet/web --filter=@fleet/api

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
CMD ["node", "apps/api/.output/server/index.mjs"]
