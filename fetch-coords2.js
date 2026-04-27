const axios = require('axios');
const queries = [
    { id: 'hz_gajnice', q: 'Gajnice railway station' },
    { id: 'hz_vrapce', q: 'Vrapče railway station' },
    { id: 'hz_kustosija', q: 'Kustošija railway station' },
    { id: 'hz_maksimir', q: 'Maksimir railway station' },
    { id: 'hz_trnava', q: 'Trnava railway station' },
    { id: 'hz_culinec', q: 'Čulinec railway station' },
    { id: 'hz_podsused', q: 'Podsused railway station' },
    { id: 'hz_zapresic', q: 'Zaprešić railway station' },
    { id: 'hz_dugoselo', q: 'Dugo Selo railway station' }
];
async function run() {
    for (const item of queries) {
        try {
            let res = await axios.get(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(item.q)}&format=json&limit=1`);
            if (res.data.length === 0) {
                res = await axios.get(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(item.q.replace('railway station', 'stajalište'))}&format=json&limit=1`);
            }
            if (res.data.length > 0) {
                console.log(`  { id: '${item.id}', name: 'HŽ ${item.id.replace('hz_', '').toUpperCase()}', lat: ${parseFloat(res.data[0].lat).toFixed(6)}, lon: ${parseFloat(res.data[0].lon).toFixed(6)}, routes: ['HŽPP'], isHZPP: true },`);
            } else {
                console.log(`  // NOT FOUND: ${item.q}`);
            }
        } catch(e) {}
        await new Promise(r => setTimeout(r, 1000));
    }
}
run();
