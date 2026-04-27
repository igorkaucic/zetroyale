import { useState, useEffect, useRef, memo } from 'react';

/**
 * Self-contained session clock that ticks internally.
 * Prevents the parent App from re-rendering every second just for the T+ display.
 */
export const SessionClock = memo(function SessionClock() {
  const startRef = useRef(Date.now());
  const [time, setTime] = useState('00:00:00');

  useEffect(() => {
    const iv = setInterval(() => {
      const e = Math.floor((Date.now() - startRef.current) / 1000);
      const h = String(Math.floor(e / 3600)).padStart(2, '0');
      const m = String(Math.floor((e % 3600) / 60)).padStart(2, '0');
      const s = String(e % 60).padStart(2, '0');
      setTime(`${h}:${m}:${s}`);
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  return <>{time}</>;
});
