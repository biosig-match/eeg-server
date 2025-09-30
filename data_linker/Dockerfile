# Use the official Bun image as a base
FROM oven/bun:1-alpine

# Set the working directory
WORKDIR /usr/src/app

# Copy package.json and bun.lockb to leverage Docker cache
COPY package.json bun.lock ./

# Install dependencies using --frozen-lockfile for deterministic builds
RUN bun install --frozen-lockfile

# Copy the rest of the application source code
COPY . .

# The command to run the application
CMD ["bun", "start"]
