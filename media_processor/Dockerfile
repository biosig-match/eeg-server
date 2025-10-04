FROM oven/bun:1.2.23-slim

WORKDIR /usr/src/app

COPY bun.lock ./
COPY media_processor/package.json ./
RUN bun install

COPY tsconfig.base.json /usr/src/
COPY media_processor/tsconfig.json ./
COPY media_processor/src ./src

CMD ["bun", "run", "src/main.ts"]
