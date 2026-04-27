const axios = require('axios');
axios.get('https://api.hzpp.hr/api/public/Vlak?BrojVlaka=8016')
    .then(r => console.log(r.data))
    .catch(console.error);
