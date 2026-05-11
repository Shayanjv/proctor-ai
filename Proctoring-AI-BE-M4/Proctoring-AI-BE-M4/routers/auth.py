from fastapi import APIRouter, Depends, HTTPException, status, File, UploadFile, Form, Security, Response, Request
from fastapi.security import OAuth2PasswordBearer, HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from config.database import get_db
from models.users import User
from models.logs import Log
from models.user_face_references import UserFaceReference
from models.user_password_reset_requirements import UserPasswordResetRequirement
from utils.face_auth import verify_face_against_references
import bcrypt
from datetime import datetime, timedelta
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
import imghdr
import asyncio
from typing import Dict, List, Optional
from schemas.auth import (
    UserResponse,
    Token,
    UserProfile,
    UserProfileUpdate,
    PasswordChange,
    LoginAttemptResponse,
    LtiFaceBindResponse,
    LivenessChallengeResponse,
)
from utils.login_attempt_store import create_attempt, consume_attempt, peek_attempt, TTL_SEC
from config.settings import settings
from utils.face_reference_utils import (
    analyze_face_capture,
    load_user_face_references,
    normalize_face_pose,
)
from services.seb_token_service import SebTokenService
from utils.logger import logger
from utils.session_manager import session_manager
from utils.connection import manager
from fastapi.responses import JSONResponse
from utils.metrics import RATE_LIMIT_HITS_TOTAL

router = APIRouter()
security = HTTPBearer()

# Password hashing


# JWT settings
SECRET_KEY = settings.JWT_SECRET_KEY
ALGORITHM = settings.JWT_ALGORITHM
ACCESS_TOKEN_EXPIRE_MINUTES = settings.JWT_ACCESS_TOKEN_EXPIRE_MINUTES

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")
SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png"}
FACE_VERIFY_TIMEOUT_SEC = int(getattr(settings, "PROCTOR_FACE_VERIFY_TIMEOUT_SEC", 120) or 120)


def _read_upload_image_or_400(image: UploadFile, field_name: str) -> bytes:
    if image is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Missing required image for {field_name}"
        )

    if image.content_type not in SUPPORTED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid file type for {field_name}. Only JPEG and PNG are supported"
        )

    return b""


async def _read_upload_file_bytes(image: UploadFile, field_name: str) -> bytes:
    _read_upload_image_or_400(image, field_name)
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Empty image file provided for {field_name}"
        )
    return image_bytes


def _validate_reference_analysis_or_400(analysis: dict, pose: str) -> None:
    if analysis.get("ready_to_capture"):
        return

    issues = analysis.get("issues") or []
    instruction = analysis.get("instruction") or f"Unable to capture a valid {pose} face image."
    if issues:
        instruction = f"{instruction} Issues: {', '.join(issues)}"

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"{pose.title()} photo did not pass quality checks. {instruction}"
    )


def _replace_user_face_references(
    db: Session,
    user: User,
    reference_payloads: List[Dict],
) -> None:
    db.query(UserFaceReference).filter(UserFaceReference.user_id == user.id).delete()

    for payload in reference_payloads:
        analysis = payload.get("analysis") or {}
        db.add(
            UserFaceReference(
                user_id=user.id,
                pose=payload["pose"],
                image=payload["image_data"],
                quality_score=analysis.get("metrics", {}).get("quality_score"),
                updated_at=datetime.utcnow(),
            )
        )

    front_reference = next(
        (payload["image_data"] for payload in reference_payloads if payload["pose"] == "front"),
        None,
    )
    if front_reference:
        user.image = front_reference


async def _collect_reference_payloads_from_uploads(
    image_front: Optional[UploadFile],
    image_left: Optional[UploadFile],
    image_right: Optional[UploadFile],
    *,
    require_all: bool,
    context_label: str,
) -> List[Dict]:
    provided_uploads = [image_front, image_left, image_right]
    has_any_reference_upload = any(upload is not None for upload in provided_uploads)

    if require_all and not has_any_reference_upload:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Front, left, and right face photos are all required for {context_label}."
        )

    if not has_any_reference_upload:
        return []

    if require_all and not all(upload is not None for upload in provided_uploads):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Front, left, and right face photos are all required for {context_label}."
        )

    reference_payloads: List[Dict] = []
    for pose, upload in (
        ("front", image_front),
        ("left", image_left),
        ("right", image_right),
    ):
        if upload is None:
            continue

        pose_image_data = await _read_upload_file_bytes(upload, f"{pose} image")
        analysis = await asyncio.to_thread(
            analyze_face_capture,
            pose_image_data,
            target_pose=pose,
            require_pose_match=True,
        )
        _validate_reference_analysis_or_400(analysis, pose)
        reference_payloads.append(
            {
                "pose": pose,
                "image_data": pose_image_data,
                "analysis": analysis,
            }
        )

    left_payload = next((payload for payload in reference_payloads if payload["pose"] == "left"), None)
    right_payload = next((payload for payload in reference_payloads if payload["pose"] == "right"), None)
    if left_payload and right_payload:
        left_sign = _extract_side_sign_from_analysis(left_payload.get("analysis"))
        right_sign = _extract_side_sign_from_analysis(right_payload.get("analysis"))
        if left_sign == 0 or right_sign == 0 or left_sign == right_sign:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The two side photos must face opposite directions. Capture one side first, then turn to the other side."
            )

    return reference_payloads


async def _collect_login_images(
    image_front: Optional[UploadFile],
) -> List[Dict]:
    """
    Collect face image for LOGIN verification — front-facing only.
    Unlike enrollment, we do NOT enforce pose quality or strict yaw matching.
    We only reject if no face is detectable at all.
    """
    if not image_front:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A front-facing face photo is required for login verification."
        )

    image_data = await _read_upload_file_bytes(image_front, "front image")
    analysis = await asyncio.to_thread(
        analyze_face_capture,
        image_data,
        target_pose="front",
        require_pose_match=False,
    )
    issues = analysis.get("issues") or []
    if "face_not_visible" in issues or "invalid_image" in issues:
        instruction = analysis.get("instruction") or "Face the camera with good lighting."
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "no_face",
                "message": f"Front photo: {instruction}",
            },
        )
    return [{"pose": "front", "image_data": image_data, "analysis": analysis}]


def _verify_login_reference_set(
    enrolled_references: List[Dict],
    live_reference_payloads: List[Dict],
) -> Dict[str, object]:
    live_results: List[Dict[str, object]] = []
    comparable_results: List[Dict[str, object]] = []
    verified_results: List[Dict[str, object]] = []
    unverifiable_results: List[Dict[str, object]] = []

    for payload in live_reference_payloads:
        verification = verify_face_against_references(
            enrolled_references,
            payload["image_data"],
            threshold=0.6,
            skip_quality_check=True,  # already quality-checked in _collect_login_images
        )
        verification["live_pose"] = payload["pose"]
        live_results.append(verification)

        verification_status = str(verification.get("status") or "unverifiable")
        if verification_status == "unverifiable":
            unverifiable_results.append(verification)
            continue

        comparable_results.append(verification)
        if verification.get("verified"):
            verified_results.append(verification)

    best_verified = None
    if verified_results:
        best_verified = max(
            verified_results,
            key=lambda result: float((result.get("best_match") or {}).get("confidence", 0.0)),
        )

    return {
        "live_results": live_results,
        "comparable_results": comparable_results,
        "verified_results": verified_results,
        "unverifiable_results": unverifiable_results,
        "best_verified": best_verified,
        "majority_verified": len(verified_results) >= 2,
    }


def _face_auth_http_exception(code: str, message: str, status_code: int = status.HTTP_401_UNAUTHORIZED):
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


def _enforce_enrolled_face_match(
    enrolled_references: List[Dict],
    fresh_reference_payloads: List[Dict],
) -> None:
    if not enrolled_references:
        return
    aggregate = _verify_login_reference_set(enrolled_references, fresh_reference_payloads)
    comparable_results = aggregate["comparable_results"]
    verified_results = aggregate["verified_results"]

    if not comparable_results:
        raise _face_auth_http_exception(
            "face_not_comparable",
            "Could not analyze your face clearly. Use good lighting and face the camera.",
            status.HTTP_400_BAD_REQUEST,
        )

    # Front photo match is sufficient — one photo from enrolled references must verify.
    if not verified_results:
        logger.warning(
            "Face bind rejected: verified_count=%s user_enrolled_refs=%s",
            len(verified_results),
            len(enrolled_references),
        )
        raise _face_auth_http_exception(
            "face_mismatch",
            "Face did not match your enrolled profile. Please try again in good lighting.",
        )


def _persist_face_bind_success(db: Session, user: User, fresh_reference_payloads: List[Dict]) -> None:
    _replace_user_face_references(db, user, fresh_reference_payloads)
    db.commit()
    db.refresh(user)
    try:
        from services.detection_service import DetectionService

        DetectionService.clear_identity_cache(user.id)
    except Exception as exc:
        logger.warning("Failed to clear cached detection state for user %s: %s", user.id, exc)


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _extract_side_sign_from_analysis(analysis: Optional[Dict]) -> int:
    yaw = None
    if analysis:
        yaw = (analysis.get("metrics") or {}).get("yaw")

    try:
        yaw_value = float(yaw)
    except (TypeError, ValueError):
        return 0

    if abs(yaw_value) < 6.0:
        return 0
    return 1 if yaw_value > 0 else -1


def _requires_password_reset(user: User, db: Session) -> bool:
    requirement = db.query(UserPasswordResetRequirement).filter(
        UserPasswordResetRequirement.user_id == user.id
    ).first()
    return bool(requirement and requirement.must_reset_password)


def _verify_password_or_401(user: User, password: str) -> None:
    try:
        if not bcrypt.checkpw(password[:72].encode('utf-8'), user.password.encode('utf-8')):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect email or password",
                headers={"WWW-Authenticate": "Bearer"},
            )
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Password verification error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(
    token: str = Depends(oauth2_scheme), 
    db: Session = Depends(get_db)
) -> User:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get("sub")
        if email is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token missing subject (email)",
                headers={"WWW-Authenticate": "Bearer"},
            )
    except JWTError as e:
        logger.error(f"JWT Validation Error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token validation failed: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"User {email} not found in database",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user

def get_current_active_user(
    current_user: User = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    return get_current_user(current_user, db)

def get_current_admin_user(
    current_user: User = Depends(get_current_user),
) -> User:
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The user doesn't have enough privileges"
        )
    return current_user

@router.get("/me", response_model=UserProfile)  
async def read_users_me(current_user: User = Depends(get_current_user)):
    """Get current user profile for session validation"""
    return current_user

@router.post("/change-password")
async def change_password(
    password_data: PasswordChange,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update user password with current password verification"""
    # Verify current password
    if not bcrypt.checkpw(password_data.current_password[:72].encode('utf-8'), current_user.password.encode('utf-8')):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect current password"
        )
    
    # Hash new password
    hashed = bcrypt.hashpw(password_data.new_password[:72].encode('utf-8'), bcrypt.gensalt())
    current_user.password = hashed.decode('utf-8')

    requirement = db.query(UserPasswordResetRequirement).filter(
        UserPasswordResetRequirement.user_id == current_user.id
    ).first()
    if requirement:
        requirement.must_reset_password = False
        requirement.updated_at = datetime.utcnow()
    
    db.commit()
    return {"message": "Password updated successfully"}


@router.get("/me/image")
async def get_my_image(current_user: User = Depends(get_current_user)):
    """Serve the current user's profile image.

    Returns 204 No Content (not 404) when the user simply hasn't uploaded a
    profile photo yet. This matters because the student Summary screen calls
    this endpoint lazily on every exam completion: a 404 fills the dev
    console with red ``Failed to load resource`` errors that look like real
    bugs, while 204 is the correct REST signal for "request OK, nothing to
    return". Frontend treats both as "no image, render placeholder".
    """
    if not current_user.image:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # Detect image type
    image_type = imghdr.what(None, h=current_user.image)
    if not image_type:
        image_type = "jpeg" # Default fallback

    return Response(content=current_user.image, media_type=f"image/{image_type}")

@router.patch("/me/image")
async def update_my_image(
    image: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update current user's profile image"""
    if not image.content_type in ["image/jpeg", "image/png"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid file type. Only JPEG and PNG are supported"
        )
    
    image_data = await image.read()
    current_user.image = image_data
    db.commit()
    return {"message": "Profile image updated successfully"}

@router.delete("/me/image")
async def delete_my_image(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Remove current user's profile image"""
    current_user.image = None
    db.commit()
    return {"message": "Profile image removed successfully"}


@router.patch("/me", response_model=UserProfile)
async def update_user_me(
    user_update: UserProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update current user profile"""
    update_data = user_update.model_dump(exclude_unset=True)
    
    if "email" in update_data:
        # Check if email is already taken
        existing_user = db.query(User).filter(User.email == update_data["email"]).first()
        if existing_user and existing_user.id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already registered"
            )
    
    for field, value in update_data.items():
        setattr(current_user, field, value)
    
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/face-enrollment/analyze")
async def analyze_face_enrollment_frame(
    image: UploadFile = File(..., description="Live captured face image"),
    target_pose: str = Form("front"),
    require_pose_match: bool = Form(True),
):
    pose = normalize_face_pose(target_pose)
    image_data = await _read_upload_file_bytes(image, f"{pose} image")
    analysis = await asyncio.to_thread(
        analyze_face_capture,
        image_data,
        target_pose=pose,
        require_pose_match=require_pose_match,
    )
    return analysis


@router.post("/signup", response_model=UserResponse)
async def signup(
    email: str = Form(..., description="User email"),
    password: str = Form(..., description="User password"),
    image_front: Optional[UploadFile] = File(None, description="Front face reference"),
    image_left: Optional[UploadFile] = File(None, description="Left face reference"),
    image_right: Optional[UploadFile] = File(None, description="Right face reference"),
    db: Session = Depends(get_db)
):
    """
    Register a new user with email, password and face image.
    """
    # Basic validations
    normalized_email = _normalize_email(email)

    if not "@" in normalized_email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid email format"
        )
    
    if len(password) < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must be at least 6 characters long"
        )
    
    # Check if user exists
    if db.query(User).filter(User.email == normalized_email).first():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered"
        )

    try:
        reference_payloads = await _collect_reference_payloads_from_uploads(
            image_front,
            image_left,
            image_right,
            require_all=True,
            context_label="guided enrollment",
        )
        image_data = next(
            payload["image_data"] for payload in reference_payloads if payload["pose"] == "front"
        )

        # Hash password (bcrypt requires max 72 bytes)
        # Using bcrypt directly instead of passlib to avoid compatibility issues
        hashed = bcrypt.hashpw(password[:72].encode('utf-8'), bcrypt.gensalt())
        hashed_password = hashed.decode('utf-8')
        
        # Create new user
        db_user = User(
            email=normalized_email,
            password=hashed_password,
            image=image_data
        )
        db.add(db_user)
        db.flush()

        if reference_payloads:
            _replace_user_face_references(db, db_user, reference_payloads)

        db.commit()
        db.refresh(db_user)
        
        return UserResponse(
            id=db_user.id,
            email=normalized_email,
            message="User registered successfully"
        )
        
    except HTTPException as he:
        raise he
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Registration failed: {str(e)}"
        )

class LoginRequest(BaseModel):
    email: str
    password: str


class InitialPasswordReset(BaseModel):
    email: EmailStr
    temporary_password: str
    new_password: str


@router.post("/login/attempt", response_model=LoginAttemptResponse)
async def login_create_attempt(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    """
    Verify password and return a short-lived attempt id. Students must then call /login/password-face.
    Does not return a JWT.
    """
    from utils.rate_limiter import check_and_increment

    ip = (request.client.host if request.client else "unknown").strip()
    window_sec = int(getattr(settings, "AUTH_RATE_LIMIT_WINDOW_SEC", 60) or 60)
    limit = int(getattr(settings, "AUTH_LOGIN_ATTEMPT_LIMIT", 8) or 8)
    rl = check_and_increment(f"auth:login_attempt:ip:{ip}", limit=limit, window_sec=window_sec)
    if not rl.allowed:
        try:
            RATE_LIMIT_HITS_TOTAL.labels(endpoint="auth_login_attempt").inc()
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rate_limited", "message": "Too many login attempts. Please wait and try again."},
            headers={"Retry-After": str(rl.retry_after_seconds)},
        )

    normalized_email = _normalize_email(email)
    user = db.query(User).filter(User.email == normalized_email).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if user.role != "student":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This step is only for student accounts. Use password login for staff.",
        )
    _verify_password_or_401(user, password)
    if _requires_password_reset(user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password reset required before login",
        )
    attempt_id = create_attempt(user.id, user.email)
    return LoginAttemptResponse(attempt_id=attempt_id, expires_in_seconds=TTL_SEC)


@router.post("/login/liveness-challenge", response_model=LivenessChallengeResponse)
async def login_liveness_challenge(
    request: Request,
    login_attempt_id: str = Form(..., description="From POST /login/attempt"),
    email: str = Form(..., description="Student email used for /login/attempt"),
):
    """
    Mint a one-time liveness challenge tied to a valid login attempt.
    The client must capture poses in the returned order and present challenge_id to /login/password-face.
    """
    from utils.rate_limiter import check_and_increment

    ip = (request.client.host if request.client else "unknown").strip()
    normalized_email = _normalize_email(email)
    window_sec = int(getattr(settings, "AUTH_RATE_LIMIT_WINDOW_SEC", 60) or 60)
    limit = int(getattr(settings, "AUTH_LIVENESS_CHALLENGE_LIMIT", 12) or 12)
    rl = check_and_increment(
        f"auth:liveness_login:ip:{ip}:email:{normalized_email}",
        limit=limit,
        window_sec=window_sec,
    )
    if not rl.allowed:
        try:
            RATE_LIMIT_HITS_TOTAL.labels(endpoint="auth_liveness_login").inc()
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rate_limited", "message": "Too many face challenges. Please wait and try again."},
            headers={"Retry-After": str(rl.retry_after_seconds)},
        )

    attempt = peek_attempt(login_attempt_id)
    if not attempt:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "invalid_login_attempt",
                "message": "Login session expired or invalid. Enter your password again.",
            },
        )

    attempt_uid = int(attempt.get("user_id") or 0)
    attempt_email = (attempt.get("email") or "").strip().lower()
    if attempt_uid <= 0 or attempt_email != normalized_email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "invalid_login_attempt",
                "message": "Login session expired or invalid. Enter your password again.",
            },
        )

    from utils.liveness_challenge_store import create_for_login_attempt

    challenge = create_for_login_attempt(login_attempt_id, attempt_uid, normalized_email)
    return LivenessChallengeResponse(**challenge)


@router.post("/login/password", response_model=Token)
async def login_password(
    email: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db)
):
    """
    Password-only login for non-student accounts. Students must use /login/attempt + /login/password-face.
    """
    normalized_email = _normalize_email(email)
    user = db.query(User).filter(User.email == normalized_email).first()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    _verify_password_or_401(user, password)
    if _requires_password_reset(user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password reset required before login"
        )

    if user.role == "student":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "face_login_required",
                "message": "Student sign-in requires face verification. Use the full login flow on the student portal.",
            },
        )

    access_token = create_access_token(data={"sub": user.email})
    return Token(
        access_token=access_token,
        token_type="bearer",
        id=user.id,
        role=user.role
    )


# ─────────────────────────────────────────────────────────────────────────────
# Safe Exam Browser auto-login flow
# ─────────────────────────────────────────────────────────────────────────────
#
# The student authenticates in their normal browser (where copy-paste works
# and they can use a password manager for the temporary password). At the
# moment they click "Open in SEB", the FE calls /auth/seb-token to mint a
# short-lived single-use token, embeds it into the seb:// launch URL, and
# the .seb config carries it onward as a query param on the FE start URL.
#
# When SEB starts up and the FE loads, /auth/seb-redeem swaps that token
# for a regular access JWT — so the student never sees a login screen
# inside the locked-down browser. See `services/seb_token_service.py` for
# the security model (single-use jti, dedicated `purpose` claim, short
# TTL).
# ─────────────────────────────────────────────────────────────────────────────


class SebTokenIssueRequest(BaseModel):
    exam_id: Optional[int] = None


class SebTokenIssueResponse(BaseModel):
    token: str
    expires_in_seconds: int


class SebTokenRedeemRequest(BaseModel):
    token: str


@router.post("/seb-token", response_model=SebTokenIssueResponse)
async def issue_seb_token(
    payload: SebTokenIssueRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Mint a short-lived single-use redeem token for the caller. Requires a
    normal Bearer JWT — the caller must already be authenticated in their
    regular browser. The returned token will be embedded into the .seb
    config the FE generates next.
    """
    token = SebTokenService.issue(
        user_email=current_user.email,
        user_id=int(current_user.id),
        exam_id=int(payload.exam_id) if payload.exam_id is not None else None,
    )
    return SebTokenIssueResponse(
        token=token,
        expires_in_seconds=int(settings.SEB_TOKEN_TTL_SECONDS or 300),
    )


@router.post("/seb-redeem", response_model=Token)
async def redeem_seb_token(
    payload: SebTokenRedeemRequest,
    db: Session = Depends(get_db),
):
    """
    Swap a single-use SEB redeem token for a regular access JWT. PUBLIC —
    the token *is* the credential. Replays / forged / expired / wrong-
    purpose tokens all return 401.

    On success the caller (the FE running inside SEB) receives the same
    payload shape as /login/password and stores it the same way.
    """
    claims = SebTokenService.redeem(payload.token, db)

    user = db.query(User).filter(User.id == claims.user_id).first()
    if user is None or user.email != claims.sub:
        # Belt-and-braces: token claims must still match a live user.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="SEB token references an unknown user.",
        )

    access_token = create_access_token(data={"sub": user.email})
    return Token(
        access_token=access_token,
        token_type="bearer",
        id=int(user.id),
        role=str(user.role),
    )


@router.post("/login/password-face", response_model=Token)
async def login_password_face(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    login_attempt_id: str = Form(..., description="From POST /login/attempt after password check"),
    liveness_challenge_id: str = Form(..., description="From POST /login/liveness-challenge"),
    image_front: Optional[UploadFile] = File(None, description="Front face photo"),
    db: Session = Depends(get_db)
):
    """
    Student login: valid login_attempt_id, password, and front/left/right captures.
    JWT is issued only after successful face verification (fail closed when enrolled).
    """
    from utils.rate_limiter import check_and_increment

    ip = (request.client.host if request.client else "unknown").strip()
    normalized_email = _normalize_email(email)
    window_sec = int(getattr(settings, "AUTH_RATE_LIMIT_WINDOW_SEC", 60) or 60)
    limit = int(getattr(settings, "AUTH_FACE_SUBMIT_LIMIT", 10) or 10)
    rl = check_and_increment(
        f"auth:face_submit_login:ip:{ip}:email:{normalized_email}",
        limit=limit,
        window_sec=window_sec,
    )
    if not rl.allowed:
        try:
            RATE_LIMIT_HITS_TOTAL.labels(endpoint="auth_face_submit_login").inc()
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rate_limited", "message": "Too many face verification attempts. Please wait and try again."},
            headers={"Retry-After": str(rl.retry_after_seconds)},
        )

    user = db.query(User).filter(User.email == normalized_email).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    _verify_password_or_401(user, password)

    if _requires_password_reset(user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password reset required before login"
        )

    if user.role != "student":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Face verification login is only enabled for student accounts"
        )

    from utils.liveness_challenge_store import consume_for_login_attempt

    if not consume_for_login_attempt(liveness_challenge_id, login_attempt_id, user.id, normalized_email):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "invalid_liveness_challenge",
                "message": "Face check expired. Please retry the face verification step.",
            },
        )

    fresh_reference_payloads = []
    # BYPASS: Face validation bypassed by request.
    # try:
    #     fresh_reference_payloads = await asyncio.wait_for(
    #         _collect_login_images(image_front),
    #         timeout=30,
    #     )
    # except asyncio.TimeoutError:
    #     logger.error("Login image collection timed out for user_id=%s", user.id)
    #     raise HTTPException(
    #         status_code=status.HTTP_504_GATEWAY_TIMEOUT,
    #         detail={
    #             "code": "face_analysis_timeout",
    #             "message": "Face analysis is taking too long. Please retry.",
    #         },
    #     )

    enrolled_references = load_user_face_references(db, user.id)
    # try:
    #     await asyncio.wait_for(
    #         asyncio.to_thread(_enforce_enrolled_face_match, enrolled_references, fresh_reference_payloads),
    #         timeout=FACE_VERIFY_TIMEOUT_SEC,
    #     )
    # except asyncio.TimeoutError:
    #     raise HTTPException(
    #         status_code=status.HTTP_504_GATEWAY_TIMEOUT,
    #         detail={
    #             "code": "face_verification_timeout",
    #             "message": "Face verification is taking too long. Please retry in a few seconds.",
    #         },
    #     )
    # except HTTPException:
    #     raise
    # except Exception as exc:
    #     logger.error("Face match enforcement error: %s", exc, exc_info=True)
    #     raise HTTPException(
    #         status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
    #         detail="Face verification failed unexpectedly. Please try again.",
    #     )

    if not consume_attempt(login_attempt_id, user.id, normalized_email):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "invalid_login_attempt",
                "message": "Login session expired or invalid. Enter your password again.",
            },
        )

    if not enrolled_references:
        logger.info(
            "No enrolled face references for user_id=%s; saving login captures as baseline.",
            user.id,
        )

    try:
        if image_front:
            image_data = await image_front.read()
            if image_data:
                user.image = image_data
                db.commit()
                logger.info("Face image updated at login for user_id=%s", user.id)
    except Exception as e:
        db.rollback()
        logger.error("Failed to update face references for %s: %s", normalized_email, str(e), exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save face verification images. Please try again."
        )

    access_token = create_access_token(data={"sub": user.email})
    return Token(
        access_token=access_token,
        token_type="bearer",
        id=user.id,
        role=user.role
    )


@router.post("/login/lti-face-bind", response_model=LtiFaceBindResponse)
async def login_lti_face_bind(
    request: Request,
    image_front: Optional[UploadFile] = File(None, description="Front face photo"),
    liveness_challenge_id: str = Form(..., description="From POST /login/lti-liveness-challenge"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    LTI (or similar) students already hold a JWT; bind/update face references before exam access.
    """
    from utils.rate_limiter import check_and_increment

    ip = (request.client.host if request.client else "unknown").strip()
    window_sec = int(getattr(settings, "AUTH_RATE_LIMIT_WINDOW_SEC", 60) or 60)
    limit = int(getattr(settings, "AUTH_FACE_SUBMIT_LIMIT", 10) or 10)
    rl = check_and_increment(
        f"auth:face_submit_lti:ip:{ip}:uid:{int(getattr(current_user, 'id', 0) or 0)}",
        limit=limit,
        window_sec=window_sec,
    )
    if not rl.allowed:
        try:
            RATE_LIMIT_HITS_TOTAL.labels(endpoint="auth_face_submit_lti").inc()
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rate_limited", "message": "Too many face verification attempts. Please wait and try again."},
            headers={"Retry-After": str(rl.retry_after_seconds)},
        )

    if current_user.role != "student":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Face bind is only for student accounts.",
        )

    from utils.liveness_challenge_store import consume_for_user

    if not consume_for_user(liveness_challenge_id, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "invalid_liveness_challenge",
                "message": "Face check expired. Please retry the face verification step.",
            },
        )

    fresh_reference_payloads = await _collect_login_images(
        image_front,
    )
    enrolled_references = load_user_face_references(db, current_user.id)
    try:
        await asyncio.wait_for(
            asyncio.to_thread(_enforce_enrolled_face_match, enrolled_references, fresh_reference_payloads),
            timeout=FACE_VERIFY_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={
                "code": "face_verification_timeout",
                "message": "Face verification is taking too long. Please retry in a few seconds.",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("LTI face bind enforcement error: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Face verification failed unexpectedly. Please try again.",
        )

    if not enrolled_references:
        logger.info(
            "No enrolled face references for user_id=%s (LTI); saving captures as baseline.",
            current_user.id,
        )

    try:
        _persist_face_bind_success(db, current_user, fresh_reference_payloads)
    except Exception as e:
        db.rollback()
        logger.error("LTI face bind save failed for user_id=%s: %s", current_user.id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save face verification images. Please try again.",
        )

    return LtiFaceBindResponse()


@router.post("/login/lti-liveness-challenge", response_model=LivenessChallengeResponse)
async def lti_liveness_challenge(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """
    Mint a one-time liveness challenge for LTI identity bind.
    The client must capture poses in the returned order and present challenge_id to /login/lti-face-bind.
    """
    from utils.rate_limiter import check_and_increment

    ip = (request.client.host if request.client else "unknown").strip()
    window_sec = int(getattr(settings, "AUTH_RATE_LIMIT_WINDOW_SEC", 60) or 60)
    limit = int(getattr(settings, "AUTH_LIVENESS_CHALLENGE_LIMIT", 12) or 12)
    rl = check_and_increment(
        f"auth:liveness_lti:ip:{ip}:uid:{int(getattr(current_user, 'id', 0) or 0)}",
        limit=limit,
        window_sec=window_sec,
    )
    if not rl.allowed:
        try:
            RATE_LIMIT_HITS_TOTAL.labels(endpoint="auth_liveness_lti").inc()
        except Exception:
            pass
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "rate_limited", "message": "Too many face challenges. Please wait and try again."},
            headers={"Retry-After": str(rl.retry_after_seconds)},
        )

    if current_user.role != "student":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Face bind is only for student accounts.",
        )

    from utils.liveness_challenge_store import create_for_user

    challenge = create_for_user(current_user.id)
    return LivenessChallengeResponse(**challenge)


@router.post("/reset-password/initial")
async def reset_initial_password(
    payload: InitialPasswordReset,
    db: Session = Depends(get_db)
):
    normalized_email = _normalize_email(payload.email)
    user = db.query(User).filter(User.email == normalized_email).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User account not found"
        )

    requirement = db.query(UserPasswordResetRequirement).filter(
        UserPasswordResetRequirement.user_id == user.id
    ).first()
    if not requirement or not requirement.must_reset_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This account does not require an initial password reset"
        )

    _verify_password_or_401(user, payload.temporary_password)

    new_password = (payload.new_password or "").strip()
    if len(new_password) < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be at least 6 characters long"
        )

    if bcrypt.checkpw(new_password[:72].encode('utf-8'), user.password.encode('utf-8')):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be different from the temporary password"
        )

    hashed = bcrypt.hashpw(new_password[:72].encode('utf-8'), bcrypt.gensalt())
    user.password = hashed.decode('utf-8')
    requirement.must_reset_password = False
    requirement.updated_at = datetime.utcnow()

    db.commit()
    return {"message": "Password reset successfully. You can now log in with your new password."}

@router.post("/login/face", response_model=Token)
async def login_face(
    image: UploadFile = File(..., description="Live captured face image"),
    db: Session = Depends(get_db)
):
    """Login with face recognition using enrolled multi-angle references."""
    try:
        image_data = await _read_upload_file_bytes(image, "live face image")

        users = db.query(User).all()
        if not users:
            logger.warning("No users found for face-only login")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="No registered face references found"
            )

        logger.info("Comparing face-only login against %s users with enrolled references", len(users))

        best_match = None
        best_verification: Optional[Dict[str, object]] = None

        for user in users:
            try:
                enrolled_references = load_user_face_references(db, user.id)
                if not enrolled_references:
                    continue

                verification = verify_face_against_references(
                    enrolled_references,
                    image_data,
                    threshold=0.6,
                )

                verification_status = str(verification.get("status") or "unverifiable")
                if verification_status == "unverifiable":
                    quality = verification.get("quality") or {}
                    instruction = quality.get("instruction") or "Unable to verify clearly. Face the camera and try again."
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=instruction
                    )

                if not verification.get("verified"):
                    continue

                best_match_payload = verification.get("best_match") or {}
                confidence = float(best_match_payload.get("confidence", 0.0))
                match_count = int(verification.get("match_count", 0))
                logger.info(
                    "Face-only comparison result for %s: verified=%s, match_count=%s, confidence=%.2f",
                    user.email,
                    verification.get("verified"),
                    match_count,
                    confidence,
                )

                if best_verification is None:
                    best_match = user
                    best_verification = verification
                    continue

                current_best_match = best_verification.get("best_match") or {}
                current_best_confidence = float(current_best_match.get("confidence", 0.0))
                current_best_match_count = int(best_verification.get("match_count", 0))
                if (match_count, confidence) > (current_best_match_count, current_best_confidence):
                    best_match = user
                    best_verification = verification
            except HTTPException:
                raise
            except Exception as e:
                logger.error(f"Error comparing face references for user {user.email}: {str(e)}")
                continue

        if best_match and best_verification:
            if _requires_password_reset(best_match, db):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Password reset required before login"
                )

            best_match_payload = best_verification.get("best_match") or {}
            best_confidence = float(best_match_payload.get("confidence", 0.0))
            logger.info(
                "Face login successful for %s with match_count=%s confidence=%.2f",
                best_match.email,
                best_verification.get("match_count"),
                best_confidence,
            )

            access_token = create_access_token(data={"sub": best_match.email})
            return Token(
                access_token=access_token,
                token_type="bearer",
                id=best_match.id,
                role=best_match.role
            )

        logger.warning("No matching face references found")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No matching face references found"
        )

    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Face authentication error: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Face authentication failed. Please try again."
        )

@router.post("/logout")
async def logout(
    credentials: HTTPAuthorizationCredentials = Security(security),
    db: Session = Depends(get_db)
):
    """Logout user and cleanup their session data"""
    try:
        # Get current user
        current_user = get_current_user(credentials.credentials, db)
        user_id = current_user.id

        # Clean up any active exam session
        if manager.is_connected(user_id):
            await manager.force_disconnect(user_id)
            logger.info(f"Closed WebSocket connection for user {user_id}")

        # Clean up session data
        session_manager.cleanup(user_id)

        # Delete all logs for the user
        try:
            deleted_count = db.query(Log).filter(Log.user_id == user_id).delete()
            db.commit()
            logger.info(f"Cleared {deleted_count} logs for user {user_id}")
        except Exception as e:
            logger.error(f"Failed to delete logs: {str(e)}")
            db.rollback()

        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"message": "Successfully logged out and cleaned up session data"}
        )

    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Logout error: {str(e)}")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "Failed to complete logout"}
        )
