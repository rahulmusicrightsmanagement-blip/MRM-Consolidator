#!/usr/bin/env bash
# Start the MRM-Consolidator app: builds the React frontend and serves everything from Django.
set -e
cd "$(dirname "$0")"
[ -f .env ] || { echo 'Missing .env – copy .env.example to .env and set MRM_DATABASE_URL (Neon).'; exit 1; }
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r backend/requirements.txt; }
(cd frontend && { [ -d node_modules ] || npm install; } && npm run build)
cd backend
../.venv/bin/python manage.py migrate -v 0
# First run: asks for the super admin's password (later runs skip this).
../.venv/bin/python manage.py superadmin
# Uploads that did not reach Google Drive last time (if Drive is set up).
../.venv/bin/python manage.py drive_setup --sync || echo "Google Drive sync failed – it is retried on the next start."
echo "MRM-Consolidator running at http://127.0.0.1:8010"
exec ../.venv/bin/python manage.py runserver 127.0.0.1:8010
