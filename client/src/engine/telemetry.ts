// ══════════════════════════════════════════════════
//  ZET ROYALE V2 — Telemetry & Debugging
// ══════════════════════════════════════════════════

export interface LogEntry {
  time: number;
  type: 'INFO' | 'WARN' | 'ERROR' | 'GPS' | 'FETCH' | 'ROUTING' | 'UI' | 'DISCOVERY' | 'TRACK' | 'ETA';
  message: string;
  data?: any;
}

declare global {
  interface Window {
    SESSION_LOGS: LogEntry[];
  }
}

// Initialize on boot
if (!window.SESSION_LOGS) {
  window.SESSION_LOGS = [];
}

export function logEvent(type: LogEntry['type'], message: string, data?: any) {
  const entry: LogEntry = { time: Date.now(), type, message, data };
  window.SESSION_LOGS.push(entry);
  
  // Cap at 1000 logs to prevent memory leaks on mobile
  if (window.SESSION_LOGS.length > 1000) {
    window.SESSION_LOGS.shift();
  }

  // Also log to console in dev
  if (import.meta.env.DEV) {
    if (type === 'ERROR') console.error(`[${type}] ${message}`, data || '');
    else if (type === 'WARN') console.warn(`[${type}] ${message}`, data || '');
    else console.log(`[${type}] ${message}`, data || '');
  }
}

export function clearLogs() {
  window.SESSION_LOGS = [];
}

export function getLogsDump(): string {
  if (window.SESSION_LOGS.length === 0) return 'NO LOGS RECORDED.';
  
  return window.SESSION_LOGS.map(log => {
    const d = new Date(log.time);
    const timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
    let line = `[${timeStr}] [${log.type}] ${log.message}`;
    if (log.data) {
      try {
        line += `\n  ↳ ${JSON.stringify(log.data)}`;
      } catch (e) {
        line += `\n  ↳ [Complex Data Object]`;
      }
    }
    return line;
  }).join('\n');
}

// ── Global UI click interceptor ──────────────────
// Captures every tap target so we can replay the user's actions from logs
function describeElement(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const cls = el.className ? `.${String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.')}` : '';
  const id = el.id ? `#${el.id}` : '';
  const text = el.textContent?.trim().slice(0, 40) || '';
  return `<${tag}${id}${cls}> "${text}"`;
}

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (!target) return;
  logEvent('UI', `TAP ${describeElement(target)}`);
}, { capture: true, passive: true });

// ── Global error interceptor ─────────────────────
// Catches uncaught errors and promise rejections so they show up in Copy Logs
window.addEventListener('error', (e) => {
  logEvent('ERROR', `Uncaught: ${e.message}`, {
    file: e.filename,
    line: e.lineno,
    col: e.colno
  });
});

window.addEventListener('unhandledrejection', (e) => {
  logEvent('ERROR', `Unhandled Promise: ${e.reason}`, {
    reason: String(e.reason)
  });
});
