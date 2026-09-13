FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
FROM deps AS builder
ARG MANDAT_BUILD_ID=development
ENV MANDAT_BUILD_ID=$MANDAT_BUILD_ID
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
FROM node:22-bookworm-slim AS web
ARG MANDAT_BUILD_ID=development
ENV MANDAT_BUILD_ID=$MANDAT_BUILD_ID
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
FROM deps AS worker
ARG MANDAT_BUILD_ID=development
ENV MANDAT_BUILD_ID=$MANDAT_BUILD_ID
COPY . .
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
CMD ["npm", "run", "worker"]
