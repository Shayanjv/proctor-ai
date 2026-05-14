import os
from fastapi import FastAPI, WebSocket, Depends, HTTPException, Request, WebSocketDisconnect, status, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials, OAuth2PasswordBearer
from jose import JWTError, jwt
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from schemas.responses import ErrorResponse
from routers import auth, exam, lti  # Add lti router import
from seed_admin import seed_admin  # Import seed_admin
import cv2
import numpy as np
from datetime import datetime
import json
import time
from config.database import Base, get_db, create_db_engine  # Add engine and Base import
from models.logs import Log
from models.users import User
from models.sessions import ExamSession
from routers.auth import SECRET_KEY, ALGORITHM
from sqlalchemy.orm import Session
from sqlalchemy import text  # Add text import
import asyncio
from starlette.websockets import WebSocketState
import base64
from typing import Dict, Any
from utils.connection import manager  # Import manager from new module
from utils.logger import logger
from services.detection_service import DetectionService
from services.log_service import LogService
from services.storage_service import StorageService
from models.evidence import Evidence  # Ensure table creation
from models.exam_eligible_students import ExamEligibleStudent  # Ensure table creation
from models.user_face_references import UserFaceReference  # Ensure table creation
from models.user_password_reset_requirements import UserPasswordResetRequirement  # Ensure table creation
from models.policy_audit import PolicyAudit  # Ensure table creation
from models.seb_token_consumed import SebTokenConsumed  # Ensure table creation (SEB single-use redeem tokens)
from utils.image_utils import decode_image_data
from utils.mediapipe_config import configure_mediapipe
from utils.time_utils import utc_iso, utc_now_iso
from config.settings import settings as app_settings, parse_csv_env
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from utils.metrics import (
    WS_CONNECTIONS_TOTAL,
    WS_DISCONNECTS_TOTAL,
    WS_ACTIVE_CONNECTIONS,
    FRAME_PROCESSING_MS,
    FRAME_QUEUE_DEPTH,
    FRAMES_DROPPED_TOTAL,
)

# Security schemes
security = HTTPBearer()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login/password")

# Add auth helper functions
async def get_current_user_ws(token: str, db: Session) -> tuple[User, Dict[str, Any]]:
    credentials_exception = WebSocketException(code=status.WS_1008_POLICY_VIOLATION)
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        subject = payload.get("sub")
        if subject is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = None
    try:
        subject_id = int(str(subject))
        user = db.query(User).filter(User.id == subject_id).first()
    except (TypeError, ValueError):
        user = db.query(User).filter(User.email == str(subject)).first()

    if user is None:
        raise credentials_exception
    return user, payload

class WebSocketException(Exception):
    def __init__(self, code: int):
        self.code = code

app = FastAPI()

@app.on_event("startup")
async def startup_event():
    try:
        logger.info("Initializing database connection...")
        engine = create_db_engine()
        
        if engine is None:
            raise Exception("Failed to create database engine")
            
        # Test connection
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        logger.info("Database connection successful")
        
        # Initialize Storage (MinIO)
        try:
            StorageService.initialize()
        except Exception as e:
            logger.warning(f"Storage initialization failed (MinIO might be down): {e}")

        # Initialize tables
        
        # Initialize tables
        Base.metadata.create_all(bind=engine)
        logger.info("Database tables created successfully")

        # ─────────────────────────────────────────────────────────────
        # Idempotent column-level migrations.
        #
        # Base.metadata.create_all only adds *missing tables*; it does NOT
        # add new columns to tables that already exist in the database.
        # When we ship new nullable columns on long-lived tables (e.g.
        # ExamSession's mark-penalty fields) this loop ensures running
        # databases pick them up without a separate alembic step. Each
        # ALTER uses IF NOT EXISTS, so re-running on a fresh DB or on a
        # DB that's already up-to-date is a no-op.
        #
        # Postgres-only syntax (`ADD COLUMN IF NOT EXISTS`). On SQLite the
        # ALTERs are skipped — SQLite is dev-only and create_all + a
        # fresh test.db covers it.
        # ─────────────────────────────────────────────────────────────
        try:
            dialect = engine.dialect.name if engine.dialect else ""
            if dialect == "postgresql":
                exam_session_columns: list[tuple[str, str]] = [
                    ("major_violation_count",    "INTEGER"),
                    ("critical_violation_count", "INTEGER"),
                    ("proctor_penalty_pct",      "DOUBLE PRECISION"),
                    ("proctor_adjusted_score",   "DOUBLE PRECISION"),
                    ("final_score",              "DOUBLE PRECISION"),
                    ("score_decision",           "VARCHAR(16)"),
                    ("score_decision_by",        "INTEGER"),
                    ("score_decision_at",        "TIMESTAMP"),
                ]
                with engine.begin() as conn:
                    for col_name, col_type in exam_session_columns:
                        conn.execute(text(
                            f"ALTER TABLE exam_sessions "
                            f"ADD COLUMN IF NOT EXISTS {col_name} {col_type}"
                        ))
                logger.info(
                    "Idempotent column migrations applied (mark-penalty fields)."
                )
        except Exception as exc:
            # Non-fatal: a missing column will surface as an SQLAlchemy
            # error at query time. We log and continue so a partially-up
            # service can still serve unrelated endpoints.
            logger.warning(
                f"Idempotent column migration failed (continuing): {exc}"
            )

        # Auto-seed admin user
        seed_admin()

        # Warm-start detector pipeline so first WS frame is real-time.
        # We BLOCK readiness on warmup completion so the first /exam/start and
        # WS frame don't pay model-init / GIL-contention costs.
        try:
            import asyncio as _asyncio

            from services.warmup_service import WarmupService

            # Spawn the daemon-thread warmup (lazy ML imports + dummy inferences).
            WarmupService.start_warmup()

            # Wait for completion off the event loop. Capped so a misconfigured
            # environment cannot wedge container startup forever.
            warmup_timeout_s = float(os.environ.get("WARMUP_TIMEOUT_S", "120"))
            ready = await _asyncio.to_thread(
                WarmupService.wait_until_ready, warmup_timeout_s
            )
            state = WarmupService.get_state()
            if ready:
                logger.info(
                    f"[Startup] Detector pipeline ready in {state.get('warmup_ms')}ms"
                )
            else:
                logger.warning(
                    "[Startup] Detector warmup did not finish within "
                    f"{warmup_timeout_s}s (state={state}). Continuing; first request "
                    "may pay cold-start latency."
                )
        except Exception as exc:
            logger.warning(f"Detector warmup scheduling failed: {exc}")
        
    except Exception as e:
        logger.error(f"Failed to initialize database: {str(e)}")
        raise

# Add Session Middleware (for LTI State)
from starlette.middleware.sessions import SessionMiddleware
from routers.auth import SECRET_KEY
app.add_middleware(
    SessionMiddleware, 
    secret_key=SECRET_KEY,
    same_site="none",
    https_only=True  # Required for SameSite=None
)

# Add CORS middleware
cors_origins = parse_csv_env(app_settings.CORS_ORIGINS)
allow_all_origins = cors_origins == ["*"]
if not cors_origins:
    logger.warning("CORS_ORIGINS is empty; browser clients may be blocked. Set CORS_ORIGINS in environment.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all_origins else cors_origins,
    allow_credentials=not allow_all_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

from routers import auth, exam, lti, settings as settings_router, observability
# Include routers
app.include_router(auth.router, prefix="/api/v1/auth", tags=["authentication"])
app.include_router(exam.router, prefix="/api/v1/exam", tags=["exam"])  # Add exam router
app.include_router(settings_router.router, prefix="/api/v1/settings", tags=["settings"]) # Add settings router
app.include_router(observability.router, prefix="/api/v1/observability", tags=["observability"])
app.include_router(lti.router)  # LTI endpoints have their own prefix

# Add exception handlers
@app.exception_handler(404)
async def not_found_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=404,
        content={"detail": "Not Found"}
    )

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail}
    )

# Add root endpoint
@app.get("/")
async def root():
    return {"message": "Proctoring AI API", "version": "1.0"}


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint (public)."""
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


def _admin_live_interval_seconds() -> float:
    raw_value = os.getenv("ADMIN_LIVE_WS_INTERVAL_SECONDS", "2.5")
    try:
        return max(1.0, float(raw_value))
    except (TypeError, ValueError):
        return 2.5


@app.websocket("/ws/admin/live")
async def admin_live_websocket(
    websocket: WebSocket,
    db: Session = Depends(get_db)
):
    """Admin live monitor websocket stream."""
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        # get_current_user_ws returns (user, payload) — the student WS handler
        # below unpacks correctly; this admin handler was treating the whole
        # tuple as the user, which surfaced as
        # "AttributeError: 'tuple' object has no attribute 'role'" in the
        # logs and a WS 1008 policy-violation close on every admin connect.
        current_user, _payload = await get_current_user_ws(token, db)
        if current_user.role != "admin":
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
    except WebSocketException as e:
        await websocket.close(code=e.code)
        return

    await websocket.accept()
    WS_CONNECTIONS_TOTAL.labels(kind="admin").inc()
    WS_ACTIVE_CONNECTIONS.labels(kind="admin").inc()
    admin_user_id = int(getattr(current_user, "id", 0) or 0)
    logger.info(f"Admin live websocket connected for admin user {admin_user_id}")
    send_interval = _admin_live_interval_seconds()

    try:
        while True:
            if websocket.application_state != WebSocketState.CONNECTED:
                break

            try:
                db.expire_all()
                live_payload = exam._build_admin_live_payload(db)
                await websocket.send_text(json.dumps({
                    "type": "admin_live_snapshot",
                    **live_payload,
                }))
            except Exception as exc:
                logger.error(f"Failed to send admin live snapshot: {exc}")
                if websocket.application_state == WebSocketState.CONNECTED:
                    await websocket.send_text(json.dumps({
                        "type": "admin_live_error",
                        "detail": "Failed to build live monitor snapshot",
                    }))

            try:
                message = await asyncio.wait_for(websocket.receive_text(), timeout=send_interval)
                if message:
                    try:
                        payload = json.loads(message)
                        if payload.get("type") == "keepalive":
                            await websocket.send_text(json.dumps({"type": "keepalive"}))
                    except json.JSONDecodeError:
                        # Ignore non-JSON client messages and keep stream alive.
                        pass
            except asyncio.TimeoutError:
                continue
            except WebSocketDisconnect:
                break
            except Exception as exc:
                err = str(exc).lower()
                if any(token in err for token in ("disconnect", "close frame", "closed")):
                    break
                logger.error(f"Admin websocket receive loop error: {exc}")
                await asyncio.sleep(0.2)
    finally:
        WS_ACTIVE_CONNECTIONS.labels(kind="admin").dec()
        try:
            db.close()
        except Exception:
            pass
        # Use captured id to avoid DetachedInstanceError after session close.
        logger.info(f"Admin live websocket disconnected for admin user {admin_user_id}")

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: int,
    db: Session = Depends(get_db)
):
    """
    Enterprise-grade WebSocket endpoint.
    
    Architecture: Producer-Consumer with asyncio.Queue
    - Receive loop: validates + enqueues frames (never blocks on detection)
    - Detection worker: pulls frames from queue, runs detection, sends results back
    - Stale frames are dropped when queue is full (ensures low latency)
    - Detection runs for the FULL exam duration, not just 5 minutes
    """
    logger.info(f"WebSocket connection request received for user {user_id}")
    connection_established = False

    # Token validation
    token = websocket.query_params.get('token')
    if not token:
        logger.warning(f"No token provided for user {user_id}")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        current_user, payload = await get_current_user_ws(token, db)
        if current_user.id != user_id:
            logger.warning(f"Token user ID mismatch for user {user_id}")
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        session_claim = payload.get("session")
        try:
            session_id = int(str(session_claim))
        except (TypeError, ValueError):
            logger.warning(f"Missing or invalid WS session claim for user {user_id}")
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        session = db.query(ExamSession).filter(
            ExamSession.id == session_id,
            ExamSession.user_id == user_id,
        ).first()
        if session is None:
            logger.warning(f"WS session not found for user {user_id}, session {session_id}")
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        session_status = (session.status or "").strip().lower()
        if session_status != "active":
            logger.info(f"Rejecting WS connect for user {user_id}; session status is {session_status or 'unknown'}")
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
    except WebSocketException as e:
        logger.error(f"Token validation failed for user {user_id}")
        await websocket.close(code=e.code)
        return

    # Connect
    if not await manager.connect(websocket, user_id):
        logger.error(f"Failed to establish WebSocket connection for user {user_id}")
        return

    connection_established = True
    WS_CONNECTIONS_TOTAL.labels(kind="student").inc()
    WS_ACTIVE_CONNECTIONS.labels(kind="student").inc()
    logger.info(f"WebSocket connection established for user {user_id}")

    send_lock = asyncio.Lock()

    async def safe_send(payload: Dict[str, Any]) -> bool:
        """Send JSON payload safely while receive and worker loops run concurrently."""
        if websocket.application_state != WebSocketState.CONNECTED:
            return False
        try:
            async with send_lock:
                if websocket.application_state != WebSocketState.CONNECTED:
                    return False
                await websocket.send_text(json.dumps(payload))
            return True
        except Exception as exc:
            err = str(exc).lower()
            if any(token in err for token in ("disconnect", "close frame", "closed")):
                return False
            logger.debug(f"[WS] send failed for user {user_id}: {exc}")
            return False

    # Send connect confirmation
    await safe_send({
        "type": "init_success",
        "message": "Connection established successfully",
        "user_id": user_id
    })

    # Frame queue — max 3 frames buffered (drop old ones to stay real-time)
    frame_queue: asyncio.Queue = asyncio.Queue(maxsize=4)
    stop_event = asyncio.Event()
    dropped_frames = 0

    async def detection_worker():
        """Consumes frames from queue and runs all detectors."""
        logger.info(f"[WS] Detection worker started for user {user_id}")
        while not stop_event.is_set():
            raw_frame = None
            try:
                # Wait for a frame (timeout so we can check stop_event)
                try:
                    raw_frame = await asyncio.wait_for(frame_queue.get(), timeout=2.0)
                except asyncio.TimeoutError:
                    continue

                # Decode in the worker so receive loop can stay low-latency.
                frame = await asyncio.to_thread(decode_image_data, raw_frame)
                if frame is None:
                    continue

                process_started_at = time.perf_counter()
                # Run detection pipeline
                logs = await DetectionService.process_frame(db, user_id, frame)
                monitor_state = DetectionService.get_live_monitor_state(user_id)
                processing_ms = round((time.perf_counter() - process_started_at) * 1000, 2)
                FRAME_PROCESSING_MS.observe(processing_ms)
                FRAME_QUEUE_DEPTH.set(frame_queue.qsize())

                if websocket.application_state == WebSocketState.CONNECTED:
                    if logs:
                        stored_logs = await LogService.store_logs(db, user_id, logs)
                        if stored_logs:
                            await safe_send({
                                "type": "logs",
                                "data": [
                                    {
                                        "event": log.log,
                                        "event_type": log.event_type,
                                        "time": utc_iso(log.timestamp)
                                    }
                                    for log in stored_logs
                                ],
                                "stored": True
                            })

                            # Policy engine: warn/terminate based on accumulated strikes.
                            try:
                                from services.termination_policy_service import TerminationPolicyService

                                event_types = [str(item.event_type or "") for item in stored_logs]
                                # Per-exam leniency: if exam.config.lenient_mode is on,
                                # the policy service will skip multiple_people /
                                # prohibited_object / phone_detected for strike counting.
                                # The events are still stored above (admin timeline keeps them).
                                lenient_mode = TerminationPolicyService.resolve_lenient_mode(db, user_id)
                                policy_action = TerminationPolicyService.evaluate(
                                    user_id,
                                    event_types,
                                    lenient_mode=lenient_mode,
                                )
                                if policy_action.action in {"warn", "terminate"}:
                                    evidence_url = None
                                    try:
                                        # Prefer evidence URL attached by DetectionService when upload succeeded.
                                        candidates = [log.get("file_url") for log in (logs or []) if isinstance(log, dict)]
                                        evidence_url = next((c for c in candidates if isinstance(c, str) and c.strip()), None)
                                    except Exception:
                                        evidence_url = None

                                    policy_log = await TerminationPolicyService.apply_action(
                                        db,
                                        user_id,
                                        policy_action,
                                        trigger_event_types=event_types,
                                        trigger_source="ws_detector",
                                        evidence_url=evidence_url,
                                    )
                                    if policy_log:
                                        await safe_send({
                                            "type": "logs",
                                            "data": [
                                                {
                                                    "event": policy_log.log,
                                                    "event_type": policy_log.event_type,
                                                    "time": utc_iso(policy_log.timestamp)
                                                }
                                            ],
                                            "stored": True
                                        })

                                    if policy_action.action == "terminate":
                                        # Best-effort notify client, then stop worker and close WS.
                                        await safe_send({
                                            "type": "session_terminated",
                                            "reason": policy_action.reason,
                                            "details": policy_action.details,
                                        })
                                        stop_event.set()
                                        try:
                                            await manager.force_disconnect(user_id)
                                        except Exception:
                                            pass
                                        break
                            except Exception as exc:
                                logger.debug(f"Policy termination evaluation failed: {exc}")

                    await safe_send({
                        "type": "frame_processed",
                        "event_count": len(logs),
                        "processed_at": utc_now_iso(),
                        "processing_ms": processing_ms,
                        "queue_depth": frame_queue.qsize(),
                        "dropped_frames": dropped_frames,
                        "monitor_state": monitor_state,
                    })

            except Exception as e:
                logger.error(f"[WS] Detection worker error for user {user_id}: {e}", exc_info=True)
                if websocket.application_state == WebSocketState.CONNECTED:
                    try:
                        await safe_send({
                            "type": "frame_error",
                            "error": "Frame processing failed"
                        })
                    except Exception:
                        pass
                await asyncio.sleep(0.2)
            finally:
                if raw_frame is not None:
                    frame_queue.task_done()

        logger.info(f"[WS] Detection worker stopped for user {user_id}")

    # Start detection worker as background task
    worker_task = asyncio.create_task(detection_worker())

    try:
        # Receive loop — just enqueueframes, never blocks on detection
        while True:
            try:
                if websocket.application_state != WebSocketState.CONNECTED:
                    logger.info(f"WebSocket no longer connected for user {user_id}")
                    break

                data = await websocket.receive()

                if data["type"] == "websocket.disconnect":
                    logger.info(f"Client disconnected for user {user_id}")
                    break

                raw_data = data.get("text") or data.get("bytes")
                if not raw_data:
                    continue

                # Handle keepalive
                if isinstance(raw_data, str) and "keepalive" in raw_data:
                    try:
                        json_data = json.loads(raw_data)
                        if json_data.get("type") == "keepalive":
                            await safe_send({"type": "keepalive"})
                            continue
                    except json.JSONDecodeError:
                        pass

                # Enqueue (drop oldest if full — stays real-time)
                if frame_queue.full():
                    try:
                        frame_queue.get_nowait()  # Drop stale frame
                        frame_queue.task_done()
                        dropped_frames += 1
                        FRAMES_DROPPED_TOTAL.inc()
                    except asyncio.QueueEmpty:
                        pass
                await frame_queue.put(raw_data)

            except WebSocketDisconnect:
                logger.info(f"WebSocket disconnected for user {user_id}")
                break
            except Exception as e:
                err_str = str(e).lower()
                if any(x in err_str for x in ["close message", "disconnect", "closed"]):
                    break
                logger.error(f"Receive loop error for user {user_id}: {e}")
                continue

    finally:
        # Signal worker to stop and wait
        stop_event.set()
        try:
            await asyncio.wait_for(worker_task, timeout=5.0)
        except asyncio.TimeoutError:
            worker_task.cancel()
        except Exception:
            pass

        await manager.disconnect(user_id)
        WS_ACTIVE_CONNECTIONS.labels(kind="student").dec()
        DetectionService.cleanup_user(user_id)
        try:
            db.close()
        except Exception:
            pass
        logger.info(f"[WS] Session fully cleaned up for user {user_id}")


if __name__ == "__main__":
    import uvicorn
    from config.settings import settings
    # Use 0.0.0.0 to allow access from other devices (e.g. mobile, other PCs)
    uvicorn.run("main:app", host=settings.SERVER_HOST, port=settings.SERVER_PORT, reload=True)
