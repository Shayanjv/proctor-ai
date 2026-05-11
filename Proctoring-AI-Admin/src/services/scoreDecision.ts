import api from './api';

/**
 * Mark-penalty / score-decision admin API helper.
 *
 * The backend endpoint is:
 *   POST /api/v1/exam/admin/session/{session_id}/score-decision
 *   body: { decision: "raw" | "penalised" | "manual", manual_score?: number }
 *
 * Response shape: { session: SessionScoreDecision }.
 */

export type ScoreDecisionChoice = 'raw' | 'penalised' | 'manual';

/**
 * The session payload returned by both the admin summary endpoints AND by
 * the score-decision endpoint. Mirrors `_build_session_summary_dict` in
 * routers/exam.py.
 *
 * Most penalty fields are nullable: `null` means "not yet computed" or
 * "pending admin review".
 */
export interface SessionScoreDecision {
  id: number;
  status: string;
  score: number;                                  // raw correctness score
  total_marks: number;
  percentage: number;
  start_time: string | null;
  end_time: string | null;
  compliance: number;

  major_violation_count: number | null;
  critical_violation_count: number | null;
  proctor_penalty_pct: number | null;             // 0..cap
  proctor_adjusted_score: number | null;          // raw - deduction (>= 0)

  final_score: number | null;                     // null = pending
  score_decision: ScoreDecisionChoice | null;     // null = pending
  score_decision_by: string | null;               // admin email
  score_decision_at: string | null;

  penalty_config: {
    free_strikes: number;
    per_major_pct: number;
    critical_multiplier: number;
    per_critical_pct: number;
    cap_pct: number;
  };
}

export interface ScoreDecisionRequest {
  decision: ScoreDecisionChoice;
  manual_score?: number | null;
}

/**
 * Commit a final score decision for an exam attempt.
 * Throws on network / validation error so callers can show a toast.
 */
export async function setScoreDecision(
  sessionId: number,
  request: ScoreDecisionRequest,
): Promise<SessionScoreDecision> {
  const response = await api.post(
    `exam/admin/session/${sessionId}/score-decision`,
    request,
  );
  return response.data?.session as SessionScoreDecision;
}
