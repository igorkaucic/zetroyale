const axios = require('axios');
async function run() {
    try {
        const url = 'https://mapper-motis.ojpp-gateway.derp.si/api/v1/map/stops?min=45.7%2C15.6&max=45.9%2C16.3&zoom=20';
        const res = await axios.get(url);
        const stops = res.data.filter(s => ['harmica', 'zaprešić', 'podsused', 'gajnice', 'vrapče', 'kustošija', 'zapadni kolodvor', 'glavni kolodvor', 'maksimir', 'trnava', 'čulinec', 'sesvete', 'dugo selo'].some(n => s.name.toLowerCase().includes(n)));
        stops.forEach(s => console.log(`  { id: "hz_${s.name.toLowerCase().replace(/ /g, '_')}", name: "HŽ ${s.name}", lat: ${s.lat}, lon: ${s.lon}, routes: ["HŽPP"], isHZPP: true },`));
    } catch(e) { console.log(e.message); }
}
run();
