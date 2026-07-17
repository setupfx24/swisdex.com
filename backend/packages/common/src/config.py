from functools import lru_cache

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings


# Sentinel default values that MUST be overridden in any non-development environment.
# Startup fails fast if ENVIRONMENT != "development" and any of these are still in use.
_INSECURE_DEFAULTS: dict[str, set[str]] = {
    "JWT_SECRET":         {"dev-secret-change-in-production", "", "changeme"},
    "USER_JWT_SECRET":    {"dev-secret-change-in-production", "", "changeme"},
    "ADMIN_JWT_SECRET":   {"admin-secret-change-in-production", "dev-secret-change-in-production", "", "changeme"},
    "ADMIN_PASSWORD":     {"SwisDexAdmin2025!", "admin", "password", ""},
}


class Settings(BaseSettings):
    ENVIRONMENT: str = "development"
    DATABASE_URL: str = "postgresql+asyncpg://swisdex:swisdex_dev@localhost:5432/swisdex"
    TIMESCALE_URL: str = "postgresql+asyncpg://swisdex:swisdex_dev@localhost:5433/marketdata"
    REDIS_URL: str = "redis://localhost:6379/0"

    JWT_SECRET: str = "dev-secret-change-in-production"
    JWT_ALGORITHM: str = "HS256"
    # Short-lived access JWT (browser cookie + optional JSON for legacy clients).
    JWT_ACCESS_EXPIRY_MINUTES: int = Field(
        default=45,
        validation_alias=AliasChoices("JWT_ACCESS_EXPIRY_MINUTES", "JWT_EXPIRY_MINUTES"),
    )
    # Refresh token row expiry in DB (rotation); still enforced when validating refresh.
    JWT_REFRESH_EXPIRY_DAYS: int = 7
    # If True, both access + refresh HttpOnly cookies omit Max-Age (browser session cookies).
    # Closing the browser session clears them — user must log in again. If False, cookies use
    # Max-Age (access ~JWT_ACCESS_EXPIRY_MINUTES, refresh JWT_REFRESH_EXPIRY_DAYS) so login
    # survives browser restarts.
    JWT_REFRESH_SESSION_COOKIE: bool = True
    # Still return access_token in login/register JSON (phase out when all clients use cookies only).
    JWT_INCLUDE_LEGACY_JSON_TOKEN: bool = True
    # Include the raw refresh token in the JSON body of /auth/login,
    # /auth/google, /auth/wallet/verify, /auth/refresh, etc. Required
    # for mobile clients (which cannot use HttpOnly cookies). Web does
    # not need this — it reads pt_refresh from the cookie. Default
    # false in production; flip to true in .env when mobile is deployed.
    JWT_INCLUDE_REFRESH_IN_JSON: bool = False

    # HttpOnly auth cookies (trader web). Secure derived from request HTTPS unless overridden.
    ACCESS_TOKEN_COOKIE_NAME: str = "pt_access"
    REFRESH_TOKEN_COOKIE_NAME: str = "pt_refresh"
    COOKIE_SAMESITE: str = "strict"  # lax | strict | none
    # If None, Secure flag follows the incoming request (HTTPS / X-Forwarded-Proto).
    COOKIE_SECURE: bool | None = None
    # Cookie Domain attribute. Set to a parent domain (e.g. ".swisdex.com") to share
    # the auth session across the apex and subdomains (trade.*, etc.). Leave empty to
    # let the browser set a host-only cookie (works for single-host dev/local setups).
    COOKIE_DOMAIN: str = ""

    # Google OAuth (Sign in / Sign up with Google). Verifies id_token audience offline
    # against Google's JWKS — no client secret stored on our infra. When empty, the
    # /auth/google endpoint returns 503 and the frontend hides the button.
    GOOGLE_CLIENT_ID: str = ""

    ADMIN_JWT_SECRET: str = "admin-secret-change-in-production"
    ADMIN_JWT_ALGORITHM: str = "HS256"
    ADMIN_JWT_EXPIRY_HOURS: int = 8

    ADMIN_EMAIL: str = "admin@swisdex.com"
    ADMIN_PASSWORD: str = "SwisDexAdmin2025!"
    USER_JWT_SECRET: str = "dev-secret-change-in-production"
    USER_JWT_ALGORITHM: str = "HS256"

    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:3001"
    CORS_ALLOW_METHODS: str = "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    CORS_ALLOW_HEADERS: str = "Authorization,Content-Type,X-Requested-With,Accept,X-Api-Key,X-Api-Secret"

    # Public trader app URL (password reset links). No trailing slash.
    TRADER_APP_URL: str = "http://localhost:3000"

    # Email branding — used by the shared layout in email_templates/base.py.
    # EMAIL_LOGO_URL must be an absolute https URL because email clients
    # cannot resolve relative paths or render images from blob/data URIs.
    # If empty, the layout falls back to the styled "SwisDex" wordmark text.
    # The email header renders on a DARK band (email_templates/base.py), so the
    # logo must be the WHITE-lettered asset (swisdex_png5.png). A dark header is
    # the only reliable choice across clients: Gmail's dark mode forcibly
    # darkens light backgrounds (which made the old dark-lettered logo on a
    # white header vanish), but it never lightens an already-dark background —
    # so a white logo on a dark header stays visible in both light and dark
    # mode. Override in .env if a tenant ships a custom logo. Must be an
    # absolute https URL because email clients can't resolve relative paths.
    EMAIL_LOGO_URL: str = "https://swisdex.com/images/swisdex_png5.png"

    # Mobile app store links — when set, the email footer renders the
    # "Get the app" section with App Store + Google Play badges. Leave
    # either empty to hide just that badge; leave both empty to hide the
    # whole section. The badges themselves are served from EMAIL_*_BADGE_URL.
    IOS_APP_URL: str = ""
    ANDROID_APP_URL: str = ""
    EMAIL_IOS_BADGE_URL: str = "https://swisdex.com/images/email/app-store-badge.png"
    EMAIL_ANDROID_BADGE_URL: str = "https://swisdex.com/images/email/google-play-badge.png"

    # Optional SMTP — required for password-reset emails in non-dev. If SMTP_HOST is empty, reset links are only logged in development.
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""
    # Display name shown in the user's inbox (e.g. "SwisDex <noreply@…>").
    # We wrap whatever address SMTP_FROM holds with this display name, so
    # the inbox preview reads "SwisDex" even if the mail provider's
    # underlying account is named differently.
    MAIL_FROM_NAME: str = "SwisDex"
    SMTP_USE_TLS: bool = True
    # Comma-separated exact addresses that must NEVER be emailed — team test
    # accounts whose mailbox doesn't exist (e.g. ib1@gmail.com). Every mail to
    # them hard-bounces back to the sender inbox and, in volume, damages
    # sender reputation. Checked at the single send choke point (smtp_mail).
    EMAIL_SUPPRESSION_LIST: str = ""

    # ─── Per-category From aliases (Hostinger / any SMTP) ────────────────
    # SMTP authenticates as SMTP_USER (the mailbox owner) but the visible
    # `From:` header is selected by the call site's category so users see
    # mails coming from a topical address (account@, voucher@, …) instead
    # of a single noreply.
    #
    # All blank by default — when blank, the call falls back to SMTP_FROM
    # / SMTP_USER (the legacy single-address behaviour). Once you set them,
    # category-tagged sends use the alias automatically.
    #
    # The aliases MUST already exist in your mail provider (e.g. Hostinger
    # alias config) AND the provider must allow sending as the alias under
    # the authenticated mailbox. Hostinger's default is to allow this.
    SMTP_FROM_ACCOUNT: str = ""      # deposit / withdrawal mails
    SMTP_FROM_INSURE: str = ""       # insured-trade payouts + reminders
    SMTP_FROM_AFFILIATES: str = ""   # IB / PAMM / MAM
    SMTP_FROM_VOUCHER: str = ""      # bonus + referral
    SMTP_FROM_STACKING: str = ""     # fixed-return + staking
    SMTP_FROM_INFO: str = ""         # generic website-side mails (default)
    SMTP_FROM_SUPPORT: str = ""      # auth / KYC / password reset

    # ─── Cloudflare Turnstile (bot protection on /auth/register) ─────────
    # When both are set, the register endpoint requires a valid Turnstile
    # token from the client; we POST it to challenges.cloudflare.com/turnstile
    # /v0/siteverify with the SECRET to confirm it really came from a real
    # browser. Leave SECRET empty in dev to skip verification entirely.
    # Get a site/secret pair at https://dash.cloudflare.com → Turnstile.
    CLOUDFLARE_TURNSTILE_SECRET_KEY: str = ""

    # ─── InfoWay — market-data provider (preferred when set) ────────────
    # https://docs.infoway.io — REST + WebSocket for forex / metals /
    # crypto / commodities / equities. Auth via `apikey` URL query param.
    # When INFOWAY_TOKEN is set, market-data picks InfoWay before AllTick
    # and before the simulator. Channel: depth (10003 → 10005) for best
    # bid/ask; falls back to trade ticks (10000 → 10002) when depth is
    # not licensed on the symbol. Heartbeat 10010 every ~30s.
    INFOWAY_TOKEN: str = ""
    INFOWAY_WS_URL: str = "wss://data.infoway.io/ws"
    # Client 2026-06-20: NEVER show simulated/mock prices. When the real feed
    # (InfoWay/AllTick) sends nothing — closed market, weekend, token/plan
    # issue — quotes must FREEZE on the last real price, not switch to the GBM
    # simulator (which invented e.g. XAUUSD ~2000). Set to true ONLY for local
    # dev without a feed token.
    ALLOW_SIMULATED_FEED: bool = False
    # Business segment for the WS URL (?business=common). InfoWay routes
    # forex / crypto / commodities under "common"; equities have separate
    # business codes per their docs. Override only if the account requires it.
    INFOWAY_BUSINESS: str = "common"
    # Subscribe channel: "depth" uses 10003/10005 (best bid + best ask);
    # "trade" uses 10000/10002 (last trade price, mid-only — bid==ask).
    # Verified on the free plan (2026-07-08): the DEPTH channel accepts the
    # subscribe (code 10001/10004 "ok") but pushes ZERO 10005 frames, whereas
    # the TRADE channel streams 10002 ticks fine → live bid/ask flow again.
    # Default to "trade" so a fresh deploy stays live; on a paid plan where
    # depth pushes, set INFOWAY_CHANNEL=depth in .env for true bid/ask.
    INFOWAY_CHANNEL: str = "trade"
    # Seconds between reconcile REST calls (closed-bar re-assert vs official OHLC).
    # 3s suits the free plan's 60/min cap; on the paid $199 plan (600/min) drop to
    # ~1.0–1.5 for near-real-time candle reconciliation. (client 2026-07-09)
    INFOWAY_RECONCILE_SPACING: float = 3.0
    # REST-to-tick bridge (client 2026-07-09): the free InfoWay plan's WS
    # subscribes OK but pushes NO live frames, so bid/ask + the forming candle
    # freeze while REST batch_kline keeps working. When true, market-data polls
    # REST for each forex/metals/indices symbol's latest close (~2s) and feeds
    # it through the normal tick pipeline — restoring live prices + filling
    # candle gaps. Per-symbol staleness gate makes it a no-op once a real WS
    # tick streams (e.g. after buying a paid plan). Set false to disable.
    INFOWAY_REST_BRIDGE_ENABLED: bool = False
    # Free InfoWay plan hard-caps WS subscriptions at 10 — subscribing to more
    # makes InfoWay REJECT the WHOLE subscription (error 516) so ZERO ticks
    # arrive. Subscribe to ONLY these priority symbols (<=10) so the WS is
    # accepted and streams live ticks; the rest degrade to REST/history.
    # Crypto is served live by Binance, so keep this to forex/metals/indices.
    # Comma-separated platform symbols; empty = all instruments (will exceed
    # the cap on the free plan). Raise/replace this list on a paid plan.
    INFOWAY_WS_SYMBOLS: str = "XAUUSD,XAGUSD,EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,US30,US500"

    # ─── AllTick — market-data provider (used when InfoWay is empty) ────
    # Real-time forex / metals / crypto / indices CFD ticks via WebSocket.
    # Get a token at https://alltick.co (paid plan required for full
    # symbol coverage; free tier limits to 5 symbols / 1 connection).
    # When ALLTICK_TOKEN is empty or a placeholder, market-data falls back
    # to FeedSimulator + Binance (crypto only) so the platform still runs
    # in dev / unfunded environments.
    ALLTICK_TOKEN: str = ""
    # Override only if AllTick directs you to a regional endpoint.
    ALLTICK_FOREX_WS_URL: str = "wss://quote.alltick.co/quote-b-ws-api"
    ALLTICK_STOCK_WS_URL: str = "wss://quote.alltick.co/quote-stock-b-ws-api"

    # Corecen LP (alternate primary market data source). When CORECEN_LP_ENABLED=true
    # the market-data service stops running its own AllTick / simulator feed and
    # consumes ticks pushed from Corecen via POST /api/lp/prices/batch (HMAC).
    CORECEN_LP_ENABLED: bool = False
    # HMAC credentials — must match SWISDEX_API_KEY / SWISDEX_API_SECRET in the Corecen .env.
    CORECEN_LP_API_KEY: str = ""
    CORECEN_LP_API_SECRET: str = ""
    # Reject pushes older than this many ms (same tolerance as Corecen's HMAC middleware).
    CORECEN_LP_TIMESTAMP_TOLERANCE_MS: int = 60_000

    # Corecen Broker API (A-Book trade forwarding). When an A-Book user opens/closes
    # a position, SwisDex pushes the trade to Corecen's broker API for LP routing.
    # These credentials are the API key/secret registered in Corecen's admin panel
    # for the SwisDex broker account.
    CORECEN_BROKER_API_URL: str = ""       # e.g. https://api.corecen.com
    CORECEN_BROKER_API_KEY: str = ""       # ck_... from Corecen broker API keys
    CORECEN_BROKER_API_SECRET: str = ""    # cs_... from Corecen broker API keys

    MARGIN_CALL_LEVEL: float = 80.0
    STOP_OUT_LEVEL: float = 50.0
    MAX_OPEN_TRADES: int = 200
    DEFAULT_LEVERAGE: int = 100

    # Sentry error tracking (leave empty to disable)
    SENTRY_DSN: str = ""
    SENTRY_TRACES_SAMPLE_RATE: float = 0.1

    # SlowAPI middleware-level limit (currently disabled — per-endpoint
    # rate_limit_http() in auth_service.py provides Redis sliding-window
    # throttling on the actual brute-force surfaces). Kept for future use.
    RATE_LIMIT_DEFAULT: str = "1000000/minute"
    RATE_LIMIT_AUTH: str = "1000000/minute"
    RATE_LIMIT_TRADING: str = "1000000/minute"

    # Request body size limit (bytes) — 10 MB default
    MAX_REQUEST_SIZE: int = 10 * 1024 * 1024

    # OxaPay crypto payment gateway (legacy — kept mounted for in-flight + historical deposits)
    OXAPAY_MERCHANT_KEY: str = ""
    OXAPAY_SANDBOX: bool = False
    OXAPAY_CALLBACK_BASE_URL: str = ""  # public gateway URL for webhooks, e.g. "https://api.yourdomain.com"

    # NOWPayments crypto payment gateway (current default for new deposits).
    NOWPAYMENTS_API_KEY: str = ""
    NOWPAYMENTS_IPN_SECRET: str = ""    # IPN HMAC secret from dashboard
    NOWPAYMENTS_SANDBOX: bool = False
    NOWPAYMENTS_CALLBACK_BASE_URL: str = ""  # e.g. "https://api.swisdex.com"
    # Automatic crypto WITHDRAWALS (payouts) use the /v1/payout API, which needs
    # a JWT obtained from the account login (separate from the x-api-key used for
    # deposits). Disable whitelisting + 2FA on the NOWPayments dashboard for
    # unattended payouts. Leave blank to keep withdrawals fully manual.
    NOWPAYMENTS_EMAIL: str = ""
    NOWPAYMENTS_PASSWORD: str = ""

    # Absolute path recommended in production (writable volume). Relative paths are resolved from gateway CWD.
    KYC_UPLOAD_ROOT: str = "uploads/kyc"
    # Deposit proof screenshots + user payout QR for manual withdrawals (gateway). Mount same path in admin for review.
    WALLET_UPLOAD_ROOT: str = "uploads/wallet"

    # ─── Admin financial-action thresholds (USD) ──────────────────────────
    # Withdrawals at or above this amount require a second admin to approve
    # (4-eyes rule). Add-fund / deduct-fund go through the same gate.
    # 0 ⇒ EVERY admin fund add/deduct/withdrawal-approval needs a second
    # admin's sign-off (client 2026-06-12 — no direct admin funding at all).
    ADMIN_DUAL_APPROVAL_THRESHOLD: float = 0.0
    # Hard cap for any single admin balance mutation (defense-in-depth, even
    # for a super_admin). Set to 0 to disable.
    ADMIN_BALANCE_MUTATION_CAP: float = 100_000.0

    class Config:
        env_file = ".env"
        # Tolerate env vars meant for OTHER services in a shared .env (e.g. the
        # market-data timescale_* keys). Without this, an unrelated extra key
        # crashes startup with extra_forbidden (2026-06-26).
        extra = "ignore"

    # ─── Fail-closed validation ───────────────────────────────────────────
    @model_validator(mode="after")
    def _enforce_production_secrets(self) -> "Settings":
        """In any non-development environment, refuse to start if critical
        secrets are still set to their well-known defaults. This eliminates
        the most dangerous misconfiguration class — accidentally shipping
        with `dev-secret-change-in-production` as the JWT signing key."""
        if self.ENVIRONMENT.lower() in ("development", "dev", "local", "test"):
            return self
        bad: list[str] = []
        for field, defaults in _INSECURE_DEFAULTS.items():
            value = getattr(self, field, None)
            if value in defaults:
                bad.append(field)
        if bad:
            raise RuntimeError(
                "Refusing to start: the following secrets are still at "
                "insecure defaults — set them via environment variables: "
                + ", ".join(sorted(bad))
            )
        # Reuse of the same secret across user/admin tokens is also unsafe.
        if self.JWT_SECRET == self.ADMIN_JWT_SECRET:
            raise RuntimeError(
                "Refusing to start: JWT_SECRET and ADMIN_JWT_SECRET must be different."
            )
        return self


@lru_cache()
def get_settings() -> Settings:
    return Settings()
