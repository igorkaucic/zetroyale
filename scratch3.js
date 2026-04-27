const fs = require('fs');
const stopTimesRaw = fs.readFileSync('hzpp_gtfs/stop_times.txt', 'utf8');

const GAJNICE_ID = 'i-o697';
const ZAGREB_GK_ID = 'i-o523';

const tripStops = {};
stopTimesRaw.split('\n').forEach(line => {
    const parts = line.split(',');
    if (parts.length > 4) {
        const trip_id = parts[0];
        const arrival_time = parts[1];
        const stop_id = parts[3];
        const stop_sequence = parseInt(parts[4]);
        
        if (!tripStops[trip_id]) tripStops[trip_id] = [];
        tripStops[trip_id].push({ stop_id, arrival_time, seq: stop_sequence });
    }
});

const validTrips = [];
for (const trip_id in tripStops) {
    const stops = tripStops[trip_id];
    let gajnice = null;
    let zagreb = null;
    for (const s of stops) {
        if (s.stop_id === GAJNICE_ID) gajnice = s;
        if (s.stop_id === ZAGREB_GK_ID) zagreb = s;
    }
    if (gajnice && zagreb && gajnice.seq < zagreb.seq) {
        validTrips.push({ trip_id, gajniceTime: gajnice.arrival_time, zagrebTime: zagreb.arrival_time });
    }
}
console.log('Total trips:', validTrips.length);
validTrips.slice(0, 5).forEach(t => console.log(t));
