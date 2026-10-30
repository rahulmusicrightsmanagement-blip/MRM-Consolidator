"""Steps 1 and 2: read the IPRS three-line work listing, validate its fixed
column format, clean it, and consolidate it into one row per work."""
from collections import Counter, defaultdict

from .normalize import clean_id, clean_text, norm_ipi, norm_isrc, norm_iswc, to_number
from .xlsx import read_rows

# Fixed IPRS column format: key -> accepted header spellings (compared without
# spaces/punctuation). IPRS itself ships the typo "PERORMER".
WORK_COLUMNS = [
    ("internal_no", ["INTERNAL NO"]),
    ("iswc", ["ISWC NO", "ISWC"]),
    ("isrc", ["ISRC"]),
    ("title", ["TITLE"]),
    ("alt_title", ["ALTERNATE TITLE"]),
    ("duration", ["DURATION"]),
    ("language", ["LANGUAGE"]),
    ("category", ["CATEGORY"]),
    ("status", ["STATUS"]),
    ("performer", ["PERFORMER", "PERORMER"]),
    ("production", ["PRODUCTION TITLE"]),
]
CONTRIBUTOR_COLUMNS = [
    ("set_no", ["SET NO."]),
    ("name_type", ["NAME TYPE"]),
    ("role", ["ROLE"]),
    ("name", ["NAME"]),
    ("ipi", ["IPI NO"]),
    ("society", ["SOCIETY"]),
]
SHARE_GROUPS = [("per", ["PER SHARES"]), ("mec", ["MEC SHARES"]), ("sync", ["SYNC SHARES"])]
SHARE_KEYS = [f"{g}_{k}" for g, _ in SHARE_GROUPS for k in ("own", "collect")]
RIGHT_LABELS = {"per": "Performance", "mec": "Mechanical", "sync": "Sync"}

AUTHOR_ROLES = {"A", "CA", "AD", "SA", "TR"}
COMPOSER_ROLES = {"C", "CA", "AR", "SR"}
PUBLISHER_ROLES = {"E", "SE", "AM", "PA", "ES"}


class IPRSFormatError(Exception):
    def __init__(self, checks):
        super().__init__("IPRS file does not match the required format")
        self.checks = checks


def _key(text):
    return "".join(ch for ch in clean_text(text).upper() if ch.isalnum())


def _find_columns(header, wanted):
    found = {}
    keyed = [_key(h) for h in header]
    for field, spellings in wanted:
        targets = {_key(s) for s in spellings}
        for idx, k in enumerate(keyed):
            if k in targets:
                found[field] = idx
                break
    return found


def _read_client(rows, header_idx):
    """Rows above the header hold 'LABEL, ..., value' pairs (INTERNAL NO, NAME, IPI...)."""
    labels = {"INTERNALNO": "internal_no", "NAME": "name", "IPINAMENO": "ipi_name_no", "IPIBASENO": "ipi_base_no"}
    client = {v: "" for v in labels.values()}
    for row in rows[:header_idx]:
        cells = list(row)
        for i, cell in enumerate(cells):
            field = labels.get(_key(cell))
            if not field:
                continue
            value = next((c for c in cells[i + 1:] if c not in (None, "")), "")
            client[field] = clean_id(value)
    client["ipi_name_no"] = norm_ipi(client["ipi_name_no"])
    return client


def parse_iprs(path):
    """Return {client, checks, works, cleanup, issues, stats} or raise IPRSFormatError."""
    rows = read_rows(path)  # every cell: IPRS exports carry a wrong sheet size

    checks = []
    header_idx = next(
        (i for i, r in enumerate(rows[:20]) if {"TITLE", "ISWCNO"} <= {_key(c) for c in r}), None
    )
    checks.append({"label": "Header row found (TITLE, ISWC NO)", "passed": header_idx is not None,
                   "detail": f"Excel row {header_idx + 1}" if header_idx is not None else "No header row in the first 20 rows"})
    if header_idx is None:
        raise IPRSFormatError(checks)

    header, sub_header = rows[header_idx], rows[header_idx + 1] if header_idx + 1 < len(rows) else ()
    cols = _find_columns(header, WORK_COLUMNS + CONTRIBUTOR_COLUMNS)
    missing = [spellings[0] for field, spellings in WORK_COLUMNS + CONTRIBUTOR_COLUMNS if field not in cols]
    checks.append({"label": "All 17 detail columns present", "passed": not missing,
                   "detail": "Missing: " + ", ".join(missing) if missing else "Internal No … Society"})

    share_cols = _find_columns(header, SHARE_GROUPS)
    share_problems = []
    for group, spellings in SHARE_GROUPS:
        if group not in share_cols:
            share_problems.append(f"{spellings[0]} missing")
            continue
        start = share_cols[group]
        own = _key(sub_header[start]) if start < len(sub_header) else ""
        collect = _key(sub_header[start + 1]) if start + 1 < len(sub_header) else ""
        if own != "OWN" or collect != "COLLECT":
            share_problems.append(f"{spellings[0]} needs OWN % / COLLECT % below it")
        cols[f"{group}_own"], cols[f"{group}_collect"] = start, start + 1
    checks.append({"label": "Share columns (PER / MEC / SYNC × OWN % / COLLECT %)", "passed": not share_problems,
                   "detail": "; ".join(share_problems) if share_problems else "6 share columns found"})
    if missing or share_problems:
        raise IPRSFormatError(checks)

    client = _read_client(rows, header_idx)
    checks.append({"label": "Client details (name, IPI name number)", "passed": bool(client["name"]),
                   "detail": f"{client['name']} · IPI {client['ipi_name_no'] or 'not given'}"})

    def cell(row, field):
        idx = cols[field]
        return row[idx] if idx < len(row) else None

    cleanup, works, footer_count = [], [], None
    current = None

    def clean_logged(row_no, column, raw, cleaned, action):
        if raw not in (None, "") and str(raw) != cleaned:
            cleanup.append({"row": row_no, "column": column, "original": str(raw), "cleaned": cleaned, "action": action})
        return cleaned

    for offset, row in enumerate(rows[header_idx + 2:]):
        row_no = header_idx + 3 + offset
        if all(v in (None, "") for v in row):
            continue
        first = clean_text(row[0]) if row else ""
        if first.upper().startswith("NO. OF WORKS") or first.upper().startswith("NO OF WORKS"):
            footer_count = next((int(to_number(v)) for v in row[1:] if to_number(v) is not None), None)
            continue

        internal_raw = cell(row, "internal_no")
        if internal_raw not in (None, ""):
            internal_no = clean_logged(row_no, "INTERNAL NO", internal_raw, clean_id(internal_raw), "Number stored as text")
            work = {"internal_no": internal_no, "source_rows": [row_no], "contributors": []}
            for field, spellings in WORK_COLUMNS[1:]:
                raw = cell(row, field)
                work[field] = clean_logged(row_no, spellings[0], raw, clean_text(raw), "Trimmed spaces")
            work["iswc_valid"] = norm_iswc(work["iswc"])
            work["isrc_valid"] = norm_isrc(work["isrc"])
            works.append(work)
            current = work
        elif current is None:
            continue
        else:
            current["source_rows"].append(row_no)

        name_raw, role = cell(row, "name"), clean_text(cell(row, "role")).upper()
        shares = {k: to_number(cell(row, k)) for k in SHARE_KEYS}
        if name_raw in (None, "") and not role:
            continue
        # A row holding only a name continues the previous name (IPRS wraps long names).
        if not role and all(v is None for v in shares.values()) and current["contributors"]:
            prev = current["contributors"][-1]
            joined = f"{prev['name']} {clean_text(name_raw)}"
            cleanup.append({"row": row_no, "column": "NAME", "original": f"{prev['name']} | {clean_text(name_raw)}",
                            "cleaned": joined, "action": "Joined name wrapped onto next row"})
            prev["name"] = joined
            prev["wrapped_rows"] = prev.get("wrapped_rows", []) + [row_no]
            continue
        name = clean_logged(row_no, "NAME", name_raw, clean_text(name_raw), "Trimmed spaces")
        ipi_raw = cell(row, "ipi")
        current["contributors"].append({
            "source_row": row_no,
            "set_no": clean_id(cell(row, "set_no")),
            "name_type": clean_text(cell(row, "name_type")),
            "role": role,
            "name": name,
            "ipi": norm_ipi(ipi_raw),
            "society": clean_text(cell(row, "society")).upper(),
            **shares,
        })

    issues = _find_issues(works, client, footer_count)
    stats = {
        "works": len(works),
        "contributor_rows": sum(len(w["contributors"]) for w in works),
        "footer_count": footer_count,
        "rows_per_work": dict(sorted(Counter(len(w["contributors"]) for w in works).items())),
        "languages": dict(Counter(w["language"] or "—" for w in works).most_common()),
        "categories": dict(Counter(w["category"] or "—" for w in works).most_common()),
        "client_roles": dict(Counter(
            c["role"] for w in works for c in w["contributors"]
            if client["ipi_name_no"] and c["ipi"] == client["ipi_name_no"]).most_common()),
    }
    checks.append({"label": "Work count matches footer", "passed": footer_count in (None, len(works)),
                   "detail": f"{len(works)} works read · footer says {footer_count if footer_count is not None else 'nothing'}"})
    for w in works:
        w["authors"], w["composers"], w["publishers"], w["others"] = split_roles(w["contributors"])
        w["issue_codes"] = sorted({i["code"] for i in issues if i.get("internal_no") == w["internal_no"]})
    return {"client": client, "checks": checks, "works": works, "cleanup": cleanup, "issues": issues, "stats": stats}


def split_roles(contributors):
    authors, composers, publishers, others = [], [], [], []
    for c in contributors:
        placed = False
        if c["role"] in AUTHOR_ROLES:
            authors.append(c)
            placed = True
        if c["role"] in COMPOSER_ROLES:
            composers.append(c)
            placed = True
        if c["role"] in PUBLISHER_ROLES:
            publishers.append(c)
            placed = True
        if not placed:
            others.append(c)
    return authors, composers, publishers, others


def _issue(work, severity, code, message):
    return {"internal_no": work["internal_no"] if work else "", "title": work["title"] if work else "",
            "severity": severity, "code": code, "message": message}


def _find_issues(works, client, footer_count):
    issues = []
    if footer_count is not None and footer_count != len(works):
        issues.append(_issue(None, "error", "FOOTER_MISMATCH",
                             f"Footer says {footer_count} works but {len(works)} were read"))
    iswc_owners, title_owners = defaultdict(list), defaultdict(list)
    for w in works:
        if not w["title"]:
            issues.append(_issue(w, "error", "MISSING_TITLE", "Work has no title"))
        if not w["contributors"]:
            issues.append(_issue(w, "error", "NO_CONTRIBUTORS", "Work has no contributor rows"))
        if not w["iswc"]:
            issues.append(_issue(w, "warning", "MISSING_ISWC", "No ISWC"))
        elif not w["iswc_valid"]:
            issues.append(_issue(w, "warning", "INVALID_ISWC", f"ISWC '{w['iswc']}' is not in T + 10 digits form"))
        if not w["isrc"]:
            issues.append(_issue(w, "warning", "MISSING_ISRC", "No ISRC"))
        elif not w["isrc_valid"]:
            issues.append(_issue(w, "warning", "INVALID_ISRC", f"ISRC '{w['isrc']}' is not a valid ISRC"))
        if w["iswc_valid"]:
            iswc_owners[w["iswc_valid"]].append(w)
        title_owners[w["title"].upper()].append(w)

        sets = defaultdict(list)
        for c in w["contributors"]:
            sets[c["set_no"]].append(c)
        if len(sets) > 1:
            issues.append(_issue(w, "info", "MULTIPLE_SETS", f"{len(sets)} share sets ({', '.join(sorted(sets))})"))
        for set_no, members in sets.items():
            for right, label in RIGHT_LABELS.items():
                total = round(sum(c[f"{right}_own"] or 0 for c in members), 2)
                if total == 0:
                    issues.append(_issue(w, "info", f"NO_{right.upper()}_SHARE", f"{label} shares total 0% (set {set_no})"))
                elif abs(total - 100) > 0.05:
                    issues.append(_issue(w, "error", "SHARE_TOTAL",
                                         f"{label} shares total {total}% instead of 100% (set {set_no})"))
        for c in w["contributors"]:
            if not c["ipi"]:
                issues.append(_issue(w, "warning", "NO_IPI", f"{c['name']} ({c['role']}) has no IPI number"))
            if c["society"] == "NS":
                issues.append(_issue(w, "info", "NON_MEMBER", f"{c['name']} ({c['role']}) is not a society member (NS)"))
            if c.get("wrapped_rows"):
                issues.append(_issue(w, "info", "NAME_WRAPPED",
                                     f"Name '{c['name']}' was split over rows {c['source_row']}, {', '.join(map(str, c['wrapped_rows']))} and has been joined"))
        if client["ipi_name_no"] and not any(c["ipi"] == client["ipi_name_no"] for c in w["contributors"]):
            issues.append(_issue(w, "warning", "CLIENT_NOT_ON_WORK", f"{client['name']} is not listed on this work"))

    for iswc, owners in iswc_owners.items():
        if len(owners) > 1:
            ids = ", ".join(o["internal_no"] for o in owners)
            for o in owners:
                issues.append(_issue(o, "warning", "DUPLICATE_ISWC", f"ISWC {iswc} is shared by works {ids}"))
    for title, owners in title_owners.items():
        if title and len(owners) > 1:
            ids = ", ".join(o["internal_no"] for o in owners)
            for o in owners:
                issues.append(_issue(o, "info", "DUPLICATE_TITLE", f"Title also used by works {ids}"))
    return issues
