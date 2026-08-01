#!/usr/bin/env bash
# Deploy curia to the Hetzner box. Run from any machine with ssh access.
# See docs/deploy.md.
set -euo pipefail

HOST="${CURIA_DEPLOY_HOST:-alp@coinmatica.net}"

ssh "$HOST" 'set -euo pipefail
cd ~/curia
git pull --ff-only
/usr/local/bin/npm --prefix daemon install --no-fund --no-audit
sudo /bin/cp /home/alp/curia/deploy/curia.service /etc/systemd/system/curia.service
sudo /bin/systemctl daemon-reload
sudo /bin/systemctl restart curia
sleep 3
systemctl is-active curia'

echo "deployed: $HOST"
