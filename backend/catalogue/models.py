from django.db import models


# Report order. Spelled out because SQLite and Postgres put reports without a date at opposite ends by default.
NEWEST_FIRST = (models.F("report_date").desc(nulls_last=True), models.F("created_at").desc())
OLDEST_FIRST = (models.F("report_date").asc(nulls_first=True), models.F("created_at").asc())


class Client(models.Model):
    """A rightsholder MRM manages, identified by their IPI name number."""
    name = models.CharField(max_length=200)
    ipi = models.CharField(max_length=20, blank=True, db_index=True)
    owner = models.CharField(max_length=100, blank=True)  # team member handling the client
    due_date = models.DateField(null=True, blank=True)
    home_society = models.CharField(max_length=20, default="IPRS")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name

    def active_master(self):
        return self.masters.order_by("-uploaded_at").first()


def master_path(instance, filename):
    return f"clients/{instance.client_id}/master/{filename}"


class MasterFile(models.Model):
    """Our master (LNV report) for a client – uploaded once, shared by every society check. Older versions are kept."""
    client = models.ForeignKey(Client, related_name="masters", on_delete=models.CASCADE)
    file = models.FileField(upload_to=master_path, max_length=300)
    original_name = models.CharField(max_length=255)
    stats = models.JSONField(default=dict, blank=True)
    uploaded_at = models.DateTimeField(auto_now_add=True)


SOCIETIES = [
    {"code": "IPRS", "name": "IPRS", "country": "India", "kind": "Home society", "file": "IPRS work listing (.xlsx)", "available": True},
    {"code": "PRS", "name": "PRS for Music", "country": "UK", "kind": "Foreign society", "file": "PRS 'my works' export (.csv / .xlsx)", "available": True},
    {"code": "ASCAP", "name": "ASCAP", "country": "USA", "kind": "Foreign society", "file": "", "available": False},
    {"code": "BMI", "name": "BMI", "country": "USA", "kind": "Foreign society", "file": "", "available": False},
    {"code": "SOCAN", "name": "SOCAN", "country": "Canada", "kind": "Foreign society", "file": "", "available": False},
    {"code": "GEMA", "name": "GEMA", "country": "Germany", "kind": "Foreign society", "file": "", "available": False},
    {"code": "IMRO", "name": "IMRO", "country": "Ireland", "kind": "Foreign society", "file": "", "available": False},
    {"code": "MLC", "name": "The MLC", "country": "USA (mechanical)", "kind": "Foreign society", "file": "", "available": False},
]
SOCIETY_CODES = {s["code"] for s in SOCIETIES if s["available"]}


class ClientSociety(models.Model):
    """A society this client is reconciled with. Each one has its own workspace and reports."""
    client = models.ForeignKey(Client, related_name="societies", on_delete=models.CASCADE)
    society = models.CharField(max_length=20)
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = [("client", "society")]
        ordering = ["added_at", "id"]


class Run(models.Model):
    """One reporting run for one client: an IPRS report, the master and society exports."""
    name = models.CharField(max_length=200)
    client = models.ForeignKey(Client, related_name="runs", null=True, blank=True, on_delete=models.SET_NULL)
    client_name = models.CharField(max_length=200, blank=True)
    client_ipi = models.CharField(max_length=20, blank=True)
    society = models.CharField(max_length=20, default="IPRS")  # the one society this report checks
    report_date = models.DateField(null=True, blank=True)  # date of the society report this run reconciles
    confirmed_step = models.IntegerField(default=0)         # steps the user has confirmed in the society workspace
    completed_at = models.DateTimeField(null=True, blank=True)
    # Headline numbers saved after each computation so lists and the dashboard load instantly.
    summary = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self):
        return self.name

    def active_file(self, kind):
        return self.files.filter(kind=kind).order_by("-uploaded_at").first()

    def active_files(self):
        """{kind: newest file or None} for every kind, in one query (none if the files were prefetched)."""
        newest = {}
        for f in sorted(self.files.all(), key=lambda f: f.uploaded_at, reverse=True):
            newest.setdefault(f.kind, f)
        return {kind: newest.get(kind) for kind, _ in SourceFile.KINDS}


def upload_path(instance, filename):
    return f"runs/{instance.run_id}/{instance.kind}/{filename}"


class SourceFile(models.Model):
    IPRS, MASTER, PRS = "iprs", "master", "prs"
    KINDS = [(IPRS, "IPRS report"), (MASTER, "MRM master (LNV)"), (PRS, "PRS works export")]

    run = models.ForeignKey(Run, related_name="files", on_delete=models.CASCADE)
    kind = models.CharField(max_length=20, choices=KINDS)
    file = models.FileField(upload_to=upload_path)
    original_name = models.CharField(max_length=255)
    uploaded_at = models.DateTimeField(auto_now_add=True)


class LinkDecision(models.Model):
    """A reviewer's decision on how one IPRS work maps to the master. Kept per client so it carries to later reports."""
    run = models.ForeignKey(Run, related_name="decisions", on_delete=models.CASCADE)
    internal_no = models.CharField(max_length=40)
    master_row = models.IntegerField(null=True, blank=True)
    master_title = models.CharField(max_length=300, blank=True)
    rejected_rows = models.JSONField(default=list, blank=True)
    note = models.TextField(blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("run", "internal_no")]


class Work(models.Model):
    """The golden record for one musical work of one client. Survives across reports."""
    client = models.ForeignKey(Client, related_name="works", on_delete=models.CASCADE)
    mrm_id = models.CharField(max_length=20)                 # W-0001 … stable per client
    title = models.CharField(max_length=300)
    alt_titles = models.JSONField(default=list, blank=True)
    identifiers = models.JSONField(default=dict, blank=True)  # {"IPRS": [...], "PRS": [...], "ISWC": [...], "ISRC": [...]}
    language = models.CharField(max_length=60, blank=True)
    category = models.CharField(max_length=120, blank=True)
    duration = models.CharField(max_length=20, blank=True)
    origin = models.CharField(max_length=10, default="master")  # master / iprs (added from the IPRS report)
    master_row = models.IntegerField(null=True, blank=True)
    credits = models.JSONField(default=list, blank=True)      # golden credits [{name, role, ipi, share, sources}]
    sources = models.JSONField(default=dict, blank=True)      # latest per-source snapshot (iprs works, master row, prs works, match)
    first_run = models.ForeignKey(Run, related_name="+", null=True, on_delete=models.SET_NULL)
    last_run = models.ForeignKey(Run, related_name="+", null=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("client", "mrm_id")]
        ordering = ["title"]


class Registration(models.Model):
    """Where one work stands at one society, as of the latest report."""
    REGISTERED, NOT_REGISTERED, NEEDS_AMEND, DUPLICATE = "registered", "not_registered", "needs_amend", "duplicate"
    LABELS = {REGISTERED: "Registered", NOT_REGISTERED: "Not registered", NEEDS_AMEND: "Needs amendment", DUPLICATE: "Duplicate registrations"}

    @classmethod
    def label(cls, status):
        return cls.LABELS.get(status, status)

    def get_status_label(self):
        return self.label(self.status)

    work = models.ForeignKey(Work, related_name="registrations", on_delete=models.CASCADE)
    society = models.CharField(max_length=20)
    status = models.CharField(max_length=20)
    codes = models.JSONField(default=list, blank=True)
    found_by = models.CharField(max_length=60, blank=True)
    issues = models.JSONField(default=list, blank=True)
    last_run = models.ForeignKey(Run, related_name="+", null=True, on_delete=models.SET_NULL)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("work", "society")]


class Task(models.Model):
    """One follow-up for one work at one society (or in our master), tracked until it is fixed."""
    REGISTER, ADD_CREDIT, CORRECT, MERGE, FIX_MASTER = "register", "add_client_credit", "correct_credits", "merge_duplicates", "fix_master"
    TYPES = [(REGISTER, "Register"), (ADD_CREDIT, "Add client credit"), (CORRECT, "Correct writers / shares"),
             (MERGE, "Merge duplicate registrations"), (FIX_MASTER, "Fix our master")]
    OPEN, IN_PROGRESS, SUBMITTED, VERIFIED, DONE, DISMISSED = "open", "in_progress", "submitted", "verified", "done", "dismissed"
    STATES = [(OPEN, "Open"), (IN_PROGRESS, "In progress"), (SUBMITTED, "Submitted"), (VERIFIED, "Verified in report"),
              (DONE, "Done"), (DISMISSED, "Dismissed")]
    CLOSED = {VERIFIED, DONE, DISMISSED}

    client = models.ForeignKey(Client, related_name="tasks", on_delete=models.CASCADE)
    work = models.ForeignKey(Work, related_name="tasks", on_delete=models.CASCADE)
    society = models.CharField(max_length=20)   # IPRS / PRS / MASTER
    type = models.CharField(max_length=30, choices=TYPES)
    state = models.CharField(max_length=20, choices=STATES, default=OPEN)
    detail = models.JSONField(default=list, blank=True)   # the reasons from the latest report
    owner = models.CharField(max_length=100, blank=True)
    due_date = models.DateField(null=True, blank=True)
    note = models.TextField(blank=True)
    opened_run = models.ForeignKey(Run, related_name="+", null=True, on_delete=models.SET_NULL)
    closed_run = models.ForeignKey(Run, related_name="+", null=True, blank=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("work", "society", "type")]


class TaskEvent(models.Model):
    task = models.ForeignKey(Task, related_name="events", on_delete=models.CASCADE)
    kind = models.CharField(max_length=30)   # created / state / note / owner / due / auto_verified / reopened / updated
    text = models.TextField()
    at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["at", "id"]


class WorkEvent(models.Model):
    """What happened to a work over time: first seen, status changes per society, identifiers added."""
    work = models.ForeignKey(Work, related_name="events", on_delete=models.CASCADE)
    run = models.ForeignKey(Run, related_name="+", null=True, on_delete=models.SET_NULL)
    kind = models.CharField(max_length=30)
    text = models.TextField()
    at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["at", "id"]


class MasterEdit(models.Model):
    """The reviewer's choice for one field of one master song where IPRS and our master disagree (or the master is
    empty): "iprs" writes the IPRS value into the master, "master" keeps ours. Kept per client so it carries to
    later reports; applied when the updated master (LNV) is downloaded."""
    IPRS, MASTER = "iprs", "master"
    FIELDS = ["Title", "Duration", "ISWC", "ISRC", "Authors", "Composers", "Publishers"]

    client = models.ForeignKey(Client, related_name="master_edits", on_delete=models.CASCADE)
    master_row = models.IntegerField()
    field = models.CharField(max_length=20)
    internal_no = models.CharField(max_length=40)  # the IPRS work the value comes from
    choice = models.CharField(max_length=10)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("client", "master_row", "field")]


class SongFlag(models.Model):
    """A reviewer's mark on one song of a client's master, e.g. "Not our work". key = M<master row> or I<IPRS no>."""
    NOT_OUR_WORK = "not_our_work"

    client = models.ForeignKey(Client, related_name="song_flags", on_delete=models.CASCADE)
    key = models.CharField(max_length=40)
    flag = models.CharField(max_length=30, default=NOT_OUR_WORK)
    title = models.CharField(max_length=300, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("client", "key", "flag")]
