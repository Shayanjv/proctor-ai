const API_URL = import.meta.env.VITE_API_URL;
const BASE_URL = `${API_URL}/api/v1/exam`;
const WS_URL = import.meta.env.VITE_WS_URL;
import { authService } from './authService';
import { toTimestampMs } from '../utils/timeUtils';
import { networkEvents } from './networkEventBus';

// ─────────────────────────────────────────────────────────────────────────────
// Network-resilience helpers
//
// On flaky / slow connections the original fetch() calls below would block
// indefinitely — that is why the exam screen sometimes sits on
// "Preparing your questions…" and the submit screen "buffers" forever after
// finishing an exam. We wrap the critical calls with an explicit timeout +
// AbortController so the FE surfaces an actionable error instead of hanging.
// ─────────────────────────────────────────────────────────────────────────────

class NetworkTimeoutError extends Error {
    constructor(url, timeoutMs) {
        super(`Network timeout after ${timeoutMs}ms — please check your connection and retry.`);
        this.name = 'NetworkTimeoutError';
        this.code = 'NETWORK_TIMEOUT';
        this.url = url;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * fetch() wrapper that aborts after `timeoutMs` and converts the abort into a
 * descriptive NetworkTimeoutError. Behaviour is otherwise identical to fetch
 * (status codes are NOT inspected here — callers handle response.ok).
 */
const fetchWithTimeout = async (url, options = {}, timeoutMs = 25000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return response;
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new NetworkTimeoutError(url, timeoutMs);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
};

/**
 * fetchWithTimeout + a single automatic retry on transient timeout/network
 * errors. Used for idempotent reads (exam details, summary). NOT used for
 * non-idempotent writes by default — submit handles its own retry policy.
 */
const fetchWithTimeoutAndRetry = async (url, options = {}, timeoutMs = 25000, retryCount = 1) => {
    let lastErr = null;
    let emittedSlow = false;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const response = await fetchWithTimeout(url, options, timeoutMs);
            if (emittedSlow) networkEvents.emit('cleared', { url });
            return response;
        } catch (error) {
            lastErr = error;
            const transient = error?.code === 'NETWORK_TIMEOUT' || error?.name === 'TypeError';
            if (!transient || attempt === retryCount) {
                if (emittedSlow) networkEvents.emit('cleared', { url });
                throw error;
            }
            emittedSlow = true;
            networkEvents.emit('slow', { url, attempt: attempt + 1, timeoutMs, action: 'retry' });
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 800));
        }
    }
    throw lastErr;
};

const retryFetch = async (url, options, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;

            const error = await response.json().catch(() => ({}));
            if (response.status === 500) {
                console.log(`Attempt ${i + 1}: Retrying due to server error...`);
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
                continue;
            }
            throw new Error(error.message || `HTTP error! status: ${response.status}`);
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
};

const getAuthHeaders = () => {
    const token = localStorage.getItem('token');
    if (!token) {
        const err = new Error('Authentication required');
        err.code = 'AUTH_EXPIRED';
        throw err;
    }
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token.trim()}`
    };
};

const sendRequest = async (url, options) => {
    const defaultOptions = {
        headers: getAuthHeaders(),
        mode: 'cors'
    };

    const response = await fetch(url, { ...defaultOptions, ...options });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || `Request failed: ${response.status}`);
    }

    return response.json().catch(() => ({}));
};

const forceCloseExam = async (userId) => {
    const token = localStorage.getItem('token');
    const response = await fetch(`${import.meta.env.VITE_API_URL}/api/v1/exam/force-close/${userId}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
        }
    });

    if (!response.ok) {
        throw new Error('Failed to force close exam');
    }
    return response.json();
};

const parseJoinability = (value) => {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return Boolean(value);
};

const examStatusPriority = {
    active: 0,
    upcoming: 1,
    ended: 2,
};

const sortAvailableExams = (exams) => [...exams].sort((a, b) => {
    if (a.canJoin !== b.canJoin) {
        return a.canJoin ? -1 : 1;
    }

    const aStatus = examStatusPriority[a.status] ?? 99;
    const bStatus = examStatusPriority[b.status] ?? 99;
    if (aStatus !== bStatus) {
        return aStatus - bStatus;
    }

    const aStart = toTimestampMs(a.start_time);
    const bStart = toTimestampMs(b.start_time);
    return aStart - bStart;
});

export const examService = {
    async warmupProctoring() {
        try {
            const response = await fetch(`${BASE_URL}/warmup`, {
                method: 'POST',
                headers: getAuthHeaders(),
            });
            return await response.json().catch(() => ({}));
        } catch (error) {
            console.debug('Warmup request failed:', error);
            return { ready: false, error: 'warmup_failed' };
        }
    },

    async getAvailableExams() {
        try {
            const response = await sendRequest(`${BASE_URL}/available`);
            if (!Array.isArray(response)) {
                return [];
            }

            const normalized = response.map((exam) => ({
                ...exam,
                canJoin: parseJoinability(exam.can_join ?? exam.canJoin),
                questionCount: exam.question_count ?? 0,
                lastSessionStatus: exam.last_session_status ?? null,
                actionMessage: exam.action_message ?? '',
            }));

            return sortAvailableExams(normalized);
        } catch (error) {
            console.error('Get available exams error:', error);
            throw error;
        }
    },

    async getSession(userId) {
        try {
            const response = await fetch(`${BASE_URL}/session/${userId}`, {
                headers: getAuthHeaders()
            });
            if (!response.ok) throw new Error('Failed to get session');
            return await response.json();
        } catch (error) {
            console.error('Get session error:', error);
            throw error;
        }
    },

    async getExamDetails(examId) {
        try {
            // 25s timeout, 1 retry — read is idempotent, safe to retry.
            const response = await fetchWithTimeoutAndRetry(
                `${BASE_URL}/${examId}`,
                { headers: getAuthHeaders() },
                25000,
                1
            );
            if (!response.ok) throw new Error('Failed to get exam details');
            return await response.json();
        } catch (error) {
            console.error('Get exam details error:', error);
            throw error;
        }
    },

    async startExam(userId, examId = null) {
        try {
            const url = examId ? `${BASE_URL}/start/${userId}?exam_id=${examId}` : `${BASE_URL}/start/${userId}`;
            // 30s timeout — start endpoint may briefly wait for warmup readiness
            // on a freshly-restarted backend. No retry: starting an exam mutates
            // server state and is not safely repeatable here.
            const response = await fetchWithTimeout(url, {
                method: 'POST',
                headers: getAuthHeaders()
            }, 30000);

            const data = await response.json();
            if (!response.ok) {
                const errorMessage = data.detail || 'Failed to start exam';
                throw new Error(`${errorMessage} (${response.status})`);
            }

            // Simplify WebSocket URL construction
            if (data.wsUrl) {
                data.wsUrl = `${WS_URL}/${userId}`;
            }

            return data;
        } catch (error) {
            console.error('Start exam error:', error);
            throw error;
        }
    },

    async pauseExam(userId) {
        try {
            const token = localStorage.getItem('token');
            const formData = new FormData();
            formData.append('userId', userId);

            const response = await retryFetch(`${BASE_URL}/pause/${userId}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token.trim()}`
                },
                body: formData
            });
            return await response.json();
        } catch (error) {
            console.error('Pause exam error:', error);
            throw new Error('Failed to pause exam. Please try again.');
        }
    },

    async resumeExam(userId) {
        try {
            const token = localStorage.getItem('token');
            const formData = new FormData();
            formData.append('userId', userId);

            const response = await retryFetch(`${BASE_URL}/resume/${userId}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token.trim()}`
                },
                body: formData
            });
            return await response.json();
        } catch (error) {
            console.error('Resume exam error:', error);
            throw new Error('Failed to resume exam. Please try again.');
        }
    },

    async stopExam(userId) {
        try {
            // Send stop request to server
            const response = await sendRequest(`${BASE_URL}/stop/${userId}`, {
                method: 'POST'
            });
            return response;
        } catch (error) {
            console.error('Stop exam error:', error);
            throw error;
        }
    },

    // Remove endExam method since we're not using it anymore

    async endExamAndLogout(userId) {
        try {
            await this.stopExam(userId);
            authService.logout();
            return { success: true, message: 'Exam ended and logged out successfully' };
        } catch (error) {
            console.error('End exam and logout error:', error);
            throw error;
        }
    },

    async getExamSummary(userId, options = {}) {
        const { includeImage = true } = options;
        try {
            // 25s timeout, 1 retry — summary read is idempotent.
            const url = `${BASE_URL}/summary/${userId}${includeImage ? '' : '?include_image=false'}`;
            const response = await fetchWithTimeoutAndRetry(
                url,
                { headers: getAuthHeaders(), mode: 'cors' },
                25000,
                1
            );
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.detail || `Request failed: ${response.status}`);
            }
            return await response.json().catch(() => ({}));
        } catch (error) {
            console.error('Get summary error:', error);
            throw error;
        }
    },

    /**
     * Lazy-load the current user's profile photo as a data URL. Used by the
     * Summary page after a lite getExamSummary so the heavy image bytes do
     * not block the textual results from rendering on slow networks.
     */
    async getMyImageDataUrl() {
        try {
            const response = await fetchWithTimeoutAndRetry(
                `${API_URL}/api/v1/auth/me/image`,
                { headers: getAuthHeaders() },
                20000,
                1
            );
            // Backend returns 204 No Content for users without a profile
            // photo (preferred over 404 because it doesn't pollute the
            // browser console with red error rows for a perfectly normal
            // case). 404 is also handled defensively for older backends.
            if (response.status === 204 || response.status === 404) return null;
            if (!response.ok) return null;
            const blob = await response.blob();
            if (!blob || blob.size === 0) return null;
            return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
            });
        } catch (error) {
            console.debug('getMyImageDataUrl failed:', error);
            return null;
        }
    },

    async clearLogs(userId) {
        try {
            const response = await fetch(`${BASE_URL}/clear-logs/${userId}`, {
                method: 'POST',
                headers: getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error('Failed to clear logs');
            }

            return true;
        } catch (error) {
            console.warn('Clear logs error:', error);
            // Don't throw error since this is cleanup
            return false;
        }
    },

    async saveProgress(userId, progressData) {
        try {
            const response = await fetch(`${BASE_URL}/progress/${userId}`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(progressData),
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.detail || 'Failed to save exam progress');
            }

            return data;
        } catch (error) {
            console.error('Save exam progress error:', error);
            throw error;
        }
    },

    async submitExam(userId, submissionData) {
        // Submit is the most user-painful place to hang. Use a generous 45s
        // timeout (grading can take longer than a typical read) and try ONCE
        // more on a transient timeout — the backend submit handler is safe to
        // re-invoke for a completed session (it returns the cached result).
        const url = `${BASE_URL}/submit/${userId}`;
        const body = JSON.stringify(submissionData);
        const opts = {
            method: 'POST',
            headers: getAuthHeaders(),
            body,
        };

        const attempt = async () => {
            const response = await fetchWithTimeout(url, opts, 45000);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const err = new Error(data.detail || 'Failed to submit exam');
                err.status = response.status;
                throw err;
            }
            return data;
        };

        try {
            return await attempt();
        } catch (error) {
            if (error?.code === 'NETWORK_TIMEOUT') {
                console.warn('Submit timed out, retrying once…');
                networkEvents.emit('slow', { url, attempt: 1, timeoutMs: 45000, action: 'submit-retry' });
                try {
                    const result = await attempt();
                    networkEvents.emit('cleared', { url });
                    return result;
                } catch (retryError) {
                    networkEvents.emit('cleared', { url });
                    console.error('Submit exam retry failed:', retryError);
                    throw retryError;
                }
            }
            console.error('Submit exam error:', error);
            throw error;
        }
    },

    async logViolation(type, message, data = {}) {
        try {
            await fetch(`${BASE_URL}/log`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    log: message,
                    event_type: type,
                    event_data: data
                })
            });
        } catch (error) {
            console.error('Log violation error:', error);
            // Don't throw, just log error, as we don't want to interrupt the exam flow for logging failure
        }
    },

    forceCloseExam,
};
