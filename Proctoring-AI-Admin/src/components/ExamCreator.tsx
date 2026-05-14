import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { motion } from 'motion/react';
import {
  Check,
  Clock,
  Copy,
  FileText,
  Loader2,
  Lock,
  Mail,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import api from '../services/api';

type QuestionType = 'Multiple Choice' | 'True/False' | 'Short Answer';
type BannerTone = 'success' | 'error' | 'info';

interface Question {
  id: string;
  text: string;
  type: QuestionType;
  points: number;
  options: string[];
  correctAnswer: string;
}

interface AllowedQuestionType {
  value: string;
  label: string;
}

interface CreatorConfig {
  duration_minutes: { min: number; max: number; step: number; default: number };
  default_question_marks: number;
  default_access_buffer_minutes: number;
  max_questions_per_exam: number;
  default_exam_title_prefix: string;
  default_description: string | null;
  allowed_question_types: AllowedQuestionType[];
}

interface EligibleRosterImportResponse {
  file_name: string;
  emails: string[];
  count: number;
}

interface BannerState {
  tone: BannerTone;
  message: string;
}

interface PublishedExam {
  exam_id: number | null;
  title: string;
  exam_url: string;
  temporary_password: string | null;
  monitor_key: string | null;
  eligible_email_count: number;
  published_at: string;
}

const DEFAULT_CONFIG: CreatorConfig = {
  duration_minutes: { min: 15, max: 240, step: 15, default: 60 },
  default_question_marks: 1,
  default_access_buffer_minutes: 1,
  max_questions_per_exam: 200,
  default_exam_title_prefix: 'Exam',
  default_description: null,
  allowed_question_types: [
    { value: 'MCQ', label: 'Multiple Choice' },
    { value: 'TRUE_FALSE', label: 'True/False' },
    { value: 'SUBJECTIVE', label: 'Short Answer' },
  ],
};


const toLocalDateTime = (value: Date): string => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hour = String(value.getHours()).padStart(2, '0');
  const minute = String(value.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
};

const nowLocal = (): string => {
  const now = new Date();
  now.setSeconds(0, 0);
  return toLocalDateTime(now);
};

const parseLocal = (value: string): Date | null => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const addMinutes = (value: string, minutes: number): string => {
  const parsed = parseLocal(value);
  if (!parsed) return value;
  parsed.setMinutes(parsed.getMinutes() + minutes);
  return toLocalDateTime(parsed);
};

const makeQuestionId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const toneClass = (tone: BannerTone): string => {
  if (tone === 'success') return 'border-green-300 bg-green-50 text-green-800';
  if (tone === 'error') return 'border-red-300 bg-red-50 text-red-800';
  return 'border-cyan-300 bg-cyan-50 text-cyan-800';
};

const parseQuestionType = (value: unknown): QuestionType => {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('true') || raw.includes('false') || raw.includes('boolean')) return 'True/False';
  if (raw.includes('subjective') || raw.includes('short')) return 'Short Answer';
  return 'Multiple Choice';
};

const parseCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
};

const mapAllowedType = (item: AllowedQuestionType): QuestionType => {
  if (item.value.toUpperCase() === 'TRUE_FALSE') return 'True/False';
  if (item.value.toUpperCase() === 'SUBJECTIVE') return 'Short Answer';
  return 'Multiple Choice';
};

export function ExamCreator() {
  const initialStart = useMemo(() => addMinutes(nowLocal(), DEFAULT_CONFIG.default_access_buffer_minutes), []);
  const initialEnd = useMemo(() => addMinutes(initialStart, DEFAULT_CONFIG.duration_minutes.default), [initialStart]);
  const timezoneLabel = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local timezone', []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rosterInputRef = useRef<HTMLInputElement | null>(null);

  const [config, setConfig] = useState<CreatorConfig>(DEFAULT_CONFIG);
  const [configLoading, setConfigLoading] = useState(true);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [activeTab, setActiveTab] = useState<'manual' | 'bulk'>('manual');
  const [isDragging, setIsDragging] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const scheduleTouchedRef = useRef(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [duration, setDuration] = useState(DEFAULT_CONFIG.duration_minutes.default);
  const [startTime, setStartTime] = useState(initialStart);
  const [endTime, setEndTime] = useState(initialEnd);
  const [singleUse, setSingleUse] = useState(false);
  // Lenient mode: when on, the per-exam config tells the backend policy
  // engine to skip strike accumulation / termination for environmental
  // detections (multiple_people, prohibited_object, phone_detected) that
  // commonly produce false positives in college-hall settings. The events
  // themselves are still recorded so the admin can review them.
  const [lenientMode, setLenientMode] = useState(false);
  const [currentTime, setCurrentTime] = useState(nowLocal());
  const [questions, setQuestions] = useState<Question[]>([]);
  const [publishedLink, setPublishedLink] = useState<string | null>(null);
  const [publishedExamId, setPublishedExamId] = useState<number | null>(null);
  const [publishedTempPassword, setPublishedTempPassword] = useState<string | null>(null);
  const [publishedMonitorKey, setPublishedMonitorKey] = useState<string | null>(null);
  const [publishedEligibleEmailCount, setPublishedEligibleEmailCount] = useState(0);
  const [publishedExams, setPublishedExams] = useState<PublishedExam[]>([]);
  const [eligibleEmails, setEligibleEmails] = useState<string[]>([]);
  const [rosterFileName, setRosterFileName] = useState<string | null>(null);
  const [isImportingRoster, setIsImportingRoster] = useState(false);



  const allowedTypes = useMemo<QuestionType[]>(() => {
    const mapped = config.allowed_question_types.map(mapAllowedType);
    return mapped.length > 0 ? mapped : ['Multiple Choice', 'True/False', 'Short Answer'];
  }, [config.allowed_question_types]);

  const totalMarks = useMemo(() => questions.reduce((sum, q) => sum + q.points, 0), [questions]);
  const parsedStart = parseLocal(startTime);
  const parsedEnd = parseLocal(endTime);
  const windowValid = Boolean(parsedStart && parsedEnd && parsedEnd > parsedStart);
  const windowMinutes = windowValid ? Math.floor((parsedEnd!.getTime() - parsedStart!.getTime()) / 60000) : 0;

  const fetchConfig = useCallback(async () => {
    try {
      const response = await api.get('exam/admin/exam-creator/config');
      const raw = response.data as Partial<CreatorConfig>;
      const allowedTypes = Array.isArray(raw.allowed_question_types)
        ? raw.allowed_question_types
          .filter((item): item is AllowedQuestionType => Boolean(item && typeof item === 'object'))
          .map((item) => ({
            value: String(item.value || 'MCQ').toUpperCase(),
            label: String(item.label || 'Multiple Choice'),
          }))
          .filter((item) => ['MCQ', 'TRUE_FALSE', 'SUBJECTIVE'].includes(item.value))
        : [];
      const next: CreatorConfig = {
        duration_minutes: {
          min: Math.max(1, Number(raw.duration_minutes?.min ?? DEFAULT_CONFIG.duration_minutes.min)),
          max: Math.max(1, Number(raw.duration_minutes?.max ?? DEFAULT_CONFIG.duration_minutes.max)),
          step: Math.max(1, Number(raw.duration_minutes?.step ?? DEFAULT_CONFIG.duration_minutes.step)),
          default: Math.max(1, Number(raw.duration_minutes?.default ?? DEFAULT_CONFIG.duration_minutes.default)),
        },
        default_question_marks: Math.max(0.1, Number(raw.default_question_marks ?? DEFAULT_CONFIG.default_question_marks)),
        default_access_buffer_minutes: Math.max(0, Number(raw.default_access_buffer_minutes ?? DEFAULT_CONFIG.default_access_buffer_minutes)),
        max_questions_per_exam: Math.max(1, Number(raw.max_questions_per_exam ?? DEFAULT_CONFIG.max_questions_per_exam)),
        default_exam_title_prefix: String(raw.default_exam_title_prefix ?? DEFAULT_CONFIG.default_exam_title_prefix),
        default_description: raw.default_description ?? null,
        allowed_question_types: allowedTypes.length > 0 ? allowedTypes : DEFAULT_CONFIG.allowed_question_types,
      };
      if (next.duration_minutes.default > next.duration_minutes.max) next.duration_minutes.default = next.duration_minutes.max;
      if (next.duration_minutes.default < next.duration_minutes.min) next.duration_minutes.default = next.duration_minutes.min;
      setConfig(next);
      setDuration((curr) => Math.min(next.duration_minutes.max, Math.max(next.duration_minutes.min, curr)));
      setDescription((curr) => curr || next.default_description || '');
      if (!scheduleTouchedRef.current) {
        const nextStart = addMinutes(nowLocal(), next.default_access_buffer_minutes);
        setStartTime(nextStart);
        setEndTime(addMinutes(nextStart, next.duration_minutes.default));
        setDuration(next.duration_minutes.default);
      }
    } catch {
      setBanner({
        tone: 'info',
        message: 'Using fallback exam creator defaults because server config is unavailable.',
      });
    } finally {
      setConfigLoading(false);
    }
  }, []);


  useEffect(() => {
    void fetchConfig();
    const timer = window.setInterval(() => setCurrentTime(nowLocal()), 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [fetchConfig]);

  const addQuestion = () => {
    if (questions.length >= config.max_questions_per_exam) {
      setBanner({
        tone: 'error',
        message: `Question limit reached. Maximum ${config.max_questions_per_exam} questions are allowed.`,
      });
      return;
    }
    const nextType = allowedTypes[0] || 'Multiple Choice';
    const nextQuestion: Question = {
      id: makeQuestionId(),
      text: '',
      type: nextType,
      points: config.default_question_marks,
      options: nextType === 'Multiple Choice' ? ['', '', '', ''] : nextType === 'True/False' ? ['True', 'False'] : [],
      correctAnswer: '',
    };
    setQuestions((curr) => [
      ...curr,
      nextQuestion,
    ]);
  };

  const updateQuestion = (id: string, updater: (current: Question) => Question) => {
    setQuestions((curr) => curr.map((question) => (question.id === id ? updater(question) : question)));
  };

  const updateQuestionType = (id: string, type: QuestionType) => {
    updateQuestion(id, (question) => ({
      ...question,
      type,
      options: type === 'Multiple Choice' ? (question.options.length > 0 ? question.options.slice(0, 4) : ['', '', '', '']) : type === 'True/False' ? ['True', 'False'] : [],
      correctAnswer: type === 'True/False'
        ? (question.correctAnswer === 'True' || question.correctAnswer === 'False' ? question.correctAnswer : '')
        : question.correctAnswer,
    }));
  };

  const importFromFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.json') && !lower.endsWith('.csv')) {
      setBanner({ tone: 'error', message: 'Unsupported file type. Please upload JSON or CSV.' });
      return;
    }

    try {
      const text = await file.text();
      let parsed: Question[] = [];

      if (lower.endsWith('.json')) {
        const data = JSON.parse(text) as unknown;
        const source = Array.isArray(data)
          ? data
          : (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).questions)
            ? (data as Record<string, unknown>).questions as unknown[]
            : []);
        parsed = source
          .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'))
          .map((entry) => {
            const type = parseQuestionType(entry.type || entry.question_type);
            return {
              id: makeQuestionId(),
              text: String(entry.text || entry.question || '').trim(),
              type,
              points: Math.max(0.1, Number(entry.marks ?? entry.points ?? config.default_question_marks)),
              options: type === 'Multiple Choice'
                ? (Array.isArray(entry.options) ? entry.options.map((opt) => String(opt || '')) : ['', '', '', '']).slice(0, 4)
                : type === 'True/False'
                  ? ['True', 'False']
                  : [],
              correctAnswer: String(entry.correct_option || entry.correctAnswer || '').trim(),
            } satisfies Question;
          })
          .filter((question) => question.text.length > 0);
      } else {
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const rows = lines.map(parseCsvLine);
        const hasHeader = rows[0]?.some((cell) => ['text', 'question', 'type'].includes(cell.toLowerCase())) ?? false;
        const offset = hasHeader ? 1 : 0;

        parsed = rows.slice(offset).map((cells) => {
          const type = parseQuestionType(cells[1] ?? 'MCQ');
          return {
            id: makeQuestionId(),
            text: String(cells[0] || '').trim(),
            type,
            points: Math.max(0.1, Number(cells[7] || config.default_question_marks)),
            options: type === 'Multiple Choice' ? [cells[2] || '', cells[3] || '', cells[4] || '', cells[5] || ''] : type === 'True/False' ? ['True', 'False'] : [],
            correctAnswer: String(cells[6] || '').trim(),
          };
        }).filter((question) => question.text.length > 0);
      }

      if (parsed.length === 0) {
        setBanner({ tone: 'error', message: 'No valid questions were found in the uploaded file.' });
        return;
      }

      setQuestions((curr) => {
        const room = Math.max(0, config.max_questions_per_exam - curr.length);
        return [...curr, ...parsed.slice(0, room)];
      });
      setActiveTab('manual');
      setBanner({ tone: 'success', message: `Imported ${parsed.length} question(s) from ${file.name}.` });
    } catch {
      setBanner({ tone: 'error', message: 'Could not parse file. Please verify format and try again.' });
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void importFromFile(file);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void importFromFile(file);
  };

  const importEligibleRoster = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.xlsx')) {
      setBanner({ tone: 'error', message: 'Unsupported roster format. Please upload a CSV or XLSX file.' });
      return;
    }

    setIsImportingRoster(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await api.post<EligibleRosterImportResponse>('exam/admin/exam/eligible-emails/import', formData);
      const emails = Array.isArray(response.data?.emails)
        ? response.data.emails.map((value) => String(value).trim()).filter(Boolean)
        : [];

      if (emails.length === 0) {
        setBanner({ tone: 'error', message: 'No valid student email IDs were found in the uploaded roster.' });
        return;
      }

      setEligibleEmails(emails);
      setRosterFileName(response.data?.file_name || file.name);
      setBanner({
        tone: 'success',
        message: `Imported ${emails.length} eligible student email ID(s) from ${response.data?.file_name || file.name}.`,
      });
    } catch (error: unknown) {
      const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setBanner({ tone: 'error', message: detail || 'Failed to import eligible student email IDs.' });
    } finally {
      setIsImportingRoster(false);
    }
  };

  const handleRosterFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void importEligibleRoster(file);
    event.target.value = '';
  };

  const clearEligibleRoster = () => {
    setEligibleEmails([]);
    setRosterFileName(null);
    setBanner({ tone: 'info', message: 'Eligible student roster cleared. The exam will be open to any signed-in student.' });
  };

  const validatePayload = (): string | null => {
    if (!title.trim()) return 'Exam title is required.';
    if (!startTime || !endTime) return 'Start and end time are required.';
    if (!parsedStart || !parsedEnd || parsedEnd <= parsedStart) return 'Access window is invalid.';
    if (duration < config.duration_minutes.min || duration > config.duration_minutes.max) {
      return `Duration must be between ${config.duration_minutes.min} and ${config.duration_minutes.max} minutes.`;
    }
    if (duration > windowMinutes) return 'Exam duration cannot exceed access window length.';
    if (questions.length === 0) return 'Add at least one question.';

    for (let i = 0; i < questions.length; i += 1) {
      const question = questions[i];
      const qNo = i + 1;
      if (!question.text.trim()) return `Question ${qNo} is empty.`;
      if (!Number.isFinite(question.points) || question.points <= 0) return `Question ${qNo} has invalid marks.`;
      if (question.type === 'Multiple Choice') {
        const options = question.options.map((item) => item.trim()).filter(Boolean);
        if (options.length < 2) return `Question ${qNo} needs at least 2 options.`;
        if (!options.includes(question.correctAnswer.trim())) return `Question ${qNo} has invalid correct answer.`;
      }
      if (question.type === 'True/False' && !['True', 'False'].includes(question.correctAnswer.trim())) {
        return `Question ${qNo} must set answer as True or False.`;
      }
      if (question.type === 'Short Answer' && !question.correctAnswer.trim()) {
        return `Question ${qNo} requires an expected answer.`;
      }
    }
    return null;
  };

  const publishExam = async () => {
    setBanner(null);
    const validation = validatePayload();
    if (validation) {
      setBanner({ tone: 'error', message: validation });
      return;
    }

    setIsPublishing(true);
    try {
      setPublishedTempPassword(null);
      setPublishedMonitorKey(null);
      setPublishedEligibleEmailCount(0);
      const payload = {
        title: title.trim(),
        description: description.trim() || undefined,
        start_time: parsedStart!.toISOString(),
        end_time: parsedEnd!.toISOString(),
        duration_minutes: duration,
        is_active: true,
        eligible_emails: eligibleEmails.length > 0 ? eligibleEmails : undefined,
        config: {
          single_use: singleUse,
          lenient_mode: lenientMode,
        },
        questions: questions.map((question) => {
          const marks = Number(question.points.toFixed(2));
          if (question.type === 'Multiple Choice') {
            return {
              text: question.text.trim(),
              question_type: 'MCQ',
              options: question.options.map((item) => item.trim()).filter(Boolean),
              correct_option: question.correctAnswer.trim(),
              marks,
            };
          }
          if (question.type === 'True/False') {
            return {
              text: question.text.trim(),
              question_type: 'MCQ',
              options: ['True', 'False'],
              correct_option: question.correctAnswer.trim() === 'True' ? 'True' : 'False',
              marks,
            };
          }
          return {
            text: question.text.trim(),
            question_type: 'SUBJECTIVE',
            options: null,
            correct_option: question.correctAnswer.trim(),
            marks,
          };
        }),
      };

      const response = await api.post('exam/admin/exam', payload);
      const examUrl = String(response.data?.exam_url || '');
      const examId = Number(response.data?.exam_id) || null;
      const tempPassword = response.data?.temporary_password || null;
      const monitorKey = response.data?.monitor_key || null;
      const eligibleCount = Number(response.data?.eligible_email_count) || 0;
      setPublishedLink(examUrl || null);
      setPublishedExamId(examId);
      setPublishedTempPassword(tempPassword);
      setPublishedMonitorKey(monitorKey);
      setPublishedEligibleEmailCount(eligibleCount);
      setPublishedExams((curr) => [
        {
          exam_id: examId,
          title: title.trim(),
          exam_url: examUrl,
          temporary_password: tempPassword,
          monitor_key: monitorKey,
          eligible_email_count: eligibleCount,
          published_at: new Date().toISOString(),
        },
        ...curr,
      ]);
      setBanner({
        tone: 'success',
        message: eligibleEmails.length > 0
          ? 'Exam published and eligible accounts prepared. Click “Create another exam” to publish the next one.'
          : 'Exam published successfully. Click “Create another exam” to publish the next one.',
      });

    } catch (error: unknown) {
      const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setBanner({ tone: 'error', message: detail || 'Failed to publish exam.' });
    } finally {
      setIsPublishing(false);
    }
  };

  const resetForNewExam = () => {
    setTitle('');
    setDescription(config.default_description ?? '');
    setDuration(config.duration_minutes.default);
    scheduleTouchedRef.current = false;
    const nextStart = addMinutes(nowLocal(), config.default_access_buffer_minutes);
    setStartTime(nextStart);
    setEndTime(addMinutes(nextStart, config.duration_minutes.default));
    setSingleUse(false);
    setLenientMode(false);
    setQuestions([]);
    setEligibleEmails([]);
    setRosterFileName(null);
    setActiveTab('manual');
    setPublishedLink(null);
    setPublishedExamId(null);
    setPublishedTempPassword(null);
    setPublishedMonitorKey(null);
    setPublishedEligibleEmailCount(0);
    setBanner({ tone: 'info', message: 'Form cleared. Configure the next exam.' });
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const copyValue = async (value: string | null, successMessage: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setBanner({ tone: 'success', message: successMessage });
    } catch {
      setBanner({ tone: 'error', message: 'Could not copy to clipboard.' });
    }
  };

  const copyPublishedLink = async () => {
    await copyValue(publishedLink, 'Exam link copied to clipboard.');
  };

  const copyPublishedTempPassword = async () => {
    await copyValue(publishedTempPassword, 'Temporary password copied to clipboard.');
  };

  const copyMonitorKey = async () => {
    await copyValue(publishedMonitorKey, 'Monitor key copied to clipboard.');
  };

  return (
    <div className="min-h-screen bg-white">
      <div className="mx-auto max-w-7xl">
        {banner && (
          <div className={`mb-6 rounded-lg border px-4 py-3 text-sm ${toneClass(banner.tone)}`}>
            {banner.message}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left half: inner 2-col grid — Exam Config | Access Window */}
          <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }} className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
                  <FileText className="h-5 w-5 text-cyan-600" />
                  Exam Configuration
                </h2>
                {configLoading && <Loader2 className="h-4 w-4 animate-spin text-cyan-600" />}
              </div>

              <div className="space-y-5">
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Exam Title</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={`${config.default_exam_title_prefix} - Final Assessment`}
                    className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Description (Optional)</label>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-slate-900 placeholder-slate-400 focus:border-cyan-500 focus:outline-none"
                    placeholder="Instructions for students..."
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="text-sm font-medium text-slate-700">Duration (minutes)</label>
                    <span className="text-sm font-semibold text-cyan-600">{duration} min</span>
                  </div>
                  <input
                    type="range"
                    min={config.duration_minutes.min}
                    max={config.duration_minutes.max}
                    step={config.duration_minutes.step}
                    value={duration}
                    onChange={(event) => {
                      scheduleTouchedRef.current = true;
                      setDuration(Number(event.target.value));
                    }}
                    className="w-full accent-cyan-600"
                  />
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="singleUse"
                    checked={singleUse}
                    onChange={(event) => setSingleUse(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
                  />
                  <label htmlFor="singleUse" className="flex items-center gap-2 text-sm text-slate-900">
                    <Lock className="h-4 w-4 text-cyan-600" />
                    Single-use links
                  </label>
                </div>

                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      id="lenientMode"
                      checked={lenientMode}
                      onChange={(event) => setLenientMode(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                    />
                    <label htmlFor="lenientMode" className="flex flex-col gap-1 text-sm text-slate-900">
                      <span className="flex items-center gap-2 font-medium">
                        <ShieldCheck className="h-4 w-4 text-amber-600" />
                        Lenient mode (offline / college-hall exam)
                      </span>
                      <span className="text-xs text-slate-600">
                        Treat <strong>multiple people</strong>, <strong>laptop / book / keyboard</strong> and <strong>phone</strong> detections as warnings only. They will still appear in the admin timeline, but they will <em>not</em> terminate the exam or count toward strikes. Use this when students are taking the test in a shared room where other people and devices are naturally visible.
                      </span>
                    </label>
                  </div>
                </div>

                <div className={`rounded-xl border-2 transition-all duration-200 ${
                  eligibleEmails.length > 0
                    ? 'border-emerald-200 bg-emerald-50/40'
                    : 'border-dashed border-slate-200 bg-slate-50/50'
                } p-4`}>

                  {/* Hidden file input – never renders text */}
                  <input
                    ref={rosterInputRef}
                    type="file"
                    accept=".csv,.xlsx"
                    onChange={handleRosterFileChange}
                    style={{ display: 'none' }}
                  />

                  {eligibleEmails.length > 0 ? (
                    /* ── LOADED STATE ── */
                    <>
                      {/* Header row */}
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                          {/* Count badge */}
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-sm font-bold text-white shadow-sm">
                            {eligibleEmails.length}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-slate-900">
                              {eligibleEmails.length} student{eligibleEmails.length !== 1 ? 's' : ''} on roster
                            </p>
                            <p className="flex items-center gap-1 text-xs text-slate-500">
                              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                              {rosterFileName || 'Roster imported'} · Restricted access active
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isImportingRoster && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
                          <button
                            type="button"
                            onClick={() => rosterInputRef.current?.click()}
                            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-cyan-400 hover:text-cyan-700"
                          >
                            Change
                          </button>
                          <button
                            type="button"
                            onClick={clearEligibleRoster}
                            className="rounded-lg border border-red-100 bg-white px-3 py-1.5 text-xs font-medium text-red-500 transition hover:bg-red-50"
                          >
                            Remove
                          </button>
                        </div>
                      </div>

                      {/* Scrollable email list */}
                      <div className="max-h-36 overflow-y-auto rounded-lg border border-emerald-100 bg-white p-2">
                        <div className="flex flex-wrap gap-1.5">
                          {eligibleEmails.map((email) => {
                            const initials = email.split('@')[0].slice(0, 2).toUpperCase();
                            const colors = [
                              'bg-violet-100 text-violet-700',
                              'bg-cyan-100 text-cyan-700',
                              'bg-amber-100 text-amber-700',
                              'bg-pink-100 text-pink-700',
                              'bg-lime-100 text-lime-700',
                              'bg-sky-100 text-sky-700',
                            ];
                            const color = colors[email.charCodeAt(0) % colors.length];
                            return (
                              <span
                                key={email}
                                title={email}
                                className="inline-flex items-center gap-1.5 rounded-full border border-slate-100 bg-slate-50 py-1 pl-1 pr-3 text-xs text-slate-700 transition hover:border-slate-200 hover:bg-white"
                              >
                                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${color}`}>
                                  {initials}
                                </span>
                                <span className="max-w-[140px] truncate">{email}</span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  ) : (
                    /* ── EMPTY STATE ── */
                    <div className="flex flex-col items-center gap-3 py-2 text-center">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100">
                        <Mail className="h-5 w-5 text-slate-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-700">Eligible Student Email IDs</p>
                        <p className="mt-1 text-xs text-slate-500 max-w-[260px]">
                          Upload a CSV or Excel roster to restrict this exam to specific students.
                          They'll receive a shared temporary password on publish.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => rosterInputRef.current?.click()}
                        disabled={isImportingRoster}
                        className="mt-1 inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-cyan-700 disabled:opacity-60"
                      >
                        {isImportingRoster
                          ? <><Loader2 className="h-4 w-4 animate-spin" /> Importing…</>
                          : <><Upload className="h-4 w-4" /> Upload Roster (.csv / .xlsx)</>}
                      </button>
                      <p className="text-xs text-slate-400">
                        Leave empty to allow any signed-in student to join.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Access Window — right side of left half */}
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
              <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-900">
                <Clock className="h-5 w-5 text-purple-600" />
                Access Window
              </h3>
              <div className="space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Start Time</label>
                  <input
                    type="datetime-local"
                    value={startTime}
                    min={currentTime}
                    onChange={(event) => {
                      scheduleTouchedRef.current = true;
                      setStartTime(event.target.value);
                    }}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-purple-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">End Time</label>
                  <input
                    type="datetime-local"
                    value={endTime}
                    min={startTime || currentTime}
                    onChange={(event) => {
                      scheduleTouchedRef.current = true;
                      setEndTime(event.target.value);
                    }}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-purple-500 focus:outline-none"
                  />
                </div>
              </div>
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <p>Current local time: {currentTime.replace('T', ' ')} ({timezoneLabel})</p>
                <p className="mt-1">Window length: {windowValid ? `${windowMinutes} min` : 'Invalid'} | Duration: {duration} min</p>
              </div>
            </div>
          </motion.div>

          {/* Right half — Questions & Publish */}
          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 }} className="space-y-6">
            <div className="rounded-xl border border-slate-200 bg-white shadow-lg">
              <div className="border-b border-slate-200 p-6 pb-0">
                <h2 className="mb-4 text-xl font-semibold text-slate-900">Questions & Content</h2>
                <div className="flex gap-2">
                  <button onClick={() => setActiveTab('manual')} className={`rounded-t-lg px-6 py-3 text-sm font-medium ${activeTab === 'manual' ? 'bg-slate-50 text-slate-900' : 'text-slate-500'}`}>Manual Entry</button>
                  <button onClick={() => setActiveTab('bulk')} className={`rounded-t-lg px-6 py-3 text-sm font-medium ${activeTab === 'bulk' ? 'bg-slate-50 text-slate-900' : 'text-slate-500'}`}>Bulk Upload</button>
                </div>
              </div>

              <div className="p-6">
                {activeTab === 'bulk' ? (
                  <div
                    onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    className={`flex min-h-[280px] flex-col items-center justify-center rounded-xl border-2 border-dashed ${isDragging ? 'border-cyan-500 bg-cyan-50' : 'border-slate-300 bg-slate-50'}`}
                  >
                    <Upload className="mb-4 h-12 w-12 text-slate-400" />
                    <p className="mb-2 text-lg font-medium text-slate-900">Drag and drop file here</p>
                    <p className="mb-4 text-sm text-slate-500">JSON or CSV</p>
                    <input ref={fileInputRef} type="file" accept=".json,.csv" onChange={handleFileChange} className="hidden" />
                    <button onClick={() => fileInputRef.current?.click()} className="rounded-lg border border-cyan-600 bg-cyan-50 px-6 py-2 text-sm font-medium text-cyan-600 hover:bg-cyan-100">
                      Browse Files
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <button onClick={addQuestion} className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 py-3 text-sm font-medium text-cyan-600 hover:border-cyan-500 hover:bg-cyan-50">
                      <Plus className="h-4 w-4" />
                      Add New Question
                    </button>

                    <div className="max-h-[460px] space-y-3 overflow-y-auto pr-2">
                      {questions.map((question, index) => (
                        <div key={question.id} className="rounded-lg border border-slate-200 bg-white p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <p className="text-sm font-semibold text-slate-900">Question {index + 1}</p>
                            <button onClick={() => setQuestions((curr) => curr.filter((item) => item.id !== question.id))}>
                              <Trash2 className="h-4 w-4 text-red-500 hover:text-red-600" />
                            </button>
                          </div>
                          <input
                            type="text"
                            value={question.text}
                            onChange={(event) => updateQuestion(question.id, (curr) => ({ ...curr, text: event.target.value }))}
                            placeholder="Type your question"
                            className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-cyan-500 focus:outline-none"
                          />

                          <div className="mb-3 flex items-center gap-2">
                            <select
                              value={question.type}
                              onChange={(event) => updateQuestionType(question.id, event.target.value as QuestionType)}
                              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:border-cyan-500 focus:outline-none"
                            >
                              {allowedTypes.map((type) => <option key={type}>{type}</option>)}
                            </select>
                            <input
                              type="number"
                              value={question.points}
                              min="0.1"
                              step="0.1"
                              onChange={(event) => updateQuestion(question.id, (curr) => ({ ...curr, points: Math.max(0.1, Number(event.target.value) || 0.1) }))}
                              className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-xs focus:border-cyan-500 focus:outline-none"
                            />
                            <span className="text-xs text-slate-600">marks</span>
                          </div>

                          {question.type === 'Multiple Choice' && (
                            <div className="grid grid-cols-2 gap-2">
                              {[0, 1, 2, 3].map((optIdx) => (
                                <div key={optIdx} className="flex items-center gap-2">
                                  <input
                                    type="radio"
                                    checked={question.correctAnswer === question.options[optIdx]}
                                    onChange={() => updateQuestion(question.id, (curr) => ({ ...curr, correctAnswer: curr.options[optIdx] || '' }))}
                                    className="h-4 w-4"
                                  />
                                  <input
                                    type="text"
                                    value={question.options[optIdx] || ''}
                                    onChange={(event) => updateQuestion(question.id, (curr) => {
                                      const nextOptions = [...curr.options];
                                      nextOptions[optIdx] = event.target.value;
                                      return { ...curr, options: nextOptions };
                                    })}
                                    placeholder={`Option ${optIdx + 1}`}
                                    className="flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:border-cyan-500 focus:outline-none"
                                  />
                                </div>
                              ))}
                            </div>
                          )}

                          {question.type === 'True/False' && (
                            <div className="flex gap-4">
                              {['True', 'False'].map((value) => (
                                <label key={value} className="flex items-center gap-2 text-xs">
                                  <input
                                    type="radio"
                                    checked={question.correctAnswer === value}
                                    onChange={() => updateQuestion(question.id, (curr) => ({ ...curr, correctAnswer: value }))}
                                    className="h-4 w-4"
                                  />
                                  {value}
                                </label>
                              ))}
                            </div>
                          )}

                          {question.type === 'Short Answer' && (
                            <input
                              type="text"
                              value={question.correctAnswer}
                              onChange={(event) => updateQuestion(question.id, (curr) => ({ ...curr, correctAnswer: event.target.value }))}
                              placeholder="Expected answer"
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-cyan-500 focus:outline-none"
                            />
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-center text-sm text-slate-600">
                      Total Questions: <span className="font-semibold text-slate-900">{questions.length}</span>
                      {' • '}
                      Total Marks: <span className="font-semibold text-slate-900">{Number(totalMarks.toFixed(2))}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </div>

        {publishedLink && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mt-8 rounded-xl border border-cyan-200 bg-cyan-50 p-6 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-cyan-900">Exam Published Successfully</h3>
                <p className="mt-1 text-sm text-cyan-700">
                  {publishedExamId ? `Exam ID ${publishedExamId}` : 'Share this link with students.'}
                  {publishedEligibleEmailCount > 0 ? ` ${publishedEligibleEmailCount} eligible student account(s) were prepared.` : ''}
                </p>
              </div>
              <Check className="h-8 w-8 text-cyan-600" />
            </div>
            <div className="mt-4 flex items-center gap-2">
              <input type="text" readOnly value={publishedLink} className="flex-1 rounded-lg border border-cyan-300 bg-white px-4 py-2 text-sm text-slate-900" />
              <button onClick={() => void copyPublishedLink()} className="rounded-lg bg-cyan-600 px-6 py-2 text-sm font-medium text-white hover:bg-cyan-700">
                <span className="inline-flex items-center gap-2">
                  <Copy className="h-4 w-4" />
                  Copy Link
                </span>
              </button>
            </div>
            {publishedTempPassword && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-900">Shared Temporary Password</p>
                <p className="mt-1 text-xs text-amber-700">
                  Students on the uploaded roster must use this temporary password only to reset their password first.
                  It will not allow direct login.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={publishedTempPassword}
                    className="flex-1 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900"
                  />
                  <button
                    onClick={() => void copyPublishedTempPassword()}
                    className="rounded-lg bg-amber-600 px-6 py-2 text-sm font-medium text-white hover:bg-amber-700"
                  >
                    <span className="inline-flex items-center gap-2">
                      <Copy className="h-4 w-4" />
                      Copy Password
                    </span>
                  </button>
                </div>
              </div>
            )}
            {publishedMonitorKey && (
              <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-violet-900">🔐 Monitor Room Key</p>
                    <p className="mt-1 text-xs text-violet-700">
                      Share this key only with proctors. Required to enter the Live Monitor room for this exam.
                      It is also shown on each exam card in the Live Monitor lobby.
                    </p>
                  </div>
                  <Lock className="h-5 w-5 text-violet-500 flex-shrink-0 mt-0.5" />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={publishedMonitorKey}
                    className="flex-1 rounded-lg border border-violet-300 bg-white px-4 py-2 text-base font-black tracking-[0.25em] text-violet-900"
                    style={{ fontFamily: 'ui-monospace, monospace' }}
                  />
                  <button
                    onClick={() => void copyMonitorKey()}
                    className="rounded-lg bg-violet-600 px-6 py-2 text-sm font-medium text-white hover:bg-violet-700"
                  >
                    <span className="inline-flex items-center gap-2">
                      <Copy className="h-4 w-4" />
                      Copy Key
                    </span>
                  </button>
                </div>
              </div>
            )}
            <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={resetForNewExam}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan-600 bg-white px-6 py-2.5 text-sm font-semibold text-cyan-700 transition hover:bg-cyan-50"
              >
                <Plus className="h-4 w-4" />
                Create another exam
              </button>
            </div>
          </motion.div>
        )}

        {publishedExams.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-lg"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Published exams (this session)</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Every exam you published in this browser session. The list clears on page refresh.
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                {publishedExams.length} total
              </span>
            </div>
            <div className="space-y-3">
              {publishedExams.map((exam, index) => (
                <div
                  key={`${exam.exam_id ?? 'exam'}-${index}-${exam.published_at}`}
                  className="rounded-lg border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">
                        {exam.title || 'Untitled exam'}
                      </p>
                      <p className="text-xs text-slate-500">
                        {exam.exam_id ? `ID ${exam.exam_id} \u2022 ` : ''}
                        Published {new Date(exam.published_at).toLocaleString()}
                        {exam.eligible_email_count > 0 ? ` \u2022 ${exam.eligible_email_count} eligible students` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={exam.exam_url}
                        className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700"
                      />
                      <button
                        type="button"
                        onClick={() => void copyValue(exam.exam_url, 'Exam link copied to clipboard.')}
                        className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <Copy className="h-3.5 w-3.5" />
                          Link
                        </span>
                      </button>
                    </div>
                    {exam.temporary_password && (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          readOnly
                          value={exam.temporary_password}
                          className="flex-1 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-900"
                        />
                        <button
                          type="button"
                          onClick={() => void copyValue(exam.temporary_password, 'Temporary password copied to clipboard.')}
                          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <Copy className="h-3.5 w-3.5" />
                            Password
                          </span>
                        </button>
                      </div>
                    )}
                    {exam.monitor_key && (
                      <div className="flex items-center gap-2 sm:col-span-2">
                        <input
                          type="text"
                          readOnly
                          value={exam.monitor_key}
                          className="flex-1 rounded-lg border border-violet-300 bg-white px-3 py-1.5 text-xs font-black tracking-[0.2em] text-violet-900"
                          style={{ fontFamily: 'ui-monospace, monospace' }}
                        />
                        <button
                          type="button"
                          onClick={() => void copyValue(exam.monitor_key, 'Monitor key copied to clipboard.')}
                          className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <Copy className="h-3.5 w-3.5" />
                            Monitor key
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
          <motion.button
            onClick={() => void publishExam()}
            whileHover={{ scale: isPublishing ? 1 : 1.02 }}
            whileTap={{ scale: isPublishing ? 1 : 0.98 }}
            disabled={isPublishing}
            className={`flex w-full items-center justify-center gap-2 rounded-lg px-8 py-3 font-semibold text-white ${
              isPublishing ? 'cursor-not-allowed bg-slate-400' : 'bg-gradient-to-r from-cyan-600 to-blue-600'
            }`}
          >
            {isPublishing ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Publishing...
              </>
            ) : (
              <>
                <Send className="h-5 w-5" />
                Publish and Generate Link
              </>
            )}
          </motion.button>
        </div>
      </div>
    </div>
  );
}
