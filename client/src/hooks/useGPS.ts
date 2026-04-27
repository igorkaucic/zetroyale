import { useState, useEffect, useRef } from 'react';
import { logEvent } from '../engine/telemetry';

interface GPSPosition {
  lat: number;
  lon: number;
  speed: number; // m/s
  accuracy: number;
}

export function useGPS() {
  const [position, setPosition] = useState<GPSPosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setError('Geolocation not available');
      logEvent('ERROR', 'Geolocation API not available on this device');
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          speed: pos.coords.speed || 0,
          accuracy: pos.coords.accuracy,
        });
        setError(null);
        logEvent('GPS', `Location updated (acc: ${pos.coords.accuracy}m)`, {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude
        });
      },
      (err) => {
        setError(err.message);
        logEvent('ERROR', `GPS Error: ${err.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 8000 }
    );

    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  return { position, error };
}
