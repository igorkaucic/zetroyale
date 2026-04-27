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
// Kill aggressive mobile caching
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});
app.use(express.static('public_v2'));
app.use(express.static('public'));

const HTTPS_PORT = 3268;
const HTTP_PORT  = 3269;

const ZET_URL = 'https://www.zet.hr/gtfs-rt-protobuf';

const positionHistory = {};
let cachedVehicles = [];
let lastFetchTime = 0;
let lastClientReqTime = 0;
let isFetching = false;

// ── Stops Data ──────────────────────────────────────
let allStops = [];
try {
    const stopsData = fs.readFileSync('zagreb_stops.json', 'utf8');
    allStops = JSON.parse(stopsData);
    console.log(`Loaded ${allStops.length} physical stops from zagreb_stops.json`);
} catch (e) {
    console.warn('⚠️ zagreb_stops.json not found! Stop names will fallback to generic names.');
}

function getNearestStop(lat, lon, fallbackName) {
    if (allStops.length === 0) return { id: fallbackName.toLowerCase().replace(/ /g, '_'), name: fallbackName, lat, lon };
    
    let bestDist = Infinity;
    let bestStop = null;
    
    for (const stop of allStops) {
        const d = haversineM(lat, lon, stop.lat, stop.lon);
        if (d < bestDist) {
            bestDist = d;
            bestStop = stop;
        }
    }
    
    // If the closest actual stop is more than 500m away, we probably don't have good data for this area.
    if (bestDist > 500 || !bestStop) {
        return { id: fallbackName.toLowerCase().replace(/ /g, '_'), name: fallbackName, lat, lon };
    }
    
    return bestStop;
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function haversineM(lat1, lon1, lat2, lon2) {
    return haversine(lat1, lon1, lat2, lon2) * 1000;
}

// ══════════════════════════════════════════════════
//  GTFS-RT: Fetch ALL vehicles from ZET
// ══════════════════════════════════════════════════
async function fetchVehicles() {
    if (isFetching) return;
    isFetching = true;
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
        const vehicles = [];
        const routeSet = new Set();

        feed.entity.forEach(entity => {
            if (!entity.vehicle || !entity.vehicle.position) return;
            const routeId = entity.vehicle.trip ? (entity.vehicle.trip.routeId || '') : '';
            if (!routeId) return;

            const id = entity.vehicle.vehicle?.label || entity.id;
            const lat = entity.vehicle.position.latitude;
            const lon = entity.vehicle.position.longitude;
            const bearing = entity.vehicle.position.bearing || 0;
            const directionId = entity.vehicle.trip ? entity.vehicle.trip.directionId : null;
            const tripId = entity.vehicle.trip ? entity.vehicle.trip.tripId : '';

            let speed = 0, heading = bearing;
            const prev = positionHistory[id];
            if (prev) {
                const dist = haversine(prev.lat, prev.lon, lat, lon);
                const dtHours = (now - prev.time) / 3600000;
                if (dtHours > 0.0001) speed = dist / dtHours;
                prev.speeds.push(speed);
                if (prev.speeds.length > 12) prev.speeds.shift();
                
                // Compute heading from GPS movement
                if (speed > 3) {
                    const dLon = (lon - prev.lon) * Math.PI / 180;
                    const y = Math.sin(dLon) * Math.cos(lat * Math.PI / 180);
                    const x = Math.cos(prev.lat * Math.PI / 180) * Math.sin(lat * Math.PI / 180)
                            - Math.sin(prev.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.cos(dLon);
                    heading = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
                }
                
                prev.lat = lat; prev.lon = lon; prev.time = now;
            } else {
                positionHistory[id] = { lat, lon, time: now, speeds: [] };
            }

            routeSet.add(routeId);

            // Extract route number for display (strip "ZET_" prefixes etc.)
            const linija = routeId.replace(/^ZET_/i, '').replace(/^0+/, '') || routeId;

            vehicles.push({
                garaza: id,
                linija,
                routeId,
                lat, lon,
                heading,
                bearing,
                speed: Math.round(speed),
                directionId,
                tripId,
                timestamp: now,
            });
        });

        cachedVehicles = vehicles;
        lastFetchTime = now;
        if (vehicles.length > 0) {
            console.log(`[${new Date().toLocaleTimeString()}] ${vehicles.length} vehicles on ${routeSet.size} routes`);
        }
    } catch (err) {
        console.error('Fetch error:', err.message);
    } finally {
        isFetching = false;
    }
}

// ══════════════════════════════════════════════════
//  SSE: Stream ALL vehicles to the client
// ══════════════════════════════════════════════════
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
    lastClientReqTime = Date.now();
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('\n');
    sseClients.add(res);

    // Send current data immediately
    const payload = JSON.stringify({
        vehicles: cachedVehicles,
        lastUpdate: lastFetchTime,
        vehicleCount: cachedVehicles.length,
        routeCount: new Set(cachedVehicles.map(v => v.linija)).size,
    });
    res.write(`data: ${payload}\n\n`);

    req.on('close', () => sseClients.delete(res));
});

function broadcastSSE() {
    const payload = JSON.stringify({
        vehicles: cachedVehicles,
        lastUpdate: lastFetchTime,
        vehicleCount: cachedVehicles.length,
        routeCount: new Set(cachedVehicles.map(v => v.linija)).size,
    });
    const msg = `data: ${payload}\n\n`;
    for (const client of sseClients) {
        try { client.write(msg); } catch (_) { sseClients.delete(client); }
    }
}

// ══════════════════════════════════════════════════
//  AUTO-DISCOVERY: /api/next-vehicle
//  Given origin + destination GPS, automatically finds
//  which routes have vehicles passing near BOTH points.
// ══════════════════════════════════════════════════
app.get('/api/next-vehicle', (req, res) => {
    lastClientReqTime = Date.now();
    const userLat = parseFloat(req.query.userLat);
    const userLon = parseFloat(req.query.userLon);
    const destLat = parseFloat(req.query.destLat);
    const destLon = parseFloat(req.query.destLon);

    if (isNaN(userLat) || isNaN(destLat)) {
        return res.json({ error: 'Missing coordinates' });
    }

    if (cachedVehicles.length === 0) {
        return res.json({ error: 'No vehicle data yet' });
    }

    // ── STEP 1: Group vehicles by route, compute bounding box + proximity ──
    const CORRIDOR_PAD_M = 2500; // 2.5km padding — the bus STOP is close, but the BUS could be anywhere
    const latPad = CORRIDOR_PAD_M / 111000;

    const routeInfo = {};

    cachedVehicles.forEach(v => {
        const r = v.linija;
        if (!routeInfo[r]) routeInfo[r] = {
            vehicles: [], minLat: 90, maxLat: -90, minLon: 180, maxLon: -180,
            minDistOrigin: Infinity, minDistDest: Infinity,
        };
        const info = routeInfo[r];
        info.vehicles.push(v);
        if (v.lat < info.minLat) info.minLat = v.lat;
        if (v.lat > info.maxLat) info.maxLat = v.lat;
        if (v.lon < info.minLon) info.minLon = v.lon;
        if (v.lon > info.maxLon) info.maxLon = v.lon;
        const dO = haversineM(v.lat, v.lon, userLat, userLon);
        const dD = haversineM(v.lat, v.lon, destLat, destLon);
        if (dO < info.minDistOrigin) info.minDistOrigin = dO;
        if (dD < info.minDistDest) info.minDistDest = dD;
    });

    // ── STEP 2: Classify routes using BOUNDING BOX (not vehicle proximity) ──
    // A route "serves" an area if the area falls within its vehicle corridor + padding.
    // This is correct because the bus STOP is near you even if no bus is there RIGHT NOW.
    const originRoutes = [];
    const destRoutes = [];

    for (const [route, info] of Object.entries(routeInfo)) {
        if (info.vehicles.length < 2) continue;
        const lonP = latPad / Math.cos((info.minLat + info.maxLat) / 2 * Math.PI / 180);
        const box = {
            minLat: info.minLat - latPad, maxLat: info.maxLat + latPad,
            minLon: info.minLon - lonP, maxLon: info.maxLon + lonP,
        };
        const coversOrigin = userLat >= box.minLat && userLat <= box.maxLat && userLon >= box.minLon && userLon <= box.maxLon;
        const coversDest = destLat >= box.minLat && destLat <= box.maxLat && destLon >= box.minLon && destLon <= box.maxLon;

        if (coversOrigin) originRoutes.push({ route, dist: info.minDistOrigin, vehicles: info.vehicles });
        if (coversDest) destRoutes.push({ route, dist: info.minDistDest, vehicles: info.vehicles });
    }

    // ── STEP 3a: Direct routes — route corridor covers BOTH areas ──
    const directMatches = [];
    for (const oR of originRoutes) {
        if (destRoutes.some(dR => dR.route === oR.route)) {
            directMatches.push({ route: oR.route, dist: oR.dist });
        }
    }

    // ── STEP 3b: Transfer routes ──
    // Transfer point = midpoint of the closest vehicle pair between routes
    const transferMatches = [];

    for (const rA of originRoutes) {
        for (const rB of destRoutes) {
            if (rA.route === rB.route) continue;

            // Find closest pair of vehicles between route A and route B
            let bestDist = Infinity, bestTxLat = 0, bestTxLon = 0;
            for (const vA of rA.vehicles) {
                for (const vB of rB.vehicles) {
                    const d = haversineM(vA.lat, vA.lon, vB.lat, vB.lon);
                    if (d < bestDist) {
                        bestDist = d;
                        bestTxLat = (vA.lat + vB.lat) / 2;
                        bestTxLon = (vA.lon + vB.lon) / 2;
                    }
                }
            }

            // Routes must have vehicles that get within 5km of each other (they cross somewhere)
            if (bestDist < 5000) {
                transferMatches.push({
                    routeA: rA.route, routeB: rB.route,
                    transferLat: bestTxLat, transferLon: bestTxLon,
                    distA: rA.dist, crossDist: bestDist,
                });
            }
        }
    }

    // ── STEP 4: Diversify ──
    transferMatches.sort((a, b) => (a.distA + a.crossDist * 0.5) - (b.distA + b.crossDist * 0.5));

    // Max 2 transfer options per unique first-leg route for variety
    const legACounts = {};
    const diversified = transferMatches.filter(t => {
        legACounts[t.routeA] = (legACounts[t.routeA] || 0) + 1;
        return legACounts[t.routeA] <= 2;
    }).slice(0, 12);

    // ── STEP 5: Build journey chains ──
    const journeyChains = [];
    const routes = [];

    directMatches.sort((a, b) => a.dist - b.dist);
    for (const m of directMatches) {
        routes.push(m.route);
        journeyChains.push({
            legs: [{
                route: m.route,
                departureStop: getNearestStop(userLat, userLon, 'Boarding Area'),
                arrivalStop: getNearestStop(destLat, destLon, 'Destination Area'),
            }]
        });
    }

    for (const t of diversified) {
        const label = `${t.routeA}→${t.routeB}`;
        routes.push(label);
        journeyChains.push({
            legs: [
                {
                    route: t.routeA,
                    departureStop: getNearestStop(userLat, userLon, 'Boarding Area'),
                    arrivalStop: getNearestStop(t.transferLat, t.transferLon, 'Transfer Area'),
                },
                {
                    route: t.routeB,
                    departureStop: getNearestStop(t.transferLat, t.transferLon, 'Transfer Area'),
                    arrivalStop: getNearestStop(destLat, destLon, 'Destination Area'),
                },
            ]
        });
    }

    console.log(`[PLANNER] ${userLat.toFixed(4)},${userLon.toFixed(4)} -> ${destLat.toFixed(4)},${destLon.toFixed(4)} : ${directMatches.length} direct + ${diversified.length} transfer (${originRoutes.length} origin, ${destRoutes.length} dest routes)`);
    if (diversified.length > 0) console.log(`[PLANNER] Routes: ${routes.slice(0, 8).join(', ')}`);

    res.json({ routes, journeyChains });
});

// ── API: Stops Search ──
app.get('/api/stops/all', (_req, res) => {
    res.json({ stops: allStops });
});

app.get('/api/stops', (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    const limit = parseInt(req.query.limit) || 10;
    if (!q) return res.json({ stops: [] });
    
    // Exact or starts-with match first, then includes
    let results = allStops.filter(s => s.name.toLowerCase().startsWith(q));
    if (results.length < limit) {
        results = results.concat(allStops.filter(s => s.name.toLowerCase().includes(q) && !s.name.toLowerCase().startsWith(q)));
    }
    
    res.json({ stops: results.slice(0, limit) });
});

// ── API: Nearby Departures & Schedule ──
app.get('/api/nearby-departures', (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (isNaN(lat) || isNaN(lon)) return res.json({ departures: [] });
    
    // Find vehicles heading toward this location
    const departures = [];
    const now = new Date();
    
    cachedVehicles.forEach(v => {
        const dist = haversineM(lat, lon, v.lat, v.lon);
        // Only consider vehicles within 5km
        if (dist > 5000) return;
        
        // Very basic direction check: is it getting closer?
        // We'll just calculate raw ETA based on distance and speed
        const speed = Math.max(v.speed, 15); // min 15km/h
        const walkMins = Math.round((dist / 1000) / 4 * 60); // 4km/h walking
        const driveMins = Math.round((dist / 1000) / speed * 60);
        
        // Get the real stop name nearest to where the vehicle currently is
        const nearestStop = getNearestStop(v.lat, v.lon, `Route ${v.linija}`);
        
        // Use real headsign from vehicle data if available, fallback to route ID
        const headsign = v.headsign || v.tripHeadsign || `Route ${v.linija}`;
        
        if (driveMins < 45) {
            const arrDate = new Date(now.getTime() + driveMins * 60000);
            const depStr = `${String(arrDate.getHours()).padStart(2, '0')}:${String(arrDate.getMinutes()).padStart(2, '0')}`;
            
            departures.push({
                route: v.linija,
                stopName: nearestStop.name,
                headsign: headsign,
                liveDepartureStr: depStr,
                departure: depStr,
                isLive: true,
                delay: 0,
                waitMins: driveMins,
                walkMins: walkMins
            });
        }
    });
    
    departures.sort((a, b) => a.waitMins - b.waitMins);
    
    // Deduplicate by route + headsign
    const uniqueDeps = [];
    const seen = new Set();
    for (const d of departures) {
        const key = `${d.route}-${d.headsign}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueDeps.push(d);
        }
    }
    
    res.json({ departures: uniqueDeps.slice(0, 15) });
});


app.get('/api/schedule', (req, res) => {
    const stopId = req.query.stopId;
    const stop = allStops.find(s => s.id == stopId);
    if (!stop) return res.json({ upcoming: [] });
    
    // Similar to nearby, but specifically for the exact stop lat/lon
    // Forwarding to nearby logic for simplicity
    req.query.lat = stop.lat;
    req.query.lon = stop.lon;
    
    // We mock the response format for schedule
    const departures = [];
    const now = new Date();
    
    cachedVehicles.forEach(v => {
        const dist = haversineM(stop.lat, stop.lon, v.lat, v.lon);
        if (dist > 5000) return;
        
        const speed = Math.max(v.speed, 15);
        const driveMins = Math.round((dist / 1000) / speed * 60);
        
        if (driveMins < 45) {
            const arrDate = new Date(now.getTime() + driveMins * 60000);
            const depStr = `${String(arrDate.getHours()).padStart(2, '0')}:${String(arrDate.getMinutes()).padStart(2, '0')}`;
            
            departures.push({
                route: v.linija,
                headsign: `Line ${v.linija}`,
                departure: depStr,
                isLive: true,
                delay: 0,
                waitMins: driveMins
            });
        }
    });
    
    departures.sort((a, b) => a.waitMins - b.waitMins);
    res.json({ upcoming: departures.slice(0, 10) });
});

// ── HŽPP Schedule stub (returns empty for now) ──
app.get('/api/hzpp-schedule', (_req, res) => {
    res.json({ upcoming: [] });
});

app.get('/api/hzpp', (_req, res) => {
    res.json({ error: 'Not implemented yet' });
});

// ── Server Startup ────────────────
if (isCloud) {
    app.listen(CLOUD_PORT, '0.0.0.0', () => {
        console.log(`\n☁️  ZET ROYALE — CLOUD BACKEND ONLINE ON PORT ${CLOUD_PORT}`);
        fetchVehicles(); // Immediate first fetch
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
        fetchVehicles(); // Immediate first fetch
    });
}

// ── Polling + Broadcasting ────────────────
setInterval(async () => {
    if (sseClients.size > 0 || Date.now() - lastClientReqTime < 30000) {
        await fetchVehicles();
        broadcastSSE();
    }
}, 10000);
