# Squash League Automation

Local-first director dashboard and API for house league operations (see `.doc/prd.md` and `.doc/constitution.md`).

## Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io) 9+

## Setup

```bash
pnpm install
pnpm --filter @squash/shared build
pnpm --filter @squash/api db:push
```

## Development

Terminal 1 — API (SQLite in `apps/api/data/`):

```bash
pnpm --filter @squash/api dev
```

Terminal 2 — Web UI (proxies to API):

```bash
pnpm --filter @squash/web dev
```

Open `http://localhost:5173`. API health: `http://localhost:3001/health`.

## Tests

```bash
pnpm --filter @squash/shared test
```

## Project layout

| Path | Purpose |
|------|---------|
| `apps/api` | Fastify + Drizzle + SQLite |
| `apps/web` | React + Vite director UI |
| `packages/shared` | Rotation, draw heuristic, standings (Vitest) |
| `docs/discovery` | Spikes / ADRs |

## Configuration

Copy `apps/api/.env.example` to `apps/api/.env` and adjust. Defaults use `CLUB_LOCKER_ADAPTER=mock` and `EMAIL_ADAPTER=console`.
