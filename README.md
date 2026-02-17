# SDI Lead Discovery (Dev mode, free)

This repo implements the required UI + backend pipeline with:
- Next.js App Router (UI + API)
- BullMQ + Redis (queue + worker)
- PostgreSQL + Prisma (runs, leads, logs, cache)
- SSE progress stream
- Deterministic extraction + evidence fields
- **No external API keys needed** in dev: discovery uses mock connector and/or URLs inside the "Detailed context".

## 0) Prereqs (Windows)
- Node.js LTS installed (`node -v` and `npm -v` work)
- Docker Desktop running (`docker version` shows Server)

## 1) Start infrastructure (Postgres + Redis)
```powershell
cd C:\dev\sdi\sdi-lead-discovery
docker compose up -d
```

## 2) Install deps
```powershell
npm install
```

## 3) Init DB
```powershell
copy .env.example .env
npm run db:migrate
```

## 4) Start worker (Terminal 1)
```powershell
npm run worker
```

## 5) Start web app (Terminal 2)
```powershell
npm run dev
```

Open http://localhost:3000

## Notes
- If you paste one or more **company URLs** into "Detailed target context", the app will use them as discovery seeds (no guessing).
- Verified CSV will only include rows that pass the verification policy (evidence + gates). Everything else goes to needs_review.csv.
