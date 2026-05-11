import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Clock3,
  Download,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  Users,
  Zap,
  BookOpen,
  BarChart3,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Activity,
  TrendingUp,
  Filter,
  Lock,
  Copy,
} from 'lucide-react';
import api from '../services/api';
import { formatServerDateTime, parseServerDate } from '../utils/dateTime';
import { RoomKeyModal, isRoomUnlocked } from './RoomKeyModal';

interface AdminResultsDashboardProps {
  onReviewEvidence?: (student: Record<string, unknown>) => void;
  onViewSummary?: (sessionId: number, examId?: number) => void;
  initialExamId?: number | null;
  onExamSelect?: (examId: number | null) => void;
}

type ExamStatus = 'active' | 'upcoming' | 'ended' | 'inactive' | 'invalid';
type AttemptStatus = 'active' | 'offline' | 'completed' | 'terminated';
type AttemptTier = 'Safe' | 'Watch' | 'Flagged' | 'Critical';
type ExamFilter = 'all' | ExamStatus;

interface ExamCard {
  id: number;
  title: string;
  description: string | null;
  status: ExamStatus;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number;
  question_count: number;
  attempt_count: number;
  completed_attempt_count: number;
  monitor_key?: string | null;
}

interface ExamFeed {
  generated_at: string | null;
  stats: {
    total_exams: number;
    active_exams: number;
    live_exams: number;
    upcoming_exams: number;
    ended_exams: number;
    published_last_24h: number;
  };
  exams: ExamCard[];
}

interface Attempt {
  id: number;
  session_id: number;
  exam_id: number | null;
  email: string;
  full_name: string;
  status: AttemptStatus;
  tier: AttemptTier;
  score: number;
  total_marks: number;
  score_percentage: number | null;
  compliance: number | null;
  violation_count: number;
  evidence_count: number;
  last_active: string | null;
  duration_minutes: number;
  exam_title: string | null;
  // Mark-penalty / score-decision (None = pending admin review).
  major_violation_count: number | null;
  critical_violation_count: number | null;
  proctor_penalty_pct: number | null;
  proctor_adjusted_score: number | null;
  final_score: number | null;
  score_decision: 'raw' | 'penalised' | 'manual' | null;
}

interface ExamDetail {
  generated_at: string | null;
  exam: {
    id: number;
    title: string;
    status: ExamStatus;
    question_count: number;
    duration_minutes: number;
  };
  stats: {
    attempt_count: number;
    student_count: number;
    completed_attempt_count: number;
    active_attempt_count: number;
    terminated_attempt_count: number;
    flagged_attempt_count: number;
    avg_score_percentage: number | null;
    avg_compliance: number | null;
    highest_score_percentage: number | null;
  };
  participants: Attempt[];
}

const asNumber = (value: number | null | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const formatRelative = (value: string | null | undefined): string => {
  if (!value) return 'Just updated';
  const parsed = parseServerDate(value);
  if (!parsed) return 'Just updated';
  const delta = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
  if (delta < 5) return 'Just now';
  if (delta < 60) return `${delta}s ago`;
  const minutes = Math.floor(delta / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const formatPercent = (value: number | null): string => {
  if (value === null || Number.isNaN(value)) return '—';
  return `${Math.round(value)}%`;
};

const statusConfig = (status: ExamStatus) => {
  if (status === 'active') return { bg: 'bg-emerald-500/20', text: 'text-emerald-300', border: 'border-emerald-500/30', dot: 'bg-emerald-400', label: 'LIVE', glow: 'shadow-emerald-500/20' };
  if (status === 'upcoming') return { bg: 'bg-blue-500/20', text: 'text-blue-300', border: 'border-blue-500/30', dot: 'bg-blue-400', label: 'UPCOMING', glow: 'shadow-blue-500/20' };
  if (status === 'ended') return { bg: 'bg-slate-500/20', text: 'text-slate-400', border: 'border-slate-500/30', dot: 'bg-slate-500', label: 'ENDED', glow: 'shadow-slate-500/10' };
  if (status === 'inactive') return { bg: 'bg-amber-500/20', text: 'text-amber-300', border: 'border-amber-500/30', dot: 'bg-amber-400', label: 'INACTIVE', glow: 'shadow-amber-500/20' };
  return { bg: 'bg-rose-500/20', text: 'text-rose-300', border: 'border-rose-500/30', dot: 'bg-rose-400', label: 'INVALID', glow: 'shadow-rose-500/20' };
};

const tierConfig = (tier: AttemptTier) => {
  if (tier === 'Safe') return { bg: 'bg-emerald-500/15', text: 'text-emerald-300', border: 'border-emerald-500/25', icon: '🟢' };
  if (tier === 'Watch') return { bg: 'bg-amber-500/15', text: 'text-amber-300', border: 'border-amber-500/25', icon: '🟡' };
  if (tier === 'Flagged') return { bg: 'bg-orange-500/15', text: 'text-orange-300', border: 'border-orange-500/25', icon: '🟠' };
  return { bg: 'bg-rose-500/15', text: 'text-rose-300', border: 'border-rose-500/25', icon: '🔴' };
};

const attemptStatusConfig = (status: AttemptStatus) => {
  if (status === 'active') return { bg: 'bg-emerald-500/15', text: 'text-emerald-300', border: 'border-emerald-500/25' };
  if (status === 'completed') return { bg: 'bg-blue-500/15', text: 'text-blue-300', border: 'border-blue-500/25' };
  if (status === 'terminated') return { bg: 'bg-rose-500/15', text: 'text-rose-300', border: 'border-rose-500/25' };
  return { bg: 'bg-slate-500/15', text: 'text-slate-400', border: 'border-slate-500/25' };
};

const csvCell = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

const exportCsv = (filename: string, headers: string[], rows: Array<Array<unknown>>): void => {
  const csv = [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
};

const examGradients = [
  'from-violet-600/30 to-indigo-600/30',
  'from-cyan-600/30 to-blue-600/30',
  'from-rose-600/30 to-pink-600/30',
  'from-amber-600/30 to-orange-600/30',
  'from-emerald-600/30 to-teal-600/30',
  'from-fuchsia-600/30 to-purple-600/30',
];

export function AdminResultsDashboard({
  onReviewEvidence,
  onViewSummary,
  initialExamId = null,
  onExamSelect,
}: AdminResultsDashboardProps) {
  const [selectedExamId, setSelectedExamId] = useState<number | null>(initialExamId);
  const [feed, setFeed] = useState<ExamFeed | null>(null);
  const [detail, setDetail] = useState<ExamDetail | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');
  const [searchExam, setSearchExam] = useState('');
  const [examStatusFilter, setExamStatusFilter] = useState<ExamFilter>('all');
  const [searchAttempt, setSearchAttempt] = useState('');
  const [exporting, setExporting] = useState(false);
  const [keyModalExam, setKeyModalExam] = useState<ExamCard | null>(null);
  const [, forceRerender] = useState(0); // so isRoomUnlocked re-checks after modal

  useEffect(() => {
    setSelectedExamId(initialExamId ?? null);
  }, [initialExamId]);

  const loadFeed = async () => {
    setLoadingFeed(true);
    setError('');
    try {
      const response = await api.get<ExamFeed>('exam/admin/exams/live', { params: { limit: 200 } });
      setFeed(response.data);
    } catch {
      setError('Unable to load exam library. Please refresh.');
    } finally {
      setLoadingFeed(false);
    }
  };

  const loadDetail = async (examId: number) => {
    setLoadingDetail(true);
    setError('');
    try {
      const response = await api.get<ExamDetail>(`exam/admin/results/exam/${examId}`);
      setDetail(response.data);
    } catch {
      setDetail(null);
      setError('Unable to load exam results. Please refresh.');
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    void loadFeed();
  }, []);

  useEffect(() => {
    if (selectedExamId === null) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedExamId);
  }, [selectedExamId]);

  const filteredExams = useMemo(() => {
    const exams = feed?.exams ?? [];
    const q = searchExam.trim().toLowerCase();
    return exams.filter((exam) => {
      if (examStatusFilter !== 'all' && exam.status !== examStatusFilter) return false;
      if (!q) return true;
      return exam.title.toLowerCase().includes(q) || exam.status.toLowerCase().includes(q);
    });
  }, [feed?.exams, searchExam, examStatusFilter]);

  const examStatusCounts = useMemo(() => {
    const counts: Record<ExamFilter, number> = { all: 0, active: 0, upcoming: 0, ended: 0, inactive: 0, invalid: 0 };
    const exams = feed?.exams ?? [];
    counts.all = exams.length;
    for (const exam of exams) counts[exam.status] += 1;
    return counts;
  }, [feed?.exams]);

  const filteredAttempts = useMemo(() => {
    const attempts = detail?.participants ?? [];
    const q = searchAttempt.trim().toLowerCase();
    if (!q) return attempts;
    return attempts.filter(
      (item) =>
        item.full_name.toLowerCase().includes(q) ||
        item.email.toLowerCase().includes(q) ||
        item.status.toLowerCase().includes(q) ||
        item.tier.toLowerCase().includes(q),
    );
  }, [detail?.participants, searchAttempt]);

  const refreshCurrentView = async () => {
    if (selectedExamId === null) { await loadFeed(); return; }
    await loadDetail(selectedExamId);
  };

  const handleExport = () => {
    setExporting(true);
    if (selectedExamId === null) {
      exportCsv(
        'exam-library-results.csv',
        ['Exam ID', 'Title', 'Status', 'Attempts', 'Completed', 'Questions', 'Duration(min)', 'Start', 'End'],
        filteredExams.map((exam) => [
          exam.id, exam.title, statusConfig(exam.status).label, exam.attempt_count,
          exam.completed_attempt_count, exam.question_count, exam.duration_minutes,
          formatServerDateTime(exam.start_time), formatServerDateTime(exam.end_time),
        ]),
      );
      setExporting(false);
      return;
    }
    exportCsv(
      `${(detail?.exam.title || 'exam').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}-results.csv`,
      [
        'Session ID', 'Student', 'Email', 'Status', 'Tier',
        'Score', 'Score %', 'Compliance %',
        'Final Score', 'Decision',
        'Violations', 'Evidence', 'Last Active',
      ],
      filteredAttempts.map((item) => [
        item.session_id, item.full_name, item.email, item.status, item.tier,
        `${item.score}/${item.total_marks}`, formatPercent(item.score_percentage),
        formatPercent(item.compliance),
        item.final_score !== null ? `${item.final_score}/${item.total_marks}` : 'Pending',
        item.score_decision || 'pending',
        item.violation_count, item.evidence_count,
        formatServerDateTime(item.last_active),
      ]),
    );
    setExporting(false);
  };

  const openExam = (examId: number) => { setSelectedExamId(examId); onExamSelect?.(examId); };
  const backToLobby = () => { setSelectedExamId(null); onExamSelect?.(null); };

  const handleEnterRoom = (exam: ExamCard) => {
    const roomKey = `results-room-unlocked-${exam.id}`;
    const alreadyUnlocked = !exam.monitor_key || isRoomUnlocked(exam.id) || sessionStorage.getItem(roomKey) === '1';
    if (alreadyUnlocked) {
      openExam(exam.id);
    } else {
      setKeyModalExam(exam);
    }
  };

  const handleRoomUnlocked = (examId: number) => {
    sessionStorage.setItem(`results-room-unlocked-${examId}`, '1');
    setKeyModalExam(null);
    forceRerender(n => n + 1);
    openExam(examId);
  };

  const openEvidence = (item: Attempt) => {
    onReviewEvidence?.({
      id: item.id, sessionId: item.session_id, session_id: item.session_id,
      examId: item.exam_id ?? selectedExamId, exam_id: item.exam_id ?? selectedExamId,
      name: item.full_name, full_name: item.full_name, rollNo: item.email,
      roll_number: item.email, email: item.email, department: 'University Student',
      examTitle: detail?.exam.title ?? item.exam_title ?? 'Exam',
      exam_title: detail?.exam.title ?? item.exam_title ?? 'Exam',
      violations: item.violation_count, violation_count: item.violation_count,
      compliance: item.compliance ?? 100, status: item.status,
      last_active: item.last_active, examDuration: detail?.exam.duration_minutes ?? item.duration_minutes,
    });
  };

  const openSummary = (item: Attempt) => {
    onViewSummary?.(item.session_id, item.exam_id ?? selectedExamId ?? undefined);
  };

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(135deg, #0a0f1e 0%, #0d1735 50%, #0a0f1e 100%)' }}>
      <style>{`
        .glass { background: rgba(255,255,255,0.04); backdrop-filter: blur(20px); border: 1px solid rgba(255,255,255,0.08); }
        .glass-hover:hover { background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.12); }
        .glow-blue { box-shadow: 0 0 40px rgba(59,130,246,0.15); }
        .glow-purple { box-shadow: 0 0 40px rgba(139,92,246,0.15); }
        .stat-card { background: linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%); border: 1px solid rgba(255,255,255,0.08); backdrop-filter: blur(20px); }
        .exam-card-bg { background: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); }
        .scrollbar-dark::-webkit-scrollbar { width: 6px; height: 6px; }
        .scrollbar-dark::-webkit-scrollbar-track { background: rgba(255,255,255,0.03); }
        .scrollbar-dark::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 10px; }
        .scrollbar-dark::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
        .pulse-live { animation: pulseLive 2s cubic-bezier(0.4,0,0.6,1) infinite; }
        @keyframes pulseLive { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        .progress-bar { height: 6px; border-radius: 99px; background: rgba(255,255,255,0.08); overflow: hidden; }
        .progress-fill { height: 100%; border-radius: 99px; transition: width 1s ease; }
        .row-hover:hover { background: rgba(255,255,255,0.04); }
      `}</style>

      <div className="mx-auto max-w-[1440px] px-6 py-8 space-y-6">

        {/* ── HEADER ── */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }}
          className="glass rounded-2xl p-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div className="flex items-center gap-4">
            {selectedExamId !== null && (
              <button onClick={backToLobby}
                className="flex items-center justify-center h-10 w-10 rounded-xl glass glass-hover transition-all duration-200 text-slate-300 hover:text-white flex-shrink-0">
                <ArrowLeft className="h-5 w-5" />
              </button>
            )}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="h-2 w-2 rounded-full bg-violet-400 pulse-live" />
                <span className="text-xs font-semibold uppercase tracking-widest text-violet-400">
                  {selectedExamId === null ? 'Results Command Center' : 'Exam Detail View'}
                </span>
              </div>
              <h1 className="text-2xl font-bold text-white leading-tight">
                {selectedExamId === null ? 'Exam Results Dashboard' : (detail?.exam.title || 'Loading...')}
              </h1>
              {selectedExamId !== null && detail && (
                <p className="text-sm text-slate-400 mt-0.5">
                  {detail.exam.question_count} questions · {detail.exam.duration_minutes} min · {detail.stats.student_count} students
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="glass rounded-xl px-4 py-2 text-xs text-slate-400 font-medium flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-violet-400" />
              {formatRelative(selectedExamId === null ? feed?.generated_at : detail?.generated_at)}
            </div>
            <button onClick={() => void refreshCurrentView()}
              className="flex items-center gap-2 glass glass-hover rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-300 hover:text-white transition-all duration-200">
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            <button onClick={handleExport} disabled={exporting}
              className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-all duration-200 disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)', boxShadow: '0 4px 20px rgba(99,102,241,0.4)' }}>
              <Download className="h-4 w-4" />
              {exporting ? 'Exporting...' : 'Export CSV'}
            </button>
          </div>
        </motion.div>

        {error && (
          <div className="glass rounded-xl px-5 py-3 text-sm text-rose-300 border border-rose-500/30 flex items-center gap-3">
            <AlertCircle className="h-4 w-4 text-rose-400 flex-shrink-0" />
            {error}
          </div>
        )}

        <AnimatePresence mode="wait">
          {selectedExamId === null ? (
            <motion.div key="lobby" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">

              {/* ── STATS ROW ── */}
              {loadingFeed && !feed ? (
                <div className="flex h-48 items-center justify-center glass rounded-2xl">
                  <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-10 w-10 animate-spin text-violet-400" />
                    <span className="text-sm text-slate-400">Loading exam library...</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                    {[
                      { label: 'Total Exams', value: asNumber(feed?.stats.total_exams), sub: `${asNumber(feed?.stats.published_last_24h)} new today`, icon: BookOpen, color: 'from-violet-500 to-indigo-500', glow: 'rgba(139,92,246,0.3)' },
                      { label: 'Live Now', value: asNumber(feed?.stats.live_exams), sub: `${asNumber(feed?.stats.active_exams)} active sessions`, icon: Zap, color: 'from-emerald-500 to-teal-500', glow: 'rgba(16,185,129,0.3)' },
                      { label: 'Upcoming', value: asNumber(feed?.stats.upcoming_exams), sub: 'Scheduled windows', icon: CalendarDays, color: 'from-blue-500 to-cyan-500', glow: 'rgba(59,130,246,0.3)' },
                      { label: 'Ended', value: asNumber(feed?.stats.ended_exams), sub: 'Historical archives', icon: BarChart3, color: 'from-rose-500 to-pink-500', glow: 'rgba(244,63,94,0.3)' },
                    ].map((stat, i) => (
                      <motion.div key={stat.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }}
                        className="stat-card rounded-2xl p-5 flex flex-col gap-3">
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-0.5">{stat.label}</p>
                            <p className="text-4xl font-black text-white">{stat.value}</p>
                          </div>
                          <div className="rounded-xl p-2.5" style={{ background: `linear-gradient(135deg, ${stat.glow.replace('0.3', '0.25')}, ${stat.glow.replace('0.3', '0.1')})`, boxShadow: `0 4px 20px ${stat.glow}` }}>
                            <stat.icon className="h-5 w-5 text-white" />
                          </div>
                        </div>
                        <p className="text-xs text-slate-500">{stat.sub}</p>
                        <div className="progress-bar w-full">
                          <div className="progress-fill" style={{ width: `${Math.min(100, (stat.value / (asNumber(feed?.stats.total_exams) || 1)) * 100)}%`, background: `linear-gradient(90deg, ${stat.glow.replace('0.3', '0.9')}, ${stat.glow.replace('0.3', '0.6')})` }} />
                        </div>
                      </motion.div>
                    ))}
                  </div>

                  {/* ── EXAM LIBRARY ── */}
                  <div className="glass rounded-2xl p-6 space-y-5">
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                      <div>
                        <h2 className="text-xl font-bold text-white">Exam Library</h2>
                        <p className="text-sm text-slate-500 mt-0.5">Select an exam to view detailed student results</p>
                      </div>

                      {/* Filter Chips */}
                      <div className="flex flex-wrap gap-2">
                        {([
                          { value: 'all', label: 'All' },
                          { value: 'active', label: '● Live' },
                          { value: 'upcoming', label: 'Upcoming' },
                          { value: 'ended', label: 'Ended' },
                          { value: 'inactive', label: 'Inactive' },
                        ] as Array<{ value: ExamFilter; label: string }>).map((opt) => (
                          <button key={opt.value} onClick={() => setExamStatusFilter(opt.value)}
                            className={`px-4 py-1.5 rounded-xl text-xs font-semibold uppercase tracking-wide transition-all duration-200 ${
                              examStatusFilter === opt.value
                                ? 'text-white border border-violet-500/50'
                                : 'text-slate-400 border border-transparent hover:border-slate-600 hover:text-slate-200'
                            }`}
                            style={examStatusFilter === opt.value ? { background: 'linear-gradient(135deg, rgba(99,102,241,0.3), rgba(139,92,246,0.2))' } : {}}>
                            {opt.label} ({examStatusCounts[opt.value]})
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Search */}
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                        <input value={searchExam} onChange={(e) => setSearchExam(e.target.value)}
                          placeholder="Search exams by title or status..."
                          className="w-full rounded-xl py-3 pl-11 pr-4 text-sm text-white placeholder-slate-500 outline-none transition-all duration-200 focus:ring-2 focus:ring-violet-500/40"
                          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }} />
                      </div>
                      <div className="flex items-center gap-2 rounded-xl px-4 py-3 text-xs text-slate-400 font-medium flex-shrink-0"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <Filter className="h-3.5 w-3.5" />
                        {filteredExams.length} / {examStatusCounts.all} exams
                      </div>
                    </div>

                    {/* Exam Cards Grid */}
                    {filteredExams.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-20 gap-4 text-slate-500"
                        style={{ border: '1px dashed rgba(255,255,255,0.1)', borderRadius: '16px' }}>
                        <BookOpen className="h-12 w-12 opacity-30" />
                        <p className="text-sm font-medium">No matching exams found</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {filteredExams.map((exam, i) => {
                          const sc = statusConfig(exam.status);
                          const grad = examGradients[exam.id % examGradients.length];
                          const completionPct = exam.attempt_count > 0
                            ? Math.round((exam.completed_attempt_count / exam.attempt_count) * 100)
                            : 0;
                          return (
                            <motion.article key={exam.id}
                              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
                              whileHover={{ y: -4, scale: 1.01 }}
                              className="exam-card-bg rounded-2xl p-5 space-y-4 cursor-default overflow-hidden relative group transition-all duration-300"
                              style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
                              {/* Gradient accent */}
                              <div className={`absolute inset-0 bg-gradient-to-br ${grad} opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none`} />

                              <div className="relative flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-600 mb-1">Exam #{exam.id}</p>
                                  <h3 className="text-base font-bold text-white leading-snug line-clamp-2">{exam.title}</h3>
                                </div>
                                <span className={`flex-shrink-0 flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-wider ${sc.bg} ${sc.text} ${sc.border}`}>
                                  {exam.status === 'active' && <span className={`h-1.5 w-1.5 rounded-full ${sc.dot} pulse-live`} />}
                                  {sc.label}
                                </span>
                              </div>

                              {exam.description && (
                                <p className="relative text-xs text-slate-500 line-clamp-2 leading-relaxed">{exam.description}</p>
                              )}

                              {/* Meta row */}
                              <div className="relative flex flex-wrap gap-2 text-[10px] text-slate-500 font-medium">
                                <span className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                  <CalendarDays className="h-3 w-3 text-slate-600" />
                                  {formatServerDateTime(exam.start_time)}
                                </span>
                                <span className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                  <Clock3 className="h-3 w-3 text-slate-600" />
                                  {exam.duration_minutes}m
                                </span>
                                <span className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
                                  <BookOpen className="h-3 w-3 text-slate-600" />
                                  {exam.question_count} Qs
                                </span>
                              </div>

                              {/* Stats row */}
                              <div className="relative grid grid-cols-2 gap-2">
                                <div className="rounded-xl p-3 text-center" style={{ background: 'rgba(255,255,255,0.04)' }}>
                                  <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-1">Attempts</p>
                                  <p className="text-xl font-black text-white">{exam.attempt_count}</p>
                                </div>
                                <div className="rounded-xl p-3 text-center" style={{ background: 'rgba(255,255,255,0.04)' }}>
                                  <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600 mb-1">Completed</p>
                                  <p className="text-xl font-black text-white">{exam.completed_attempt_count}</p>
                                </div>
                              </div>

                              {/* Completion bar */}
                              <div className="relative space-y-1.5">
                                <div className="flex items-center justify-between text-[10px] font-semibold text-slate-600">
                                  <span>Completion rate</span>
                                  <span className="text-slate-400">{completionPct}%</span>
                                </div>
                                <div className="progress-bar">
                                  <div className="progress-fill" style={{ width: `${completionPct}%`, background: 'linear-gradient(90deg, #6366f1, #8b5cf6)' }} />
                                </div>
                              </div>

                              {/* Monitor Key */}
                              {exam.monitor_key && (
                                <div className="relative flex items-center justify-between gap-2 py-1" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                                  <span className="text-[9px] font-bold uppercase tracking-widest text-slate-700 flex items-center gap-1">
                                    <Lock className="h-2.5 w-2.5" /> Monitor Key
                                  </span>
                                  <button
                                    onClick={async (e) => { e.stopPropagation(); await navigator.clipboard.writeText(exam.monitor_key!).catch(()=>{}); }}
                                    className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[10px] font-black tracking-widest transition-all"
                                    style={{ background: 'rgba(139,92,246,0.12)', border: '1px solid rgba(139,92,246,0.25)', color: '#c4b5fd', fontFamily: 'monospace' }}
                                  >
                                    {exam.monitor_key} <Copy className="h-2.5 w-2.5" />
                                  </button>
                                </div>
                              )}

                              {/* CTA */}
                              <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                                onClick={() => handleEnterRoom(exam)}
                                className="relative w-full flex items-center justify-center gap-2.5 rounded-xl py-3 text-sm font-bold text-white transition-all duration-200"
                                style={{ background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)', boxShadow: '0 4px 20px rgba(99,102,241,0.35)' }}>
                                {exam.monitor_key && !isRoomUnlocked(exam.id) && sessionStorage.getItem(`results-room-unlocked-${exam.id}`) !== '1'
                                  ? <><Lock className="h-4 w-4" /> Enter Room</>
                                  : <>View Results <ArrowRight className="h-4 w-4" /></>}
                              </motion.button>
                            </motion.article>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </motion.div>
          ) : (
            <motion.div key="detail" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">

              {loadingDetail && !detail ? (
                <div className="flex h-64 items-center justify-center glass rounded-2xl">
                  <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-10 w-10 animate-spin text-violet-400" />
                    <span className="text-sm text-slate-400">Loading results...</span>
                  </div>
                </div>
              ) : detail ? (
                <>
                  {/* ── EXAM DETAIL STATS ── */}
                  <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                    {[
                      { label: 'Total Attempts', value: detail.stats.attempt_count, sub: `${detail.stats.active_attempt_count} currently active`, color: '#6366f1', glow: 'rgba(99,102,241,0.35)', icon: Users },
                      { label: 'Completed', value: detail.stats.completed_attempt_count, sub: `${detail.stats.terminated_attempt_count} terminated`, color: '#22c55e', glow: 'rgba(34,197,94,0.35)', icon: CheckCircle2 },
                      { label: 'Avg Score', value: formatPercent(detail.stats.avg_score_percentage), sub: `Best: ${formatPercent(detail.stats.highest_score_percentage)}`, color: '#3b82f6', glow: 'rgba(59,130,246,0.35)', icon: TrendingUp, isStr: true },
                      { label: 'Avg Integrity', value: formatPercent(detail.stats.avg_compliance), sub: `${detail.stats.flagged_attempt_count} flagged`, color: '#f59e0b', glow: 'rgba(245,158,11,0.35)', icon: Shield, isStr: true },
                    ].map((s, i) => (
                      <motion.div key={s.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }}
                        className="stat-card rounded-2xl p-5 flex flex-col gap-3">
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-0.5">{s.label}</p>
                            <p className="text-4xl font-black text-white">{s.value}</p>
                          </div>
                          <div className="rounded-xl p-2.5" style={{ background: s.glow.replace('0.35', '0.15'), boxShadow: `0 4px 15px ${s.glow}` }}>
                            <s.icon className="h-5 w-5" style={{ color: s.color }} />
                          </div>
                        </div>
                        <p className="text-xs text-slate-500">{s.sub}</p>
                      </motion.div>
                    ))}
                  </div>

                  {/* ── STUDENT RESULTS TABLE ── */}
                  <div className="glass rounded-2xl overflow-hidden">
                    <div className="p-6 border-b flex flex-col gap-4" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <h2 className="text-xl font-bold text-white">Student Results</h2>
                          <p className="text-sm text-slate-500 mt-0.5">Showing {filteredAttempts.length} of {detail.participants.length} participants</p>
                        </div>
                      </div>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <div className="relative flex-1">
                          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                          <input value={searchAttempt} onChange={(e) => setSearchAttempt(e.target.value)}
                            placeholder="Search by student name, email, status or tier..."
                            className="w-full rounded-xl py-3 pl-11 pr-4 text-sm text-white placeholder-slate-500 outline-none transition-all duration-200 focus:ring-2 focus:ring-violet-500/40"
                            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }} />
                        </div>
                        {searchAttempt && (
                          <button onClick={() => setSearchAttempt('')}
                            className="px-4 py-3 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition-all duration-200"
                            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                            Clear
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="overflow-x-auto scrollbar-dark">
                      <table className="w-full min-w-[900px]">
                        <thead>
                          <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                            {['Student', 'Status', 'Risk Tier', 'Score', 'Final', 'Integrity', 'Violations', 'Last Active', 'Actions'].map((h) => (
                              <th key={h} className="px-5 py-4 text-left text-[10px] font-bold uppercase tracking-widest text-slate-600">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredAttempts.length === 0 ? (
                            <tr>
                              <td colSpan={9} className="px-5 py-16 text-center">
                                <div className="flex flex-col items-center gap-3 text-slate-600">
                                  <Users className="h-10 w-10 opacity-30" />
                                  <p className="text-sm">No participants match your search</p>
                                </div>
                              </td>
                            </tr>
                          ) : (
                            filteredAttempts.map((item, idx) => {
                              const sc = attemptStatusConfig(item.status);
                              const tc = tierConfig(item.tier);
                              const scorePct = asNumber(item.score_percentage);
                              return (
                                <motion.tr key={item.session_id}
                                  initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: idx * 0.02 }}
                                  className="row-hover transition-colors duration-150 align-middle"
                                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                  <td className="px-5 py-4">
                                    <div className="flex items-center gap-3">
                                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-sm font-black text-white"
                                        style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
                                        {(item.full_name || 'S').charAt(0).toUpperCase()}
                                      </div>
                                      <div>
                                        <p className="text-sm font-semibold text-white leading-tight">{item.full_name}</p>
                                        <p className="text-xs text-slate-500">{item.email}</p>
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-5 py-4">
                                    <span className={`inline-flex rounded-lg border px-3 py-1 text-[10px] font-bold uppercase tracking-wide ${sc.bg} ${sc.text} ${sc.border}`}>
                                      {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                                    </span>
                                  </td>
                                  <td className="px-5 py-4">
                                    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-[10px] font-bold uppercase tracking-wide ${tc.bg} ${tc.text} ${tc.border}`}>
                                      {tc.icon} {item.tier}
                                    </span>
                                  </td>
                                  <td className="px-5 py-4">
                                    <div>
                                      <p className="text-sm font-bold text-white">{item.score}<span className="text-slate-600">/{item.total_marks}</span></p>
                                      <div className="mt-1.5 progress-bar w-20">
                                        <div className="progress-fill" style={{ width: `${scorePct}%`, background: scorePct >= 70 ? '#22c55e' : scorePct >= 40 ? '#f59e0b' : '#ef4444' }} />
                                      </div>
                                      <p className="text-[10px] text-slate-500 mt-0.5">{formatPercent(item.score_percentage)}</p>
                                    </div>
                                  </td>
                                  {/* Final score column — admin's committed decision, or Pending. */}
                                  <td className="px-5 py-4">
                                    {item.final_score !== null && item.score_decision ? (
                                      <div>
                                        <p className="text-sm font-bold text-emerald-300">
                                          {item.final_score}
                                          <span className="text-slate-600">/{item.total_marks}</span>
                                        </p>
                                        <span
                                          className={`mt-1 inline-flex rounded-md px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                                            item.score_decision === 'raw'
                                              ? 'bg-amber-500/15 text-amber-300 border border-amber-400/30'
                                              : item.score_decision === 'penalised'
                                              ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/30'
                                              : 'bg-cyan-500/15 text-cyan-300 border border-cyan-400/30'
                                          }`}
                                        >
                                          {item.score_decision === 'raw'
                                            ? 'Original'
                                            : item.score_decision === 'penalised'
                                            ? 'AI Adjusted'
                                            : 'Manual'}
                                        </span>
                                      </div>
                                    ) : (
                                      <div>
                                        <p className="text-sm font-bold text-slate-500">—</p>
                                        <span className="mt-1 inline-flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-300">
                                          <Shield className="h-2.5 w-2.5" /> Pending
                                        </span>
                                      </div>
                                    )}
                                  </td>
                                  <td className="px-5 py-4">
                                    <p className="text-sm font-bold" style={{ color: asNumber(item.compliance) >= 80 ? '#22c55e' : asNumber(item.compliance) >= 50 ? '#f59e0b' : '#ef4444' }}>
                                      {formatPercent(item.compliance)}
                                    </p>
                                  </td>
                                  <td className="px-5 py-4">
                                    <div className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold ${
                                      item.violation_count === 0 ? 'text-emerald-400' : item.violation_count <= 2 ? 'text-amber-400' : 'text-rose-400'
                                    }`} style={{ background: item.violation_count === 0 ? 'rgba(34,197,94,0.1)' : item.violation_count <= 2 ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)' }}>
                                      <XCircle className="h-3 w-3" />
                                      {item.violation_count} violation{item.violation_count !== 1 ? 's' : ''}
                                    </div>
                                    <p className="text-[10px] text-slate-600 mt-0.5">{item.evidence_count} evidence files</p>
                                  </td>
                                  <td className="px-5 py-4 text-xs text-slate-400">{formatServerDateTime(item.last_active)}</td>
                                  <td className="px-5 py-4">
                                    <div className="flex items-center justify-end gap-2">
                                      <button onClick={() => openSummary(item)}
                                        className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-white transition-all duration-200 hover:opacity-90"
                                        style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)', boxShadow: '0 2px 12px rgba(59,130,246,0.35)' }}>
                                        <FileText className="h-3.5 w-3.5" />
                                        Summary
                                      </button>
                                      <button onClick={() => openEvidence(item)}
                                        className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-white transition-all duration-200 hover:opacity-90"
                                        style={{ background: 'linear-gradient(135deg, #8b5cf6, #6d28d9)', boxShadow: '0 2px 12px rgba(139,92,246,0.35)' }}>
                                        <Eye className="h-3.5 w-3.5" />
                                        Evidence
                                      </button>
                                    </div>
                                  </td>
                                </motion.tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Results Room Key Modal ── */}
      <AnimatePresence>
        {keyModalExam && (
          <RoomKeyModal
            examId={keyModalExam.id}
            examTitle={keyModalExam.title}
            onSuccess={() => handleRoomUnlocked(keyModalExam.id)}
            onClose={() => setKeyModalExam(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
