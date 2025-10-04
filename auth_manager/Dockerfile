FROM oven/bun:1.2.23-slim
WORKDIR /usr/src/app
COPY package.json bun.lock ./
RUN bun install
COPY ./src ./src
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
