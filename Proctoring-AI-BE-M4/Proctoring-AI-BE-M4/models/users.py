from .base import Base
from sqlalchemy import Column, Integer, String, Boolean, LargeBinary
from sqlalchemy.orm import relationship
import enum

from typing import Any, Optional

class UserRole(str, enum.Enum):
    STUDENT = "student"
    ADMIN = "admin"
    PROCTOR = "proctor"

class User(Base):
    __tablename__ = "users"

    id: Any = Column(Integer, primary_key=True, index=True) # type: ignore
    email: Any = Column(String(255), unique=True, index=True) # type: ignore
    password: Any = Column(String(255)) # type: ignore
    image: Any = Column(LargeBinary, nullable=True) # type: ignore
    
    @property
    def has_image(self) -> bool:
        return self.image is not None
    
    # New Fields
    full_name: Any = Column(String(255), nullable=True) # type: ignore
    role: Any = Column(String(50), default=UserRole.STUDENT.value) # type: ignore
    roll_number: Any = Column(String(50), unique=True, index=True, nullable=True) # type: ignore
    department: Any = Column(String(100), nullable=True) # type: ignore
    
    # Relationships
    logs = relationship("Log", back_populates="user")
    # ExamSession has two FKs to users (user_id, score_decision_by) so we
    # disambiguate which one this back-populating relationship binds to.
    exam_sessions = relationship(
        "ExamSession",
        back_populates="user",
        foreign_keys="ExamSession.user_id",
    )
    created_exams = relationship("Exam", back_populates="creator")
    evidence = relationship("Evidence", back_populates="user")
    face_references = relationship("UserFaceReference", cascade="all, delete-orphan")
