import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
    X,
    Trophy,
    AlertTriangle,
    CheckCircle,
    XCircle,
    FileText,
    Loader2
} from 'lucide-react';
import api from '../services/api';
import { formatServerTime } from '../utils/dateTime';
import { ScoreDecisionCard } from './ScoreDecisionCard';
import type { SessionScoreDecision } from '../services/scoreDecision';

interface StudentSummaryModalProps {
    studentId: number | null;
    isOpen: boolean;
    onClose: () => void;
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
    student: {
        id: number;
        email: string;
        full_name: string;
        image: string | null;
    };
    exam: {
        id: number;
        title: string;
        duration_minutes: number;
    };
    session: SessionScoreDecision;
    questions: QuestionDetail[];
    violations: Array<{
        type: string;
        timestamp: string;
        data: any;
    }>;
    violation_count: number;
}

export function StudentSummaryModal({ studentId, isOpen, onClose }: StudentSummaryModalProps) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<SummaryData | null>(null);

    useEffect(() => {
        if (isOpen && studentId) {
            fetchSummary();
        }
    }, [isOpen, studentId]);

    const fetchSummary = async () => {
        if (!studentId) return;
        setLoading(true);
        setError(null);

        try {
            const response = await api.get(`exam/admin/summary/student/${studentId}`);
            setData(response.data);
        } catch (err: any) {
            console.error('StudentSummaryModal: Fetch error:', err);
            setError(err.response?.data?.detail || 'Failed to load student summary');
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return createPortal(
        <AnimatePresence>
            <motion.div
                key="summary-modal-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-md"
                style={{ zIndex: 99999 }}
                onClick={onClose}
            >
                <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 20 }}
                    transition={{ type: "spring", duration: 0.5, bounce: 0.3 }}
                    className="relative max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-3xl border border-white/10 bg-slate-900 shadow-[0_0_50px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Background Decorative Glow */}
                    <div className="pointer-events-none absolute -left-20 -top-20 h-64 w-64 rounded-full bg-cyan-500/10 blur-[100px]" />
                    <div className="pointer-events-none absolute -right-20 -bottom-20 h-64 w-64 rounded-full bg-blue-500/10 blur-[100px]" />

                    <div className="relative p-6 md:p-8">
                        {/* Close Button */}
                        <button
                            onClick={onClose}
                            className="absolute right-4 top-4 rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-700 hover:text-white"
                        >
                            <X className="h-5 w-5" />
                        </button>

                        {loading ? (
                            <div className="flex h-64 items-center justify-center">
                                <Loader2 className="h-12 w-12 animate-spin text-cyan-400" />
                            </div>
                        ) : error ? (
                            <div className="flex h-64 flex-col items-center justify-center gap-4 text-center">
                                <AlertTriangle className="h-16 w-16 text-amber-500/50" />
                                <div>
                                    <h3 className="text-xl font-bold text-white mb-2">Request Unavailable</h3>
                                    <p className="text-slate-400 max-w-sm mx-auto">{error}</p>
                                </div>
                                <button
                                    onClick={onClose}
                                    className="mt-4 px-6 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl transition-colors"
                                >
                                    Close Modal
                                </button>
                            </div>
                        ) : data ? (
                            <>
                                {/* Header */}
                                <div className="mb-6 flex items-center gap-4">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 text-2xl font-bold text-white shadow-lg overflow-hidden">
                                        {data.student.image ? (
                                            <img
                                                src={`data:image/jpeg;base64,${data.student.image}`}
                                                alt={data.student.full_name}
                                                className="h-full w-full object-cover"
                                            />
                                        ) : (
                                            data.student.full_name?.[0] || 'S'
                                        )}
                                    </div>
                                    <div>
                                        <h2 className="text-2xl font-bold text-white tracking-tight">{data.student.full_name}</h2>
                                        <p className="text-slate-400">{data.student.email}</p>
                                        <p className="text-sm font-semibold text-cyan-400 uppercase tracking-wider mt-1">{data.exam.title}</p>
                                    </div>
                                </div>

                                {/* Stats Grid */}
                                <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
                                    <div className="rounded-2xl border border-white/5 bg-slate-800/40 p-4 transition-all hover:bg-slate-800/60">
                                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                                            <Trophy className="h-4 w-4 text-amber-400" />
                                            <span className="text-[10px] font-bold uppercase tracking-widest">Score</span>
                                        </div>
                                        <p className="text-2xl font-bold text-white">
                                            {data.session.score}<span className="text-slate-500 text-lg font-normal">/{data.session.total_marks}</span>
                                        </p>
                                    </div>
                                    <div className="rounded-2xl border border-white/5 bg-slate-800/40 p-4 transition-all hover:bg-slate-800/60">
                                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                                            <FileText className="h-4 w-4 text-blue-400" />
                                            <span className="text-[10px] font-bold uppercase tracking-widest">Percentage</span>
                                        </div>
                                        <p className={`text-2xl font-bold ${data.session.percentage >= 40 ? 'text-green-400' : 'text-red-400'}`}>
                                            {data.session.percentage}%
                                        </p>
                                    </div>
                                    <div className="rounded-2xl border border-white/5 bg-slate-800/40 p-4 transition-all hover:bg-slate-800/60">
                                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                                            <AlertTriangle className="h-4 w-4 text-red-500" />
                                            <span className="text-[10px] font-bold uppercase tracking-widest">Violations</span>
                                        </div>
                                        <p className={`text-2xl font-bold ${data.violation_count > 5 ? 'text-red-400' : 'text-green-400'}`}>
                                            {data.violation_count}
                                        </p>
                                    </div>
                                    <div className="rounded-2xl border border-white/5 bg-slate-800/40 p-4 transition-all hover:bg-slate-800/60">
                                        <div className="flex items-center gap-2 text-slate-400 mb-2">
                                            <CheckCircle className="h-4 w-4 text-cyan-400" />
                                            <span className="text-[10px] font-bold uppercase tracking-widest">Compliance</span>
                                        </div>
                                        <p className="text-2xl font-bold text-cyan-400">{data.session.compliance}%</p>
                                    </div>
                                </div>

                                {/* Final Score Decision card — admin picks Original / AI Penalty / Manual. */}
                                <div className="mb-6">
                                    <ScoreDecisionCard
                                        session={data.session}
                                        onSaved={(next) => {
                                            setData((prev) => (prev ? { ...prev, session: next } : prev));
                                        }}
                                    />
                                </div>

                                {/* Questions Section */}
                                <div className="mb-6">
                                    <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-white">
                                        <div className="h-6 w-1 bg-cyan-500 rounded-full" />
                                        Performance Audit
                                    </h3>
                                    <div className="space-y-3">
                                        {data.questions.map((q, index) => (
                                            <div
                                                key={q.id}
                                                className={`rounded-2xl border p-5 transition-all group ${q.is_correct
                                                    ? 'border-green-500/10 bg-green-500/5'
                                                    : q.user_answer
                                                        ? 'border-red-500/10 bg-red-500/5'
                                                        : 'border-white/5 bg-slate-800/30'
                                                    }`}
                                            >
                                                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                                                    <div className="flex-1">
                                                        <div className="flex items-start gap-4 mb-3">
                                                            <span className="flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-lg bg-slate-700/50 text-[10px] font-bold text-slate-300">
                                                                {index + 1}
                                                            </span>
                                                            <p className="font-medium text-white leading-relaxed">
                                                                {q.text}
                                                            </p>
                                                        </div>
                                                        <div className="flex flex-wrap gap-y-2 gap-x-8 pl-10 text-sm">
                                                            <div className="flex flex-col">
                                                                <span className="text-[9px] uppercase tracking-wider text-slate-500 mb-0.5 font-bold">Category</span>
                                                                <span className="text-slate-400 text-xs">{q.type}</span>
                                                            </div>
                                                            <div className="flex flex-col">
                                                                <span className="text-[9px] uppercase tracking-wider text-slate-500 mb-0.5 font-bold">Student Response</span>
                                                                <span className={q.is_correct ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
                                                                    {q.user_answer || 'Skipped'}
                                                                </span>
                                                            </div>
                                                            <div className="flex flex-col">
                                                                <span className="text-[9px] uppercase tracking-wider text-slate-500 mb-0.5 font-bold">Valid Key</span>
                                                                <span className="text-cyan-400 font-bold">{q.correct_option}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center justify-end gap-4 pl-10 md:pl-0">
                                                        <div className="text-right">
                                                            <p className={`text-xl font-black ${q.is_correct ? 'text-green-400' : 'text-slate-600'}`}>
                                                                {q.marks_obtained}<span className="text-xs font-normal">/{q.marks}</span>
                                                            </p>
                                                            <p className="text-[9px] uppercase tracking-widest text-slate-600 font-black">Points</p>
                                                        </div>
                                                        {q.is_correct ? (
                                                            <div className="h-12 w-12 flex items-center justify-center rounded-2xl bg-green-500/10 shadow-inner">
                                                                <CheckCircle className="h-6 w-6 text-green-500" />
                                                            </div>
                                                        ) : q.user_answer ? (
                                                            <div className="h-12 w-12 flex items-center justify-center rounded-2xl bg-red-500/10 shadow-inner">
                                                                <XCircle className="h-6 w-6 text-red-500" />
                                                            </div>
                                                        ) : (
                                                            <div className="h-12 w-12 flex items-center justify-center rounded-2xl bg-slate-700/10 shadow-inner">
                                                                <X className="h-6 w-6 text-slate-600" />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Violations Section */}
                                {data.violations.length > 0 && (
                                    <div>
                                        <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-white">
                                            <div className="h-6 w-1 bg-red-500 rounded-full" />
                                            Security Incidents ({data.violation_count})
                                        </h3>
                                        <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                                            {data.violations.slice(0, 15).map((v, index) => (
                                                <div
                                                    key={index}
                                                    className="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-4 py-3 hover:bg-white/10 transition-colors"
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <div className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
                                                        <span className="text-slate-200 font-semibold text-sm">{v.type.replace(/_/g, ' ')}</span>
                                                    </div>
                                                    <span className="text-[10px] font-bold text-slate-500 font-mono bg-slate-800 px-2 py-1 rounded">
                                                        {formatServerTime(v.timestamp)}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : null}
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body
    );
}
