import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { EnrichedVehicle, TransitLocation } from '../types/transit';
import { haversineM } from '../engine/math';

interface RawStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

interface TacticalMapProps {
  vehicles: EnrichedVehicle[];
  trackedId: string | null;
  trackedDeviation?: string | null;
  userLat: number | null;
  userLon: number | null;
  targetStop: TransitLocation | null;
  profileLocations: TransitLocation[];
  busEta: number | null;
  relevantRoutes?: string[];
  onVehicleClick?: (vehicle: EnrichedVehicle) => void;
  onStopClick?: (stop: any) => void;
  onMapCenterChange?: (lat: number, lon: number) => void;
  onMapClick?: () => void;
  onHubClick?: (hub: { name: string; lat: number; lon: number; routes: string[] }) => void;
  activeLeg?: any;
  transferStops?: any[];
  transferWalkLines?: { from: [number, number]; to: [number, number] }[];
  showHubs?: boolean;
  showStops?: boolean;
  autoFollow?: 'tracked' | 'user' | null;
  onMapDrag?: () => void;
}

const WALK_SPEED_MPS = 1.4;

export function TacticalMap({
  vehicles,
  trackedId,
  trackedDeviation,
  userLat,
  userLon,
  targetStop,
  transferStops = [],
  profileLocations,
  busEta,
  relevantRoutes = [],
  onVehicleClick,
  onStopClick,
  activeLeg,
  onMapCenterChange,
  onMapClick,
  onHubClick,
  transferWalkLines = [],
  showHubs = true,
  showStops = true,
  autoFollow = null,
  onMapDrag,
}: TacticalMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const vehicleMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const userMarkerRef = useRef<L.Marker | null>(null);
  const stopMarkersRef = useRef<L.Layer[]>([]);
  const allStopsLayerRef = useRef<L.LayerGroup | null>(null);
  const ringRef = useRef<L.Circle | null>(null);
  const walkLineRef = useRef<L.Polyline | null>(null);
  const journeyLineRef = useRef<L.Polyline | null>(null);

  const [allStops, setAllStops] = useState<RawStop[]>([]);
  const [zoomLevel, setZoomLevel] = useState(13);

  // Keep a stable ref to the callback so we don't recreate the map when it changes
  const onCenterChangeRef = useRef(onMapCenterChange);
  useEffect(() => {
    onCenterChangeRef.current = onMapCenterChange;
  }, [onMapCenterChange]);

  const onMapClickRef = useRef(onMapClick);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  const onMapDragRef = useRef(onMapDrag);
  useEffect(() => {
    onMapDragRef.current = onMapDrag;
  }, [onMapDrag]);

  // Initialize map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
      zoomSnap: 1, 
      wheelPxPerZoomLevel: 30, // 2x faster than default to prevent exhausting scrolling
    }).setView([45.76, 15.98], 13);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(map);

    map.on('moveend', () => {
      if (onCenterChangeRef.current) {
        const center = map.getCenter();
        onCenterChangeRef.current(center.lat, center.lng);
      }
    });

    map.on('zoomend', () => {
      setZoomLevel(map.getZoom());
    });

    map.on('click', () => {
      if (onMapClickRef.current) onMapClickRef.current();
    });

    map.on('dragstart', () => {
      if (onMapDragRef.current) onMapDragRef.current();
    });

    mapRef.current = map;
    (window as any).__leafletMap = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Fetch all stops once
  useEffect(() => {
    fetch('/api/stops/all')
      .then(r => r.json())
      .then(data => {
        if (data.stops) setAllStops(data.stops);
      })
      .catch(e => console.error('Failed to load stops', e));
  }, []);

  // Fetch hub data once, store in state
  const hubLayerRef = useRef<L.LayerGroup | null>(null);
  const [hubData, setHubData] = useState<any[]>([]);
  useEffect(() => {
    fetch('/api/hubs')
      .then(r => r.json())
      .then(data => { if (data.hubs) setHubData(data.hubs); })
      .catch(e => console.error('Failed to load hubs', e));
  }, []);

  // Rebuild hub layer reactively — filter geographically when tracking a vehicle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (hubLayerRef.current) {
      map.removeLayer(hubLayerRef.current);
      hubLayerRef.current = null;
    }

    if (hubData.length === 0) return;

    // Intelligent Hub Filtering:
    // Display a hub ONLY if it is within an 800m walking radius of the user.
    // This strictly eliminates map noise across the city. The user's active transfer 
    // and destination stops are rendered independently anyway.
    let filtered = hubData;
    if (userLat !== null && userLon !== null) {
      filtered = hubData.filter((h: any) => {
        return haversineM(h.lat, h.lon, userLat, userLon) < 800;
      });
    }

    const hubMarkers = filtered.map((h: any) => {
      const routeCount = h.routes.length;
      
      const marker = L.marker([h.lat, h.lon], {
        icon: L.divIcon({
          className: '',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
          html: `<div class="hub-marker">
            <div class="hub-diamond"></div>
            <div class="hub-label">${h.name.toUpperCase()}</div>
            <div class="hub-routes">${routeCount} ${routeCount === 1 ? 'route' : 'routes'}</div>
          </div>`
        }),
        interactive: true,
        zIndexOffset: -500
      });
      marker.on('click', (e: any) => {
        L.DomEvent.stopPropagation(e);
        if (onHubClick) onHubClick({ name: h.name, lat: h.lat, lon: h.lon, routes: h.routes });
      });
      return marker;
    });

    hubLayerRef.current = L.layerGroup(hubMarkers);
    hubLayerRef.current.addTo(map);
  }, [hubData, trackedId, userLat, userLon, targetStop, showHubs, relevantRoutes ? relevantRoutes.join(',') : '']);

  // Render all official stops
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (allStopsLayerRef.current) {
      map.removeLayer(allStopsLayerRef.current);
    }

    // Filter stops to only those that service the relevant routes for this active leg
    const relevantRouteSet = new Set(relevantRoutes.map(r => r.toLowerCase()));
    
    // When actively tracking (relevantRouteSet > 0), don't show route stops — they're just noise.
    // Also hide stops when zoomed out (zoom < 15) to avoid rendering thousands of DOM nodes.
    // Also respect the showStops toggle from settings.
    const allStopsAny = allStops as any[];
    const filteredStops = (relevantRouteSet.size > 0 || zoomLevel < 15 || !showStops)
      ? [] 
      : allStopsAny;

    const markers = filteredStops.map(s => {
      const isTrain = s.isHZPP || (s.id && s.id.startsWith('hz_'));
      const markerColor = isTrain ? '#ff5500' : '#00ffd5';
      
      let html = '';
      if (isTrain && s.headings && s.headings.length > 0) {
        // HZPP bi-directional arrows — unified teardrop shape
        const size = 20;
        html = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="overflow:visible;">`;
        s.headings.forEach((h: number) => {
          html += `<g transform="translate(${size/2},${size/2}) rotate(${h})">
            <path d="M 0,-7 L 3.5,3 Q 0,6 -3.5,3 Z" fill="${markerColor}" opacity="0.85" stroke="${markerColor}" stroke-width="0.5"/>
          </g>`;
        });
        html += `</svg>`;
      } else if (!isTrain && s.heading !== undefined) {
        // ZET single directional arrow — unified teardrop
        html = `<svg width="14" height="14" viewBox="0 0 14 14" style="overflow:visible;">
          <g transform="translate(7,7) rotate(${s.heading})">
            <path d="M 0,-5.5 L 2.8,2.5 Q 0,4.5 -2.8,2.5 Z" fill="${markerColor}" opacity="0.8" stroke="${markerColor}" stroke-width="0.3"/>
          </g>
        </svg>`;
      } else {
        // Fallback simple dot
        const r = isTrain ? 3 : 2;
        const size = r * 2 + 2;
        html = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size/2}" cy="${size/2}" r="${r}" fill="${markerColor}" opacity="0.7"/></svg>`;
      }

      const marker = L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: '', // prevent default leaflet square styling
          html,
          iconSize: isTrain ? [16, 16] : [12, 12],
          iconAnchor: isTrain ? [8, 8] : [6, 6]
        }),
        interactive: true
      });
      
      if (onStopClick) {
        marker.on('click', (e: any) => {
          L.DomEvent.stopPropagation(e);
          onStopClick(s);
        });
      }
      return marker;
    });

    const layerGroup = L.layerGroup(markers);
    layerGroup.addTo(map);
    allStopsLayerRef.current = layerGroup;

  }, [allStops, relevantRoutes, onStopClick, zoomLevel, showStops]);

  // Draw walking lines between transfer stops
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear old lines
    if ((window as any).__walkLines) {
      (window as any).__walkLines.forEach((l: any) => map.removeLayer(l));
    }
    (window as any).__walkLines = [];

    transferWalkLines.forEach(line => {
      const polyline = L.polyline([line.from, line.to], {
        color: '#00ffd5',
        weight: 3,
        dashArray: '5, 8',
        opacity: 0.8
      }).addTo(map);
      (window as any).__walkLines.push(polyline);
    });
  }, [transferWalkLines]);

  // Update profile location markers (Home, Hubs, Destinations)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear old stop markers
    stopMarkersRef.current.forEach(m => map.removeLayer(m));
    stopMarkersRef.current = [];

    // Gather all points of interest — always show user's saved locations
    const pois = [...profileLocations];
    
    if (targetStop && targetStop.lat !== 0) {
      if (!pois.find(p => p.lat === targetStop.lat && p.lon === targetStop.lon)) {
        pois.push({ ...targetStop, type: 'target' });
      } else {
        const existing = pois.find(p => p.lat === targetStop.lat && p.lon === targetStop.lon)!;
        existing.type = 'target';
      }
    }

    // Render transfer stops explicitly so the user knows where to exit and board
    transferStops.forEach(ts => {
      if (!pois.find(p => p.lat === ts.lat && p.lon === ts.lon)) {
        pois.push({ ...ts, type: ts.type });
      } else {
        const existing = pois.find(p => p.lat === ts.lat && p.lon === ts.lon)!;
        existing.type = ts.type;
        existing.label = ts.label;
      }
    });

    pois.forEach(loc => {
      if (loc.lat === 0 && loc.lon === 0) return;

      const colors: Record<string, string> = {
        home: '#00ff6a',
        hub: '#00ffd5',
        destination: '#ffd600',
        target: '#ff0055',    
        transfer_exit: '#ff4400', // Orange-red for getting off
        transfer_board: '#0088ff' // Blue for boarding
      };
      
      const color = colors[loc.type] || '#00ffd5';
      let labelText = loc.name;
      if (loc.type === 'target') labelText = `🎯 ${loc.name}`;
      if (loc.label) labelText = loc.label; // Use explicit transfer label if provided

      const marker = L.marker([loc.lat, loc.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="position:relative">
            <div style="width:16px;height:16px;border-radius:50%;background:${color}33;border:2px solid ${color};box-shadow:0 0 10px ${color};"></div>
            <div style="position:absolute;top:-24px;left:50%;transform:translateX(-50%);font-family:'Orbitron',monospace;font-size:10px;font-weight:900;color:${color};white-space:nowrap;text-shadow:0 2px 8px rgba(0,0,0,1);background:rgba(0,0,0,0.6);padding:2px 6px;border-radius:3px;border:1px solid ${color}55;">${labelText.toUpperCase()}</div>
          </div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        }),
        zIndexOffset: loc.type === 'target' ? 800 : 500,
      }).addTo(map);

      if (onStopClick) {
        marker.on('click', () => onStopClick(loc as any));
      }

      stopMarkersRef.current.push(marker);
    });
  }, [profileLocations, activeLeg, targetStop, transferStops, relevantRoutes]);

  // Update vehicle markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const currentIds = new Set<string>();
    const relevantRouteSet = new Set(relevantRoutes.map(r => r.toLowerCase()));

    vehicles.forEach(v => {
      // PER USER REQUEST: Ripped out all ghost trains from the map.
      // We only care about the single train we are actively tracking.
      if (v.isHZPP && v.id !== trackedId) return;

      // When a journey is active, only show vehicles on relevant routes + the tracked one.
      if (relevantRouteSet.size > 0 && v.id !== trackedId && !relevantRouteSet.has(v.routeId.toLowerCase())) return;
      
      // When NO journey is active yet (fresh load / refresh), don't spam the whole fleet.
      // Only show vehicles within 2km of the user.
      if (relevantRouteSet.size === 0 && v.id !== trackedId && userLat !== null && userLon !== null) {
        const dist = haversineM(v.lat, v.lon, userLat, userLon);
        if (dist > 2000) return;
      }

      currentIds.add(v.id);
      const isTrk = v.id === trackedId;
      const typeIcon = v.routeId.match(/^\d{4}$/) || v.routeId.toUpperCase() === 'HŽPP' ? '🚆' : parseInt(v.routeId) <= 17 ? '🚋' : '🚌';
      const dev = (v as any).scheduleDeviation;
      let devStr = '';
      if (dev !== null && dev !== undefined) {
        if (dev > 0) devStr = ` +${dev}`;
        else if (dev < 0) devStr = ` ${dev}`;
        else devStr = ' ✓';
      }
      let tagText = `${v.routeId}${devStr}`;
      if (isTrk && trackedDeviation) {
        tagText += ` (${trackedDeviation})`;
      }
      
      const dotClass = isTrk ? 'tracked' : 'ghost';
      const tagClass = isTrk ? 'tracked' : dev !== null && dev > 2 ? 'late' : dev !== null && dev < -1 ? 'early' : 'ghost';

      if (vehicleMarkersRef.current.has(v.id)) {
        const marker = vehicleMarkersRef.current.get(v.id)!;
        marker.setLatLng([v.lat, v.lon]);
        const el = marker.getElement();
        if (el) {
          const dot = el.querySelector('.bus-dot');
          const tag = el.querySelector('.bus-tag');
          const headingIndicator = el.querySelector('.bus-heading') as HTMLElement;
          const iconContainer = el.querySelector('.bus-icon-inner') as HTMLElement;
          
          if (dot) dot.className = `bus-dot ${dotClass}`;
          if (iconContainer) iconContainer.textContent = typeIcon;
          if (tag) {
            tag.className = `bus-tag ${tagClass}`;
            tag.textContent = tagText;
          }
          if (headingIndicator) {
            headingIndicator.setAttribute('class', `bus-heading ${tagClass}`);
            headingIndicator.style.transform = `rotate(${v.heading || 0}deg)`;
          }
        }
      } else {
        const marker = L.marker([v.lat, v.lon], {
          icon: L.divIcon({
            className: '',
            html: `<div class="bus-wrap">
              <div class="bus-tag ${tagClass}">${tagText}</div>
              <div class="bus-dot ${dotClass}">
                <div class="bus-icon-inner">${typeIcon}</div>
                <svg class="bus-heading ${tagClass}" viewBox="0 0 24 24" style="transform: rotate(${v.heading || 0}deg);">
                  <path d="M12 2L22 20L12 17L2 20L12 2Z" fill="currentColor"/>
                </svg>
              </div>
            </div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          }),
          zIndexOffset: isTrk ? 1000 : 100,
        }).addTo(map);

        if (onVehicleClick) {
          marker.on('click', () => onVehicleClick(v));
        }

        vehicleMarkersRef.current.set(v.id, marker);
      }
    });

    // Remove gone vehicles
    for (const [id, marker] of vehicleMarkersRef.current) {
      if (!currentIds.has(id)) {
        map.removeLayer(marker);
        vehicleMarkersRef.current.delete(id);
      }
    }
  }, [vehicles, trackedId, onVehicleClick, relevantRoutes]);

  // Update user marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map || userLat === null || userLon === null) return;

    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng([userLat, userLon]);
    } else {
      userMarkerRef.current = L.marker([userLat, userLon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="position:relative"><div class="user-ring"></div><div class="user-dot"></div></div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
        zIndexOffset: 900,
      }).addTo(map);
    }
  }, [userLat, userLon]);

  // Update extraction ring
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !targetStop || targetStop.lat === 0) return;

    const eta = busEta ?? 0;
    const radiusM = Math.max(eta * WALK_SPEED_MPS * 60, 0);

    const userDist = userLat !== null && userLon !== null
      ? haversineM(userLat, userLon, targetStop.lat, targetStop.lon)
      : null;
    const inZone = userDist !== null ? userDist <= radiusM : true;

    const ringColor = inZone ? 'rgba(0,255,106,0.85)' : 'rgba(255,45,45,0.85)';
    const ringFill = inZone ? 'rgba(0,255,106,0.04)' : 'rgba(255,45,45,0.06)';

    if (ringRef.current) {
      ringRef.current.setLatLng([targetStop.lat, targetStop.lon]);
      ringRef.current.setRadius(radiusM);
      ringRef.current.setStyle({ color: ringColor, fillColor: ringFill });
    } else {
      ringRef.current = L.circle([targetStop.lat, targetStop.lon], {
        radius: radiusM,
        color: ringColor,
        fillColor: ringFill,
        fillOpacity: 1,
        weight: 2.5,
        dashArray: '10 8',
      }).addTo(map);
    }

    // (Removed straight walk line as it ignores street topology and confuses users)
    if (walkLineRef.current) {
      map.removeLayer(walkLineRef.current);
      walkLineRef.current = null;
    }
  }, [targetStop, busEta, userLat, userLon]);

  // (Journey line logic removed)

  // Navigation methods
  const flyToTracked = useCallback(() => {
    if (trackedId && vehicleMarkersRef.current.has(trackedId)) {
      mapRef.current?.flyTo(vehicleMarkersRef.current.get(trackedId)!.getLatLng(), 15, { duration: 0.8 });
    }
  }, [trackedId]);

  const flyToUser = useCallback(() => {
    if (userLat !== null && userLon !== null) {
      mapRef.current?.flyTo([userLat, userLon], 16, { duration: 0.8 });
    }
  }, [userLat, userLon]);

  // Expose nav methods via ref-like approach on window for NavBar
  useEffect(() => {
    (window as any).__mapNav = { flyToTracked, flyToUser };
  }, [flyToTracked, flyToUser]);

  // Auto-follow logic (Uber-style)
  useEffect(() => {
    if (!mapRef.current) return;
    if (autoFollow === 'tracked' && trackedId && vehicleMarkersRef.current.has(trackedId)) {
      const marker = vehicleMarkersRef.current.get(trackedId);
      if (marker) {
        mapRef.current.panTo(marker.getLatLng(), { animate: true, duration: 0.5 });
      }
    } else if (autoFollow === 'user' && userLat !== null && userLon !== null) {
      mapRef.current.panTo([userLat, userLon], { animate: true, duration: 0.5 });
    }
  }, [autoFollow, vehicles, userLat, userLon, trackedId]);

  return <div id="map-container" ref={containerRef} />;
}
