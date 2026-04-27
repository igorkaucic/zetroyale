const axios = require('axios');
const stations = ['Gajnice', 'Vrapce', 'Kustosija', 'Zapadni Kolodvor', 'Glavni Kolodvor', 'Maksimir', 'Trnava', 'Culinec', 'Sesvete', 'Podsused'];

async function getCoords(name) {
    try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name + ' train station zagreb')}&format=json&limit=1`;
        const res = await axios.get(url, { headers: { 'User-Agent': 'ZET-Royale-Script' } });
        if (res.data && res.data.length > 0) {
            return { lat: res.data[0].lat, lon: res.data[0].lon, name: res.data[0].display_name };
        }
        
        const url2 = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name + ' station zagreb')}&format=json&limit=1`;
        const res2 = await axios.get(url2, { headers: { 'User-Agent': 'ZET-Royale-Script' } });
        if (res2.data && res2.data.length > 0) {
            return { lat: res2.data[0].lat, lon: res2.data[0].lon, name: res2.data[0].display_name };
        }
    } catch(e) {}
    return null;
}

async function run() {
    for (const s of stations) {
        const data = await getCoords(s);
        if (data) {
            console.log(`  { id: 'hz_${s.toLowerCase().replace(/ /g, '_')}', name: 'HŽ ${s}', lat: ${parseFloat(data.lat).toFixed(6)}, lon: ${parseFloat(data.lon).toFixed(6)}, routes: ['HŽPP'], isHZPP: true }, // ${data.name}`);
        } else {
            console.log(`  // Could not find ${s}`);
        }
        await new Promise(r => setTimeout(r, 1500));
    }
}
run();
