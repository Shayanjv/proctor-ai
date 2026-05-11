/**
 * Tiny event bus for network-resilience UX events emitted by the exam API
 * helpers. UI components (Exam, Summary) subscribe to render a transient
 * "Network looks slow…" banner without coupling to the service layer.
 *
 * Events:
 *   - 'slow'    => fired BEFORE a retry: { url, attempt, timeoutMs, action }
 *   - 'cleared' => fired AFTER a successful retry recovery: { url }
 */

const listeners = new Set();

export const networkEvents = {
    /** Subscribe to events. Returns an unsubscribe function. */
    subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    /** Emit an event to all subscribers. Never throws. */
    emit(type, payload = {}) {
        for (const listener of listeners) {
            try {
                listener({ type, ...payload });
            } catch (err) {
                // Subscribers must not break the network path.
                // eslint-disable-next-line no-console
                console.debug('[networkEvents] listener error:', err);
            }
        }
    },
};

export default networkEvents;
