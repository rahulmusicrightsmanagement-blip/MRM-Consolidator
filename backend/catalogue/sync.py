"""Turn a processed report into the client's persistent catalogue.

For every song in the report's final list:
  1. find its Work (by IPRS tunecode, PRS tunecode, ISWC, then title) or create one with a new MRM ID,
  2. refresh the golden record (survivorship: IPRS for credits/ISWC, master for title),
  3. store where it stands at each society (Registration),
  4. reconcile Tasks: open new ones, update existing ones, auto-verify the ones the report shows are fixed,
     and reopen ones that were marked done but still show up.
Only the client's newest report changes task states, so re-opening an old report never undoes progress.
"""
from django.db import transaction
from django.utils import timezone

from .engine.normalize import norm_title, same_party
from .models import NEWEST_FIRST, Registration, Run, Task, TaskEvent, Work, WorkEvent

TASK_FOR_ISSUE = {
    "NOT_FOUND": Task.REGISTER,
    "CLIENT_NOT_CREDITED": Task.ADD_CREDIT,
    "CODE_NOT_IN_EXPORT": Task.ADD_CREDIT,
    "CREDITS_DIFFER": Task.CORRECT,
    "UNKNOWN_WRITER": Task.CORRECT,
    "ISWC_DIFFERS": Task.CORRECT,
    "DUPLICATE_REGISTRATION": Task.MERGE,
}
TASK_LABEL = dict(Task.TYPES)


def _status(society_result):
    codes = {i["code"] for i in society_result.get("issues", [])}
    if society_result["status"] == "Registration":
        return Registration.NOT_REGISTERED
    if society_result["status"] == "Amend":
        return Registration.NEEDS_AMEND
    if "DUPLICATE_REGISTRATION" in codes:
        return Registration.DUPLICATE
    return Registration.REGISTERED


def _golden_credits(iprs_works, master_song, prs_works):
    """One list of people across all sources; IPRS shares win, every source that names the person is recorded."""
    people = []

    def find(name, ipi=""):
        return next((p for p in people if same_party(p["name"], name, p["ipi"], ipi)), None)

    for w in iprs_works[:1]:
        for c in w["contributors"]:
            p = find(c["name"], c["ipi"])
            if p:
                if c["role"] not in p["role"].split("/"):
                    p["role"] += "/" + c["role"]
                continue
            people.append({"name": c["name"], "role": c["role"], "ipi": c["ipi"], "share": c["per_own"],
                           "society": c["society"], "sources": ["IPRS"]})
    if master_song:
        for group in ("authors", "composers", "publishers"):
            for m in master_song.get(group, []):
                p = find(m["name"], m["ipi"])
                if p:
                    p["sources"].append("Master")
                    p["master_share"] = m["perf"]
                    continue
                people.append({"name": m["name"], "role": m["role"], "ipi": m["ipi"], "share": m["perf"],
                               "society": "", "sources": ["Master"]})
    for w in prs_works:
        for name in w["writers"] + w["publishers"]:
            p = find(name)
            if p:
                if "PRS" not in p["sources"]:
                    p["sources"].append("PRS")
                continue
            people.append({"name": name, "role": "E" if name in w["publishers"] else "", "ipi": "", "share": None,
                           "society": "", "sources": ["PRS"]})
    return people


def _ids(iprs_works, master_song, prs_works, tc_row):
    ids = {"IPRS": [w["internal_no"] for w in iprs_works], "PRS": list(tc_row["societies"].get("PRS", {}).get("codes", [])),
           "ISWC": [], "ISRC": []}
    for w in iprs_works:
        for key, value in (("ISWC", w["iswc_valid"]), ("ISRC", w["isrc_valid"])):
            if value and value not in ids[key]:
                ids[key].append(value)
    if master_song:
        for key, values in (("ISWC", master_song["iswcs"]), ("ISRC", master_song["isrcs"])):
            ids[key] += [v for v in values if v not in ids[key]]
        for reg in master_song["registrations"]:
            if reg["society"] in ("IPRS", "PRS") and reg["code"] and reg["code"] not in ids[reg["society"]]:
                ids[reg["society"]].append(reg["code"])
    for w in prs_works:
        if w["iswc_valid"] and w["iswc_valid"] not in ids["ISWC"]:
            ids["ISWC"].append(w["iswc_valid"])
    return ids


def _find_work(existing, ids, title):
    for key in ("IPRS", "PRS", "ISWC"):
        wanted = set(ids.get(key, []))
        if not wanted:
            continue
        for work in existing:
            if wanted & set(work.identifiers.get(key, [])):
                return work
    t = norm_title(title)
    same_title = [w for w in existing if norm_title(w.title) == t]
    return same_title[0] if len(same_title) == 1 else None


def is_latest(run):
    """Only the newest report of a society may change that society's statuses and tasks."""
    newest = Run.objects.filter(client=run.client, society=run.society).exclude(summary={}) \
        .order_by(*NEWEST_FIRST).first()
    return newest is None or newest.id == run.id


class _Writes:
    """Everything one sync changes, written with a handful of bulk queries at the end instead of one query per
    song (the database can be far away – e.g. Neon – where every query costs a network round trip)."""

    def __init__(self):
        self.now = timezone.now()
        self.new_regs, self.changed_regs = [], []
        self.new_tasks, self.changed_tasks = [], {}
        self.task_events = []   # (task, kind, text), in the order they happened
        self.work_events = []   # WorkEvent objects whose work is saved

    def task_changed(self, task):
        task.updated_at = self.now
        self.changed_tasks[id(task)] = task

    def flush(self, changes):
        Registration.objects.bulk_create(self.new_regs, batch_size=BATCH)
        for reg in self.changed_regs:
            reg.updated_at = self.now
        Registration.objects.bulk_update(self.changed_regs, ["status", "codes", "found_by", "issues", "last_run", "updated_at"],
                                         batch_size=BATCH)
        Task.objects.bulk_create(self.new_tasks, batch_size=BATCH)   # fills in ids for the events below
        changes["new_tasks"] += [t.id for t in self.new_tasks]
        Task.objects.bulk_update(list(self.changed_tasks.values()), ["detail", "state", "closed_run", "updated_at"],
                                 batch_size=BATCH)
        TaskEvent.objects.bulk_create([TaskEvent(task=t, kind=k, text=x) for t, k, x in self.task_events], batch_size=BATCH)
        WorkEvent.objects.bulk_create(self.work_events, batch_size=BATCH)


BATCH = 200
WORK_FIELDS = ["title", "alt_titles", "identifiers", "language", "category", "duration", "origin", "master_row",
               "credits", "sources", "last_run", "updated_at"]


@transaction.atomic
def sync_run(run, result):
    """Write one processed report into the client's catalogue. Returns a 'what changed' summary."""
    if not run.client or not result.get("tunecodes"):
        return None
    client = run.client
    latest = is_latest(run)
    works_by_id = {w["internal_no"]: w for w in (result["iprs"] or {}).get("works", [])}
    songs_by_row = {s["row"]: s for s in result["master"]["songs"]}
    prs_by_code = {w["code"]: w for w in (result["prs"] or {}).get("works", [])}
    links = {l["internal_no"]: l for l in result["mapping"]["links"]}
    finals = {r["key"]: r for r in result["final"]["rows"]}

    existing = list(client.works.all())
    next_no = 1 + max([int(w.mrm_id.split("-")[1]) for w in existing] + [0])
    changes = {"new_works": [], "status_changes": [], "verified": [], "reopened": [], "new_tasks": []}
    seen = set()       # id() of the Work objects this report covers (new ones have no database id yet)
    planned = []       # (work, row, created) in report order

    for row in result["tunecodes"]["rows"]:
        final = finals[row["key"]]
        iprs_works = [works_by_id[i] for i in final["iprs_works"]]
        master_song = songs_by_row.get(final["master_row"])
        prs_works = [prs_by_code[c] for c in row["societies"].get("PRS", {}).get("codes", []) if c in prs_by_code]
        ids = _ids(iprs_works, master_song, prs_works, row)
        work = _find_work([w for w in existing if id(w) not in seen], ids, row["title"])
        created = work is None
        if created:
            work = Work(client=client, mrm_id=f"W-{next_no:04d}", first_run=run)
            next_no += 1

        # Golden record. Our master's title wins; otherwise the IPRS title.
        work.title = row["title"]
        lead = iprs_works[0] if iprs_works else None
        alts = {t for t in [w["title"] for w in iprs_works] + [w["alt_title"] for w in iprs_works] if t and t != row["title"]}
        work.alt_titles = sorted(set(work.alt_titles) | alts)
        merged = {k: list(dict.fromkeys((work.identifiers or {}).get(k, []) + v)) for k, v in ids.items()}
        work.identifiers = merged
        work.language = (lead["language"] if lead else "") or (master_song or {}).get("language", "") or work.language
        work.category = (lead["category"] if lead else "") or work.category
        work.duration = (lead["duration"] if lead else "") or (master_song or {}).get("duration", "") or work.duration
        work.origin = row["origin"]
        work.master_row = final["master_row"]
        work.credits = _golden_credits(iprs_works, master_song, prs_works)
        previous = work.sources or {}
        checks = {**(previous.get("tunecode") or {}).get("societies", {}), **row["societies"]}
        work.sources = {
            "iprs": iprs_works or previous.get("iprs", []), "master": master_song,
            "prs": prs_works if "PRS" in row["societies"] else previous.get("prs", []),
            "links": [links[i] for i in final["iprs_works"] if i in links] or previous.get("links", []),
            "fills": final["fills"] or previous.get("fills", []),
            "tunecode": {**row, "societies": checks},
        }
        if latest:
            work.last_run = run
        seen.add(id(work))
        if created:
            existing.append(work)
            changes["new_works"].append(work.mrm_id)
        planned.append((work, row, created))

    writes = _Writes()
    new_works = [w for w, _, created in planned if created]
    old_works = [w for w, _, created in planned if not created]
    Work.objects.bulk_create(new_works, batch_size=BATCH)   # fills in their ids
    for work in old_works:
        work.updated_at = writes.now
    Work.objects.bulk_update(old_works, WORK_FIELDS, batch_size=BATCH)

    regs, tasks = {}, {}
    if latest:
        for reg in Registration.objects.filter(work__client=client):
            regs[(reg.work_id, reg.society)] = reg
        for task in Task.objects.filter(work__client=client).select_related("closed_run").defer("closed_run__summary").order_by("id"):
            tasks.setdefault(task.work_id, {})[(task.society, task.type)] = task

    for work, row, created in planned:
        if created:
            writes.work_events.append(WorkEvent(work=work, run=run, kind="created",
                                                text="Added from the IPRS report (not in our master)" if row["origin"] == "iprs" else "First seen in this report"))
        if not latest:
            continue
        # Registrations per society.
        for society, res in row["societies"].items():
            status = _status(res)
            reg = regs.get((work.id, society))
            if reg is None:
                reg = Registration(work=work, society=society)
                writes.new_regs.append(reg)
            else:
                if reg.status != status:
                    writes.work_events.append(WorkEvent(work=work, run=run, kind="status",
                                                        text=f"{society}: {reg.get_status_label()} → {Registration.label(status)}"))
                    changes["status_changes"].append({"work": work.mrm_id, "title": work.title, "society": society,
                                                      "from": reg.status, "to": status})
                writes.changed_regs.append(reg)
            reg.status, reg.codes, reg.found_by, reg.issues, reg.last_run = status, res["codes"], res["method"], res["issues"], run
        _plan_tasks(client, work, tasks.get(work.id, {}), row, run, changes, writes)

    if latest:
        # Works the newest report no longer mentions keep their history but lose their open tasks' urgency.
        covered = {w.id for w, _, _ in planned}
        for work in sorted((w for w in existing if w.id not in covered), key=lambda w: w.title):
            for task in tasks.get(work.id, {}).values():
                if task.state not in Task.CLOSED:
                    writes.task_events.append((task, "updated", "Song is not in the latest report any more"))
    writes.flush(changes)
    return changes


def _desired_tasks(row, society):
    """{(society, type): [reasons]} that this report says are needed for the song.
    Fixes to our master are filed under the society whose check found them."""
    wanted = {}
    for society, res in row["societies"].items():
        for issue in res.get("issues", []):
            task_type = TASK_FOR_ISSUE.get(issue["code"])
            if task_type:
                wanted.setdefault((society, task_type), []).append(issue["text"])
    if row["master_updates"]:
        wanted[(society, Task.FIX_MASTER)] = list(row["master_updates"])
    return wanted


def _newer(run, other):
    return (run.report_date, run.created_at) > (other.report_date, other.created_at)


def _reconcile_tasks(client, work, row, run, changes):
    """Bring one work's tasks in line with one report row (writes straight away)."""
    writes = _Writes()
    current = {(t.society, t.type): t for t in work.tasks.select_related("closed_run").defer("closed_run__summary")}
    _plan_tasks(client, work, current, row, run, changes, writes)
    writes.flush(changes)


def _plan_tasks(client, work, current, row, run, changes, writes):
    """Open, update, reopen or auto-verify the work's tasks; the writes are queued on `writes`."""
    wanted = _desired_tasks(row, getattr(run, "society", "IPRS"))
    when = run.report_date.isoformat() if run.report_date else "this report"
    for key, reasons in wanted.items():
        task = current.get(key)
        if task is None:
            task = Task(client=client, work=work, society=key[0], type=key[1], detail=reasons, opened_run=run, owner=client.owner)
            writes.new_tasks.append(task)
            writes.task_events.append((task, "created", f"Found in report {when}"))
            continue
        if task.detail != reasons:
            task.detail = reasons
            writes.task_changed(task)
        # Reopen only when a newer report still shows the problem; never undo a dismissal.
        if task.state in (Task.VERIFIED, Task.DONE) and task.closed_run_id and task.closed_run_id != run.id \
                and _newer(run, task.closed_run):
            previous = task.get_state_display()
            task.state, task.closed_run = Task.OPEN, None
            writes.task_changed(task)
            writes.task_events.append((task, "reopened", f"Was '{previous}', but report {when} still shows the problem"))
            changes["reopened"].append(task.id)
    checked = set(row["societies"]) | {getattr(run, "society", "IPRS")}
    for key, task in current.items():
        # Only a society this report actually checked can prove a fix (a report without the PRS file proves nothing for PRS).
        if key not in wanted and key[0] in checked and task.state not in Task.CLOSED:
            task.state, task.closed_run = Task.VERIFIED, run
            writes.task_changed(task)
            writes.task_events.append((task, "auto_verified", f"Report {when} no longer shows the problem – verified fixed"))
            changes["verified"].append(task.id)
