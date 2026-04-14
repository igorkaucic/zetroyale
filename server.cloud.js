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
    oresk:   { name: 'Oreškovićeva',    lat: 45.7595, lon: 15.9835 },
    glavni:  { name: 'Glavni Kolodvor', lat: 45.80292, lon: 15.97724 }
};

const positionHistory = {};
let cachedBuses = [];
let lastFetchTime = 0;
let lastClientReqTime = 0;
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
            if (prev) {
                const dist = haversine(prev.lat, prev.lon, lat, lon);
                const dtHours = (now - prev.time) / 3600000;
                if (dtHours > 0.0001) speed = dist / dtHours;
                prev.speeds.push(speed);
                if (prev.speeds.length > 12) prev.speeds.shift();
                avgSpeed = prev.speeds.reduce((a, b) => a + b, 0) / prev.speeds.length;
                prev.lat = lat; prev.lon = lon; prev.time = now;
            } else {
                positionHistory[id] = { lat, lon, time: now, speeds: [] };
            }

            let direction = 'unknown';
            if (directionId !== null) {
                direction = directionId === 0 ? 'toward_glavni' : 'toward_vg';
            }
            if (direction === 'unknown' && bearing) {
                if (bearing > 315 || bearing < 45) direction = 'toward_glavni';
                else if (bearing > 135 && bearing < 225) direction = 'toward_vg';
            }
            if (prev && speed > 3) {
                const latDelta = lat - prev.lat;
                if (Math.abs(latDelta) > 0.0002)
                    direction = latDelta > 0 ? 'toward_glavni' : 'toward_vg';
            }

            const effectiveSpeed = avgSpeed > 5 ? avgSpeed : (speed > 5 ? speed : 25);
            const roadFactor = 1.35;
            const distOresk   = haversine(lat, lon, STOPS.oresk.lat,  STOPS.oresk.lon);
            const distGlavni  = haversine(lat, lon, STOPS.glavni.lat, STOPS.glavni.lon);
            const etaOresk    = Math.round((distOresk  * roadFactor) / effectiveSpeed * 60);
            const etaGlavni   = Math.round((distGlavni * roadFactor) / effectiveSpeed * 60);

            buses.push({
                id, routeId, lat, lon, bearing,
                speed: Math.round(speed),
                avgSpeed: Math.round(avgSpeed),
                direction, directionId, tripId,
                distOresk:  Math.round(distOresk  * 100) / 100,
                distGlavni: Math.round(distGlavni * 100) / 100,
                etaOresk, etaGlavni
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

app.get('/api/buses', async (_req, res) => {
    lastClientReqTime = Date.now();
    if (Date.now() - lastFetchTime > 5000 && !isFetching) {
        await fetchBuses();
    }
    res.json({ buses: cachedBuses, stops: STOPS, lastUpdate: lastFetchTime });
});

// Plain HTTP — Render handles HTTPS automatically
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ZET ROYALE live on port ${PORT}\n`);
});

// Smart fetch loop
setInterval(() => {
    if (Date.now() - lastClientReqTime < 30000 && !isFetching) {
        fetchBuses();
    }
}, 10000);
