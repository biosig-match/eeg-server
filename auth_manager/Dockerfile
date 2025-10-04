FROM oven/bun:1.2.23-slim

WORKDIR /usr/src/app

COPY bun.lock ./
COPY auth_manager/package.json ./
RUN bun install

COPY tsconfig.base.json /usr/src/
COPY auth_manager/tsconfig.json ./
COPY auth_manager/src ./src

EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
