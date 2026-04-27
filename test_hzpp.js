const axios = require('axios');
axios.get('https://www.hzpp.app/?trainId=8016')
    .then(r => console.log(r.data.includes('Kolodvor')))
    .catch(console.error);
