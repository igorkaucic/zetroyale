const {Client} = require('ssh2');
const c = new Client();
c.on('ready', () => {
    const cmd = `curl -s 'http://127.0.0.1:3000/api/next-vehicle?userLat=45.7591&userLon=15.9844&destLat=45.8156&destLon=15.8763'`;
    c.exec(cmd, (e, s) => {
        let out = '';
        s.on('close', () => {
            try {
                const j = JSON.parse(out);
                console.log('Routes found:', j.routes?.length);
                console.log('Routes:', j.routes);
                j.journeyChains?.forEach((chain, i) => {
                    const legs = chain.legs.map(l => l.route).join(' → ');
                    console.log(`  Chain ${i}: ${legs}`);
                });
            } catch(e) { console.log(out); }
            c.end();
        }).on('data', (d) => out += d.toString())
          .stderr.on('data', (d) => process.stderr.write(d.toString()));
    });
}).connect({
    host: '46.101.220.44', port: 22, username: 'root', password: 'Novcanik1!'
});
