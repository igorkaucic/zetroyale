const axios = require('axios');
const stations = ['Gajnice', 'Vrapče', 'Kustošija', 'Zapadni Kolodvor', 'Glavni Kolodvor', 'Maksimir', 'Trnava', 'Čulinec', 'Sesvete'];
async function run() {
  for (const s of stations) {
    try {
      let res = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: { q: \\ train station, Zagreb\, format: 'json', limit: 1 },
        headers: { 'User-Agent': 'ZET Royale Tracker' }
      });
      if (res.data.length === 0) {
        res = await axios.get('https://nominatim.openstreetmap.org/search', {
          params: { q: \Željeznička stanica \, Zagreb\, format: 'json', limit: 1 },
          headers: { 'User-Agent': 'ZET Royale Tracker' }
        });
      }
      if (res.data.length > 0) {
        console.log(\{ id: 'hz_\', name: '\', lat: \, lon: \, routes: ['HŽPP'], isHZPP: true },\);
      } else {
        console.log(\// Not found: \\);
      }
    } catch(e) { console.log('Error', e.message); }
    await new Promise(r => setTimeout(r, 1500));
  }
}
run();
