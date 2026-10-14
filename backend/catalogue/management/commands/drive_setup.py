"""Connect MRM-Consolidator to Google Drive (run once, on a computer with a web browser).

    python manage.py drive_setup path/to/client_secret.json     # sign in, create the folder, write .env
    python manage.py drive_setup --check                         # test the saved connection
    python manage.py drive_setup --sync                          # upload local files that are not in Drive yet

The Google sign-in opens in the browser. The keys it produces are written to the project's .env; copy the
four MRM_GDRIVE_* lines to the server's .env as well.
"""
import os
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from catalogue import drive

FOLDER_NAME = "MRM-Consolidator uploads"
ENV_FILE = Path(settings.BASE_DIR).parent / ".env"


def write_env(values, path=ENV_FILE):
    """Set KEY=value lines in .env, replacing existing ones and keeping everything else."""
    lines = path.read_text().splitlines() if path.exists() else []
    lines = [line for line in lines if line.split("=", 1)[0].strip() not in values]
    if lines and lines[-1].strip():
        lines.append("")
    lines.append("# Google Drive for uploaded spreadsheets (written by manage.py drive_setup).")
    lines += [f"{k}='{v}'" for k, v in values.items()]
    path.write_text("\n".join(lines) + "\n")
    path.chmod(0o600)


class Command(BaseCommand):
    help = "Connect the app to Google Drive for storing uploaded spreadsheets."

    def add_arguments(self, parser):
        parser.add_argument("client_secrets", nargs="?", help="OAuth client JSON downloaded from Google Cloud (Desktop app).")
        parser.add_argument("--check", action="store_true", help="Test the connection saved in .env.")
        parser.add_argument("--sync", "--upload-existing", dest="sync", action="store_true",
                            help="Upload files in the media folder that are not in Drive yet (runs at app start).")

    def handle(self, *args, client_secrets=None, check=False, sync=False, **options):
        if client_secrets:
            self._connect(client_secrets)
        if check or client_secrets:
            self._check()
        if sync:
            self._sync()
        if not (client_secrets or check or sync):
            raise CommandError("Give the client_secret.json file, or --check / --sync.")

    def _connect(self, client_secrets):
        from google_auth_oauthlib.flow import InstalledAppFlow
        if not Path(client_secrets).is_file():
            raise CommandError(f"{client_secrets} not found.")
        flow = InstalledAppFlow.from_client_secrets_file(client_secrets, scopes=drive.SCOPES)
        self.stdout.write("A browser window opens: sign in with the Google account whose Drive should hold the files.")
        creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
        if not creds.refresh_token:
            raise CommandError("Google did not return a refresh token – run the command again.")
        http = drive.session(creds)
        folder_id = drive.create_folder(http, FOLDER_NAME)
        values = {"MRM_GDRIVE_CLIENT_ID": creds.client_id, "MRM_GDRIVE_CLIENT_SECRET": creds.client_secret,
                  "MRM_GDRIVE_REFRESH_TOKEN": creds.refresh_token, "MRM_GDRIVE_FOLDER_ID": folder_id}
        write_env(values)
        os.environ.update(values)
        self.stdout.write(self.style.SUCCESS(f"Connected. Folder \"{FOLDER_NAME}\" created in your Drive; keys saved to {ENV_FILE}."))

    def _check(self):
        if not drive.configured():
            raise CommandError("Google Drive is not set up – run: python manage.py drive_setup client_secret.json")
        http = drive.session()
        folder = os.environ["MRM_GDRIVE_FOLDER_ID"]
        name = "_connection_check.txt"
        file_id = drive.upload(http, folder, name, b"MRM-Consolidator can write here.")
        data = drive._check(http.get(f"{drive.API}/{file_id}", params={"alt": "media"}, timeout=drive.TIMEOUT), "read back").content
        drive._check(http.delete(f"{drive.API}/{file_id}", timeout=drive.TIMEOUT), "delete the test file")
        if data != b"MRM-Consolidator can write here.":
            raise CommandError("Google Drive returned different content than was uploaded.")
        self.stdout.write(self.style.SUCCESS("Google Drive works: test file uploaded, read back and removed."))

    def _sync(self):
        if not drive.configured():
            self.stdout.write("Google Drive is not set up – uploads stay on this computer only.")
            return
        root = Path(settings.MEDIA_ROOT)
        files = [p for p in root.rglob("*") if p.is_file() and not p.name.endswith(".part")]
        if not files:
            self.stdout.write("Google Drive: nothing to upload.")
            return
        in_drive = drive.list_names(drive.session(), os.environ["MRM_GDRIVE_FOLDER_ID"])
        missing = [p for p in files if p.relative_to(root).as_posix() not in in_drive]
        for p in missing:
            drive.upload(drive.session(), os.environ["MRM_GDRIVE_FOLDER_ID"], p.relative_to(root).as_posix(), p.read_bytes())
        self.stdout.write(self.style.SUCCESS(f"Google Drive: uploaded {len(missing)} file(s); {len(files) - len(missing)} already there."))
