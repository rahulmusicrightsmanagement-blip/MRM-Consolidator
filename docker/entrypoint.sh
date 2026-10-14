#!/bin/sh
# Prepare the data volume, then start the server.
set -e
mkdir -p "$MRM_DATA_DIR/media"

# No secret key given? Create one once and keep it in the data volume so logins survive restarts.
if [ -z "$MRM_SECRET_KEY" ]; then
  key_file="$MRM_DATA_DIR/.secret_key"
  [ -s "$key_file" ] || python -c "import secrets; print(secrets.token_urlsafe(50))" > "$key_file"
  MRM_SECRET_KEY="$(cat "$key_file")"
  export MRM_SECRET_KEY
fi

python manage.py migrate --noinput -v 0
# Creates the super admin from MRM_SUPER_ADMIN_PASSWORD the first time (no-op afterwards).
python manage.py superadmin --no-input
# Uploads that did not reach Google Drive last time (if Drive is set up); never blocks the start.
python manage.py drive_setup --sync || echo "Google Drive sync failed – it is retried on the next start."
exec "$@"
