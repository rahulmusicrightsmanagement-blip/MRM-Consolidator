"""Muso vs LNV's answers written (clean_decisions), each change kept so that it can be undone song by song – the Undo
section – and the songs the reviewer types ("Add a song").

GET  /api/clients/<id>/changes/                 every change, newest first
POST /api/clients/<id>/changes/ {undo: [ids]}   undone – with the later changes on the same decisions
                                {redo: id}      an undone change made again
GET  /api/clients/<id>/songs/                   the form: the fields of the client's own LNV
POST /api/clients/<id>/songs/   {key?, data, log}  a song typed (or an earlier one corrected)
"""
import uuid
from collections import OrderedDict

from django.core.cache import cache
from django.db import transaction
from django.db.models import Count, Max
from django.utils import timezone

from .models import CleanChange, CleanDecision, NameAlias

LIMIT = 1500


def _state(choice, data):
    return {"choice": choice, "data": data or {}}


def current(client, keys, global_prefixes):
    """{decision key: {"choice", "data"}} as saved now, for these keys (the global ones – names – too)."""
    keys = list(keys)
    names = [k for k in keys if k.startswith(global_prefixes)]
    mine = [k for k in keys if not k.startswith(global_prefixes)]
    out = {}
    if mine:
        out.update({d.key: _state(d.choice, d.data) for d in client.clean_decisions.filter(key__in=mine)})
    if names:
        out.update({a.key: _state(a.choice, a.data) for a in NameAlias.objects.filter(key__in=names)})
    return out


def write(client, target, email, global_prefixes):
    """Decisions saved as given: {key: {"choice", "data"} | None (cleared)}."""
    now = timezone.now()
    names = {k: v for k, v in target.items() if k.startswith(global_prefixes)}
    mine = {k: v for k, v in target.items() if k not in names}
    gone = [k for k, v in names.items() if v is None]
    if gone:
        NameAlias.objects.filter(key__in=gone).delete()
    put = {k: v for k, v in names.items() if v is not None}
    if put:
        known = {a.key: a for a in NameAlias.objects.filter(key__in=list(put))}
        fresh, kept = [], []
        for k, v in put.items():
            a = known.get(k) or NameAlias(key=k)
            a.choice, a.data, a.decided_by, a.updated_at = v["choice"], v["data"], email, now
            (kept if a.pk else fresh).append(a)
        NameAlias.objects.bulk_create(fresh)
        NameAlias.objects.bulk_update(kept, ["choice", "data", "decided_by", "updated_at"])
    gone = [k for k, v in mine.items() if v is None]
    if gone:
        client.clean_decisions.filter(key__in=gone).delete()
    put = {k: v for k, v in mine.items() if v is not None}
    if put:
        known = {d.key: d for d in client.clean_decisions.filter(key__in=list(put))}
        fresh, kept = [], []
        for k, v in put.items():
            d = known.get(k)
            if d is None:
                fresh.append(CleanDecision(client=client, key=k, choice=v["choice"], data=v["data"], updated_at=now))
            else:
                d.choice, d.data, d.updated_at = v["choice"], v["data"], now
                kept.append(d)
        CleanDecision.objects.bulk_create(fresh)
        CleanDecision.objects.bulk_update(kept, ["choice", "data", "updated_at"])


def _songs(raw):
    out = []
    for s in raw if isinstance(raw, list) else []:
        if isinstance(s, dict) and s.get("key") and not any(x["key"] == str(s["key"])[:200] for x in out):
            out.append({"key": str(s["key"])[:200], "title": str(s.get("title") or "")[:200]})
    return out[:6]


def save(client, items, user, by, global_prefixes):
    """items: {key: (choice | None, data, log)} – written, and the ones that really changed kept as changes: one per
    log.group (a song's answer, one value, one title …), with the lines the screen gave them."""
    with transaction.atomic():
        before = current(client, items, global_prefixes)
        target = {k: None if c is None else _state(c, data) for k, (c, data, _) in items.items()}
        diff = {k: v for k, v in target.items() if before.get(k) != v}
        if not diff:
            return 0
        write(client, diff, getattr(user, "email", ""), global_prefixes)
        groups = OrderedDict()
        for k, v in diff.items():
            log = items[k][2] if isinstance(items[k][2], dict) else {}
            g = groups.setdefault(str(log.get("group") or k)[:300], {"songs": [], "lines": [], "minor": [], "items": []})
            g["songs"] = _songs(g["songs"] + (log.get("songs") if isinstance(log.get("songs"), list) else []))
            text = str(log.get("text") or k)[:300]
            lines = g["minor"] if log.get("minor") else g["lines"]
            if text not in lines:
                lines.append(text)
            g["items"].append({"key": k, "before": before.get(k), "after": v})
        CleanChange.objects.bulk_create([
            CleanChange(client=client, songs=g["songs"], lines=(g["lines"] or g["minor"])[:12], keys=[i["key"] for i in g["items"]],
                        items=g["items"], by=by) for g in groups.values()])
        return len(diff)


def close(client):
    """A new LNV or Muso export: the earlier changes name rows of the old one, so they can no longer be undone."""
    client.clean_changes.filter(closed=False).update(closed=True)


def _with(rows):
    """{change id: ids of the later changes that go with it when it is undone} – they touch the same decisions."""
    live = sorted((r for r in rows if not r["undone_at"] and not r["closed"]), key=lambda r: r["id"])
    by_key = {}
    for r in live:
        for k in r["keys"]:
            by_key.setdefault(k, []).append(r["id"])
    keys_of = {r["id"]: r["keys"] for r in live}

    def closure(start):
        seen, queue = {start}, [start]
        while queue:
            i = queue.pop()
            for k in keys_of[i]:
                for j in by_key[k]:
                    if j > i and j not in seen:
                        seen.add(j)
                        queue.append(j)
        return sorted(seen - {start})
    return {r["id"]: closure(r["id"]) for r in live}


def listing(client):
    rows = list(client.clean_changes.order_by("-id").values("id", "songs", "lines", "keys", "by", "at", "undone_at", "undone_by", "closed")[:LIMIT])
    later = _with(rows)
    return [{"id": r["id"], "songs": r["songs"], "lines": r["lines"], "by": r["by"], "at": r["at"].isoformat(), "closed": r["closed"],
             "undone_at": r["undone_at"].isoformat() if r["undone_at"] else None, "undone_by": r["undone_by"],
             "with": later.get(r["id"], [])} for r in rows]


# the songs "Last updated" goes through, and how many it names
TRACKED, NAMED = 5000, 10


def updates(client):
    """Last updated: the songs changed last, newest first ("last": their names, when, by whom, what), and when each song
    was last changed ("songs": {song key: ISO time}). A change undone counts as one too. Kept until the next change."""
    mark = client.clean_changes.aggregate(n=Count("id"), last=Max("id"), undone=Max("undone_at"))
    if not mark["n"]:
        return {"last": [], "songs": {}}
    key = f"updates-{client.id}-{mark['n']}-{mark['last']}-{mark['undone'].timestamp() if mark['undone'] else 0}"
    out = cache.get(key)
    if out is None:
        seen = {}
        for songs, at, by, undone_at, undone_by, pk in client.clean_changes.order_by("-id").values_list(
                "songs", "at", "by", "undone_at", "undone_by", "id")[:TRACKED]:
            when, who, undone = (undone_at, undone_by, True) if undone_at else (at, by, False)
            for s in songs:
                if s.get("key") and s["key"] != "other" and (s["key"] not in seen or when > seen[s["key"]]["when"]):
                    seen[s["key"]] = {"key": s["key"], "title": s.get("title") or "", "when": when, "by": who, "undone": undone, "id": pk}
        newest = sorted(seen.values(), key=lambda x: x["when"], reverse=True)
        lines = dict(client.clean_changes.filter(id__in=[x["id"] for x in newest[:NAMED]]).values_list("id", "lines"))
        out = {"last": [{"key": x["key"], "title": x["title"], "at": x["when"].isoformat(), "by": x["by"],
                         "what": ("Undone: " if x["undone"] else "") + str((lines.get(x["id"]) or [""])[0])} for x in newest[:NAMED]],
               "songs": {x["key"]: x["when"].isoformat() for x in newest}}
        cache.set(key, out, 24 * 60 * 60)
    return out


def last_songs(client_ids):
    """Each client's song changed last, for the client list: {client id: {"title", "at", "by"}} – one query."""
    rows = CleanChange.objects.filter(client_id__in=client_ids).order_by("client_id", "-id").distinct("client_id").values("client_id", "songs", "at", "by")
    return {r["client_id"]: {"title": str(((r["songs"] or [{}])[0] or {}).get("title") or ""), "at": r["at"].isoformat(), "by": r["by"]} for r in rows}


class Conflict(Exception):
    pass


def undo(client, ids, user, by, global_prefixes):
    with transaction.atomic():
        rows = list(client.clean_changes.select_for_update().filter(closed=False, undone_at__isnull=True).order_by("id"))
        later = _with([{"id": r.id, "keys": r.keys, "undone_at": None, "closed": False} for r in rows])
        want = {i for i in ids if i in later}
        if not want:
            raise Conflict("This change was undone already, or the LNV or Muso sheet was replaced since.")
        for i in list(want):
            want.update(later[i])
        chosen = [r for r in rows if r.id in want]
        now = current(client, {k for r in chosen for k in r.keys}, global_prefixes)
        target, seen = {}, set()
        for r in reversed(chosen):   # the newest first: each decision must still be as it left it
            for i in r.items:
                if i["key"] not in seen:
                    seen.add(i["key"])
                    if now.get(i["key"]) != i["after"]:
                        raise Conflict(f"“{(r.lines or ['This change'])[0]}” was changed again somewhere else, so it cannot be undone.")
                target[i["key"]] = i["before"]
        write(client, target, getattr(user, "email", ""), global_prefixes)
        CleanChange.objects.filter(id__in=want).update(undone_at=timezone.now(), undone_by=by)
    return sorted(want)


def redo(client, change_id, user, by, global_prefixes):
    with transaction.atomic():
        r = client.clean_changes.select_for_update().filter(id=change_id, closed=False, undone_at__isnull=False).first()
        if not r:
            raise Conflict("This change cannot be made again.")
        now = current(client, r.keys, global_prefixes)
        if any(now.get(i["key"]) != i["before"] for i in r.items):
            raise Conflict("The song was changed since, so this cannot be made again by itself.")
        write(client, {i["key"]: i["after"] for i in r.items}, getattr(user, "email", ""), global_prefixes)
        # it is the latest change on these decisions again: kept as a fresh one, so that undoing follows the order
        CleanChange.objects.create(client=client, songs=r.songs, lines=r.lines, keys=r.keys, items=r.items, by=by)
        r.delete()


def new_key():
    return f"song:{uuid.uuid4().hex[:16]}"
