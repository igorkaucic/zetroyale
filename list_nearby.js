const https = require('https');
const fs = require('fs');

const agent = new https.Agent({ rejectUnauthorized: false });

// Read GPS from settings.json
const settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));
const lat = settings.home.lat;
const lon = settings.home.lon;

const now = new Date();
const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

console.log(`\n📍 ${timeStr} — All catchable buses from ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
console.log(`   Walk speed: ~5 km/h. Only showing buses you can physically reach.\n`);

// Use the smart nearby-departures endpoint — it already factors in walk time
https.get(`https://localhost:3268/api/nearby-departures?lat=${lat}&lon=${lon}`, { agent }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        const info = JSON.parse(d);

        if (!info.departures || info.departures.length === 0) {
            console.log("No catchable departures found in the next 90 minutes.");
            return;
        }

        // Print clean table
        console.log("DEPARTS  | WALK | WAIT | ROUTE | FROM                      | HEADING TO");
        console.log("---------|------|------|-------|---------------------------|---------------------");

        info.departures.forEach(dep => {
            const depTime = dep.departure.slice(0, 5);
            const walkStr = `${dep.walkMins}m`.padEnd(4);
            const waitStr = `${dep.waitMins}m`.padEnd(4);
            const route = dep.route.padEnd(5);
            const stop = dep.stopName.padEnd(25);
            const headsign = dep.headsign || '???';
            const liveTag = dep.isLive ? (dep.delay > 0 ? ` ⚠ +${dep.delay}m` : ' ✅') : '';
            console.log(`${depTime}    | ${walkStr} | ${waitStr} | ${route} | ${stop} | ${headsign}${liveTag}`);
        });

        console.log(`\n✅ ${info.departures.length} catchable departures shown (90-min lookahead)\n`);
    });
}).on('error', err => {
    console.error("Error connecting to local proxy. Is server.js running?", err.message);
});
