from sqlalchemy.orm import Session
from models.questions import Question
from models.sessions import ExamSession
from models.logs import Log
from schemas.exam import ExamSubmission, ExamResult
from services.mark_penalty_service import MarkPenaltyService
from utils.logger import logger
from datetime import datetime
import re
from typing import Optional

class GradingService:
    """Robust grading service supporting MCQ, True/False, and Short Answer questions"""
    
    @staticmethod
    def normalize_answer(answer: Optional[str]) -> str:
        """Normalize answer for comparison - lowercase, strip whitespace, remove extra spaces"""
        if answer is None:
            return ""
        return re.sub(r'\s+', ' ', str(answer).strip().lower())
    
    @staticmethod
    def grade_mcq(user_answer: Optional[str], correct_answer: Optional[str]) -> bool:
        """Grade MCQ question - exact match after normalization"""
        normalized_user = GradingService.normalize_answer(user_answer)
        normalized_correct = GradingService.normalize_answer(correct_answer)
        return normalized_user == normalized_correct
    
    @staticmethod
    def grade_true_false(user_answer: Optional[str], correct_answer: Optional[str]) -> bool:
        """Grade True/False question - handles various formats"""
        true_variants = {'true', 't', 'yes', 'y', '1', 'correct'}
        false_variants = {'false', 'f', 'no', 'n', '0', 'incorrect'}
        
        normalized_user = GradingService.normalize_answer(user_answer)
        normalized_correct = GradingService.normalize_answer(correct_answer)
        
        user_is_true = normalized_user in true_variants
        user_is_false = normalized_user in false_variants
        correct_is_true = normalized_correct in true_variants
        correct_is_false = normalized_correct in false_variants
        
        if user_is_true and correct_is_true:
            return True
        if user_is_false and correct_is_false:
            return True
        
        # Fallback to exact match
        return normalized_user == normalized_correct
    
    @staticmethod
    def grade_short_answer(user_answer: Optional[str], correct_answer: Optional[str]) -> bool:
        """Grade Short Answer question - flexible matching"""
        normalized_user = GradingService.normalize_answer(user_answer)
        normalized_correct = GradingService.normalize_answer(correct_answer)
        
        # Exact match
        if normalized_user == normalized_correct:
            return True
        
        # Check if correct answer is contained in user answer or vice versa
        # This helps with slight variations
        if len(normalized_correct) > 3 and len(normalized_user) > 3:
            if normalized_correct in normalized_user or normalized_user in normalized_correct:
                return True
        
        return False
    
    @staticmethod
    def grade_question(question_type: Optional[str], user_answer: Optional[str], correct_answer: Optional[str]) -> bool:
        """Route to appropriate grader based on question type"""
        q_type = (question_type or "MCQ").upper().strip()
        
        if q_type in ["TRUE_FALSE", "TRUEFALSE", "TF", "BOOLEAN"]:
            return GradingService.grade_true_false(user_answer, correct_answer)
        elif q_type in ["SHORT_ANSWER", "SHORTANSWER", "SHORT", "SUBJECTIVE", "TEXT"]:
            return GradingService.grade_short_answer(user_answer, correct_answer)
        else:  # Default to MCQ
            return GradingService.grade_mcq(user_answer, correct_answer)
    
    @staticmethod
    async def grade_exam(user_id: int, submission: ExamSubmission, db: Session) -> ExamResult:
        try:
            # 1. Fetch current session to get exam_id
            session = db.query(ExamSession).filter(
                ExamSession.user_id == user_id,
                ExamSession.status != "terminated"
            ).order_by(ExamSession.start_time.desc()).first()
            
            if not session:
                raise ValueError("Active exam session not found")

            # 2. Fetch all questions for this exam
            questions = db.query(Question).filter(Question.exam_id == session.exam_id).all()
            question_map = {q.id: q for q in questions}
            
            logger.info(f"Grading exam for user {user_id}, exam_id: {session.exam_id}, questions: {len(questions)}")

            # 3. Calculate Score
            correct_count: int = 0
            wrong_count = 0
            total_score: float = 0.0
            attempted_count = 0
            
            # Create maps for tracking
            user_answers_map = {}
            grading_details = []
            
            for answer in submission.answers:
                question_id = answer.question_id
                user_answer = answer.selected_option
                user_answers_map[str(question_id)] = user_answer
                
                if question_id not in question_map:
                    logger.warning(f"Question {question_id} not found in exam")
                    continue
                    
                question = question_map[question_id]
                
                # Skip if not attempted
                if not user_answer or str(user_answer).strip() == "":
                    grading_details.append({
                        "question_id": question_id,
                        "status": "skipped"
                    })
                    continue
                    
                attempted_count += 1
                
                # Grade based on question type
                is_correct = GradingService.grade_question(
                    question.question_type,
                    user_answer,
                    question.correct_option
                )
                
                logger.debug(f"Q{question_id}: type={question.question_type}, user='{user_answer}', correct='{question.correct_option}', result={is_correct}")
                
                if is_correct:
                    correct_count += 1
                    total_score += float(question.marks or 0)
                    grading_details.append({
                        "question_id": question_id,
                        "status": "correct",
                        "marks": float(question.marks or 0)
                    })
                else:
                    wrong_count += 1
                    grading_details.append({
                        "question_id": question_id,
                        "status": "wrong",
                        "marks": 0
                    })
            
            # 4. Calculate final stats
            total_questions = len(questions)
            max_marks = sum(q.marks for q in questions)
            percentage = (total_score / max_marks * 100) if max_marks > 0 else 0

            logger.info(f"Grading complete: {correct_count}/{total_questions} correct, score: {total_score}/{max_marks}, percentage: {percentage:.2f}%")

            # 5. Update Session
            session.score = total_score
            session.saved_answers = user_answers_map
            session.status = "completed"
            session.end_time = datetime.utcnow()

            # 6. Compute the proctor mark-penalty recommendation. The admin
            #    still picks the final_score later via the score-decision
            #    endpoint, so we deliberately leave `final_score` /
            #    `score_decision` NULL ("pending review").
            try:
                GradingService._recompute_proctor_decision(
                    db=db,
                    session=session,
                    raw_score=total_score,
                    total_marks=float(max_marks or 0.0),
                )
            except Exception as exc:
                logger.warning(
                    f"Penalty recompute failed for session {session.id}: {exc}"
                )

            db.commit()

            return ExamResult(
                total_questions=total_questions,
                attempted=attempted_count,
                correct=correct_count,
                wrong=wrong_count,
                score=total_score,
                total_marks=max_marks,
                percentage=round(percentage, 2),
                status="passed" if percentage >= 40 else "failed",
                final_score=None,
            )

        except Exception as e:
            logger.error(f"Grading error for user {user_id}: {str(e)}")
            db.rollback()
            raise e

    # ──────────────────────────────────────────────────────────────────
    # Proctor mark-penalty recompute helper.
    #
    # Counts MAJOR + CRITICAL violation logs for the session and writes the
    # AI-recommended deduction columns onto the session. Called both from
    # grade_exam (post-grade) and from get_exam_summary (so older sessions
    # without these fields self-heal on first view — "compute on demand").
    # ──────────────────────────────────────────────────────────────────

    @staticmethod
    def _recompute_proctor_decision(
        *,
        db: Session,
        session: ExamSession,
        raw_score: float,
        total_marks: float,
    ) -> None:
        """Populate `major_violation_count`, `critical_violation_count`,
        `proctor_penalty_pct`, `proctor_adjusted_score` on `session`.

        Does NOT touch `final_score` / `score_decision` — those stay under
        admin control. Caller is responsible for committing.
        """
        # Pull all logs for this user that fell within this session's time
        # window. session_id is not currently set on Log rows, so we
        # bracket by [start_time, end_time] to scope to *this attempt*.
        end_ts = getattr(session, "end_time", None) or datetime.utcnow()
        start_ts = getattr(session, "start_time", None)
        log_query = db.query(Log).filter(Log.user_id == session.user_id)
        if start_ts is not None:
            log_query = log_query.filter(Log.timestamp >= start_ts)
        log_query = log_query.filter(Log.timestamp <= end_ts)

        result = MarkPenaltyService.compute_from_logs(
            log_query.all(),
            raw_score=raw_score,
            total_marks=total_marks,
        )

        session.major_violation_count = result.major_count
        session.critical_violation_count = result.critical_count
        session.proctor_penalty_pct = result.penalty_pct
        session.proctor_adjusted_score = result.adjusted_score
        session.overall_compliance = max(0.0, 100.0 - result.penalty_pct)

