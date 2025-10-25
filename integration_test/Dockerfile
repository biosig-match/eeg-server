FROM oven/bun:1.2.22-slim AS deps

WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY auth_manager/package.json ./auth_manager/
COPY collector/package.json ./collector/
COPY data_linker/package.json ./data_linker/
COPY event_corrector/package.json ./event_corrector/
COPY integration_test/package.json ./integration_test/
COPY media_processor/package.json ./media_processor/
COPY processor/package.json ./processor/
COPY session_manager/package.json ./session_manager/
COPY stimulus_asset_processor/package.json ./stimulus_asset_processor/
COPY observability_dashboard/package.json ./observability_dashboard/

RUN bun install --frozen-lockfile --no-cache

FROM deps

WORKDIR /app
COPY . .

WORKDIR /app/integration_test

CMD ["bun", "test"]
