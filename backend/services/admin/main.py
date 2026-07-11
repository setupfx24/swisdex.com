import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from packages.common.src.config import get_settings
from packages.common.src.database import engine
from packages.common.src.instrumentation import init_sentry, add_middleware_stack

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s")
logger = logging.getLogger("admin-api")

from routes import (
    auth, dashboard, users, trades, deposits, banks, book,
    config as routes_config, instruments_admin, business, social, analytics, bonus, banners,
    support, employees, settings, transactions, kyc, account_types, user_audit_logs,
    insurance as insurance_admin, play_zone as play_zone_admin,
    lifestyle as lifestyle_admin, approvals, notifications, broadcast,
    fixed_return as fixed_return_admin, rm as rm_admin, tasks as tasks_admin,
    expenses as expenses_admin, risk as risk_admin,
)

app_settings = get_settings()
init_sentry("admin-api")

_cors_origins = [
    o.strip()
    for o in app_settings.CORS_ORIGINS.split(",")
    if o.strip()
]
if not _cors_origins:
    _cors_origins = ["http://localhost:3001"]
_cors_methods = [m.strip() for m in app_settings.CORS_ALLOW_METHODS.split(",") if m.strip()]
_cors_headers = [h.strip() for h in app_settings.CORS_ALLOW_HEADERS.split(",") if h.strip()]


async def _apply_startup_ddl():
    """Idempotent ALTERs that unblock admin endpoints when manual migrations
    haven't been run yet on a host (Render/Vercel/etc.). Safe to re-run."""
    from sqlalchemy import text
    try:
        async with engine.begin() as conn:
            await conn.execute(text(
                "ALTER TABLE employees ADD COLUMN IF NOT EXISTS extra_permissions JSONB DEFAULT '[]'::jsonb"
            ))
            # Book-management LP settings read/write this table. Create if the
            # baseline migration hasn't been applied so GET/PUT don't 500.
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS system_settings (
                    key VARCHAR(100) PRIMARY KEY,
                    value JSONB NOT NULL,
                    description TEXT,
                    updated_by UUID REFERENCES users(id),
                    updated_at TIMESTAMPTZ DEFAULT now()
                )
            """))
            # RM subsystem (migration 0071). Self-heal so the /rm endpoints work
            # even on hosts where the migrate step wasn't run.
            await conn.execute(text(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_rm_id UUID REFERENCES users(id)"
            ))
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS rm_funding_requests (
                    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                    rm_id UUID NOT NULL REFERENCES users(id),
                    user_id UUID NOT NULL REFERENCES users(id),
                    amount NUMERIC(18,2) NOT NULL,
                    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
                    method VARCHAR(40),
                    note TEXT,
                    proof_path TEXT,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    approved_by UUID REFERENCES users(id),
                    approved_at TIMESTAMPTZ,
                    credited_by UUID REFERENCES users(id),
                    credited_at TIMESTAMPTZ,
                    rejected_by UUID REFERENCES users(id),
                    rejected_at TIMESTAMPTZ,
                    rejection_reason TEXT,
                    deposit_id UUID REFERENCES deposits(id),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """))
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_rm_funding_requests_status ON rm_funding_requests(status)"
            ))
            # Bonus promo-code flow (migration 0072).
            await conn.execute(text(
                "ALTER TABLE bonus_offers ADD COLUMN IF NOT EXISTS promo_code VARCHAR(40)"
            ))
            await conn.execute(text(
                "ALTER TABLE bonus_offers ADD COLUMN IF NOT EXISTS code_visible BOOLEAN NOT NULL DEFAULT true"
            ))
            # User lifecycle statuses. The original init-db CHECK only allowed
            # active/banned/blocked/pending_kyc/suspended, so terminate
            # (status='terminated') and soft-delete (status='deleted') silently
            # failed the commit — the account never changed. Drop the constraint
            # (consistent with the project's move away from status CHECK
            # constraints; statuses are validated in app code) so every
            # lifecycle action persists.
            await conn.execute(text(
                "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check"
            ))
            # IB manual tier override (migration 0074, client spec 2026-06-16).
            await conn.execute(text(
                "ALTER TABLE ib_profiles ADD COLUMN IF NOT EXISTS tier_override VARCHAR(40)"
            ))
            # notifications.type CHECK was too narrow — type='bonus' (and
            # others) violated it and 500'd features like Fixed-Return bonus.
            # Drop it; type is validated in app code (migration 0075).
            await conn.execute(text(
                "ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check"
            ))
            # employees.role CHECK predated rm/deposit_manager/withdrawal_manager
            # — creating those employees 500'd. Role is validated in app code
            # (employee_service.VALID_EMPLOYEE_ROLES). Drop it (migration 0076).
            await conn.execute(text(
                "ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check"
            ))
            # Employee tasks + custom roles (migration 0077, client 2026-06-16).
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS employee_custom_roles (
                    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                    name VARCHAR(40) UNIQUE NOT NULL,
                    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_by UUID REFERENCES users(id),
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """))
            await conn.execute(text("""
                CREATE TABLE IF NOT EXISTS employee_tasks (
                    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                    assigned_by UUID REFERENCES users(id),
                    assigned_to UUID NOT NULL REFERENCES users(id),
                    title VARCHAR(200) NOT NULL,
                    description TEXT,
                    due_date DATE,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    undone_reason TEXT,
                    completed_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            """))
            await conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_employee_tasks_assigned_to ON employee_tasks(assigned_to)"
            ))
            # Broker spread revenue per trade (migration 0078) — its own Finance
            # Overview line, separate from commission.
            await conn.execute(text(
                "ALTER TABLE orders ADD COLUMN IF NOT EXISTS spread_revenue NUMERIC(18,8) DEFAULT 0"
            ))
    except Exception as e:
        logger.warning("startup DDL skipped: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _apply_startup_ddl()
    yield
    await engine.dispose()


app = FastAPI(
    title="SwisDex Admin API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs" if app_settings.ENVIRONMENT == "development" else None,
    redoc_url="/redoc" if app_settings.ENVIRONMENT == "development" else None,
    openapi_url="/openapi.json" if app_settings.ENVIRONMENT == "development" else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=_cors_methods,
    allow_headers=_cors_headers,
)

add_middleware_stack(app)


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception):
    """Return JSON (not plain text) so proxies and the admin UI can parse errors."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


prefix = "/api/v1/admin"

app.include_router(auth.router, prefix=prefix)
app.include_router(dashboard.router, prefix=prefix)
app.include_router(users.router, prefix=prefix)
app.include_router(trades.router, prefix=prefix)
app.include_router(book.router, prefix=prefix)
app.include_router(deposits.router, prefix=prefix)
app.include_router(banks.router, prefix=prefix)
app.include_router(routes_config.router, prefix=prefix)
app.include_router(instruments_admin.router, prefix=prefix)
app.include_router(business.router, prefix=prefix)
app.include_router(social.router, prefix=prefix)
app.include_router(analytics.router, prefix=prefix)
app.include_router(bonus.router, prefix=prefix)
app.include_router(banners.router, prefix=prefix)
app.include_router(support.router, prefix=prefix)
app.include_router(employees.router, prefix=prefix)
app.include_router(tasks_admin.router, prefix=f"{prefix}/tasks")
app.include_router(settings.router, prefix=prefix)
app.include_router(transactions.router, prefix=prefix)
app.include_router(kyc.router, prefix=prefix)
app.include_router(account_types.router, prefix=prefix)
app.include_router(user_audit_logs.router, prefix=prefix)
app.include_router(insurance_admin.router, prefix=prefix)
app.include_router(fixed_return_admin.router, prefix=prefix)
app.include_router(play_zone_admin.router, prefix=prefix)
app.include_router(lifestyle_admin.router, prefix=prefix)
app.include_router(approvals.router, prefix=f"{prefix}/approvals", tags=["Approvals"])
app.include_router(notifications.router, prefix=prefix)
app.include_router(broadcast.router, prefix=prefix)
app.include_router(rm_admin.router, prefix=prefix)
app.include_router(expenses_admin.router, prefix=prefix)
app.include_router(risk_admin.router, prefix=prefix)


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "admin"}
