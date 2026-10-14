# MRM-Consolidator

Catalogue reconciliation app: Django API (`backend/`) + React/Vite (`frontend/`).

## Run on your own computer (development)

```
./start.sh            # → http://127.0.0.1:8010
```

The first start asks for the super admin's password.

## Database

All data lives in Neon Postgres (Singapore). Put the connection string in `.env` as `MRM_DATABASE_URL`
(see `.env.example`); the app does not start without it. Uploaded spreadsheets stay on disk in `backend/media/`.
Tests create a temporary `test_neondb` database on the same Neon project and remove it afterwards.

## Uploaded spreadsheets in Google Drive

Without setup, uploads are kept in `backend/media/`. Once connected, every upload is saved to a
"MRM-Consolidator uploads" folder in your Google Drive and `backend/media/` is only a cache, so a server whose
disk is wiped loses nothing (files are downloaded again when needed).

One-time setup (on your own computer, it opens a browser):

1. https://console.cloud.google.com → create a project (e.g. "MRM-Consolidator").
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform): app name "MRM-Consolidator", user type
   **External**, your email as support and developer contact. Under **Data access** add the scope
   `.../auth/drive.file`. Then under **Audience** click **Publish app** ("In production") – in "Testing" mode
   Google expires the sign-in after 7 days. No Google review is needed for this scope.
4. **Credentials → Create credentials → OAuth client ID** → type **Desktop app** → download the JSON, save it
   as `client_secret.json` in the project folder (it is git-ignored).
5. Run:
   ```
   cd backend && ../.venv/bin/python manage.py drive_setup ../client_secret.json
   ```
   Sign in with the Google account whose Drive should hold the files, allow access. The command creates the
   folder, writes four `MRM_GDRIVE_*` lines into `.env` and tests the connection.
6. Restart the app (`./start.sh`, or `docker compose up -d --build`). On a server, copy the four
   `MRM_GDRIVE_*` lines into its `.env`.

- Test the connection any time: `manage.py drive_setup --check`
- Uploads go to Drive in the background (the app does not wait for Google). Anything that did not arrive –
  app stopped, Drive down – is uploaded automatically the next time the app starts, or now with
  `manage.py drive_setup --sync`.
- The app only sees files it created itself (Google's `drive.file` permission), not the rest of your Drive.

## Sign-in and users

Everyone must sign in. The super admin (`rahuljadhav0417@gmail.com`, change with `MRM_SUPER_ADMIN_EMAIL`)
is the only person who can add, disable, reset or remove users – from the avatar menu → **Users**.
Other users can change their own password from the same menu.

- Forgotten super admin password: `cd backend && ../.venv/bin/python manage.py superadmin --reset`
  (Docker: `docker compose exec mrm python manage.py superadmin --reset`)

## Run with Docker (production)

```
cp .env.example .env          # set MRM_SUPER_ADMIN_PASSWORD for the first start; edit hostnames / port
docker compose up -d --build  # → http://localhost:8010
```

- The database is Neon (`MRM_DATABASE_URL` in `.env`); uploaded spreadsheets are in `backend/media/`,
  mounted into the container, so rebuilding or restarting it does not lose anything.
- Update to new code: `git pull && docker compose up -d --build`
- Logs: `docker compose logs -f`  ·  Stop: `docker compose down`
- Backup: the database is backed up by Neon (restore points in the Neon console); copy
  `backend/media/` for the uploaded spreadsheets.

On a server with a domain, set `MRM_ALLOWED_HOSTS` and `MRM_CSRF_TRUSTED_ORIGINS` in `.env`,
put a reverse proxy with HTTPS (Caddy, nginx, Traefik) in front of port 8010, and set `MRM_HTTPS=1`.
