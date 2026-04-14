const express = require('express');
const axios = require('axios');
const cors = require('cors');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

const app = express();
app.use(cors());
// Kill aggressive mobile caching
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});
app.use(express.static('public'));

const PORT = process.env.PORT || 3268;
const ZET_URL = 'https://www.zet.hr/gtfs-rt-protobuf';

const STOPS = {
    oresk:   { name: 'Otok',    lat: 45.760914, lon: 15.984021 },
    glavni:  { name: 'Glavni Kolodvor', lat: 45.802815, lon: 15.9771445 },
    vg:      { name: 'Velika Gorica', lat: 45.7113868, lon: 16.0769206 }
};

const positionHistory = {};
const activeTrips = {};
const telemetry = {
    glavniToOtok: [], // { time, val }
    vgToOtok: []
};

const TRIP_ZONES = {
    GLAVNI: b => b.lat > 45.795,
    OTOK: b => b.lat > 45.759 && b.lat < 45.762,
    VG: b => b.lat < 45.730
};

function addTelemetry(type, mins) {
    telemetry[type].push({ time: Date.now(), val: mins });
    // purge older than 60m
    const cutoff = Date.now() - 3600 * 1000;
    telemetry[type] = telemetry[type].filter(t => t.time > cutoff);
}

function getAverage(type, defaultVal) {
    const arr = telemetry[type];
    if (!arr.length) return defaultVal;
    return Math.round(arr.reduce((sum, t) => sum + t.val, 0) / arr.length);
}

let cachedBuses = [];
let lastFetchTime = 0;
let isFetching = false;

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchBuses() {
    try {
        const resp = await axios({
            method: 'GET',
            url: ZET_URL,
            responseType: 'arraybuffer',
            timeout: 12000
        });

        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
            new Uint8Array(resp.data)
        );

        const now = Date.now();
        const buses = [];

        // Global live traffic intelligence (averages the speed across all currently moving 268 buses)
        let activeSpeeds = Object.values(positionHistory)
            .map(p => p.speeds && p.speeds.length ? p.speeds.reduce((a,b)=>a+b,0)/p.speeds.length : 0)
            .filter(s => s > 15 && s < 80);
        let liveTrafficSpeed = activeSpeeds.length > 0 ? (activeSpeeds.reduce((a,b)=>a+b,0) / activeSpeeds.length) : 32;

        feed.entity.forEach(entity => {
            if (!entity.vehicle || !entity.vehicle.position) return;
            const routeId = entity.vehicle.trip ? (entity.vehicle.trip.routeId || '') : '';
            if (!routeId.includes('268')) return;

            const id = entity.id;
            const lat = entity.vehicle.position.latitude;
            const lon = entity.vehicle.position.longitude;
            const bearing = entity.vehicle.position.bearing || 0;
            const directionId = entity.vehicle.trip ? entity.vehicle.trip.directionId : null;
            const tripId = entity.vehicle.trip ? entity.vehicle.trip.tripId : '';

            let speed = 0, avgSpeed = 0;
            const prev = positionHistory[id];
            
            // DIRECTION: GPS movement is king. GTFS directionId only used as bootstrap.
            let direction = 'unknown';
            let dirSource = 'new';
            
            if (prev) {
                const dist = haversine(prev.lat, prev.lon, lat, lon);
                const dtHours = (now - prev.time) / 3600000;
                if (dtHours > 0.0001) speed = dist / dtHours;
                prev.speeds.push(speed);
                if (prev.speeds.length > 12) prev.speeds.shift();
                avgSpeed = prev.speeds.reduce((a, b) => a + b, 0) / prev.speeds.length;

                // DIRECTION CHECK MUST HAPPEN BEFORE OVERWRITING prev.lat
                const latDelta = lat - prev.lat;
                if (Math.abs(latDelta) > 0.00003) { // ~3.3m movement
                    direction = latDelta > 0 ? 'toward_glavni' : 'toward_vg';
                    dirSource = `gps=${latDelta.toFixed(6)}`;
                } else if (prev.lastDir) {
                    direction = prev.lastDir;
                    dirSource = 'cached';
                }
                
                // TELEMETRY TRACKING
                let currentZone = null;
                if (TRIP_ZONES.GLAVNI({lat, lon})) currentZone = 'GLAVNI';
                else if (TRIP_ZONES.OTOK({lat, lon})) currentZone = 'OTOK';
                else if (TRIP_ZONES.VG({lat, lon})) currentZone = 'VG';
                
                if (prev.zone === 'GLAVNI' && currentZone !== 'GLAVNI') {
                    activeTrips[id] = { startZone: 'GLAVNI', startTime: now };
                } else if (prev.zone === 'VG' && currentZone !== 'VG') {
                    activeTrips[id] = { startZone: 'VG', startTime: now };
                }
                
                // Arriving at Otok
                if (prev.zone !== 'OTOK' && currentZone === 'OTOK') {
                    if (activeTrips[id]) {
                        const elapsedMins = (now - activeTrips[id].startTime) / 60000;
                        if (elapsedMins > 5 && elapsedMins < 45) { // sanity
                            if (activeTrips[id].startZone === 'GLAVNI') addTelemetry('glavniToOtok', elapsedMins);
                            if (activeTrips[id].startZone === 'VG') addTelemetry('vgToOtok', elapsedMins);
                            console.log(`[TELEMETRY] Bus ${id.slice(-5)} drove ${activeTrips[id].startZone} -> OTOK in ${elapsedMins.toFixed(1)} mins`);
                        }
                        delete activeTrips[id];
                    }
                }
                
                prev.lastDir = direction !== 'unknown' ? direction : prev.lastDir;
                prev.lat = lat; prev.lon = lon; prev.time = now; prev.zone = currentZone;
            } else {
                let initialZone = null;
                if (TRIP_ZONES.GLAVNI({lat, lon})) initialZone = 'GLAVNI';
                else if (TRIP_ZONES.OTOK({lat, lon})) initialZone = 'OTOK';
                else if (TRIP_ZONES.VG({lat, lon})) initialZone = 'VG';
                
                positionHistory[id] = { lat, lon, time: now, speeds: [], zone: initialZone };
                // FIRST sighting — no movement data yet. Bootstrap from GTFS.
                if (directionId === 0) { direction = 'toward_glavni'; dirSource = 'gtfs_boot'; }
                else if (directionId === 1) { direction = 'toward_vg'; dirSource = 'gtfs_boot'; }
            }

            // Live traffic modeling based on fleet movement
            let busTargetSpeed = avgSpeed > 10 ? avgSpeed : liveTrafficSpeed;
            // Floor of 16km/h prevents mathematically absurd red light ETAs while honoring heavy traffic
            const effectiveSpeed = Math.max(busTargetSpeed, 16);
            
            const roadFactor = 1.15; // Tuned specifically for Većeslava Holjevca's linear road curve
            const distOresk   = haversine(lat, lon, STOPS.oresk.lat,  STOPS.oresk.lon);
            const distGlavni  = haversine(lat, lon, STOPS.glavni.lat, STOPS.glavni.lon);
            const distVG      = haversine(lat, lon, STOPS.vg.lat, STOPS.vg.lon);
            const etaOresk    = Math.round((distOresk  * roadFactor) / effectiveSpeed * 60);
            const etaGlavni   = Math.round((distGlavni * roadFactor) / effectiveSpeed * 60);
            const etaVG       = Math.round((distVG * roadFactor) / effectiveSpeed * 60);

            console.log(`  [BUS] ${id.slice(-8)} | lat=${lat.toFixed(4)} | dir=${direction} (${dirSource}) | spd=${Math.round(speed)} | dGl=${distGlavni.toFixed(2)}km`);

            buses.push({
                id, routeId, lat, lon, bearing,
                speed: Math.round(speed),
                avgSpeed: Math.round(avgSpeed),
                direction, directionId, tripId,
                distOresk:  Math.round(distOresk  * 100) / 100,
                distGlavni: Math.round(distGlavni * 100) / 100,
                distVG:     Math.round(distVG * 100) / 100,
                etaOresk, etaGlavni, etaVG
            });
        });

        cachedBuses = buses;
        lastFetchTime = now;
        console.log(`[${new Date().toLocaleTimeString()}] 268 buses: ${buses.length}`);
    } catch (err) {
        console.error('Fetch error:', err.message);
    } finally {
        isFetching = false;
    }
}

app.get('/api/buses', (_req, res) => {
    res.json({
        buses: cachedBuses, 
        stops: STOPS, 
        lastUpdate: lastFetchTime,
        telemetry: {
            glavni_to_otok: getAverage('glavniToOtok', 15),
            vg_to_otok: getAverage('vgToOtok', 22)
        }
    });
});

// Plain HTTP — Render handles HTTPS automatically
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ZET ROYALE live on port ${PORT}\n`);
    fetchBuses(); // immediate first fetch on boot
});

// Always poll ZET every 12s — data ready the instant you open the app
setInterval(() => {
    if (!isFetching) fetchBuses();
}, 12000);
