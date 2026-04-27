const { Client } = require('ssh2');

const BASH_SCRIPT = `
set -e
echo "Building React frontend..."
cd /srv/users/serverpilot/apps/zetroyale/repo/client
npm install --legacy-peer-deps
npm run build

echo "Moving build to public_v2..."
cd /srv/users/serverpilot/apps/zetroyale/repo
rm -rf public_v2
cp -r client/dist public_v2

echo "Fixing permissions..."
chown -R serverpilot:serverpilot /srv/users/serverpilot/apps/zetroyale

echo "Restarting PM2..."
pm2 restart zetroyale
echo "DONE"
`;

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH connection established. Running build script...');
  conn.exec(BASH_SCRIPT, (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Build script finished with exit code', code);
      conn.end();
    }).on('data', (data) => {
      process.stdout.write(data.toString());
    }).stderr.on('data', (data) => {
      process.stderr.write(data.toString());
    });
  });
}).on('error', (err) => {
  console.error('SSH Error:', err);
}).connect({
  host: '46.101.220.44',
  port: 22,
  username: 'root',
  password: 'Novcanik1!'
});
