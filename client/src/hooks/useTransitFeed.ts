import { useState, useEffect, useCallback, useRef } from 'react';
import type { RawVehicle, ApiBusResponse } from '../types/transit';
import { logEvent } from '../engine/telemetry';

export function useTransitFeed() {
  const [vehicles, setVehicles] = useState<RawVehicle[]>([]);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [stats, setStats] = useState<{ vehicleCount: number; routeCount: number }>({ vehicleCount: 0, routeCount: 0 });

  const eventSourceRef = useRef<EventSource | null>(null);

  const initSSE = useCallback(() => {
    if (eventSourceRef.current) return;

    const source = new EventSource('/api/stream');
    eventSourceRef.current = source;

    source.onmessage = (event) => {
      try {
        const data: ApiBusResponse = JSON.parse(event.data);
        const raw = (data.vehicles || []).map((v: any) => ({
          id: v.garaza || v.id,
          routeId: v.linija || v.routeId,
          lat: parseFloat(v.lat),
          lon: parseFloat(v.lon),
          heading: v.heading || 0,
          bearing: v.bearing || 0,
          speed: v.speed || 0,
          trueDest: v.trueDest || (v.terminusLat && v.terminusLon ? {
            name: v.terminusName || v.headsign || '',
            lat: parseFloat(v.terminusLat),
            lon: parseFloat(v.terminusLon),
          } : null),
          isHZPP: v.isHZPP || false,
          delay: v.delay || 0,
          tripId: v.tripId || '',
          directionId: v.directionId || null,
          // Schedule enrichment from server
          nextStopName: v.nextStopName || '',
          nextStopEta: v.nextStopEta ?? null,
          scheduledArrival: v.scheduledArrival || '',
          prevStopName: v.prevStopName || '',
          scheduleDeviation: v.scheduleDeviation ?? null,
          headsign: v.headsign || '',
          timestamp: v.timestamp || Date.now()
        }));
        setVehicles(raw);
        setLastUpdate(data.lastUpdate);
        setStats({ vehicleCount: data.vehicleCount, routeCount: data.routeCount });
        logEvent('FETCH', `Received ${data.vehicles?.length || 0} vehicles (${data.routeCount} routes) via SSE`);
      } catch (err) {
        console.error('[SSE Parse Error]', err);
      }
    };

    source.onerror = () => {
      console.warn('[SSE] Connection lost, reconnecting...');
      source.close();
      eventSourceRef.current = null;
      setTimeout(initSSE, 5000);
    };
  }, []);

  useEffect(() => {
    initSSE();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [initSSE]);

  return {
    vehicles,
    lastUpdate,
    stats
  };
}
