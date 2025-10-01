# Stage 1: Install dependencies
FROM oven/bun:1 as base
WORKDIR /usr/src/app
COPY package.json bun.lock .
RUN bun install --frozen-lockfile

# Stage 2: Build the application
FROM base as build
COPY . .
# If you had a build step, it would go here.
# For this service, we run directly from source.

# Stage 3: Run the application
FROM base
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/src ./src
COPY --from=build /usr/src/app/tsconfig.json .
CMD ["bun", "run", "src/index.ts"]