from pydantic import BaseModel, EmailStr
from datetime import datetime
from typing import Dict, Union, Optional, List
import base64

class ViolationDetail(BaseModel):
    count: int
    first_occurrence: str

class LogCreate(BaseModel):
    log: str
    event_type: str
    event_data: Optional[Dict] = None

class UserInfo(BaseModel):
    email: str
    image: Optional[str] = None  # Base64 encoded image

class ExamSummary(BaseModel):
    total_duration: float  # in minutes
    face_detection_rate: float  # percentage of time face was detected
    suspicious_activities: Dict[str, Union[int, ViolationDetail]]  # count or details of each suspicious activity
    overall_compliance: float  # overall compliance percentage
    user: Optional[UserInfo] = None  # User information

class AnswerSchema(BaseModel):
    question_id: int
    selected_option: Optional[str] = None  # null if skipped

class ExamSubmission(BaseModel):
    answers: List[AnswerSchema]


class ExamProgressUpdate(BaseModel):
    exam_id: Optional[int] = None
    answers: Dict[str, Optional[str]] = {}
    current_question_index: int = 0
    remaining_seconds: int = 0


class ExamProgressState(BaseModel):
    session_id: int
    exam_id: Optional[int] = None
    saved_answers: Dict[str, Optional[str]] = {}
    current_question_index: int = 0
    remaining_seconds: int = 0
    resumed: bool = True

class ExamResult(BaseModel):
    total_questions: int
    attempted: int
    correct: int
    wrong: int
    score: float
    total_marks: float
    percentage: float
    status: str  # passed/failed
    # Final admin-decided score; None == pending admin review.
    final_score: Optional[float] = None

class QuestionCreate(BaseModel):
    text: str
    question_type: str = "MCQ"
    options: Optional[List[str]] = None
    correct_option: Optional[str] = None
    marks: float = 1.0
    image_url: Optional[str] = None

class ExamCreate(BaseModel):
    title: str
    description: Optional[str] = None
    start_time: datetime
    end_time: datetime
    duration_minutes: int
    is_active: bool = True
    config: Optional[Dict] = {}
    questions: Optional[List[QuestionCreate]] = []
    eligible_emails: Optional[List[EmailStr]] = []

class ExamLink(BaseModel):
    exam_url: str
    exam_id: int
    temporary_password: Optional[str] = None
    eligible_email_count: int = 0
    monitor_key: Optional[str] = None

class AvailableExam(BaseModel):
    id: int
    title: str
    description: Optional[str] = None
    duration_minutes: int
    start_time: datetime
    end_time: datetime
    status: str
    can_join: bool
    action_message: str
    question_count: int = 0
    last_session_status: Optional[str] = None
