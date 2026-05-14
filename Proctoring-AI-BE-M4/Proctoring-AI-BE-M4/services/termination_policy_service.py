from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from sqlalchemy.orm import Session

from config.settings import settings
from models.exams import Exam
from models.logs import Log
from models.policy_audit import PolicyAudit
from models.sessions import ExamSession
from utils.logger import logger
from utils.strike_store import get_state, set_state
from utils.metrics import POLICY_ACTIONS_TOTAL


# Events that an exam-creator can opt to demote to "warnings only" via the
# per-exam `lenient_mode` config flag. These are the detections most prone to
# false positives in a college-hall setting (other students visible behind the
# camera, laptops on neighbouring desks, etc.). When lenient_mode is on we
# still LOG them (admin can see them in the timeline and decide manually) but
# we do NOT count them toward critical/major strike accumulation or
# termination.
LENIENT_MODE_DEMOTED_EVENTS: Set[str] = {
    "multiple_people",
    "phone_detected",
    "prohibited_object",
}


@dataclass(frozen=True)
class PolicyAction:
    action: str  # "none" | "warn" | "terminate"
    reason: str
    details: Dict[str, Any]


class TerminationPolicyService:
    """
    Strike engine:
    - Minor: terminate when a category reaches its configured threshold.
    - Major: accumulate strikes; warn at N; terminate at M.
    - Critical: optionally terminate immediately on first occurrence.
    """

    # Mirror of routers/exam.py MINOR_TERMINATION_THRESHOLDS (kept here to avoid circular import).
    MINOR_TERMINATION_THRESHOLDS = {
        "tab_switch": int(getattr(settings, "PROCTOR_TAB_SWITCH_TERMINATION_THRESHOLD", 3) or 3),
        "copy_paste": int(getattr(settings, "PROCTOR_COPY_PASTE_TERMINATION_THRESHOLD", 3) or 3),
    }

    # "Critical" events: treat as immediate termination by default.
    CRITICAL_EVENT_TYPES: Set[str] = {
        "identity_mismatch",
        "multiple_people",
        "phone_detected",
        "prohibited_object",
        "face_spoofing",
        "screen_share_stopped",
        "camera_blocked_or_disabled",
        "policy_termination",
    }

    # "Major" events: accumulate strikes.
    MAJOR_EVENT_TYPES: Set[str] = {
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

    @classmethod
    def _now(cls) -> float:
        return time.time()

    @classmethod
    def _cooldown_sec(cls) -> float:
        try:
            return max(0.0, float(getattr(settings, "PROCTOR_STRIKE_EVENT_COOLDOWN_SEC", 10.0) or 10.0))
        except Exception:
            return 10.0

    @classmethod
    def _warn_at(cls) -> int:
        try:
            return max(1, int(getattr(settings, "PROCTOR_MAJOR_STRIKES_WARN", 3) or 3))
        except Exception:
            return 3

    @classmethod
    def _terminate_at(cls) -> int:
        try:
            return max(1, int(getattr(settings, "PROCTOR_MAJOR_STRIKES_TERMINATE", 6) or 6))
        except Exception:
            return 6

    @classmethod
    def _critical_immediate(cls) -> bool:
        return bool(getattr(settings, "PROCTOR_CRITICAL_TERMINATE_IMMEDIATELY", True))

    @classmethod
    def _critical_thresholds(cls) -> Dict[str, int]:
        """
        Per-event thresholds for critical events.

        Env format: "face_spoofing=1,phone_detected=2,identity_mismatch=2"
        If not provided, falls back to the legacy global immediate flag:
        - immediate => all critical events threshold=1
        - not immediate => all critical events threshold=2
        """
        raw = (getattr(settings, "PROCTOR_CRITICAL_EVENT_THRESHOLDS", "") or "").strip()
        thresholds: Dict[str, int] = {}

        if raw:
            for item in raw.split(","):
                token = (item or "").strip()
                if not token:
                    continue
                if "=" not in token:
                    continue
                k, v = token.split("=", 1)
                key = (k or "").strip()
                try:
                    val = int(str(v).strip())
                except Exception:
                    continue
                if not key or val <= 0:
                    continue
                thresholds[key] = val

        if thresholds:
            # Only keep known critical keys to prevent typos from silently adding junk.
            return {k: thresholds[k] for k in thresholds.keys() if k in cls.CRITICAL_EVENT_TYPES}

        default_val = 1 if cls._critical_immediate() else 2
        return {k: default_val for k in cls.CRITICAL_EVENT_TYPES}

    @classmethod
    def _eligible_events(cls, event_types: Iterable[str]) -> Tuple[Set[str], Set[str]]:
        minor = {e for e in event_types if e in cls.MINOR_TERMINATION_THRESHOLDS}
        major = {e for e in event_types if e in cls.MAJOR_EVENT_TYPES}
        return minor, major

    @classmethod
    def resolve_lenient_mode(cls, db: Optional[Session], user_id: int) -> bool:
        """
        Look up the active exam session for `user_id` and return the value of
        `exam.config.lenient_mode` (bool). Returns False on any error so the
        default behaviour (strict proctoring) is preserved.

        We intentionally tolerate a missing `db` because some callers may not
        have one in scope; in that case we just default to False.
        """
        if db is None:
            return False
        try:
            session_row = db.query(ExamSession).filter(
                ExamSession.user_id == int(user_id),
                ExamSession.status == "active",
            ).order_by(ExamSession.start_time.desc()).first()
            if session_row is None or session_row.exam_id is None:
                return False
            exam_row = db.query(Exam).filter(Exam.id == int(session_row.exam_id)).first()
            if exam_row is None:
                return False
            cfg = exam_row.config if isinstance(exam_row.config, dict) else {}
            return bool(cfg.get("lenient_mode", False))
        except Exception as exc:
            logger.debug("resolve_lenient_mode failed for user %s: %s", user_id, exc)
            return False

    @classmethod
    def evaluate(
        cls,
        user_id: int,
        event_types: List[str],
        *,
        lenient_mode: bool = False,
    ) -> PolicyAction:
        uid = int(user_id)
        now = cls._now()
        cooldown = cls._cooldown_sec()

        # Lenient mode: strip events the exam-creator chose to demote BEFORE
        # any strike accumulation or threshold check happens. The event row
        # is still persisted by the caller (so the admin sees it in the
        # timeline), but it cannot drive a warn/terminate action here.
        if lenient_mode and event_types:
            filtered = [e for e in event_types if e not in LENIENT_MODE_DEMOTED_EVENTS]
            if not filtered:
                # All events in this batch were demoted - nothing to evaluate.
                return PolicyAction(
                    action="none",
                    reason="lenient_mode_filtered",
                    details={"demoted_events": sorted({
                        e for e in event_types if e in LENIENT_MODE_DEMOTED_EVENTS
                    })},
                )
            event_types = filtered

        state = get_state(uid) or {}
        major_strikes = int(state.get("major_strikes", 0) or 0)
        minor_counts = dict(state.get("minor_counts") or {})
        critical_counts = dict(state.get("critical_counts") or {})
        last_counted = dict(state.get("last_counted_ts") or {})

        minor_events, major_events = cls._eligible_events(event_types)
        critical_events = {e for e in event_types if e in cls.CRITICAL_EVENT_TYPES}
        critical_thresholds = cls._critical_thresholds()

        def can_count(event_type: str) -> bool:
            last_ts = float(last_counted.get(event_type, 0) or 0)
            return (now - last_ts) >= cooldown

        # Minor counters (count occurrences, terminate at threshold)
        for event in sorted(minor_events):
            if not can_count(event):
                continue
            minor_counts[event] = int(minor_counts.get(event, 0) or 0) + 1
            last_counted[event] = now

        for event, threshold in cls.MINOR_TERMINATION_THRESHOLDS.items():
            if int(minor_counts.get(event, 0) or 0) >= int(threshold):
                state.update({
                    "major_strikes": major_strikes,
                    "minor_counts": minor_counts,
                    "critical_counts": critical_counts,
                    "last_counted_ts": last_counted,
                })
                set_state(uid, state)
                return PolicyAction(
                    action="terminate",
                    reason="minor_threshold_reached",
                    details={"event_type": event, "count": int(minor_counts.get(event, 0) or 0), "threshold": int(threshold)},
                )

        # Critical per-event thresholds (count with cooldown per event)
        for event in sorted(critical_events):
            threshold = int(critical_thresholds.get(event, 0) or 0)
            if threshold <= 0:
                continue
            if not can_count(f"critical:{event}"):
                continue
            critical_counts[event] = int(critical_counts.get(event, 0) or 0) + 1
            last_counted[f"critical:{event}"] = now
            if int(critical_counts.get(event, 0) or 0) >= threshold:
                state.update({
                    "major_strikes": major_strikes,
                    "minor_counts": minor_counts,
                    "critical_counts": critical_counts,
                    "last_counted_ts": last_counted,
                })
                set_state(uid, state)
                return PolicyAction(
                    action="terminate",
                    reason="critical_threshold_reached",
                    details={
                        "event_type": event,
                        "count": int(critical_counts.get(event, 0) or 0),
                        "threshold": threshold,
                    },
                )

        # Major strikes: increment once per batch (if any major event present)
        major_incremented = False
        if major_events:
            key = "major_batch"
            if can_count(key):
                major_strikes += 1
                last_counted[key] = now
                major_incremented = True

        warn_at = cls._warn_at()
        terminate_at = cls._terminate_at()

        state.update({
            "major_strikes": major_strikes,
            "minor_counts": minor_counts,
            "critical_counts": critical_counts,
            "last_counted_ts": last_counted,
        })
        set_state(uid, state)

        if major_strikes >= terminate_at:
            return PolicyAction(
                action="terminate",
                reason="major_strikes_threshold",
                details={"major_strikes": major_strikes, "terminate_at": terminate_at, "events": sorted(list(major_events))},
            )

        if major_incremented and major_strikes == warn_at:
            return PolicyAction(
                action="warn",
                reason="major_strikes_warning",
                details={"major_strikes": major_strikes, "warn_at": warn_at, "events": sorted(list(major_events))},
            )

        return PolicyAction(action="none", reason="", details={})

    @classmethod
    def _thresholds_snapshot(cls) -> Dict[str, Any]:
        return {
            "minor_termination_thresholds": dict(cls.MINOR_TERMINATION_THRESHOLDS),
            "major_warn_at": cls._warn_at(),
            "major_terminate_at": cls._terminate_at(),
            "critical_event_thresholds": cls._critical_thresholds(),
            "strike_event_cooldown_sec": cls._cooldown_sec(),
        }

    @classmethod
    async def apply_action(
        cls,
        db: Session,
        user_id: int,
        action: PolicyAction,
        *,
        trigger_event_types: Optional[List[str]] = None,
        trigger_source: str = "system",
        evidence_url: Optional[str] = None,
    ) -> Optional[Log]:
        """
        Persist warning/termination logs and update session status when terminating.
        Returns the created Log row (or None).
        """
        uid = int(user_id)
        if action.action not in {"warn", "terminate"}:
            return None

        session = db.query(ExamSession).filter(
            ExamSession.user_id == uid,
            ExamSession.status == "active",
        ).order_by(ExamSession.start_time.desc()).first()

        if action.action == "warn":
            message = "Proctoring warning: policy threshold approaching."
            event_type = "policy_warning"
        else:
            message = "Exam terminated by policy due to repeated violations."
            event_type = "policy_termination"
            if session:
                session.status = "terminated"
                session.end_time = __import__("datetime").datetime.utcnow()

        try:
            POLICY_ACTIONS_TOTAL.labels(
                action=str(action.action),
                reason=str(action.reason or ""),
                source=str(trigger_source or "system"),
            ).inc()
        except Exception:
            pass

        # Persist immutable audit record (separate from limited-size logs.event_data).
        try:
            audit = PolicyAudit(
                user_id=uid,
                session_id=int(session.id) if session is not None else None,
                exam_id=int(session.exam_id) if session is not None and session.exam_id is not None else None,
                action=str(action.action),
                reason=str(action.reason or ""),
                trigger_source=str(trigger_source or "system"),
                details=dict(action.details or {}),
                thresholds=cls._thresholds_snapshot(),
                trigger_event_types=list(trigger_event_types or []),
                evidence_url=(evidence_url.strip() if isinstance(evidence_url, str) and evidence_url.strip() else None),
            )
            db.add(audit)
        except Exception as exc:
            logger.debug("Failed to create PolicyAudit row: %s", exc)

        log_row = Log(
            user_id=uid,
            log=message,
            event_type=event_type,
            timestamp=__import__("datetime").datetime.utcnow(),
            # Keep this small (logs.event_data is a bounded string).
            event_data=__import__("json").dumps(
                {
                    "reason": action.reason,
                    "trigger_source": trigger_source,
                    "trigger_event_types": list(trigger_event_types or [])[:8],
                }
            ),
        )
        db.add(log_row)
        try:
            db.commit()
            db.refresh(log_row)
            return log_row
        except Exception as exc:
            db.rollback()
            logger.error("Failed to persist policy action for user %s: %s", uid, exc, exc_info=True)
            return None

