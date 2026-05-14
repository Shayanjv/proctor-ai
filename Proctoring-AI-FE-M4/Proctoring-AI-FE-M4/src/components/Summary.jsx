import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Doughnut } from 'react-chartjs-2';
import Swal from 'sweetalert2';
import jsPDF from 'jspdf';
import { authService } from '../services/authService';
import { examService } from '../services/examService';
import { formatServerDateTime } from '../utils/timeUtils';
import { quitSEB } from '../app/utils/seb';
import NetworkSlowBanner from './NetworkSlowBanner';
import '../styles/summary.css';

const Summary = () => {
    const summaryRef = useRef(null);
    const [summary, setSummary] = useState(null);
    const [, setUserImage] = useState(null);
    const [score, setScore] = useState(0);
    const [examResult, setExamResult] = useState(null);
    const [loading, setLoading] = useState(true);
    const [examViolation, setExamViolation] = useState(null);
    const [appealSubmitting, setAppealSubmitting] = useState(false);
    // Auto-logout countdown after results render. Long enough that the
    // student can read their score and download a PDF, short enough that
    // an unattended exam machine doesn't keep an authenticated session
    // alive. The user can also click "Logout now" any time.
    const AUTO_LOGOUT_SECONDS = 90;
    const [logoutCountdown, setLogoutCountdown] = useState(AUTO_LOGOUT_SECONDS);
    const autoLogoutTriggeredRef = useRef(false);
    const navigate = useNavigate();
    const examId = localStorage.getItem('examId');
    const examRoute = examId ? `/exam/${examId}` : '/exam';
    // Sum ACTUAL occurrence counts across event types, NOT the number
    // of distinct types. The BE shape is
    //     suspicious_activities: { [event_type]: { count, first_occurrence } }
    // so 5 phone_detected + 3 multiple_people events = 8 violations
    // (NOT "2 violations"). This drives the "Violations" metric tile,
    // the Compliance Score subtitle, and the PDF report — they all need
    // the real count to be meaningful to students and admins.
    const majorViolationCount = Object.values(summary?.suspicious_activities || {})
        .reduce((acc, entry) => acc + (Number(entry?.count) || 0), 0);




    const formatTerminationReason = (type) => {
        const normalized = String(type || '').trim().toLowerCase();
        const labels = {
            'tab-switch': 'Excessive Tab Switching',
            'copy-paste': 'Excessive Copy-Paste Attempts',
            'identity-mismatch': 'Identity Mismatch',
            'multiple-people': 'Multiple People Detected',
            'face-not-visible': 'Face Not Visible (Grace Exceeded)',
            'face-outside-box': 'Continuous Face Outside Guide Box',
            'repeated-face-outside-box': 'Repeated Face Outside Guide Box Breaches',
            'phone-detected': 'Prohibited Device Detected',
            'prohibited-object': 'Prohibited Material Detected',
            'screen-share-stopped': 'Screen Sharing Stopped',
            'audio-anomaly': 'Third-Party Communication / Audio Anomaly',
            'tampering-detected': 'System Tampering Detected',
        };

        return labels[normalized] || type || 'Policy violation';
    };

    useEffect(() => {
        const fetchSummary = async () => {
            try {
                const examScore = localStorage.getItem('examScore');
                const examResultData = localStorage.getItem('examResult');
                const userId = localStorage.getItem('userId');

                if (!userId) {
                    throw new Error('Missing exam data');
                }

                setScore(parseFloat(examScore) || 0);

                // Parse exam result if available
                if (examResultData) {
                    setExamResult(JSON.parse(examResultData));
                }

                // Fetch the textual summary WITHOUT the embedded user photo so
                // the results render quickly on slow networks. The photo is
                // streamed lazily after the summary is shown.
                const summaryData = await examService.getExamSummary(userId, { includeImage: false });

                const violationData = localStorage.getItem('examViolation');
                if (violationData) {
                    setExamViolation(JSON.parse(violationData));
                }

                setSummary({
                    overall_compliance: summaryData.overall_compliance || 0,
                    total_duration: summaryData.total_duration || 0,
                    face_detection_rate: summaryData.face_detection_rate || 0,
                    suspicious_activities: summaryData.suspicious_activities || {},
                    user: summaryData.user || {}
                });

                // Photo arrives separately so a slow image transfer never
                // blocks the score / metrics from being visible.
                examService.getMyImageDataUrl().then((dataUrl) => {
                    if (!dataUrl) return;
                    const base64 = typeof dataUrl === 'string' && dataUrl.includes(',')
                        ? dataUrl.split(',', 2)[1]
                        : null;
                    setSummary((prev) => (
                        prev
                            ? { ...prev, user: { ...(prev.user || {}), image: base64 } }
                            : prev
                    ));
                    const img = new Image();
                    img.src = dataUrl;
                    img.onload = () => setUserImage(img);
                });

            } catch (error) {
                console.error('Error loading summary:', error);
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: 'Failed to load exam summary',
                    background: '#2a2a2a',
                    color: '#fff'
                });
                navigate(examRoute);
            } finally {
                setLoading(false);
            }
        };

        fetchSummary();
    }, [examRoute, navigate]);

const renderSummaryChart = () => {
    if (!summary) return null;

    const data = {
        labels: ['Compliant', 'Non-Compliant'],
        datasets: [{
            data: [
                summary.overall_compliance || 0,
                100 - (summary.overall_compliance || 0)
            ],
            backgroundColor: ['#10b981', '#ef4444'],
            borderColor: ['#059669', '#dc2626'],
            borderWidth: 2,
            hoverBorderWidth: 3,
        }]
    };

    const options = {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
            legend: {
                position: 'bottom',
                labels: {
                    color: '#fff',
                    padding: 24,
                    font: { size: 15, weight: '500' }
                }
            },
            tooltip: {
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                titleColor: '#fff',
                bodyColor: '#fff',
                borderColor: 'rgba(255, 255, 255, 0.2)',
                borderWidth: 1,
                padding: 12,
                displayColors: false,
                boxWidth: 12,
                boxHeight: 12,
                cornerRadius: 4,
                callbacks: {
                    label: function(context) {
                        let label = context.dataset.label || '';
                        if (label) {
                            label += ': ';
                        }
                        if (context.parsed !== null) {
                            label += new Intl.NumberFormat('en-US', { 
                                style: 'percent',
                                minimumFractionDigits: 1,
                                maximumFractionDigits: 1
                            }).format(context.parsed / 100);
                        }
                        return label;
                    }
                }
            }
        },
        cutout: '65%',
        radius: '70%',
        animation: {
            animateScale: true,
            animateRotate: true
        }
    };

    return (
        <div style={{ width: '100%', height: '100%', maxWidth: '320px', maxHeight: '320px', margin: '0 auto' }}>
            <Doughnut data={data} options={options} />
        </div>
    );
};



    const handleLogout = async () => {
        // Guard against the auto-logout effect and a manual click both firing
        // logout in the same tick.
        if (autoLogoutTriggeredRef.current) return;
        autoLogoutTriggeredRef.current = true;
        try {
            const userId = localStorage.getItem('userId');
            if (userId) {
                await examService.clearLogs(userId);
            }

            // Inside SEB → auto-quit the locked-down browser. Outside SEB →
            // fall back to the normal navigate-to-login redirect.
            authService.logout();
            quitSEB(() => navigate('/login', { replace: true }));
        } catch (error) {
            console.warn('Logout error:', error);
            authService.logout();
            quitSEB(() => navigate('/login', { replace: true }));
        }
    };

    // Once the summary is rendered, count down to an automatic logout. The
    // student is intentionally NOT allowed to navigate back to the exam —
    // a completed session cannot be retaken (backend enforces this on
    // /exam/available too) and lingering on the results page indefinitely
    // creates an idle authenticated session on a likely-shared machine.
    useEffect(() => {
        if (loading) return;
        if (autoLogoutTriggeredRef.current) return;
        if (logoutCountdown <= 0) {
            handleLogout();
            return undefined;
        }
        const timer = setTimeout(() => {
            setLogoutCountdown((seconds) => seconds - 1);
        }, 1000);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, logoutCountdown]);

    const handleDownloadPDF = async () => {
        try {
            Swal.fire({
                title: 'Generating PDF',
                html: 'Please wait...',
                allowOutsideClick: false,
                didOpen: () => {
                    Swal.showLoading();
                }
            });

            const pdf = new jsPDF('p', 'mm', 'a4');
            const pageWidth = pdf.internal.pageSize.width;
            let yPosition = 15;
            const lineHeight = 7;

            // Title and header info
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(20);
            pdf.setTextColor(0, 0, 0);
            pdf.text('Exam Report', pageWidth / 2, yPosition, { align: 'center' });

            yPosition += lineHeight * 2;
            pdf.setFontSize(12);
            pdf.text(`Generated on: ${new Date().toLocaleString()}`, pageWidth / 2, yPosition, { align: 'center' });

            // User Info
            yPosition += lineHeight * 2;
            if (summary.user?.email) {
                pdf.text(`Candidate: ${summary.user.email}`, pageWidth / 2, yPosition, { align: 'center' });
            }

            // Add user image if available
            if (summary.user?.image) {
                yPosition += lineHeight * 2;
                const imgData = `data:image/jpeg;base64,${summary.user.image}`;
                const imgProps = pdf.getImageProperties(imgData);
                const imgWidth = 50;
                const imgHeight = (imgProps.height * imgWidth) / imgProps.width;
                pdf.addImage(imgData, 'JPEG', (pageWidth - imgWidth) / 2, yPosition, imgWidth, imgHeight);
                yPosition += imgHeight + lineHeight;
            }

            // Score and Compliance
            yPosition += lineHeight * 2;
            pdf.setFontSize(14);
            pdf.text('Exam Performance', pageWidth / 2, yPosition, { align: 'center' });

            yPosition += lineHeight;
            pdf.setFontSize(12);
            pdf.setFont('helvetica', 'normal');
            pdf.text(
                `Original Score: ${examResult ? examResult.score : score}/${examResult ? examResult.total_marks : '?'}`,
                20,
                yPosition
            );
            pdf.text(`Duration: ${summary.total_duration.toFixed(1)} minutes`, 20, yPosition + lineHeight);

            // Pending-admin-review notice (replaces the old "Final Score" line).
            yPosition += lineHeight * 5;
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(202, 138, 4);
            pdf.text('Final Score: Pending Admin Review', 20, yPosition);
            yPosition += lineHeight - 1;
            pdf.setFont('helvetica', 'normal');
            pdf.setFontSize(10);
            pdf.setTextColor(0, 0, 0);
            const noticeLines = pdf.splitTextToSize(
                'Your final score will be calculated based on your compliance and violations. Please wait for the admin to review your submission.',
                pageWidth - 40
            );
            pdf.text(noticeLines, 20, yPosition);
            yPosition += lineHeight * noticeLines.length;
            pdf.setFontSize(12);

            // Violations Section
            yPosition += lineHeight * 5;
            pdf.setFont('helvetica', 'bold');
            pdf.text('Major Violations', 20, yPosition);

            yPosition += lineHeight;
            pdf.setFont('helvetica', 'normal');
            if (Object.keys(summary.suspicious_activities).length > 0) {
                Object.entries(summary.suspicious_activities).forEach(([key, value]) => {
                    const violation = formatViolationDisplay(key, value);
                    yPosition += lineHeight;
                    const violationText = `${key.replace(/_/g, ' ')} - Count: ${violation.count}`;
                    pdf.text(violationText, 25, yPosition);
                    yPosition += lineHeight - 2;
                    pdf.setFontSize(10);
                    pdf.text(`First occurred at: ${violation.timestamp}`, 30, yPosition);
                    pdf.setFontSize(12);
                });
            } else {
                yPosition += lineHeight;
                pdf.text('No major violations detected', 25, yPosition);
            }

            // Add termination reason if present
            if (examViolation && examViolation.type) {
                yPosition += lineHeight * 2;
                pdf.setFont('helvetica', 'bold');
                pdf.setTextColor(239, 68, 68);
                pdf.text('Exam Terminated Due To:', 20, yPosition);
                yPosition += lineHeight;
                pdf.setFont('helvetica', 'normal');
                pdf.text(formatTerminationReason(examViolation.type), 25, yPosition);
                pdf.setTextColor(0, 0, 0);
            }

            // Footer
            pdf.setFontSize(10);
            pdf.setTextColor(128, 128, 128);
            const footer = 'AI Proctoring System - Exam Report';
            pdf.text(footer, pageWidth / 2, pdf.internal.pageSize.height - 10, { align: 'center' });

            // Save the PDF
            pdf.save(`exam_summary_${localStorage.getItem('userId')}.pdf`);

            // After the PDF lands in the student's Downloads folder, walk
            // them straight out of the session: a 5-second countdown Swal
            // followed by `handleLogout()` which (a) clears local auth and
            // (b) auto-quits Safe Exam Browser via quitSEB(). They can
            // cancel ("Stay on this page") if they need a minute, but the
            // default path is: download → logout. Matches the product
            // intent that a completed/downloaded exam is *done*.
            const AUTO_LOGOUT_AFTER_DOWNLOAD_MS = 5000;
            const result = await Swal.fire({
                icon: 'success',
                title: 'Download Complete',
                html:
                    'Your exam summary has been downloaded.<br/>' +
                    'Logging you out and closing Safe Exam Browser in ' +
                    `<b>${AUTO_LOGOUT_AFTER_DOWNLOAD_MS / 1000}</b> seconds…`,
                background: '#2a2a2a',
                color: '#fff',
                timer: AUTO_LOGOUT_AFTER_DOWNLOAD_MS,
                timerProgressBar: true,
                showCancelButton: true,
                showConfirmButton: true,
                confirmButtonText: 'Logout now',
                cancelButtonText: 'Stay on this page',
                allowOutsideClick: false,
                allowEscapeKey: false,
            });

            // Logout on confirm OR on timer expiry. Cancel keeps the page
            // open (the existing AUTO_LOGOUT_SECONDS countdown still runs
            // in the background, so the student is never stuck).
            if (
                result.isConfirmed ||
                result.dismiss === Swal.DismissReason.timer
            ) {
                await handleLogout();
            }
        } catch (error) {
            console.error('PDF generation error:', error);
            Swal.fire({
                icon: 'error',
                title: 'Download Failed',
                text: 'Failed to generate PDF. Please try again.',
                background: '#2a2a2a',
                color: '#fff'
            });
        }
    };

    const handleRequestManualReview = async () => {
        const userId = localStorage.getItem('userId');
        if (!userId || appealSubmitting) return;

        setAppealSubmitting(true);
        try {
            await examService.logViolation(
                'appeal_request',
                'Student requested post-exam manual review',
                {
                    requested_at: new Date().toISOString(),
                    exam_id: examId || null,
                    termination_type: examViolation?.type || null,
                    warning_count: warningItems.length,
                }
            );

            await Swal.fire({
                icon: 'success',
                title: 'Review Request Submitted',
                text: 'Your appeal has been logged for admin review.',
                background: '#2a2a2a',
                color: '#fff'
            });
        } catch (error) {
            console.error('Failed to submit appeal request:', error);
            await Swal.fire({
                icon: 'error',
                title: 'Request Failed',
                text: 'Unable to submit appeal right now. Please try again later.',
                background: '#2a2a2a',
                color: '#fff'
            });
        } finally {
            setAppealSubmitting(false);
        }
    };

    const formatViolationDisplay = (key, value) => {
        return {
            count: value.count,
            timestamp: formatServerDateTime(
                value.first_occurrence,
                undefined,
                { dateStyle: 'medium', timeStyle: 'medium' }
            )
        };
    };

const renderUserInfo = () => {
    if (!summary?.user) return null;
    return (
        <div className="user-info-section">
            <div className="user-image">
                {summary.user.image ? (
                    <img 
                        src={`data:image/jpeg;base64,${summary.user.image}`}
                        alt="User"
                    />
                ) : (
                    <div className="user-placeholder">
                        {summary.user.name ? summary.user.name.charAt(0).toUpperCase() : 'U'}
                    </div>
                )}
            </div>
            <div className="user-details">
                <span className="user-email">{summary.user.email}</span>
                {summary.user.name && (
                    <span className="user-name">{summary.user.name}</span>
                )}
            </div>
        </div>
    );
};

    if (loading) {
        return (
            <>
                <NetworkSlowBanner />
                <div className="summary-loading">
                    <div className="loading-spinner"></div>
                    <h3>Loading Exam Results...</h3>
                </div>
            </>
        );
    }

    if (!summary) return null;

    return (
        <div className="summary-container">
            <NetworkSlowBanner />
            <div ref={summaryRef} className="summary-shell">
                {renderUserInfo()}
                <div className="summary-header">
                    <h1>Exam Results</h1>
                    {examResult && (
                        <div className={`status-badge ${examResult.status === 'passed' ? 'passed' : 'failed'}`}>
                            {examResult.status === 'passed' ? 'Passed' : 'Failed'}
                        </div>
                    )}
                    {/*
                      * Two-column hero panel (mark-penalty workflow):
                      *   LEFT  → Original Marks (raw correctness, what the student earned)
                      *   RIGHT → Compliance Score (proctor compliance %, with major-violation count)
                      *
                      * The student deliberately does NOT see a final score here.
                      * The pending-review notice below makes that explicit — the
                      * admin will commit the final mark via the score-decision
                      * endpoint, after which the student's transcript reflects it.
                      */}
                    <div
                        className="header-stats"
                        style={{ gridTemplateColumns: '1fr' }}
                    >
                        <div className="stat-card primary">
                            <h3>Original Marks</h3>
                            <div className="score-display">
                                <strong>{examResult ? examResult.score : score}</strong>
                                <span>/{examResult && examResult.total_marks != null ? examResult.total_marks : '—'}</span>
                            </div>
                            <p>{examResult
                                ? `${examResult.percentage}% • ${examResult.correct}/${examResult.total_questions} correct`
                                : 'Marks earned by correctness'}</p>
                        </div>
                    </div>

                    {/* Pending-admin-review notice. Replaces what used to be a
                        "Final Score" card. Per product decision: the student
                        is logged out shortly after this page renders and the
                        admin commits the final mark separately. */}
                    <div
                        className="pending-review-notice"
                        style={{
                            marginTop: '1rem',
                            padding: '1rem 1.1rem',
                            borderRadius: '14px',
                            background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(217, 119, 6, 0.12))',
                            border: '1px solid rgba(245, 158, 11, 0.35)',
                            color: '#fde68a',
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.75rem',
                            lineHeight: 1.45,
                        }}
                    >
                        <span style={{ fontSize: '1.1rem', lineHeight: 1 }}>⏳</span>
                        <div>
                            <strong style={{ display: 'block', marginBottom: 2, color: '#fbbf24' }}>
                                Final score pending admin review
                            </strong>
                            <span style={{ fontSize: '0.92rem', color: '#fde68a', opacity: 0.95 }}>
                                Your final score will be calculated based on your compliance and violations. Please wait for the admin to review your submission.
                            </span>
                        </div>
                    </div>
                    {examResult && (
                        <div className="question-breakdown">
                            <div className="breakdown-item">
                                <span>Total Questions:</span>
                                <strong>{examResult.total_questions}</strong>
                            </div>
                            <div className="breakdown-item">
                                <span>Attempted:</span>
                                <strong>{examResult.attempted}</strong>
                            </div>
                            <div className="breakdown-item correct">
                                <span>Correct:</span>
                                <strong>{examResult.correct}</strong>
                            </div>
                            <div className="breakdown-item wrong">
                                <span>Wrong:</span>
                                <strong>{examResult.wrong}</strong>
                            </div>
                        </div>
                    )}
                </div>

                <div className="summary-grid">


                    <div className="metrics-section">
                        <div className="section-card">
                            <h3>Exam Metrics</h3>
                            <div className="metrics-grid">
                                <div className="metric-item">
                                    <span>Duration</span>
                                    <strong>{(summary.total_duration || 0).toFixed(1)} min</strong>
                                </div>

                                <div className="metric-item">
                                    <span>Violations</span>
                                    <strong>{majorViolationCount}</strong>
                                </div>
                                {examViolation && examViolation.type === 'copy-paste' && (
                                    <div className="metric-item violation">
                                        <span>Violation</span>
                                        <strong>Copy-Paste Detected</strong>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="activity-section">
                        <div className="section-card">
                            <h3>Major Violations</h3>
                            {summary.suspicious_activities && Object.keys(summary.suspicious_activities).length > 0 ? (
                                <div className="activity-list">
                                    {Object.entries(summary.suspicious_activities).map(([key, value]) => {
                                        const violation = formatViolationDisplay(key, value);
                                        return (
                                            <div key={key} className="activity-item high-severity">
                                                <div className="activity-details">
                                                    <span className="activity-name">
                                                        {key.replace(/_/g, ' ')}
                                                    </span>
                                                    <div className="activity-info">
                                                        <strong className="activity-count">
                                                            count: {violation.count}
                                                        </strong>
                                                        <span className="violation-timestamp">
                                                            at {violation.timestamp}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p style={{ color: '#10b981', padding: '1rem', textAlign: 'center', fontSize: '0.95rem' }}>
                                    ✓ No major violations detected
                                </p>
                            )}
                            {examViolation && examViolation.type && (
                                <div className="termination-reason" style={{
                                    marginTop: '0.75rem',
                                    padding: '0.75rem 1rem',
                                    borderRadius: '10px',
                                    background: 'rgba(239, 68, 68, 0.1)',
                                    border: '1px solid rgba(239, 68, 68, 0.25)',
                                }}>
                                    <span style={{ color: '#fca5a5', fontSize: '0.85rem' }}>Exam Terminated Due To:</span>
                                    <strong style={{ display: 'block', color: '#f87171', marginTop: '0.25rem' }}>
                                        {formatTerminationReason(examViolation.type)}
                                    </strong>
                                </div>
                            )}
                        </div>
                    </div>



                    <div className="actions-section">
                        <button onClick={handleLogout} className="action-button primary">
                            {logoutCountdown > 0
                                ? `Complete Exam & Logout  (auto in ${logoutCountdown}s)`
                                : 'Complete Exam & Logout'}
                        </button>
                        <button onClick={handleDownloadPDF} className="action-button secondary">
                            Download Summary
                        </button>
                        <button
                            onClick={handleRequestManualReview}
                            className="action-button secondary"
                            disabled={appealSubmitting}
                        >
                            {appealSubmitting ? 'Submitting Review Request...' : 'Request Manual Review'}
                        </button>
                        {/* 'Back to Exam' intentionally removed: a completed
                            session cannot be retaken (backend enforces this),
                            and offering the button confused students into
                            thinking a second attempt was possible. */}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Summary;
