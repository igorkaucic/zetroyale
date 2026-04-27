const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });

const homeLat = 45.8151578571005;
const homeLon = 15.876268392931646;

// Haversine formula
function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dPhi = (lat2 - lat1) * Math.PI / 180;
    const dLam = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) * Math.sin(dLam / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

https.get('https://localhost:3268/api/stops?q=bolonj', { agent }, res => {
    let d = '';
    res.on('data', c => d+=c);
    res.on('end', () => {
        const stops = JSON.parse(d).stops;
        console.log("Bolonja stops found:");
        stops.forEach(s => {
            const dist = haversineM(homeLat, homeLon, s.lat, s.lon);
            console.log(`- ${s.name} (${s.id}) at ${Math.round(dist)} meters away. Routes: ${s.routes}`);
        });
    });
}).on('error', console.error);
