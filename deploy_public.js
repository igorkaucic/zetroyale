const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Zipping public_v2...');
try {
  if (fs.existsSync('public_v2.tar.gz')) fs.unlinkSync('public_v2.tar.gz');
  execSync('tar.exe -czf public_v2.tar.gz -C public_v2 .');
} catch (err) {
  console.error('Tar failed:', err);
  process.exit(1);
}

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH ready. Uploading zip...');
  conn.sftp((err, sftp) => {
    if (err) throw err;
    const remotePath = '/srv/users/serverpilot/apps/zetroyale/repo/public_v2.tar.gz';
    sftp.fastPut('public_v2.tar.gz', remotePath, (err) => {
      if (err) throw err;
      console.log('Upload complete. Extracting and restarting...');
      
      const BASH_SCRIPT = `
set -e
cd /srv/users/serverpilot/apps/zetroyale/repo
rm -rf public_v2
mkdir public_v2
tar -xzf public_v2.tar.gz -C public_v2
chown -R serverpilot:serverpilot public_v2
rm public_v2.tar.gz
pm2 restart zetroyale
echo "DONE"
      `;
      conn.exec(BASH_SCRIPT, (err, stream) => {
        if (err) throw err;
        stream.on('close', (code) => {
          console.log('Done with code', code);
          conn.end();
        }).on('data', (d) => process.stdout.write(d))
          .stderr.on('data', (d) => process.stderr.write(d));
      });
    });
  });
}).on('error', (err) => console.error(err)).connect({
  host: '46.101.220.44',
  port: 22,
  username: 'root',
  password: 'Novcanik1!'
});
