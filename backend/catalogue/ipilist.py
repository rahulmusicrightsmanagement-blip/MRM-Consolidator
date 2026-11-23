"""The IPI / CAE List screen's API, and the list ready for lookups (engine/ipi.py) everywhere names are compared.

GET    /api/ipi/?q=&show=all|new|updated|removed&page=  the list's summary, its uploads and one page of members
POST   /api/ipi/  (file, replace?)                       a member list uploaded: new names added, changed ones updated;
                                                         replace=1 also removes the names the file does not have
DELETE /api/ipi/                                         the list cleared (admins)
"""
import re
import tempfile
import threading
from pathlib import Path

from django.core.cache import cache
from django.db import transaction
from django.db.models import Count, Q
from django.http import JsonResponse
from django.views.decorators.gzip import gzip_page
from django.views.decorators.http import require_http_methods

from .accounts import is_admin
from .engine import ipi
from .engine.normalize import norm_ipi
from .models import IpiName, IpiUpload

FIELDS = ("member", "member_name", "name", "type", "ipi", "role", "internal_no", "sr")
PAGE = 50
_lock = threading.Lock()
_index = {"version": None, "index": ipi.EMPTY}


def version():
    """The list's version: its newest upload (0 – no list yet)."""
    return IpiUpload.objects.order_by("-id").values_list("id", flat=True).first() or 0


def index():
    """The IPI / CAE list ready for lookups – kept in memory (and in the cache for the other workers) until the list
    changes. ipi.EMPTY when there is no list."""
    v = version()
    if _index["version"] == v:
        return _index["index"]
    with _lock:
        if _index["version"] != v:
            if not v:
                built = ipi.EMPTY
            else:
                key = f"ipi-entries-{v}"
                entries = cache.get(key)
                if entries is None:
                    entries = list(IpiName.objects.values(*FIELDS))
                    cache.set(key, entries, 30 * 24 * 60 * 60)
                built = ipi.Index(entries, v)
            _index.update(version=v, index=built)
    return _index["index"]


def _who(request):
    user = getattr(request, "user", None)
    return ((user.first_name or user.email) if user and user.is_authenticated else "")[:254]


def _upload_json(u):
    return {"id": u.id, "name": u.original_name, "kind": u.kind, "stats": u.stats, "by": u.uploaded_by, "at": u.uploaded_at.isoformat()}


def _summary():
    latest = IpiUpload.objects.order_by("-id").first()
    by_type = dict(IpiName.objects.values_list("type").annotate(n=Count("id")).values_list("type", "n"))
    return {
        "version": latest.id if latest else 0,
        "names": sum(by_type.values()), "members": IpiName.objects.values("member").distinct().count(),
        "types": by_type, "latest": _upload_json(latest) if latest else None,
        "uploads": [_upload_json(u) for u in IpiUpload.objects.order_by("-id")[:12]],
    }


def _members(request, latest):
    """One page of members – each with every name the list holds for them – that match the search and the filter."""
    q, show = (request.GET.get("q") or "").strip(), request.GET.get("show") or "all"
    try:
        page = max(1, int(request.GET.get("page") or 1))
    except ValueError:
        page = 1
    rows = IpiName.objects.all()
    if q:
        digits = re.sub(r"\D", "", q)
        cond = Q(name__icontains=q) | Q(member_name__icontains=q) | Q(member__icontains=q)
        if len(digits) >= 4:
            cond |= Q(ipi__contains=digits) | Q(internal_no=digits)
        words = [w for w in re.split(r"[\s,]+", q) if w]
        if len(words) > 1:   # 'sharma mithun' finds 'MITHUN NARESH,SHARMA'
            both = Q()
            for w in words:
                both &= Q(name__icontains=w)
            cond |= both
        rows = rows.filter(cond)
    if show == "new" and latest:
        rows = rows.filter(added_in_id=latest)
    elif show == "updated" and latest:
        rows = rows.filter(changed_in_id=latest).exclude(added_in_id=latest)
    members = rows.values("member", "member_name").distinct().order_by("member_name", "member")
    total = members.count()
    picked = list(members[(page - 1) * PAGE: page * PAGE])
    names = {}
    for n in IpiName.objects.filter(member__in=[m["member"] for m in picked]).order_by("type", "name"):
        names.setdefault(n.member, []).append({"name": n.name, "type": n.type, "ipi": n.ipi, "role": n.role,
                                               "internal_no": n.internal_no, "new": n.added_in_id == latest,
                                               "updated": n.changed_in_id == latest and n.added_in_id != latest})
    out = []
    for m in picked:
        ns = sorted(names.get(m["member"], []), key=lambda x: (x["type"] != "PA", ipi.NAME_TYPES.index(x["type"]) if x["type"] in ipi.NAME_TYPES else 99, x["name"]))
        pa = next((x for x in ns if x["type"] == "PA"), ns[0] if ns else {})
        out.append({"member": m["member"], "name": m["member_name"], "ipi": pa.get("ipi", ""), "role": pa.get("role", ""),
                    "names": ns, "new": bool(ns) and all(x["new"] for x in ns), "updated": any(x["updated"] or (x["new"] and not pa.get("new")) for x in ns)})
    return {"members": out, "total": total, "page": page, "pages": max(1, -(-total // PAGE)), "q": q, "show": show}


def save(entries, name, by, replace=False):
    """The list from a file: new names added, names whose details changed updated, the others left as they are.
    replace: names the file does not have are removed. Returns the upload (its stats say what changed)."""
    existing = {k: v for k, *v in IpiName.objects.values_list("key", *FIELDS)}
    keys = {e["key"] for e in entries}
    with transaction.atomic():
        up = IpiUpload.objects.create(original_name=name[:255], kind="replace" if replace else "upload", uploaded_by=by)
        fresh, changed = [], []
        for e in entries:
            old = existing.get(e["key"])
            values = [e[f] for f in FIELDS]
            if old is None:
                fresh.append(IpiName(key=e["key"], added_in=up, changed_in=up, **{f: e[f] for f in FIELDS}))
            elif list(old) != values:
                changed.append((e["key"], e))
        IpiName.objects.bulk_create(fresh, batch_size=2000)
        if changed:
            by_key = {n.key: n for n in IpiName.objects.filter(key__in=[k for k, _ in changed])}
            rows = []
            for k, e in changed:
                n = by_key[k]
                for f in FIELDS:
                    setattr(n, f, e[f])
                n.changed_in = up
                rows.append(n)
            IpiName.objects.bulk_update(rows, list(FIELDS) + ["changed_in"], batch_size=500)
        gone = [k for k in existing if k not in keys]
        removed = 0
        if replace and gone:
            for i in range(0, len(gone), 5000):
                removed += IpiName.objects.filter(key__in=gone[i:i + 5000]).delete()[0]
        up.stats = {"names": len(entries), "members": len({e["member"] for e in entries}), "added": len(fresh),
                    "updated": len(changed), "unchanged": len(entries) - len(fresh) - len(changed),
                    "removed": removed, "kept": 0 if replace else len(gone), "total": len(existing) + len(fresh) - removed}
        up.save(update_fields=["stats"])
    return up


@gzip_page
@require_http_methods(["GET", "POST", "DELETE"])
def ipi_list(request):
    if request.method == "DELETE":
        if not is_admin(request.user):
            return JsonResponse({"error": "Only an admin can clear the IPI / CAE list"}, status=403)
        with transaction.atomic():
            n = IpiName.objects.count()
            IpiName.objects.all().delete()
            IpiUpload.objects.create(kind="clear", uploaded_by=_who(request), stats={"removed": n, "total": 0})
    elif request.method == "POST":
        uploaded = request.FILES.get("file")
        if not uploaded:
            return JsonResponse({"error": "No file was sent"}, status=400)
        suffix = Path(uploaded.name).suffix.lower()
        if suffix not in (".xlsx", ".xlsm", ".csv"):
            return JsonResponse({"error": "The IPI / CAE list must be an Excel (.xlsx) or CSV file"}, status=422)
        with tempfile.NamedTemporaryFile(suffix=suffix) as tmp:
            for chunk in uploaded.chunks():
                tmp.write(chunk)
            tmp.flush()
            try:
                entries = ipi.parse(tmp.name)
            except ipi.IpiFormatError as e:
                return JsonResponse({"error": str(e)}, status=422)
            except Exception as e:   # not a spreadsheet at all
                return JsonResponse({"error": f"The file could not be read as a member list: {e}"}, status=422)
        replace = str(request.POST.get("replace") or "").lower() in ("1", "true", "yes", "on")
        up = save(entries, uploaded.name, _who(request), replace)
        summary = _summary()
        return JsonResponse({"summary": summary, "upload": _upload_json(up), **_members(request, summary["version"])})
    summary = _summary()
    return JsonResponse({"summary": summary, **_members(request, summary["version"])})


def lookup(request):
    """GET /api/ipi/lookup/?name=&ipi= – how the list has one name (the review screens' "IPI List" value)."""
    r = index().resolve(request.GET.get("name") or "", norm_ipi(request.GET.get("ipi") or ""))
    return JsonResponse({"found": r})
