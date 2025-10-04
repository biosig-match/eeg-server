FROM oven/bun:1.2.23-slim

WORKDIR /usr/src/app

COPY package.json bun.lock ./
RUN bun install

COPY ./src ./src
COPY ./tsconfig.json ./tsconfig.json

CMD ["bun", "run", "src/index.ts"]
