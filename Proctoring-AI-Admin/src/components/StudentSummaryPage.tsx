import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronLeft,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Trophy,
  Clock,
  Shield,
  BookOpen,
  Target,
  TrendingUp,
  AlertCircle,
  BarChart3,
  FileText,
  Minus,
} from 'lucide-react';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
} from 'recharts';
import api from '../services/api';
import { formatServerTime, parseServerDate } from '../utils/dateTime';
import { ScoreDecisionCard } from './ScoreDecisionCard';
import type { SessionScoreDecision } from '../services/scoreDecision';

interface StudentSummaryPageProps {
  sessionId: number | null;
  onBack: () => void;
}

interface QuestionDetail {
  id: number;
  text: string;
  type: string;
  options: string[] | null;
  correct_option: string;
  user_answer: string | null;
  is_correct: boolean;
  marks: number;
  marks_obtained: number;
}

interface SummaryData {
  student: { id: number; email: string; full_name: string; image: string | null };
  exam: { id: number; title: string; duration_minutes: number };
  /**
   * Session block. Mirrors `_build_session_summary_dict` in routers/exam.py;
   * includes mark-penalty / score-decision fields used by
   * <ScoreDecisionCard>.
   */
  session: SessionScoreDecision;
  questions: QuestionDetail[];
  violations: Array<{ type: string; timestamp: string; data: any }>;
  violation_count: number;
}

/* ─── animated counter hook ─── */
function useCountUp(target: number, duration = 1200) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let start: number | null = null;
    const step = (ts: number) => {
      if (!start) start = ts;
      const prog = Math.min((ts - start) / duration, 1);
      const ease = 1 - Math.pow(1 - prog, 3);
      setValue(Math.round(ease * target));
      if (prog < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [target, duration]);
  return value;
}

/* ─── SVG circular score ring ─── */
function ScoreRing({ pct, color, size = 160 }: { pct: number; color: string; size?: number }) {
  const r = (size - 16) / 2;
  const circ = 2 * Math.PI * r;
  const animated = useCountUp(pct);
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={{ strokeDashoffset: circ }}
          animate={{ strokeDashoffset: circ - (circ * pct) / 100 }}
          transition={{ duration: 1.4, ease: 'easeOut' }}
          style={{ filter: `drop-shadow(0 0 8px ${color}80)` }}
        />
      </svg>
      {/* Centered percentage. The page sits on a white card so the number
          needs a dark colour — the legacy `text-white` was literally invisible
          (white-on-white) which is what produced the "empty SCORE ring" screenshot. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-black leading-none" style={{ color }}>{animated}%</span>
        <span className="text-[10px] font-bold uppercase tracking-widest mt-1 text-slate-500">Score</span>
      </div>
    </div>
  );
}

/* ─── custom tooltip ─── */
const DarkTooltip = ({ active, payload }: any) => {
  if (active && payload?.length) {
    return (
      <div style={{ background: 'rgba(10,15,30,0.96)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, padding: '8px 14px' }}>
        <p className="text-sm font-bold text-white">{payload[0].name}: <span style={{ color: payload[0].payload.color }}>{payload[0].value}</span></p>
      </div>
    );
  }
  return null;
};

type Tab = 'audit' | 'violations';

export function StudentSummaryPage({ sessionId, onBack }: StudentSummaryPageProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SummaryData | null>(null);
  const [tab, setTab] = useState<Tab>('audit');
  const [filterQ, setFilterQ] = useState<'all' | 'correct' | 'wrong' | 'skipped'>('all');

  useEffect(() => { if (sessionId) fetchSummary(); }, [sessionId]);

  const fetchSummary = async () => {
    if (!sessionId) return;
    setLoading(true); setError(null);
    try {
      const res = await api.get(`exam/admin/summary/session/${sessionId}`);
      setData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to load student summary');
    } finally { setLoading(false); }
  };

  const stats = useMemo(() => {
    if (!data) return null;
    const total = data.questions.length;
    const correct = data.questions.filter(q => q.is_correct).length;
    const wrong = data.questions.filter(q => q.user_answer && !q.is_correct).length;
    const skipped = data.questions.filter(q => !q.user_answer).length;
    const attempted = total - skipped;
    const accuracy = Math.round((correct / (attempted || 1)) * 100);
    const chartData = [
      { name: 'Correct', value: correct, color: '#22c55e' },
      { name: 'Wrong', value: wrong, color: '#ef4444' },
      { name: 'Skipped', value: skipped, color: '#475569' },
    ].filter(d => d.value > 0);
    let durationText = 'N/A';
    if (data.session.start_time && data.session.end_time) {
      const s = parseServerDate(data.session.start_time);
      const e = parseServerDate(data.session.end_time);
      if (s && e) { const m = Math.max(0, Math.round((e.getTime() - s.getTime()) / 60000)); durationText = `${m} min`; }
    }
    return { total, correct, wrong, skipped, attempted, accuracy, chartData, durationText };
  }, [data]);

  const filteredQ = useMemo(() => {
    if (!data) return [];
    if (filterQ === 'correct') return data.questions.filter(q => q.is_correct);
    if (filterQ === 'wrong') return data.questions.filter(q => q.user_answer && !q.is_correct);
    if (filterQ === 'skipped') return data.questions.filter(q => !q.user_answer);
    return data.questions;
  }, [data, filterQ]);

  /* ── Loading ── */
  if (loading) return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-5">
        <div className="relative h-20 w-20 rounded-3xl flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg,rgba(99,102,241,0.15),rgba(139,92,246,0.10))', border: '1px solid rgba(99,102,241,0.25)', boxShadow: '0 0 40px rgba(99,102,241,0.1)' }}>
          <Loader2 className="h-9 w-9 animate-spin text-violet-400" />
        </div>
        <div className="text-center">
          <p className="text-base font-bold text-slate-900">Loading Summary</p>
          <p className="text-xs text-slate-500 mt-1">Fetching session data...</p>
        </div>
      </div>
    </div>
  );

  /* ── Error ── */
  if (error || !data || !stats) return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-50">
      <div className="h-20 w-20 rounded-3xl flex items-center justify-center" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)' }}>
        <AlertTriangle className="h-10 w-10 text-amber-400" />
      </div>
      <div className="text-center">
        <h3 className="text-xl font-black text-slate-900 mb-2">Summary Unavailable</h3>
        <p className="text-slate-400 max-w-sm text-sm">{error || 'No data for this session.'}</p>
      </div>
      <button onClick={onBack} className="flex items-center gap-2 rounded-2xl px-6 py-3 text-sm font-bold text-white"
        style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 4px 24px rgba(99,102,241,0.3)' }}>
        <ChevronLeft className="h-4 w-4" /> Back to Dashboard
      </button>
    </div>
  );

  const passed = data.session.percentage >= 40;
  const compColor = data.session.compliance > 80 ? '#22c55e' : data.session.compliance > 50 ? '#f59e0b' : '#ef4444';
  const scoreColor = data.session.percentage >= 80 ? '#22c55e' : data.session.percentage >= 40 ? '#818cf8' : '#ef4444';

  return (
    <div className="min-h-screen pb-20 bg-slate-50">
      <style>{`
        .sp-glass { background: rgba(255,255,255,0.8); backdrop-filter: blur(24px); border: 1px solid rgba(0,0,0,0.08); }
        .sp-card { background: #ffffff; border: 1px solid rgba(0,0,0,0.08); box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .sp-inset { background: #f8fafc; border: 1px solid rgba(0,0,0,0.06); }
        .pulse2 { animation: p2 2s ease-in-out infinite; }
        @keyframes p2 { 0%,100%{opacity:1;} 50%{opacity:0.35;} }
        .prog-wrap { height:8px; border-radius:99px; background:rgba(0,0,0,0.06); overflow:hidden; }
        .prog-fill { height:100%; border-radius:99px; }
        .tab-active { background: linear-gradient(135deg,rgba(99,102,241,0.15),rgba(139,92,246,0.10)); border-color: rgba(99,102,241,0.4)!important; color:#6366f1!important; }
        .tab-btn { border: 1px solid rgba(0,0,0,0.08); color: rgba(100,116,139,1); transition: all .2s; border-radius: 12px; }
        .tab-btn:hover { border-color: rgba(99,102,241,0.3); color:#6366f1; }
        .q-correct { border-color: rgba(34,197,94,0.22); background: rgba(34,197,94,0.04); }
        .q-wrong   { border-color: rgba(239,68,68,0.22);  background: rgba(239,68,68,0.04); }
        .q-skipped { border-color: rgba(0,0,0,0.06); background: rgba(248,250,252,1); }
        .q-card { border: 1px solid; border-radius:20px; transition: transform .15s, box-shadow .15s; }
        .q-card:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(0,0,0,0.08); }
        .scrollbar-sp::-webkit-scrollbar { width:5px; }
        .scrollbar-sp::-webkit-scrollbar-track { background:rgba(0,0,0,0.02); }
        .scrollbar-sp::-webkit-scrollbar-thumb { background:rgba(0,0,0,0.12); border-radius:10px; }
        .v-chip { background:rgba(239,68,68,0.06); border:1px solid rgba(239,68,68,0.15); border-radius:12px; }
        .hero-shimmer::after { content:''; position:absolute; inset:0; background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,0.4) 50%,transparent 65%); background-size:200% 100%; animation:shimmer 3s ease-in-out infinite; pointer-events:none; }
        @keyframes shimmer { 0%{background-position:200% 0;} 100%{background-position:-200% 0;} }
      `}</style>

      <div className="mx-auto max-w-[1300px] px-5 py-7 space-y-5">

        {/* ── BACK NAV ── */}
        <motion.button initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }}
          onClick={onBack}
          className="group flex items-center gap-3 text-slate-400 hover:text-white transition-all duration-200">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl sp-glass transition-all duration-200 group-hover:border-violet-500/40 group-hover:bg-violet-500/10">
            <ChevronLeft className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold">Back to Results</span>
        </motion.button>

        {/* ══════════ HERO BANNER ══════════ */}
        <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}
          className="sp-card rounded-3xl overflow-hidden relative hero-shimmer">
          {/* background glow */}
          <div className="absolute inset-0 pointer-events-none" style={{
            background: passed
              ? 'radial-gradient(ellipse 60% 80% at 80% 50%, rgba(34,197,94,0.06) 0%, transparent 70%)'
              : 'radial-gradient(ellipse 60% 80% at 80% 50%, rgba(239,68,68,0.06) 0%, transparent 70%)'
          }} />

          <div className="relative p-7 lg:p-8">
            <div className="flex flex-col lg:flex-row items-start lg:items-center gap-8">

              {/* Avatar + name.
                  The avatar slot is locked to 88x88 with INLINE styles (not
                  Tailwind arbitrary classes) so the student's base64 webcam
                  image — which can have intrinsic dimensions of 1280x720 or
                  larger — cannot burst out of the slot if Tailwind purging
                  drops `h-[88px]`/`w-[88px]` for any reason. The earlier UI
                  bug showed the photo rendering at ~600x400 because the img
                  was effectively unconstrained. */}
              <div className="flex items-center gap-5 flex-1 min-w-0">
                <div className="relative flex-shrink-0" style={{ width: 88, height: 88 }}>
                  <div
                    className="rounded-2xl overflow-hidden flex items-center justify-center text-4xl font-black text-white"
                    style={{
                      width: 88,
                      height: 88,
                      background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                      boxShadow: '0 8px 32px rgba(99,102,241,0.3)',
                    }}
                  >
                    {data.student.image
                      ? (
                        <img
                          src={`data:image/jpeg;base64,${data.student.image}`}
                          alt={data.student.full_name}
                          style={{ width: 88, height: 88, objectFit: 'cover', display: 'block' }}
                        />
                      )
                      : (data.student.full_name?.[0] || 'S').toUpperCase()}
                  </div>
                  <div className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full border-2 flex items-center justify-center" style={{ background: '#f8fafc', borderColor: '#f8fafc' }}>
                    <div className="h-3.5 w-3.5 rounded-full pulse2" style={{ background: '#22c55e', boxShadow: '0 0 8px #22c55e' }} />
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-3 flex-wrap mb-1">
                    <h1 className="text-2xl font-black text-slate-900">{data.student.full_name}</h1>
                    <span className="rounded-xl px-3 py-1 text-xs font-black uppercase tracking-wider flex items-center gap-1.5"
                      style={{
                        background: passed ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                        border: passed ? '1px solid rgba(34,197,94,0.35)' : '1px solid rgba(239,68,68,0.35)',
                        color: passed ? '#16a34a' : '#dc2626',
                        boxShadow: passed ? '0 0 20px rgba(34,197,94,0.1)' : '0 0 20px rgba(239,68,68,0.1)',
                      }}>
                      {passed ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                      {passed ? 'Passed' : 'Failed'}
                    </span>
                  </div>
                  <p className="text-slate-500 text-sm">{data.student.email}</p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {[
                      { icon: Trophy, text: data.exam.title, col: '#a78bfa' },
                      { icon: Clock, text: stats.durationText, col: '#60a5fa' },
                      { icon: BookOpen, text: `${stats.total} questions`, col: '#34d399' },
                    ].map(({ icon: Icon, text, col }) => (
                      <span key={text} className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600"
                        style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
                        <Icon className="h-3.5 w-3.5 flex-shrink-0" style={{ color: col }} />
                        {text}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Score ring */}
              <div className="flex-shrink-0 flex flex-col items-center gap-3">
                <ScoreRing pct={data.session.percentage} color={scoreColor} size={148} />
                <p className="text-xs text-slate-500 font-medium">{data.session.score}/{data.session.total_marks} points</p>
              </div>
            </div>

            {/* ── 4 stat tiles ── */}
            <div className="mt-7 grid grid-cols-2 sm:grid-cols-4 gap-3" style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: '1.5rem' }}>
              {[
                { label: 'Total Score', display: `${data.session.score}`, sub: `out of ${data.session.total_marks}`, col: '#1e293b', icon: Trophy },
                { label: 'Percentage', display: `${data.session.percentage}%`, sub: 'of total marks', col: scoreColor, icon: TrendingUp },
                { label: 'Integrity', display: `${data.session.compliance}%`, sub: 'compliance score', col: compColor, icon: Shield },
                { label: 'Violations', display: `${data.violation_count}`, sub: 'incidents flagged', col: data.violation_count > 0 ? '#ef4444' : '#22c55e', icon: AlertCircle },
              ].map(({ label, display, sub, col, icon: Icon }) => (
                <div key={label} className="rounded-2xl p-4 sp-inset">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600">{label}</p>
                    <Icon className="h-3.5 w-3.5" style={{ color: col, opacity: 0.6 }} />
                  </div>
                  <p className="text-3xl font-black leading-none" style={{ color: col }}>{display}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{sub}</p>
                </div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Final-score decision card — admin commits raw / penalised / manual. */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="mb-5"
        >
          <ScoreDecisionCard
            session={data.session}
            onSaved={(next) =>
              setData((prev) => (prev ? { ...prev, session: next } : prev))
            }
          />
        </motion.div>

        {/* ══════════ BODY: 2-col ══════════ */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5">

          {/* ── LEFT: TABS + CONTENT ── */}
          <div className="space-y-4">
            {/* Tab bar */}
            <div className="flex items-center gap-2">
              {([
                { key: 'audit', label: 'Answer Audit', icon: FileText },
                { key: 'violations', label: `Violations (${data.violation_count})`, icon: AlertCircle },
              ] as { key: Tab; label: string; icon: any }[]).map(({ key, label, icon: Icon }) => (
                <button key={key} onClick={() => setTab(key)}
                  className={`tab-btn flex items-center gap-2 px-4 py-2.5 text-sm font-bold ${tab === key ? 'tab-active' : ''}`}>
                  <Icon className="h-4 w-4" /> {label}
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              {tab === 'audit' && (
                <motion.div key="audit" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-4">
                  {/* filter chips */}
                  <div className="flex flex-wrap gap-2">
                    {([
                      { key: 'all', label: `All (${stats.total})`, col: '#818cf8' },
                      { key: 'correct', label: `Correct (${stats.correct})`, col: '#4ade80' },
                      { key: 'wrong', label: `Wrong (${stats.wrong})`, col: '#f87171' },
                      { key: 'skipped', label: `Skipped (${stats.skipped})`, col: '#94a3b8' },
                    ] as { key: typeof filterQ; label: string; col: string }[]).map(({ key, label, col }) => (
                      <button key={key} onClick={() => setFilterQ(key)}
                        className="px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all duration-200"
                        style={{
                          background: filterQ === key ? `${col}15` : 'rgba(0,0,0,0.02)',
                          border: filterQ === key ? `1px solid ${col}40` : '1px solid rgba(0,0,0,0.06)',
                          color: filterQ === key ? col : '#64748b',
                        }}>
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Question cards */}
                  <div className="space-y-3">
                    {filteredQ.map((q, idx) => {
                      const cls = q.is_correct ? 'q-correct' : q.user_answer ? 'q-wrong' : 'q-skipped';
                      const numBg = q.is_correct ? 'rgba(34,197,94,0.12)' : q.user_answer ? 'rgba(239,68,68,0.12)' : 'rgba(0,0,0,0.04)';
                      const numColor = q.is_correct ? '#16a34a' : q.user_answer ? '#dc2626' : '#64748b';
                      return (
                        <motion.div key={q.id}
                          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: idx * 0.025 }}
                          className={`q-card ${cls} p-5`}>
                          <div className="flex items-start gap-4">
                            {/* Q number */}
                            <div className="flex-shrink-0 h-9 w-9 rounded-xl flex items-center justify-center text-sm font-black"
                              style={{ background: numBg, color: numColor }}>
                              {data.questions.indexOf(q) + 1}
                            </div>

                            <div className="flex-1 min-w-0 space-y-3">
                              {/* Question text */}
                              <p className="text-sm font-semibold text-slate-900 leading-relaxed">{q.text}</p>

                              {/* answer / key / type */}
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                                <AnswerCell
                                  label="Student Answer"
                                  value={q.user_answer || null}
                                  color={q.is_correct ? '#4ade80' : '#f87171'}
                                  bg={q.is_correct ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)'}
                                />
                                <AnswerCell label="Correct Key" value={q.correct_option} color="#a78bfa" bg="rgba(139,92,246,0.1)" />
                                <AnswerCell label="Question Type" value={q.type} color="#94a3b8" bg="rgba(255,255,255,0.04)" capitalize />
                              </div>

                              {/* Options preview (if MCQ) */}
                              {q.options && q.options.length > 0 && (
                                <div className="grid grid-cols-2 gap-1.5 mt-1">
                                  {q.options.map((opt) => {
                                    const isCorrect = opt === q.correct_option;
                                    const isChosen = opt === q.user_answer;
                                    return (
                                      <div key={opt} className="flex items-center gap-2 rounded-lg px-3 py-1.5"
                                        style={{
                                          background: isCorrect ? 'rgba(34,197,94,0.06)' : isChosen && !isCorrect ? 'rgba(239,68,68,0.06)' : 'rgba(0,0,0,0.02)',
                                          border: isCorrect ? '1px solid rgba(34,197,94,0.20)' : isChosen && !isCorrect ? '1px solid rgba(239,68,68,0.20)' : '1px solid rgba(0,0,0,0.06)',
                                        }}>
                                        <div className="h-2 w-2 rounded-full flex-shrink-0"
                                          style={{ background: isCorrect ? '#22c55e' : isChosen && !isCorrect ? '#ef4444' : 'rgba(255,255,255,0.15)' }} />
                                        <span className="text-xs font-semibold truncate"
                                          style={{ color: isCorrect ? '#16a34a' : isChosen && !isCorrect ? '#dc2626' : '#64748b' }}>
                                          {opt}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            {/* Marks badge */}
                            <div className="flex-shrink-0 rounded-2xl p-3 flex flex-col items-center min-w-[58px]"
                              style={{
                                background: q.is_correct ? 'rgba(34,197,94,0.06)' : 'rgba(0,0,0,0.02)',
                                border: q.is_correct ? '1px solid rgba(34,197,94,0.20)' : '1px solid rgba(0,0,0,0.06)',
                              }}>
                              <span className="text-2xl font-black leading-none" style={{ color: q.is_correct ? '#16a34a' : 'rgba(0,0,0,0.15)' }}>
                                {q.marks_obtained}
                              </span>
                              <Minus className="h-3 w-3 my-1 text-slate-400" />
                              <span className="text-sm font-bold text-slate-500">{q.marks}</span>
                              <span className="text-[9px] uppercase tracking-widest text-slate-400 mt-1">pts</span>
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                    {filteredQ.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-16 rounded-2xl" style={{ border: '1px dashed rgba(0,0,0,0.08)' }}>
                        <BookOpen className="h-10 w-10 text-slate-400 mb-3" />
                        <p className="text-sm text-slate-500">No questions in this category</p>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {tab === 'violations' && (
                <motion.div key="violations" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                  {data.violations.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 rounded-3xl"
                      style={{ background: 'rgba(34,197,94,0.04)', border: '1px dashed rgba(34,197,94,0.18)' }}>
                      <div className="h-16 w-16 rounded-2xl flex items-center justify-center mb-4"
                        style={{ background: 'rgba(34,197,94,0.12)', boxShadow: '0 0 30px rgba(34,197,94,0.2)' }}>
                        <CheckCircle2 className="h-8 w-8 text-emerald-400" />
                      </div>
                      <p className="text-lg font-black text-emerald-400">Zero Violations</p>
                      <p className="text-sm text-slate-500 mt-1.5 max-w-xs text-center">This student maintained perfect integrity throughout the session.</p>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {data.violations.map((v, i) => (
                        <motion.div key={i}
                          initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
                          className="flex items-center gap-4 rounded-2xl p-4 v-chip">
                          <div className="h-8 w-8 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(239,68,68,0.15)' }}>
                            <AlertCircle className="h-4 w-4 text-rose-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-slate-900 capitalize">{v.type.replace(/_/g, ' ')}</p>
                            <p className="text-xs text-slate-500 mt-0.5">Incident #{i + 1}</p>
                          </div>
                          <div className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 flex-shrink-0"
                            style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
                            <div className="h-1.5 w-1.5 rounded-full pulse2" style={{ background: '#ef4444' }} />
                            <span className="text-xs font-bold text-slate-400 font-mono">{formatServerTime(v.timestamp)}</span>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ── RIGHT SIDEBAR ── */}
          <div className="space-y-4">

            {/* Donut + breakdown */}
            <div className="sp-card rounded-3xl p-5 space-y-4">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Target className="h-4 w-4 text-violet-400" />
                Response Breakdown
              </h3>

              <div className="relative h-[180px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={stats.chartData} cx="50%" cy="50%"
                      innerRadius={58} outerRadius={82}
                      paddingAngle={5} dataKey="value" stroke="none">
                      {stats.chartData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} style={{ filter: `drop-shadow(0 0 6px ${entry.color}80)` }} />
                      ))}
                    </Pie>
                    <Tooltip content={<DarkTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Accuracy</p>
                  <p className="text-2xl font-black text-slate-900">{stats.accuracy}%</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'Correct', value: stats.correct, col: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
                  { label: 'Wrong', value: stats.wrong, col: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
                  { label: 'Skipped', value: stats.skipped, col: '#64748b', bg: 'rgba(100,116,139,0.12)' },
                ].map(s => (
                  <div key={s.label} className="rounded-xl p-3 text-center" style={{ background: s.bg, border: `1px solid ${s.col}25` }}>
                    <p className="text-[9px] font-bold uppercase tracking-wider mb-1" style={{ color: s.col }}>{s.label}</p>
                    <p className="text-2xl font-black text-slate-900">{s.value}</p>
                  </div>
                ))}
              </div>

            </div>

            {/* Exam meta */}
            <div className="sp-card rounded-3xl p-5 space-y-3">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-blue-400" />
                Exam Details
              </h3>
              {[
                { label: 'Exam Title', value: data.exam.title },
                { label: 'Session ID', value: `#${data.session.id}` },
                { label: 'Status', value: data.session.status },
                { label: 'Duration', value: `${data.exam.duration_minutes} min` },
                { label: 'Session Time', value: stats.durationText },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-start justify-between gap-2 py-2" style={{ borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
                  <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">{label}</span>
                  <span className="text-xs font-bold text-slate-900 text-right max-w-[160px] leading-snug">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── AnswerCell mini component ─── */
function AnswerCell({ label, value, color, bg, capitalize = false }: { label: string; value: string | null; color: string; bg: string; capitalize?: boolean }) {
  return (
    <div className="rounded-xl p-3" style={{ background: bg, border: `1px solid ${color}18` }}>
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-1.5">{label}</p>
      {value
        ? <p className="text-sm font-black" style={{ color, textTransform: capitalize ? 'capitalize' : 'uppercase' }}>{value}</p>
        : <p className="text-sm font-semibold text-slate-400 italic">No answer</p>
      }
    </div>
  );
}
