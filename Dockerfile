FROM node:24-bullseye-slim

WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/ingestion/package.json apps/ingestion/package.json
COPY apps/signal-engine/package.json apps/signal-engine/package.json
COPY apps/execution-engine/package.json apps/execution-engine/package.json
COPY apps/llm-agent/package.json apps/llm-agent/package.json
COPY apps/ui/package.json apps/ui/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm -r build
