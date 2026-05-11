from .base import Base
from sqlalchemy import Column, Integer, String, DateTime, Boolean, ForeignKey, Float
from sqlalchemy.orm import relationship
from sqlalchemy.types import JSON
from datetime import datetime
from typing import Optional, Any

class ExamSession(Base):
    __tablename__ = "exam_sessions"

    id: Any = Column(Integer, primary_key=True, index=True) # type: ignore
    user_id: Any = Column(Integer, ForeignKey("users.id")) # type: ignore
    exam_id: Any = Column(Integer, ForeignKey("exams.id"), nullable=True) # type: ignore
    
    start_time: Any = Column(DateTime, default=datetime.utcnow) # type: ignore
    end_time: Any = Column(DateTime, nullable=True) # type: ignore
    
    status: Any = Column(String(20), default="active")  # active, paused, submitted, terminated # type: ignore
    
    # Crash Recovery & Progress
    remaining_seconds: Any = Column(Integer, nullable=True) # type: ignore
    current_question_index: Any = Column(Integer, default=0) # type: ignore
    saved_answers: Any = Column(JSON, default={}) # {"q_id": "answer"} # type: ignore
    
    is_summarized: Any = Column(Boolean, default=False) # type: ignore
    score: Any = Column(Float, nullable=True) # type: ignore
    overall_compliance: Any = Column(Float, nullable=True) # type: ignore

    # Mark-penalty engine outputs (services/mark_penalty_service.py).
    # Computed automatically after grading and on-demand when a summary is
    # viewed. NULL means "not yet computed for this session".
    major_violation_count: Any = Column(Integer, nullable=True)  # type: ignore
    critical_violation_count: Any = Column(Integer, nullable=True)  # type: ignore
    proctor_penalty_pct: Any = Column(Float, nullable=True)  # type: ignore
    proctor_adjusted_score: Any = Column(Float, nullable=True)  # type: ignore

    # Admin's final-score decision. NULL final_score == pending review.
    final_score: Any = Column(Float, nullable=True)  # type: ignore
    score_decision: Any = Column(String(16), nullable=True)  # "raw"|"penalised"|"manual" type: ignore
    score_decision_by: Any = Column(Integer, ForeignKey("users.id"), nullable=True)  # type: ignore
    score_decision_at: Any = Column(DateTime, nullable=True)  # type: ignore

    # Relationships
    user = relationship("User", foreign_keys=[user_id], back_populates="exam_sessions")
    exam = relationship("Exam", back_populates="sessions")
    score_decided_by_user = relationship("User", foreign_keys=[score_decision_by])
