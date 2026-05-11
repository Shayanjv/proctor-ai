import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Check, ScaleIcon, AlertTriangle, Loader2, Trophy, Sparkles, PencilLine } from 'lucide-react';
import {
    setScoreDecision,
    type ScoreDecisionChoice,
    type SessionScoreDecision,
} from '../services/scoreDecision';
import { formatServerDateTime } from '../utils/dateTime';

interface ScoreDecisionCardProps {
    /** Session block returned by the admin summary endpoints. */
    session: SessionScoreDecision;
    /** Called with the fresh session payload after a successful save. */
    onSaved: (next: SessionScoreDecision) => void;
}

/**
 * Final-score decision card.
 *
 * Lets the admin commit ONE of three options for an exam attempt:
 *   1. Award Original     - the raw correctness score, no proctor penalty
 *   2. Apply AI Penalty   - proctor_adjusted_score (recommended)
 *   3. Set Manual         - any number in [0, total_marks]
 *
 * The component is purely presentational + a single POST. The parent owns
 * the session state and re-renders this card with the updated payload via
 * `onSaved`. There is no internal cache.
 *
 * The penalty fields are advisory: the AI never silently changes a
 * student's mark. Until an admin saves a decision here, `final_score` on
 * the backend stays NULL ("Pending admin review").
 */
export function ScoreDecisionCard({ session, onSaved }: ScoreDecisionCardProps) {
    const totalMarks = Number(session.total_marks ?? 0);
    const rawScore = Number(session.score ?? 0);
    const adjustedScore = session.proctor_adjusted_score;
    const penaltyPct = session.proctor_penalty_pct;
    const majorCount = session.major_violation_count;
    const criticalCount = session.critical_violation_count;
    const hasPenaltyData = adjustedScore !== null && penaltyPct !== null;

    // Track the currently-selected radio independently of the saved decision
    // so the admin can preview a different option before clicking Save.
    const [choice, setChoice] = useState<ScoreDecisionChoice>(
        session.score_decision || (hasPenaltyData ? 'penalised' : 'raw'),
    );
    const [manualScore, setManualScore] = useState<string>(
        session.score_decision === 'manual' && session.final_score !== null
            ? String(session.final_score)
            : String(adjustedScore ?? rawScore),
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Re-sync local UI state when the session prop changes (e.g. after a save).
    useEffect(() => {
        setChoice(session.score_decision || (hasPenaltyData ? 'penalised' : 'raw'));
        setManualScore(
            session.score_decision === 'manual' && session.final_score !== null
                ? String(session.final_score)
                : String(adjustedScore ?? rawScore),
        );
        setError(null);
    }, [session.id, session.score_decision, session.final_score, adjustedScore, rawScore]);

    const previewFinalScore = useMemo(() => {
        if (choice === 'raw') return rawScore;
        if (choice === 'penalised') return adjustedScore ?? rawScore;
        const parsed = Number.parseFloat(manualScore);
        return Number.isFinite(parsed) ? parsed : null;
    }, [choice, manualScore, rawScore, adjustedScore]);

    // Derived percentage for the live preview banner. We round to one
    // decimal so 8.5/10 reads as 85% not 85.0%. Falls back to null when
    // the manual field is empty/invalid — the UI shows an em-dash then.
    const previewPercent = useMemo(() => {
        if (previewFinalScore === null || totalMarks <= 0) return null;
        return Math.round((previewFinalScore / totalMarks) * 1000) / 10;
    }, [previewFinalScore, totalMarks]);

    // Traffic-light accent for the preview banner / save button —
    // mirrors the rest of the admin UI (green >= 80, blue >= 40, red below).
    const previewAccent = previewPercent === null
        ? '#64748b'
        : previewPercent >= 80
            ? '#16a34a'
            : previewPercent >= 40
                ? '#0ea5e9'
                : '#dc2626';

    const isManualInvalid =
        choice === 'manual' &&
        (previewFinalScore === null ||
            (previewFinalScore as number) < 0 ||
            (totalMarks > 0 && (previewFinalScore as number) > totalMarks));

    const handleSave = async () => {
        if (saving) return;
        setError(null);
        if (choice === 'manual' && isManualInvalid) {
            setError(`Manual score must be a number between 0 and ${totalMarks}.`);
            return;
        }
        setSaving(true);
        try {
            const updated = await setScoreDecision(session.id, {
                decision: choice,
                manual_score: choice === 'manual' ? Number.parseFloat(manualScore) : null,
            });
            onSaved(updated);
        } catch (err: any) {
            setError(
                err?.response?.data?.detail ||
                err?.message ||
                'Failed to save score decision.',
            );
        } finally {
            setSaving(false);
        }
    };

    const isPending = !session.score_decision || session.final_score === null;
    const config = session.penalty_config ?? {
        free_strikes: 1,
        per_major_pct: 5,
        critical_multiplier: 2,
        per_critical_pct: 10,
        cap_pct: 30,
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
        >
            {/* Header */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <ScaleIcon className="h-5 w-5 text-amber-400" />
                    <h3 className="text-base font-bold text-slate-900 tracking-tight">
                        Final Score Decision
                    </h3>
                </div>
                {/* Status pills are inline-styled — the project ships a static
                    Tailwind v4 css dump (no build step), so utility classes
                    like `bg-amber-50` /  `text-emerald-600` that aren't already
                    in that dump silently render as nothing. We use hex colours
                    directly so the colour ALWAYS applies. */}
                {isPending ? (
                    <span
                        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-widest"
                        style={{ background: '#fef3c7', color: '#b45309', border: '1px solid #fcd34d' }}
                    >
                        <AlertTriangle className="h-3 w-3" /> Pending review
                    </span>
                ) : (
                    <span
                        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-widest"
                        style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}
                    >
                        <Check className="h-3 w-3" />
                        Final: {session.final_score}/{totalMarks}
                    </span>
                )}
            </div>

            {/* Live preview banner — updates instantly as the admin clicks
                a radio or types a manual score. Shows BOTH the awarded marks
                and the resulting percentage so the admin sees the impact of
                each choice before committing it. */}
            <div
                className="mb-4 flex items-center justify-between gap-3 rounded-xl border bg-gradient-to-r from-slate-50 to-white px-4 py-3"
                style={{ borderColor: `${previewAccent}55` }}
            >
                <div className="min-w-0">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Preview — will be awarded on save
                    </p>
                    <p className="mt-0.5 text-xs font-semibold text-slate-700 truncate">
                        {choice === 'raw'
                            ? 'Original score, no proctor penalty'
                            : choice === 'penalised'
                                ? `AI penalty applied (−${penaltyPct ?? 0}%)`
                                : 'Custom manual override'}
                    </p>
                </div>
                <div className="text-right flex-shrink-0">
                    <p className="text-2xl font-black leading-none" style={{ color: previewAccent }}>
                        {previewFinalScore !== null ? previewFinalScore : '—'}
                        <span className="text-sm font-medium text-slate-500">/{totalMarks}</span>
                    </p>
                    <p className="mt-1 text-xs font-bold" style={{ color: previewAccent }}>
                        {previewPercent !== null ? `${previewPercent}%` : 'enter a value'}
                    </p>
                </div>
            </div>

            {/* Penalty rule snapshot — keeps the AI math transparent. */}
            <p className="mb-4 text-[11px] text-slate-500 leading-relaxed">
                <strong className="text-slate-700">Rule:</strong> first {config.free_strikes} major event{config.free_strikes === 1 ? '' : 's'} are warnings; each additional major deducts {config.per_major_pct}%, each critical {config.per_critical_pct}%. Capped at {config.cap_pct}%. Tab-switch and copy-paste never deduct marks.
            </p>

            {/* Three choice cards */}
            <div className="space-y-2">
                {/* Award Original */}
                <RadioRow
                    selected={choice === 'raw'}
                    onSelect={() => setChoice('raw')}
                    icon={<Trophy className="h-4 w-4" />}
                    iconColor="#b45309"
                    iconBg="#fef3c7"
                    title="Award Original"
                    subtitle="Raw correctness score, no proctor penalty applied"
                    rightValue={`${rawScore}`}
                    rightUnit={`/${totalMarks}`}
                    rightColor="#b45309"
                />

                {/* Apply AI Penalty (recommended) */}
                <RadioRow
                    selected={choice === 'penalised'}
                    onSelect={() => setChoice('penalised')}
                    disabled={!hasPenaltyData}
                    icon={<Sparkles className="h-4 w-4" />}
                    iconColor="#15803d"
                    iconBg="#dcfce7"
                    title="Apply AI Penalty"
                    badge="Recommended"
                    subtitle={
                        hasPenaltyData
                            ? `−${penaltyPct}% for ${majorCount ?? 0} major + ${criticalCount ?? 0} critical violation${(majorCount ?? 0) + (criticalCount ?? 0) === 1 ? '' : 's'}`
                            : 'Penalty data unavailable for this session'
                    }
                    rightValue={hasPenaltyData ? `${adjustedScore}` : '—'}
                    rightUnit={hasPenaltyData ? `/${totalMarks}` : ''}
                    rightColor="#15803d"
                />

                {/* Set Manual */}
                <RadioRow
                    selected={choice === 'manual'}
                    onSelect={() => setChoice('manual')}
                    icon={<PencilLine className="h-4 w-4" />}
                    iconColor="#0e7490"
                    iconBg="#cffafe"
                    title="Set Manual"
                    subtitle="Override and award a custom score"
                    rightSlot={
                        <div
                            className="flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <input
                                type="number"
                                min={0}
                                max={totalMarks || undefined}
                                step="0.25"
                                value={manualScore}
                                onChange={(e) => {
                                    setChoice('manual');
                                    setManualScore(e.target.value);
                                }}
                                onFocus={() => setChoice('manual')}
                                onClick={(e) => {
                                    // Don't bubble — the row would re-trigger
                                    // selection but we already own the choice.
                                    e.stopPropagation();
                                    setChoice('manual');
                                }}
                                className={`w-20 rounded-lg border bg-white px-2 py-1 text-right text-sm font-bold text-slate-900 outline-none transition focus:ring-2 focus:ring-cyan-500/40 ${
                                    choice === 'manual' && isManualInvalid
                                        ? 'border-red-500'
                                        : 'border-slate-300'
                                }`}
                            />
                            <span className="text-xs text-slate-500">/{totalMarks}</span>
                        </div>
                    }
                />
            </div>

            {error && (
                <p
                    className="mt-3 text-xs flex items-center gap-1.5"
                    style={{ color: '#dc2626' }}
                >
                    <AlertTriangle className="h-3.5 w-3.5" /> {error}
                </p>
            )}

            {/* Save bar — stacked: short audit line on top, ALWAYS-visible
                Save button below. We had to drop the side-by-side layout
                because the audit sentence (“Last set by admin@example.com on
                May 11, 2026, 7:33 PM…”) was wide enough to push the button
                off-screen on tighter viewports. Now the button gets its own
                100%-wide row and CANNOT be hidden. */}
            <div
                className="mt-5 pt-4"
                style={{ borderTop: '1px solid #e2e8f0' }}
            >
                <p className="text-[11px] text-slate-500 mb-3">
                    {session.score_decision_by ? (
                        <>
                            Last set by{' '}
                            <span className="text-slate-700 font-semibold">{session.score_decision_by}</span>
                            {session.score_decision_at && (
                                <>
                                    {' '}on{' '}
                                    <span className="text-slate-700 font-semibold">
                                        {formatServerDateTime(session.score_decision_at)}
                                    </span>
                                </>
                            )}
                            . Saving again overrides it — every save is audit-logged.
                        </>
                    ) : (
                        <>No decision yet. The student sees “Pending admin review” until you save.</>
                    )}
                </p>
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || (choice === 'manual' && isManualInvalid)}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold transition"
                    style={{
                        background: saving || (choice === 'manual' && isManualInvalid) ? '#94a3b8' : '#16a34a',
                        color: '#ffffff',
                        boxShadow: saving || (choice === 'manual' && isManualInvalid)
                            ? 'none'
                            : '0 4px 14px 0 rgba(22, 163, 74, 0.25)',
                        cursor: saving || (choice === 'manual' && isManualInvalid) ? 'not-allowed' : 'pointer',
                        opacity: saving || (choice === 'manual' && isManualInvalid) ? 0.7 : 1,
                    }}
                >
                    {saving ? (
                        <>
                            <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                        </>
                    ) : (
                        <>
                            <Check className="h-4 w-4" />
                            Save Decision
                            {previewFinalScore !== null && previewPercent !== null && (
                                <span style={{ opacity: 0.85, fontWeight: 600 }}>
                                    · {previewFinalScore}/{totalMarks} ({previewPercent}%)
                                </span>
                            )}
                        </>
                    )}
                </button>
            </div>
        </motion.div>
    );
}

// ───────────────────── internal radio row helper ─────────────────────

interface RadioRowProps {
    selected: boolean;
    onSelect: () => void;
    disabled?: boolean;
    icon: React.ReactNode;
    /** Hex colour for the icon's foreground. */
    iconColor: string;
    /** Hex colour for the icon tile background. */
    iconBg: string;
    title: string;
    subtitle: string;
    badge?: string;
    rightValue?: string;
    rightUnit?: string;
    /** Hex colour for the right-aligned numeric value. */
    rightColor?: string;
    rightSlot?: React.ReactNode;
}

function RadioRow({
    selected,
    onSelect,
    disabled,
    icon,
    iconColor,
    iconBg,
    title,
    subtitle,
    badge,
    rightValue,
    rightUnit,
    rightColor,
    rightSlot,
}: RadioRowProps) {
    // We render the row as a <div role="radio"> rather than a <button>.
    // The Manual row embeds an <input type="number"> and `<input>` nested
    // inside `<button>` is invalid HTML — browsers are allowed to drop
    // click/focus forwarding, which produced the original “radios don’t
    // visibly select” bug. A div with role=”radio” + keydown handler keeps
    // keyboard accessibility without the nested-interactive trap.
    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onSelect();
        }
    };
    // Inline styles for ALL colour/visual concerns. The admin app ships a
    // STATIC pre-compiled Tailwind v4 stylesheet (no build step), so any
    // `bg-emerald-*` / `border-emerald-*` / `ring-*` / arbitrary `shadow-[...]`
    // class is silently a no-op unless the exact class is already in the
    // dump. Hex codes always work.
    const rowStyle: React.CSSProperties = {
        border: selected ? '2px solid #16a34a' : '2px solid #e2e8f0',
        background: selected ? '#f0fdf4' : '#ffffff',
        boxShadow: selected ? '0 0 0 3px rgba(22, 163, 74, 0.15)' : 'none',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.15s ease',
    };
    const dotStyle: React.CSSProperties = selected
        ? {
            display: 'flex',
            width: 20,
            height: 20,
            flexShrink: 0,
            borderRadius: 9999,
            background: '#16a34a',
            border: '2px solid #16a34a',
            boxShadow: '0 0 0 3px rgba(22, 163, 74, 0.2)',
            alignItems: 'center',
            justifyContent: 'center',
        }
        : {
            display: 'flex',
            width: 20,
            height: 20,
            flexShrink: 0,
            borderRadius: 9999,
            background: '#ffffff',
            border: '2px solid #cbd5e1',
            alignItems: 'center',
            justifyContent: 'center',
        };
    return (
        <div
            role="radio"
            aria-checked={selected}
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : 0}
            onClick={() => { if (!disabled) onSelect(); }}
            onKeyDown={handleKeyDown}
            className="group flex w-full items-center justify-between gap-4 rounded-xl px-4 py-3 text-left outline-none"
            style={rowStyle}
        >
            <div className="flex items-center gap-3 min-w-0">
                <span style={dotStyle}>
                    {selected && (
                        <Check style={{ width: 12, height: 12, color: '#ffffff' }} strokeWidth={4} />
                    )}
                </span>
                <span
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
                    style={{ background: iconBg, color: iconColor }}
                >
                    {icon}
                </span>
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-bold text-slate-900">{title}</p>
                        {badge && (
                            <span
                                className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                                style={{ background: '#dcfce7', color: '#15803d' }}
                            >
                                {badge}
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</p>
                </div>
            </div>
            <div className="flex-shrink-0">
                {rightSlot ? (
                    rightSlot
                ) : (
                    <p
                        className="text-lg font-black"
                        style={{ color: rightColor || '#0f172a' }}
                    >
                        {rightValue}
                        <span className="text-xs font-normal text-slate-500">{rightUnit}</span>
                    </p>
                )}
            </div>
        </div>
    );
}
