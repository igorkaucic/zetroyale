import { useState, useEffect } from 'react';
import { haversineM } from '../engine/math';

import type { TransitLocation, ActiveLeg, UserProfile, EnrichedVehicle } from '../types/transit';

interface Props {
  targetStop?: TransitLocation | null;
  relevantRoutes?: string[];
  activeLeg?: ActiveLeg;
  profile?: UserProfile;
  fleet?: EnrichedVehicle[];
  userLocation?: TransitLocation | null;
  activeChainLegs?: any[];
}

// Map hub names to HŽPP GTFS stop_ids for schedule queries
const HZ_NAME_TO_GTFS: Record<string, string> = {
  'hž harmica': 'i-o716',
  'hž zaprešić savska': 'i-o698',
  'hž zaprešić': 'i-o695',
  'hž podsused stajalište': 'i-o694',
  'hž gajnice': 'i-o697',
  'hž vrapče': 'i-o692',
  'hž kustošija': 'i-o696',
  'hž zagreb zapadni kolodvor': 'i-o700',
  'hž zagreb glavni kolodvor': 'i-o523',
  'glavni kolodvor': 'i-o523',
  'hž maksimir': 'i-o517',
  'hž trnava': 'i-o516',
  'hž čulinec': 'i-o515',
  'hž sesvete': 'i-o514',
  'hž dugo selo': 'i-o540',
};

function resolveHzGtfsId(name: string): string | null {
  const lower = name.toLowerCase().trim();
  // Exact match first
  if (HZ_NAME_TO_GTFS[lower]) return HZ_NAME_TO_GTFS[lower];
  // Partial match
  for (const [key, val] of Object.entries(HZ_NAME_TO_GTFS)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return null;
}

export function TimetablePanel({ targetStop, relevantRoutes, activeLeg, profile, fleet, userLocation, activeChainLegs }: Props) {
  const [searchQuery, setSearchQuery] = useState(targetStop ? targetStop.name : '');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedStop, setSelectedStop] = useState<any | null>(null);
  
  const [schedule, setSchedule] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [hzppData, setHzppData] = useState<any>(null);
  const [hzppLoading, setHzppLoading] = useState(false);
  const [hzppSchedule, setHzppSchedule] = useState<any[]>([]);
  const [hzppScheduleLoading, setHzppScheduleLoading] = useState(false);
  const [hzppScheduleMeta, setHzppScheduleMeta] = useState<{ from: string; to: string } | null>(null);

  // Calculate drive offset
  let destName = '';
  let driveMins = 0;
  let liveSpeedAvg = 0;
  
  if (activeLeg && activeLeg.type !== 'idle' && activeLeg.to && selectedStop) {
    // Determine ultimate destination
    let ultimateDest = activeLeg.to;
    
    // If we are arriving at a hub, we want the ETA to the subsequent spoke (Home or Destination)
    if (ultimateDest.type === 'hub' && profile) {
      const hour = new Date().getHours();
      if (hour < 14 && profile.destinations.length > 0) {
        ultimateDest = profile.destinations[0];
      } else if (profile.home && profile.home.lat !== 0) {
        ultimateDest = profile.home;
      } else if (profile.destinations.length > 0) {
        ultimateDest = profile.destinations[0];
      }
    }
    
    if (ultimateDest.id !== selectedStop.id) {
      destName = ultimateDest.name;
      const distM = haversineM(selectedStop.lat, selectedStop.lon, ultimateDest.lat, ultimateDest.lon);
      
      // Calculate LIVE SPEED from active fleet on our relevant routes
      let speedSum = 0;
      let speedCount = 0;
      if (fleet && relevantRoutes && relevantRoutes.length > 0) {
        fleet.forEach(v => {
          if (relevantRoutes.includes(v.routeId) && v.speed > 0) {
            speedSum += v.speed;
            speedCount++;
          }
        });
      }
      
      // Use live GPS telemetry average speed, or fallback to 25 km/h urban default
      liveSpeedAvg = speedCount > 0 ? (speedSum / speedCount) : 25;
      
      // Ensure we don't divide by crazy high/low numbers (bound between 10 and 60 km/h)
      const boundedSpeed = Math.max(10, Math.min(60, liveSpeedAvg));
      driveMins = Math.round((distM / 1000) / boundedSpeed * 60);
    }
  }

  // ── Auto-Fetch Target Stop or Nearby Departures ──
  useEffect(() => {
    if (userLocation && userLocation.lat !== 0) {
      setSearchQuery('NEARBY RADAR');
      setSelectedStop({ name: 'NEARBY RADAR', id: 'nearby' });
      fetchNearbyDepartures(userLocation.lat, userLocation.lon);
    } else if (targetStop) {
      setSearchQuery(targetStop.name);
      fetch(`/api/stops?q=${encodeURIComponent(targetStop.name)}&limit=15`)
        .then(res => res.json())
        .then(data => {
          if (data.stops && data.stops.length > 0) {
            let bestStop = data.stops[0];
            if (relevantRoutes && relevantRoutes.length > 0) {
              const matched = data.stops.find((s: any) => 
                s.routes && s.routes.some((r: string) => relevantRoutes.includes(r))
              );
              if (matched) bestStop = matched;
            }
            setSelectedStop(bestStop);
            fetchSchedule(bestStop.id);
          } else {
            setSelectedStop(targetStop);
            fetchSchedule(targetStop.id);
          }
        })
        .catch(e => console.error('Auto-resolve failed', e));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetStop?.id, userLocation?.lat]);

  // ── Autocomplete Search ──
  useEffect(() => {
    if (searchQuery === 'NEARBY RADAR') return;
    if (selectedStop && searchQuery === selectedStop.name) return;
    
    if (searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/stops?q=${encodeURIComponent(searchQuery)}&limit=8`);
        const data = await res.json();
        if (data.stops) setSearchResults(data.stops);
      } catch (e) {
        console.error('Stop search failed', e);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, selectedStop]);

  // ── Fetch Schedule ──
  const fetchSchedule = async (stopId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/schedule?stopId=${stopId}`);
      const data = await res.json();
      setSchedule(data.upcoming || []);
    } catch (e) {
      console.error('Failed to load schedule', e);
    }
    setLoading(false);
  };

  const fetchNearbyDepartures = async (lat: number, lon: number) => {
    setLoading(true);
    try {
      const destQuery = activeLeg && activeLeg.type !== 'idle' && activeLeg.to 
          ? `&destLat=${activeLeg.to.lat}&destLon=${activeLeg.to.lon}` 
          : '';
          
      const res = await fetch(`/api/nearby-departures?lat=${lat}&lon=${lon}${destQuery}`);
      const data = await res.json();
      // Format the data to match the expected structure
      const formatted = (data.departures || []).map((d: any) => ({
        route: d.route,
        headsign: `${d.stopName} ➔ ${d.headsign}`, // Include the stop name since it's aggregated!
        departure: d.liveDepartureStr,
        isLive: d.isLive,
        delay: d.delay,
        waitMins: d.waitMins,
        walkMins: d.walkMins
      }));
      setSchedule(formatted);
    } catch (e) {
      console.error('Failed to load nearby departures', e);
    }
    setLoading(false);
  };

  // ── Auto-Fetch HŽPP GTFS Schedule (between two HŽPP hubs) ──
  useEffect(() => {
    if (!activeLeg || activeLeg.type === 'idle') {
      setHzppSchedule([]);
      setHzppScheduleMeta(null);
      return;
    }

    const fromRoutes = activeLeg.from?.connectedRoutes || [];
    const toRoutes = activeLeg.to?.connectedRoutes || [];
    const fromIsHz = fromRoutes.some(r => r.toUpperCase() === 'HŽPP');
    const toIsHz = toRoutes.some(r => r.toUpperCase() === 'HŽPP');

    if (fromIsHz && toIsHz) {
      const fromGtfs = resolveHzGtfsId(activeLeg.from.name);
      const toGtfs = resolveHzGtfsId(activeLeg.to.name);

      if (fromGtfs && toGtfs) {
        setHzppScheduleLoading(true);
        fetch(`/api/hzpp-schedule?from=${fromGtfs}&to=${toGtfs}`)
          .then(res => res.json())
          .then(data => {
            if (data && data.upcoming) {
              setHzppSchedule(data.upcoming);
              setHzppScheduleMeta({
                from: data.from?.name || (activeLeg as any).from.name,
                to: data.to?.name || (activeLeg as any).to.name
              });
            } else {
              setHzppSchedule([]);
            }
          })
          .catch(e => {
            console.error('HŽPP Schedule fetch error:', e);
            setHzppSchedule([]);
          })
          .finally(() => setHzppScheduleLoading(false));
      } else {
        setHzppSchedule([]);
      }
    } else {
      setHzppSchedule([]);
      setHzppScheduleMeta(null);
    }
  }, [(activeLeg as any)?.from?.id, (activeLeg as any)?.to?.id]);

  // ── Auto-Fetch HŽPP Train (live delay for specific train) ──
  useEffect(() => {
    // Check if any relevant route is a 4-digit number
    const trainNum = relevantRoutes?.find(r => /^\d{4}$/.test(r)) || (/^\d{4}$/.test(searchQuery.trim()) ? searchQuery.trim() : null);
    
    if (trainNum) {
      setHzppLoading(true);
      fetch(`/api/hzpp?train=${trainNum}`)
        .then(res => res.json())
        .then(data => {
          if (data && data.station) {
            setHzppData(data);
          } else {
            setHzppData(null);
          }
        })
        .catch(e => {
          console.error("HZPP Fetch Error", e);
          setHzppData(null);
        })
        .finally(() => setHzppLoading(false));
    } else {
      setHzppData(null);
    }
  }, [relevantRoutes, searchQuery]);

  return (
    <div style={{
      position: 'fixed',
      top: 'calc(60px + env(safe-area-inset-top, 0px))',
      left: '50%',
      transform: 'translateX(-50%)',
      width: '92%',
      maxWidth: '340px',
      zIndex: 2002,
      background: 'rgba(4, 7, 12, 0.97)',
      border: '1px solid var(--cyan)',
      borderTop: '2px solid var(--cyan)',
      borderRadius: '5px',
      padding: '16px',
      boxShadow: '0 15px 40px rgba(0,0,0,0.9)',
      maxHeight: 'calc(100vh - 160px)',
      display: 'flex',
      flexDirection: 'column'
    }}>
      <div style={{
        fontFamily: "'Orbitron', monospace",
        fontSize: '11px',
        fontWeight: 800,
        color: 'var(--amber)',
        letterSpacing: '1.5px',
        marginBottom: '14px'
      }}>// LIVE TIMETABLE</div>

        {/* HŽPP GTFS Train Schedule */}
        {(hzppSchedule.length > 0 || hzppScheduleLoading) && (
          <div style={{
            background: 'rgba(255, 0, 10, 0.08)',
            border: '1px solid rgba(255, 0, 10, 0.4)',
            borderRadius: '4px',
            padding: '12px',
            marginBottom: '16px'
          }}>
            <div style={{ fontSize: '11px', color: '#FF000A', marginBottom: '10px', fontWeight: 'bold', letterSpacing: '1px' }}>
              🚂 HŽPP TRAINS {hzppScheduleMeta ? `${hzppScheduleMeta.from.toUpperCase()} → ${hzppScheduleMeta.to.toUpperCase()}` : ''}
            </div>
            {hzppScheduleLoading ? (
              <div className="loading-pulse" style={{ fontSize: '12px', color: '#FF000A' }}>
                LOADING HŽPP SCHEDULE...
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {hzppSchedule.slice(0, 3).map((train: any, idx: number) => {
                  const isNext = idx === 0;
                  // Calculate journey duration
                  const [dH, dM] = train.departure.split(':').map(Number);
                  const [aH, aM] = train.arrival.split(':').map(Number);
                  const durationMin = (aH * 60 + aM) - (dH * 60 + dM);
                  
                  // Calculate minutes until departure
                  const now = new Date();
                  const nowMins = now.getHours() * 60 + now.getMinutes();
                  const depMins = dH * 60 + dM;
                  const minsUntil = depMins - nowMins;

                  return (
                    <div
                      key={train.tripId}
                      style={{
                        background: isNext ? 'rgba(255, 0, 10, 0.15)' : 'rgba(255,255,255,0.03)',
                        border: isNext ? '1px solid #FF000A' : '1px solid rgba(255,255,255,0.1)',
                        padding: '10px 12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        borderRadius: '4px'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                          fontFamily: "'Orbitron', monospace",
                          fontSize: '13px',
                          fontWeight: 800,
                          color: isNext ? '#FF000A' : '#fff',
                          background: isNext ? 'rgba(255, 0, 10, 0.2)' : 'rgba(255,255,255,0.1)',
                          padding: '3px 6px',
                          borderRadius: '3px',
                          minWidth: '42px',
                          textAlign: 'center'
                        }}>
                          {train.trainNumber}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <div style={{
                            fontSize: '12px',
                            fontWeight: '600',
                            color: isNext ? '#fff' : 'rgba(255,255,255,0.7)',
                            maxWidth: '120px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>
                            {train.routeName}
                          </div>
                          <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)' }}>
                            {durationMin} MIN · {train.stops?.length || 0} STOPS
                          </div>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{
                          fontSize: '16px',
                          fontWeight: isNext ? '900' : '600',
                          color: isNext ? '#FF000A' : '#fff',
                          fontFamily: 'monospace'
                        }}>
                          {train.departure.substring(0, 5)}
                        </div>
                        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)' }}>
                          ARR {train.arrival.substring(0, 5)}
                        </div>
                        {minsUntil > 0 && minsUntil < 120 && (
                          <div style={{
                            fontSize: '10px',
                            fontWeight: 'bold',
                            color: minsUntil <= 10 ? '#FF000A' : minsUntil <= 20 ? 'var(--amber)' : 'var(--cyan)',
                            marginTop: '2px'
                          }}>
                            IN {minsUntil} MIN
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* HŽPP Live Delay Widget */}
        {(hzppData || hzppLoading) && (
          <div style={{
            background: 'rgba(255, 0, 10, 0.1)',
            border: '1px solid #FF000A',
            borderRadius: '4px',
            padding: '12px',
            marginBottom: '16px'
          }}>
            <div style={{ fontSize: '11px', color: '#FF000A', marginBottom: '8px', fontWeight: 'bold' }}>
              // HŽPP TRACKER (TRAIN {hzppData?.train || '...'})
            </div>
            {hzppLoading ? (
              <div className="loading-pulse" style={{ fontSize: '12px', color: '#FF000A' }}>
                INTERCEPTING HŽPP SERVER...
              </div>
            ) : (
              <div>
                <div style={{ fontSize: '14px', color: 'white', marginBottom: '4px' }}>
                  Last Seen: <strong style={{ color: 'var(--cyan)' }}>{hzppData.station}</strong>
                </div>
                <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.7)' }}>
                  Reported at: {hzppData.time || 'N/A'}
                </div>
                <div style={{ 
                  marginTop: '8px', 
                  fontSize: '14px', 
                  fontWeight: 'bold',
                  color: hzppData.delay > 0 ? '#FF000A' : '#00FF00' 
                }}>
                  {hzppData.delay > 0 ? `DELAY: +${hzppData.delay} MIN` : 'ON TIME'}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Search Box */}
        <div style={{ position: 'relative', marginBottom: '16px' }}>
          <input
            className="settings-input"
            placeholder="Search any ZET stop..."
            value={searchQuery}
            onChange={e => {
              setSearchQuery(e.target.value);
              setSelectedStop(null);
            }}
            style={{ 
              borderBottom: searchResults.length > 0 ? 'none' : undefined,
              fontSize: '16px',
              padding: '12px'
            }}
          />
          
          {/* Autocomplete Dropdown */}
          {searchResults.length > 0 && !selectedStop && (
            <div style={{ 
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              background: 'rgba(10, 14, 23, 0.95)', 
              border: '1px solid var(--amber)', 
              borderTop: 'none',
              maxHeight: '250px', 
              overflowY: 'auto',
              zIndex: 100,
              boxShadow: '0 10px 30px rgba(0,0,0,0.8)'
            }}>
              {searchResults.map(s => (
                <div 
                  key={s.id}
                  onClick={() => {
                    setSelectedStop(s);
                    setSearchQuery(s.name);
                    setSearchResults([]);
                    fetchSchedule(s.id);
                  }}
                  style={{
                    padding: '12px 16px',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                >
                  <span style={{ fontSize: '14px', color: '#fff', fontWeight: 600 }}>{s.name}</span>
                  {s.routes && (
                    <span style={{ fontSize: '10px', color: 'var(--cyan)' }}>Routes: {s.routes.join(', ')}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Schedule Display */}
        {selectedStop && (
          <div style={{ flex: 1, overflowY: 'auto', paddingRight: '4px' }}>
            <div style={{ 
              fontSize: '12px', 
              color: 'var(--cyan)', 
              marginBottom: '4px',
              textTransform: 'uppercase',
              letterSpacing: '1px'
            }}>
              Upcoming Departures
            </div>
            
            {destName && (
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)', marginBottom: '12px' }}>
                LIVE CALC: ARRIVAL AT {destName.toUpperCase()} IN ~{driveMins} MINS
              </div>
            )}

            {loading ? (
              <div className="loading-pulse" style={{ textAlign: 'center', padding: '20px', color: 'var(--amber)' }}>
                DECRYPTING SCHEDULE...
              </div>
            ) : (() => {
              let filtered = schedule;
              if (relevantRoutes && relevantRoutes.length > 0) {
                if (targetStop && selectedStop.name === targetStop.name) {
                  filtered = schedule.filter(d => relevantRoutes.includes(d.route));
                }
              }

              if (filtered.length === 0) {
                return (
                  <div style={{ textAlign: 'center', padding: '20px', color: 'rgba(255,255,255,0.4)' }}>
                    No more departures matching your route.
                  </div>
                );
              }
              
              // Limit departures
              const isRadar = selectedStop?.id === 'nearby';
              filtered = isRadar ? filtered.slice(0, 10) : filtered.slice(0, 3);
              
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {filtered.map((dep, idx) => {
                  const isNext = idx === 0;
                  
                  let arrivalStr = '';
                  if (!isRadar && destName && driveMins > 0) {
                    const [h, m] = dep.departure.split(':').map(Number);
                    const arrDate = new Date();
                    arrDate.setHours(h, m + driveMins, 0);
                    arrivalStr = `${String(arrDate.getHours()).padStart(2, '0')}:${String(arrDate.getMinutes()).padStart(2, '0')}`;
                  }

                  return (
                    <div 
                      key={idx} 
                      style={{ 
                        background: isNext ? 'rgba(0, 255, 213, 0.1)' : 'rgba(255,255,255,0.03)',
                        border: isNext ? '1px solid var(--cyan)' : '1px solid rgba(255,255,255,0.1)',
                        padding: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        borderRadius: '4px'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{ 
                          fontFamily: "'Orbitron', monospace", 
                          fontSize: '14px', 
                          fontWeight: 800, 
                          color: isNext ? 'var(--cyan)' : '#fff',
                          background: isNext ? 'rgba(0, 255, 213, 0.1)' : 'rgba(255,255,255,0.1)',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          minWidth: '32px',
                          textAlign: 'center'
                        }}>
                          {dep.route}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <div style={{ 
                            fontSize: '14px', 
                            fontWeight: '500', 
                            color: isNext ? '#fff' : 'rgba(255,255,255,0.7)',
                            maxWidth: '180px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>
                            {dep.headsign}
                          </div>
                          {isRadar ? (
                            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', marginTop: '2px' }}>
                              <span style={{ color: dep.isLive ? '#FF000A' : 'inherit' }}>
                                {dep.isLive ? `LIVE (${dep.delay >= 0 ? '+' : ''}${dep.delay}m)` : 'SCHEDULED'}
                              </span>
                              {' · '}
                              <span style={{ color: 'var(--amber)' }}>WALK: {dep.walkMins}m</span>
                            </div>
                          ) : arrivalStr ? (
                            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)' }}>
                              ETA {destName.toUpperCase()}: {arrivalStr}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div style={{ 
                        fontSize: '18px', 
                        fontWeight: isNext ? '900' : '600', 
                        color: isNext ? 'var(--cyan)' : '#fff',
                        fontFamily: 'monospace'
                      }}>
                        {dep.departure.substring(0, 5)}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          </div>
        )}
        
        {!selectedStop && !searchResults.length && (
          <div style={{ 
            flex: 1, 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            color: 'rgba(255,255,255,0.2)',
            fontSize: '12px',
            textAlign: 'center',
            padding: '20px'
          }}>
            Search a station above to view its live timetable.
          </div>
        )}
      </div>
  );
}
