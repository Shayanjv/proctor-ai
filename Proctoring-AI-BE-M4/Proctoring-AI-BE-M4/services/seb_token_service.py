"""
Single-use auto-login tokens for the Safe Exam Browser launch flow.

The student authenticates in their REGULAR browser first (so they can
paste a temporary password / use a password manager). When they click
"Open in SEB", the FE asks the backend to *issue* a short-lived token
that gets baked into the `.seb` config's startURL as a query param. SEB
launches the FE which immediately *redeems* that token for a normal JWT
— skipping the lockdown-with-no-clipboard login screen entirely.

Two security guarantees layered together:
    1. **Signed**: the token is a JWT (HS256, same secret as the regular
       access token) with a dedicated `purpose=seb_redeem` claim. The
       redeem endpoint refuses anything that doesn't carry that claim,
       so a stolen access token can't be used here, and vice versa.
    2. **Single-use**: the `jti` claim is inserted into the
       `seb_token_consumed` table at redeem time. Replays fail on PK
       conflict.

Plus a 5-minute TTL (configurable) as a backstop.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional
from uuid import uuid4

from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from config.settings import settings
from models.seb_token_consumed import SebTokenConsumed


SEB_TOKEN_PURPOSE = "seb_redeem"


@dataclass(frozen=True)
class SebTokenClaims:
    """Decoded payload of a successfully verified SEB token."""

    sub: str           # user email (matches the `sub` claim used by /login)
    user_id: int
    exam_id: Optional[int]
    jti: str


class SebTokenService:
    """All operations are static — no instance state needed."""

    # ── ISSUE ─────────────────────────────────────────────────────────────

    @staticmethod
    def issue(*, user_email: str, user_id: int, exam_id: Optional[int]) -> str:
        """
        Mint a fresh redeem token for the given (user, exam) pair.

        The TTL comes from `settings.SEB_TOKEN_TTL_SECONDS` and a fresh
        random `jti` (UUID4 hex) is embedded so single-use can be enforced
        downstream.
        """
        now = datetime.utcnow()
        ttl = max(int(settings.SEB_TOKEN_TTL_SECONDS or 300), 30)
        payload = {
            "sub": user_email,
            "user_id": int(user_id),
            "exam_id": int(exam_id) if exam_id is not None else None,
            "purpose": SEB_TOKEN_PURPOSE,
            "jti": uuid4().hex,
            "iat": now,
            "exp": now + timedelta(seconds=ttl),
        }
        return jwt.encode(
            payload,
            settings.JWT_SECRET_KEY,
            algorithm=settings.JWT_ALGORITHM,
        )

    # ── VERIFY + CONSUME (atomic) ─────────────────────────────────────────

    @staticmethod
    def redeem(token: str, db: Session) -> SebTokenClaims:
        """
        Verify the signature, expiry, purpose claim, and *consume* the jti.

        Returns the decoded claims so the caller can issue a regular JWT
        bound to the same user. Raises HTTPException(401) on any failure
        (bad signature, expired, wrong purpose, already-redeemed).

        Consumption is atomic via a PK insert on `seb_token_consumed`. A
        replay (or two simultaneous redeems racing) loses the race and
        gets a 401.
        """
        if not token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing SEB token.",
            )

        try:
            payload = jwt.decode(
                token,
                settings.JWT_SECRET_KEY,
                algorithms=[settings.JWT_ALGORITHM],
            )
        except JWTError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="SEB token is invalid or expired.",
            ) from exc

        if payload.get("purpose") != SEB_TOKEN_PURPOSE:
            # Defence in depth: refuse a regular access token used here.
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="SEB token has the wrong purpose.",
            )

        sub = payload.get("sub")
        user_id = payload.get("user_id")
        jti = payload.get("jti")
        exam_id = payload.get("exam_id")

        if not sub or user_id is None or not jti:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="SEB token is malformed.",
            )

        # Mark consumed BEFORE returning success. PK conflict = replay.
        try:
            db.add(SebTokenConsumed(
                jti=str(jti),
                user_id=int(user_id),
                exam_id=int(exam_id) if exam_id is not None else None,
            ))
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="SEB token has already been used.",
            )

        return SebTokenClaims(
            sub=str(sub),
            user_id=int(user_id),
            exam_id=int(exam_id) if exam_id is not None else None,
            jti=str(jti),
        )
