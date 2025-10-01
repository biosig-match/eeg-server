# Use the official Bun image as a base
FROM oven/bun:1-slim
WORKDIR /usr/src/app
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY ./src ./src
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
