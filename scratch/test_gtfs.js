const axios = require('axios');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

async function testFetch() {
    console.log("Fetching live ZET GTFS-RT feed...");
    try {
        const resp = await axios({
            method: 'GET',
            url: 'https://www.zet.hr/gtfs-rt-protobuf',
            responseType: 'arraybuffer'
        });
        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
            new Uint8Array(resp.data)
        );
        
        console.log(`Successfully fetched. Total vehicle entities found: ${feed.entity.length}`);
        
        // Count unique routes to see if we have everything
        const routeCounts = {};
        let sampleEntities = [];
        
        feed.entity.forEach(entity => {
            if (!entity.vehicle || !entity.vehicle.trip) return;
            const routeId = entity.vehicle.trip.routeId || 'Unknown';
            
            if (!routeCounts[routeId]) {
                routeCounts[routeId] = 0;
            }
            routeCounts[routeId]++;
            
            // Just collect a sample of different routes to show
            if (sampleEntities.length < 15 && Object.keys(routeCounts).length > sampleEntities.length) {
                sampleEntities.push({
                    id: entity.id,
                    route: routeId,
                    lat: entity.vehicle.position?.latitude,
                    lon: entity.vehicle.position?.longitude
                });
            }
        });
        
        console.log(`\nFound ${Object.keys(routeCounts).length} unique transit routes active right now.\n`);
        
        console.log("=== ROUTE FREQUENCY SAMPLE (Top 10) ===");
        const sortedRoutes = Object.entries(routeCounts).sort((a,b) => b[1] - a[1]).slice(0, 10);
        sortedRoutes.forEach(([route, count]) => {
            console.log(`Route ${route}: ${count} active vehicles`);
        });
        
        console.log("\n=== RANDOM VEHICLE SAMPLE ===");
        sampleEntities.forEach(v => {
            console.log(`Vehicle ${v.id.slice(-5)} | Route: ${v.route} | Pos: ${v.lat}, ${v.lon}`);
        });

    } catch (err) {
        console.error("Error fetching data:", err.message);
    }
}
testFetch();
