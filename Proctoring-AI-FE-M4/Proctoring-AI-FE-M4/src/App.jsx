import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Provider } from 'react-redux';
import { store } from './store/store';
import Login from './components/Login';
import Signup from './components/Signup';
import Exam from './components/Exam';
import ExamLobbyHome from './components/ExamLobbyHome';
import { SystemCheckPage } from './app/components/SystemCheckPage';
import { NetworkCheckPage } from './app/components/NetworkCheckPage';
import Summary from './components/Summary';
import LTICallback from './components/LTICallback';
import VerifyIdentity from './components/VerifyIdentity';
import { authService } from './services/authService';

const isAuthenticatedUser = () => {
    const token = localStorage.getItem('token')?.trim();
    const userId = localStorage.getItem('userId')?.trim();

    return Boolean(
        token &&
        userId &&
        token !== 'undefined' &&
        token !== 'null' &&
        userId !== 'undefined' &&
        userId !== 'null'
    );
};

const ltiIdentityPending = () => localStorage.getItem('ltiIdentityPending') === '1';

// eslint-disable-next-line react/prop-types
const ProtectedRoute = ({ children }) => {
    const location = useLocation();
    const [isAuthenticated, setIsAuthenticated] = React.useState(null);

    React.useEffect(() => {
        const checkAuth = () => {
            const token = localStorage.getItem('token')?.trim();
            const userId = localStorage.getItem('userId')?.trim();
            
            const isValid = Boolean(
                token && 
                userId && 
                token !== 'undefined' && 
                token !== 'null' &&
                userId !== 'undefined' &&
                userId !== 'null'
            );
            
            console.log('[AuthCheck]', { isValid, token: !!token, userId: !!userId });
            setIsAuthenticated(isValid);
        };

        checkAuth();
        // Add event listener for storage changes
        window.addEventListener('storage', checkAuth);
        return () => window.removeEventListener('storage', checkAuth);
    }, []);

    // Show loading or nothing while checking auth
    if (isAuthenticated === null) return null;

    if (!isAuthenticated) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    if (ltiIdentityPending() && location.pathname !== '/verify-identity') {
        return <Navigate to="/verify-identity" replace />;
    }

    return children;
};

// eslint-disable-next-line react/prop-types
const AuthLandingRoute = ({ children }) => {
    if (isAuthenticatedUser() && ltiIdentityPending()) {
        return <Navigate to="/verify-identity" replace />;
    }
    if (isAuthenticatedUser()) {
        return <Navigate to="/exam" replace />;
    }

    return children;
};

/**
 * SEB auto-login bridge.
 *
 * When Safe Exam Browser launches the FE, the start URL carries a
 * single-use redeem token in the `seb_token` query param (issued by
 * /auth/seb-token while the student was still in their regular browser).
 * This component traps that param BEFORE any <ProtectedRoute> can bounce
 * the user to /login: redeems the token, persists the JWT via
 * authService.setAuth, then strips the param from the URL so React Router
 * can render the intended route normally.
 *
 * Renders nothing while in flight; on failure it falls back to the regular
 * login flow (the protected route will redirect to /login as usual).
 */
const SebTokenRedeemer = ({ children }) => {
    const [phase, setPhase] = React.useState(() => {
        // Cheap synchronous detection so we don't flash the login screen.
        if (typeof window === 'undefined') return 'idle';
        const params = new URLSearchParams(window.location.search);
        return params.has('seb_token') ? 'redeeming' : 'idle';
    });

    React.useEffect(() => {
        if (phase !== 'redeeming') return;
        const params = new URLSearchParams(window.location.search);
        const token = params.get('seb_token');
        if (!token) {
            setPhase('idle');
            return;
        }

        let cancelled = false;
        (async () => {
            try {
                // If a stale token is in storage from a previous regular-
                // browser session, ditch it so the SEB session starts clean.
                if (authService.isAuthenticated()) {
                    authService.logout();
                }
                await authService.redeemSebToken(token);
            } catch (err) {
                console.error('[SEB] Auto-login failed:', err);
            } finally {
                if (cancelled) return;
                // Strip seb_token from the URL whether we succeeded or not —
                // we never want it sitting in the address bar / history.
                params.delete('seb_token');
                const search = params.toString();
                const next =
                    window.location.pathname +
                    (search ? `?${search}` : '') +
                    window.location.hash;
                window.history.replaceState(null, '', next);
                setPhase('idle');
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [phase]);

    if (phase === 'redeeming') {
        // Tiny placeholder — usually <1s. Keeping it minimal avoids
        // pulling in tailwind/motion before the rest of the tree mounts.
        return (
            <div
                style={{
                    minHeight: '100vh',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'system-ui, sans-serif',
                    color: '#475569',
                    fontSize: 14,
                }}
            >
                Signing you in…
            </div>
        );
    }

    return children;
};

const App = () => {
    return (
        <Provider store={store}>
            <BrowserRouter>
                <SebTokenRedeemer>
                    <Routes>
                    <Route path="/lti/callback" element={<LTICallback />} />
                    <Route path="/verify-identity" element={
                        <ProtectedRoute>
                            <VerifyIdentity />
                        </ProtectedRoute>
                    } />
                    <Route path="/login" element={
                        <AuthLandingRoute>
                            <Login />
                        </AuthLandingRoute>
                    } />
                    <Route path="/signup" element={
                        <AuthLandingRoute>
                            <Signup />
                        </AuthLandingRoute>
                    } />
                    <Route path="/exam/:examId" element={
                        <ProtectedRoute>
                            <SystemCheckPage />
                        </ProtectedRoute>
                    } />
                    <Route path="/exam/:examId/network-check" element={
                        <ProtectedRoute>
                            <NetworkCheckPage />
                        </ProtectedRoute>
                    } />
                    <Route path="/exam/:examId/active" element={
                        <ProtectedRoute>
                            < Exam />
                        </ProtectedRoute>
                    } />
                    <Route path="/exam" element={
                        <ProtectedRoute>
                            <ExamLobbyHome />
                        </ProtectedRoute>
                    } />
                    <Route path="/exam/network-check" element={
                        <ProtectedRoute>
                            <Navigate to="/exam" replace />
                        </ProtectedRoute>
                    } />
                    <Route path="/exam/active" element={
                        <ProtectedRoute>
                            < Exam />
                        </ProtectedRoute>
                    } />
                    <Route path="/summary" element={
                        <ProtectedRoute>
                            <Summary />
                        </ProtectedRoute>
                    } />
                    <Route
                        path="/"
                        element={
                            isAuthenticatedUser() && ltiIdentityPending()
                                ? <Navigate to="/verify-identity" replace />
                                : <Navigate to={isAuthenticatedUser() ? "/exam" : "/login"} replace />
                        }
                    />
                    {/*
                      * SEB quit-URL sentinel. The .seb plist served by the BE
                      * sets `quitURL=<frontend>/seb-quit` so that when the FE
                      * navigates here from inside SEB, the locked-down browser
                      * auto-closes. If we land here OUTSIDE SEB (e.g. in a
                      * regular dev browser), this fallback page just redirects
                      * to /login so the URL never 404s.
                      */}
                    <Route path="/seb-quit" element={<Navigate to="/login" replace />} />
                    </Routes>
                </SebTokenRedeemer>
            </BrowserRouter>
        </Provider>
    );
};

export default App;
