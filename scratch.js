const fs = require('fs');

const stopTimesRaw = fs.readFileSync('hzpp_gtfs/stop_times.txt', 'utf8');
const tripsRaw = fs.readFileSync('hzpp_gtfs/trips.txt', 'utf8');
const routesRaw = fs.readFileSync('hzpp_gtfs/routes.txt', 'utf8');

const tripStops = {};
stopTimesRaw.split('\n').forEach(line => {
    const parts = line.split(',');
    if (parts.length > 4) {
        const trip_id = parts[0];
        const stop_id = parts[3];
        const stop_sequence = parseInt(parts[4]);
        if (!tripStops[trip_id]) tripStops[trip_id] = [];
        tripStops[trip_id].push({ stop_id, seq: stop_sequence });
    }
});

const validTrips = [];
for (const trip_id in tripStops) {
    const stops = tripStops[trip_id];
    let gajniceSeq = -1;
    let zagrebSeq = -1;
    for (const s of stops) {
        if (s.stop_id === 'i-o697') gajniceSeq = s.seq;
        if (s.stop_id === 'i-o523') zagrebSeq = s.seq;
    }
    if (gajniceSeq !== -1 && zagrebSeq !== -1) {
        validTrips.push(trip_id);
    }
}

const tripToRoute = {};
tripsRaw.split('\n').slice(1).forEach(line => {
    const parts = line.split(',');
    if (parts.length > 2) {
        tripToRoute[parts[2]] = parts[0]; // trip_id -> route_id
    }
});

const routeToName = {};
routesRaw.split('\n').slice(1).forEach(line => {
    const parts = line.split(',');
    if (parts.length > 3) {
        routeToName[parts[0]] = parts[2] || parts[3]; // route_id -> name
    }
});

const routeNames = new Set();
validTrips.forEach(trip_id => {
    const route_id = tripToRoute[trip_id];
    if (route_id && routeToName[route_id]) {
        routeNames.add(routeToName[route_id].replace(/"/g, ''));
    }
});

console.log([...routeNames]);
