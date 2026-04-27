const express = require('express');
const axios = require('axios');
const cors = require('cors');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');

// ── Server Startup (Local HTTPS vs Cloud HTTP) ────────────────
const isCloud = process.env.PORT != null;
const CLOUD_PORT = process.env.PORT || 3000;

// ── Load the real certs (only needed for local dev) ─────
let httpsOptions = {};
if (!isCloud) {
    try {
        httpsOptions = {
            key:  fs.readFileSync('localhost-key.pem'),
            cert: fs.readFileSync('localhost.pem')
        };
    } catch (e) {
        console.warn('⚠️ Local certs missing. HTTPS will fail if not in cloud mode.');
    }
}

const app = express();
app.use(cors());
app.use(express.static('public_v2'));
app.use(express.static('public'));

const HTTPS_PORT = 3268;
const HTTP_PORT  = 3269;

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

        // DEBUG: dump all unique routeIds to find 268 format
        const allRoutes = new Set();
        feed.entity.forEach(e => {
            if (e.vehicle && e.vehicle.trip) allRoutes.add(e.vehicle.trip.routeId || '?');
        });
        const r268 = [...allRoutes].filter(r => r.includes('268'));
        console.log(`[DEBUG] Total vehicles: ${feed.entity.length}, unique routes: ${allRoutes.size}, 268-matching: [${r268.join(', ')}]`);

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

            // ── Direction detection ─────────────────────────────────────
            // Priority 1: directionId from GTFS-RT (most reliable, persists even when stopped)
            let direction = 'unknown';
            if (directionId !== null) {
                // 0 = toward Glavni Kolodvor (inbound), 1 = toward Velika Gorica (outbound)
                // NOTE: mapping confirmed by real-world observation
                direction = directionId === 0 ? 'toward_glavni' : 'toward_vg';
            }

            // Priority 2: bearing from GTFS (if directionId missing)
            if (direction === 'unknown' && bearing) {
                if (bearing > 315 || bearing < 45) direction = 'toward_glavni';
                else if (bearing > 135 && bearing < 225) direction = 'toward_vg';
            }

            // Priority 3: latDelta — ONLY override when bus is actually moving (speed > 3 km/h)
            // Prevents GPS noise at stops from flipping the direction label
            if (prev && speed > 3) {
                const latDelta = lat - prev.lat;
                if (Math.abs(latDelta) > 0.0002) // stricter threshold
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
    // If our cached data is older than 5 seconds, try to fetch immediately
    if (Date.now() - lastFetchTime > 5000 && !isFetching) {
        await fetchBuses();
    }
    res.json({ buses: cachedBuses, stops: STOPS, lastUpdate: lastFetchTime });
});

// ── Server Startup ────────────────
if (isCloud) {
    app.listen(CLOUD_PORT, '0.0.0.0', () => {
        console.log(`\n☁️  ZET ROYALE — CLOUD BACKEND ONLINE ON PORT ${CLOUD_PORT}`);
    });
} else {
    // Local Dev: HTTP → HTTPS redirect
    http.createServer((req, res) => {
        const host = (req.headers.host || 'localhost').replace(`:${HTTP_PORT}`, '');
        res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
        res.end();
    }).listen(HTTP_PORT, '::', () => {
        console.log(`↪ HTTP redirect on port ${HTTP_PORT}`);
    });

    // Local Dev: HTTPS main server
    https.createServer(httpsOptions, app).listen(HTTPS_PORT, '::', () => {
        const nets = os.networkInterfaces();
        console.log('\n==========================================');
        console.log('🔒 ZET ROYALE — LOCAL HTTPS ONLINE');
        console.log('==========================================');
        console.log(`💻 PC:    https://localhost:${HTTPS_PORT}`);
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal)
                    console.log(`📱 Phone: https://${net.address}:${HTTPS_PORT}`);
            }
        }
        console.log('==========================================\n');
    });
}

// Smart fetch loop: only fetch if a client requested data in the last 30 seconds
setInterval(() => {
    if (Date.now() - lastClientReqTime < 30000 && !isFetching) {
        fetchBuses();
    }
}, 10000);
