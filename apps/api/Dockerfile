# Use Node 20 as base
FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Build stage
FROM base AS build
WORKDIR /usr/src/app

# Copy monorepo configuration
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build dependencies and the app
RUN pnpm --filter @squash/shared build
RUN pnpm --filter @squash/api build

# Deploy production-ready package
RUN pnpm --filter @squash/api --prod deploy /usr/src/app/deployed

# Runner stage
FROM base AS runner
WORKDIR /app

# Copy the deployed application from build stage
COPY --from=build /usr/src/app/deployed .

# Create data directory for SQLite persistence
RUN mkdir -p data

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_URL=file:/app/data/squash.db

EXPOSE 3001

# Start the API
CMD ["node", "dist/index.js"]
