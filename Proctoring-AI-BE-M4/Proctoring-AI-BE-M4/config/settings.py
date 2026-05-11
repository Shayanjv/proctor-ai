from pydantic_settings import BaseSettings
from pydantic import Field
from functools import lru_cache
import os
import json
from dotenv import load_dotenv
import secrets
from typing import List, Union

load_dotenv()

def generate_secret_key():
    return os.getenv("JWT_SECRET_KEY") or secrets.token_hex(64)

def parse_csv_env(value: Union[str, List[str], None]) -> List[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]

    raw = (value or "").strip()
    if not raw:
        return []
    if raw == "*":
        return ["*"]

    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass

    return [item.strip() for item in raw.split(",") if item.strip()]

class Settings(BaseSettings):

    # Database settings
    DB_TYPE: str = Field(default="postgres")
    # Support both new POSTGRES_ vars and old MYSQL vars for backward compatibility/migration
    DB_USER: str = Field(default="postgres", alias="POSTGRES_USER")
    DB_PASSWORD: str = Field(default="", alias="POSTGRES_PASSWORD")
    # DATABASE_HOST takes absolute priority for Docker networking
    DB_HOST: str = Field(default=os.getenv("DATABASE_HOST", "db")) 
    DB_NAME: str = Field(default=os.getenv("POSTGRES_DB", "proctoring_ai"), alias="POSTGRES_DB")
    DB_PORT: int = Field(default=int(os.getenv("DATABASE_PORT", "5432")))
    
    # MinIO
    MINIO_ENDPOINT: str = Field(default=os.getenv("MINIO_ENDPOINT", ""))
    MINIO_ACCESS_KEY: str = Field(default=os.getenv("MINIO_ACCESS_KEY", ""))
    MINIO_SECRET_KEY: str = Field(default=os.getenv("MINIO_SECRET_KEY", ""))
    MINIO_BUCKET_NAME: str = Field(default="evidence-bucket")
    MINIO_SECURE: bool = Field(default=False)

    # LTI Configuration (Plugin Mode)
    LTI_ISSUER: str = Field(default="https://canvas.instructure.com") # The LMS URL
    LTI_CLIENT_ID: str = Field(default="proctoring-ai-tool") # Our ID in the LMS
    LTI_AUTH_URL: str = Field(default="") # LMS Authorization Endpoint
    LTI_TOKEN_URL: str = Field(default="") # LMS Token Endpoint
    LTI_JWKS_URL: str = Field(default="") # LMS Public Keys
    
    # Allowed Domains for Identity Security
    ALLOWED_EMAIL_DOMAINS: list[str] = Field(default=[]) # e.g. ["@university.edu"]
    
    # SQLite fallback
    SQLITE_URL: str = Field(default="sqlite:///./test.db")

    # JWT Settings
    JWT_SECRET_KEY: str = Field(default_factory=generate_secret_key)
    JWT_ALGORITHM: str = "HS256"
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    
    # SEB Settings
    SEB_STRICT_MODE: bool = Field(default=False)
    SEB_CONFIG_KEY: str = Field(default=os.getenv("SEB_CONFIG_KEY", "change-me-seb-key"))
    SEB_config_key: str = Field(default=os.getenv("SEB_CONFIG_KEY", "change-me-seb-key")) # Alias used by seb_service.py

    # ─────────────────────────────────────────────────────────────────────
    # SEB auto-login redeem token.
    #
    # The student authenticates in their REGULAR browser (so they can paste
    # temporary passwords / use a password manager) and clicks "Open in
    # SEB". The FE asks the backend to mint a short-lived single-use token
    # which is embedded into the .seb config's startURL. When SEB loads the
    # frontend, that page redeems the token for a normal JWT — so the
    # student never sees a login screen INSIDE Safe Exam Browser.
    #
    # The TTL is intentionally short: it should be long enough for SEB to
    # cold-start (~30s on slow machines) and reach the FE, but short enough
    # that a leaked link can't be replayed later. Single-use enforcement
    # via the `seb_token_consumed` table makes the TTL a backstop, not the
    # primary defence.
    # ─────────────────────────────────────────────────────────────────────
    SEB_TOKEN_TTL_SECONDS: int = Field(
        default=int(os.getenv("SEB_TOKEN_TTL_SECONDS", "300"))
    )

    # ─────────────────────────────────────────────────────────────────────
    # Mark-penalty engine (services/mark_penalty_service.py).
    #
    # AI-recommended deduction off the raw exam score, computed from MAJOR
    # proctor violations only (CRITICAL events count at a multiplier).
    # MINOR events (tab_switch, copy_paste) are *never* penalised here —
    # they remain in the strike engine for termination but do not move
    # marks. The admin always has the final say (Original / Adjusted /
    # Manual) via POST /admin/session/{id}/score-decision.
    # ─────────────────────────────────────────────────────────────────────
    PROCTOR_MARK_PENALTY_FREE_STRIKES: int = Field(
        default=int(os.getenv("PROCTOR_MARK_PENALTY_FREE_STRIKES", "1"))
    )
    PROCTOR_MARK_PENALTY_PER_MAJOR_PCT: float = Field(
        default=float(os.getenv("PROCTOR_MARK_PENALTY_PER_MAJOR_PCT", "5"))
    )
    PROCTOR_MARK_PENALTY_CRITICAL_MULTIPLIER: float = Field(
        default=float(os.getenv("PROCTOR_MARK_PENALTY_CRITICAL_MULTIPLIER", "2"))
    )
    PROCTOR_MARK_PENALTY_CAP_PCT: float = Field(
        default=float(os.getenv("PROCTOR_MARK_PENALTY_CAP_PCT", "30"))
    )

    # Server settings
    SERVER_HOST: str = Field(default="0.0.0.0")
    SERVER_PORT: int = Field(default=8080, alias="PORT")
    API_DOMAIN: str = Field(default=os.getenv("API_DOMAIN", ""))
    WS_BASE_URL: str = Field(default=os.getenv("WS_BASE_URL", ""))
    STUDENT_FRONTEND_URL: str = Field(default=os.getenv("STUDENT_FRONTEND_URL", ""))
    ADMIN_FRONTEND_URL: str = Field(default=os.getenv("ADMIN_FRONTEND_URL", ""))
    CORS_ORIGINS: str = Field(default=os.getenv("CORS_ORIGINS", ""))

    # Optional Redis (login attempts). Empty = in-memory fallback for dev/single worker.
    REDIS_URL: str = Field(default=os.getenv("REDIS_URL", ""))

    # Liveness (challenge/nonce) settings
    LIVENESS_CHALLENGE_TTL_SEC: int = Field(default=int(os.getenv("PROCTOR_LIVENESS_CHALLENGE_TTL_SEC", "120")))

    # Rate limiting (auth / liveness)
    AUTH_RATE_LIMIT_WINDOW_SEC: int = Field(default=int(os.getenv("PROCTOR_AUTH_RATE_LIMIT_WINDOW_SEC", "60")))
    AUTH_LOGIN_ATTEMPT_LIMIT: int = Field(default=int(os.getenv("PROCTOR_AUTH_LOGIN_ATTEMPT_LIMIT", "8")))
    AUTH_LIVENESS_CHALLENGE_LIMIT: int = Field(default=int(os.getenv("PROCTOR_AUTH_LIVENESS_CHALLENGE_LIMIT", "12")))
    AUTH_FACE_SUBMIT_LIMIT: int = Field(default=int(os.getenv("PROCTOR_AUTH_FACE_SUBMIT_LIMIT", "10")))

    # Face verification safety timeout (seconds) for blocking model calls.
    PROCTOR_FACE_VERIFY_TIMEOUT_SEC: int = Field(default=int(os.getenv("PROCTOR_FACE_VERIFY_TIMEOUT_SEC", "120")))

    # Policy termination (strike engine)
    PROCTOR_STRIKE_STATE_TTL_SEC: int = Field(default=int(os.getenv("PROCTOR_STRIKE_STATE_TTL_SEC", "21600")))  # 6h
    PROCTOR_MAJOR_STRIKES_WARN: int = Field(default=int(os.getenv("PROCTOR_MAJOR_STRIKES_WARN", "3")))
    PROCTOR_MAJOR_STRIKES_TERMINATE: int = Field(default=int(os.getenv("PROCTOR_MAJOR_STRIKES_TERMINATE", "6")))
    PROCTOR_CRITICAL_TERMINATE_IMMEDIATELY: bool = Field(
        default=(os.getenv("PROCTOR_CRITICAL_TERMINATE_IMMEDIATELY", "1").strip().lower() not in {"0", "false", "no", "off"})
    )
    # Optional per-event critical thresholds, e.g. "face_spoofing=1,phone_detected=2,identity_mismatch=2"
    PROCTOR_CRITICAL_EVENT_THRESHOLDS: str = Field(default=os.getenv("PROCTOR_CRITICAL_EVENT_THRESHOLDS", ""))
    PROCTOR_STRIKE_EVENT_COOLDOWN_SEC: float = Field(default=float(os.getenv("PROCTOR_STRIKE_EVENT_COOLDOWN_SEC", "10")))
    
    # LTI Security Keys (RSA in PEM format)
    LTI_PRIVATE_KEY: str = Field(default="")
    LTI_PUBLIC_KEY: str = Field(default="")

@lru_cache()
def get_settings() -> Settings:
    return Settings()

settings = get_settings()
