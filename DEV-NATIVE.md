# Native local development (hot reload, no Docker rebuilds)

All app code runs natively on Windows; only the databases run in Docker.
Every change to Python or frontend code is picked up instantly — uvicorn
`--reload` for the backend, `next dev --turbo` for the frontends.

## Start everything

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-native.ps1
```

Each service opens in its own window so you can watch logs. URLs:

| Service            | URL                          |
|--------------------|------------------------------|
| Trader app         | http://localhost:3000        |
| Admin app          | http://localhost:3001        |
| Gateway API (docs) | http://localhost:8000/docs   |
| Admin API (docs)   | http://localhost:8001/docs   |

Admin login (local dev): `admin@swisdex.local` / `ChangeMeLocalDev2026!`

## Stop everything

Close the service windows (Ctrl+C), or:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-native-stop.ps1
```

## How it's wired

- **Infra in Docker** — `docker-compose.local-infra.yml` publishes the DB
  containers on shifted host ports (5432/5433/6379 are taken by other local
  projects): postgres → **5434**, timescaledb → **5435**, redis → **6381**.
  Data lives in the same Docker volumes the full-Docker setup used.
- **`backend/.env`** — native services read this (cwd = `backend/`); it
  points at the localhost ports above. Docker Compose keeps using the root
  `.env` with in-network hostnames — the two don't conflict.
- **Module-name junctions** — Docker maps `services/market-data` →
  `/app/services/market_data`. Natively the same is done with Windows
  directory junctions (`market_data`, `b_book_engine`, `risk_engine`),
  created once, gitignored. If you clone fresh, recreate them:
  ```powershell
  cd backend\services
  New-Item -ItemType Junction market_data  -Target market-data
  New-Item -ItemType Junction b_book_engine -Target b-book-engine
  New-Item -ItemType Junction risk_engine  -Target risk-engine
  ```
- **Python venv** — `backend\.venv` (Python 3.14) with all five services'
  requirements + `pip install -e packages\common`.
- **admin-api** gets `REDIS_URL=redis://localhost:6381/1` (db 1) in its
  window — same override docker-compose applies.

## Migrations

```powershell
cd backend
$env:DATABASE_URL='postgresql+asyncpg://swisdex:swisdex_dev@localhost:5434/swisdex'
.\.venv\Scripts\python.exe -m alembic -c infra\migrations\alembic.ini upgrade head
```

## Mobile app (Expo)

```powershell
cd ..\swisdex_mobile_app
pnpm start          # then scan the QR with Expo Go
```

`.env.local` must point at your PC's Wi-Fi IP (currently `192.168.1.8`) —
update it if your IP changes. The gateway binds `0.0.0.0:8000` so the phone
can reach it; if the app can't connect, allow Python through Windows
Firewall (private networks).

## Deploying to production

Nothing here touches prod. Production still deploys the Docker way via
`scripts/deploy.sh` on the server (see MEMORY: /opt/swisdex). The files
added for native dev (`docker-compose.local-infra.yml`, `backend/.env`,
junctions, `scripts/dev-native*.ps1`) are dev-only; `backend/.env` and the
junctions are gitignored.
