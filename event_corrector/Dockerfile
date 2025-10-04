FROM oven/bun:1.2.23-slim

WORKDIR /usr/src/app

COPY bun.lock ./
COPY event_corrector/package.json ./
RUN bun install

COPY tsconfig.base.json /usr/src/
COPY event_corrector/tsconfig.json ./
COPY event_corrector/src ./src

CMD ["bun", "run", "src/main.ts"]
