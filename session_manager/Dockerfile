FROM oven/bun:1.2.23-slim

WORKDIR /usr/src/app

COPY bun.lock ./
COPY session_manager/package.json ./
RUN bun install

COPY tsconfig.base.json /usr/src/
COPY session_manager/tsconfig.json ./
COPY session_manager/src ./src

EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
