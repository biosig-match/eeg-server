FROM oven/bun:1.2.23-slim

WORKDIR /usr/src/app

COPY bun.lock ./
COPY collector/package.json ./
RUN bun install

COPY tsconfig.base.json /usr/src/
COPY collector/tsconfig.json ./
COPY collector/src ./src

EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
