import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Request notification permission early
try {
  if (Notification?.permission === 'default') Notification.requestPermission();
} catch (_) { /* ignore */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// ═══════════════════════════════════════════════════════════════
// SERVICE WORKER: Register + Auto-Update
// When a new SW is detected (version bump in sw.js), the page
// reloads automatically so the PWA always serves fresh code.
// ═══════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      console.log('[SW] Registered. Scope:', reg.scope);

      // Check for updates every 60 seconds
      setInterval(() => reg.update(), 60 * 1000);

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        console.log('[SW] Update found — new worker installing...');

        newWorker.addEventListener('statechange', () => {
          // New SW is active and there was a previous one — reload
          if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
            console.log('[SW] New version activated — reloading...');
            window.location.reload();
          }
        });
      });
    }).catch(err => {
      console.error('[SW] Registration failed:', err);
    });

    // Also reload if the controlling SW changes (covers skipWaiting)
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      console.log('[SW] Controller changed — reloading...');
      window.location.reload();
    });
  });
}
