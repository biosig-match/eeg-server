FROM oven/bun:1.2.23-slim

WORKDIR /usr/src/app

COPY bun.lock ./
COPY processor/package.json ./
RUN bun install

COPY tsconfig.base.json /usr/src/
COPY processor/tsconfig.json ./
COPY processor/src ./src

CMD ["bun", "run", "src/main.ts"]
