// Debug: check what bounding boxes look like for routes
const https = require('https');

// Fetch directly from ZET to see what data looks like
const axios = require('axios');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

async function main() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const resp = await axios({
        method: 'GET',
        url: 'https://www.zet.hr/gtfs-rt-protobuf',
        responseType: 'arraybuffer',
        timeout: 12000
    });

    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(resp.data)
    );

    const vehicles = [];
    feed.entity.forEach(entity => {
        if (!entity.vehicle || !entity.vehicle.position) return;
        const routeId = entity.vehicle.trip ? (entity.vehicle.trip.routeId || '') : '';
        if (!routeId) return;
        const linija = routeId.replace(/^ZET_/i, '').replace(/^0+/, '') || routeId;
        vehicles.push({
            linija,
            lat: entity.vehicle.position.latitude,
            lon: entity.vehicle.position.longitude,
        });
    });

    console.log('Total vehicles:', vehicles.length);

    // Group by route
    const routes = {};
    vehicles.forEach(v => {
        if (!routes[v.linija]) routes[v.linija] = [];
        routes[v.linija].push(v);
    });

    const originLat = 45.7591, originLon = 15.9844;  // Work (Oreškovićeva)
    const destLat = 45.8156, destLon = 15.8763;      // Home (Hrvatskih iseljenika)

    console.log('\nOrigin (Work):', originLat, originLon);
    console.log('Dest (Home):', destLat, destLon);
    console.log('\n--- Routes where BOTH origin AND dest are in padded bbox ---');

    const PAD = 2000 / 111000; // ~2km in degrees

    let found = 0;
    for (const [route, veh] of Object.entries(routes)) {
        if (veh.length < 2) continue;
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        veh.forEach(v => {
            if (v.lat < minLat) minLat = v.lat;
            if (v.lat > maxLat) maxLat = v.lat;
            if (v.lon < minLon) minLon = v.lon;
            if (v.lon > maxLon) maxLon = v.lon;
        });

        const lonPad = PAD / Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
        const pMinLat = minLat - PAD, pMaxLat = maxLat + PAD;
        const pMinLon = minLon - lonPad, pMaxLon = maxLon + lonPad;

        const oIn = originLat >= pMinLat && originLat <= pMaxLat && originLon >= pMinLon && originLon <= pMaxLon;
        const dIn = destLat >= pMinLat && destLat <= pMaxLat && destLon >= pMinLon && destLon <= pMaxLon;

        if (oIn || dIn) {
            console.log(`Route ${route} (${veh.length} veh): bbox lat [${minLat.toFixed(4)}, ${maxLat.toFixed(4)}] lon [${minLon.toFixed(4)}, ${maxLon.toFixed(4)}] | origin:${oIn} dest:${dIn} ${oIn && dIn ? '✓ MATCH' : ''}`);
            if (oIn && dIn) found++;
        }
    }
    console.log(`\nTotal matching routes: ${found}`);
}

main().catch(console.error);
