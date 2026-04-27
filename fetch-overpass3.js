const axios = require('axios');
const q = `[out:json];(node[railway=station](45.7, 15.6, 45.9, 16.3);node[railway=halt](45.7, 15.6, 45.9, 16.3););out body;`;
axios.post('https://overpass-api.de/api/interpreter', q, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
  .then(res => {
    res.data.elements.forEach(el => {
      if (el.tags && el.tags.name) {
        console.log(`  { id: 'hz_${el.tags.name.toLowerCase().replace(/ /g, '_')}', name: 'HŽ ${el.tags.name}', lat: ${el.lat}, lon: ${el.lon}, routes: ['HŽPP'], isHZPP: true },`);
      }
    });
  })
  .catch(err => console.log('Error', err.response ? err.response.status : err.message));
