const axios = require('axios');
const stations = [
  'Harmica', 'Zaprešić', 'Podsused', 'Gajnice', 'Vrapče', 'Kustošija', 'Maksimir', 'Trnava', 'Čulinec', 'Dugo Selo'
];

async function run() {
  for (const s of stations) {
    try {
      const q = encodeURIComponent(`željeznička postaja ${s}`);
      const res = await axios.get(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&countrycodes=HR`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (res.data.length > 0) {
        console.log(`  { id: 'hz_${s.toLowerCase().replace(/ /g, '_').replace(/č/g, 'c').replace(/ć/g, 'c').replace(/š/g, 's')}', name: 'HŽ ${s}', lat: ${parseFloat(res.data[0].lat).toFixed(6)}, lon: ${parseFloat(res.data[0].lon).toFixed(6)}, routes: ['HŽPP'], isHZPP: true },`);
      } else {
        const q2 = encodeURIComponent(`željeznički kolodvor ${s}`);
        const res2 = await axios.get(`https://nominatim.openstreetmap.org/search?q=${q2}&format=json&countrycodes=HR`, { headers: { 'User-Agent': 'Mozilla/5.0' }});
        if (res2.data.length > 0) {
            console.log(`  { id: 'hz_${s.toLowerCase().replace(/ /g, '_').replace(/č/g, 'c').replace(/ć/g, 'c').replace(/š/g, 's')}', name: 'HŽ ${s}', lat: ${parseFloat(res2.data[0].lat).toFixed(6)}, lon: ${parseFloat(res2.data[0].lon).toFixed(6)}, routes: ['HŽPP'], isHZPP: true },`);
        } else {
            console.log(`  // STILL NOT FOUND: ${s}`);
        }
      }
    } catch(e) { console.log('Error', e.message); }
    await new Promise(r => setTimeout(r, 1000));
  }
}
run();
