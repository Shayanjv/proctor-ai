from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Column, DateTime, Integer, String

from .base import Base


class SebTokenConsumed(Base):
    """
    One row per redeemed SEB auto-login token.

    Used to enforce the *single-use* property of the short-lived token that
    the FE embeds into the .seb config's startURL. The token's `jti` claim
    is inserted here at the moment it is redeemed; any subsequent redeem
    attempt with the same `jti` fails on the primary-key conflict and is
    rejected as a replay.

    Rows are kept indefinitely for audit purposes — they are tiny (a UUID
    plus a timestamp) and let us answer "did this token get redeemed twice
    (replay attempt)?" later.
    """

    __tablename__ = "seb_token_consumed"

    # JWT `jti` claim — UUID4 hex (32 chars). PRIMARY KEY enforces single-use.
    jti: Any = Column(String(64), primary_key=True)  # type: ignore

    # Audit metadata.
    consumed_at: Any = Column(DateTime, default=datetime.utcnow, nullable=False)  # type: ignore
    user_id: Any = Column(Integer, index=True, nullable=False)  # type: ignore
    exam_id: Any = Column(Integer, index=True, nullable=True)  # type: ignore
