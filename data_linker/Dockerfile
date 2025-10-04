FROM oven/bun:1.2.23-slim

WORKDIR /usr/src/app

COPY bun.lock ./
COPY data_linker/package.json ./
RUN bun install

COPY tsconfig.base.json /usr/src/
COPY data_linker/tsconfig.json ./
COPY data_linker/src ./src

CMD ["bun", "run", "src/main.ts"]
