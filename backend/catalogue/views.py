import hashlib
import json
import logging
import tempfile
import threading
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

from django.conf import settings
from django.core.cache import cache
from django.db import connection, transaction
from django.db.models import Count, Prefetch, Q
from django.http import FileResponse, Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.views.decorators.http import require_http_methods

from .drive import DriveError
from .engine import export
from .engine.fill import fill_iprs_columns
from .engine.verify import verify as verify_run
from .engine.iprs import IPRSFormatError, parse_iprs
from .engine.normalize import norm_ipi
from .engine.pair import build_pair
from .engine.master import MasterFormatError, parse_master
from .engine.pipeline import run_pipeline
from .engine.prs import SocietyFormatError, parse_prs
from .models import NEWEST_FIRST, OLDEST_FIRST, SOCIETIES, SOCIETY_CODES, Client, ClientSociety, LinkDecision, MasterEdit, MasterFile, Registration, Run, SongFlag, SourceFile, Task, TaskEvent, Work
from .sync import TASK_LABEL, is_latest, sync_run
from .timing import measure

logger = logging.getLogger(__name__)

PARSERS = {
    SourceFile.IPRS: (parse_iprs, IPRSFormatError),
    SourceFile.MASTER: (parse_master, MasterFormatError),
    SourceFile.PRS: (parse_prs, SocietyFormatError),
}
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
TASK_STATES = dict(Task.STATES)
# Large JSON columns of a work, left out of queries that do not show them (the database may be far away).
HEAVY = ("sources", "credits")
# What a work's row in a list shows of its registrations and tasks (not their issue / detail JSON).
ROW_REGS = Prefetch("registrations", Registration.objects.only("id", "work_id", "society", "status", "codes"))
ROW_TASKS = Prefetch("tasks", Task.objects.only("id", "work_id", "type", "state"))
TASK_WORK_HEAVY = ("work__sources", "work__credits")
# A task only shows its reports' dates; their summaries would be sent again with every task row.
TASK_RUN_HEAVY = ("opened_run__summary", "closed_run__summary")
# A processed report is keyed by its files, decisions, client and app version, so it stays valid until one of those
# changes; a short expiry only made a page load after an idle hour re-process (and re-save) every client's reports.
VERSION_FILE = settings.BASE_DIR.parent / "VERSION"
APP_VERSION = VERSION_FILE.read_text().strip() if VERSION_FILE.exists() else ""
RESULT_TTL = 30 * 24 * 60 * 60
STAGES = ["Needs master", "Master loaded", "Societies in progress", "All societies complete"]
# What the user sees: three steps per society. One-line conversion, gap filling, tune-code checks and
# task creation run behind them as part of the process.
STEPS = {"IPRS": ["Upload file & check headers", "Map with master", "Fill IPRS columns", "Reports"],
         "PRS": ["Upload file & check headers", "Map with master", "Reports"]}
SOCIETY_META = {s["code"]: s for s in SOCIETIES}


def _body(request):
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return {}


def _iso(d):
    return d.isoformat() if d else None


# ---------------------------------------------------------------- serialisers

def _client_json(client):
    if not client:
        return None
    return {"id": client.id, "name": client.name, "ipi": client.ipi, "owner": client.owner, "due_date": _iso(client.due_date),
            "home_society": client.home_society}


def _run_json(run):
    files = {kind: {"name": f.original_name, "uploaded_at": f.uploaded_at.isoformat()} if f else None
             for kind, f in run.active_files().items()}
    return {"id": run.id, "name": run.name, "client": _client_json(run.client), "client_name": run.client_name,
            "client_ipi": run.client_ipi, "summary": run.summary, "report_date": _iso(run.report_date),
            "society": run.society, "confirmed_step": run.confirmed_step, "completed_at": _iso(run.completed_at),
            "steps": STEPS.get(run.society, []),
            "created_at": run.created_at.isoformat(), "updated_at": run.updated_at.isoformat(), "files": files}


def _task_json(task, events=False):
    out = {"id": task.id, "work": {"id": task.work_id, "mrm_id": task.work.mrm_id, "title": task.work.title},
           "society": task.society, "type": task.type, "type_label": TASK_LABEL[task.type], "state": task.state,
           "state_label": TASK_STATES[task.state], "detail": task.detail, "owner": task.owner, "due_date": _iso(task.due_date),
           "note": task.note, "created_at": task.created_at.isoformat(), "updated_at": task.updated_at.isoformat(),
           "opened_report": _iso(task.opened_run.report_date) if task.opened_run else None,
           "closed_report": _iso(task.closed_run.report_date) if task.closed_run else None,
           "codes": next((r.codes for r in task.work.registrations.all() if r.society == task.society), [])}
    if events:
        out["events"] = [{"kind": e.kind, "text": e.text, "at": e.at.isoformat()} for e in task.events.all()]
    return out


def _work_row(work):
    regs = {r.society: {"status": r.status, "label": r.get_status_label(), "codes": r.codes} for r in work.registrations.all()}
    open_tasks = [t for t in work.tasks.all() if t.state not in Task.CLOSED]
    return {"id": work.id, "mrm_id": work.mrm_id, "title": work.title, "origin": work.origin, "identifiers": work.identifiers,
            "registrations": regs, "open_tasks": len(open_tasks), "task_types": sorted({t.type for t in open_tasks}),
            "credited": not any(t.type == Task.ADD_CREDIT for t in open_tasks), "in_latest": work.last_run_id is not None,
            "writers": [c["name"] for c in work.credits if c["role"] not in ("E", "SE", "AM", "PA")][:4]}


# ---------------------------------------------------------------- processing

def _decisions(run):
    """Decisions for this report, inheriting the client's earlier decisions (newest wins)."""
    out = {}
    runs = list(Run.objects.filter(client=run.client).order_by(*OLDEST_FIRST)) if run.client else []
    if run not in runs:
        runs.append(run)
    for r in runs:
        if r.id != run.id and (r.report_date, r.created_at) > (run.report_date, run.created_at):
            continue
        for d in r.decisions.all():
            out[d.internal_no] = {"master_row": d.master_row, "master_title": d.master_title, "rejected_rows": d.rejected_rows}
    return out


def snapshot(result):
    """Headline numbers of one report's processing."""
    s = {"stage": 0}
    if result.get("iprs"):
        iprs = result["iprs"]
        s.update(stage=2, works=iprs["stats"]["works"], contributor_rows=iprs["stats"]["contributor_rows"],
                 errors=sum(1 for i in iprs["issues"] if i["severity"] == "error"),
                 warnings=sum(1 for i in iprs["issues"] if i["severity"] == "warning"))
    if result.get("master"):
        s["master_songs"] = result["master"]["stats"]["songs"]
        s["master_issues"] = len(result["master"]["issues"])
    if result.get("mapping"):
        m = result["mapping"]["summary"]
        # Same rule as the review screen: undecided links, title-only links and links with conflicting identifiers.
        review = sum(1 for l in result["mapping"]["links"] if l["state"] == "review" or (
            l["state"] == "linked" and l["method"] != "Confirmed by reviewer" and (l["method"] == "Title + contributors" or l["reason"])))
        s.update(stage=4, linked=m["linked"], matched=m["matched"], with_differences=m["with_differences"],
                 review=review, iprs_only=m["iprs_only"], master_only=m["master_only"])
    if result.get("final"):
        s["final_total"] = result["final"]["summary"]["final_total"]
        s["added"] = result["final"]["summary"]["added"]
    if result.get("tunecodes"):
        s["stage"] = 5
        s["societies"] = {k: v for k, v in result["tunecodes"]["summary"].items() if isinstance(v, dict)}
    return s


def _inputs(run):
    """The files one society check uses: its own society file, the client's master, and – for a foreign society –
    the client's latest IPRS report, so it is compared with the catalogue as IPRS has completed it."""
    own = run.active_files()
    master = run.client.active_master() if run.client else None
    inputs = {"master": master or own["master"], "iprs": None, "prs": None}
    if run.society == "IPRS":
        inputs["iprs"] = own["iprs"]
    else:
        inputs[run.society.lower()] = own.get(run.society.lower())
        if run.client:
            iprs_run = next((r for r in run.client.runs.filter(society="IPRS").order_by(*NEWEST_FIRST).prefetch_related("files")
                             if r.active_file("iprs")), None)
            inputs["iprs"] = iprs_run.active_file("iprs") if iprs_run else None
    return inputs


def compute(run):
    """Process a report (cached until its files or decisions change) and write it into the catalogue."""
    paths = _inputs(run)
    decisions = _decisions(run)
    stamp = (run.created_at.isoformat(), tuple((k, f.id if f else 0, f.file.name if f else "") for k, f in paths.items()),
             json.dumps(decisions, sort_keys=True), run.report_date,
             (run.client.name, run.client.ipi) if run.client else None, APP_VERSION)
    # A stable key (Python's hash() differs per process), so every worker finds what another one computed.
    key = f"run-{run.id}-{hashlib.sha1(repr(stamp).encode()).hexdigest()}"
    result = cache.get(key)
    if result is None:
        client = run.client
        # Local paths first: a file missing on this computer is downloaded from Drive (timed as "drive").
        local = {k: paths[k].file.path if paths.get(k) else None for k in ("iprs", "master", "prs")}
        with measure("processing"):
            result = run_pipeline(
                iprs_path=local["iprs"], master_path=local["master"], prs_path=local["prs"],
                decisions=decisions, societies=(run.society,),
                client={"name": client.name.upper(), "ipi_name_no": client.ipi} if client else None,
            )
        summary = snapshot(result)
        changes = sync_run(run, result)
        if changes is not None:
            old = run.summary.get("changes") or {}
            summary["changes"] = {k: list(dict.fromkeys((old.get(k) or []) + v)) if k != "status_changes"
                                  else (old.get(k) or []) + [c for c in v if c not in (old.get(k) or [])]
                                  for k, v in changes.items()}
        run.summary = summary
        Run.objects.filter(pk=run.pk).update(summary=summary)
        cache.set(key, result, RESULT_TTL)
    return result


def _not_our_work(client):
    return set(client.song_flags.filter(flag=SongFlag.NOT_OUR_WORK).values_list("key", flat=True)) if client else set()


def fill_plan(run, result):
    """What goes into the master's IPRS columns (IPRS reports only; cheap, so not cached)."""
    if run.society != "IPRS" or not result.get("final") or not result.get("iprs"):
        return None
    slots = sum(1 for b in result["master"]["layout"]["blocks"] if b["society"] == "IPRS")
    return fill_iprs_columns(result["iprs"], result["master"], result["mapping"], result["final"],
                             result["iprs"]["client"], _not_our_work(run.client), slots=slots)


def _payload(run):
    result = dict(compute(run))
    result["fill"] = fill_plan(run, result)
    if result.get("master"):
        result["master"] = {k: v for k, v in result["master"].items() if k != "layout"}
    work_ids = {}
    if run.client:
        # Only the one key, not each work's whole sources snapshot (hundreds of KB over the network).
        for wid, key in run.client.works.values_list("id", "sources__tunecode__key"):
            if key:
                work_ids[key] = wid
    return {"run": _run_json(run), "result": result, "latest": is_latest(run) if run.client else True, "work_ids": work_ids,
            "master_edits": _master_edits(run.client)}


def _master_edits(client):
    if not client:
        return []
    return [{"master_row": e.master_row, "field": e.field, "internal_no": e.internal_no, "choice": e.choice}
            for e in client.master_edits.order_by("master_row", "field")]


# ---------------------------------------------------------------- client metrics

def _master_json(master):
    if not master:
        return None
    return {"id": master.id, "name": master.original_name, "uploaded_at": master.uploaded_at.isoformat(), "stats": master.stats}


def _runs(client):
    """The client's reports, newest first, with their files – loaded once per request (the database may be far away)."""
    if not hasattr(client, "_runs"):
        _load([client])
    return client._runs


def _societies(client):
    if not hasattr(client, "_societies"):
        _load([client])
    return client._societies


def _master(client):
    if not hasattr(client, "_master"):
        _load([client])
    return client._master


def _load(clients):
    """Reports (with files), societies and newest master of many clients in three queries, not three per client."""
    by_id = {c.id: c for c in clients}
    for c in clients:
        c._runs, c._societies, c._master = [], [], None
    for run in Run.objects.filter(client_id__in=by_id).order_by(*NEWEST_FIRST).prefetch_related("files"):
        run.client = by_id[run.client_id]
        run.client._runs.append(run)
    for cs in ClientSociety.objects.filter(client_id__in=by_id):
        by_id[cs.client_id]._societies.append(cs)
    for master in MasterFile.objects.filter(client_id__in=by_id).order_by("-uploaded_at"):
        if by_id[master.client_id]._master is None:
            by_id[master.client_id]._master = master


def society_summaries(client, coverage, task_counts):
    """Where the client stands with each society it is reconciled with."""
    out = []
    for cs in _societies(client):
        runs = [r for r in _runs(client) if r.society == cs.society]
        latest = runs[0] if runs else None
        has_file = bool(latest and latest.active_files().get(cs.society.lower()))
        if latest and latest.completed_at:
            status = "completed"
        elif has_file:
            status = "in_progress"
        else:
            status = "not_started"
        own = [t for t in task_counts if t["society"] == cs.society]
        out.append({
            "code": cs.society, "meta": SOCIETY_META.get(cs.society, {"code": cs.society, "name": cs.society}),
            "status": status, "steps": STEPS.get(cs.society, []), "report": _run_json(latest) if latest else None,
            "report_count": len(runs), "coverage": coverage.get(cs.society),
            "open_tasks": sum(t["n"] for t in own if t["state"] not in Task.CLOSED), "tasks": sum(t["n"] for t in own),
            "review": (latest.summary or {}).get("review", 0) if latest and cs.society == "IPRS" else 0,
        })
    return out


def latest_run(client):
    runs = _runs(client)
    return next((r for r in runs if r.summary), None) or max(runs, key=lambda r: r.created_at, default=None)


def client_metrics(client):
    return metrics([client])[client.id]


def metrics(clients):
    """{client id: headline numbers}. The database counts (one query per kind of count for all clients together);
    loading every work, registration and task to count them in Python was most of the tracker's time."""
    ids = [c.id for c in clients]
    _load([c for c in clients if not hasattr(c, "_runs")])
    in_latest = Work.objects.filter(client_id__in=ids, last_run__isnull=False)
    works = {r["client_id"]: r for r in in_latest.values("client_id").annotate(
        works=Count("id"), with_iswc=Count("id", filter=Q(identifiers__has_key="ISWC") & ~Q(identifiers__ISWC=[])
                                           & ~Q(identifiers__ISWC=None)))}
    coverage = defaultdict(dict)
    regs = Registration.objects.filter(work__in=in_latest).values("work__client_id", "society", "status").annotate(n=Count("id"))
    for r in sorted(regs, key=lambda r: (r["society"], r["status"])):
        coverage[r["work__client_id"]].setdefault(r["society"], Counter())[r["status"]] = r["n"]
    today = date.today()
    tasks = defaultdict(list)
    for t in Task.objects.filter(work__client_id__in=ids).values("work__client_id", "society", "type", "state").annotate(
            n=Count("id"), overdue=Count("id", filter=Q(due_date__lt=today))):
        tasks[t["work__client_id"]].append(t)
    no_credit = dict(Task.objects.filter(work__in=in_latest, type=Task.ADD_CREDIT).exclude(state__in=Task.CLOSED)
                     .values("work__client_id").annotate(n=Count("work_id", distinct=True)).values_list("work__client_id", "n"))
    return {c.id: _metrics(c, works.get(c.id, {}), coverage[c.id], tasks[c.id], no_credit.get(c.id, 0)) for c in clients}


def _metrics(client, works, counts, task_counts, no_credit):
    coverage = {society: {"total": sum(n.values()), "registered": sum(n.values()) - n[Registration.NOT_REGISTERED],
                          "clean": n[Registration.REGISTERED], "statuses": dict(n)} for society, n in counts.items()}
    by_type = defaultdict(lambda: {"open": 0, "closed": 0})
    for t in task_counts:
        by_type[f"{t['society']}|{t['type']}"]["closed" if t["state"] in Task.CLOSED else "open"] += t["n"]
    total = sum(t["n"] for t in task_counts)
    open_count = sum(t["n"] for t in task_counts if t["state"] not in Task.CLOSED)
    run = latest_run(client)
    s = (run.summary if run else {}) or {}
    societies = society_summaries(client, coverage, task_counts)
    master = _master(client)
    if not master:
        stage = 0
    elif not any(x["status"] != "not_started" for x in societies):
        stage = 1
    elif societies and all(x["status"] == "completed" for x in societies):
        stage = 3
    else:
        stage = 2
    return {
        "master": _master_json(master),
        "societies": societies,
        "works": works.get("works", 0),
        "with_iswc": works.get("with_iswc", 0),
        "credited": works.get("works", 0) - no_credit,
        "coverage": coverage,
        "tasks": {"open": open_count, "closed": total - open_count, "total": total,
                  "overdue": sum(t["overdue"] for t in task_counts if t["state"] not in Task.CLOSED),
                  "verified": sum(t["n"] for t in task_counts if t["state"] == Task.VERIFIED),
                  "by_type": dict(by_type)},
        "stage": {"index": stage, "label": STAGES[stage]},
        "review": s.get("review", 0),
        "latest_report": _run_json(run) if run else None,
    }


# ---------------------------------------------------------------- clients

@require_http_methods(["GET", "POST"])
def clients(request):
    if request.method == "POST":
        data = _body(request)
        name = (data.get("name") or "").strip()
        if not name:
            return JsonResponse({"error": "Client name is required"}, status=400)
        ipi = (data.get("ipi") or "").strip()[:20]
        if ipi and Client.objects.filter(ipi=norm_ipi(ipi)).exists():
            return JsonResponse({"error": f"A client with IPI {ipi} already exists"}, status=409)
        client = Client.objects.create(name=name[:200], ipi=norm_ipi(ipi) if ipi else "", owner=(data.get("owner") or "").strip()[:100],
                                       due_date=parse_date(data.get("due_date") or "") or None,
                                       home_society=data.get("home_society") or "IPRS")
        return JsonResponse(_client_json(client), status=201)
    everyone = list(Client.objects.all())
    _load(everyone)
    for c in everyone:
        _refresh_soon(c)
    numbers = metrics(everyone)
    out = [{**_client_json(c), **numbers[c.id], "report_count": len(_runs(c))} for c in everyone]
    return JsonResponse({"clients": out, "stages": STAGES})


# Pages show what is in the database straight away; re-processing the latest reports (which may download them from
# Google Drive) runs after the response, at most every REFRESH_EVERY seconds per client. Uploads and the report
# screens still process their report before answering. Tests set this off to get the old, synchronous behaviour.
REFRESH_IN_BACKGROUND = "test" not in __import__("sys").argv[1:2]
REFRESH_EVERY = 5 * 60


def _refresh_soon(client):
    if not REFRESH_IN_BACKGROUND:
        _refresh(client)
        return
    if not cache.add(f"refresh-client-{client.id}", 1, REFRESH_EVERY):
        return   # done (or tried) recently, by this or another worker
    threading.Thread(target=_refresh_in_background, args=(client.id,), name=f"refresh client {client.id}", daemon=True).start()


def _refresh_in_background(client_id):
    try:
        client = Client.objects.filter(pk=client_id).first()
        if client:
            _refresh(client)
    except Exception:
        logger.exception("Background refresh of client %s failed", client_id)
    finally:
        connection.close()   # this thread's own database connection


def _refresh(client):
    """Process the latest report of every society (cached), so the catalogue reflects them."""
    for cs in _societies(client):
        run = next((r for r in _runs(client) if r.society == cs.society), None)
        if run and any(run.active_files().values()) and _master(client):
            try:
                compute(run)
            except (FileNotFoundError, DriveError) as e:
                # One report's spreadsheet missing (or Drive unreachable) must not break the client list / page.
                logger.warning("Report %s of client %s skipped: %s", run.id, client.id, e)


def _delete_files_after_commit(stored):
    """Remove stored spreadsheets (Google Drive + local copy) once the database delete has really happened,
    so a failed delete never leaves rows pointing at files that are gone."""
    stored = [(f.storage, f.name) for f in stored if f.name]
    transaction.on_commit(lambda: [storage.delete(name) for storage, name in stored])


def _delete_run(run):
    _delete_files_after_commit([f.file for f in run.files.all()])
    run.delete()


@require_http_methods(["GET", "PATCH", "DELETE"])
def client_detail(request, client_id):
    client = get_object_or_404(Client, pk=client_id)
    if request.method == "DELETE":
        # Everything of the client goes, all or nothing: its reports (and their decisions), master, societies,
        # works with their registrations, tasks and history, master edits and song flags; then its files.
        with transaction.atomic():
            runs = list(client.runs.all())
            for run in runs:
                _delete_run(run)
            _delete_files_after_commit([m.file for m in client.masters.all()])
            client.delete()
        return JsonResponse({"deleted": client_id, "runs_deleted": len(runs)})
    if request.method == "PATCH":
        data = _body(request)
        if (data.get("name") or "").strip():
            client.name = data["name"].strip()[:200]
        if "owner" in data:
            client.owner = (data["owner"] or "").strip()[:100]
        if "due_date" in data:
            client.due_date = parse_date(data["due_date"]) if data["due_date"] else None
        client.save()
    _refresh_soon(client)
    run = latest_run(client)
    changes = (run.summary.get("changes") if run else None) or {}
    task_titles = {t.id: t for t in Task.objects.filter(id__in=changes.get("verified", []) + changes.get("reopened", []) + changes.get("new_tasks", []))
                   .select_related("work").only("id", "type", "society", "work__id", "work__title")}
    def task_list(ids):
        return [{"id": i, "title": task_titles[i].work.title, "label": f"{TASK_LABEL[task_titles[i].type]} · {task_titles[i].society}"}
                for i in ids if i in task_titles]
    return JsonResponse({
        "client": _client_json(client), **client_metrics(client),
        "reports": [_run_json(r) for r in _runs(client)],
        "available_societies": [{**s, "added": s["code"] in {cs.society for cs in _societies(client)}} for s in SOCIETIES],
        "changes": {"new_works": len(changes.get("new_works", [])), "status_changes": changes.get("status_changes", []),
                    "verified": task_list(changes.get("verified", [])), "reopened": task_list(changes.get("reopened", [])),
                    "new_tasks": len(changes.get("new_tasks", []))},
    })


@require_http_methods(["POST", "DELETE"])
def client_master(request, client_id):
    """Upload (or replace) our master for this client. Every society check is compared against it.
    DELETE removes the master (all versions); the societies wait for a new one."""
    client = get_object_or_404(Client, pk=client_id)
    if request.method == "DELETE":
        with transaction.atomic():
            masters = list(client.masters.all())
            _delete_files_after_commit([m.file for m in masters])
            client.masters.all().delete()
        return client_detail(_as_get(request), client_id)
    uploaded = request.FILES.get("file")
    if not uploaded:
        return JsonResponse({"error": "No file was sent"}, status=400)
    with tempfile.NamedTemporaryFile(suffix=Path(uploaded.name).suffix) as tmp:
        for chunk in uploaded.chunks():
            tmp.write(chunk)
        tmp.flush()
        parsed, error = _try_parse(tmp.name, SourceFile.MASTER)
        if error:
            # A common mistake: dropping the IPRS or PRS file here.
            for other in (SourceFile.IPRS, SourceFile.PRS):
                if _try_parse(tmp.name, other)[0] is not None:
                    error = {"error": f"This is the {other.upper()} file, not our master. Upload it inside the {other.upper()} workspace."}
            return JsonResponse(error, status=422)
    uploaded.seek(0)
    stats = {**parsed["stats"], "issues": len(parsed["issues"]),
             "issue_counts": dict(Counter(i["code"] for i in parsed["issues"]))}
    master = MasterFile(client=client, original_name=uploaded.name, stats=stats)
    try:
        master.file.save(uploaded.name, uploaded, save=False)   # store the file (Google Drive) before the database row
    except DriveError as e:
        return JsonResponse({"error": f"The file could not be saved: {e}"}, status=502)
    master.save()
    # Only once the new master is safely stored: choices that point at rows of the old master go.
    client.master_edits.all().delete()
    client.song_flags.filter(key__startswith="M").delete()
    return client_detail(_as_get(request), client_id)


def _as_get(request):
    request.method = "GET"
    return request


@require_http_methods(["POST"])
def client_societies(request, client_id):
    client = get_object_or_404(Client, pk=client_id)
    codes = _body(request).get("societies") or []
    bad = [c for c in codes if c not in SOCIETY_CODES]
    if bad:
        return JsonResponse({"error": f"Not available yet: {', '.join(bad)}"}, status=400)
    for code in codes:
        ClientSociety.objects.get_or_create(client=client, society=code)
    return client_detail(_as_get(request), client_id)


@require_http_methods(["DELETE", "POST"])
def client_society(request, client_id, society):
    """DELETE removes a society that has no reports yet. POST starts a new report for it."""
    client = get_object_or_404(Client, pk=client_id)
    cs = get_object_or_404(ClientSociety, client=client, society=society)
    if request.method == "DELETE":
        # Remove the society completely: its reports (and files), its statuses and follow-ups, and any work
        # that only existed because of it (e.g. songs the IPRS report added).
        runs = list(client.runs.filter(society=society))
        for run in runs:
            _delete_run(run)
        Registration.objects.filter(work__client=client, society=society).delete()
        Task.objects.filter(client=client, society=society).delete()
        if society == "IPRS":
            client.works.filter(origin="iprs").delete()  # songs that only the IPRS report added
        if not client.runs.exists():
            client.works.all().delete()
        cs.delete()
        return client_detail(_as_get(request), client_id)
    data = _body(request)
    run = Run.objects.create(name=f"{client.name} – {society} report", client=client, society=society,
                             client_name=client.name, client_ipi=client.ipi,
                             report_date=parse_date(data.get("report_date") or "") or date.today())
    return JsonResponse(_run_json(run), status=201)


# ---------------------------------------------------------------- tasks

def _tasks_qs(client):
    return client.tasks.select_related("work", "opened_run", "closed_run").defer(*TASK_WORK_HEAVY, *TASK_RUN_HEAVY).prefetch_related(
        Prefetch("work__registrations", Registration.objects.only("id", "work_id", "society", "codes")))


def client_tasks(request, client_id):
    client = get_object_or_404(Client, pk=client_id)
    return JsonResponse({"tasks": [_task_json(t) for t in _tasks_qs(client)]})


def _apply(task, data, latest):
    if "state" in data and data["state"] in TASK_STATES and data["state"] != task.state:
        old = task.get_state_display()
        task.state = data["state"]
        task.closed_run = latest if data["state"] in Task.CLOSED else None
        TaskEvent.objects.create(task=task, kind="state", text=f"{old} → {task.get_state_display()}")
    if "owner" in data and (data["owner"] or "") != task.owner:
        task.owner = (data["owner"] or "").strip()[:100]
        TaskEvent.objects.create(task=task, kind="owner", text=f"Owner: {task.owner or 'nobody'}")
    if "due_date" in data:
        due = parse_date(data["due_date"]) if data["due_date"] else None
        if due != task.due_date:
            task.due_date = due
            TaskEvent.objects.create(task=task, kind="due", text=f"Due date: {_iso(due) or 'none'}")
    if "note" in data and data["note"] != task.note:
        task.note = data["note"] or ""
        if task.note:
            TaskEvent.objects.create(task=task, kind="note", text=task.note)
    task.save()


@require_http_methods(["POST"])
def tasks_bulk(request, client_id):
    client = get_object_or_404(Client, pk=client_id)
    data = _body(request)
    ids = data.get("ids") or []
    latest = latest_run(client)
    for task in client.tasks.filter(id__in=ids):
        _apply(task, data, latest)
    return JsonResponse({"tasks": [_task_json(t) for t in _tasks_qs(client)]})


@require_http_methods(["GET", "PATCH"])
def task_detail(request, task_id):
    task = get_object_or_404(Task.objects.select_related("work", "client", "opened_run", "closed_run"), pk=task_id)
    if request.method == "PATCH":
        _apply(task, _body(request), latest_run(task.client))
    return JsonResponse(_task_json(task, events=True))


# ---------------------------------------------------------------- works

def client_works(request, client_id):
    client = get_object_or_404(Client, pk=client_id)
    works = client.works.defer("sources", "alt_titles").prefetch_related(ROW_REGS, ROW_TASKS)
    return JsonResponse({"works": [_work_row(w) for w in works]})


def work_detail(request, work_id):
    work = get_object_or_404(Work.objects.select_related("client", "first_run", "last_run"), pk=work_id)
    tasks = work.tasks.select_related("work", "opened_run", "closed_run").defer(*TASK_WORK_HEAVY, *TASK_RUN_HEAVY).prefetch_related("events", "work__registrations")
    return JsonResponse({
        **_work_row(work), "client": _client_json(work.client), "alt_titles": work.alt_titles, "language": work.language,
        "category": work.category, "duration": work.duration, "master_row": work.master_row, "credits": work.credits,
        "sources": work.sources, "first_report": _iso(work.first_run.report_date) if work.first_run else None,
        "last_report": _iso(work.last_run.report_date) if work.last_run else None,
        "registration_detail": [{"society": r.society, "status": r.status, "label": r.get_status_label(), "codes": r.codes,
                                 "found_by": r.found_by, "issues": r.issues} for r in work.registrations.all()],
        "tasks": [_task_json(t, events=True) for t in tasks],
        "events": [{"kind": e.kind, "text": e.text, "at": e.at.isoformat()} for e in work.events.all()],
        "latest_run": work.client.runs.order_by(*NEWEST_FIRST).values_list("id", flat=True).first(),
    })


# ---------------------------------------------------------------- reports (runs)

@require_http_methods(["GET", "POST"])
def runs(request):
    if request.method == "POST":
        data = _body(request)
        client = Client.objects.filter(pk=data.get("client_id")).first() if data.get("client_id") else None
        name = (data.get("name") or "").strip() or (f"{client.name} – report" if client else "New report")
        run = Run.objects.create(name=name[:200], client=client, client_name=client.name if client else "",
                                 client_ipi=client.ipi if client else "",
                                 report_date=parse_date(data.get("report_date") or "") or date.today())
        return JsonResponse(_run_json(run), status=201)
    return JsonResponse({"runs": [_run_json(r) for r in Run.objects.select_related("client")]})


@require_http_methods(["GET", "PATCH", "DELETE"])
def run_detail(request, run_id):
    run = get_object_or_404(Run, pk=run_id)
    if request.method == "DELETE":
        _delete_run(run)
        return JsonResponse({"deleted": run_id})
    if request.method == "PATCH":
        data = _body(request)
        if (data.get("name") or "").strip():
            run.name = data["name"].strip()[:200]
        if "report_date" in data:
            run.report_date = parse_date(data["report_date"]) if data["report_date"] else None
        if "confirmed_step" in data:
            run.confirmed_step = max(0, min(int(data["confirmed_step"]), len(STEPS.get(run.society, []))))
        if "completed" in data:
            run.completed_at = timezone.now() if data["completed"] else None
        run.save()
    return JsonResponse(_payload(run))


def _try_parse(path, kind):
    parser, error_type = PARSERS[kind]
    try:
        return parser(path), None
    except error_type as e:
        return None, {"error": str(e), "checks": getattr(e, "checks", [])}
    except Exception as e:  # unreadable / not a spreadsheet of this kind
        return None, {"error": f"Could not read the file: {e}"}


@require_http_methods(["POST"])
def upload(request, run_id, kind):
    """Upload one source file. kind = iprs / master / prs, or 'auto' to recognise it from its columns."""
    run = get_object_or_404(Run, pk=run_id)
    if kind not in PARSERS and kind != "auto":
        raise Http404("Unknown file type")
    uploaded = request.FILES.get("file")
    if not uploaded:
        return JsonResponse({"error": "No file was sent"}, status=400)
    # Validate before keeping the file: a file in the wrong format is rejected, never patched up.
    with tempfile.NamedTemporaryFile(suffix=Path(uploaded.name).suffix) as tmp:
        for chunk in uploaded.chunks():
            tmp.write(chunk)
        tmp.flush()
        if kind == "auto":
            parsed = None
            for candidate in (SourceFile.IPRS, SourceFile.MASTER, SourceFile.PRS):
                parsed, _ = _try_parse(tmp.name, candidate)
                if parsed is not None:
                    kind = candidate
                    break
            if parsed is None:
                return JsonResponse({"error": f"{uploaded.name} is not an IPRS work listing, an MRM master or a PRS works export"}, status=422)
        else:
            parsed, error = _try_parse(tmp.name, kind)
            if error:
                return JsonResponse(error, status=422)
    expected = run.society.lower()
    if kind == SourceFile.MASTER and run.client:
        return JsonResponse({"error": "This is our master. Upload it on the client page (it is shared by every society)."}, status=422)
    if run.client and kind != expected:
        return JsonResponse({"error": f"This is the {kind.upper()} file, but this is the {run.society} workspace. Upload it in the {kind.upper()} workspace."}, status=422)
    if kind == SourceFile.IPRS and run.client and run.client.ipi and parsed["client"]["ipi_name_no"] \
            and parsed["client"]["ipi_name_no"] != run.client.ipi:
        return JsonResponse({"error": f"This IPRS report is for {parsed['client']['name'].title()} (IPI {parsed['client']['ipi_name_no']}), "
                                      f"not {run.client.name} (IPI {run.client.ipi})."}, status=422)
    uploaded.seek(0)
    source = SourceFile(run=run, kind=kind, original_name=uploaded.name)
    try:
        source.file.save(uploaded.name, uploaded, save=False)   # store the file (Google Drive) before the database row
    except DriveError as e:
        return JsonResponse({"error": f"The file could not be saved: {e}"}, status=502)
    source.save()
    if run.client and not run.client.ipi and kind == SourceFile.IPRS:
        Client.objects.filter(pk=run.client_id).update(ipi=parsed["client"]["ipi_name_no"])
    if kind == SourceFile.IPRS:
        info = parsed["client"]
        run.client_name, run.client_ipi = info["name"], info["ipi_name_no"]
        if run.client is None:
            run.client = (Client.objects.filter(ipi=info["ipi_name_no"]).first() if info["ipi_name_no"] else None) \
                or Client.objects.filter(name__iexact=info["name"]).first() \
                or Client.objects.create(name=info["name"].title(), ipi=info["ipi_name_no"])
        if run.name in ("New report", "New reporting run") and info["name"]:
            run.name = f"{info['name'].title()} – IPRS report"
    run.save()
    return JsonResponse({**_payload(run), "detected": kind})


@require_http_methods(["POST"])
def decide(request, run_id):
    """Reviewer links an IPRS work to a master row, rejects a suggestion, or clears the decision."""
    run = get_object_or_404(Run, pk=run_id)
    data = _body(request)
    if data.get("items"):  # "Confirm all": [{internal_no, master_row}, …] linked in one go
        titles = {s["row"]: s["title"] for s in compute(run)["master"]["songs"]}
        for item in data["items"]:
            row = int(item["master_row"])
            decision, _ = LinkDecision.objects.get_or_create(run=run, internal_no=str(item["internal_no"]))
            decision.master_row, decision.master_title = row, titles.get(row, "")
            decision.rejected_rows = [r for r in decision.rejected_rows if r != row]
            decision.save()
        run.save()
        return JsonResponse(_payload(run))
    internal_no = str(data.get("internal_no") or "")
    action = data.get("action")
    if not internal_no or action not in ("link", "reject", "clear"):
        return JsonResponse({"error": "internal_no and action (link / reject / clear) are required"}, status=400)
    if action == "clear":
        LinkDecision.objects.filter(run=run, internal_no=internal_no).delete()
    else:
        decision, _ = LinkDecision.objects.get_or_create(run=run, internal_no=internal_no)
        row = int(data["master_row"]) if data.get("master_row") is not None else None
        title = next((s["title"] for s in compute(run)["master"]["songs"] if s["row"] == row), "") if row else ""
        if action == "link":
            decision.master_row, decision.master_title = row, title
            decision.rejected_rows = [r for r in decision.rejected_rows if r != row]
        else:
            decision.master_row, decision.master_title = None, ""
            if row is not None and row not in decision.rejected_rows:
                decision.rejected_rows = decision.rejected_rows + [row]
        decision.save()
    run.save()
    return JsonResponse(_payload(run))


@require_http_methods(["POST"])
def master_edits(request, run_id):
    """Save which value to keep for fields where IPRS and our master differ (or our master is empty).
    Body: {"edits": [{"master_row", "field", "internal_no", "choice": "iprs" | "master" | null}]}; null clears it."""
    run = get_object_or_404(Run, pk=run_id)
    if not run.client:
        return JsonResponse({"error": "This report has no client"}, status=409)
    edits = _body(request).get("edits") or []
    for e in edits:
        if e.get("field") not in MasterEdit.FIELDS or e.get("choice") not in (MasterEdit.IPRS, MasterEdit.MASTER, None) \
                or not isinstance(e.get("master_row"), int):
            return JsonResponse({"error": "Each edit needs master_row, field and choice (iprs / master / null)"}, status=400)
    for e in edits:
        key = {"client": run.client, "master_row": e["master_row"], "field": e["field"]}
        if e["choice"] is None:
            MasterEdit.objects.filter(**key).delete()
        else:
            MasterEdit.objects.update_or_create(**key, defaults={"choice": e["choice"], "internal_no": str(e.get("internal_no") or "")})
    return JsonResponse(_payload(run))


@require_http_methods(["POST"])
def song_flags(request, run_id):
    """Mark songs "Not our work" (or clear it). Body: {"keys": ["M12", "I2158…"], "on": true}."""
    run = get_object_or_404(Run, pk=run_id)
    if not run.client:
        return JsonResponse({"error": "This report has no client"}, status=409)
    data = _body(request)
    keys = [str(k) for k in data.get("keys") or []]
    if data.get("on"):
        titles = {r["key"]: r["title"] for r in (compute(run).get("final") or {}).get("rows", [])}
        for key in keys:
            SongFlag.objects.update_or_create(client=run.client, key=key, flag=SongFlag.NOT_OUR_WORK,
                                              defaults={"title": titles.get(key, "")[:300]})
    else:
        SongFlag.objects.filter(client=run.client, key__in=keys, flag=SongFlag.NOT_OUR_WORK).delete()
    return JsonResponse(_payload(run))


# ---------------------------------------------------------------- exports

EXPORT_NAMES = {
    "amend_lnv": "Amend_report_LNV", "registration_lnv": "Registration_report_LNV",
    "step1": "1_IPRS_validation_and_cleanup", "step2": "2_IPRS_one_line", "step3": "3_Mapping_with_master",
    "step5": "5_Tune_code_check", "all": "Full_workings", "final": "Updated_master_LNV",
}


def _xlsx(content, filename):
    response = HttpResponse(content, content_type=XLSX)
    response["Content-Disposition"] = f'attachment; filename="{filename}.xlsx"'
    return response


def download(request, run_id, name):
    run = get_object_or_404(Run, pk=run_id)
    if name not in EXPORT_NAMES:
        raise Http404("Unknown export")
    if run.society != "IPRS" and name in ("step1", "step2", "final"):
        return JsonResponse({"error": "That download belongs to the IPRS workspace"}, status=409)
    result = compute(run)
    needs = {"step1": "iprs", "step2": "iprs", "step3": "mapping", "step5": "tunecodes", "all": "iprs", "final": "final",
             "amend_lnv": "tunecodes", "registration_lnv": "tunecodes"}
    if run.society != "IPRS":
        needs["all"] = "tunecodes"
    if not result.get(needs[name]):
        return JsonResponse({"error": "Upload the files for this step first"}, status=409)
    if name in ("amend_lnv", "registration_lnv"):
        content = export.lnv_action_report(_inputs(run)["master"].file.path, result["iprs"], result["final"], result["tunecodes"],
                                           run.society, "Amend" if name == "amend_lnv" else "Registration")
        return _xlsx(content, f"{(run.client_name or 'client').title().replace(' ', '_')}_{run.society}_{run.report_date or ''}_{EXPORT_NAMES[name]}")
    if name == "final":
        content = export.final_report(_inputs(run)["master"].file.path, result["iprs"], result["final"], _master_edits(run.client),
                                      fill_plan(run, result))
    else:
        content = export.step_workbook(name, result)
    client = (run.client_name or "client").title().replace(" ", "_")
    return _xlsx(content, f"{client}_{run.report_date or ''}_{EXPORT_NAMES[name]}")


def verify(request, run_id):
    """Read back the files this report produces and check every step (IPRS reports)."""
    run = get_object_or_404(Run, pk=run_id)
    if run.society != "IPRS":
        return JsonResponse({"error": "Verification is available for IPRS reports"}, status=409)
    result = compute(run)
    if not result.get("final") or not result.get("tunecodes"):
        return JsonResponse({"error": "Upload the IPRS report and our master first"}, status=409)
    master = _inputs(run)["master"].file.path
    fill = fill_plan(run, result)
    edits = _master_edits(run.client)
    out = export.final_report(master, result["iprs"], result["final"], edits, fill)
    amend = export.lnv_action_report(master, result["iprs"], result["final"], result["tunecodes"], "IPRS", "Amend")
    reg = export.lnv_action_report(master, result["iprs"], result["final"], result["tunecodes"], "IPRS", "Registration")
    return JsonResponse(verify_run(master, out, result["iprs"], result["mapping"], result["final"], fill, result["tunecodes"],
                                   edits, result["iprs"]["client"], amend, reg))


def pair(request, run_id):
    """Every column of one IPRS work next to every column of a master row (?work=<internal no>&row=<master row>)."""
    run = get_object_or_404(Run, pk=run_id)
    result = compute(run)
    inputs = _inputs(run)
    work_no, row = request.GET.get("work", ""), request.GET.get("row", "")
    work = next((w for w in (result.get("iprs") or {}).get("works", []) if w["internal_no"] == work_no), None)
    master = result.get("master") or {}
    song = next((s for s in master.get("songs", []) if str(s["row"]) == row), None)
    if not work and not song:
        raise Http404("Unknown work and master row")
    return JsonResponse(build_pair(inputs["iprs"].file.path if inputs["iprs"] else None,
                                   inputs["master"].file.path if inputs["master"] else None,
                                   work, song, master.get("layout")))


def client_export(request, client_id, name):
    client = get_object_or_404(Client, pk=client_id)
    if name == "tasks":
        content = export.tasks_workbook(client, [_task_json(t, events=True) for t in _tasks_qs(client).prefetch_related("events")])
    elif name == "catalogue":
        content = export.catalogue_workbook(client, [_work_row(w) for w in client.works.defer("sources").prefetch_related("registrations", "tasks")])
    else:
        raise Http404("Unknown export")
    return _xlsx(content, f"{client.name.replace(' ', '_')}_{name}_{date.today()}")


def frontend(request, path=""):
    """Serve the built React app (frontend/dist) so one server runs everything."""
    dist = Path(settings.FRONTEND_DIST)
    target = (dist / path).resolve()
    if path and target.is_file() and dist.resolve() in target.parents:
        return FileResponse(open(target, "rb"))
    index = dist / "index.html"
    if not index.exists():
        return HttpResponse("Frontend not built yet. Run `npm run build` in frontend/ or use the Vite dev server.", status=503)
    return FileResponse(open(index, "rb"), content_type="text/html")
