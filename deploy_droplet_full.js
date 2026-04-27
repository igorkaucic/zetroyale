const { Client } = require('ssh2');

const BASH_SCRIPT = `
set -e
echo "1. Checking Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
    apt-get install -y nodejs
fi

echo "2. Installing PM2..."
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
fi

echo "3. Creating directories..."
mkdir -p /srv/users/serverpilot/apps/zetroyale
chown -R serverpilot:serverpilot /srv/users/serverpilot/apps/zetroyale
mkdir -p /srv/users/serverpilot/log/zetroyale
chown -R serverpilot:serverpilot /srv/users/serverpilot/log/zetroyale
cd /srv/users/serverpilot/apps/zetroyale

echo "4. Cloning repository..."
sudo -u serverpilot bash -c '
    if [ ! -d "/srv/users/serverpilot/apps/zetroyale/repo" ]; then
        git clone https://github.com/igorkaucic/zetroyale.git /srv/users/serverpilot/apps/zetroyale/repo
    else
        cd /srv/users/serverpilot/apps/zetroyale/repo
        git pull
    fi
'

echo "5. Installing dependencies..."
cd /srv/users/serverpilot/apps/zetroyale/repo
npm install --legacy-peer-deps

echo "6. Starting PM2 process..."
PORT=3000 pm2 start server.js --name "zetroyale" || pm2 restart "zetroyale"
pm2 save

echo "Fixing permissions..."
chown -R serverpilot:serverpilot /srv/users/serverpilot/apps/zetroyale

echo "7. Configuring Nginx for ServerPilot..."
cat << 'EOF' > /etc/nginx-sp/vhosts.d/zetroyale.conf
server {
    listen       80;
    listen       [::]:80;
    server_name  zetroyale.site www.zetroyale.site;
    
    access_log  /srv/users/serverpilot/log/zetroyale/nginx.access.log;
    error_log  /srv/users/serverpilot/log/zetroyale/nginx.error.log;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

echo "8. Reloading Nginx..."
systemctl reload nginx-sp || service nginx-sp reload

echo "ALL DONE!"
`;

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH connection established. Running deployment script...');
  conn.exec(BASH_SCRIPT, (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Deployment script finished with exit code', code);
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
