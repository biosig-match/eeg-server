# Use the official Bun image as a base
FROM oven/bun:1-slim
WORKDIR /usr/src/app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY ./src ./src
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
