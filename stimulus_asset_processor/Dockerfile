FROM oven/bun:1.2.23-slim

WORKDIR /usr/src/app

COPY bun.lock ./
COPY stimulus_asset_processor/package.json ./
RUN bun install

COPY tsconfig.base.json /usr/src/
COPY stimulus_asset_processor/tsconfig.json ./
COPY stimulus_asset_processor/src ./src

CMD ["bun", "run", "src/main.ts"]
