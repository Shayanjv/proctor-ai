import { store } from '../store/store';
import { setCredentials, logout } from '../store/authSlice';
import { clearAllLobbyProgress } from '../app/utils/lobbyProgress';
import { releaseScreenShare } from '../utils/screenRecorderSession';

const API_URL = import.meta.env.VITE_API_URL;
const FACE_LOGIN_TIMEOUT_MS = 150000;
const EXAM_STORAGE_KEYS = [
    'examId',
    'examScore',
    'examResult',
    'examSummary',
    'examViolation',
    'examViolations',
    'tabSwitches',
];

const clearTransientExamState = () => {
    EXAM_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    clearAllLobbyProgress();
    releaseScreenShare();
};

/** Normalize FastAPI detail (string or { code, message }) */
export function parseApiDetail(detail) {
    if (detail == null) return 'Request failed';
    if (typeof detail === 'string') return detail;
    if (typeof detail === 'object' && detail.message) return detail.message;
    return 'Request failed';
}

export const authService = {
    async login(credentials) {
        const formData = new FormData();
        Object.keys(credentials).forEach(key => {
            formData.append(key, credentials[key]);
        });

        const response = await fetch(`${API_URL}/api/v1/auth/login/password`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(parseApiDetail(data.detail) || 'Login failed');
        }

        this.setAuth(data);
        return data;
    },

    async getUserProfile() {
        try {
            const { token } = this.getAuth();
            if (!token) {
                const err = new Error('No authentication token found');
                err.code = 'AUTH_EXPIRED';
                throw err;
            }

            const response = await fetch(`${API_URL}/api/v1/auth/me`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                if (response.status === 401 || response.status === 403) {
                    this.logout();
                    const err = new Error(parseApiDetail(data.detail) || 'Session expired');
                    err.code = 'AUTH_EXPIRED';
                    err.status = response.status;
                    throw err;
                }
                throw new Error(parseApiDetail(data.detail) || 'Failed to fetch user profile');
            }

            return await response.json();
        } catch (error) {
            console.error('Error fetching user profile:', error);
            if (
                error?.name === 'AbortError' ||
                (typeof error?.message === 'string' && error.message.toLowerCase().includes('failed to fetch'))
            ) {
                const err = new Error('Network issue');
                err.code = 'NETWORK_ERROR';
                throw err;
            }
            throw error;
        }
    },

    /**
     * Student flow step 1: verify password, receive attempt_id (no JWT).
     */
    async createLoginAttempt(credentials) {
        const formData = new FormData();
        formData.append('email', credentials.email);
        formData.append('password', credentials.password);

        const response = await fetch(`${API_URL}/api/v1/auth/login/attempt`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(parseApiDetail(data.detail) || 'Could not start login');
        }
        return data;
    },

    async loginWithPassword(credentials) {
        try {
            const formData = new FormData();
            formData.append('email', credentials.email);
            formData.append('password', credentials.password);

            const response = await fetch(`${API_URL}/api/v1/auth/login/password`, {
                method: 'POST',
                body: formData
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(parseApiDetail(data.detail) || 'Login failed');
            }

            this.setAuth(data);
            return data;
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    },

    async loginWithPasswordAndFace(credentials) {
        try {
            const formData = new FormData();
            formData.append('email', credentials.email);
            formData.append('password', credentials.password);
            formData.append('login_attempt_id', credentials.loginAttemptId);
            formData.append('liveness_challenge_id', credentials.livenessChallengeId);

            if (!credentials.loginAttemptId) {
                throw new Error('Login session missing. Enter your password again.');
            }
            if (!credentials.livenessChallengeId) {
                throw new Error('Face challenge missing. Restart the face verification step.');
            }

            if (!credentials.imageFront) {
                throw new Error('A front-facing photo is required for verification.');
            }

            formData.append('image_front', credentials.imageFront, 'face-front-login.jpg');

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), FACE_LOGIN_TIMEOUT_MS);

            let response;
            try {
                response = await fetch(`${API_URL}/api/v1/auth/login/password-face`, {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(parseApiDetail(data.detail) || 'Password and face verification failed');
            }

            this.setAuth(data);
            return data;
        } catch (error) {
            console.error('Password+face login error:', error);
            if (error?.name === 'AbortError') {
                throw new Error('Face verification is taking too long. Please retry.');
            }
            if (typeof error?.message === 'string' && error.message.toLowerCase().includes('failed to fetch')) {
                throw new Error('Cannot reach the server right now. Please retry in a few seconds.');
            }
            throw error;
        }
    },

    /**
     * Student login: mint liveness challenge tied to attempt_id.
     */
    async createLoginLivenessChallenge({ email, loginAttemptId }) {
        const formData = new FormData();
        formData.append('email', email);
        formData.append('login_attempt_id', loginAttemptId);

        const response = await fetch(`${API_URL}/api/v1/auth/login/liveness-challenge`, {
            method: 'POST',
            body: formData,
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(parseApiDetail(data.detail) || 'Could not start face challenge');
        }
        return data;
    },

    /**
     * LTI: user already has Bearer token; bind face references before exam.
     */
    async completeLtiFaceBind({ imageFront, livenessChallengeId }) {
        const { token } = this.getAuth();
        if (!token) throw new Error('Not signed in');

        if (!livenessChallengeId) {
            throw new Error('Face challenge missing. Restart the face verification step.');
        }

        if (!imageFront) {
            throw new Error('A front-facing photo is required for verification.');
        }

        const formData = new FormData();
        formData.append('liveness_challenge_id', livenessChallengeId);
        formData.append('image_front', imageFront, 'face-front-lti.jpg');

        const response = await fetch(`${API_URL}/api/v1/auth/login/lti-face-bind`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(parseApiDetail(data.detail) || 'Face verification failed');
        }
        return data;
    },

    /**
     * LTI: mint liveness challenge for current user (Bearer token).
     */
    async createLtiLivenessChallenge() {
        const { token } = this.getAuth();
        if (!token) throw new Error('Not signed in');

        const response = await fetch(`${API_URL}/api/v1/auth/login/lti-liveness-challenge`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(parseApiDetail(data.detail) || 'Could not start face challenge');
        }
        return data;
    },

    async resetInitialPassword(payload) {
        try {
            const response = await fetch(`${API_URL}/api/v1/auth/reset-password/initial`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: payload.email,
                    temporary_password: payload.temporaryPassword,
                    new_password: payload.newPassword,
                }),
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(parseApiDetail(data.detail) || 'Password reset failed');
            }

            return data;
        } catch (error) {
            console.error('Initial password reset error:', error);
            throw error;
        }
    },

    async analyzeEnrollmentFrame(payload) {
        try {
            const formData = new FormData();
            formData.append('image', payload.image, `face-${payload.targetPose || 'front'}.jpg`);
            formData.append('target_pose', payload.targetPose || 'front');
            const requirePose = payload.requirePoseMatch !== false;
            formData.append('require_pose_match', requirePose ? 'true' : 'false');

            const response = await fetch(`${API_URL}/api/v1/auth/face-enrollment/analyze`, {
                method: 'POST',
                body: formData,
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(parseApiDetail(data.detail) || 'Failed to analyze face frame');
            }

            return data;
        } catch (error) {
            console.error('Face enrollment analysis error:', error);
            throw error;
        }
    },

    /**
     * Step 1 of the SEB hand-off:
     * Ask the backend (while we're still in the regular browser, fully
     * authenticated) for a short-lived single-use token that we will bake
     * into the .seb config's startURL. Throws on network / auth failure.
     */
    async requestSebToken(examId) {
        const { token } = this.getAuth();
        if (!token) throw new Error('Not signed in');

        const response = await fetch(`${API_URL}/api/v1/auth/seb-token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                exam_id: examId !== undefined && examId !== null && examId !== ''
                    ? Number(examId)
                    : null,
            }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(parseApiDetail(data.detail) || 'Could not mint SEB token');
        }
        return data; // { token, expires_in_seconds }
    },

    /**
     * Step 2 of the SEB hand-off:
     * Inside SEB, the FE detects `?seb_token=…` in the URL and trades it
     * for a normal access JWT here. PUBLIC endpoint — the SEB token IS
     * the credential, single-use enforced server-side.
     *
     * On success, side-effect: the JWT is persisted via `setAuth()`, so
     * the rest of the app behaves exactly as if the user had just logged
     * in normally.
     */
    async redeemSebToken(sebToken) {
        if (!sebToken) throw new Error('Missing SEB token');

        const response = await fetch(`${API_URL}/api/v1/auth/seb-redeem`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: sebToken }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(parseApiDetail(data.detail) || 'SEB auto-login failed');
        }

        this.setAuth(data);
        return data;
    },

    setAuth(data) {
        const token = data.token ?? data.access_token;
        const userId = data.id ?? data.userId;

        if (!token || userId === undefined || userId === null) {
            throw new Error('Invalid auth data');
        }

        const normalizedUserId = String(userId);

        clearTransientExamState();
        localStorage.removeItem('token');
        localStorage.removeItem('userId');
        localStorage.setItem('token', token);
        localStorage.setItem('userId', normalizedUserId);

        store.dispatch(setCredentials({ token, userId: normalizedUserId }));

        return { token, userId: normalizedUserId };
    },

    getAuth() {
        const token = localStorage.getItem('token');
        const userId = localStorage.getItem('userId');
        return { token, userId };
    },

    isAuthenticated() {
        const token = localStorage.getItem('token');
        const userId = localStorage.getItem('userId');
        return Boolean(token && userId && token !== 'undefined' && token !== 'null');
    },

    logout() {
        clearTransientExamState();
        localStorage.removeItem('token');
        localStorage.removeItem('userId');
        localStorage.removeItem('isLti');
        localStorage.removeItem('ltiIdentityPending');
        store.dispatch(logout());
    }
};
