import { useState, useEffect, useRef, useCallback } from 'react';
import type { UserProfile, EnrichedVehicle, Phase, ActiveLeg, Journey } from './types/transit';
import { useGPS } from './hooks/useGPS';
import { useTransitFeed } from './hooks/useTransitFeed';
import { loadProfile, getDefaultProfile, getAllLocations, setHome, addHub, addDestination } from './engine/profile';
import { enrichVehicles, getBestVehicle, detectActiveLeg, getRelevantRoutes, computeJourneyLegs, findBestChain, shouldBreakLock } from './engine/routing';
import { haversineM, walkingTime, fmtTime, fmtMin, calculateHeading } from './engine/math';
import { logEvent } from './engine/telemetry';
import { TacticalMap } from './components/TacticalMap';
import { SettingsPanel } from './components/SettingsPanel';
import { TimetablePanel } from './components/TimetablePanel';
import { SessionClock } from './components/SessionClock';
import { APP_VERSION } from './version';

const WALK_RADIUS_ENTER = 800;

// Store last known valid headings to survive ZET's '0 heading when stopped' bug
const vehicleHeadingHistory = new Map<string, number>();

export default function App() {
  // ── Profile state (Node API) ──
  const [profile, setProfile] = useState<UserProfile>(getDefaultProfile());
  const [profileLoaded, setProfileLoaded] = useState(false);

  // ── Data sources ──
  const { position } = useGPS();
  const { vehicles: rawVehicles, stats } = useTransitFeed();


  // ── Derived state ──
  const [activeLeg, setActiveLeg] = useState<ActiveLeg>({ type: 'idle' });
  const [enriched, setEnriched] = useState<EnrichedVehicle[]>([]);
  const [trackedId, setTrackedId] = useState<string | null>(null);
  const [manualTrackedId, setManualTrackedId] = useState<string | null>(null);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [selectedGhost, setSelectedGhost] = useState<EnrichedVehicle | null>(null);
  const [ghostScheduleInfo, setGhostScheduleInfo] = useState<{ scheduled: string, diff: number, isLate: boolean } | null>(null);
  const [selectedStopPopup, setSelectedStopPopup] = useState<any>(null);
  const [selectedHub, setSelectedHub] = useState<{ name: string; lat: number; lon: number; routes: string[] } | null>(null);
  const [hubArrivals, setHubArrivals] = useState<any[]>([]);
  const [phase, setPhase] = useState<Phase>('walk');
  const [liveEta, setLiveEta] = useState<number | null>(null);
  const [activeNav, setActiveNav] = useState<'track' | 'me' | 'timetable' | 'settings' | 'none'>('track');
  const [hzppData, setHzppData] = useState<any>(null);
  const [hzppSchedule, setHzppSchedule] = useState<any[]>([]);

  // ── Map layer toggles (persisted) ──
  const [showHubs, setShowHubs] = useState(() => localStorage.getItem('zr_showHubs') !== 'false');
  const [showStops, setShowStops] = useState(() => localStorage.getItem('zr_showStops') !== 'false');

  // ── Toast ──
  const [toastMsg, setToastMsg] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const notifiedRef = useRef(false);

  // ── Picking UI ──
  const [pickingMode, setPickingMode] = useState<'home' | 'place' | null>(null);
  const [pickLat, setPickLat] = useState<number | null>(null);
  const [pickLon, setPickLon] = useState<number | null>(null);
  const [pickName, setPickName] = useState('');

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 3000);
  }, []);

  // ── Session timer ──
  const sessionStart = useRef(Date.now());

  // Smooth ETA countdown (every 1 second to allow fluid timer)
  useEffect(() => {
    const interval = setInterval(() => {
      setLiveEta(prev => {
        if (prev !== null && prev > 0) {
          return prev - (1 / 60); // 1 second elapsed
        }
        return prev;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Load profile on mount
  useEffect(() => {
    loadProfile().then(p => {
      setProfile(p);
      setProfileLoaded(true);
    });
  }, []);

  // Poll for new version to auto-refresh
  useEffect(() => {
    const checkVersion = async () => {
      try {
        const res = await fetch(`/zetroyale/version.json?t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          if (data.version && data.version !== APP_VERSION) {
            console.log(`Update detected: ${APP_VERSION} -> ${data.version}. Reloading...`);
            window.location.reload();
          }
        }
      } catch (e) {
        // Ignore network errors
      }
    };
    
    // Check every 60 seconds
    const interval = setInterval(checkVersion, 60000);
    // Also check when tab becomes visible
    const handleVis = () => { if (document.visibilityState === 'visible') checkVersion(); };
    document.addEventListener('visibilitychange', handleVis);
    
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVis);
    };
  }, []);



  const [legSchedules, setLegSchedules] = useState<Record<number, any>>({});
  const [discoveredRoutes, setDiscoveredRoutes] = useState<string[]>([]);
  const [discoveredRouteDetails, setDiscoveredRouteDetails] = useState<any[]>([]);
  const [journeyChains, setJourneyChains] = useState<any[]>([]);
  const [evaluatedChains, setEvaluatedChains] = useState<any[]>([]);
  const [activeChainIndex, setActiveChainIndex] = useState(0);
  const lockedRouteRef = useRef<string | null>(null);
  const [isJourneyExpanded, setIsJourneyExpanded] = useState(false);

  // ── Detect active leg from GPS (Only once when idle) ──
  useEffect(() => {
    if (!position || !profile) return;
    
    setActiveLeg(prev => {
      // If the user already has a route (auto-detected or manually tapped), do NOT overwrite it!
      if (prev.type !== 'idle') return prev;

      const leg = detectActiveLeg(position.lat, position.lon, profile);
      if (leg.type !== 'idle') {
        logEvent('ROUTING', `Auto-detected initial route: ${leg.type}`, leg);
        return leg;
      }
      return prev;
    });
  }, [position, profile]);

  // ── Journey Planner Hook ──
  // Calls /api/next-vehicle when user has an active leg with GPS position
  useEffect(() => {
    if (activeLeg.type === 'idle' || !activeLeg.from || !activeLeg.to) {
      setDiscoveredRoutes([]);
      setJourneyChains([]);
      return;
    }
    if (!position) return; // Need GPS

    let isCancelled = false;
    let pollTimer: any;

    const fetchJourney = () => {
      const { from, to } = activeLeg as { from: any; to: any };
      fetch(`/api/next-vehicle?userLat=${position.lat}&userLon=${position.lon}&destLat=${to.lat}&destLon=${to.lon}`)
        .then(r => r.json())
        .then(data => {
          if (isCancelled) return;
          if (data.error) {
            console.log('[PLANNER] Not ready:', data.error);
            pollTimer = setTimeout(fetchJourney, 5000);
            return;
          }
          if (data.journeyChains) {
            setDiscoveredRoutes(data.routes || []);
            setDiscoveredRouteDetails([]);
            setJourneyChains(data.journeyChains);
            
            const lockedRoute = lockedRouteRef.current;
            if (lockedRoute) {
              const foundIdx = data.journeyChains.findIndex((c: any) => c.legs && c.legs.length > 0 && c.legs[0].route === lockedRoute);
              if (foundIdx !== -1 && foundIdx <= 1) {
                // Locked route is still in top 2 — keep it
                setActiveChainIndex(foundIdx);
              } else {
                // Locked route dropped out of top options or gone entirely — release the lock
                lockedRouteRef.current = null;
                setActiveChainIndex(0);
              }
            } else {
              setActiveChainIndex(0);
            }
            
            if (data.journeyChains.length > 0) {
              logEvent('PLANNER', `Found ${data.journeyChains.length} routes: ${data.routes?.join(', ')}`, data);
            }
          }
          // Re-poll every 30s for updated options
          pollTimer = setTimeout(fetchJourney, 30000);
        })
        .catch(e => {
          console.error('[PLANNER] Error:', e);
          if (!isCancelled) pollTimer = setTimeout(fetchJourney, 10000);
        });
    };

    fetchJourney();

    return () => {
      isCancelled = true;
      clearTimeout(pollTimer);
    };
  }, [
    activeLeg.type !== 'idle' ? (activeLeg as any).to?.lat : null,
    activeLeg.type !== 'idle' ? (activeLeg as any).to?.lon : null,
    position ? Math.round(position.lat * 100) : null, // Re-fetch when user moves significantly (~1km)
    position ? Math.round(position.lon * 100) : null,
  ]);

  // If we have journey chains, use the best chain to determine primary routes
  const chainIdx = Math.min(activeChainIndex, journeyChains.length - 1);
  const activeChain = journeyChains.length > 0 ? journeyChains[Math.max(0, chainIdx)] : null;
  const activeChainLegs = activeChain ? activeChain.legs : null;
  
  useEffect(() => {
    if (activeChainLegs && activeChainLegs.length > 0) {
      lockedRouteRef.current = activeChainLegs[0].route;
    }
  }, [activeChainLegs]);
  
  // Routes come from the active chain ONLY — the discovery engine already did the math
  const activeChainRoutes = activeChainLegs ? activeChainLegs.map((l: any) => l.route) : [];
  const relevantRoutes = activeChainRoutes;

  // ── Detect HŽPP Leg ──
  const isHzppLeg = activeChainLegs && activeChainLegs.length > 0 && activeChainLegs[0].route === 'HŽPP';

  // Map hub names to HŽPP GTFS stop_ids
  const HZ_NAME_TO_GTFS: Record<string, string> = {
    'hž harmica': 'i-o716', 'hž zaprešić savska': 'i-o698', 'hž zaprešić': 'i-o695',
    'hž podsused stajalište': 'i-o694', 'hž gajnice': 'i-o697', 'hž vrapče': 'i-o692',
    'hž kustošija': 'i-o696', 'hž zagreb zapadni kolodvor': 'i-o700',
    'hž zagreb glavni kolodvor': 'i-o523', 'glavni kolodvor': 'i-o523',
    'hž maksimir': 'i-o517', 'hž trnava': 'i-o516', 'hž čulinec': 'i-o515',
    'hž sesvete': 'i-o514', 'hž dugo selo': 'i-o540',
  };
  const resolveHz = (name: string) => {
    if (!name) return null;
    const lower = name.toLowerCase().trim();
    if (HZ_NAME_TO_GTFS[lower]) return HZ_NAME_TO_GTFS[lower];
    for (const [k, v] of Object.entries(HZ_NAME_TO_GTFS)) {
      if (lower.includes(k) || k.includes(lower)) return v;
    }
    return null;
  };

  // ── Auto-Fetch HŽPP Schedule (between two HŽPP hubs) ──
  useEffect(() => {
    if (!isHzppLeg || !activeChainLegs) {
      setHzppSchedule([]);
      return;
    }
    const fromGtfs = resolveHz(activeChainLegs[0]?.departureStop?.name || '');
    const toGtfs = resolveHz(activeChainLegs[0]?.arrivalStop?.name || '');
    if (!fromGtfs || !toGtfs) return;

    const fetchSchedule = () => {
      fetch(`/api/hzpp-schedule?from=${fromGtfs}&to=${toGtfs}`)
        .then(r => r.json())
        .then(data => {
          if (data?.upcoming) {
            setHzppSchedule(data.upcoming);
          }
        })
        .catch(() => setHzppSchedule([]));
    };
    fetchSchedule();
    const iv = setInterval(fetchSchedule, 60000); // refresh every minute
    return () => clearInterval(iv);
  }, [isHzppLeg, activeLeg.type !== 'idle' ? activeLeg.from?.id : '', activeLeg.type !== 'idle' ? activeLeg.to?.id : '']);

  // ── Auto-Fetch HŽPP Train (live delay for specific train) ──
  useEffect(() => {
    const trainNum = relevantRoutes?.find(r => /^\d{4}$/.test(r));
    if (trainNum && activeNav === 'track') {
      const fetchHz = () => {
        const queryParams = new URLSearchParams({ train: trainNum });
        if (activeLeg.type === 'custom' && activeLeg.from) {
          queryParams.append('targetLat', activeLeg.from.lat.toString());
          queryParams.append('targetLon', activeLeg.from.lon.toString());
        }
        fetch(`/api/hzpp?${queryParams.toString()}`)
          .then(res => res.json())
          .then(data => {
            if (data && data.station) setHzppData(data);
            else setHzppData(null);
          })
          .catch(_ => setHzppData(null));
      };
      
      fetchHz(); // initial
      const interval = setInterval(fetchHz, 15000);
      return () => clearInterval(interval);
    } else {
      setHzppData(null);
    }
  }, [relevantRoutes, activeNav]);

  // ── Core update: enrich vehicles + find best ──
  useEffect(() => {
    if (rawVehicles.length === 0) return;

    let targetStop = activeLeg.type !== 'idle' ? activeLeg.to : null;
    
    // In V3, the backend provides the exact mathematical departure stop for the first leg of the journey.
    // If we have journey chains, use the best chain's first leg departure stop
    if (activeChainLegs && activeChainLegs.length > 0 && activeChainLegs[0].departureStop) {
      targetStop = activeChainLegs[0].departureStop;
    } else if (discoveredRouteDetails && discoveredRouteDetails.length > 0) {
      const firstLeg = discoveredRouteDetails.find(r => r && r.departureStop);
      if (firstLeg) {
        targetStop = firstLeg.departureStop;
      }
    } 
    
    if (!targetStop || targetStop.id === (activeLeg as any).to?.id) {
      // Fallback: IF the user is currently at a HUB or DESTINATION (within 1.5km), they are waiting for a vehicle to ARRIVE AT THEM.
      if (activeLeg.type !== 'idle' && activeLeg.from && activeLeg.from.id !== 'wild' && position) {
        if (activeLeg.from.type !== 'home') {
          const distToOrigin = haversineM(position.lat, position.lon, activeLeg.from.lat, activeLeg.from.lon);
          if (distToOrigin < 1500) {
            targetStop = activeLeg.from;
          }
        }
      }
    }

    const enrichedVehicles = enrichVehicles(rawVehicles, targetStop, relevantRoutes);

    setEnriched(enrichedVehicles);

    // ── Multi-leg journey computation ──────────────────────────────────────
    const mappedVehicles = rawVehicles.map(v => {
      let h = v.heading || v.bearing || 0;
      if (h === 0 && vehicleHeadingHistory.has(v.id)) {
        h = vehicleHeadingHistory.get(v.id)!;
      } else if (h !== 0) {
        vehicleHeadingHistory.set(v.id, h);
      }
      return {
        ...v,
        approachingTarget: true, // Legacy flag, now mostly superseded by math
        distToTarget: 0,
        etaToTarget: 0,
        avgSpeed: v.speed,
        heading: h,
      };
    }) as any;

    let currentJourney: Journey | null = null;
    if (journeyChains && journeyChains.length > 0 && position && activeLeg.type !== 'idle') {
      // ── V3 ALGORITHM: Evaluate ALL chains ──
      const evaluated = journeyChains.map((chain: any, idx: number) => ({
        index: idx,
        journey: computeJourneyLegs(chain.legs, mappedVehicles, position.lat, position.lon)
      })).sort((a: any, b: any) => a.journey.totalMinutes - b.journey.totalMinutes);
      
      setEvaluatedChains(evaluated);

      // ── Step 2: Find the best chain (walk/time balance) ──
      const activeRouteId = activeChainLegs && activeChainLegs.length > 0 ? activeChainLegs[0].route : null;
      const bestChain = findBestChain(evaluated, position.lat, position.lon, activeRouteId);
      
      if (bestChain && bestChain.index !== activeChainIndex) {
        const currentEval = evaluated.find((e: any) => e.index === activeChainIndex);
        const currentTime = currentEval?.journey?.totalMinutes ?? 999;
        const bestTime = bestChain.journey.totalMinutes;
        
        // ── LOCK BREAK: Switch if the best chain is >5 minutes faster ──
        // This prevents thrashing on marginal differences while still allowing
        // the system to recover when the locked route becomes significantly worse
        // (e.g., the 172 bus departed and now 121 is 20 minutes faster).
        if (currentTime - bestTime > 5) {
          logEvent('ROUTING', `Breaking lock: ${activeChainLegs?.[0]?.route} (${currentTime.toFixed(0)}m) → ${bestChain.journey.legs[0]?.route} (${bestTime.toFixed(0)}m)`);
          lockedRouteRef.current = bestChain.journey.legs[0]?.route || null;
          setActiveChainIndex(bestChain.index);
          uncatchableStartTimeRef.current = null;
        }
      } else {
        // Active chain is already the best — reset late timer
        uncatchableStartTimeRef.current = null;
      }

      // Use the active chain's journey for display
      const activeEval = evaluated.find((e: any) => e.index === activeChainIndex);
      currentJourney = activeEval?.journey ?? (bestChain?.journey ?? null);
      setJourney(currentJourney);
    } else if (discoveredRouteDetails && discoveredRouteDetails.length >= 1 && position) {
      currentJourney = computeJourneyLegs(
        discoveredRouteDetails,
        mappedVehicles,
        position.lat,
        position.lon,
      );
      setJourney(currentJourney);
    } else {
      setJourney(null);
    }

    // Keep selectedGhost synced with live data (heading, speed, position update every tick)
    setSelectedGhost(prev => {
      if (!prev) return null;
      const live = enrichedVehicles.find(v => v.id === prev.id);
      return live || prev; // Update with live data, or keep stale if vehicle disappeared
    });

    // ── UNIFIED VEHICLE TRACKING ──
    // When the journey planner has computed a valid vehicle for the active leg,
    // use THAT as the tracked vehicle.
    let best: typeof enrichedVehicles[0] | null = null;

    if (manualTrackedId && enrichedVehicles.some(v => v.id === manualTrackedId)) {
      // Manual override! User explicitly selected a vehicle to track on the map.
      best = enrichedVehicles.find(v => v.id === manualTrackedId)!;
    } else if (currentJourney && currentJourney.legs.length > 0) {
      // Find which leg we are currently on based on user's GPS position
      let activeLegIndex = 0;
      if (position) {
         for (let i = 0; i < currentJourney.legs.length - 1; i++) {
             const exit = currentJourney.legs[i].exitStop;
             const distToExit = haversineM(position.lat, position.lon, exit.lat, exit.lon);
             // If we are within 200m of the transfer point, we are likely waiting for the next vehicle
             if (distToExit < 200) {
                 activeLegIndex = i + 1;
             }
         }
      }
      
      const activeLegVehicle = currentJourney.legs[activeLegIndex].vehicle;
      if (activeLegVehicle) {
        best = enrichedVehicles.find(v => v.id === activeLegVehicle.id) || null;
      }
      // CRITICAL FIX: If journey is active but returned null, DO NOT fall back.
      // It means all nearby vehicles are going the wrong way.
    } else {
      // No journey active — use independent proximity tracking
      const primaryEnriched = enrichedVehicles.filter(v => relevantRoutes.includes(v.routeId) || (v.isHZPP && relevantRoutes.includes('HŽPP')));
      best = getBestVehicle(primaryEnriched, trackedId);
      
      // FALLBACK: If the schedule planner found 0 routes, but there are vehicles driving around...
      // Just lock onto ANY vehicle that is heading towards the destination!
      if (!best && enrichedVehicles.length > 0) {
        best = getBestVehicle(enrichedVehicles, trackedId);
      }
    }

    if (best) {
      // Detect target swap (including the case where hasPassed forced re-selection)
      if (trackedId && trackedId !== best.id) {
        const prevVehicle = enrichedVehicles.find(v => v.id === trackedId);
        const reason = prevVehicle && !prevVehicle.approachingTarget && prevVehicle.distToTarget > 0.5
          ? '⟳ VEHICLE PASSED — LOCKED ONTO NEXT'
          : '⟳ TARGET SWAP — NOW TRACKING';
        showToast(`${reason} ${best.routeId}`);
        logEvent('ROUTING', `Target changed to vehicle ${best.id} (route ${best.routeId})`);
      }
      setTrackedId(best.id);

      // Debug: log tracked vehicle metrics on every ping
      // logEvent('TRACK', `[${best.id.slice(-5)}] spd=${best.speed}km/h eff=${Math.max(best.speed > 10 ? best.speed : 32, 16)}km/h dist=${best.distToTarget}km rawETA=${best.etaToTarget.toFixed(1)}m approaching=${best.approachingTarget} heading=${Math.round(best.heading)}°`);

      // Smooth ETA blending
      setLiveEta(prev => {
        const raw = best.etaToTarget;
        let next: number;
        if (prev === null || Math.abs(prev - raw) > 3) {
          next = raw;
        } else {
          next = prev * 0.6 + raw * 0.4;
        }
        // logEvent('ETA', `prev=${prev?.toFixed(1) ?? 'null'} raw=${raw.toFixed(1)} blended=${next.toFixed(1)} jump=${prev !== null ? Math.abs(prev - raw).toFixed(1) : 'N/A'}`);
        return next;
      });

      // Phase detection
      if (position && targetStop) {
        const distToTarget = haversineM(position.lat, position.lon, targetStop.lat, targetStop.lon);
        if (distToTarget > WALK_RADIUS_ENTER) {
          setPhase('train');
        } else if (best.etaToTarget <= 5) {
          setPhase('extract');
        } else {
          setPhase('walk');
        }
      }

      // Notification
      if (best.etaToTarget <= 5 && !notifiedRef.current) {
        notifiedRef.current = true;
        showToast(`⚠ EXTRACTION IN ${Math.round(best.etaToTarget)} MIN — MOVE NOW ⚠`);
        sendNotification(best.etaToTarget, targetStop?.name || 'STOP');
      }
      if (best.etaToTarget > 7) notifiedRef.current = false;

    } else {
      setTrackedId(null);
      setLiveEta(null);
    }
  }, [rawVehicles, activeLeg, position, activeChainIndex]);


  const sendNotification = (eta: number, stopName: string) => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification('⚠ ZET ROYALE', {
        body: `Vehicle arriving at ${stopName} in ~${Math.round(eta)} min. MOVE!`,
        tag: 'zetroyale',
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  };

  // ── Computed values ──
  let targetStop = activeLeg.type !== 'idle' ? activeLeg.to : null;
  
  if (activeLeg.type !== 'idle') {
    if (activeChainLegs && activeChainLegs.length > 0 && activeChainLegs[0].departureStop) {
      targetStop = activeChainLegs[0].departureStop;
    } else if (discoveredRouteDetails && discoveredRouteDetails.length > 0) {
      // Find the first route that actually has a boarding stop near the user
      const firstLeg = discoveredRouteDetails.find(r => r && r.departureStop);
      if (firstLeg) {
        targetStop = firstLeg.departureStop;
      }
    }
  }
  
  if (!targetStop || targetStop.id === (activeLeg as any).to?.id) {
    if (activeLeg.type !== 'idle' && (activeLeg as any).from && (activeLeg as any).from.id !== 'wild' && position) {
      if ((activeLeg as any).from.type !== 'home') {
        const distToOrigin = haversineM(position.lat, position.lon, (activeLeg as any).from.lat, (activeLeg as any).from.lon);
        if (distToOrigin < 1500) {
          targetStop = (activeLeg as any).from;
        }
      }
    }
  }
  const trackedVehicle = enriched.find(v => v.id === trackedId) || null;
  
  let busEta = trackedVehicle?.etaToTarget ?? null;
  if (busEta === null) {
    // If no live vehicle, prioritize the ACTUAL fetched GTFS schedule for the active leg!
    if (legSchedules[0]?.scheduled) {
      const [h, m] = legSchedules[0].scheduled.split(':').map(Number);
      const now = new Date();
      let schedMins = h * 60 + m;
      const currentMins = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
      if (schedMins < currentMins - 120) schedMins += 24 * 60; // Handle midnight rollover
      busEta = Math.max(0, schedMins - currentMins);
    } else if (journey?.legs?.[0]?.scheduledDeparture) {
      // Use the scheduled departure from the journey chain (available immediately, no fetch needed)
      const depStr = journey.legs[0].scheduledDeparture!;
      const [h, m, s] = depStr.split(':').map(Number);
      const now = new Date();
      let schedMins = h * 60 + m + (s || 0) / 60;
      const currentMins = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
      if (schedMins < currentMins - 120) schedMins += 24 * 60;
      busEta = Math.max(0, schedMins - currentMins);
    } else {
      // Fallback to routing engine's phantom timetable if schedule hasn't loaded yet
      busEta = journey?.legs?.[0]?.vehicleEtaToBoardStop ?? null;
    }
  }
  
  const busDist = trackedVehicle?.distToTarget ?? null;

  // On HŽPP legs, override busEta with minutes until next train departure (second precision)
  let hzppMinsUntil: number | null = null;
  if (isHzppLeg && hzppSchedule.length > 0) {
    const nextTrain = hzppSchedule[0];
    const [dH, dM, dS] = nextTrain.departure.split(':').map(Number);
    const now = new Date();
    const depSecs = dH * 3600 + dM * 60 + (dS || 0);
    const nowSecs = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    hzppMinsUntil = (depSecs - nowSecs) / 60;
    busEta = hzppMinsUntil; // feed into ring
  }

  let walkMin: number | null = null;
  let bufferMin: number | null = null;

  if (position && targetStop && targetStop.lat !== 0) {
    walkMin = walkingTime(position.lat, position.lon, targetStop.lat, targetStop.lon);
    if (busEta !== null) {
      bufferMin = busEta - walkMin;
    }
  }

  // Ultimate destination computation for tracked bus
  let ultimateDestName = '';
  let destEtaStr = '';
  
  // ── Auto-Recalculate Impossible Routes ──
  // (Logic moved to the main render loop to prevent conflicting reroutes and route flapping)
  const uncatchableStartTimeRef = useRef<number | null>(null);

  // If we are tracking a vehicle, the "main" UI destination should be the bus's true terminus!
  // And the "LIVE CALC" sub-panel should show the ETA to our own active leg destination (if it's along the way).
  const isUserOnVehicle = !!(trackedVehicle && position && (phase === 'train' || (haversineM(position.lat, position.lon, trackedVehicle.lat, trackedVehicle.lon) < 200)));

  let displayMainTarget = (journey?.legs?.[0]?.exitStop?.name || targetStop?.name || 'NONE').toUpperCase();
  let displayLegLabel = activeLeg.type !== 'idle' ? `${activeLeg.from.name} → ${activeLeg.to.name}` : 'NO ROUTE CONFIGURED';

  if (trackedVehicle) {
    const trueDest = trackedVehicle.trueDest;
    if (trueDest) {
      displayLegLabel = `ROUTE ${trackedVehicle.routeId} · HEADSIGN: ${trueDest.name}`;
    } else {
      displayLegLabel = `ROUTE ${trackedVehicle.routeId} · HEADSIGN: ${trackedVehicle.headsign || 'UNKNOWN'}`;
    }

    if (activeLeg.type !== 'idle' && activeLeg.to) {
      ultimateDestName = activeLeg.to.name;
      const distToUlt = haversineM(trackedVehicle.lat, trackedVehicle.lon, activeLeg.to.lat, activeLeg.to.lon);
      const speed = Math.max(10, Math.min(60, trackedVehicle.speed || 25));
      const busEtaToUltimate = Math.round((distToUlt / 1000) / speed * 60);
      
      const arrDate = new Date();
      arrDate.setMinutes(arrDate.getMinutes() + busEtaToUltimate);
      destEtaStr = `${String(arrDate.getHours()).padStart(2, '0')}:${String(arrDate.getMinutes()).padStart(2, '0')}`;
    }
  }
  // Status logic
  let statusClass = 'safe';
  let statusText = 'WAITING FOR DATA';
  let timerColor = '#fff';

  if (!trackedVehicle && busEta === null) {
    statusText = `NO MATCHING VEHICLE (${enriched.length} in sector)`;
  } else if (bufferMin !== null) {
    if (bufferMin >= 3) {
      statusClass = 'safe';
      statusText = `✓ SAFE ZONE — ${Math.round(bufferMin)}m BUFFER`;
    } else if (bufferMin >= 0) {
      statusClass = 'risk';
      statusText = '⚠ CUTTING IT CLOSE — SPEED UP';
      timerColor = 'var(--amber)';
    } else {
      statusClass = 'danger';
      statusText = `⛔ EVACUATION ZONE — ${Math.round(-bufferMin)}m LATE`;
      timerColor = 'var(--red)';
    }
  } else if (busEta !== null) {
    if (busEta <= 5) {
      statusClass = 'danger';
      statusText = '⚠ VEHICLE ARRIVING — MOVE NOW';
      timerColor = 'var(--red)';
    } else if (busEta <= 10) {
      statusClass = 'risk';
      statusText = `⚡ VEHICLE IN ${Math.round(busEta)} MIN — PREPARE`;
      timerColor = 'var(--amber)';
    } else {
      statusClass = 'safe';
      statusText = 'ENABLE GPS FOR RING TRACKING';
    }
  }

  // Phase badge text
  let badgeText = '🚶 APPROACH MODE';
  if (phase === 'train') badgeText = '🚂 TRANSIT MODE — APPROACHING';
  if (phase === 'extract') badgeText = '⚠ EXTRACTION MODE — MOVE NOW';
  if (activeLeg.type === 'idle') badgeText = '⚙ CONFIGURE TRANSIT GRAPH';

  // HŽPP-specific overrides — use BUFFER as source of truth (inside ring = safe)
  if (isHzppLeg && hzppMinsUntil !== null) {
    if (hzppMinsUntil <= 0) {
      badgeText = '⚠ TRAIN DEPARTING — RUN';
    } else if (bufferMin !== null && bufferMin < 0) {
      badgeText = '⛔ OUTSIDE RING — WON\'T MAKE IT';
    } else if (bufferMin !== null && bufferMin < 2) {
      badgeText = '⚠ TIGHT — START WALKING';
    } else if (bufferMin !== null && bufferMin >= 2) {
      badgeText = '✓ YOU\'RE GOOD — TRAIN TRACKED';
    } else {
      badgeText = '🚂 HŽPP — NEXT TRAIN TRACKED';
    }
  }

  // Timer display
  const effectiveEta = isHzppLeg ? hzppMinsUntil : (liveEta !== null ? liveEta : busEta);
  const timerDisplay = effectiveEta !== null ? fmtTime(effectiveEta) : '--:--';



  const profileLocations = getAllLocations(profile);

  // Open settings if no profile configured at all
  useEffect(() => {
    if (!profileLoaded) return;
    if (!profile) return;
    const hasHome = profile.home && profile.home.lat !== 0;
    const hasHubs = profile.hubs.length > 0;
    const hasDest = profile.destinations.length > 0;
    if (!hasHome && !hasHubs && !hasDest) {
      setActiveNav('settings');
    }
  }, [profile, profileLoaded]);

  // We no longer guess ghostActualTarget.
  // Direction check — use computed heading, fall back to API bearing for instant results
  let isTargetAlongTheWay = false;
  if (selectedGhost && targetStop && targetStop.lat !== 0) {
    const ghostDir = selectedGhost.heading !== 0 ? selectedGhost.heading : (selectedGhost.bearing || 0);
    if (ghostDir !== 0) {
      const brngToTarget = calculateHeading(selectedGhost.lat, selectedGhost.lon, targetStop.lat, targetStop.lon);
      let angleDiff = Math.abs(ghostDir - brngToTarget);
      if (angleDiff > 180) angleDiff = 360 - angleDiff;
      if (angleDiff <= 90) isTargetAlongTheWay = true;
    }
    // heading === 0 means no data — leave false, don't guess
  }

  // Fetch official timetable to compare Ghost ETA
  useEffect(() => {
    // We prioritize checking the timetable of the headsign (Terminus) because it's the main destination.
    // If it doesn't exist, we fallback to the active targetStop if it's along the way.
    let timetableTargetName = '';
    let distToTarget = 0;

    if (!selectedGhost || activeLeg.type === 'idle') {
      setGhostScheduleInfo(null);
      return;
    }

    if (selectedGhost.terminusLat && selectedGhost.terminusLon) {
      // Use full stop name (terminusName) for search, not abbreviated headsign
      timetableTargetName = selectedGhost.terminusName || selectedGhost.headsign || '';
      distToTarget = haversineM(selectedGhost.lat, selectedGhost.lon, selectedGhost.terminusLat, selectedGhost.terminusLon);
    } else if (isTargetAlongTheWay && targetStop) {
      timetableTargetName = targetStop.name;
      distToTarget = haversineM(selectedGhost.lat, selectedGhost.lon, targetStop.lat, targetStop.lon);
    } else {
      setGhostScheduleInfo(null);
      return; // Nothing to fetch
    }

    const speed = Math.max(10, Math.min(60, selectedGhost.speed || 25));
    const busEtaMins = Math.round((distToTarget / 1000) / speed * 60);

    const now = new Date();
    const liveArrDate = new Date(now.getTime() + busEtaMins * 60000);
    const liveMinsAbs = liveArrDate.getHours() * 60 + liveArrDate.getMinutes();

    fetch(`/api/stops?q=${encodeURIComponent(timetableTargetName)}&limit=15`)
      .then(res => res.json())
      .then(data => {
        if (!data.stops || data.stops.length === 0) return; // No stops found — silent
        const matched = data.stops.find((s: any) => s.routes && s.routes.includes(selectedGhost.routeId)) || data.stops[0];
        return fetch(`/api/schedule?stopId=${matched.id}`);
      })
      .then(res => { if (res) return res.json(); })
      .then(data => {
        if (!data || !data.upcoming) return;
        const routeDeps = data.upcoming.filter((d: any) => d.route === selectedGhost.routeId);
        if (routeDeps.length > 0) {
          let closestDep = routeDeps[0];
          let minDiff = 9999;
          for (const dep of routeDeps) {
            if (!dep.departure) continue;
            const [h, m] = dep.departure.split(':').map(Number);
            const schedMinsAbs = h * 60 + m;
            const diff = liveMinsAbs - schedMinsAbs;
            if (Math.abs(diff) < Math.abs(minDiff)) {
              minDiff = diff;
              closestDep = dep;
            }
          }
          setGhostScheduleInfo({
            scheduled: closestDep.departure.substring(0, 5),
            diff: Math.abs(minDiff),
            isLate: minDiff > 0
          });
        }
      })
      .catch(() => { /* Schedule lookup failed — non-critical */ });

  }, [selectedGhost, isTargetAlongTheWay, targetStop, activeLeg.type]);

  // ── Fetch Timetables for active journey legs ──
  useEffect(() => {
    if (!journey || !journey.legs) return;

    journey.legs.forEach(leg => {
      const { legIndex, route, boardStop, exitStop } = leg;
      const cacheKey = `${legIndex}_${route}_${boardStop.id}`;

      // Prevent duplicate fetches
      (window as any).__legSchedCache = (window as any).__legSchedCache || {};
      
      const cached = (window as any).__legSchedCache[cacheKey];
      if (cached) {
        if (cached.fetching) return; // Currently fetching, just wait
        if (cached.data && (Date.now() - cached.ts) < 5 * 60000) {
          setLegSchedules(prev => {
            if (prev[legIndex]?.scheduled === cached.data.scheduled) return prev;
            return { ...prev, [legIndex]: cached.data };
          });
          return;
        }
      }

      (window as any).__legSchedCache[cacheKey] = { fetching: true, ts: Date.now() };

      const isHzpp = route.toUpperCase() === 'HŽPP';
      const url = isHzpp
        ? `/api/hzpp-schedule?from=${boardStop.id}&to=${exitStop.id}`
        : `/api/schedule?stopId=${boardStop.id}`;

      fetch(url)
        .then(res => res.json())
        .then(data => {
          let scheduledTime = null;
          
          const now = new Date();
          const currentMinsAbs = now.getHours() * 60 + now.getMinutes();
          const targetMinsAbs = currentMinsAbs + (leg.timeUserArrivesAtBoardStop || 0);

          // We must use the FULL schedule (trains/departures) because a late vehicle's 
          // scheduled time might have already passed the current time!
          const fullSchedule = isHzpp ? data.trains : data.departures;

          if (fullSchedule && fullSchedule.length > 0) {
             // For HŽPP, if we are tracking a specific train, we know its routeId (e.g. 8023)
             let activeRouteDeps = fullSchedule;
             if (isHzpp && leg.vehicle) {
               activeRouteDeps = fullSchedule.filter((d: any) => d.route === leg.vehicle.routeId || d.trainNumber == leg.vehicle.routeId);
             } else if (!isHzpp) {
               activeRouteDeps = fullSchedule.filter((d: any) => d.route === route);
             }

             if (activeRouteDeps.length > 0) {
               // Accurate sort by absolute minutes to fix any GTFS string-sort bugs
               activeRouteDeps.sort((a: any, b: any) => {
                 const [ah, am] = a.departure.split(':').map(Number);
                 const [bh, bm] = b.departure.split(':').map(Number);
                 return (ah * 60 + am) - (bh * 60 + bm);
               });

               let closestDep = activeRouteDeps[0];
               let minDiff = 9999;
               
               for (const dep of activeRouteDeps) {
                 if (!dep.departure) continue;
                 const [h, m] = dep.departure.split(':').map(Number);
                 const schedMinsAbs = h * 60 + m;
                 
                 // If we have a live vehicle, we match the schedule to the VEHICLE's live ETA
                 if (leg.vehicle && leg.vehicleEtaToBoardStop !== 99) {
                   const liveMinsAbs = currentMinsAbs + leg.vehicleEtaToBoardStop;
                   const diffToLive = Math.abs(schedMinsAbs - liveMinsAbs);
                   if (diffToLive < minDiff) {
                     minDiff = diffToLive;
                     closestDep = dep;
                   }
                 } else {
                   // If we don't have a live vehicle, we just want the first schedule AFTER the user arrives
                   const diffToUser = schedMinsAbs - targetMinsAbs;
                   if (diffToUser >= -2 && diffToUser < minDiff) {
                     minDiff = diffToUser;
                     closestDep = dep;
                   }
                 }
               }

               let next3: string[] = [];
               if (minDiff !== 9999) {
                 scheduledTime = closestDep.departure.substring(0, 5);
                 const closestIdx = activeRouteDeps.indexOf(closestDep);
                 next3 = activeRouteDeps.slice(closestIdx + 1, closestIdx + 4).map((d: any) => d.departure.substring(0, 5));
               } else {
                 scheduledTime = activeRouteDeps[activeRouteDeps.length - 1].departure.substring(0, 5);
               }

               const schedData = { scheduled: scheduledTime, next: next3 };
               (window as any).__legSchedCache[cacheKey] = { fetching: false, ts: Date.now(), data: schedData };
               setLegSchedules(prev => ({ ...prev, [legIndex]: schedData }));
             } else {
               (window as any).__legSchedCache[cacheKey] = { fetching: false, ts: Date.now(), data: { scheduled: null } };
             }
          } else {
             (window as any).__legSchedCache[cacheKey] = { fetching: false, ts: Date.now(), data: { scheduled: null } };
          }
        })
        .catch(e => {
          console.error('Leg schedule fetch failed:', e);
          (window as any).__legSchedCache[cacheKey] = { fetching: false, ts: Date.now(), data: { scheduled: null } };
        });
    });
  }, [journey]);

  // Ghost Popup Computation
  let ghostEtaStr = '';
  let ghostEtaTargetName = '';
  let ghostUltimateDestName = '';
  let ghostUltimateEtaStr = '';
  
  if (selectedGhost) {
    const trueDest = selectedGhost.trueDest;
    if (trueDest) {
      ghostUltimateDestName = trueDest.name;
      const distToUlt = haversineM(selectedGhost.lat, selectedGhost.lon, trueDest.lat, trueDest.lon);
      const speed = Math.max(10, Math.min(60, selectedGhost.speed || 25));
      const busEtaToUltimate = Math.round((distToUlt / 1000) / speed * 60);
      
      const arrUltDate = new Date();
      arrUltDate.setMinutes(arrUltDate.getMinutes() + busEtaToUltimate);
      ghostUltimateEtaStr = `${String(arrUltDate.getHours()).padStart(2, '0')}:${String(arrUltDate.getMinutes()).padStart(2, '0')}`;
    }

    if (isTargetAlongTheWay && targetStop) {
      ghostEtaTargetName = targetStop.name;
      const distToTarget = haversineM(selectedGhost.lat, selectedGhost.lon, targetStop.lat, targetStop.lon);
      const speed = Math.max(10, Math.min(60, selectedGhost.speed || 25));
      const busEtaToTarget = Math.round((distToTarget / 1000) / speed * 60);
      
      const arrDate = new Date();
      arrDate.setMinutes(arrDate.getMinutes() + busEtaToTarget);
      ghostEtaStr = `${String(arrDate.getHours()).padStart(2, '0')}:${String(arrDate.getMinutes()).padStart(2, '0')}`;
    }
  }

  // Stop Popup Computation
  let stopPopupEtaStr = '';
  let stopPopupWalkStr = '';
  if (selectedStopPopup) {
    if (trackedVehicle) {
      const distToStop = haversineM(trackedVehicle.lat, trackedVehicle.lon, selectedStopPopup.lat, selectedStopPopup.lon);
      const speed = Math.max(10, Math.min(60, trackedVehicle.speed || 25));
      const busEtaToStop = Math.round((distToStop / 1000) / speed * 60);
      const arrDate = new Date();
      arrDate.setMinutes(arrDate.getMinutes() + busEtaToStop);
      stopPopupEtaStr = `${String(arrDate.getHours()).padStart(2, '0')}:${String(arrDate.getMinutes()).padStart(2, '0')} (${busEtaToStop} MIN)`;
    }
    if (position) {
      const walkMin = walkingTime(position.lat, position.lon, selectedStopPopup.lat, selectedStopPopup.lon);
      stopPopupWalkStr = `${fmtMin(walkMin)}`;
    }
  }

  // Transfer stops: We need both WHERE TO GET OFF (exitStop) and WHERE TO BOARD (next boardStop)
  const transferBoardStops: any[] = [];
  const transferExitStops: any[] = [];
  const transferWalkLines: { from: [number, number], to: [number, number] }[] = [];

  if (journey && journey.legs && journey.legs.length > 0) {
    for (let i = 0; i < journey.legs.length; i++) {
      const currentLeg = journey.legs[i];
      
      transferExitStops.push({
        ...currentLeg.exitStop,
        type: 'transfer_exit',
        label: `GET OFF HERE`
      });

      if (i < journey.legs.length - 1) {
        const nextLeg = journey.legs[i + 1];
        transferBoardStops.push({
          ...nextLeg.boardStop,
          type: 'transfer_board',
          label: `BOARD ${nextLeg.route} HERE`,
          nextRoute: nextLeg.route
        });

        transferWalkLines.push({
          from: [currentLeg.exitStop.lat, currentLeg.exitStop.lon],
          to: [nextLeg.boardStop.lat, nextLeg.boardStop.lon]
        });
      }
    }
  }

  // Pass the actual transfer stops data to the map so they render
  const transferStops: any[] = [...transferExitStops, ...transferBoardStops];

  let trackedVehicleDeviation: string | null = null;
  if (journey && trackedVehicle) {
    const legIdx = journey.legs.findIndex(l => l.vehicle?.id === (trackedVehicle as any).id);
    if (legIdx !== -1 && legSchedules[legIdx] && legSchedules[legIdx].scheduled && journey.legs[legIdx].vehicleEtaToBoardStop !== 99) {
      const now = new Date();
      const liveMinsAbs = now.getHours() * 60 + now.getMinutes() + journey.legs[legIdx].vehicleEtaToBoardStop;
      const [h, m] = legSchedules[legIdx].scheduled.split(':').map(Number);
      const schedMinsAbs = h * 60 + m;
      const diff = Math.round(liveMinsAbs - schedMinsAbs);
      if (diff === 0) trackedVehicleDeviation = 'ON TIME';
      else if (diff > 0) trackedVehicleDeviation = `+${diff}m LATE`;
      else trackedVehicleDeviation = `-${Math.abs(diff)}m EARLY`;
    }
  }
  if (!trackedVehicleDeviation && selectedGhost && ghostScheduleInfo) {
    if (ghostScheduleInfo.diff === 0) trackedVehicleDeviation = 'ON TIME';
    else if (ghostScheduleInfo.diff > 0) trackedVehicleDeviation = `+${ghostScheduleInfo.diff}m LATE`;
    else trackedVehicleDeviation = `-${Math.abs(ghostScheduleInfo.diff)}m EARLY`;
  }

  return (
    <>
      {/* MAP */}
      <TacticalMap
        vehicles={enriched}
        trackedId={trackedId}
        trackedDeviation={trackedVehicleDeviation}
        userLat={position?.lat ?? null}
        userLon={position?.lon ?? null}
        targetStop={targetStop ?? null}
        transferStops={transferStops}
        profileLocations={profileLocations}
        busEta={busEta}
        relevantRoutes={relevantRoutes}
        activeLeg={activeLeg}
        transferWalkLines={transferWalkLines}
        showHubs={showHubs}
        showStops={showStops}
        autoFollow={activeNav === 'track' ? 'tracked' : activeNav === 'me' ? 'user' : null}
        onMapDrag={() => setActiveNav('none')}
        onVehicleClick={(v) => setSelectedGhost(v)}
        onStopClick={(s) => {
          setSelectedHub({ name: s.name, lat: s.lat, lon: s.lon, routes: s.routes || [] });
          setSelectedGhost(null);
          setHubArrivals([]);
          const url = `/api/hub-arrivals?lat=${s.lat}&lon=${s.lon}&name=${encodeURIComponent(s.name)}&stopId=${encodeURIComponent(s.id)}${s.heading !== undefined ? `&heading=${s.heading}` : ''}`;
      
      fetch(url)
            .then(r => r.json())
            .then(data => {
              setHubArrivals(data.arrivals || []);
              if (data.activeRoutes) {
                setSelectedHub(prev => prev ? { ...prev, routes: data.activeRoutes } : prev);
              }
            })
            .catch(() => setHubArrivals([]));
        }}
        onMapClick={() => { setSelectedGhost(null); setSelectedStopPopup(null); setSelectedHub(null); }}
        onHubClick={(hub) => {
          setSelectedHub(hub);
          setSelectedGhost(null);
          setSelectedStopPopup(null);
          setHubArrivals([]);
          fetch(`/api/hub-arrivals?lat=${hub.lat}&lon=${hub.lon}&name=${encodeURIComponent(hub.name)}`)
            .then(r => r.json())
            .then(data => {
              setHubArrivals(data.arrivals || []);
              if (data.activeRoutes) {
                setSelectedHub(prev => prev ? { ...prev, routes: data.activeRoutes } : prev);
              }
            })
            .catch(() => setHubArrivals([]));
        }}
        onMapCenterChange={(lat, lon) => {
          setPickLat(lat);
          setPickLon(lon);
        }}
      />
      {/* GHOST VEHICLE POPUP */}
      {selectedGhost && (
        <div style={{
          position: 'absolute',
          top: '90px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10000,
          background: 'rgba(10, 15, 20, 0.95)',
          border: '1px solid var(--cyan)',
          borderRadius: '8px',
          padding: '12px',
          width: '280px',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.8)',
          backdropFilter: 'blur(10px)',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--cyan)', fontWeight: 700, fontFamily: "'Orbitron', monospace" }}>{(selectedGhost as any).isHZPP ? '🚂 TRAIN' : parseInt(selectedGhost.routeId) <= 17 ? '🚃 TRAM' : '🚌 BUS'} {selectedGhost.id.slice(-5)}</span>
            <button 
              onClick={() => setSelectedGhost(null)}
              style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '16px', padding: '0 4px' }}
            >×</button>
          </div>
          
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
            ROUTE: <span style={{ color: '#fff', fontWeight: 700 }}>{selectedGhost.routeId}</span>
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
            SPEED: <span style={{ color: '#fff', fontWeight: 700 }}>{Math.round(selectedGhost.speed || 0)} KM/H</span>
          </div>

          {/* NEXT STOP INFO — with schedule deviation */}
          {(selectedGhost as any).nextStopName && (
            <div style={{
              marginTop: '6px',
              padding: '8px',
              background: 'rgba(0, 255, 213, 0.08)',
              border: '1px solid rgba(0, 255, 213, 0.3)',
              borderRadius: '6px',
            }}>
              <div style={{ fontSize: '10px', color: 'var(--cyan)', letterSpacing: '1px', marginBottom: '4px' }}>NEXT STOP</div>
              <div style={{ fontSize: '14px', color: '#fff', fontWeight: 700, fontFamily: "'Orbitron', monospace" }}>
                {(selectedGhost as any).nextStopName.toUpperCase()}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--cyan)', marginTop: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>ETA: <span style={{ fontWeight: 700, fontSize: '16px' }}>{(selectedGhost as any).nextStopEta}m</span></span>
                {(selectedGhost as any).scheduledArrival && (
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px' }}>
                    SCHED: {(selectedGhost as any).scheduledArrival}
                  </span>
                )}
              </div>

              {/* SCHEDULE DEVIATION BADGE */}
              {(selectedGhost as any).scheduleDeviation !== null && (selectedGhost as any).scheduleDeviation !== undefined && (() => {
                const dev = (selectedGhost as any).scheduleDeviation;
                const isLate = dev > 0;
                const isEarly = dev < 0;
                const isOnTime = dev === 0;
                const color = isOnTime ? 'var(--cyan)' : isLate ? 'var(--red)' : 'var(--green)';
                const bg = isOnTime ? 'rgba(0,255,213,0.12)' : isLate ? 'rgba(255,45,45,0.15)' : 'rgba(0,255,106,0.12)';
                const label = isOnTime ? '✓ ON TIME' : isLate ? `+${dev}m LATE` : `${dev}m EARLY`;
                return (
                  <div style={{
                    marginTop: '6px',
                    padding: '5px 8px',
                    background: bg,
                    border: `1px solid ${color}`,
                    borderRadius: '4px',
                    fontSize: '12px',
                    fontWeight: 800,
                    fontFamily: "'Orbitron', monospace",
                    color: color,
                    textAlign: 'center',
                    letterSpacing: '1px'
                  }}>
                    {label}
                  </div>
                );
              })()}

              {(selectedGhost as any).prevStopName && (
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', marginTop: '4px' }}>
                  LAST STOP: {(selectedGhost as any).prevStopName.toUpperCase()}
                </div>
              )}
            </div>
          )}

          {/* HEADSIGN — final destination */}
          {(selectedGhost as any).headsign && (
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>
              DESTINATION: <span style={{ color: '#ffd600', fontWeight: 700 }}>{(selectedGhost as any).headsign.toUpperCase()}</span>
            </div>
          )}
          
          {/* PRIMARY: Where this bus is ACTUALLY heading */}
          {ghostUltimateDestName && (
            <div style={{ 
              marginTop: '4px',
              paddingTop: '8px', 
              borderTop: '1px solid rgba(255,255,255,0.1)',
              fontSize: '11px',
              color: 'var(--cyan)'
            }}>
              ETA {ghostUltimateDestName.toUpperCase()}: <span style={{ fontWeight: 700, fontSize: '14px', float: 'right' }}>{ghostUltimateEtaStr || '...'}</span>
            </div>
          )}
          
          {/* SECONDARY: User's target stop, ONLY if bus is heading toward it */}
          {ghostEtaStr && ghostEtaTargetName && ghostUltimateDestName && ghostEtaTargetName.toLowerCase() !== ghostUltimateDestName.toLowerCase() && (
            <div style={{ 
              marginTop: '0px',
              fontSize: '11px',
              color: 'rgba(255, 255, 255, 0.5)'
            }}>
              ETA {ghostEtaTargetName.toUpperCase()}: <span style={{ fontWeight: 700, fontSize: '13px', float: 'right' }}>{ghostEtaStr}</span>
            </div>
          )}
          
          {ghostScheduleInfo && (
            <div style={{ 
              marginTop: '4px',
              padding: '6px', 
              background: 'rgba(0,0,0,0.5)',
              borderRadius: '4px',
              fontSize: '10px',
              color: 'rgba(255,255,255,0.6)',
              display: 'flex',
              justifyContent: 'space-between'
            }}>
              <span>TIMETABLE: <strong style={{color: '#fff'}}>{ghostScheduleInfo.scheduled}</strong></span>
              <span style={{ color: ghostScheduleInfo.diff === 0 ? 'var(--cyan)' : ghostScheduleInfo.isLate ? 'var(--red)' : '#00ff6a' }}>
                {ghostScheduleInfo.diff === 0 ? 'ON TIME' : `${ghostScheduleInfo.diff}m ${ghostScheduleInfo.isLate ? 'LATE' : 'EARLY'}`}
              </span>
            </div>
          )}
          <button
            onClick={() => {
              setManualTrackedId(selectedGhost.id);
              setActiveNav('track');
              setSelectedGhost(null);
              // Force the map to pan immediately if mapNav is available
              setTimeout(() => {
                if ((window as any).__mapNav) (window as any).__mapNav.flyToTracked();
              }, 50);
            }}
            style={{
              marginTop: '12px',
              padding: '12px',
              background: 'var(--cyan)',
              color: '#000',
              border: 'none',
              borderRadius: '6px',
              fontWeight: 800,
              fontSize: '14px',
              fontFamily: "'Orbitron', monospace",
              cursor: 'pointer',
              textTransform: 'uppercase'
            }}
          >
            TRACK THIS VEHICLE
          </button>
        </div>
      )}

      {/* HUB DEPARTURE BOARD */}
      {selectedHub && (() => {
        // Sort: arrived first, then by minutes away
        const sorted = [...hubArrivals].sort((a, b) => {
          if (a.isArrived && !b.isArrived) return -1;
          if (!a.isArrived && b.isArrived) return 1;
          return a.minutesAway - b.minutesAway;
        });

        return (
        <div style={{
          position: 'absolute',
          top: '60px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10000,
          background: 'rgba(10, 12, 18, 0.96)',
          border: '1px solid var(--amber)',
          borderRadius: '12px',
          width: 'min(92vw, 380px)',
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(255, 214, 0, 0.15)',
          backdropFilter: 'blur(16px)',
          overflow: 'hidden',
        }}>
          {/* FIXED: Header */}
          <div style={{ padding: '14px 14px 0 14px', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <div>
                <div style={{ fontSize: '10px', color: 'var(--amber)', letterSpacing: '2px', fontFamily: "'Rajdhani', sans-serif" }}>DEPARTURES</div>
                <div style={{ fontSize: '16px', color: '#fff', fontWeight: 800, fontFamily: "'Orbitron', monospace", letterSpacing: '1px' }}>
                  ◆ {selectedHub.name.toUpperCase()}
                </div>
              </div>
              <div
                onClick={() => setSelectedHub(null)}
                style={{ cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '20px', padding: '4px 8px' }}
              >✕</div>
            </div>

            {/* FIXED: Route pills — tappable */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '10px' }}>
              {selectedHub.routes.map((r: string) => (
                <span key={r} 
                  onClick={() => {
                    // Find first arrival row for this route and scroll to it + highlight
                    const el = document.querySelector(`[data-hub-route="${r}"]`);
                    if (el) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      (el as HTMLElement).style.background = 'rgba(255, 214, 0, 0.25)';
                      (el as HTMLElement).style.transition = 'background 0.8s ease-out';
                      setTimeout(() => {
                        (el as HTMLElement).style.background = 'transparent';
                      }, 800);
                    }
                  }}
                  style={{
                    padding: '2px 8px',
                    background: 'rgba(255, 214, 0, 0.15)',
                    border: '1px solid rgba(255, 214, 0, 0.3)',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: 'var(--amber)',
                    fontFamily: "'Orbitron', monospace",
                    cursor: 'pointer'
                  }}>{r}</span>
              ))}
            </div>

            {/* Divider */}
            <div style={{ height: '1px', background: 'rgba(255, 214, 0, 0.2)' }} />
          </div>

          {/* SCROLLABLE: Arrivals list only */}
          <div style={{ overflowY: 'auto', padding: '4px 14px 14px 14px', flex: 1 }}>
            {sorted.length === 0 && (
              <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.4)', padding: '20px 0', fontSize: '12px', fontFamily: "'Orbitron', monospace" }}>
                NO MORE SERVICE TODAY
              </div>
            )}
            {sorted.map((a: any, i: number) => {
              const icon = a.routeType === 0 ? '🚋' : a.routeType === 2 ? '🚂' : '🚌';
              const devColor = a.isArrived ? 'var(--cyan)' : 
                a.deviation !== null && a.deviation > 2 ? 'var(--red)' : 
                a.deviation !== null && a.deviation < -1 ? 'var(--green)' : 'rgba(255,255,255,0.5)';
              const devLabel = a.isArrived ? '● HERE' : 
                a.isLive && a.deviation !== null && a.deviation > 0 ? `+${a.deviation}m` :
                a.isLive && a.deviation !== null && a.deviation < 0 ? `${a.deviation}m` :
                a.isLive ? '● LIVE' : '';

              return (
                <div key={a.tripId || i} 
                  data-hub-route={a.routeId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 4px',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    gap: '6px',
                    borderRadius: '4px',
                  }}>
                  {/* Left: icon + route + destination */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: '14px' }}>{icon}</span>
                    <span style={{
                      fontFamily: "'Orbitron', monospace",
                      fontSize: '13px',
                      fontWeight: 800,
                      color: '#fff',
                      minWidth: '32px'
                    }}>{a.routeId}</span>
                    <span style={{
                      fontSize: '10px',
                      color: 'rgba(255,255,255,0.5)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>→ {(a.headsign || '').toUpperCase()}</span>
                  </div>

                  {/* Right: scheduled time + ETA + status */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                    <span style={{
                      fontFamily: "'Rajdhani', sans-serif",
                      fontSize: '13px',
                      fontWeight: 700,
                      color: a.minutesAway <= 2 ? 'var(--cyan)' : '#fff'
                    }}>
                      {a.minutesAway === 0 ? 'NOW' : `${a.minutesAway}m`}
                    </span>
                    <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', minWidth: '35px', textAlign: 'right' }}>
                      {a.scheduledArrival}
                    </span>
                    {devLabel && (
                      <span style={{
                        fontSize: '9px',
                        fontWeight: 700,
                        color: devColor,
                        padding: '1px 4px',
                        border: `1px solid ${devColor}`,
                        borderRadius: '3px',
                        minWidth: '36px',
                        textAlign: 'center'
                      }}>{devLabel}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        );
      })()}

      {/* TOP HUD — hidden only in settings */}
      {activeNav !== 'settings' && (
      <div className="top-hud">
        <div className="logo">
          <span className="z">ZET</span>
          <span className="r">ROYALE</span>
        </div>
        <div className="hud-stats">
          <div className="hud-stat">SPD <span>{trackedVehicle?.speed ?? '--'}</span> KM/H</div>
          <div className="hud-stat">DIST <span>{busDist ?? '--'}</span> KM</div>
          <div className="hud-stat">FLEET <span>{stats.vehicleCount}</span> / <span>{stats.routeCount}</span> ROUTES</div>
          <div className="hud-stat">T+ <SessionClock /></div>
        </div>
      </div>
      )}

      {/* PHASE BADGE */}
      {activeNav !== 'settings' && (
      <div className={`phase-badge ${phase}`}>{badgeText}</div>
      )}

      {/* MAIN INFO CARD */}
      {activeNav !== 'settings' && (
      <div className={`info-card ${isHzppLeg ? (bufferMin !== null && bufferMin < 0 ? 'extract' : bufferMin !== null && bufferMin < 2 ? 'risk' : 'walk') : hzppData ? 'extract' : phase}`} style={isHzppLeg ? { border: '2px solid var(--cyan)', boxShadow: '0 0 20px rgba(0,255,213,0.3)' } : hzppData ? { border: '2px solid #FF000A', boxShadow: '0 0 20px rgba(255,0,10,0.5)' } : {}}>
        {isHzppLeg && hzppSchedule.length > 0 ? (() => {
          // HŽPP SCHEDULE MODE: use second-precision countdown
          const nextTrain = hzppSchedule[0];
          const [dH, dM, dS] = nextTrain.departure.split(':').map(Number);
          const [aH, aM] = nextTrain.arrival.split(':').map(Number);
          const now = new Date();
          const depSecs = dH * 3600 + dM * 60 + (dS || 0);
          const nowSecs = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
          const secsUntil = depSecs - nowSecs;
          const minsUntil = secsUntil / 60;
          const journeyMin = (aH * 60 + aM) - (dH * 60 + dM);
          const hzWalkMin = walkMin;
          const hzBuffer = hzWalkMin !== null ? minsUntil - hzWalkMin : null;

          // Format MM:SS countdown
          const countdownMins = Math.floor(Math.max(secsUntil, 0) / 60);
          const countdownSecs = Math.max(secsUntil, 0) % 60;
          const countdownStr = `${String(countdownMins).padStart(2, '0')}:${String(Math.floor(countdownSecs)).padStart(2, '0')}`;

          // Accent color based on buffer
          const accent = hzBuffer !== null ? (hzBuffer < 0 ? '#FF000A' : hzBuffer < 2 ? 'var(--amber)' : 'var(--cyan)') : 'var(--cyan)';

          return (
            <>
              <div className="card-label" style={{ color: accent, fontWeight: 'bold' }}>🚂 HŽPP NEXT TRAIN</div>
              <div className="card-stop" style={{ color: accent, textShadow: `0 0 10px ${accent}` }}>
                {((activeLeg as any).from?.name || '').toUpperCase()} → {((activeLeg as any).to?.name || '').toUpperCase()}
              </div>
              <div className="card-tracked" style={{ color: '#fff' }}>
                TRAIN {nextTrain.trainNumber} · {nextTrain.routeName}
              </div>
              {(() => {
                const isUserOnVehicle = trackedVehicle && position && 
                  (phase === 'train' || (haversineM(position.lat, position.lon, trackedVehicle.lat, trackedVehicle.lon) < 200));

                if (isUserOnVehicle) {
                  // EXIT STOP: actual GTFS station from journey, not the profile destination
                  const exitStop = journey?.legs?.[0]?.exitStop || (activeLeg as any).to;
                  if (exitStop) {
                    const dist = haversineM(trackedVehicle.lat, trackedVehicle.lon, exitStop.lat, exitStop.lon);
                    const spd = Math.max(20, trackedVehicle.speed || 30);
                    const alightEtaMin = Math.round((dist / 1000) / spd * 60);
                    const arrTime = new Date();
                    arrTime.setMinutes(arrTime.getMinutes() + alightEtaMin);
                    const arrClock = `${String(arrTime.getHours()).padStart(2,'0')}:${String(arrTime.getMinutes()).padStart(2,'0')}`;
                    
                    // Next connection: routes from destination profile (exclude train routes)
                    const destRoutes = ((activeLeg as any).to?.connectedRoutes || [])
                      .filter((r: string) => r.toUpperCase() !== 'HŽPP' && !/^\d{4}$/.test(r));
                    const destName = ((activeLeg as any).to?.name || '').toUpperCase();
                    const isUrgent = alightEtaMin <= 2;
                    const ac = isUrgent ? '#FF000A' : '#00ffd5';
                    
                    return (
                      <div style={{ padding: '12px', background: isUrgent ? 'rgba(255,0,10,0.3)' : 'rgba(0,255,213,0.12)', border: `2px solid ${ac}`, borderRadius: '8px', marginTop: '16px', textAlign: 'center', boxShadow: `0 0 20px ${isUrgent ? 'rgba(255,0,10,0.5)' : 'rgba(0,255,213,0.3)'}` }}>
                        <div style={{ color: '#fff', fontSize: '11px', fontWeight: 'bold', letterSpacing: '1px' }}>
                          {isUrgent ? '⚠ PREPARE TO EXIT ⚠' : '⬇ EXIT AT'}
                        </div>
                        <div style={{ color: ac, fontSize: '22px', fontWeight: 900, textTransform: 'uppercase', marginTop: '4px', textShadow: `0 0 12px ${ac}` }}>
                          {exitStop.name}
                        </div>
                        <div style={{ color: isUrgent ? '#FF000A' : '#0088ff', fontSize: '14px', fontWeight: 'bold', marginTop: '4px' }}>
                          IN {alightEtaMin} MIN{alightEtaMin !== 1 ? 'S' : ''} · ARRIVE ~{arrClock}
                        </div>
                        {destRoutes.length > 0 && (
                          <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px dashed rgba(255,255,255,0.2)' }}>
                            <div style={{ color: '#fff', fontSize: '10px', opacity: 0.8, letterSpacing: '1px' }}>THEN CATCH</div>
                            <div style={{ color: '#ffd600', fontSize: '15px', fontWeight: 'bold', marginTop: '3px' }}>
                              {destRoutes.map((r: string) => {
                                const num = parseInt(r);
                                return (!isNaN(num) && num <= 17 ? '🚃 TRAM ' : '🚌 BUS ') + r;
                              }).join(' / ')}
                            </div>
                            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '10px', marginTop: '2px' }}>
                              TO {destName}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  }
                }
                return (
                  <>
                    {!isUserOnVehicle && journey?.legs?.[0]?.boardStop && (
                      <div style={{ marginTop: '12px', textAlign: 'center', borderTop: '1px dashed rgba(255,255,255,0.2)', paddingTop: '12px', paddingBottom: '8px' }}>
                        <div style={{ color: '#00ffd5', fontSize: '13px', fontWeight: 'bold', letterSpacing: '2px' }}>BOARD AT:</div>
                        <div style={{ color: '#fff', fontSize: '22px', fontWeight: 900, textTransform: 'uppercase', marginTop: '2px', textShadow: '0 0 12px rgba(0,255,213,0.5)' }}>
                          {journey.legs[0].boardStop.name}
                        </div>
                      </div>
                    )}
                    <div className="timer-label" style={{ color: hzBuffer !== null ? (hzBuffer < 0 ? '#FF000A' : hzBuffer < 2 ? 'var(--amber)' : 'var(--cyan)') : 'var(--cyan)', marginTop: '16px' }}>
                      {secsUntil <= 0 ? '⚠ TRAIN DEPARTING NOW ⚠' : hzBuffer !== null && hzBuffer < 0 ? '⛔ OUTSIDE RING' : hzBuffer !== null && hzBuffer < 2 ? '⚠ LEAVE SOON' : 'DEPARTS IN'}
                    </div>
                    <div className="big-timer" style={{ color: hzBuffer !== null ? (hzBuffer < 0 ? '#FF000A' : hzBuffer < 2 ? 'var(--amber)' : 'var(--cyan)') : 'var(--cyan)' }}>
                      {secsUntil > 0 ? countdownStr : '00:00'}
                    </div>

                    <div className="prediction">
                      <div className="pred-cell">
                        <div className="pred-lbl">Departure</div>
                        <div className="pred-val" style={{ color: accent }}>{nextTrain.departure.substring(0, 5)}</div>
                      </div>
                      <div className="pred-cell">
                        <div className="pred-lbl">Walk Time</div>
                        <div className="pred-val">{fmtMin(hzWalkMin)}</div>
                      </div>
                      <div className="pred-cell">
                        <div className="pred-lbl">Buffer</div>
                        <div className={`pred-val ${hzBuffer !== null ? (hzBuffer >= 5 ? 'green' : hzBuffer >= 0 ? 'amber' : 'red') : ''}`}>
                          {hzBuffer !== null ? `${Math.round(hzBuffer)}m` : '--m'}
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}

              <div style={{
                marginTop: '12px',
                textAlign: 'center',
                fontSize: '11px',
                color: 'var(--cyan)',
                letterSpacing: '1px',
                background: 'rgba(0, 255, 213, 0.05)',
                padding: '6px',
                borderRadius: '4px',
                border: '1px solid rgba(0, 255, 213, 0.2)'
              }}>
                ARRIVES {((activeLeg as any).to?.name || '').toUpperCase()} AT {nextTrain.arrival.substring(0, 5)} · {journeyMin} MIN RIDE
              </div>

              {hzppSchedule.length > 1 && (
                <div style={{
                  marginTop: '8px',
                  fontSize: '10px',
                  color: 'rgba(255,255,255,0.4)',
                  textAlign: 'center'
                }}>
                  NEXT: {hzppSchedule.slice(1, 3).map(t => `${t.trainNumber} @ ${t.departure.substring(0, 5)}`).join(' · ')}
                </div>
              )}

              <div className={`status-strip ${hzBuffer !== null ? (hzBuffer >= 2 ? 'safe' : hzBuffer >= 0 ? 'risk' : 'danger') : 'safe'}`}>
                {hzBuffer !== null ? (
                  hzBuffer >= 5 ? `✓ PLENTY OF TIME — ${Math.round(hzBuffer)}m BUFFER` :
                  hzBuffer >= 2 ? `✓ SAFE — ${Math.round(hzBuffer)}m BUFFER TO STATION` :
                  hzBuffer >= 0 ? `⚠ TIGHT — LEAVE IN ${Math.round(hzBuffer)}m` :
                  `⛔ TOO LATE — CATCH NEXT TRAIN`
                ) : 'ENABLE GPS FOR WALK CALC'}
              </div>
            </>
          );
        })() : hzppData ? (
          <>
            <div className="card-label" style={{ color: '#FF000A', fontWeight: 'bold' }}>HŽPP TRAIN INTERCEPT (ID: {hzppData.train})</div>
            <div className="card-stop" style={{ color: '#FF000A', textShadow: '0 0 10px #FF000A' }}>{hzppData.station.toUpperCase()}</div>
            <div className="card-tracked" style={{ color: '#fff' }}>
              LAST REPORT: {hzppData.station.toUpperCase()} ({hzppData.time || 'N/A'})
            </div>
            <div className="timer-label" style={{ color: hzppData.delay > 0 ? '#FF000A' : '#00FF00', marginTop: '16px' }}>
              {hzppData.eta !== null ? 'TRAIN ETA' : (hzppData.delay > 0 ? 'TRAIN DELAY DETECTED' : 'TRAIN ON TIME')}
            </div>
            <div className="big-timer" style={{ color: hzppData.delay > 0 ? '#FF000A' : '#00FF00' }}>
              {hzppData.eta !== null ? `${hzppData.eta}` : (hzppData.delay > 0 ? `+${hzppData.delay}` : '00:00')}
            </div>
            <div className={`status-strip`} style={{ background: hzppData.delay > 0 ? 'rgba(255,0,10,0.2)' : 'rgba(0,255,0,0.2)', color: hzppData.delay > 0 ? '#FF000A' : '#00FF00' }}>
              {hzppData.delay > 0 ? `⚠ HŽPP REPORTS ${hzppData.delay} MIN LATE ⚠` : '✓ HŽPP REPORTS ON TIME ✓'}
            </div>
          </>
        ) : (
          <>
            <div className="card-label">{phase === 'train' ? 'ARRIVING AT:' : 'TARGET STOP:'}</div>
            <div className="card-stop">{displayMainTarget}</div>
            <div className="card-tracked">
              {displayLegLabel} {trackedId ? `· ${trackedVehicle?.isHZPP ? 'TRAIN' : 'BUS'} ${trackedId.replace('hz_', '')}` : ''}
            </div>
            
            {(() => {
              // ONBOARD JUMP-OFF DETECTION
              // If the user has left the boarding radius (>2km away) or is physically ON the vehicle coordinates
              const isUserOnVehicle = trackedVehicle && position && 
                (phase === 'train' || (haversineM(position.lat, position.lon, trackedVehicle.lat, trackedVehicle.lon) < 200));
                
              if (isUserOnVehicle) {
                // EXIT STOP: actual GTFS station from journey, not the profile destination
                const exitStop = journey?.legs?.[0]?.exitStop || (activeLeg as any).to;
                if (exitStop) {
                  const dist = haversineM(trackedVehicle.lat, trackedVehicle.lon, exitStop.lat, exitStop.lon);
                  const spd = Math.max(20, trackedVehicle.speed || 30);
                  const alightEtaMin = Math.round((dist / 1000) / spd * 60);
                  const arrTime = new Date();
                  arrTime.setMinutes(arrTime.getMinutes() + alightEtaMin);
                  const arrClock = `${String(arrTime.getHours()).padStart(2,'0')}:${String(arrTime.getMinutes()).padStart(2,'0')}`;
                  
                  // Next connection: routes from destination profile (exclude train routes)
                  const destRoutes = ((activeLeg as any).to?.connectedRoutes || [])
                    .filter((r: string) => r.toUpperCase() !== 'HŽPP' && !/^\d{4}$/.test(r));
                  const destName = ((activeLeg as any).to?.name || '').toUpperCase();
                  const isUrgent = alightEtaMin <= 2;
                  const ac = isUrgent ? '#FF000A' : '#00ffd5';
                  
                  return (
                    <div style={{ padding: '12px', background: isUrgent ? 'rgba(255,0,10,0.3)' : 'rgba(0,255,213,0.12)', border: `2px solid ${ac}`, borderRadius: '8px', marginTop: '16px', textAlign: 'center', boxShadow: `0 0 20px ${isUrgent ? 'rgba(255,0,10,0.5)' : 'rgba(0,255,213,0.3)'}` }}>
                      <div style={{ color: '#fff', fontSize: '11px', fontWeight: 'bold', letterSpacing: '1px' }}>
                        {isUrgent ? '⚠ PREPARE TO EXIT ⚠' : '⬇ EXIT AT'}
                      </div>
                      <div style={{ color: ac, fontSize: '22px', fontWeight: 900, textTransform: 'uppercase', marginTop: '4px', textShadow: `0 0 12px ${ac}` }}>
                        {exitStop.name}
                      </div>
                      <div style={{ color: isUrgent ? '#FF000A' : '#0088ff', fontSize: '14px', fontWeight: 'bold', marginTop: '4px' }}>
                        IN {alightEtaMin} MIN{alightEtaMin !== 1 ? 'S' : ''} · ARRIVE ~{arrClock}
                      </div>
                      {destRoutes.length > 0 && (
                        <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px dashed rgba(255,255,255,0.2)' }}>
                          <div style={{ color: '#fff', fontSize: '10px', opacity: 0.8, letterSpacing: '1px' }}>THEN CATCH</div>
                          <div style={{ color: '#ffd600', fontSize: '15px', fontWeight: 'bold', marginTop: '3px' }}>
                            {destRoutes.map((r: string) => {
                              const num = parseInt(r);
                              return (!isNaN(num) && num <= 17 ? '🚃 TRAM ' : '🚌 BUS ') + r;
                            }).join(' / ')}
                          </div>
                          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: '10px', marginTop: '2px' }}>
                            TO {destName}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                }
              }
              return (
                <>
                  {!isUserOnVehicle && journey?.legs?.[0]?.boardStop && (
                    <div style={{ marginTop: '12px', textAlign: 'center', borderTop: '1px dashed rgba(255,255,255,0.2)', paddingTop: '12px', paddingBottom: '8px' }}>
                      <div style={{ color: '#00ffd5', fontSize: '13px', fontWeight: 'bold', letterSpacing: '2px' }}>BOARD AT:</div>
                      <div style={{ color: '#fff', fontSize: '22px', fontWeight: 900, textTransform: 'uppercase', marginTop: '2px', textShadow: '0 0 12px rgba(0,255,213,0.5)' }}>
                        {journey.legs[0].boardStop.name}
                      </div>
                    </div>
                  )}
                  <div className="timer-label">
                    {phase === 'extract' ? '⚠ EMERGENCY COUNTDOWN ⚠' : 'VEHICLE ETA'}
                  </div>
                  <div className="big-timer" style={{ color: timerColor }}>{timerDisplay}</div>

                  <div className="prediction">
                    <div className="pred-cell">
                      <div className="pred-lbl">Vehicle ETA</div>
                      <div className={`pred-val ${busEta !== null ? (busEta <= 5 ? 'red' : busEta <= 10 ? 'amber' : 'green') : ''}`}>
                        {fmtMin(busEta)}
                      </div>
                    </div>
                    <div className="pred-cell">
                      <div className="pred-lbl">Walk Time</div>
                      <div className="pred-val">{fmtMin(walkMin)}</div>
                    </div>
                    <div className="pred-cell">
                      <div className="pred-lbl">Buffer</div>
                      <div className={`pred-val ${bufferMin !== null ? (bufferMin >= 3 ? 'green' : bufferMin >= 0 ? 'amber' : 'red') : ''}`}>
                        {bufferMin !== null ? fmtMin(Math.abs(bufferMin)) : '--m'}
                      </div>
                    </div>
                  </div>
                  
                  {journey && journey.legs[0]?.exitStop ? (
                    <div style={{ 
                      marginTop: '12px',
                      textAlign: 'center', 
                      background: 'rgba(0, 255, 213, 0.05)',
                      padding: '8px',
                      borderRadius: '4px',
                      border: '1px solid rgba(0, 255, 213, 0.2)'
                    }}>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', letterSpacing: '1px', marginBottom: '2px' }}>
                        GET OFF THIS {trackedVehicle && (trackedVehicle as any).isHZPP ? 'TRAIN' : 'VEHICLE'} AT
                      </div>
                      <div style={{ fontSize: '16px', color: 'var(--cyan)', fontWeight: 'bold', textTransform: 'uppercase', textShadow: '0 0 10px rgba(0,255,213,0.5)' }}>
                        {journey.legs[0].exitStop.name}
                      </div>
                      {destEtaStr && ultimateDestName && (
                        <div style={{ fontSize: '10px', color: 'var(--cyan)', letterSpacing: '1px', marginTop: '6px', paddingTop: '6px', borderTop: '1px dashed rgba(0,255,213,0.2)' }}>
                          FINAL DEST ({ultimateDestName.toUpperCase()}) ETA: {destEtaStr}
                        </div>
                      )}
                    </div>
                  ) : destEtaStr && ultimateDestName ? (
                    <div style={{ 
                      marginTop: '12px',
                      textAlign: 'center', 
                      fontSize: '11px', 
                      color: 'var(--cyan)',
                      letterSpacing: '1px',
                      background: 'rgba(0, 255, 213, 0.05)',
                      padding: '6px',
                      borderRadius: '4px',
                      border: '1px solid rgba(0, 255, 213, 0.2)'
                    }}>
                      LIVE CALC: {trackedVehicle && (trackedVehicle as any).isHZPP ? 'TRAIN' : 'VEHICLE'} ARRIVES AT {ultimateDestName.toUpperCase()} AT {destEtaStr}
                    </div>
                  ) : null}

              {/* ── FULL JOURNEY PANEL ── */}
              {journey && journey.legs.length > 1 && (() => {
                // Walking ETA to first board stop
                const walkDistM = position ? Math.round(
                  Math.sqrt(Math.pow((journey.legs[0].boardStop.lat - position.lat) * 111320, 2) + 
                            Math.pow((journey.legs[0].boardStop.lon - position.lon) * 111320 * Math.cos(position.lat * Math.PI / 180), 2))
                ) : 0;
                const walkMins = Math.round(walkDistM / 84); // 1.4 m/s = 84 m/min

                const lastLegIdx = journey.legs.length - 1;
                const lastLeg = journey.legs[lastLegIdx];
                let arrMinsAbs = 0;
                const now = new Date();
                const currentMinsAbs = now.getHours() * 60 + now.getMinutes();
                if (lastLeg.transferBuffer === null && legSchedules[lastLegIdx]?.scheduled) {
                  const [h, m] = legSchedules[lastLegIdx].scheduled.split(':').map(Number);
                  arrMinsAbs = h * 60 + m + lastLeg.rideTimeMinutes;
                } else {
                  arrMinsAbs = currentMinsAbs + lastLeg.cumulativeEta;
                }
                const arrH = Math.floor(arrMinsAbs / 60) % 24;
                const arrM = Math.floor(arrMinsAbs % 60);
                const totalMins = arrMinsAbs - currentMinsAbs;
                const arriveStr = `${String(arrH).padStart(2,'0')}:${String(arrM).padStart(2,'0')}`;
                const summaryText = journey.legs.map(l => {
                   const icon = l.route.match(/^\d{4}$/) || l.route.toUpperCase() === 'HŽPP' ? '🚂' : parseInt(l.route) <= 17 ? '🚃' : '🚌';
                   return `${icon} ${l.route.toUpperCase()}`;
                }).join(' → ');

                return (
                  <div style={{
                    margin: '8px 0',
                    border: '1px solid rgba(0,255,213,0.25)',
                    borderRadius: '6px',
                    overflow: 'hidden',
                  }}>
                    {/* Collapsible Header */}
                    <div 
                      onClick={() => setIsJourneyExpanded(!isJourneyExpanded)}
                      style={{
                        padding: '10px',
                        background: 'rgba(0,255,213,0.1)',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderBottom: isJourneyExpanded ? '1px solid rgba(255,255,255,0.1)' : 'none'
                      }}>
                      <div style={{ fontSize: '11px', color: '#fff', fontWeight: 700, letterSpacing: '0.5px', marginBottom: '2px' }}>
                        {summaryText}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--amber)', letterSpacing: '0.5px' }}>
                        🏁 ARRIVE ~{arriveStr} ({Math.round(totalMins)}m) <span style={{ color: 'rgba(255,255,255,0.4)', marginLeft: '6px' }}>{isJourneyExpanded ? '▲' : '▼'}</span>
                      </div>
                    </div>

                    {isJourneyExpanded && (
                      <>
                        {/* Walk to first stop indicator */}
                        {walkDistM > 50 && (
                          <div style={{
                            padding: '6px 10px',
                            background: 'rgba(0,136,255,0.1)',
                            borderBottom: '1px solid rgba(255,255,255,0.07)',
                            fontSize: '10px',
                            color: 'var(--cyan)',
                            letterSpacing: '0.5px',
                          }}>
                            🚶 WALK {walkMins}m ({walkDistM}m) TO {journey.legs[0].boardStop.name.toUpperCase()}
                          </div>
                        )}

                        {journey.legs.map((leg, idx) => {
                      const icon = leg.route.match(/^\d{4}$/) || leg.route.toUpperCase() === 'HŽPP'
                        ? '🚂' : parseInt(leg.route) <= 17 ? '🚃' : '🚌';
                      const statusColor = (!leg.isFeasible && (idx === 0 || leg.transferBuffer !== null)) ? 'var(--red)' :
                        (!leg.isFeasible && idx > 0 && leg.transferBuffer === null) ? 'rgba(0,255,213,0.5)' :
                        (leg.transferBuffer !== null && leg.transferBuffer < 3) ? 'var(--amber)' :
                        'var(--cyan)';
                        
                      const displayEta = leg.vehicle?.isHZPP && typeof hzppMinsUntil !== 'undefined' && hzppMinsUntil !== null
                        ? Math.round(hzppMinsUntil)
                        : leg.vehicleEtaToBoardStop >= 90
                          ? null
                          : Math.round(leg.vehicleEtaToBoardStop);

                      return (
                        <div key={idx} 
                          onClick={() => {
                            // Zoom map to show this leg's board and exit stops
                            const map = (window as any).__leafletMap;
                            if (map && leg.boardStop && leg.exitStop) {
                              const bounds = [
                                [leg.boardStop.lat, leg.boardStop.lon],
                                [leg.exitStop.lat, leg.exitStop.lon],
                              ];
                              map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14, duration: 0.8 });
                            }
                          }}
                          style={{
                          padding: '8px 10px',
                          background: idx === 0 ? 'rgba(0,255,213,0.06)' : 'rgba(0,0,0,0.3)',
                          borderBottom: idx < journey.legs.length - 1 ? '1px solid rgba(255,255,255,0.07)' : 'none',
                          cursor: 'pointer',
                        }}>
                          {/* Leg header: ROUTE + ETA */}
                          <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginBottom: '4px',
                          }}>
                            <span style={{
                              fontFamily: "'Orbitron', monospace",
                              fontSize: '12px',
                              fontWeight: 700,
                              color: statusColor,
                              letterSpacing: '1px',
                            }}>
                              {icon} {leg.route.toUpperCase()}
                              {!leg.isFeasible && (
                                idx === 0 
                                  ? ' ⛔ MISSED' 
                                  : (leg.transferBuffer === null ? ' ⏳ WAITING FOR DB' : ' ⛔ MISSED')
                              )}
                            </span>
                            <span style={{
                              fontFamily: "'Orbitron', monospace",
                              fontSize: '10px',
                              color: statusColor,
                            }}>
                              {leg.isFeasible
                                ? (displayEta === null ? 'NO VEHICLE' : `${displayEta}m TO STOP`)
                                : (idx > 0 && leg.transferBuffer === null ? 'OUT OF RANGE' : 'NEXT VEHICLE')
                              }
                            </span>
                          </div>

                          {/* SCHEDULE INFO */}
                          {legSchedules[idx] && legSchedules[idx].scheduled && (
                            <div style={{
                              display: 'flex',
                              flexDirection: 'column',
                              fontSize: '10px',
                              color: 'rgba(255,255,255,0.7)',
                              marginBottom: '6px',
                              background: 'rgba(0,0,0,0.4)',
                              padding: '4px 6px',
                              borderRadius: '4px'
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: legSchedules[idx].next?.length ? '4px' : '0' }}>
                                <span>SCHED: <strong style={{ color: '#fff' }}>{legSchedules[idx].scheduled}</strong></span>
                                {(() => {
                                  if (leg.isFeasible && displayEta !== null) {
                                    const now = new Date();
                                    const liveMinsAbs = now.getHours() * 60 + now.getMinutes() + displayEta;
                                    const [h, m] = legSchedules[idx].scheduled.split(':').map(Number);
                                    const schedMinsAbs = h * 60 + m;
                                    const diff = Math.round(liveMinsAbs - schedMinsAbs);
                                    
                                    const hLive = Math.floor(liveMinsAbs / 60) % 24;
                                    const mLive = Math.floor(liveMinsAbs % 60);
                                    const liveStr = `${String(hLive).padStart(2,'0')}:${String(mLive).padStart(2,'0')}`;
                                    
                                    if (diff === 0) return <span style={{ color: 'var(--cyan)', fontWeight: 700 }}>GPS {liveStr} <span style={{opacity: 0.7}}>(ON TIME)</span></span>;
                                    if (diff > 0) return <span style={{ color: 'var(--red)', fontWeight: 700 }}>GPS {liveStr} <span style={{opacity: 0.8}}>(+{diff}m LATE)</span></span>;
                                    return <span style={{ color: 'var(--green)', fontWeight: 700 }}>GPS {liveStr} <span style={{opacity: 0.8}}>(-{Math.abs(diff)}m EARLY)</span></span>;
                                  }
                                  return <span style={{ color: 'rgba(255,255,255,0.4)' }}>NO GPS DATA</span>;
                                })()}
                              </div>
                              {legSchedules[idx].next && legSchedules[idx].next.length > 0 && (
                                <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', paddingTop: '2px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                                  NEXT: {legSchedules[idx].next.join(' · ')}
                                </div>
                              )}
                            </div>
                          )}

                          {/* BOARD instruction */}
                          <div style={{
                            fontSize: '10px',
                            color: 'rgba(255,255,255,0.6)',
                            letterSpacing: '0.5px',
                          }}>
                            {idx === 0 ? '📍 BOARD AT' : '🔄 CATCH'}{' '}
                            <strong style={{ color: '#fff' }}>
                              {leg.boardStop.name.toUpperCase()}
                            </strong>
                          </div>

                          {/* GET OFF instruction — this is what the user needs most */}
                          <div style={{
                            marginTop: '3px',
                            fontSize: '11px',
                            color: '#ff3366',
                            fontWeight: 700,
                            letterSpacing: '0.5px',
                          }}>
                            ⬇ GET OFF AT{' '}
                            <span style={{ color: '#fff', textDecoration: 'underline' }}>
                              {leg.exitStop.name.toUpperCase()}
                            </span>
                          </div>

                          {/* Transfer buffer (only for legs > 0) */}
                          {leg.transferBuffer !== null && (
                            <div style={{
                              marginTop: '4px',
                              fontSize: '10px',
                              color: leg.transferBuffer < 1 ? 'var(--red)' :
                                     leg.transferBuffer < 3 ? 'var(--amber)' : 'var(--green)',
                              letterSpacing: '0.5px',
                            }}>
                              {leg.transferBuffer >= 1
                                ? `✓ TRANSFER: ${Math.round(leg.transferBuffer)}m BUFFER`
                                : `⚠ TRANSFER TOO TIGHT (${Math.round(leg.transferBuffer)}m)`
                              }
                            </div>
                          )}

                          {/* Final destination arrival with CLOCK TIME */}
                          {idx === journey.legs.length - 1 && (leg.cumulativeEta < 300 || legSchedules[idx]?.scheduled) && (
                            <div style={{
                              marginTop: '4px',
                              fontSize: '10px',
                              color: 'var(--amber)',
                              letterSpacing: '0.5px',
                            }}>
                              🏁 ARRIVE ~{(() => {
                                const now = new Date();
                                const currentMinsAbs = now.getHours() * 60 + now.getMinutes();
                                let arrMinsAbs = 0;
                                
                                if (leg.transferBuffer === null && legSchedules[idx]?.scheduled) {
                                  // Fallback to static GTFS schedule if no live vehicle
                                  const [h, m] = legSchedules[idx].scheduled.split(':').map(Number);
                                  arrMinsAbs = h * 60 + m + leg.rideTimeMinutes;
                                } else {
                                  // Use live GPS cumulative ETA
                                  arrMinsAbs = currentMinsAbs + leg.cumulativeEta;
                                }
                                
                                const arrH = Math.floor(arrMinsAbs / 60) % 24;
                                const arrM = Math.floor(arrMinsAbs % 60);
                                const totalMins = arrMinsAbs - currentMinsAbs;
                                
                                return `${String(arrH).padStart(2,'0')}:${String(arrM).padStart(2,'0')} (${Math.round(totalMins)}m total)`;
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Alternative chains available — tap to cycle */}
                    {evaluatedChains.length > 1 && (
                      <div style={{ marginTop: '8px', borderTop: '1px solid rgba(0, 255, 213, 0.2)', paddingTop: '8px' }}>
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', letterSpacing: '0.5px', marginBottom: '6px', textAlign: 'center' }}>
                          ALTERNATIVE ROUTES EVALUATED:
                        </div>
                        {evaluatedChains.filter(e => e.index !== activeChainIndex).slice(0, 3).map((alt) => {
                          const summary = alt.journey.legs.map((l: any) => l.route.toUpperCase()).join(' → ');
                          const arrMinsAbs = (new Date().getHours() * 60 + new Date().getMinutes()) + alt.journey.totalMinutes;
                          const arriveStr = `${String(Math.floor(arrMinsAbs / 60) % 24).padStart(2,'0')}:${String(Math.floor(arrMinsAbs % 60)).padStart(2,'0')}`;
                          const isDead = !alt.journey.legs[0]?.vehicle;
                          
                          return (
                            <div 
                              key={alt.index}
                              onClick={() => {
                                setActiveChainIndex(alt.index);
                                setIsJourneyExpanded(false);
                              }}
                              style={{
                                padding: '6px 10px',
                                background: 'rgba(255,255,255,0.05)',
                                fontSize: '11px',
                                color: isDead ? 'rgba(255,255,255,0.3)' : 'var(--cyan)',
                                textAlign: 'left',
                                display: 'flex',
                                justifyContent: 'space-between',
                                cursor: 'pointer',
                                marginBottom: '4px',
                                borderRadius: '4px'
                              }}
                            >
                              <span>{summary}</span>
                              <span>{isDead ? '⛔ NO VEHICLE' : `~${arriveStr} (${Math.round(alt.journey.totalMinutes)}m)`}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    </>
                    )}
                  </div>
                );
              })()}

                  {/* ── SKIP / NEXT ROUTE BUTTON ── */}
                  {journeyChains.length > 1 && evaluatedChains.length > 1 && !isUserOnVehicle && (() => {
                    // Build deduplicated list of unique first-leg routes in planner order (best → worst).
                    // Each entry is the BEST chain for that route.
                    const seen = new Set<string>();
                    const uniqueRouteChains: any[] = [];
                    for (const e of evaluatedChains) {
                      const r = e.journey?.legs?.[0]?.route;
                      if (r && !seen.has(r) && e.journey?.isFeasible) {
                        seen.add(r);
                        uniqueRouteChains.push(e);
                      }
                    }
                    if (uniqueRouteChains.length < 2) return null;

                    // Find current position in the unique list, then advance to the next (with wrap).
                    const currentRoute = evaluatedChains.find((e: any) => e.index === activeChainIndex)?.journey?.legs?.[0]?.route;
                    const curIdx = uniqueRouteChains.findIndex((e: any) => e.journey?.legs?.[0]?.route === currentRoute);
                    const nextIdx = (curIdx + 1) % uniqueRouteChains.length;
                    const nextAlt = uniqueRouteChains[nextIdx];
                    if (!nextAlt) return null;
                    
                    const nextLegs = nextAlt.journey.legs;
                    const nextRoute = nextLegs.map((l: any) => {
                      const num = parseInt(l.route);
                      const icon = l.route.match(/^\d{4}$/) || l.route.toUpperCase() === 'HŽPP' ? '🚂' : (!isNaN(num) && num <= 17) ? '🚃' : '🚌';
                      return `${icon} ${l.route}`;
                    }).join(' → ');
                    const now = new Date();
                    const arrMinsAbs = (now.getHours() * 60 + now.getMinutes()) + nextAlt.journey.totalMinutes;
                    const arriveStr = `${String(Math.floor(arrMinsAbs / 60) % 24).padStart(2,'0')}:${String(Math.floor(arrMinsAbs % 60)).padStart(2,'0')}`;
                    const nextBoard = nextLegs[0]?.boardStop?.name || '???';
                    const nextDep = nextLegs[0]?.scheduledDeparture?.slice(0, 5) || '';
                    
                    return (
                      <div
                        id="skip-route-btn"
                        onClick={() => {
                          setActiveChainIndex(nextAlt.index);
                          lockedRouteRef.current = nextLegs[0]?.route || null;
                          setManualTrackedId(null);
                          setIsJourneyExpanded(false);
                          showToast(`⟳ SWITCHED TO ${nextLegs[0]?.route?.toUpperCase()}`);
                          logEvent('ROUTING', `User skipped to next route: ${nextLegs[0]?.route}`);
                        }}
                        style={{
                          margin: '8px 0 0',
                          padding: '12px',
                          background: 'linear-gradient(135deg, rgba(255,140,0,0.15), rgba(255,60,0,0.1))',
                          border: '1px solid rgba(255,140,0,0.5)',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          textAlign: 'center',
                          transition: 'all 0.2s',
                        }}
                      >
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.7)', letterSpacing: '1.5px', marginBottom: '4px' }}>
                          NEXT OPTION ({nextIdx + 1}/{uniqueRouteChains.length})
                        </div>
                        <div style={{ fontSize: '15px', color: '#ff8c00', fontWeight: 900, letterSpacing: '0.5px' }}>
                          NEXT: {nextRoute}
                        </div>
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)', marginTop: '3px' }}>
                          {nextDep ? `${nextDep} from ` : ''}{nextBoard.toUpperCase()} · arrive ~{arriveStr} ({Math.round(nextAlt.journey.totalMinutes)}m)
                        </div>
                      </div>
                    );
                  })()}

                  <div className={`status-strip ${statusClass}`}>{statusText}</div>
                </>
              );
            })()}
          </>
        )}
      </div>
      )}

      {/* NAV BAR */}
      <div className="nav-bar">
        <button
          className={`nav-btn ${activeNav === 'track' ? 'active' : ''}`}
          onClick={() => {
            setActiveNav('track');
            (window as any).__mapNav?.flyToTracked();
          }}
        >
          <span className="nav-icon">🚌</span>
          <span className="nav-lbl">TRACK</span>
        </button>
        <button
          className={`nav-btn ${activeNav === 'me' ? 'active' : ''}`}
          onClick={() => {
            setActiveNav('me');
            (window as any).__mapNav?.flyToUser();
          }}
        >
          <span className="nav-icon">📍</span>
          <span className="nav-lbl">ME</span>
        </button>
        <button
          className={`nav-btn ${activeNav === 'timetable' ? 'active' : ''}`}
          onClick={() => {
            setActiveNav('timetable');
          }}
        >
          <span className="nav-icon">📅</span>
          <span className="nav-lbl">TIMETABLE</span>
        </button>
        <button
          className={`nav-btn ${activeNav === 'settings' ? 'active' : ''}`}
          onClick={() => {
            setActiveNav('settings');
          }}
        >
          <span className="nav-icon">🛠️</span>
          <span className="nav-lbl">SETUP</span>
        </button>
      </div>

      {/* TOAST */}
      <div className={`toast ${toastVisible ? 'show' : ''}`}>{toastMsg}</div>

      {/* SETTINGS */}
      {activeNav === 'settings' && pickingMode === null && profile && (
        <SettingsPanel
          profile={profile}
          onProfileChange={(p) => setProfile(p)}
          showToast={showToast}
          showHubs={showHubs}
          showStops={showStops}
          onToggleHubs={(v) => { setShowHubs(v); localStorage.setItem('zr_showHubs', String(v)); }}
          onToggleStops={(v) => { setShowStops(v); localStorage.setItem('zr_showStops', String(v)); }}
          onPickOnMap={(mode) => {
             setPickingMode(mode);
             setPickName('');
             setTimeout(() => {
               (window as any).__mapNav?.flyToUser();
             }, 50);
          }}
        />
      )}

      {/* PICKING UI */}
      {pickingMode !== null && (
        <>
          {/* Fixed Center Crosshair Pin */}
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            background: 'rgba(0,255,213,0.3)',
            border: '2px solid var(--cyan)',
            boxShadow: '0 0 15px var(--cyan)',
            pointerEvents: 'none',
            zIndex: 10000
          }}>
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '4px',
              height: '4px',
              background: '#fff',
              borderRadius: '50%'
            }} />
          </div>
          <div className="settings-overlay" style={{ top: 'auto', bottom: '80px', height: 'auto', background: 'transparent', zIndex: 10000 }}>
             <div className="settings-card" style={{ marginBottom: 0 }}>
               <div style={{ fontSize: '11px', color: 'var(--amber)', marginBottom: '8px', textTransform: 'uppercase', textAlign: 'center' }}>
                 Move map to select location
               </div>
               <input
                 className="settings-input"
                 placeholder={pickingMode === 'home' ? "Home Name (e.g. Gajnice)" : "Place Name (e.g. Work, Gym)"}
                 value={pickName}
                 onChange={e => setPickName(e.target.value)}
                 style={{ fontSize: '14px', padding: '10px', marginBottom: '8px' }}
               />
               <div style={{ display: 'flex', gap: '8px' }}>
                 <button className="settings-btn" style={{ flex: 1, borderColor: 'var(--cyan)' }} onClick={async () => {
                   if (!pickLat || !pickLon) {
                     showToast('Move map to select a point');
                     return;
                   }
                   const finalName = pickName.trim() ? pickName : (pickingMode === 'home' ? 'Home' : 'Saved Place');
                   let updated = profile;
                   if (pickingMode === 'home') {
                     updated = await setHome(profile, pickLat, pickLon, finalName, []);
                   } else {
                     updated = await addDestination(profile, finalName, pickLat, pickLon, [], '');
                   }
                   setProfile(updated);
                   showToast(`${finalName.toUpperCase()} SAVED`);
                   setPickingMode(null);
                 }}>
                   ✓ Save Location
                 </button>
                 <button className="settings-btn danger" onClick={() => setPickingMode(null)}>
                   Cancel
                 </button>
               </div>
             </div>
          </div>
        </>
      )}

      {/* TIMETABLE */}
      {activeNav === 'timetable' && (
        <TimetablePanel 
          targetStop={targetStop} 
          relevantRoutes={relevantRoutes}
          activeLeg={activeLeg}
          activeChainLegs={activeChainLegs}
          profile={profile}
          fleet={enriched}
          userLocation={profile.home}
        />
      )}
    </>
  );
}
