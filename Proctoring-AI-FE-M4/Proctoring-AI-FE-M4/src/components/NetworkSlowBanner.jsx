import { useEffect, useState, useRef } from 'react';
import { networkEvents } from '../services/networkEventBus';

/**
 * Floating, low-profile banner that appears when an exam API call is
 * timing out and being retried, and disappears once the network recovers.
 *
 * - Auto-hides 4s after the most recent 'cleared' event (or after 30s
 *   without further activity, whichever comes first).
 * - Pure presentational; subscribes to networkEvents only.
 */
const NetworkSlowBanner = () => {
    const [visible, setVisible] = useState(false);
    const [message, setMessage] = useState('Network looks slow, retrying…');
    const hideTimer = useRef(null);

    useEffect(() => {
        const unsubscribe = networkEvents.subscribe(({ type, action }) => {
            if (type === 'slow') {
                if (hideTimer.current) {
                    clearTimeout(hideTimer.current);
                    hideTimer.current = null;
                }
                setMessage(
                    action === 'submit-retry'
                        ? 'Submit is slow on this network — retrying once…'
                        : 'Network looks slow, retrying…'
                );
                setVisible(true);
                // Safety fade-out: never let the banner be sticky forever.
                hideTimer.current = setTimeout(() => setVisible(false), 30000);
            } else if (type === 'cleared') {
                if (hideTimer.current) {
                    clearTimeout(hideTimer.current);
                    hideTimer.current = null;
                }
                setMessage('Connection recovered.');
                hideTimer.current = setTimeout(() => setVisible(false), 2500);
            }
        });
        return () => {
            unsubscribe();
            if (hideTimer.current) clearTimeout(hideTimer.current);
        };
    }, []);

    if (!visible) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            style={{
                position: 'fixed',
                top: 16,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 9999,
                background: 'rgba(30, 30, 30, 0.92)',
                color: '#fff',
                padding: '10px 16px',
                borderRadius: 10,
                fontSize: 13,
                boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                pointerEvents: 'none',
                maxWidth: '90vw',
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#f59e0b',
                    boxShadow: '0 0 12px rgba(245,158,11,0.8)',
                    animation: 'networkSlowPulse 1.2s ease-in-out infinite',
                    flexShrink: 0,
                }}
            />
            <span>{message}</span>
            <style>{`@keyframes networkSlowPulse { 0%,100%{opacity:.6} 50%{opacity:1} }`}</style>
        </div>
    );
};

export default NetworkSlowBanner;
