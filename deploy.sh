#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Installing Node dependencies"
npm install

echo "==> Preparing local .env"
node scripts/setup-env.js

if [ -f "mac-controller/requirements.txt" ]; then
  echo "==> Preparing Python controller environment"
  python3 -m venv mac-controller/.venv
  mac-controller/.venv/bin/pip install -r mac-controller/requirements.txt
fi

echo "==> Running checks"
npm run check

echo "==> Starting app"
npm start
