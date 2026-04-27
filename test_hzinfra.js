const axios = require('axios');
axios.get('https://vred.hzinfra.hr/hzinfo/default.asp?vl=8016')
    .then(r => console.log(r.data.substring(0, 1500)))
    .catch(console.error);
