"""Uploaded spreadsheets kept in Google Drive.

Every file is saved to MEDIA_ROOT first (so processing can start at once) and uploaded to one Drive folder in the
background, named by its path (e.g. "runs/12/iprs/report_k3f9a2c.xlsx"). Uploads that did not finish – the app was
stopped, Drive was down – are sent by `drive_setup --sync`, which runs whenever the app starts. The processing code
reads files from disk (`.file.path`), so a file missing locally – e.g. after a redeploy wiped the disk – is
downloaded from Drive first.

Signs in as the Google account that ran `manage.py drive_setup` (scope drive.file: only files this app made).
"""
import json
import logging
import os
import secrets
import threading
import time
import uuid
from pathlib import Path

from django.conf import settings
from django.core.cache import cache
from django.core.files import File
from django.core.files.storage import Storage
from django.utils.deconstruct import deconstructible

API = "https://www.googleapis.com/drive/v3/files"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id"
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
ENV_KEYS = ("MRM_GDRIVE_CLIENT_ID", "MRM_GDRIVE_CLIENT_SECRET", "MRM_GDRIVE_REFRESH_TOKEN", "MRM_GDRIVE_FOLDER_ID")
TIMEOUT = 120

_local = threading.local()
logger = logging.getLogger(__name__)
RETRIES = 4


class DriveError(Exception):
    pass


def configured():
    return all(os.environ.get(k) for k in ENV_KEYS)


def credentials(client_id, client_secret, refresh_token):
    from google.oauth2.credentials import Credentials
    return Credentials(None, refresh_token=refresh_token, client_id=client_id, client_secret=client_secret,
                       token_uri="https://oauth2.googleapis.com/token", scopes=SCOPES)


def session(creds=None):
    """An HTTP session that adds (and refreshes) the Google access token; one per thread."""
    from google.auth.transport.requests import AuthorizedSession
    if creds is not None:
        return AuthorizedSession(creds)
    if getattr(_local, "session", None) is None:
        _local.session = AuthorizedSession(credentials(*(os.environ[k] for k in ENV_KEYS[:3])))
    return _local.session


def _check(response, what):
    if response.status_code >= 400:
        try:
            detail = response.json()["error"]["message"]
        except Exception:
            detail = response.text[:200]
        raise DriveError(f"Google Drive could not {what}: {detail} (HTTP {response.status_code})")
    return response


def _send(method, url, what, **kwargs):
    """One call to Drive with the app's sign-in. An expired sign-in or a network failure becomes a DriveError, so a
    page can skip the file instead of failing."""
    import requests
    from google.auth.exceptions import GoogleAuthError, RefreshError
    try:
        return getattr(session(), method)(url, timeout=TIMEOUT, **kwargs)
    except RefreshError as e:
        raise DriveError(f"Google Drive could not {what}: the sign-in has expired or was revoked – "
                         f"run `manage.py drive_setup` again ({e})") from e
    except (GoogleAuthError, requests.RequestException) as e:
        raise DriveError(f"Google Drive could not {what}: {e}") from e


def create_folder(http, name, parent=None):
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder", **({"parents": [parent]} if parent else {})}
    return _check(http.post(API, params={"fields": "id"}, json=meta, timeout=TIMEOUT), "create the folder").json()["id"]


def upload(http, folder_id, name, data):
    boundary = uuid.uuid4().hex
    meta = json.dumps({"name": name, "parents": [folder_id]})
    body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n"
            f"--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    r = http.post(UPLOAD, data=body, headers={"Content-Type": f"multipart/related; boundary={boundary}"}, timeout=TIMEOUT)
    return _check(r, f"save {name}").json()["id"]


def list_names(http, folder_id):
    """Names of every file in the folder (one request per 1000 files)."""
    names, token = set(), None
    while True:
        params = {"q": f"'{folder_id}' in parents and trashed = false", "fields": "nextPageToken, files(name)",
                  "pageSize": 1000, "spaces": "drive", **({"pageToken": token} if token else {})}
        data = _check(http.get(API, params=params, timeout=TIMEOUT), "list the folder").json()
        names |= {f["name"] for f in data.get("files", [])}
        token = data.get("nextPageToken")
        if not token:
            return names


@deconstructible
class DriveStorage(Storage):
    """Django storage: Google Drive is the real copy, MEDIA_ROOT a local cache."""

    def __init__(self, folder_id=None, cache_dir=None):
        self.folder_id = folder_id or os.environ.get("MRM_GDRIVE_FOLDER_ID", "")
        self.cache_dir = Path(cache_dir or settings.MEDIA_ROOT)

    # -- Drive lookups --------------------------------------------------------------------------------
    def _key(self, name):
        return f"gdrive:{self.folder_id}:{name}"

    def _find(self, name):
        """Drive file id for a stored name, or None."""
        file_id = cache.get(self._key(name))
        if file_id:
            return file_id
        escaped = name.replace("\\", "\\\\").replace("'", "\\'")
        q = f"name = '{escaped}' and '{self.folder_id}' in parents and trashed = false"
        what = f"look up {name}"
        r = _check(_send("get", API, what, params={"q": q, "fields": "files(id)", "pageSize": 1, "spaces": "drive"}), what)
        files = r.json().get("files", [])
        file_id = files[0]["id"] if files else None
        if file_id:
            cache.set(self._key(name), file_id, None)
        return file_id

    # -- Storage API ----------------------------------------------------------------------------------
    def get_available_name(self, name, max_length=None):
        """Every stored name is unique (a random tag before the extension), so no Drive lookup is needed."""
        stem, dot, ext = name.rpartition(".")
        tag = secrets.token_hex(4)
        return f"{stem}_{tag}.{ext}" if dot else f"{name}_{tag}"

    def _save(self, name, content):
        content.seek(0)
        data = content.read()
        if isinstance(data, str):
            data = data.encode()
        local = self.cache_dir / name
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(data)
        if self.background:
            threading.Thread(target=self._upload, args=(name, data), name=f"drive-upload {name}").start()
        else:
            self._upload(name, data, raise_errors=True)
        return name

    background = True

    def _upload(self, name, data, raise_errors=False):
        """Send one file to Drive, retrying a few times. In the background a failure is only logged: the local copy
        stays and `drive_setup --sync` uploads it later."""
        for attempt in range(1, RETRIES + 1):
            try:
                file_id = upload(session(), self.folder_id, name, data)
                cache.set(self._key(name), file_id, None)
                if not (self.cache_dir / name).exists():   # deleted while it was uploading
                    self.delete(name)
                return file_id
            except Exception as e:
                if attempt == RETRIES:
                    if raise_errors:
                        raise
                    logger.error("Upload of %s to Google Drive failed (%s); it will be retried when the app restarts.", name, e)
                    return None
                time.sleep(2 ** attempt)

    def path(self, name):
        """Local path of the file, downloading it from Drive if the cache does not have it."""
        local = self.cache_dir / name
        if not local.exists():
            file_id = self._find(name)
            if not file_id:
                raise FileNotFoundError(f"{name} is not in the Google Drive folder")
            what = f"download {name}"
            r = _check(_send("get", f"{API}/{file_id}", what, params={"alt": "media"}), what)
            local.parent.mkdir(parents=True, exist_ok=True)
            tmp = local.with_name(local.name + ".part")
            tmp.write_bytes(r.content)
            tmp.replace(local)
        return str(local)

    def _open(self, name, mode="rb"):
        return File(open(self.path(name), mode))

    def exists(self, name):
        return (self.cache_dir / name).exists() or self._find(name) is not None

    def delete(self, name):
        file_id = self._find(name)
        if file_id:
            r = _send("delete", f"{API}/{file_id}", f"delete {name}")
            if r.status_code != 404:
                _check(r, f"delete {name}")
        cache.delete(self._key(name))
        (self.cache_dir / name).unlink(missing_ok=True)

    def size(self, name):
        return os.path.getsize(self.path(name))

    def url(self, name):
        raise NotImplementedError("Uploaded spreadsheets are not served by URL.")
