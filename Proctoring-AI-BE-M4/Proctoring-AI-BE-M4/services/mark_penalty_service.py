"""
Mark-penalty engine.

Translates proctor violations into a recommended deduction off the raw exam
score. Only MAJOR and CRITICAL events count — minor events such as
``tab_switch`` and ``copy_paste`` are deliberately excluded so a noisy lab
network or accidental Cmd+C never reduces a student's marks.

The output is *advisory*: it lives on ``ExamSession`` as
``proctor_adjusted_score`` / ``proctor_penalty_pct``. The admin still picks
the final score (Original / Adjusted / Manual) via the score-decision
endpoint. We never silently award a penalised score to the student.

Formula (defaults; all env-tunable in ``config/settings.py``):

    free_strikes = 1                 # first major is a warning, not a hit
    per_major_pct = 5.0              # each non-critical major after free
    per_critical_pct = 10.0          # = per_major * critical_multiplier (2)
    cap_pct = 30.0                   # a single attempt can lose at most 30%

    raw_majors_after_grace = max(0, major_count - free_strikes)
    pct = raw_majors_after_grace * per_major_pct + critical_count * per_critical_pct
    pct = min(pct, cap_pct)
    deducted = total_marks * pct / 100
    adjusted_score = max(0, raw_score - deducted)

If a student triggers a critical event on their first strike, the free-strike
grace is consumed by the critical (not by the easier-going non-critical) so
that a single ``identity_mismatch`` still costs them — only repeated minor
majors get the grace.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, Iterable, List, Optional, Set, Tuple

from config.settings import settings


# Local re-export so callers don't have to import from routers/exam.py and
# create a circular dependency. Kept in sync manually with the canonical
# definition in routers/exam.py.
MAJOR_VIOLATION_EVENT_TYPES: Set[str] = {
    "identity_mismatch",
    "multiple_people",
    "face_not_visible",
    "phone_detected",
    "prohibited_object",
    "screen_share_stopped",
    "camera_blocked_or_disabled",
    "tampering_detected",
    "remote_access_detected",
    "virtual_machine_detected",
    "capture_tool_detected",
    "third_party_communication",
    "abusive_behavior",
    "disruptive_behavior",
    "proctor_abuse",
    "policy_termination",
    "face_spoofing",
}

# A subset of major events that are severe enough to count at the critical
# multiplier rate. Mirrors the spirit of
# ``TerminationPolicyService.CRITICAL_EVENT_TYPES`` but excludes
# ``policy_termination`` (which is a *consequence*, not a cause).
CRITICAL_VIOLATION_EVENT_TYPES: Set[str] = {
    "identity_mismatch",
    "multiple_people",
    "phone_detected",
    "prohibited_object",
    "face_spoofing",
    "screen_share_stopped",
    "camera_blocked_or_disabled",
}

# Events that are NEVER counted toward marks (they may still trigger the
# strike-engine for termination, but they don't move the score).
EXCLUDED_FROM_PENALTY: Set[str] = {
    "tab_switch",
    "copy_paste",
}


@dataclass(frozen=True)
class PenaltyResult:
    """Output of :meth:`MarkPenaltyService.compute_penalty`."""
    free_strikes: int
    major_count: int           # non-critical major occurrences (after grace)
    critical_count: int        # critical occurrences
    penalty_pct: float         # 0..cap, rounded to 2dp
    deducted_marks: float      # rounded to 2dp
    adjusted_score: float      # rounded to 2dp, never below 0
    config_snapshot: Dict[str, float]

    def to_dict(self) -> Dict[str, object]:
        return asdict(self)


class MarkPenaltyService:
    """Pure functions — no DB access, no I/O. Easy to unit test."""

    # ────────────────────────────── config ──────────────────────────────

    @staticmethod
    def _free_strikes() -> int:
        try:
            return max(0, int(getattr(settings, "PROCTOR_MARK_PENALTY_FREE_STRIKES", 1) or 0))
        except Exception:
            return 1

    @staticmethod
    def _per_major_pct() -> float:
        try:
            return max(0.0, float(getattr(settings, "PROCTOR_MARK_PENALTY_PER_MAJOR_PCT", 5.0) or 0.0))
        except Exception:
            return 5.0

    @staticmethod
    def _critical_multiplier() -> float:
        try:
            return max(0.0, float(getattr(settings, "PROCTOR_MARK_PENALTY_CRITICAL_MULTIPLIER", 2.0) or 0.0))
        except Exception:
            return 2.0

    @staticmethod
    def _cap_pct() -> float:
        try:
            return max(0.0, min(100.0, float(getattr(settings, "PROCTOR_MARK_PENALTY_CAP_PCT", 30.0) or 0.0)))
        except Exception:
            return 30.0

    @classmethod
    def config_snapshot(cls) -> Dict[str, float]:
        return {
            "free_strikes": float(cls._free_strikes()),
            "per_major_pct": cls._per_major_pct(),
            "critical_multiplier": cls._critical_multiplier(),
            "per_critical_pct": cls._per_major_pct() * cls._critical_multiplier(),
            "cap_pct": cls._cap_pct(),
        }

    # ───────────────────────────── counting ─────────────────────────────

    @classmethod
    def count_major_and_critical(
        cls,
        event_types: Iterable[str],
    ) -> Tuple[int, int]:
        """
        Count occurrences of major (non-critical) and critical events from a
        flat iterable of event_type strings (one per log row). MINOR events
        and unknown events return (0, 0).

        Returns ``(major_non_critical_count, critical_count)``.
        """
        major_non_critical = 0
        critical = 0
        for raw in event_types:
            ev = (raw or "").strip()
            if not ev or ev in EXCLUDED_FROM_PENALTY:
                continue
            if ev in CRITICAL_VIOLATION_EVENT_TYPES:
                critical += 1
            elif ev in MAJOR_VIOLATION_EVENT_TYPES:
                major_non_critical += 1
        return major_non_critical, critical

    # ───────────────────────────── compute ──────────────────────────────

    @classmethod
    def compute_penalty(
        cls,
        *,
        major_count: int,
        critical_count: int,
        raw_score: float,
        total_marks: float,
    ) -> PenaltyResult:
        """
        Compute the AI-recommended deduction.

        ``major_count`` is the count of non-critical majors. ``critical_count``
        is counted separately at the critical multiplier rate (no grace).
        """
        free = cls._free_strikes()
        per_major = cls._per_major_pct()
        per_critical = per_major * cls._critical_multiplier()
        cap = cls._cap_pct()

        major_after_grace = max(0, int(major_count) - max(0, free))
        critical_safe = max(0, int(critical_count))
        raw_safe = max(0.0, float(raw_score or 0.0))
        total_safe = max(0.0, float(total_marks or 0.0))

        pct = (major_after_grace * per_major) + (critical_safe * per_critical)
        pct = min(pct, cap)
        if pct < 0:
            pct = 0.0

        deducted = (total_safe * pct) / 100.0
        adjusted = max(0.0, raw_safe - deducted)

        return PenaltyResult(
            free_strikes=free,
            major_count=int(major_count),
            critical_count=critical_safe,
            penalty_pct=round(pct, 2),
            deducted_marks=round(deducted, 2),
            adjusted_score=round(adjusted, 2),
            config_snapshot=cls.config_snapshot(),
        )

    @classmethod
    def compute_from_logs(
        cls,
        log_rows: Iterable[object],
        *,
        raw_score: float,
        total_marks: float,
    ) -> PenaltyResult:
        """
        Convenience helper: accepts an iterable of objects exposing an
        ``event_type`` attribute (e.g. SQLAlchemy ``Log`` rows) and returns
        the same :class:`PenaltyResult`.
        """
        events: List[str] = []
        for row in log_rows:
            ev = getattr(row, "event_type", None)
            if isinstance(ev, str):
                events.append(ev)
        major, critical = cls.count_major_and_critical(events)
        return cls.compute_penalty(
            major_count=major,
            critical_count=critical,
            raw_score=raw_score,
            total_marks=total_marks,
        )
