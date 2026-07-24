FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/relay/package.json apps/relay/package.json
COPY plugins/codex-collab/package.json plugins/codex-collab/package.json
RUN npm ci

COPY packages/protocol packages/protocol
COPY apps/relay apps/relay
RUN npm run build --workspace @codex-collab/protocol \
    && npm run build --workspace @codex-collab/relay

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4177
ENV CODEX_COLLAB_DATA_DIR=/data

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol ./packages/protocol
COPY --from=build /app/apps/relay ./apps/relay

VOLUME ["/data"]
EXPOSE 4177
CMD ["node", "apps/relay/dist/server.js"]
