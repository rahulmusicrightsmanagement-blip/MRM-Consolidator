"""The Remark dropdown's list – Settings – one for every user and client.

GET    /api/remarks/        every remark, the removed ones too
POST   /api/remarks/        {name, help?} added
PATCH  /api/remarks/<id>/   {name?, help?, active?, move? (-1 | 1)} edited, put back, moved up or down
DELETE /api/remarks/<id>/   removed from the dropdown (songs that have it keep it)
"""
import json

from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_http_methods

from .engine.normalize import clean_text
from .models import Remark


def _json(r):
    return {"id": r.id, "name": r.name, "help": r.help, "active": r.active, "by": r.updated_by, "at": r.updated_at.isoformat()}


def _list():
    return JsonResponse({"remarks": [_json(r) for r in Remark.objects.all()]})


def _who(request):
    return (request.user.first_name or request.user.email or "")[:254]


def _problem(name, but=None):
    if not name:
        return "Type the remark"
    if len(name) > 120:
        return "A remark can have 120 characters at most"
    if Remark.objects.filter(name__iexact=name, active=True).exclude(pk=but).exists():
        return f"“{name}” is in the list already"
    return ""


def _body(request):
    try:
        data = json.loads(request.body or b"{}")
    except ValueError:
        data = {}
    return data if isinstance(data, dict) else {}


@require_http_methods(["GET", "POST"])
def remarks(request):
    if request.method == "POST":
        data = _body(request)
        name = clean_text(data.get("name"))
        if error := _problem(name):
            return JsonResponse({"error": error}, status=400)
        last = Remark.objects.order_by("-position").values_list("position", flat=True).first() or 0
        Remark.objects.create(name=name, help=clean_text(data.get("help"))[:400], position=last + 1, updated_by=_who(request))
    return _list()


@require_http_methods(["PATCH", "DELETE"])
def remark(request, remark_id):
    r = get_object_or_404(Remark, pk=remark_id)
    if request.method == "DELETE":
        r.active = False
        r.updated_by = _who(request)
        r.save()
        return _list()
    data = _body(request)
    if data.get("move") in (-1, 1):
        with transaction.atomic():
            rows = list(Remark.objects.filter(active=True))
            at = next((i for i, x in enumerate(rows) if x.id == r.id), None)
            to = None if at is None else at + data["move"]
            if to is not None and 0 <= to < len(rows):
                rows[at], rows[to] = rows[to], rows[at]
                for i, x in enumerate(rows, start=1):
                    x.position = i
                Remark.objects.bulk_update(rows, ["position"])
        return _list()
    name = clean_text(data["name"]) if "name" in data else r.name
    active = bool(data.get("active", r.active))
    if (name != r.name or (active and not r.active)) and (error := _problem(name, r.id)):
        return JsonResponse({"error": error}, status=400)
    r.name, r.active, r.updated_by = name, active, _who(request)
    if "help" in data:
        r.help = clean_text(data.get("help"))[:400]
    r.save()
    return _list()


def offered():
    """The dropdown's choices."""
    return [{"id": r.id, "name": r.name, "help": r.help} for r in Remark.objects.filter(active=True)]


def of(decisions):
    """The songs' remarks under their names as they are now: {recording (its ISRC, else "#<sheet row>"): {"id", "name"}}."""
    set_ = {k[7:]: (d.get("data") or {}) for k, d in decisions.items() if k.startswith("remark:") and d.get("choice") == "set"}
    if not set_:
        return {}
    names = dict(Remark.objects.values_list("id", "name"))
    out = {}
    for k, v in set_.items():
        rid = v.get("remark") if isinstance(v.get("remark"), int) else None
        name = names.get(rid) or str(v.get("value") or "")
        if name:
            out[k] = {"id": rid, "name": name}
    return out
