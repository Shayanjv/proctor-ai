/**
 * Safe Exam Browser (SEB) helpers.
 *
 * Real SEB integration has two halves:
 *   1. Detect whether the page is being viewed *inside* SEB.
 *   2. Build a `seb://` / `sebs://` launch URL that, when clicked in a regular
 *      browser, hands control to SEB which then fetches the .seb config from
 *      the backend and navigates to the lobby in lockdown mode.
 *
 * The .seb endpoint is provided by the backend at
 *   GET /api/v1/exam/{examId}/seb-config.seb?return_to=<frontend-origin>
 */

const SEB_USER_AGENT_RE = /SEB[\s/]\d/i;

/**
 * True when the page is being rendered inside Safe Exam Browser.
 *
 * SEB exposes itself via two signals:
 *   - `navigator.userAgent` includes a `SEB/<version>` token.
 *   - A `window.SafeExamBrowser` JS object is injected.
 * We accept either one.
 */
export function isInsideSEB(): boolean {
    if (typeof navigator !== "undefined" && navigator.userAgent) {
        if (SEB_USER_AGENT_RE.test(navigator.userAgent)) return true;
    }
    if (typeof window !== "undefined") {
        const w = window as unknown as { SafeExamBrowser?: unknown };
        if (typeof w.SafeExamBrowser !== "undefined") return true;
    }
    return false;
}

/**
 * Build the launch URL the student clicks in a regular browser to hand off
 * to SEB. Uses `sebs://` for HTTPS API origins and `seb://` for HTTP.
 *
 * When `sebToken` is supplied (issued just-in-time by POST /auth/seb-token
 * while the student is still authenticated in the regular browser) it is
 * passed through to the .seb config endpoint, which embeds it into the
 * start URL. The FE running INSIDE SEB then redeems it for a JWT — so the
 * student never sees a login screen in the locked-down browser.
 *
 * Example output (without token):
 *   sebs://api.example.com/api/v1/exam/42/seb-config.seb?return_to=https%3A%2F%2Fstudent.example.com
 * Example output (with token):
 *   sebs://api.example.com/api/v1/exam/42/seb-config.seb?return_to=https%3A%2F%2Fstudent.example.com&seb_token=eyJhbGciOi…
 */
export function buildSebLaunchUrl(
    examId: string | number,
    sebToken?: string | null,
): string | null {
    const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
    if (!apiUrl) return null;

    let parsed: URL;
    try {
        parsed = new URL(apiUrl);
    } catch {
        return null;
    }

    const scheme = parsed.protocol === "https:" ? "sebs" : "seb";
    const hostAndPath = `${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
    const returnTo = encodeURIComponent(window.location.origin);
    const tokenSuffix = sebToken
        ? `&seb_token=${encodeURIComponent(sebToken)}`
        : "";
    return `${scheme}://${hostAndPath}/api/v1/exam/${examId}/seb-config.seb?return_to=${returnTo}${tokenSuffix}`;
}

/**
 * Path SEB is configured to treat as its `quitURL`. The .seb plist served by
 * the backend points `quitURL` at `<frontend-origin>/seb-quit`. Navigating
 * here from inside SEB triggers an automatic, prompt-less close (we also
 * set `quitURLConfirm=false` server-side).
 *
 * Outside SEB this path is harmless — App.jsx wires it to a tiny placeholder
 * page that just redirects back to /login.
 */
export const SEB_QUIT_PATH = "/seb-quit";

/**
 * Programmatically quit Safe Exam Browser at the end of a session
 * (termination, normal completion, manual logout).
 *
 * Strategy, in order:
 *   1. Call `window.SafeExamBrowser.security.quit(false)` if SEB injected
 *      its JS API. This is the cleanest path — no navigation, just an
 *      immediate close. `false` skips the in-app confirmation dialog.
 *   2. Fall back to navigating the page to `SEB_QUIT_PATH`. SEB matches
 *      this against its configured `quitURL` and closes itself; with
 *      `quitURLConfirm=false` no prompt is shown.
 *   3. If the page is NOT inside SEB (regular browser dev / preview) we
 *      can't actually close anything — invoke the supplied
 *      `fallbackOutsideSEB` callback so the caller can do its normal
 *      navigate-to-login.
 *
 * Returns `true` when a SEB exit path was attempted, `false` if we ran
 * the non-SEB fallback instead.
 */
export function quitSEB(fallbackOutsideSEB?: () => void): boolean {
    if (!isInsideSEB()) {
        if (fallbackOutsideSEB) {
            try {
                fallbackOutsideSEB();
            } catch (err) {
                console.warn("[SEB] fallbackOutsideSEB threw:", err);
            }
        }
        return false;
    }

    // Path 1: SEB JS API (SEB 3.x exposes window.SafeExamBrowser.security.quit).
    try {
        const w = window as unknown as {
            SafeExamBrowser?: {
                security?: {
                    quit?: (showConfirm?: boolean) => void;
                };
            };
        };
        const apiQuit = w.SafeExamBrowser?.security?.quit;
        if (typeof apiQuit === "function") {
            apiQuit(false);
            return true;
        }
    } catch (err) {
        console.warn("[SEB] JS-API quit failed; falling back to quitURL:", err);
    }

    // Path 2: navigate to the configured quitURL sentinel.
    try {
        window.location.href = SEB_QUIT_PATH;
    } catch (err) {
        console.error("[SEB] quitURL navigation failed:", err);
        if (fallbackOutsideSEB) fallbackOutsideSEB();
        return false;
    }
    return true;
}

/**
 * The SEB download page maintained by the SEB project. Used by the lobby's
 * "Download Safe Browser" step.
 */
export const SEB_DOWNLOAD_URL = "https://safeexambrowser.org/download_en.html";
