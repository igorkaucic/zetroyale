const fs = require('fs');

const stopTimesRaw = fs.readFileSync('hzpp_gtfs/stop_times.txt', 'utf8');
const tripsRaw = fs.readFileSync('hzpp_gtfs/trips.txt', 'utf8');

const GAJNICE_ID = 'i-o697';
const ZAGREB_GK_ID = 'i-o523';

// 1. Find all trips that contain both Gajnice and Zagreb GK
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
    
    // Check if it goes from Gajnice TO Zagreb (Gajnice is before Zagreb)
    if (gajnice && zagreb && gajnice.seq < zagreb.seq) {
        validTrips.push({ trip_id, gajniceTime: gajnice.arrival_time, zagrebTime: zagreb.arrival_time });
    }
}

// 2. Map trip_id to Train Number (trip_short_name)
const tripToTrainNumber = {};
tripsRaw.split('\n').slice(1).forEach(line => {
    const parts = line.split(',');
    if (parts.length > 4) {
        const route_id = parts[0];
        const service_id = parts[1];
        const trip_id = parts[2];
        const train_number = parts[4]; // trip_short_name is usually train number
        tripToTrainNumber[trip_id] = { train_number, service_id };
    }
});

// 3. Filter for morning trains (e.g., between 06:00:00 and 09:00:00)
const morningTrains = validTrips.filter(t => t.gajniceTime >= '06:00:00' && t.gajniceTime <= '09:00:00');

// Sort by departure time
morningTrains.sort((a, b) => a.gajniceTime.localeCompare(b.gajniceTime));

console.log('Morning trains from Gajnice to Zagreb Glavni Kolodvor (06:00 - 09:00):');
morningTrains.forEach(t => {
    const info = tripToTrainNumber[t.trip_id];
    console.log(`Train ${info ? info.train_number : 'Unknown'} | Gajnice: ${t.gajniceTime} -> Zagreb GK: ${t.zagrebTime}`);
});
