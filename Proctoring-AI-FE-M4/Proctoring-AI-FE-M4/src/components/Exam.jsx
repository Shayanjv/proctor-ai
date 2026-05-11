import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Doughnut } from 'react-chartjs-2';
import Swal from 'sweetalert2/dist/sweetalert2.js';
import 'sweetalert2/dist/sweetalert2.css';
import { examService } from '../services/examService';
import { VideoStreamManager } from '../utils/WebSocketHandler';
import { authService } from '../services/authService';
import { formatTime } from '../utils/timeUtils';
import { handleTabVisibility, getTabSwitchCount } from '../utils/tabVisibility';
import { getCopyPasteCount, handleCopyPaste } from '../utils/copyPasteTracker';
import { useScreenRecorder } from '../hooks/useScreenRecorder';
import { getLobbyProgress, hasCompletedNetworkChecks } from '../app/utils/lobbyProgress';
import { quitSEB } from '../app/utils/seb';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  Title
} from 'chart.js';
import NetworkSlowBanner from './NetworkSlowBanner';
import './Exam.css'; // Import styles for alerts and layout

ChartJS.register(
  ArcElement,
  Tooltip,
  Legend,
  Title
);

const envNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const envPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

const MINOR_VIOLATION_THRESHOLD = envPositiveInt(import.meta.env.VITE_MINOR_VIOLATION_THRESHOLD, 5);
const MINOR_VIOLATION_WINDOW_MS = envNumber(import.meta.env.VITE_MINOR_VIOLATION_WINDOW_MS, 3 * 60 * 1000);
const FACE_ABSENCE_GRACE_MS = envNumber(import.meta.env.VITE_FACE_ABSENCE_GRACE_MS, 25 * 1000);
const FACE_ABSENCE_HARD_TERMINATION_MS = envNumber(import.meta.env.VITE_FACE_ABSENCE_HARD_TERMINATION_MS, 60 * 1000);
const FACE_ABSENCE_STALE_MS = envNumber(import.meta.env.VITE_FACE_ABSENCE_STALE_MS, 6500);
const SCREEN_SHARE_LOSS_GRACE_MS = envNumber(import.meta.env.VITE_SCREEN_SHARE_LOSS_GRACE_MS, 20 * 1000);
const SCREEN_SHARE_HARD_TERMINATION_MS = envNumber(import.meta.env.VITE_SCREEN_SHARE_HARD_TERMINATION_MS, 60 * 1000);

const POLICY_SCORE_WINDOW_MS = envNumber(import.meta.env.VITE_POLICY_SCORE_WINDOW_MS, 5 * 60 * 1000);
const POLICY_TERMINATION_SCORE = envPositiveInt(import.meta.env.VITE_POLICY_TERMINATION_SCORE, 100);
const POLICY_CRITICAL_CONFIRMATION_WINDOW_MS = envNumber(import.meta.env.VITE_POLICY_CRITICAL_CONFIRMATION_WINDOW_MS, 90 * 1000);
const POLICY_CRITICAL_CONFIRMATION_COUNT = envPositiveInt(import.meta.env.VITE_POLICY_CRITICAL_CONFIRMATION_COUNT, 2);

const AUDIO_VOLUME_THRESHOLD = Math.max(
  envNumber(import.meta.env.VITE_AUDIO_VOLUME_THRESHOLD, 150),
  150
);
const AUDIO_CONSECUTIVE_FRAMES_THRESHOLD = Math.max(
  envPositiveInt(import.meta.env.VITE_AUDIO_CONSECUTIVE_FRAMES_THRESHOLD, 10),
  10
);
const AUDIO_ALERT_COOLDOWN_MS = Math.max(
  envNumber(import.meta.env.VITE_AUDIO_ALERT_COOLDOWN_MS, 20000),
  20000
);
const FACE_BOX_REPEAT_ELIGIBILITY_MS = envNumber(import.meta.env.VITE_FACE_BOX_REPEAT_ELIGIBILITY_MS, 8 * 1000);
const FACE_BOX_CONTINUOUS_TERMINATION_MS = envNumber(import.meta.env.VITE_FACE_BOX_CONTINUOUS_TERMINATION_MS, 20 * 1000);
const FACE_BOX_REPEAT_WINDOW_MS = envNumber(import.meta.env.VITE_FACE_BOX_REPEAT_WINDOW_MS, 10 * 60 * 1000);
const FACE_BOX_REPEAT_THRESHOLD = envPositiveInt(import.meta.env.VITE_FACE_BOX_REPEAT_THRESHOLD, 3);
const FACE_GUIDE_VOICE_COOLDOWN_MS = envNumber(import.meta.env.VITE_FACE_GUIDE_VOICE_COOLDOWN_MS, 9000);

// Phase 4: Prevent burst alerts when backend delivers delayed logs in a burst.
// If detections arrive "late", treat them as stale and show one banner instead of spamming alerts.
const DETECTION_LOG_STALE_MS = envNumber(import.meta.env.VITE_DETECTION_LOG_STALE_MS, 3500);

const EVENT_SCORE_WEIGHTS = {
  tab_switch: 18,
  copy_paste: 22,
  face_not_visible: 25,
  face_outside_box: 14,
  face_partially_visible: 16,
  face_too_close: 10,
  face_too_far: 10,
  eye_movement: 0,
  gaze_looking_away: 0,
  head_posture: 0,
  mouth_movement: 0,
  hand_detected: 6,
  audio_anomaly: 0,
  phone_detected: 40,
  prohibited_object: 35,
  multiple_people: 45,
  face_spoofing: 45,
  screen_share_stopped: 50,
  camera_blocked_or_disabled: 55,
  third_party_communication: 60,
};

const FACE_RECOVERY_EVENT_TYPES = new Set([
  'face_detected',
  'face_outside_box',
  'face_partially_visible',
  'face_too_close',
  'face_too_far',
  'head_posture',
  'eye_movement',
  'mouth_movement',
  'gaze_looking_away',
  'face_spoofing',
  'identity_mismatch',
  'multiple_people'
]);

const IMMEDIATE_TERMINATION_EVENT_TYPES = new Set([
  'identity_mismatch',
  'tampering_detected',
  'remote_access_detected',
  'virtual_machine_detected',
  'capture_tool_detected',
  'abusive_behavior',
  'disruptive_behavior',
  'proctor_abuse'
]);

const CONFIRMED_CRITICAL_EVENT_TYPES = new Set([
  'multiple_people',
  'phone_detected',
  'prohibited_object',
  'face_spoofing',
  'third_party_communication',
  'screen_share_stopped',
  'camera_blocked_or_disabled',
]);

const WARNING_ONLY_EVENT_TYPES = new Set([
  'eye_movement',
  'gaze_looking_away',
  'head_posture',
  'mouth_movement',
  'audio_anomaly',
  'identity_unverifiable',
]);

const DEFAULT_FACE_GUIDE_STATE = Object.freeze({
  status: 'inside',
  severity: 'ok',
  boxColor: 'green',
  message: 'Position your face within the box',
  voicePrompt: null,
  faceDetected: false,
  continuousSeconds: 0,
  secondsUntilFlag: null,
  secondsUntilTermination: null,
});

const MONITOR_POSITION_STORAGE_KEY = 'exam-camera-position';
const MONITOR_VIEWPORT_GUTTER = 16;

const normalizeFaceGuideState = (rawState) => {
  if (!rawState || typeof rawState !== 'object') {
    return DEFAULT_FACE_GUIDE_STATE;
  }

  const normalizeNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    status: typeof rawState.status === 'string' ? rawState.status : DEFAULT_FACE_GUIDE_STATE.status,
    severity: typeof rawState.severity === 'string' ? rawState.severity : DEFAULT_FACE_GUIDE_STATE.severity,
    boxColor: typeof rawState.box_color === 'string' ? rawState.box_color : DEFAULT_FACE_GUIDE_STATE.boxColor,
    message: typeof rawState.message === 'string' ? rawState.message : DEFAULT_FACE_GUIDE_STATE.message,
    voicePrompt: typeof rawState.voice_prompt === 'string' ? rawState.voice_prompt : null,
    faceDetected: Boolean(rawState.face_detected),
    continuousSeconds: normalizeNumber(rawState.continuous_seconds) ?? 0,
    secondsUntilFlag: normalizeNumber(rawState.seconds_until_flag),
    secondsUntilTermination: normalizeNumber(rawState.seconds_until_termination),
  };
};

const formatFaceGuideStatus = (status) => {
  const labels = {
    inside: 'Aligned',
    edge: 'Near Edge',
    outside: 'Outside Box',
    missing: 'Face Missing',
    partial: 'Partial Face',
    too_close: 'Too Close',
    too_far: 'Too Far',
  };
  return labels[status] || 'Camera Guide';
};

const loadStoredMonitorPosition = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(MONITOR_POSITION_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue);
    const left = Number(parsed?.left);
    const top = Number(parsed?.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      return null;
    }

    return { left, top };
  } catch {
    return null;
  }
};

const clampMonitorPosition = (position, element) => {
  if (!position || !element || typeof window === 'undefined') {
    return position;
  }

  const panelWidth = element.offsetWidth || 338;
  const panelHeight = element.offsetHeight || 240;
  const maxLeft = Math.max(MONITOR_VIEWPORT_GUTTER, window.innerWidth - panelWidth - MONITOR_VIEWPORT_GUTTER);
  const maxTop = Math.max(MONITOR_VIEWPORT_GUTTER, window.innerHeight - panelHeight - MONITOR_VIEWPORT_GUTTER);

  return {
    left: Math.min(Math.max(position.left, MONITOR_VIEWPORT_GUTTER), maxLeft),
    top: Math.min(Math.max(position.top, MONITOR_VIEWPORT_GUTTER), maxTop),
  };
};

const buildAnswerMap = (answers = []) => {
  const map = {};
  answers.forEach((entry) => {
    if (!entry || entry.question_id === undefined || entry.question_id === null) {
      return;
    }
    map[String(entry.question_id)] = entry.selected_option ?? null;
  });
  return map;
};

const buildAnswerListFromMap = (answerMap = {}) => Object.entries(answerMap)
  .filter(([questionId]) => Number.isFinite(Number(questionId)))
  .map(([questionId, selectedOption]) => ({
    question_id: Number(questionId),
    selected_option: selectedOption ?? null,
  }));

const upsertAnswerEntry = (answers, questionId, selectedOption) => {
  const nextMap = buildAnswerMap(answers);
  nextMap[String(questionId)] = selectedOption ?? null;
  return buildAnswerListFromMap(nextMap);
};

const Exam = () => {
  const { examId: routeExamId } = useParams();
  const location = useLocation();
  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const wsHandlerRef = useRef(null);
  const monitorPanelRef = useRef(null);
  const monitorDragRef = useRef(null);
  const [questions, setQuestions] = useState([]);
  const [examMetadata, setExamMetadata] = useState(null);
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [score, setScore] = useState(0);
  const [showScore] = useState(false);
  const navigate = useNavigate();
  const [connected, setConnected] = useState(true);
  const [summary, setSummary] = useState(null);
  const [userId] = useState(localStorage.getItem('userId') || '1');
  const [isLti] = useState(localStorage.getItem('isLti') === 'true');
  const [timeRemaining, setTimeRemaining] = useState(0);
  const timerRef = useRef(null);
  
  // Screen recording hook
  const {
    stopRecording,
    hasActiveScreenShare,
    error: screenRecorderError,
  } = useScreenRecorder({ userId });
  const [, setIsInitializing] = useState(true);
  const [examStarted, setExamStarted] = useState(false);
  const [, setIsVideoReady] = useState(false);
  const frameIntervalRef = useRef(null);
  const terminationRef = useRef(false);
  const tabSwitchTimesRef = useRef([]);
  const copyPasteTimesRef = useRef([]);
  const faceAbsenceStartedAtRef = useRef(null);
  const lastFaceAbsenceSignalAtRef = useRef(null);
  const screenShareLossStartedAtRef = useRef(null);
  const screenShareLastSignalAtRef = useRef(0);
  const policyRiskEventsRef = useRef([]);
  const criticalSignalsRef = useRef({});
  const faceGuideBreachRef = useRef({
    active: false,
    lastDurationMs: 0,
  });
  const faceGuideRepeatTimesRef = useRef([]);
  const lastFaceGuideVoiceRef = useRef({
    message: '',
    spokenAt: 0,
  });
  const [videoInitError, setVideoInitError] = useState(null);
  const [faceGuideState, setFaceGuideState] = useState(DEFAULT_FACE_GUIDE_STATE);
  const [monitorPosition, setMonitorPosition] = useState(() => loadStoredMonitorPosition());
  const [isMonitorDragging, setIsMonitorDragging] = useState(false);
  const [isMonitorMinimized, setIsMonitorMinimized] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.localStorage.getItem('exam-camera-minimized') === 'true';
  });
  const [warnings, setWarnings] = useState([]);
  const [violationScore, setViolationScore] = useState(100); // Start at 100%
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [userAnswers, setUserAnswers] = useState([]);
  const [shortAnswer, setShortAnswer] = useState('');
  const [delayedDelivery, setDelayedDelivery] = useState({
    active: false,
    lastSeenAt: 0,
    count: 0,
    maxAgeMs: 0,
  });
  const delayedDeliveryClearRef = useRef(null);
  const questionCount = questions.length;
  const progressLabel = questionCount > 0 ? `${currentQuestion + 1}/${questionCount}` : '0/0';
  const progressPercent = questionCount > 0
    ? Math.min(100, Math.round(((currentQuestion + 1) / questionCount) * 100))
    : 0;
  const warningCount = warnings.length;
  const faceGuideCountdown = faceGuideState.status === 'outside'
    ? (
      faceGuideState.continuousSeconds < (FACE_BOX_REPEAT_ELIGIBILITY_MS / 1000)
        ? faceGuideState.secondsUntilFlag
        : faceGuideState.secondsUntilTermination
    )
    : null;
  const faceGuideAlertActive = faceGuideState.severity === 'warning' || faceGuideState.severity === 'critical';
  const connectionUiHealthy = connected;
  const monitorStatusText = 'Monitoring Active';
  const monitorSupportText = isMonitorMinimized
    ? 'Camera minimized. Proctoring continues in the background.'
    : 'Drag the floating camera anywhere. Monitoring stays active while you use the full exam screen.';

  const persistExamProgress = useCallback(async (overrides = {}) => {
    if (!examStarted || showScore) {
      return;
    }

    const activeExamId = routeExamId || localStorage.getItem('examId');
    if (!activeExamId || !userId) {
      return;
    }

    try {
      await examService.saveProgress(userId, {
        exam_id: Number(activeExamId),
        answers: buildAnswerMap(overrides.answers ?? userAnswers),
        current_question_index: overrides.currentQuestionIndex ?? currentQuestion,
        remaining_seconds: overrides.remainingSeconds ?? timeRemaining,
      });
    } catch (error) {
      console.debug('Unable to persist exam progress:', error);
    }
  }, [currentQuestion, examStarted, routeExamId, showScore, timeRemaining, userAnswers, userId]);

  const alertsMarkup = (
    <div className="alerts-container" aria-live="assertive" aria-atomic="true">
      {activeAlerts.map(alert => (
        <div key={alert.id} className={`side-alert ${alert.isViolation ? 'violation' : ''}`}>
          <div className="alert-header">
            <strong>{alert.type}</strong>
            <span className="alert-time">{alert.time}</span>
          </div>
          <div className="alert-message">{alert.message}</div>
        </div>
      ))}
    </div>
  );

  const showSideAlert = (type, message, options = {}) => { 
    const {
      logToBackend = true,
      dedupeKey = type,
      scorePenalty = 10,
      isViolation = true,
    } = options;

    // Determine title based on type
    let title = 'Violation Detected';
    if (type === 'tab') title = 'Tab Switching';
    else if (type === 'copy-paste') title = 'Copy-Paste';
    else if (type === 'audio') title = 'Audio Check';
    else if (type === 'person') title = 'Multiple People';
    else if (type === 'face') title = 'Face Not Visible';
    else if (type === 'box') title = 'Face Position';
    else if (type === 'eye') title = 'Attention Check';
    else if (type === 'mouth') title = 'Mouth Activity';
    else if (type === 'head') title = 'Head Position';
    else if (type === 'hand') title = 'Hand Detected';
    else if (type === 'object') title = 'Prohibited Object';

    setActiveAlerts(prev => {
      // Prevent duplicate stacked alerts of the exact same type
      if (prev.some(alert => alert.dedupeKey === dedupeKey)) {
        return prev;
      }
      
      const newWarning = {
        id: Date.now() + Math.random(),
        type: title,
        dedupeKey,
        message: message,
        isViolation,
        time: new Date().toLocaleTimeString()
      };

      // Set timeout to remove just this specific alert after 4s
      setTimeout(() => {
        setActiveAlerts(current => current.filter(a => a.id !== newWarning.id));
      }, 4000);

      // Only deduct score and log if we are actually showing it
      setWarnings(w => [...w, newWarning]);
      if (scorePenalty > 0) {
        setViolationScore(score => Math.max(0, score - scorePenalty));
      }

      if (logToBackend) {
        let logType = type;
        if (type === 'tab') logType = 'tab_switch';
        else if (type === 'copy-paste') logType = 'copy_paste';
        else if (type === 'audio') logType = 'audio_anomaly';
        else if (type === 'person') logType = 'multiple_people';
        else if (type === 'face') logType = 'face_not_visible';
        else if (type === 'box') logType = 'face_outside_box';
        else if (type === 'eye') logType = 'eye_movement';
        else if (type === 'mouth') logType = 'mouth_movement';
        else if (type === 'head') logType = 'head_posture';
        else if (type === 'hand') logType = 'hand_detected';
        else if (type === 'object') logType = 'prohibited_object';

        const logMessage = typeof message === 'string' ? message : `${title} detected`;
        setTimeout(() => {
          examService.logViolation(logType, logMessage, { type, value: message }).catch(e => console.error(e));
        }, 0);
      }

      return [...prev, newWarning];
    });
  };

  const handleExamViolation = async (type, attempts) => {
    // Store violation data with timestamp
    localStorage.setItem('examViolations', JSON.stringify({
      type,
      attempts,
      warnings: warnings,
      complianceScore: violationScore,
      timestamp: new Date().toISOString()
    }));

    try {
      const userId = localStorage.getItem('userId');

      Swal.fire({
        title: 'Exam Terminated',
        html: 'Your exam has been terminated due to violations.',
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: true,
        confirmButtonText: 'OK',
        background: '#2a2a2a',
        color: '#fff'
      }).then(async () => {
        // Shut down streams cleanly
        if (videoRef.current?.srcObject) {
          videoRef.current.srcObject.getTracks().forEach(track => track.stop());
          videoRef.current.srcObject = null;
        }
        if (wsHandlerRef.current) {
          await wsHandlerRef.current.endSession();
          wsHandlerRef.current = null;
        }
        stopRecording();
        await examService.forceCloseExam(userId);

        // Always clear local auth first so neither path leaves a stale
        // JWT in storage. Then either auto-quit Safe Exam Browser (when
        // the exam is being taken inside SEB) or fall back to the
        // regular navigate-to-login flow when running in a normal
        // browser. Reloading is intentionally avoided — it breaks the
        // SPA session flow.
        authService.logout();
        quitSEB(() => navigate('/login', { replace: true }));
      });

    } catch (error) {
      console.error('[Exam] Termination error:', error);
      authService.logout();
      quitSEB(() => navigate('/login', { replace: true }));
    }
  };

  const recordMinorViolation = (bucketRef) => {
    const nowMs = Date.now();
    const withinWindow = bucketRef.current.filter((timestamp) => nowMs - timestamp <= MINOR_VIOLATION_WINDOW_MS);
    withinWindow.push(nowMs);
    bucketRef.current = withinWindow;
    return withinWindow.length;
  };

  const resetFaceAbsenceTracking = () => {
    faceAbsenceStartedAtRef.current = null;
    lastFaceAbsenceSignalAtRef.current = null;
  };

  const logPolicyTermination = (triggerType, attempts = 1, extra = {}) => {
    const message = `Exam terminated due to policy violation: ${triggerType}`;
    examService.logViolation('policy_termination', message, {
      trigger_type: triggerType,
      attempts,
      terminated_at: new Date().toISOString(),
      ...extra,
    }).catch((error) => console.error('Failed to log policy termination:', error));
  };

  const triggerTerminationOnce = (type, attempts = 1, details = {}) => {
    if (terminationRef.current) {
      return;
    }
    terminationRef.current = true;
    logPolicyTermination(type, attempts, details);
    void handleExamViolation(type, attempts);
  };

  const pruneRiskEvents = (nowMs = Date.now()) => {
    policyRiskEventsRef.current = policyRiskEventsRef.current.filter(
      (entry) => nowMs - entry.timestamp <= POLICY_SCORE_WINDOW_MS
    );
  };

  const getRollingRiskScore = () => {
    pruneRiskEvents();
    return policyRiskEventsRef.current.reduce((sum, entry) => sum + entry.score, 0);
  };

  const registerRiskEvent = (eventType, details = {}) => {
    if (!eventType || terminationRef.current) {
      return getRollingRiskScore();
    }

    const score = EVENT_SCORE_WEIGHTS[eventType] ?? 0;
    if (score <= 0) {
      return getRollingRiskScore();
    }

    const nowMs = Date.now();
    policyRiskEventsRef.current.push({
      eventType,
      score,
      timestamp: nowMs,
      details,
    });

    const rollingScore = getRollingRiskScore();
    if (rollingScore >= POLICY_TERMINATION_SCORE) {
      triggerTerminationOnce('weighted-risk-threshold', rollingScore, {
        policy: 'weighted-risk',
        risk_score: rollingScore,
        risk_window_ms: POLICY_SCORE_WINDOW_MS,
        last_event_type: eventType,
        ...details,
      });
    }

    return rollingScore;
  };

  const registerCriticalSignal = (eventType, details = {}) => {
    if (!eventType || terminationRef.current) {
      return 0;
    }

    const nowMs = Date.now();
    const previousSignals = criticalSignalsRef.current[eventType] || [];
    const activeSignals = previousSignals.filter(
      (timestamp) => nowMs - timestamp <= POLICY_CRITICAL_CONFIRMATION_WINDOW_MS
    );
    activeSignals.push(nowMs);
    criticalSignalsRef.current[eventType] = activeSignals;

    if (activeSignals.length >= POLICY_CRITICAL_CONFIRMATION_COUNT) {
      triggerTerminationOnce(eventType.replace(/_/g, '-'), activeSignals.length, {
        policy: 'critical-confirmation',
        confirmation_window_ms: POLICY_CRITICAL_CONFIRMATION_WINDOW_MS,
        required_confirmations: POLICY_CRITICAL_CONFIRMATION_COUNT,
        ...details,
      });
    }

    return activeSignals.length;
  };

  const handleMonitorDragStart = (event) => {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    if (event.target?.closest?.('button')) {
      return;
    }
    if (!monitorPanelRef.current || typeof window === 'undefined') {
      return;
    }

    const rect = monitorPanelRef.current.getBoundingClientRect();
    const currentPosition = clampMonitorPosition(
      {
        left: rect.left,
        top: rect.top,
      },
      monitorPanelRef.current,
    );

    monitorDragRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };

    setMonitorPosition(currentPosition);
    setIsMonitorDragging(true);
    event.preventDefault();
  };

  const speakFaceGuidePrompt = (message) => {
    if (!message || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

    const nowMs = Date.now();
    const lastPrompt = lastFaceGuideVoiceRef.current;
    if (lastPrompt.message === message && nowMs - lastPrompt.spokenAt < FACE_GUIDE_VOICE_COOLDOWN_MS) {
      return;
    }

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 0.9;
      window.speechSynthesis.speak(utterance);
      lastFaceGuideVoiceRef.current = {
        message,
        spokenAt: nowMs,
      };
    } catch (error) {
      console.warn('Unable to play face guide voice prompt:', error);
    }
  };

  const getLogTimestampMs = (log) => {
    if (!log || typeof log !== 'object') {
      return null;
    }

    const candidate = log.timestamp ?? log.time ?? log.created_at ?? log.createdAt ?? null;
    if (candidate === null || candidate === undefined) {
      return null;
    }

    if (typeof candidate === 'number') {
      // Heuristic: seconds vs milliseconds
      return candidate < 1e12 ? candidate * 1000 : candidate;
    }

    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  };

  const initializeVideo = async (retryCount = 0, maxRetries = 3) => {
    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve) => {
      try {
        // Wait for video element to mount (up to 5 seconds)
        let attempts = 0;
        while (!videoRef.current && attempts < 50) {
          await new Promise(r => setTimeout(r, 100));
          attempts++;
        }

        if (!videoRef.current) {
          setVideoInitError('Video element not found');
          resolve(false);
          return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
          setVideoInitError('Camera access not supported in your browser');
          resolve(false);
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 },
            frameRate: { ideal: 10, max: 15 },
            facingMode: "user"
          }
        });

        if (!stream.active) {
          throw new Error('Camera stream not active');
        }

        videoRef.current.srcObject = stream;
        await new Promise((resolveVideo) => {
          videoRef.current.onloadedmetadata = () => resolveVideo();
          videoRef.current.onerror = () => {
            setVideoInitError('Failed to load video stream');
            resolveVideo();
          };
        });

        try {
          await videoRef.current.play();
          console.log('Video stream initialized successfully');
          resolve(true);
        } catch (playError) {
          console.error('Video play error:', playError);
          throw new Error('Failed to start video playback');
        }

      } catch (err) {
        console.error('Video initialization error:', err);

        if (retryCount < maxRetries) {
          console.log(`Retrying video initialization (${retryCount + 1}/${maxRetries})...`);
          setTimeout(() => {
            resolve(initializeVideo(retryCount + 1, maxRetries));
          }, 1000);
        } else {
          setVideoInitError(
            err.name === 'NotAllowedError'
              ? 'Camera access denied. Please check your permissions.'
              : err.name === 'NotFoundError'
                ? 'No camera found. Please connect a camera and try again.'
                : 'Failed to initialize camera. Please try again.'
          );
          resolve(false);
        }
      }
    });
  };

  const handleWebSocketMessage = (data) => {
    console.log("Received WebSocket message:", data);
    if (data.type === 'session_terminated') {
      // Backend has already enforced policy termination and is about to close
      // the WebSocket. Without this branch the FE silently ignores the signal,
      // the ws layer enters its reconnect loop, and every reconnect is rejected
      // because the session is now in 'terminated' state server-side.
      // Reuse the local termination flow so we cleanly:
      //   - flip terminationRef so no further client-side policy code fires,
      //   - log the termination with the backend-supplied reason/details,
      //   - end the WS session (stops reconnect + frame capture),
      //   - navigate the student to the summary screen.
      const backendReason = (data.reason || 'backend-termination').toString();
      const triggerType = backendReason.replace(/_/g, '-');
      triggerTerminationOnce(triggerType, 1, {
        policy: 'backend-policy',
        backend_reason: backendReason,
        backend_details: data.details || null,
      });
      return;
    }
    if (data.type === 'keepalive') {
      setConnected(true);
    } else if (data.type === 'frame_processed') {
      setConnected(true);
      const liveFaceGuide = normalizeFaceGuideState(data.monitor_state?.face_guide);
      setFaceGuideState(liveFaceGuide);
      if (liveFaceGuide.faceDetected && liveFaceGuide.status !== 'missing') {
        resetFaceAbsenceTracking();
      }
    } else if (data.type === 'frame_error') {
      console.error('Frame processing error:', data.error);
    } else if (data.type === 'logs') {
      setConnected(true);
      const logs = data.data || [];
      console.log('Received detection logs from backend:', logs);
      const nowMs = Date.now();
      let staleCount = 0;
      let maxAgeMs = 0;
      for (const log of logs) {
        const logTimeMs = getLogTimestampMs(log);
        if (Number.isFinite(logTimeMs)) {
          const ageMs = Math.max(0, nowMs - logTimeMs);
          if (ageMs > DETECTION_LOG_STALE_MS) {
            staleCount += 1;
            maxAgeMs = Math.max(maxAgeMs, ageMs);
            continue;
          }
        }

        console.log('Processing individual log event:', JSON.stringify(log));
        
        const eventStr = (log.event || '').toLowerCase();
        const eventTypeStr = (log.event_type || log.type || '').toLowerCase();
        const eventConfidence = typeof log.ai_confidence === 'number'
          ? log.ai_confidence
          : (typeof log.confidence === 'number' ? log.confidence : null);
        const alertOptions = {
          logToBackend: false,
          dedupeKey: `ai-${eventTypeStr || eventStr}`
        };

        if (FACE_RECOVERY_EVENT_TYPES.has(eventTypeStr)) {
          resetFaceAbsenceTracking();
        }

        if (eventStr.includes('phone') || eventTypeStr === 'phone_detected') {
          showSideAlert('object', 'Prohibited object (Phone) detected', alertOptions);
        }
        if (eventTypeStr === 'multiple_people' || eventStr.includes('multiple people')) {
          showSideAlert('person', 'Multiple people detected', alertOptions);
        }
        if (eventStr.includes('absence') || eventTypeStr === 'face_not_visible') {
          showSideAlert('face', 'Face not visible', alertOptions);

          const nowMs = Date.now();
          if (!faceAbsenceStartedAtRef.current) {
            faceAbsenceStartedAtRef.current = nowMs;
          }
          lastFaceAbsenceSignalAtRef.current = nowMs;

          const absentDurationMs = nowMs - faceAbsenceStartedAtRef.current;
          if (absentDurationMs >= FACE_ABSENCE_GRACE_MS) {
            registerRiskEvent('face_not_visible', {
              confidence: eventConfidence,
              backend_event_type: eventTypeStr,
              absent_duration_ms: absentDurationMs,
              grace_seconds: FACE_ABSENCE_GRACE_MS / 1000,
            });
          }
          if (absentDurationMs >= FACE_ABSENCE_HARD_TERMINATION_MS) {
            triggerTerminationOnce('face-not-visible', Math.ceil(absentDurationMs / 1000), {
              policy: 'hard-absence-limit',
              confidence: eventConfidence,
              backend_event_type: eventTypeStr,
              hard_limit_seconds: FACE_ABSENCE_HARD_TERMINATION_MS / 1000,
            });
            break;
          }
        }
        if (eventTypeStr === 'face_outside_box') {
          showSideAlert('box', log.event || 'Stay inside the frame', {
            ...alertOptions,
            dedupeKey: 'ai-face_outside_box',
            scorePenalty: 8,
          });
        }
        if (eventTypeStr === 'face_partially_visible') {
          showSideAlert('box', log.event || 'Show your full face in the frame', {
            ...alertOptions,
            dedupeKey: 'ai-face_partially_visible',
            scorePenalty: 8,
          });
        }
        if (eventTypeStr === 'face_too_close') {
          showSideAlert('box', log.event || 'Move slightly back from the camera', {
            ...alertOptions,
            dedupeKey: 'ai-face_too_close',
            scorePenalty: 6,
          });
        }
        if (eventTypeStr === 'face_too_far') {
          showSideAlert('box', log.event || 'Move closer to the camera', {
            ...alertOptions,
            dedupeKey: 'ai-face_too_far',
            scorePenalty: 6,
          });
        }
        if (eventTypeStr === 'eye_movement') {
          showSideAlert('eye', 'Keep your eyes on the screen', {
            ...alertOptions,
            dedupeKey: 'ai-eye_movement',
            scorePenalty: 0,
            isViolation: false,
          });
        }
        if (eventTypeStr === 'mouth_movement') {
          showSideAlert('mouth', 'Keep your mouth relaxed and face the camera', {
            ...alertOptions,
            dedupeKey: 'ai-mouth_movement',
            scorePenalty: 0,
            isViolation: false,
          });
        }
        if (eventTypeStr === 'head_posture') {
          showSideAlert('head', 'Please face the screen', {
            ...alertOptions,
            dedupeKey: 'ai-head_posture',
            scorePenalty: 0,
            isViolation: false,
          });
        }
        if (eventTypeStr === 'hand_detected' || eventStr.includes('hand')) {
          showSideAlert('hand', 'Hand movement detected in frame', alertOptions);
        }
        if (eventTypeStr === 'gaze_looking_away') {
          showSideAlert('eye', 'Please keep looking at the screen', {
            ...alertOptions,
            dedupeKey: 'ai-gaze_looking_away',
            scorePenalty: 0,
            isViolation: false,
          });
        }
        if (eventTypeStr === 'face_spoofing') {
          showSideAlert('face', 'Possible face spoofing detected', alertOptions);
        }
        if (eventTypeStr === 'prohibited_object') {
          showSideAlert('object', log.event || 'Prohibited object detected', alertOptions);
        }
        if (eventTypeStr === 'screen_share_stopped' || eventTypeStr === 'camera_blocked_or_disabled') {
          showSideAlert('object', log.event || 'Screen or camera feed interrupted', alertOptions);
        }
        if (eventTypeStr === 'identity_mismatch') {
          showSideAlert('face', 'Identity mismatch detected. Exam will be terminated.', {
            ...alertOptions,
            dedupeKey: 'ai-identity_mismatch',
            scorePenalty: 35
          });
        }
        if (eventTypeStr === 'identity_unverifiable') {
          showSideAlert('face', log.event || 'Unable to verify clearly. Face the camera.', {
            ...alertOptions,
            dedupeKey: 'ai-identity_unverifiable',
            scorePenalty: 0,
            isViolation: false,
          });
        }

        if (!eventTypeStr) {
          continue;
        }

        const policyDetails = {
          confidence: eventConfidence,
          backend_event_type: eventTypeStr,
        };

        if (eventTypeStr === 'identity_mismatch') {
          triggerTerminationOnce('identity-mismatch', 1, {
            policy: 'immediate-critical',
            ...policyDetails,
          });
          break;
        }

        if (IMMEDIATE_TERMINATION_EVENT_TYPES.has(eventTypeStr)) {
          triggerTerminationOnce(eventTypeStr.replace(/_/g, '-'), 1, {
            policy: 'immediate-critical',
            ...policyDetails,
          });
          break;
        }

        if (CONFIRMED_CRITICAL_EVENT_TYPES.has(eventTypeStr)) {
          const confirmations = registerCriticalSignal(eventTypeStr, policyDetails);
          registerRiskEvent(eventTypeStr, {
            ...policyDetails,
            confirmations,
          });
          if (terminationRef.current) {
            break;
          }
          continue;
        }

        if (eventTypeStr !== 'face_not_visible' && !WARNING_ONLY_EVENT_TYPES.has(eventTypeStr)) {
          registerRiskEvent(eventTypeStr, policyDetails);
        }
        if (terminationRef.current) {
          break;
        }
      }

      if (staleCount > 0) {
        setDelayedDelivery((prev) => {
          const next = {
            active: true,
            lastSeenAt: nowMs,
            count: staleCount,
            maxAgeMs,
          };
          // Avoid extra renders when the same stale burst repeats quickly.
          if (
            prev.active &&
            nowMs - prev.lastSeenAt < 800 &&
            prev.count === next.count &&
            prev.maxAgeMs === next.maxAgeMs
          ) {
            return prev;
          }
          return next;
        });

        if (delayedDeliveryClearRef.current) {
          clearTimeout(delayedDeliveryClearRef.current);
        }
        delayedDeliveryClearRef.current = setTimeout(() => {
          setDelayedDelivery((prev) => (prev.active ? { ...prev, active: false } : prev));
          delayedDeliveryClearRef.current = null;
        }, 12000);
      }
    }
  };

  useEffect(() => {
    const userId = localStorage.getItem('userId');
    const token = localStorage.getItem('token');
    let isComponentMounted = true;

    if (!token) {
      navigate('/login');
      return;
    }

    const initializeSession = async () => {
      try {
        setIsInitializing(true);
        setVideoInitError(null);

        // ── 1. Validate exam ID ──────────────────────────────────────────────
        const examId = routeExamId || localStorage.getItem('examId');
        if (!examId) {
          await Swal.fire({
            icon: 'warning', title: 'No exam selected',
            text: 'Choose an exam from the dashboard before starting.',
            background: '#2a2a2a', color: '#fff',
          });
          setIsInitializing(false);
          navigate('/exam', { replace: true });
          return;
        }
        localStorage.setItem('examId', examId);

        // ── 2. Check lobby / network readiness ──────────────────────────────
        const lobbyProgress = getLobbyProgress(examId);
        if (!hasCompletedNetworkChecks(lobbyProgress)) {
          await Swal.fire({
            icon: 'warning', title: 'Return to Exam Lobby',
            text: 'Complete the network check in the exam lobby before starting.',
            background: '#2a2a2a', color: '#fff',
          });
          setIsInitializing(false);
          navigate(`/exam/${examId}/network-check`, { replace: true });
          return;
        }

        // ── 3. PARALLEL: fetch exam data + acquire camera ───────────────────
        // Both happen simultaneously — whichever takes longer is the bottleneck.
        const [examData] = await Promise.all([
          examService.getExamDetails(examId),
          initializeVideo(),          // Acquires stream into videoRef.current
        ]);

        if (!isComponentMounted) return;

        setExamMetadata(examData);
        setQuestions(examData.questions || []);
        setTimeRemaining((examData.duration_minutes || 60) * 60);
        setIsVideoReady(true);

        // ── 4. Start the exam on the backend ────────────────────────────────
        const examResponse = await examService.startExam(userId, examId);
        if (!isComponentMounted) return;

        const resumeState = examResponse?.resume_state;
        if (resumeState && typeof resumeState === 'object') {
          const restoredAnswers = buildAnswerListFromMap(resumeState.saved_answers || {});
          const restoredIndex = Math.max(0, Math.min(
            Number.isFinite(Number(resumeState.current_question_index))
              ? Number(resumeState.current_question_index) : 0,
            Math.max(0, (examData?.questions || []).length - 1),
          ));
          const restoredSeconds = Number(resumeState.remaining_seconds);
          setUserAnswers(restoredAnswers);
          setCurrentQuestion(restoredIndex);
          if (Number.isFinite(restoredSeconds) && restoredSeconds > 0) {
            setTimeRemaining(restoredSeconds);
          }
        }

        if (!examResponse.wsUrl) {
          throw new Error('Invalid WebSocket URL received from server');
        }

        // ── 5. Exam UI goes live NOW — before WS is connected ───────────────
        // The student can see and answer questions immediately. WS connects in
        // the background and proctoring begins as soon as socket opens.
        setExamStarted(true);
        setIsInitializing(false);

        // ── 6. Build WS handler and acquire camera stream ───────────────────
        const wsToken = examResponse.wsConfig?.token || token;
        const handler = new VideoStreamManager(examResponse.wsUrl, wsToken, userId);
        wsHandlerRef.current = handler;

        handler.setCallbacks({
          onConnect: () => { if (isComponentMounted) { console.log('[Exam] WS connected'); setConnected(true); } },
          onDisconnect: () => {
            if (isComponentMounted) {
              console.log('[Exam] WS disconnected — bypassing student-facing network warning and keeping exam live');
              setConnected(true);
            }
          },
          onMessage: handleWebSocketMessage,
        });

        // acquireCamera returns immediately once camera stream is ready.
        // connectWS runs in background — failures are silent and auto-retried.
        const camOk = await handler.acquireCamera(videoRef.current);
        if (!isComponentMounted) return;

        if (!camOk) {
          // Camera failed but exam is already running on screen — just show inline error
          setVideoInitError('Camera access failed. Proctoring requires camera permission.');
        }

        // Fire-and-forget: WS connects in background, UI is already live
        handler.connectWS().catch(() => {});

      } catch (error) {
        console.error('[Exam] Session initialization error:', error);
        if (!isComponentMounted) return;

        if (
          error.message?.includes('401') ||
          error.message?.includes('403') ||
          error.message?.toLowerCase().includes('unauthorized')
        ) {
          await Swal.fire({
            icon: 'warning', title: 'Session Expired',
            text: 'Please login again to continue.',
            timer: 2000, showConfirmButton: false,
            background: '#2a2a2a', color: '#fff',
          });
          authService.logout();
          navigate('/login', { state: { from: location }, replace: true });
          return;
        }

        setVideoInitError(error.message);
        setIsInitializing(false);
        // Only show popup for hard errors (not transient WS issues)
        if (!error.message?.toLowerCase().includes('websocket')) {
          Swal.fire({
            icon: 'error', title: 'Connection Error',
            text: error.message,
            background: '#2a2a2a', color: '#fff',
          });
        }
      }
    };

    initializeSession();

    return () => {
      isComponentMounted = false;
      if (wsHandlerRef.current) {
        wsHandlerRef.current.endSession().catch(e => console.error('[Exam] Session cleanup error:', e));
        wsHandlerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  useEffect(() => {
    // Tab Visibility Tracking
    const cleanupVisibility = handleTabVisibility(async (type, value) => {
      const eventType = 'tab_switch';
      const recentViolations = recordMinorViolation(tabSwitchTimesRef);
      showSideAlert('tab', `Tab switch detected (${recentViolations}/${MINOR_VIOLATION_THRESHOLD} in short window)`);
      registerRiskEvent(eventType, {
        policy: 'minor-event',
        source_event_label: type,
        recent_violations: recentViolations,
        utility_counter: value,
      });
      if (recentViolations >= MINOR_VIOLATION_THRESHOLD) {
        registerRiskEvent(eventType, {
          policy: 'minor-threshold-breach',
          source_event_label: type,
          window_ms: MINOR_VIOLATION_WINDOW_MS,
          threshold: MINOR_VIOLATION_THRESHOLD,
          recent_violations: recentViolations,
          utility_counter: value,
        });
      }
    });

    return () => {
      cleanupVisibility();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Copy-Paste Detection
    const cleanupCopyPaste = handleCopyPaste(async (type, value) => {
      const eventType = 'copy_paste';
      const recentViolations = recordMinorViolation(copyPasteTimesRef);
      showSideAlert('copy-paste', `Copy-Paste detected (${recentViolations}/${MINOR_VIOLATION_THRESHOLD} in short window)`);
      registerRiskEvent(eventType, {
        policy: 'minor-event',
        source_event_label: type,
        recent_violations: recentViolations,
        utility_counter: value,
      });
      if (recentViolations >= MINOR_VIOLATION_THRESHOLD) {
        registerRiskEvent(eventType, {
          policy: 'minor-threshold-breach',
          source_event_label: type,
          window_ms: MINOR_VIOLATION_WINDOW_MS,
          threshold: MINOR_VIOLATION_THRESHOLD,
          recent_violations: recentViolations,
          utility_counter: value,
        });
      }
    });

    return () => {
      cleanupCopyPaste();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const intervalId = setInterval(() => {
      if (!lastFaceAbsenceSignalAtRef.current) {
        return;
      }

      if (Date.now() - lastFaceAbsenceSignalAtRef.current > FACE_ABSENCE_STALE_MS) {
        resetFaceAbsenceTracking();
      }
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!examStarted || terminationRef.current) {
      return;
    }

    const shouldPrompt =
      faceGuideState.severity === 'warning' || faceGuideState.severity === 'critical';
    if (!shouldPrompt || !faceGuideState.voicePrompt) {
      return;
    }

    speakFaceGuidePrompt(faceGuideState.voicePrompt);
  }, [examStarted, faceGuideState.severity, faceGuideState.voicePrompt]);

  useEffect(() => {
    if (!examStarted || terminationRef.current) {
      return;
    }

    const nowMs = Date.now();
    const isOutside = faceGuideState.status === 'outside';
    const currentDurationMs = Math.round((faceGuideState.continuousSeconds || 0) * 1000);

    if (isOutside) {
      faceGuideBreachRef.current = {
        active: true,
        lastDurationMs: currentDurationMs,
      };

      if (currentDurationMs >= FACE_BOX_CONTINUOUS_TERMINATION_MS) {
        triggerTerminationOnce('face-outside-box', Math.ceil(currentDurationMs / 1000), {
          policy: 'continuous-face-box-breach',
          continuous_duration_ms: currentDurationMs,
          termination_threshold_ms: FACE_BOX_CONTINUOUS_TERMINATION_MS,
        });
      }
      return;
    }

    if (!faceGuideBreachRef.current.active) {
      return;
    }

    const endedDurationMs = faceGuideBreachRef.current.lastDurationMs;
    faceGuideBreachRef.current = {
      active: false,
      lastDurationMs: 0,
    };

    if (endedDurationMs < FACE_BOX_REPEAT_ELIGIBILITY_MS) {
      return;
    }

    const activeBreaches = faceGuideRepeatTimesRef.current.filter(
      (timestamp) => nowMs - timestamp <= FACE_BOX_REPEAT_WINDOW_MS
    );
    activeBreaches.push(nowMs);
    faceGuideRepeatTimesRef.current = activeBreaches;

    if (activeBreaches.length >= FACE_BOX_REPEAT_THRESHOLD) {
      triggerTerminationOnce('repeated-face-outside-box', activeBreaches.length, {
        policy: 'repeated-face-box-breach',
        repeat_window_ms: FACE_BOX_REPEAT_WINDOW_MS,
        repeat_threshold: FACE_BOX_REPEAT_THRESHOLD,
        last_breach_duration_ms: endedDurationMs,
      });
    }
  }, [examStarted, faceGuideState.continuousSeconds, faceGuideState.status]);

  useEffect(() => {
    if (!examStarted) {
      return;
    }

    const intervalId = setInterval(() => {
      if (terminationRef.current) {
        return;
      }

      const nowMs = Date.now();
      if (hasActiveScreenShare) {
        screenShareLossStartedAtRef.current = null;
        screenShareLastSignalAtRef.current = 0;
        return;
      }

      if (!screenShareLossStartedAtRef.current) {
        screenShareLossStartedAtRef.current = nowMs;
        return;
      }

      const lostDurationMs = nowMs - screenShareLossStartedAtRef.current;
      if (lostDurationMs >= SCREEN_SHARE_HARD_TERMINATION_MS) {
        triggerTerminationOnce('screen-share-stopped', Math.ceil(lostDurationMs / 1000), {
          reason: screenRecorderError || 'Screen sharing lost',
          policy: 'hard-screen-share-limit',
          lost_duration_ms: lostDurationMs,
          hard_limit_seconds: SCREEN_SHARE_HARD_TERMINATION_MS / 1000,
        });
        return;
      }

      if (lostDurationMs < SCREEN_SHARE_LOSS_GRACE_MS) {
        return;
      }

      if (nowMs - screenShareLastSignalAtRef.current < 10000) {
        return;
      }
      screenShareLastSignalAtRef.current = nowMs;

      showSideAlert('object', 'Screen sharing stopped or tampering detected.', {
        dedupeKey: 'screen-share-stopped',
        scorePenalty: 30,
      });
      const signalDetails = {
        reason: screenRecorderError || 'Screen sharing lost',
        policy: 'screen-share-grace',
        lost_duration_ms: lostDurationMs,
      };
      const confirmations = registerCriticalSignal('screen_share_stopped', signalDetails);
      registerRiskEvent('screen_share_stopped', {
        ...signalDetails,
        confirmations,
      });
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [examStarted, hasActiveScreenShare, screenRecorderError]);



  useEffect(() => {
    if (!showScore && examStarted && !timerRef.current) {
      timerRef.current = setInterval(() => {
        setTimeRemaining(prev => {
          if (prev <= 0) {
            clearInterval(timerRef.current);
            timerRef.current = null;
            handleTimeExpired();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examStarted, showScore]);

  useEffect(() => {
    const activeQuestion = questions[currentQuestion];
    if (!activeQuestion) {
      setShortAnswer('');
      return;
    }

    const isSubjective = activeQuestion.question_type === 'SUBJECTIVE' || activeQuestion.question_type === 'SHORT_ANSWER';
    if (!isSubjective) {
      setShortAnswer('');
      return;
    }

    const existingAnswer = buildAnswerMap(userAnswers)[String(activeQuestion.id)];
    setShortAnswer(typeof existingAnswer === 'string' ? existingAnswer : '');
  }, [currentQuestion, questions, userAnswers]);

  useEffect(() => {
    if (!examStarted || showScore) {
      return;
    }

    const intervalId = setInterval(() => {
      void persistExamProgress();
    }, 15000);

    return () => {
      clearInterval(intervalId);
    };
  }, [examStarted, persistExamProgress, showScore]);

  useEffect(() => {
    if (!examStarted || showScore) {
      return undefined;
    }

    const handlePageHide = () => {
      void persistExamProgress();
    };

    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handlePageHide);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handlePageHide);
    };
  }, [examStarted, persistExamProgress, showScore]);

  const handleTimeExpired = async () => {
    // Clean up resources
    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }

    // Show timeout message
    Swal.fire({
      title: 'Time\'s Up!',
      html: 'Your exam time has expired. Processing results...',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: () => {
        Swal.showLoading();
      },
      background: '#2a2a2a',
      color: '#fff'
    });

    try {
      // Close WebSocket connection
      if (wsHandlerRef.current) {
        await wsHandlerRef.current.endSession();
      }

      // Stop screen recording immediately
      stopRecording();

      const userId = localStorage.getItem('userId');

      // Submit answers to backend
      const submissionData = {
        answers: userAnswers
      };
      const result = await examService.submitExam(userId, submissionData);

      // Persist BOTH the bare score (legacy key, still used by some
      // fallbacks) AND the full ExamResult payload that the Summary
      // screen needs to render Original Marks ("X/Y"), the Pass/Fail
      // badge, and the per-question breakdown. Previously we only
      // saved `result.score`, so the denominator and breakdown all
      // showed "?" / hidden when the student landed on Summary.
      localStorage.setItem('examScore', result.score);
      localStorage.setItem('examResult', JSON.stringify(result));

      // Wait for summary
      const summary = await pollForSummary(userId);
      localStorage.setItem('examSummary', JSON.stringify(summary));

      await Swal.close();
      navigate('/summary');
    } catch (error) {
      console.error('Error handling timeout:', error);
      await Swal.close();
      navigate('/summary');
    }
  };


  const renderSummaryChart = () => {
    if (!summary) return null;

    const data = {
      labels: ['Compliant', 'Non-Compliant'],
      datasets: [{
        data: [summary.overall_compliance, (100 - summary.overall_compliance)],
        backgroundColor: ['#2ecc71', '#e74c3c'],
        borderColor: ['#27ae60', '#c0392b'],
        borderWidth: 1,
      }]
    };

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#fff',
            padding: 20,
            font: {
              size: 14
            }
          }
        }
      },
      animation: {
        animateScale: true,
        animateRotate: true
      }
    };

    return (
      <div className="summary-chart">
        <Doughnut data={data} options={options} />
      </div>
    );
  };

  const logout = () => {
    authService.logout();
    navigate('/login', { replace: true });
  }

  const pollForSummary = async (userId, maxAttempts = 10, interval = 2000) => {
    const token = localStorage.getItem('token');
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/exam/summary/${userId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });
        const data = await response.json();

        if (response.ok && data) {
          return data;
        }
      } catch (error) {
        console.debug('Waiting for summary...', error);
      }

      await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error('Failed to get exam summary');
  };

  const handleAnswer = (answer) => {
    const currentQuestionId = questions[currentQuestion]?.id;
    if (!currentQuestionId) {
      return;
    }

    const newUserAnswers = upsertAnswerEntry(userAnswers, currentQuestionId, answer);
    setUserAnswers(newUserAnswers);

    if (answer === questions[currentQuestion].correct_option) {
      setScore(score + 1);
    }

    const nextQuestion = currentQuestion + 1;
    const advancing = nextQuestion < questions.length;
    const nextQuestionIndex = advancing ? nextQuestion : currentQuestion;

    // Persist progress in the background — DO NOT await. Awaiting blocked
    // the question advance behind a network round-trip, which inside Safe
    // Exam Browser (slower WebView, no parallel-tab warmup) produced a
    // 1–3s "dead click" where the student saw no response after picking
    // an option and assumed the button was broken. Fire-and-forget keeps
    // the UI snappy; transient saveProgress failures are non-fatal (the
    // final submit is the source of truth).
    persistExamProgress({
      answers: newUserAnswers,
      currentQuestionIndex: nextQuestionIndex,
      remainingSeconds: timeRemaining,
    }).catch((error) => {
      console.debug('persistExamProgress (background) failed:', error);
    });

    if (advancing) {
      // Clear the short-answer textarea ONLY when moving to a new question.
      // On the last question we keep the value visible so the student can
      // review/edit it before clicking the explicit Submit Exam button.
      setShortAnswer('');
      setCurrentQuestion(nextQuestion);
    }
    // Last question: stay put, retain UI state, and let the student review.
    // Final submission now requires an explicit click on "Submit Exam" so we
    // never auto-grade behind their back — see promptSubmitExamWithConfirmation.
  };

  // Counts entries with a non-empty selected_option — short-answer responses
  // and MCQ selections both store text in selected_option, while skipped
  // questions store null/"".
  const countAnswered = (answersList) => (
    (answersList || []).reduce((acc, entry) => {
      const value = entry?.selected_option;
      if (value === null || value === undefined) return acc;
      return String(value).trim().length > 0 ? acc + 1 : acc;
    }, 0)
  );

  const promptSubmitExamWithConfirmation = () => {
    const totalQuestions = questions.length;
    if (totalQuestions === 0) return;

    const answeredCount = countAnswered(userAnswers);
    const unansweredCount = Math.max(0, totalQuestions - answeredCount);

    Swal.fire({
      title: 'Submit your exam?',
      html: `
        <div style="text-align:left;line-height:1.55">
          <p style="margin:0 0 10px">You have answered <strong>${answeredCount}</strong> of <strong>${totalQuestions}</strong> questions.</p>
          ${unansweredCount > 0
            ? `<p style="color:#fbbf24;margin:0 0 10px"><strong>${unansweredCount} question${unansweredCount === 1 ? '' : 's'} unanswered</strong> — they will be marked as skipped (0 marks).</p>`
            : '<p style="color:#34d399;margin:0 0 10px">All questions answered.</p>'}
          <p style="margin:0 0 6px"><strong>Please double-check every answer before confirming.</strong></p>
          <p style="margin:0;color:#fca5a5">Once submitted, you cannot edit your answers or retake this exam.</p>
        </div>
      `,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Yes, submit my exam',
      cancelButtonText: 'Review my answers',
      confirmButtonColor: '#10b981',
      cancelButtonColor: '#6b7280',
      background: '#2a2a2a',
      color: '#fff',
      reverseButtons: true,
      focusCancel: unansweredCount > 0,
    }).then((result) => {
      if (result.isConfirmed) {
        // Reuse the existing finish path, explicitly NOT a violation.
        handleFinishExam(false);
      }
    });
  };

  const handleFinishExam = async (isViolation = false) => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(track => {
        track.stop();
      });
      videoRef.current.srcObject = null;
    }
    
    // Output recording stop explicitly for finish
    stopRecording();

    try {
      if (isViolation) {
        const copyPasteAttempts = getCopyPasteCount();
        const tabSwitches = getTabSwitchCount();
        localStorage.setItem('examViolation', JSON.stringify({
          copyPasteAttempts,
          tabSwitches,
          type: copyPasteAttempts >= 3 ? 'copy-paste' : 'tab-switch'
        }));
      }

      Swal.fire({
        title: 'Processing Results',
        html: 'Please wait while we analyze your exam session...',
        allowOutsideClick: false,
        allowEscapeKey: false,
        showConfirmButton: false,
        didOpen: () => {
          Swal.showLoading();
        },
        background: '#2a2a2a',
        color: '#fff'
      });

      if (wsHandlerRef.current) {
        await wsHandlerRef.current.endSession();
      }

      const userId = localStorage.getItem('userId');

      // Submit answers to backend
      const submissionData = {
        answers: userAnswers
      };
      const result = await examService.submitExam(userId, submissionData);

      // Persist BOTH the bare score AND the full ExamResult so the
      // Summary screen can render "X/Y", Pass/Fail, and the per-question
      // breakdown. See sibling comment in handleTimeoutSubmit.
      localStorage.setItem('examScore', result.score);
      localStorage.setItem('examResult', JSON.stringify(result));
      localStorage.setItem('tabSwitches', getTabSwitchCount());

      const summary = await pollForSummary(userId);
      localStorage.setItem('examSummary', JSON.stringify(summary));

      await Swal.close();
      // replace:true so the browser back-button cannot return to the exam
      // page after submission — the session is finalized server-side too.
      navigate('/summary', { replace: true });
    } catch (error) {
      console.error('Error during exam completion:', error);
      Swal.update({
        title: 'Processing Results',
        html: 'Please wait while we complete the analysis...',
        showConfirmButton: false
      });
      setTimeout(async () => {
        try {
          const userId = localStorage.getItem('userId');
          const summary = await pollForSummary(userId, 1);
          localStorage.setItem('examSummary', JSON.stringify(summary));
        } catch (finalError) {
          console.error('Final attempt failed:', finalError);
        }
        await Swal.close();
        navigate('/summary', { replace: true });
      }, 5000);
    }
  };

  const handleLogout = () => {
    Swal.fire({
      title: 'Logout',
      text: 'Are you sure you want to end your session?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#646cff',
      cancelButtonColor: '#e74c3c',
      confirmButtonText: 'Yes, logout',
      background: '#2a2a2a',
      color: '#fff'
    }).then(async (result) => {
      if (result.isConfirmed) {
        try {
          if (videoRef.current?.srcObject) {
            const tracks = videoRef.current.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            videoRef.current.srcObject = null;
          }

          if (frameIntervalRef.current) {
            clearInterval(frameIntervalRef.current);
            frameIntervalRef.current = null;
          }

          if (wsHandlerRef.current) {
            await wsHandlerRef.current.endSession();
            wsHandlerRef.current = null;
          }

          setConnected(false);
          setIsVideoReady(false);

          authService.logout();
          navigate('/login', { replace: true });
        } catch (error) {
          console.error('Logout cleanup error:', error);
          authService.logout();
          navigate('/login', { replace: true });
        }
      }
    });
  };

  useEffect(() => {
    // Audio Detection Logic
    let audioContext;
    let analyser;
    let microphone;
    let javascriptNode;
    let audioStream;
    let consecutiveHighAudioFrames = 0;
    let lastAudioAlertAt = 0;

    const setupAudioDetection = async () => {
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        microphone = audioContext.createMediaStreamSource(audioStream);
        javascriptNode = audioContext.createScriptProcessor(2048, 1, 1);

        analyser.smoothingTimeConstant = 0.8;
        analyser.fftSize = 1024;

        microphone.connect(analyser);
        analyser.connect(javascriptNode);
        javascriptNode.connect(audioContext.destination);

        javascriptNode.onaudioprocess = () => {
          const array = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(array);
          let values = 0;
          const length = array.length;
          for (let i = 0; i < length; i++) {
            values += array[i];
          }
          const average = values / length;

          if (average > AUDIO_VOLUME_THRESHOLD) {
            consecutiveHighAudioFrames += 1;
          } else {
            consecutiveHighAudioFrames = 0;
          }

          if (
            consecutiveHighAudioFrames >= AUDIO_CONSECUTIVE_FRAMES_THRESHOLD
            && Date.now() - lastAudioAlertAt > AUDIO_ALERT_COOLDOWN_MS
          ) {
            console.log('High Audio Detected:', average);
            showSideAlert('audio', 'Background audio detected. Please stay quiet.', {
              dedupeKey: 'audio-high-volume',
              scorePenalty: 0,
              isViolation: false,
            });
            lastAudioAlertAt = Date.now();
            consecutiveHighAudioFrames = 0;
          }
        };
      } catch (err) {
        console.error('Audio detection failed:', err);
      }
    };

    if (examStarted) {
      setupAudioDetection();
    }

    return () => {
      if (audioContext) audioContext.close();
      if (javascriptNode) javascriptNode.disconnect();
      if (microphone) microphone.disconnect();
      if (analyser) analyser.disconnect();
      if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [examStarted]);

  useEffect(() => {
    const ws = wsRef.current;
    const video = videoRef.current;
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      if (ws) {
        ws.close();
      }
      if (video?.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem('exam-camera-minimized', isMonitorMinimized ? 'true' : 'false');
  }, [isMonitorMinimized]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!monitorPosition) {
      window.localStorage.removeItem(MONITOR_POSITION_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(MONITOR_POSITION_STORAGE_KEY, JSON.stringify(monitorPosition));
  }, [monitorPosition]);

  useEffect(() => {
    if (!isMonitorDragging) {
      return undefined;
    }

    const handlePointerMove = (event) => {
      if (!monitorDragRef.current || !monitorPanelRef.current) {
        return;
      }

      const nextPosition = clampMonitorPosition(
        {
          left: event.clientX - monitorDragRef.current.offsetX,
          top: event.clientY - monitorDragRef.current.offsetY,
        },
        monitorPanelRef.current,
      );
      setMonitorPosition(nextPosition);
    };

    const finishDrag = () => {
      monitorDragRef.current = null;
      setIsMonitorDragging(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    };
  }, [isMonitorDragging]);

  useEffect(() => {
    if (!monitorPosition || !monitorPanelRef.current || typeof window === 'undefined') {
      return;
    }

    const clampedPosition = clampMonitorPosition(monitorPosition, monitorPanelRef.current);
    if (
      clampedPosition.left !== monitorPosition.left
      || clampedPosition.top !== monitorPosition.top
    ) {
      setMonitorPosition(clampedPosition);
    }
  }, [isMonitorMinimized, monitorPosition]);

  useEffect(() => {
    if (!monitorPosition) {
      return undefined;
    }

    const handleResize = () => {
      if (!monitorPanelRef.current) {
        return;
      }

      setMonitorPosition((currentPosition) => (
        currentPosition
          ? clampMonitorPosition(currentPosition, monitorPanelRef.current)
          : currentPosition
      ));
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [monitorPosition]);

  return (
    <div className="exam-wrapper">
    <NetworkSlowBanner />
    <div className="dashboard-layout">
      {typeof document !== 'undefined' ? createPortal(alertsMarkup, document.body) : alertsMarkup}
      <aside
        ref={monitorPanelRef}
        className={`proctor-sidebar ${isMonitorMinimized ? 'proctor-sidebar--minimized' : ''} ${isMonitorDragging ? 'proctor-sidebar--dragging' : ''}`}
        style={monitorPosition ? {
          left: `${monitorPosition.left}px`,
          top: `${monitorPosition.top}px`,
          right: 'auto',
          bottom: 'auto',
        } : undefined}
      >
        <div
          className={`monitor-toolbar ${isMonitorDragging ? 'monitor-toolbar--dragging' : 'monitor-toolbar--draggable'}`}
          onPointerDown={handleMonitorDragStart}
        >
          <div className="monitor-toolbar-copy">
            <span className="monitor-toolbar-kicker">Camera Monitor</span>
            <strong>{monitorStatusText}</strong>
            <p>{monitorSupportText}</p>
          </div>
          <div className="monitor-toolbar-actions">
            {monitorPosition && (
              <button
                type="button"
                className="monitor-action-btn monitor-action-btn--secondary"
                onClick={() => setMonitorPosition(null)}
              >
                Reset
              </button>
            )}
            <button
              type="button"
              className="monitor-action-btn"
              onClick={() => setIsMonitorMinimized((current) => !current)}
            >
              {isMonitorMinimized ? 'Show Camera' : 'Minimize'}
            </button>
          </div>
        </div>

        <div className={`proctor-sidebar-body ${isMonitorMinimized ? 'proctor-sidebar-body--hidden' : ''}`}>
          <div className="video-monitor">
            <div className="face-overlay">
              <div className={`face-box face-box--${faceGuideState.boxColor}`}></div>
              <div className={`face-guide-status face-guide-status--${faceGuideState.boxColor}`}>
                {formatFaceGuideStatus(faceGuideState.status)}
              </div>
              {faceGuideAlertActive && (
                <div className={`face-guide-banner face-guide-banner--${faceGuideState.boxColor}`}>
                  <strong>{faceGuideState.message}</strong>
                  {Number.isFinite(faceGuideCountdown) && faceGuideCountdown > 0 && (
                    <span>{faceGuideCountdown}s remaining</span>
                  )}
                </div>
              )}
              <div className={`face-instruction face-instruction--${faceGuideState.boxColor} ${faceGuideAlertActive ? 'face-instruction--active' : ''}`}>
                {faceGuideState.message}
              </div>
            </div>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="webcam-feed"
            />
            <div className={`status-indicator ${connectionUiHealthy ? 'active' : ''}`}>
              <span className="status-dot"></span>
              {monitorStatusText}
            </div>
          </div>
          <div className="exam-info">
            <h3>{examMetadata?.title || 'Exam'}</h3>
            <div className="exam-stats">
              <div className="stat">
                <span>Questions</span>
                <strong>{questions.length}</strong>
              </div>
              <div className="stat">
                <span>Progress</span>
                <strong>{progressLabel}</strong>
              </div>
            </div>
          </div>
        </div>

        {isMonitorMinimized && (
          <div className={`monitor-minimized-summary monitor-minimized-summary--${faceGuideState.boxColor}`}>
            <div className="monitor-minimized-text">
              <strong>Camera active in background</strong>
              <span>{formatFaceGuideStatus(faceGuideState.status)} • {faceGuideState.message}</span>
            </div>
            <span className={`monitor-mini-pulse ${connectionUiHealthy ? 'active' : ''}`}></span>
          </div>
        )}
      </aside>

      <main className="exam-content">
        {false && !connected ? (
          <div className="connection-warning">
            <div className="warning-card">
              <div className="loading-spinner"></div>
              <h2>Secure connection confirmed</h2>
              {videoInitError ? (
                <div className="error-message">{videoInitError}</div>
              ) : (
                <p>
                  Your monitored exam session is connected successfully. Keep your exam page open and continue your attempt.
                </p>
              )}
            </div>
          </div>
        ) : showScore ? (
          <div className="results-container">
            <div className="score-card">
              <h2>Exam Complete!</h2>
              <div className="final-score">
                <div className="score-circle">
                  <strong>{score}</strong>
                  <span>/{questions.length}</span>
                </div>
                <p>Questions Correct</p>
              </div>

              {summary && (
                <div className="summary-dashboard">
                  <div className="summary-chart-container">
                    <h3>Proctoring Results</h3>
                    {renderSummaryChart()}
                  </div>

                  <div className="metrics-grid">
                    <div className="metric-card">
                      <span>Duration</span>
                      <strong>{summary.total_duration.toFixed(1)} min</strong>
                    </div>
                    <div className="metric-card">
                      <span>Face Detection</span>
                      <strong>{summary.face_detection_rate.toFixed(1)}%</strong>
                    </div>
                  </div>

                  <div className="activity-log">
                    <h4>Suspicious Activity Log</h4>
                    <div className="activity-list">
                      {Object.entries(summary.suspicious_activities).map(([key, value]) => (
                        <div key={key} className="activity-item">
                          <span>{key.replace(/_/g, ' ')}</span>
                          <strong>{value}</strong>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="completion-actions">
                    <p>Thank you for completing the exam!</p>
                    <div className="action-buttons">
                      {!isLti && (
                        <button onClick={logout} className="return-btn">
                          End Exam and logout
                        </button>
                      )}
                      {isLti && (
                        <p className="lti-info">You can now close this tab and return to your LMS.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          questions.length > 0 ? (
            <div className="exam-stage">
              <section className="session-banner">
                <div className="session-banner-copy">
                  <span className="session-banner-kicker">Live Assessment Session</span>
                  <h2>{examMetadata?.title || 'Monitored Exam'}</h2>
                  <p>
                    Stay focused, keep your face visible, and respond to alerts immediately during the monitored attempt.
                  </p>
                </div>
                <div className="session-pill-grid">
                  <div className="session-pill">
                    <span>Monitoring</span>
                    <strong>{connectionUiHealthy ? 'Active' : 'Connecting'}</strong>
                  </div>
                  <div className="session-pill">
                    <span>Warnings</span>
                    <strong>{warningCount}</strong>
                  </div>
                  <div className="session-pill">
                    <span>Integrity</span>
                    <strong>{violationScore}%</strong>
                  </div>
                </div>
              </section>

              {delayedDelivery.active && (
                <div className="delayed-delivery-banner" role="status" aria-live="polite">
                  <strong>Delayed detection delivery</strong>
                  <span>
                    We received {delayedDelivery.count} older proctoring event{delayedDelivery.count === 1 ? '' : 's'} ({Math.round(delayedDelivery.maxAgeMs / 1000)}s late).
                    Your exam continues normally—please keep your network stable.
                  </span>
                </div>
              )}

              <div className="question-card">
                <div className="question-header">
                  <div className="question-header-meta">
                    <span className="question-number">Question {currentQuestion + 1}</span>
                    <div className="question-progress-chip">{progressLabel}</div>
                  </div>
                  <div className={`timer-display ${timeRemaining <= 300 ? 'timer-warning' : ''}`}>
                    Time Remaining: {formatTime(timeRemaining)}
                  </div>
                  <button
                    onClick={() => promptSubmitExamWithConfirmation()}
                    className="finish-exam-btn"
                  >
                    Submit Exam
                  </button>
                </div>

                <div className="progress-track" aria-hidden="true">
                  <div className="progress-track-fill" style={{ width: `${progressPercent}%` }} />
                </div>

                <div className="question-content">
                  <h3>{questions[currentQuestion].text}</h3>
                  {questions[currentQuestion].question_type === 'SUBJECTIVE' ||
                    questions[currentQuestion].question_type === 'SHORT_ANSWER' ? (
                    <div className="short-answer-container">
                      <textarea
                        value={shortAnswer}
                        onChange={(e) => setShortAnswer(e.target.value)}
                        placeholder="Type your answer here..."
                        className="short-answer-input"
                        rows={6}
                      />
                      <div className="short-answer-actions">
                        <button
                          onClick={() => handleAnswer(shortAnswer)}
                          className="submit-short-answer-btn"
                          disabled={!shortAnswer?.trim()}
                        >
                          {currentQuestion + 1 < questions.length ? 'Next Question' : 'Save Answer'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="options-grid">
                      {(() => {
                        // Look up the currently-recorded answer for this
                        // question so we can highlight it in the UI. Without
                        // this, clicking an option gives zero visual feedback
                        // on the final question (where the page doesn't
                        // auto-advance) — students think their click failed.
                        const currentQId = questions[currentQuestion]?.id;
                        const selectedForThisQuestion = currentQId !== undefined && currentQId !== null
                          ? buildAnswerMap(userAnswers)[String(currentQId)]
                          : undefined;
                        return (questions[currentQuestion].options || []).map((option, index) => {
                          const isSelected = option === selectedForThisQuestion;
                          return (
                            <button
                              key={`${option}-${index}`}
                              onClick={() => handleAnswer(option)}
                              className={`option-button${isSelected ? ' option-button--selected' : ''}`}
                              aria-pressed={isSelected}
                            >
                              {option}
                            </button>
                          );
                        });
                      })()}
                    </div>
                  )}

                </div>
              </div>
            </div>
          ) : (
            <div className="loading-questions">
              <p>Preparing your questions...</p>
            </div>
          )
        )}
      </main>
      {!isLti && <button onClick={handleLogout} className="logout-fixed">Logout</button>}
    </div>
    </div>
  );
};

export default Exam;
