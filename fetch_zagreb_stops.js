const axios = require('axios');
const fs = require('fs');

const query = `[out:json][timeout:25];(node["highway"="bus_stop"](45.65, 15.75, 45.95, 16.20);node["railway"="tram_stop"](45.65, 15.75, 45.95, 16.20););out body;`;

console.log('Fetching bus/tram stops from OSM for Zagreb area...');
axios.post('https://overpass-api.de/api/interpreter', query, {
    headers: { 
        'Content-Type': 'text/plain',
        'Accept': 'application/json',
        'User-Agent': 'ZetRoyale/1.0 (test@example.com)'
    }
})
.then(res => {
    const stops = [];
    res.data.elements.forEach(el => {
        if (el.tags && el.tags.name) {
            stops.push({
                id: el.id,
                name: el.tags.name,
                lat: el.lat,
                lon: el.lon,
                type: el.tags.highway === 'bus_stop' ? 'bus' : 'tram'
            });
        }
    });
    console.log(`Found ${stops.length} named stops.`);
    fs.writeFileSync('zagreb_stops.json', JSON.stringify(stops));
    console.log('Saved to zagreb_stops.json');
})
.catch(err => {
    console.error('Failed:', err.message);
});
