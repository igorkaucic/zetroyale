const fs = require('fs');
const { execSync } = require('child_process');
const { Client } = require('ssh2');
const path = require('path');

// 1. READ AND BUMP VERSION
console.log('--- 1. Bumping Version ---');
const pkgPath = path.join(__dirname, 'client', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Increment patch version
const parts = pkg.version.split('.');
parts[2] = parseInt(parts[2], 10) + 1;
const newVersion = parts.join('.');

pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Updated package.json to ${newVersion}`);

// Update version.ts
const versionTsPath = path.join(__dirname, 'client', 'src', 'version.ts');
const tsContent = `export const APP_VERSION = '${newVersion}';\n`;
fs.writeFileSync(versionTsPath, tsContent);
console.log(`Updated version.ts to ${newVersion}`);

// 2. BUILD CLIENT
console.log('\n--- 2. Building Client ---');
try {
  execSync('npm run build --prefix client', { stdio: 'inherit' });
} catch (e) {
  console.error('Build failed');
  process.exit(1);
}

// 3. ZIP ARTIFACT
console.log('\n--- 3. Zipping Build ---');
try {
  if (fs.existsSync('public_v2.tar.gz')) fs.unlinkSync('public_v2.tar.gz');
  execSync('tar.exe -czf public_v2.tar.gz -C public_v2 .');
} catch (err) {
  console.error('Tar failed:', err);
  process.exit(1);
}

// 4. DEPLOY via SSH
console.log('\n--- 4. Deploying to Droplet ---');
const conn = new Client();
conn.on('ready', () => {
  console.log('SSH ready. Uploading zip...');
  conn.sftp((err, sftp) => {
    if (err) throw err;
    const remotePath = '/srv/users/serverpilot/apps/zetroyale/repo/public_v2.tar.gz';
    sftp.fastPut('public_v2.tar.gz', remotePath, (err) => {
      if (err) throw err;
      
      console.log('Upload complete. Also updating server.js and stops...');
      const remoteServerJs = '/srv/users/serverpilot/apps/zetroyale/repo/server.js';
      const remoteStops = '/srv/users/serverpilot/apps/zetroyale/repo/zagreb_stops.json';
      sftp.fastPut('server.js', remoteServerJs, (err) => {
          if (err) throw err;
          sftp.fastPut('zagreb_stops.json', remoteStops, (err) => {
              if (err) console.warn('Warning: zagreb_stops.json upload failed', err);
              
              console.log('Extracting and restarting...');
              const BASH_SCRIPT = `
set -e
cd /srv/users/serverpilot/apps/zetroyale/repo
rm -rf public_v2
mkdir public_v2
tar -xzf public_v2.tar.gz -C public_v2
chown -R serverpilot:serverpilot public_v2
rm public_v2.tar.gz
PORT=3000 NODE_TLS_REJECT_UNAUTHORIZED=0 pm2 restart zetroyale
echo "DEPLOYMENT COMPLETE -> v${newVersion}"
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
    });
  });
}).on('error', (err) => console.error(err)).connect({
  host: '46.101.220.44',
  port: 22,
  username: 'root',
  password: 'Novcanik1!'
});
