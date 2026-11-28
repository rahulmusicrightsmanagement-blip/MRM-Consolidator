"""Excel outputs for each step. Every builder writes into a workbook so the
full report can reuse them."""
import io
import re

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from . import typed
from .dataclean import VERSION_RE, person_key, phonetic, release_date, same_name, same_people, title_key
from .iprs import SHARE_KEYS
from .master import lnv_link, read_layout
from .xlsx_patch import PatchSheet, compact
from .normalize import clean_text, is_link, isrc_list, isrc_rest, norm_ipi, norm_isrc, norm_title, pipe_isrcs, printable, same_party, show_date

HEADER_FILL = PatternFill("solid", fgColor="1F4E46")
HEADER_FONT = Font(bold=True, color="FFFFFF")
STATUS_FILLS = {
    "Match": PatternFill("solid", fgColor="D9F2E3"), "matched": PatternFill("solid", fgColor="D9F2E3"),
    "Amend": PatternFill("solid", fgColor="FFF1CC"), "differences": PatternFill("solid", fgColor="FFF1CC"),
    "Registration": PatternFill("solid", fgColor="FADBD8"), "unmatched": PatternFill("solid", fgColor="FADBD8"),
    "review": PatternFill("solid", fgColor="DDE7F7"),
    "error": PatternFill("solid", fgColor="FADBD8"), "warning": PatternFill("solid", fgColor="FFF1CC"),
}
ADDED_FILL = PatternFill("solid", fgColor="D9F2E3")
FILLED_FILL = PatternFill("solid", fgColor="FFF1CC")


def _sheet(wb, title, header, rows, status_col=None, widths=None):
    ws = wb.create_sheet(re.sub(r"[\[\]:*?/\\]", "-", title)[:31])  # Excel forbids these characters in sheet names
    ws.append(header)
    for cell in ws[1]:
        cell.fill, cell.font = HEADER_FILL, HEADER_FONT
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for n, row in enumerate(rows, start=2):   # (ws.max_row walks every cell: not asked for each row)
        ws.append(["" if v is None else printable(v) for v in row])
        for c, v in enumerate(row, start=1):   # text stays text: a title that starts with "=" is never a formula
            if isinstance(v, str) and v[:1] == "=":
                ws.cell(n, c).data_type = "s"
        if status_col is not None:
            fill = STATUS_FILLS.get(str(row[status_col]))
            if fill:
                ws.cell(n, status_col + 1).fill = fill
    ws.freeze_panes = "B2"
    if rows:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(header))}{len(rows) + 1}"
    for i, h in enumerate(header, start=1):
        width = (widths or {}).get(h)
        if width is None:
            sample = [len(str(h))] + [len(str(r[i - 1])) for r in rows[:200] if i - 1 < len(r)]
            width = min(max(sample) + 2, 60)
        ws.column_dimensions[get_column_letter(i)].width = width
    return ws


def _new_book():
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    return wb


def _bytes(wb):
    buf = io.BytesIO()
    wb.save(buf)
    return compact(buf.getvalue())


# ---- Step 1 -----------------------------------------------------------------
def add_step1(wb, iprs):
    _sheet(wb, "1 Validation", ["Check", "Result", "Detail"],
           [[c["label"], "Passed" if c["passed"] else "Failed", c["detail"]] for c in iprs["checks"]])
    _sheet(wb, "1 Data issues", ["Internal No", "Title", "Severity", "Issue", "Detail"],
           [[i["internal_no"], i["title"], i["severity"], i["code"], i["message"]] for i in iprs["issues"]], status_col=2)
    _sheet(wb, "1 Cleanup log", ["Excel row", "Column", "Original value", "Cleaned value", "Action"],
           [[c["row"], c["column"], c["original"], c["cleaned"], c["action"]] for c in iprs["cleanup"]])


# ---- Step 2 -----------------------------------------------------------------
def oneline_table(iprs):
    works = iprs["works"]
    counts = {g: max([len(w[g]) for w in works] + [1]) for g in ("authors", "composers", "publishers")}
    header = ["Internal No", "Title", "Alternate Title", "ISWC", "ISRC", "Duration", "Language", "Category", "Status",
              "Performer", "Production Title", "Authors", "Composers", "Publishers"]
    for group, label in (("authors", "Author"), ("composers", "Composer"), ("publishers", "Publisher")):
        for n in range(1, counts[group] + 1):
            header += [f"{label} {n}", f"{label} {n} Role", f"{label} {n} IPI", f"{label} {n} Society", f"{label} {n} PER %"]
    header += ["Issues", "Source rows"]
    rows = []
    for w in works:
        row = [w["internal_no"], w["title"], w["alt_title"], w["iswc"], w["isrc"], w["duration"], w["language"],
               w["category"], w["status"], w["performer"], w["production"],
               len(w["authors"]), len(w["composers"]), len(w["publishers"])]
        for group in ("authors", "composers", "publishers"):
            people = w[group]
            for n in range(counts[group]):
                if n < len(people):
                    c = people[n]
                    row += [c["name"], c["role"], c["ipi"], c["society"], c["per_own"]]
                else:
                    row += ["", "", "", "", ""]
        row += [", ".join(w["issue_codes"]), ", ".join(map(str, w["source_rows"]))]
        rows.append(row)
    return header, rows


def add_step2(wb, iprs):
    header, rows = oneline_table(iprs)
    _sheet(wb, "2 One-line works", header, rows)
    share_labels = ["PER own %", "PER collect %", "MEC own %", "MEC collect %", "SYNC own %", "SYNC collect %"]
    _sheet(wb, "2 Contributors", ["Internal No", "Title", "Excel row", "Set", "Name type", "Role", "Name", "IPI", "Society"] + share_labels,
           [[w["internal_no"], w["title"], c["source_row"], c["set_no"], c["name_type"], c["role"], c["name"], c["ipi"], c["society"]]
            + [c[k] for k in SHARE_KEYS] for w in iprs["works"] for c in w["contributors"]])


# ---- Step 3 -----------------------------------------------------------------
STATE_LABELS = {"linked": "Linked", "review": "Needs review", "unmatched": "Not in master"}


def add_step3(wb, mapping):
    rows = []
    for l in mapping["links"]:
        comp = l.get("comparison") or {}
        diffs = [f"{f['field']}: {f['note'] or (f['iprs'] + ' ≠ ' + f['master'])}" for f in comp.get("fields", [])
                 if f["result"] in ("different", "missing_master")]
        rows.append([l["internal_no"], l["title"], STATE_LABELS[l["state"]], l["method"], l.get("master_row"),
                     l.get("master_title", ""), comp.get("status", l["state"]), "\n".join(diffs) or l["reason"]])
    _sheet(wb, "3 Mapping", ["IPRS Internal No", "IPRS title", "Link", "Linked by", "Master row", "Master title",
                             "Result", "Differences"], rows, status_col=6, widths={"Differences": 80})
    detail = [[l["internal_no"], l["title"], f["field"], f["iprs"], f["master"], f["result"], f["note"]]
              for l in mapping["links"] for f in l.get("comparison", {}).get("fields", [])]
    _sheet(wb, "3 Field comparison", ["IPRS Internal No", "Title", "Field", "IPRS value", "Master value", "Result", "Note"],
           detail, widths={"IPRS value": 50, "Master value": 50, "Note": 60})
    _sheet(wb, "3 Master only", ["Master row", "Title", "IPRS codes in master"],
           [[m["row"], m["title"], ", ".join(m["iprs_codes"])] for m in mapping["master_only"]])


# ---- Step 5 -----------------------------------------------------------------
STATE_NAMES = {"todo": "To do", "in_progress": "In progress", "submitted": "Submitted", "done": "Done", "ignored": "Not needed"}


def add_step5(wb, tunecodes, actions=None):
    actions = actions or {}
    societies = [s for s in ("IPRS", "PRS") if s in tunecodes["summary"]]
    header = ["Title", "Source", "Master row"]
    for s in societies:
        header += [f"{s} tunecode", f"{s} status", f"{s} found by", f"{s} reasons"]
    header += ["Master updates", "Progress"]
    rows = []
    for r in tunecodes["rows"]:
        row = [r["title"], "Added from IPRS" if r["origin"] == "iprs" else "Master", r["master_row"]]
        for s in societies:
            soc = r["societies"][s]
            row += [", ".join(soc["codes"]), soc["status"], soc["method"], "\n".join(soc["reasons"] + soc.get("notes", []))]
        row += ["\n".join(r["master_updates"])]
        targets = [s for s in societies if r["societies"][s]["status"] != "Match"] + (["MASTER"] if r["master_updates"] else [])
        row += ["\n".join(f"{t}: {STATE_NAMES[actions.get(r['key'] + '|' + t, {}).get('state', 'todo')]}" for t in targets)]
        rows.append(row)
    ws = _sheet(wb, "5 Tunecodes", header, rows, widths={f"{s} reasons": 60 for s in societies} | {"Master updates": 60})
    for i, s in enumerate(societies):
        col = 3 + i * 4 + 2
        for n in range(len(rows)):
            fill = STATUS_FILLS.get(rows[n][col - 1])
            if fill:
                ws.cell(n + 2, col).fill = fill
    if tunecodes.get("prs_not_in_report"):
        _sheet(wb, "5 PRS not in report", ["PRS tunecode", "Title", "Writers"],
               [[w["code"], w["title"], ", ".join(w["writers"])] for w in tunecodes["prs_not_in_report"]])


# ---- Step 4: final report in the master's own format -----------------------------
def _put(ws, row, col, value, fill):
    if col is None or value in (None, ""):
        return
    cell = ws.cell(row, col + 1)
    cell.value = printable(value)
    cell.fill = fill


def _write_iprs_work(ws, layout, row, w, sn, fill, status):
    """Write one IPRS work as a new row in the master's own (LNV) column layout."""
    fields, slots = layout["fields"], layout["slots"]
    category = [p.strip() for p in w["category"].split("/")]
    values = {"sn": sn, "title": w["title"], "isrc": w["isrc"], "iswc": w["iswc"], "alt_title": w["alt_title"],
              "movie": w["production"], "language": w["language"].title(), "duration": w["duration"],
              "sub_category": category[-1] if category else "", "label": ", ".join(p["name"] for p in w["publishers"])}
    for field, value in values.items():
        _put(ws, row, fields.get(field), value, fill)
    for n, singer in enumerate([s.strip() for s in w["performer"].split(",") if s.strip()][:len(slots.get("singers", []))]):
        _put(ws, row, slots["singers"][n]["name"], singer, fill)
        _put(ws, row, slots["singers"][n]["role"], "S", fill)
    for group in ("composers", "authors", "publishers"):
        people = [c for c in w[group] if not (group == "authors" and c["role"] == "CA")]
        for n, c in enumerate(people[:len(slots.get(group, []))]):
            slot = slots[group][n]
            _put(ws, row, slot["name"], c["name"], fill)
            _put(ws, row, slot["cae"], c["ipi"].lstrip("0"), fill)
            _put(ws, row, slot["role"], c["role"], fill)
            _put(ws, row, slot["perf"], c["per_own"], fill)
            _put(ws, row, slot["mech"], c["mec_own"], fill)
    iprs_blocks = [b for b in layout["blocks"] if b["society"] == "IPRS"]
    if iprs_blocks:
        b = iprs_blocks[0]
        _put(ws, row, b["isrc"], w["isrc"], fill)
        _put(ws, row, b["iswc"], w["iswc"], fill)
        _put(ws, row, b["code"], w["internal_no"], fill)
        _put(ws, row, b["fields"].get("client_status"), status, fill)


REPEAT_FILL = PatternFill("solid", fgColor="FBD9C9")
# Data clean fill fields -> the LNV's work field, or its contributor slots
DSP_FIELDS = {"ISRC": "isrc", "Release year": "release_year", "Release date": "release_date", "Duration": "duration", "Label": "label",
              "Movie / album": "movie", "Link": "website"}
DSP_SLOTS = {"Singers": "singers", "Lyricists": "authors", "Composers": "composers"}


def _put_names(ws, layout, row, group, names, fill, ipis=()):
    """Names into a contributor group's empty slots – with the CAE number of each one the IPI / CAE list knows."""
    slots = layout["slots"].get(group, [])
    for n, name in enumerate(names[:len(slots)]):
        _put(ws, row, slots[n]["name"], name, fill)
        if n < len(ipis) and ipis[n]:
            _put(ws, row, slots[n]["cae"], _cae(ipis[n]), fill)
        if group == "singers":
            _put(ws, row, slots[n]["role"], "S", fill)
    return len(names) > len(slots)


def _cae(ipi):
    """An IPI name number as the LNV writes its CAE numbers: a plain number (513185379), no leading zeros."""
    digits = re.sub(r"\D", "", str(ipi or ""))
    return int(digits) if digits else None


# The LNV's contributor groups and the step 2 field each one is
IPI_GROUPS = {"authors": "Lyricist", "composers": "Composer", "singers": "Singer", "publishers": "Publisher"}


def _listed(dsp, names, hints=frozenset()):
    """Names (a DSP song's, going into the LNV) as the IPI / CAE list has them, and their IPIs."""
    index = (dsp or {}).get("ipi")
    if not index or not names:
        return list(names), []
    new, ids, _ = index.names(list(names), (), hints)
    return new, ids


def _ipi_names(ws, layout, dsp):
    """The LNV's own names as the IPI / CAE list has them: a member's pseudonym or another spelling becomes the PA name
    (an LNV name is found by its CAE number first), and a slot with no CAE number gets the member's IPI (yellow). Not
    in a field where the reviewer chose the value – the LNV's own included. Names the list does not know stay."""
    from .normalize import norm_ipi
    index = dsp.get("ipi")
    if not index:
        return []
    kept = {(int(r), f) for r, f in dsp.get("kept", [])}
    groups = {g: layout["slots"].get(g, []) for g in IPI_GROUPS}
    title_col = layout["fields"].get("title")
    changes = []
    for row in range(2, len(ws.rows) + 1):
        cells = ws.rows[row - 1]
        at = lambda c: clean_text(cells[c]) if c < len(cells) else ""
        present = {g: [(sl, at(sl["name"]), norm_ipi(cells[sl["cae"]]) if sl["cae"] < len(cells) and cells[sl["cae"]] not in (None, "") else "")
                       for sl in slots if at(sl["name"])] for g, slots in groups.items()}
        if not any(present.values()):
            continue
        hints = index.hints([c for ps in present.values() for _, _, c in ps if c])
        title = at(title_col) if title_col is not None else ""
        for g, field in IPI_GROUPS.items():
            if (row, field) in kept:
                continue
            for sl, name, cae in present[g]:
                r = index.resolve(name, cae, hints)
                if not r:
                    continue
                renamed, numbered = r["name"] != name, not cae and bool(r["ipi"])
                if renamed:
                    _put(ws, row, sl["name"], r["name"], FILLED_FILL)
                if numbered:
                    _put(ws, row, sl["cae"], _cae(r["ipi"]), FILLED_FILL)
                if renamed or numbered:
                    changes.append([row, title, f"{field} – IPI / CAE list",
                                    (f"{name} → {r['name']}" if renamed else name) + (f" (IPI {r['ipi']} added)" if numbered else "")
                                    + " – the member's name in the IPI / CAE list"])
    return changes


def lnv_update(master_path, fills, adds, repeats, source):
    """The LNV updated from the DSP export only (no IPRS report yet) – see final_report."""
    return final_report(master_path, dsp={"fills": fills, "adds": adds, "repeats": repeats, "source": source})


PICK_FIELDS = {"Title": "title", "Film / album": "movie", "Year": "release_year", "ISRC": "isrc", "Label": "label",
               "Release date": "release_date", "Alternate title": "alt_title", "Link": "website"}
PICK_SLOTS = {"Lyricist": "authors", "Composer": "composers", "Singer": "singers", "Publisher": "publishers"}


# columns of the LNV a few sheets do not have: added after the last one when there is something to write
EXTRA_COLUMNS = {"release_date": "Date Of Release(DD-MM-YYYY)", "alt_title": "Alternate Work", "website": "Website1"}


def _last_column(ws):
    """The sheet's last column with a header (0-based) – one just added counts too."""
    return max([c for c, h in enumerate(ws[1]) if clean_text(h.value)] + [c - 1 for (r, c), v in ws.values.items() if r == 1 and clean_text(v)] + [-1])


def _column(ws, layout, field):
    """The LNV's column of a field – one of EXTRA_COLUMNS is added when the LNV has none (None for any other)."""
    fields = layout["fields"]
    if field not in fields and field in EXTRA_COLUMNS:
        fields[field] = _last_column(ws) + 1
        _put(ws, 1, fields[field], EXTRA_COLUMNS[field], ADDED_FILL)
    return fields.get(field)


SPOTIFY_TRACK = re.compile(r"spotify\.com/(?:[\w-]+/)?track/([A-Za-z0-9]{22})")


def _write_link(ws, layout, row, url, fill):
    """A link in the column the row's link stands in (a Spotify ID gets the track's ID), else in Website1. False when it
    is not a web link."""
    if not is_link(url):
        return False
    fields = layout["fields"]
    at = lambda f: clean_text(ws.cell(row, fields[f] + 1).value) if f in fields else ""
    _, field = lnv_link({f: at(f) for f in ("website", "website2", "spotify_id", "youtube")})
    track = SPOTIFY_TRACK.search(url)
    if track and at("spotify_id"):   # the ID names the old track: it goes with the link
        _put(ws, row, fields["spotify_id"], track.group(1), fill)
    if field != "spotify_id" or not track:
        _put(ws, row, fields[field] if field and field != "spotify_id" else _column(ws, layout, "website"), url, fill)
    return True


def _alternative_names(ws, layout, dsp):
    """The Alternative Work Name of each linked row: the work name of the source that was not kept joins the names the
    column has (yellow). Not where the reviewer chose the value."""
    kept = {(int(r), f) for r, f in dsp.get("kept", [])}
    fields, changes = layout["fields"], []
    for row, names in sorted((dsp.get("alternatives") or {}).items()):
        row = int(row)
        if (row, "Alternate title") in kept:
            continue
        old = clean_text(ws.cell(row, fields["alt_title"] + 1).value) if "alt_title" in fields else ""
        new = [x for x in names if not any(same_name(x, y) for y in re.split(r"[;|]", old))]
        if not new:
            continue
        _put(ws, row, _column(ws, layout, "alt_title"), " | ".join(([old] if old else []) + new), FILLED_FILL)
        changes.append([row, clean_text(ws.cell(row, fields["title"] + 1).value), "Alternative work name",
                        f"{'; '.join(new)} – the work name of the source that was not kept"])
    return changes


def _merge_isrcs(ws, layout, dsp):
    """Every ISRC of a linked song in its ISRC cell – the LNV's and the DSP's – with a pipe between them, each once
    (yellow). A cell that holds other text is left alone; so is a row where the reviewer chose the value."""
    kept = {(int(r), f) for r, f in dsp.get("kept", [])}
    fields, changes = layout["fields"], []
    if "isrc" not in fields:
        return changes
    col = fields["isrc"] + 1
    plan = {int(r): list(v) for r, v in (dsp.get("isrcs") or {}).items()}
    for row in range(2, len(ws.rows) + 1):
        old = clean_text(ws.cell(row, col).value)
        own = isrc_list(old)
        if (row, "ISRC") in kept or (old and isrc_rest(old)):
            continue
        # a row that is not linked only has what it holds written one way: no ISRC twice, a pipe between two
        want = list(dict.fromkeys(own + plan.get(row, [])))
        if not own or (want == own and (norm_isrc(old) == own[0] if len(own) == 1 else old == pipe_isrcs(own))):
            continue   # blank cells are filled with the other blanks (fills)
        _put(ws, row, fields["isrc"], pipe_isrcs(want), FILLED_FILL)
        added = [i for i in want if i not in own]
        changes.append([row, clean_text(ws.cell(row, fields["title"] + 1).value) if "title" in fields else "", "ISRCs merged",
                        f"{pipe_isrcs(want)} – " + (f"{', '.join(added)} added from {dsp['source']}" if added else "the same ISRCs, each once")])
    return changes


def _replace_names(ws, layout, row, group, names, fill, ipis=None):
    """The names of one contributor group replaced: a slot keeps its IPI only while it holds the same person; slots
    left over are emptied. ipis (names from the IPI / CAE list): each slot gets its name's IPI as its CAE number."""
    from .dataclean import person_key
    slots = layout["slots"].get(group, [])
    for n, slot in enumerate(slots):
        old = clean_text(ws.cell(row, slot["name"] + 1).value)
        new = names[n] if n < len(names) else ""
        ipi = (ipis[n] if ipis and n < len(ipis) else "") or ""
        if person_key(old) == person_key(new) and (ipis is None or old == new):
            if ipi and not clean_text(ws.cell(row, slot["cae"] + 1).value):
                ws.cell(row, slot["cae"] + 1).value = _cae(ipi)
                ws.cell(row, slot["cae"] + 1).fill = fill
            continue
        cell = ws.cell(row, slot["name"] + 1)
        cell.value = new or None
        cell.fill = fill
        for k in ("cae", "joshua"):
            ws.cell(row, slot[k] + 1).value = None
        if ipi:
            ws.cell(row, slot["cae"] + 1).value = _cae(ipi)
            ws.cell(row, slot["cae"] + 1).fill = fill
        if group == "singers":
            ws.cell(row, slot["role"] + 1).value = "S" if new else None
    return len(names) > len(slots)


def _picks(ws, layout, dsp):
    """Values the reviewer took from the DSP over the LNV's own, where the two differ (yellow)."""
    fields, changes = layout["fields"], []
    title_of = lambda row: clean_text(ws.cell(row, fields["title"] + 1).value) if "title" in fields else ""
    for p in dsp.get("picks", []):
        row, field, value = p["row"], p["field"], p["value"]
        values = [v for v in (value if isinstance(value, list) else [value]) if v]
        if not values:
            continue
        if field in PICK_SLOTS:
            slots = layout["slots"].get(PICK_SLOTS[field], [])
            old = ", ".join(x for x in (clean_text(ws.cell(row, sl["name"] + 1).value) for sl in slots) if x)
            title = title_of(row)
            ipis = p.get("ipis") if "ipis" in p else None
            if ipis is None and p.get("choice") in ("muso", "custom") and (dsp.get("ipi") or None):
                # Muso and the LNV write stage names (PP): the LNV gets the member's real name (PA) from the IPI / CAE list
                listed, found = _listed(dsp, [str(v) for v in values], _row_hints(ws, layout, row, dsp))
                if listed != [str(v) for v in values] or any(found):
                    values, ipis = listed, found
            more = _replace_names(ws, layout, row, PICK_SLOTS[field], values, FILLED_FILL, ipis)
            new = ", ".join(values) + (" (not all fit the LNV's slots)" if more else "")
        elif field == "Link":
            title = title_of(row)
            old = next((clean_text(ws.cell(row, fields[f] + 1).value) for f in ("website", "website2", "spotify_id", "youtube")
                        if f in fields and clean_text(ws.cell(row, fields[f] + 1).value)), "")
            new = str(values[0]).strip()
            if not _write_link(ws, layout, row, new, FILLED_FILL):
                continue
        else:
            col = _column(ws, layout, PICK_FIELDS.get(field))
            if col is None:
                continue
            title = title_of(row)
            old = clean_text(ws.cell(row, col + 1).value)
            new = str(values[0])[:4] if field == "Year" else show_date(values[0]) if field == "Release date" \
                else (pipe_isrcs(isrc_list(values)) or " | ".join(str(v) for v in values)) if field == "ISRC" else values[0]
            cell = ws.cell(row, col + 1)
            cell.value, cell.fill = new, FILLED_FILL
        changes.append([row, title, f"{field} changed", f"{old or '(blank)'} → {new} – " + (p.get("why") or f"the {dsp['source']} value, chosen by the reviewer")])
    return changes


def _dsp_changes(ws, layout, dsp):
    """Step 1's answers on the LNV's own rows: blank fields the DSP fills (yellow – never over a value the LNV, or
    IPRS just now, has), and rows entered twice marked (orange – never deleted)."""
    # the LNV's names as the IPI / CAE list has them first: a value the reviewer chose (picks) is written over them
    fields, changes = layout["fields"], _ipi_names(ws, layout, dsp)
    changes += _alternative_names(ws, layout, dsp)   # before the titles chosen are written: they name the LNV's own
    changes += _merge_isrcs(ws, layout, dsp)
    changes += _picks(ws, layout, dsp)
    title_of = lambda row: clean_text(ws.cell(row, fields["title"] + 1).value) if "title" in fields else ""
    for f in dsp.get("fills", []):
        row, field, value = f["row"], f["field"], f["value"]
        if field in DSP_SLOTS:
            slots = layout["slots"].get(DSP_SLOTS[field], [])
            if any(clean_text(ws.cell(row, sl["name"] + 1).value) for sl in slots):
                continue
            names, ipis = _listed(dsp, [v.strip() for v in value.split(",") if v.strip()], _row_hints(ws, layout, row, dsp))
            if names != [v.strip() for v in value.split(",") if v.strip()]:
                value = ", ".join(names) + f" (the IPI / CAE list's names for {value})"
            if _put_names(ws, layout, row, DSP_SLOTS[field], names, FILLED_FILL, ipis):
                value += " (not all fit the LNV's slots)"
        else:
            col = _column(ws, layout, DSP_FIELDS.get(field))
            if col is None or clean_text(ws.cell(row, col + 1).value):
                continue
            if field == "Link" and not is_link(value):
                continue
            _put(ws, row, col, value, FILLED_FILL)
        changes.append([row, title_of(row), f"{field} filled", f"{value} – from {dsp['source']}"])
    for r in dsp.get("repeats", []):
        if "title" in fields:
            ws.cell(r["row"], fields["title"] + 1).fill = REPEAT_FILL
        changes.append([r["row"], title_of(r["row"]), "Entered twice", f"The same song as row {r['keep']}, which is kept – check and remove"])
    return changes


def _row_hints(ws, layout, row, dsp):
    """The IPI / CAE list's members an LNV row names by CAE number: they decide a name two members share."""
    from .normalize import norm_ipi
    index = (dsp or {}).get("ipi")
    if not index:
        return frozenset()
    return index.hints([norm_ipi(ws.cell(row, sl["cae"] + 1).value) for g in IPI_GROUPS for sl in layout["slots"].get(g, [])
                        if ws.cell(row, sl["cae"] + 1).value not in (None, "")])


def _write_dsp_song(ws, layout, row, song, sn, extra=None, dsp=None):
    """One DSP song (or one version of it) as a new LNV row – its names as the IPI / CAE list has them."""
    fields = layout["fields"]
    year = (song.get("year") or "")[:4]
    values = {"sn": sn, "title": song["title"], "isrc": pipe_isrcs(song.get("isrcs") or []), "movie": song.get("album", ""),
              "release_year": year, "release_date": release_date(song.get("dates") or [], year),
              "duration": song.get("duration", ""), "label": song.get("label", ""), "alt_title": " | ".join(song.get("alt") or []),
              "website": song.get("link", "") if is_link(song.get("link")) else "", **(extra or {})}
    for field, value in values.items():
        _put(ws, row, _column(ws, layout, field) if value else fields.get(field), value, ADDED_FILL)
    for group, key in (("authors", "lyricists"), ("composers", "composers"), ("singers", "singers")):
        names, ipis = _listed(dsp, song.get(key, []))
        _put_names(ws, layout, row, group, names, ADDED_FILL, ipis)


ORIGINAL_COLUMNS = {"original_work": "Original Work", "original_movie": "Original Movie / Album"}


def _original_columns(ws, layout):
    """The columns naming a version's original work: the LNV's own, else two new ones after its last column."""
    fields = layout["fields"]
    last = _last_column(ws)
    for field, header in ORIGINAL_COLUMNS.items():
        if field not in fields:
            last += 1
            fields[field] = last
            _put(ws, 1, last, header, ADDED_FILL)


REMARK_COLUMN = "Remark"


def _remark_column(ws, why, uploaded):
    """The LNV's last column: why a song was mapped, in the dropdown's own words. An LNV that has it already (an earlier
    download, uploaded again) keeps it where it is – with the remarks of now."""
    head = {c: clean_text(v.value) for c, v in enumerate(ws[1], start=1)}
    head.update({c: clean_text(v) for (r, c), v in ws.values.items() if r == 1})
    col = next((c for c, h in sorted(head.items()) if h == REMARK_COLUMN), None) or max([c for c, h in head.items() if h] + [0]) + 1
    _put(ws, 1, col - 1, REMARK_COLUMN, ADDED_FILL)
    for r, ns in why.items():
        if ns:
            _put(ws, r, col - 1, "; ".join(ns), ADDED_FILL if r > uploaded else FILLED_FILL)


def _version_of(v):
    o = v["original"]
    return f"{v['type']} of '{o['title']}'" + (f" (row {o['row']})" if o.get("row") else "")


def _same_new_version(v, work):
    """A version to add and an IPRS-only work to add that are one recording: an ISRC, or the whole title (version
    tag and all) and the writers."""
    if work.get("isrc_valid") and work["isrc_valid"] in v["isrcs"]:
        return True
    return phonetic(v["title"]) == phonetic(work["title"]) and _same_new_song(v, work)


def _same_new_song(song, work):
    """A DSP song to add and an IPRS-only work to add that are one song: same title, and the same writers or ISRC."""
    if title_key(song["title"]) != title_key(work["title"]):
        return False
    if work.get("isrc_valid") and work["isrc_valid"] in (song.get("isrcs") or []):
        return True
    a = {person_key(n) for n in song.get("lyricists", []) + song.get("composers", [])} - {""}
    b = {person_key(p["name"]) for p in work.get("authors", []) + work.get("composers", [])} - {""}
    return bool(a and b) and same_people(a, b)


def _keep_rows(ws, keep):
    """Only the header and these rows stay, one below another – in one pass (delete_rows moves every cell below it each
    time: minutes on a large LNV). Each cell keeps its format and link, each row its height."""
    new = {old: n for n, old in enumerate([1, *sorted(r for r in keep if r > 1)], start=1)}
    cells = {}
    for (r, c), cell in ws._cells.items():
        if r in new:
            cell.row = new[r]
            cells[(new[r], c)] = cell
    ws._cells = cells
    for cell in cells.values():   # a link names its cell: it moves with it, and those of the rows left out go
        if cell.hyperlink:
            cell.hyperlink.ref = cell.coordinate
    ws._hyperlinks = [c.hyperlink for c in cells.values() if c.hyperlink]
    heights = {new[r]: d for r, d in ws.row_dimensions.items() if r in new}
    for r in list(ws.row_dimensions):
        del ws.row_dimensions[r]
    for r, d in heights.items():
        d.index = r
        ws.row_dimensions[r] = d


def lnv_action_report(master_path, iprs, final, tunecodes, society, status):
    """Our master (LNV format) cut down to the songs that need this action at this society.

    status "Amend"        → songs registered at the society whose registration differs from ours;
    status "Registration" → songs with no tune code at the society.
    The society's block gets Client status = Amendment / Registration and, for amendments, the reasons in
    "Purpose of amendment" (highlighted yellow). A sheet "Why" lists each song and its reasons.
    """
    wb = openpyxl.load_workbook(master_path)
    ws = wb.worksheets[0]
    layout = read_layout([c.value for c in ws[1]])
    blocks = [b for b in layout["blocks"] if b["society"] == society]
    works = {w["internal_no"]: w for w in (iprs or {}).get("works", [])}
    finals = {r["key"]: r for r in final["rows"]}
    label = "Amendment" if status == "Amend" else "Registration"
    picked = [r for r in tunecodes["rows"] if r["societies"].get(society, {}).get("status") == status]

    keep, notes = set(), []
    last = max([s for s in range(1, ws.max_row + 1) if any(ws.cell(s, c).value not in (None, "") for c in (1, 2))] + [1])
    for r in picked:
        res = r["societies"][society]
        if r["master_row"]:
            row = r["master_row"]
        else:  # a song the master does not have yet (added from the IPRS report)
            last += 1
            row = last
            ids = finals[r["key"]]["iprs_works"]
            if ids and ids[0] in works:
                _write_iprs_work(ws, layout, row, works[ids[0]], "", ADDED_FILL, "Added from IPRS report")
        keep.add(row)
        block = next((b for b in blocks if str(ws.cell(row, b["code"] + 1).value or "") in res["codes"]), None) \
            or next((b for b in blocks if ws.cell(row, b["code"] + 1).value in (None, "")), None) or (blocks[0] if blocks else None)
        if block:
            _put(ws, row, block["fields"].get("client_status"), label, FILLED_FILL)
            if status == "Amend":
                _put(ws, row, block["fields"].get("amendment_purpose"), "; ".join(res["reasons"]), FILLED_FILL)
        notes.append([r["title"], ", ".join(res["codes"]) or "—", label, "\n".join(res["reasons"])])

    _keep_rows(ws, keep)
    sn_col = layout["fields"].get("sn")
    if sn_col is not None:
        for n in range(2, ws.max_row + 1):
            ws.cell(n, sn_col + 1).value = n - 1

    for name in ("MRM changes", "Why"):
        if name in wb.sheetnames:
            del wb[name]
    why = wb.create_sheet("Why")
    why.append(["Title", f"{society} tune code", "Action", "Reason"])
    for cell in why[1]:
        cell.fill, cell.font = HEADER_FILL, HEADER_FONT
    for r, n in enumerate(notes, start=2):
        why.append([printable(v) for v in n])
        for c, v in enumerate(n, start=1):
            if isinstance(v, str) and v[:1] == "=":
                why.cell(r, c).data_type = "s"
    for col, width in zip("ABCD", (45, 22, 16, 90)):
        why.column_dimensions[col].width = width
    return _bytes(wb)


GROUP_OF = {"Authors": "authors", "Composers": "composers", "Publishers": "publishers"}
SLOT_COLS = ("name", "cae", "joshua", "role", "perf", "mech")


def _master_people(ws, slots, row):
    return [{"name": clean_text(ws.cell(row, s["name"] + 1).value), "ipi": norm_ipi(ws.cell(row, s["cae"] + 1).value)}
            for s in slots if clean_text(ws.cell(row, s["name"] + 1).value)]


def apply_master_edits(ws, layout, edits, works):
    """Write the IPRS value into the master for every field the reviewer chose "IPRS" (or "Add to master") for.
    Returns change-log rows."""
    fields, slots = layout["fields"], layout["slots"]
    changes = []
    chosen = {}
    for e in edits:
        if e["choice"] == "iprs" and e["internal_no"] in works:
            chosen.setdefault(e["master_row"], {})[e["field"]] = works[e["internal_no"]]
    for row, picks in chosen.items():
        for field, w in picks.items():
            detail = f"From IPRS work {w['internal_no']}"
            if field == "Alternate title":
                # The IPRS title joins the master's "Alternate Work" names, so the next report matches by itself.
                old = clean_text(ws.cell(row, fields["alt_title"] + 1).value) if "alt_title" in fields else ""
                value = w["title"] if not old else old if norm_title(w["title"]) in {norm_title(t) for t in old.split(";")} \
                    else f"{old}; {w['title']}"
                _put(ws, row, fields.get("alt_title"), value, FILLED_FILL)
            elif field in ("Language", "Film / album"):
                value = w["language"] if field == "Language" else w["production"]
                _put(ws, row, fields.get("language" if field == "Language" else "movie"), value, FILLED_FILL)
            elif field == "Singers":
                names = [n.strip() for n in re.split(r"[,;]", w["performer"] or "") if n.strip()]
                group_slots = slots.get("singers", [])
                for slot in group_slots:
                    ws.cell(row, slot["name"] + 1).value = None
                for n, name in enumerate(names[:len(group_slots)]):
                    _put(ws, row, group_slots[n]["name"], name, FILLED_FILL)
                value = "; ".join(names)
                if len(names) > len(group_slots):
                    detail += f" (only {len(group_slots)} of {len(names)} fit the master's slots)"
            elif field in ("Title", "Duration"):
                value = w["title"] if field == "Title" else w["duration"]
                _put(ws, row, fields.get(field.lower()), value, FILLED_FILL)
            elif field in ("ISWC", "ISRC"):
                key = field.lower()
                value = w[f"{key}_valid"] or w[key]
                held = isrc_list(ws.cell(row, fields["isrc"] + 1).value) if key == "isrc" and "isrc" in fields else []
                # a cell with several ISRCs keeps them: IPRS's comes first
                _put(ws, row, fields.get(key), pipe_isrcs([value, *held]) if len(held) > 1 else value, FILLED_FILL)
                for b in layout["blocks"]:  # the IPRS block that carries this work's tune code
                    if b["society"] == "IPRS" and str(ws.cell(row, b["code"] + 1).value or "").strip() == w["internal_no"]:
                        _put(ws, row, b[key], value, FILLED_FILL)
            else:
                group = GROUP_OF[field]
                people = list(w[group])
                if group == "authors":
                    # A composer/author (CA) sits in the composer slots; list them as author only if the composers
                    # the master will end up with do not already hold them.
                    composers = w["composers"] if "Composers" in picks else _master_people(ws, slots.get("composers", []), row)
                    people = [c for c in people if c["role"] != "CA"
                              or not any(same_party(c["name"], p["name"], c["ipi"], p["ipi"]) for p in composers)]
                group_slots = slots.get(group, [])
                for slot in group_slots:
                    for col in SLOT_COLS:
                        ws.cell(row, slot[col] + 1).value = None
                for n, c in enumerate(people[:len(group_slots)]):
                    slot = group_slots[n]
                    _put(ws, row, slot["name"], c["name"], FILLED_FILL)
                    _put(ws, row, slot["cae"], c["ipi"].lstrip("0"), FILLED_FILL)
                    _put(ws, row, slot["role"], c["role"], FILLED_FILL)
                    _put(ws, row, slot["perf"], c["per_own"], FILLED_FILL)
                    _put(ws, row, slot["mech"], c["mec_own"], FILLED_FILL)
                value = "; ".join(c["name"] for c in people)
                if len(people) > len(group_slots):
                    detail += f" (only {len(group_slots)} of {len(people)} fit the master's slots)"
            title = clean_text(ws.cell(row, fields["title"] + 1).value) if "title" in fields else ""
            changes.append([row, title, f"{field} from IPRS", f"{value} – {detail}"])
    return changes


def _write_fill_row(ws, iprs_blocks, row, f):
    """Write one song's planned IPRS blocks (or its 'Not registered' / 'Not our work' status) into a master row."""
    changes = []
    for b in f["blocks"]:
        block = iprs_blocks[b["slot"] - 1] if b["slot"] <= len(iprs_blocks) else None
        if block is None or b.get("round") == "kept":  # an earlier amendment round stays exactly as it was
            continue
        _put(ws, row, block["isrc"], b["isrc"], FILLED_FILL)
        _put(ws, row, block["iswc"], b["iswc"], FILLED_FILL)
        _put(ws, row, block["code"], b["internal_no"], FILLED_FILL)
        _put(ws, row, block["fields"].get("client_status"), b["client_status"], FILLED_FILL)
        _put(ws, row, block["fields"].get("general_status"), b["general_status"], FILLED_FILL)
        _put(ws, row, block["fields"].get("amendment_purpose"), b["purpose"], FILLED_FILL)
        changes.append([row, f["title"], f"IPRS block {b['slot']}",
                        f"{b['internal_no']} · Client: {b['client_status']} · General: {b['general_status']}"
                        + (f" · {b['purpose']}" if b["purpose"] else "")])
    slot = f.get("status_slot")
    if not f["blocks"] and f["state"] in ("not_registered", "not_our_work") and slot and slot <= len(iprs_blocks):
        block = iprs_blocks[slot - 1]  # the first empty block – a block with anything in it is never written
        text = "Not our work" if f["state"] == "not_our_work" else "Not registered"
        _put(ws, row, block["fields"].get("client_status"), text, FILLED_FILL)
        _put(ws, row, block["fields"].get("general_status"), text, FILLED_FILL)
        changes.append([row, f["title"], f"IPRS block {slot}", text])
    for code in f["overflow"]:
        changes.append([row, f["title"], "Not filled", f"IPRS work {code}: all {len(iprs_blocks)} IPRS blocks are used"])
    return changes


def final_report(master_path, iprs=None, final=None, edits=(), fill=None, dsp=None, arrange=None, order="song", log_name="MRM changes"):
    """The final LNV: the client's own LNV file with everything applied – the IPRS columns filled from the IPRS
    report and the values the reviewer chose to take from IPRS (yellow), step 1's answers from the DSP export (blank
    fields filled, yellow; repeats marked, orange), and the songs the LNV was missing appended (green): the DSP's new
    songs and the IPRS-only works, a song that is both added once. A DSP song's versions the LNV lacks (remix, lofi …)
    get rows of their own (VERSION "MOD") naming their original in two columns, Original Work and Original Movie /
    Album, added after the LNV's last column. Every change is listed in "MRM changes".
    arrange (review.families, the step 2 download): the rows in alphabetical order, each song's rows together under its
    main version, with three columns more – the main version's row, its title, and the row in the uploaded LNV;
    order "album": A–Z by album first. log_name: the change list's sheet (a stage 2 LNV keeps step 2's own list)."""
    ws = PatchSheet(master_path)   # only the changed cells are written: a whole LNV takes openpyxl about a minute
    layout = read_layout([c.value for c in ws[1]])
    iprs_blocks = [b for b in layout["blocks"] if b["society"] == "IPRS"]
    works = {w["internal_no"]: w for w in (iprs or {}).get("works", [])}
    plan = {f["key"]: f for f in (fill or {}).get("rows", [])}
    changes = []

    for r in (final or {}).get("rows", []):
        if r["origin"] == "master" and r["key"] in plan:
            changes += _write_fill_row(ws, iprs_blocks, r["master_row"], plan[r["key"]])
    changes += apply_master_edits(ws, layout, edits, works)
    if dsp:
        changes += _dsp_changes(ws, layout, dsp)

    last = max([s for s in range(1, ws.max_row + 1) if any(ws.cell(s, c).value not in (None, "") for c in (1, 2))] + [1])
    uploaded = last   # the uploaded LNV's last row: the rows after it are new
    sn = last - 1
    added_works = [works[r["iprs_works"][0]] for r in (final or {}).get("added", [])]
    iprs_rows = {}
    for r in (final or {}).get("added", []):
        w = works[r["iprs_works"][0]]
        last += 1
        sn += 1
        iprs_rows[w["internal_no"]] = last
        _write_iprs_work(ws, layout, last, w, sn, ADDED_FILL, "")
        changes.append([last, w["title"], "Added song", f"Missing from master; IPRS work {w['internal_no']}"])
        if r["key"] in plan:
            changes += _write_fill_row(ws, iprs_blocks, last, plan[r["key"]])
    added = {}   # song key -> its new row, for the versions naming it
    answered = {}   # new rows of songs the reviewer answered themselves: the "Checked as" column
    why = {int(r): list(ns) for r, ns in ((dsp or {}).get("remarks") or {}).items()}   # row -> its remarks

    def remark(row, names):
        for x in names or ():
            if x not in why.setdefault(row, []):
                why[row].append(x)
    versions = (dsp or {}).get("versions") or {}
    if versions.get("rows") or versions.get("named") or any(s.get("origin") for s in (dsp or {}).get("adds", [])) \
            or any(t.get("original") for t in (dsp or {}).get("typed", [])):
        _original_columns(ws, layout)
    for song in (dsp or {}).get("adds", []):
        if "original" in song:   # the song's row holds its original only; each version gets a row of its own below
            if not song["original"]:
                continue
            song = {**song, **song["original"]}
        twin = next((w for w in added_works if _same_new_song(song, w)), None)
        if twin:
            added[song["key"]] = iprs_rows[twin["internal_no"]]
            remark(added[song["key"]], song.get("remark"))
            changes.append([None, song["title"], "Not added twice", f"Also new from {dsp['source']}; added once, from IPRS work {twin['internal_no']}"])
            continue
        last += 1
        sn += 1
        added[song["key"]] = last
        if (song.get("decision") or {}).get("choice") == "add" and not (song.get("decision") or {}).get("auto"):
            answered[last] = "New row"
        remark(last, song.get("remark"))
        g = song.get("origin")
        _write_dsp_song(ws, layout, last, song, sn,
                        {"version": "MOD", "original_work": g["title"], "original_movie": g["album"], "language": g.get("language", "")} if g
                        else {"version": "ORI"} if "original" in song else None, dsp=dsp)
        changes.append([last, song["title"], "Added recording" if g else "Added song",
                        (f"A new recording of '{g['title']}' (row {g['row']}); " if g else "Not in the LNV; ") + f"from {dsp['source']}"
                        + (f" (ISRC {song['isrcs'][0]})" if song.get("isrcs") else "")])

    fields = layout["fields"]
    for v in versions.get("named", []):
        o = v["original"]
        if not any(clean_text(ws.cell(v["row"], fields[f] + 1).value) for f in ORIGINAL_COLUMNS):
            _put(ws, v["row"], fields["original_work"], o["title"], FILLED_FILL)
            _put(ws, v["row"], fields["original_movie"], o["album"], FILLED_FILL)
            changes.append([v["row"], clean_text(ws.cell(v["row"], fields["title"] + 1).value), "Original named", _version_of(v)])
    for v in versions.get("rows", []):
        o = v["original"]
        twin = next((w for w in added_works if _same_new_version(v, w)), None)
        if twin:
            remark(iprs_rows[twin["internal_no"]], v.get("remark"))
            changes.append([None, v["title"], "Not added twice", f"Also new from {dsp['source']}; added once, from IPRS work {twin['internal_no']}"])
            continue
        last += 1
        sn += 1
        remark(last, v.get("remark"))
        if o.get("add"):
            o = {**o, "row": added.get(o["add"])}
        _write_dsp_song(ws, layout, last, v, sn, {"version": "MOD", "language": o.get("language", ""),
                                                  "original_work": o["title"], "original_movie": o["album"]}, dsp=dsp)
        changes.append([last, v["title"], "Added version", f"{_version_of({**v, 'original': o})}; not in the LNV; from {dsp['source']}"
                        + (f" (ISRC {v['isrcs'][0]})" if v.get("isrcs") else "")])

    header = [c.value for c in ws[1]]
    for t in (dsp or {}).get("typed", []):
        last += 1
        sn += 1
        o = t.get("original")
        if o and o.get("add"):
            o = {**o, "row": added.get(o["add"])}
        typed.write(ws, layout, header, last, sn, t["data"], o, _put, ADDED_FILL, _cae)
        answered[last] = "Typed by you"
        changes.append([last, t["data"]["title"], "Added song (typed)", "Typed by the reviewer" + (f", added to '{o['title']}'" + (f" (row {o['row']})" if o.get("row") else "") if o else "")
                        + f" (ISRC {t['data']['isrc']})"])
        if arrange is not None and t.get("family"):
            arrange = {**arrange, "rows": {**(arrange.get("rows") or {}), last: t["family"]}}

    for r, ns in sorted(why.items()):
        if ns:
            changes.append([r, clean_text(ws.cell(r, layout["fields"]["title"] + 1).value), "Remark", "; ".join(ns)])
    # Original is one row (step 2, v2.0: the matches the reviewer put in Original): its other rows are merged into the
    # first one put there – their titles are its Alternative Work Name, their ISRCs in its ISRC cell – and left out
    merged = {}
    for keep, drop in sorted(((dsp or {}).get("merge") or {}).items()):
        for r in drop:
            if 2 <= int(r) <= uploaded and int(r) != int(keep) and int(r) not in merged:
                merged[int(r)] = int(keep)
    # the LNV rows the reviewer deleted in step 2 (v2.0): out of the file
    deleted = {int(r) for r in (dsp or {}).get("delete") or () if 2 <= int(r) <= uploaded and int(r) not in merged}
    if deleted:
        title_of = lambda r: clean_text(ws.cell(r, layout["fields"]["title"] + 1).value) if "title" in layout["fields"] else ""
        changes = [c for c in changes if c[0] not in deleted]
        changes += [[None, title_of(r), "Deleted", f"Row {r} '{title_of(r)}' deleted in step 2 – left out of the file"] for r in sorted(deleted)]
        ws.drop = set(ws.drop) | deleted
        if arrange is None and not merged:
            ws.order = [r for r in range(2, last + 1) if r not in deleted]
    if merged:
        title_of = lambda r: clean_text(ws.cell(r, layout["fields"]["title"] + 1).value) if "title" in layout["fields"] else ""
        changes = [c for c in changes if c[0] not in merged]
        # the ISRCs of the rows that go (their society blocks too) stay in the file: in the kept row's ISRC cell
        kept_fields = {(int(r), f) for r, f in (dsp or {}).get("kept", [])}
        col = layout["fields"].get("isrc")
        for keep in sorted(set(merged.values())):
            want = list(dict.fromkeys(isrc_list(((dsp or {}).get("isrcs") or {}).get(keep) or ((dsp or {}).get("isrcs") or {}).get(str(keep)) or [])))
            if col is None or not want or (keep, "ISRC") in kept_fields or clean_text(ws.cell(keep, col + 1).value):
                continue
            _put(ws, keep, col, pipe_isrcs(want), FILLED_FILL)
            changes.append([keep, title_of(keep), "ISRCs merged", f"{pipe_isrcs(want)} – every ISRC of the exact match's rows, in one row"])
        for r, keep in sorted(merged.items()):
            changes.append([keep, title_of(keep), "Original – one row", f"Row {r} '{title_of(r)}' merged into this row (put in Original); "
                            "its title is in the Alternative Work Name"])
        ws.drop = set(ws.drop) | set(merged)
        if arrange is None:
            ws.order = [r for r in range(2, last + 1) if r not in merged and r not in deleted]
    if arrange is not None:
        changes = _arrange(ws, layout, last, uploaded, {**arrange, "dropped": set(merged) | deleted, "checked": {**(arrange.get("checked") or {}), **answered}}, changes, by=order)
    if dsp:
        _remark_column(ws, why, uploaded)
    return ws.save(changes, ["LNV row", "Title", "Change", "Detail"], (10, 45, 22, 90), log_name=log_name)


ARRANGE_COLUMNS = ("Main version row", "Main version title", "Row in the uploaded LNV", "Checked as")
_ISRC = re.compile(r"[A-Z]{2}[A-Z0-9]{3}\d{7}")
# letters and digits of any script kept (a Hindi album sorts by its words, after the Latin ones), the rest dropped
_sort_text = lambda t: re.sub(r"\s+", " ", re.sub(r"[\W_]+", " ", (t or "").lower())).strip()


def _arrange(ws, layout, last, uploaded, fam, changes, by="song"):
    """The LNV in alphabetical order with each song's rows together: the songs A–Z by their main version's title,
    the main version's row first, then the song's other rows A–Z. by="album": the albums A–Z (Movie name; rows with
    none at the end), in each album its songs in that order. A song is one song name as step 2 groups it
    (review._family, a name only versions carry joined to the shorter one); its main version is the oldest DSP
    recording with no tag (review.families) – its row found by ISRC, else the row it is linked to – or, when the LNV
    has no row of it, the LNV's own oldest plain row of that name. Three columns after the last: the main version's row
    (in this sorted file), its title, and the row each one had in the uploaded LNV (blank for a new row). The change
    list's row numbers follow the new order."""
    from .review import _family, plainness
    fields = layout["fields"]
    get = lambda r, f: clean_text(ws.cell(r, fields[f] + 1).value) if f in fields else ""
    joins, mains = fam.get("joins") or {}, fam.get("mains") or {}
    moved_rows, moved_isrcs = fam.get("rows") or {}, fam.get("isrcs") or {}
    # step 2's sections: the exact match's row first, then the possible matches, then the other versions (by ISRC for a
    # new row); the rows merged into the exact one are left out
    rank, isrc_rank, keeps, dropped = fam.get("rank") or {}, fam.get("isrc_rank") or {}, fam.get("keep") or {}, fam.get("dropped") or set()
    # the rows the reviewer checked in step 2, with the section: an LNV row by its number, a new row by its ISRC
    checked, isrc_checked = fam.get("checked") or {}, fam.get("isrc_checked") or {}

    def key_of(title):
        k = _family(title) if title else None
        while k in joins:
            k = joins[k]
        return k
    rows = []
    for r in range(2, last + 1):
        if r in dropped:
            continue
        title = get(r, "title")
        isrcs = set(_ISRC.findall(get(r, "isrc").upper()))
        # a song the reviewer added to another sits under that song's name, whatever its title
        key = moved_rows.get(r) or (next((moved_isrcs[i] for i in sorted(isrcs) if i in moved_isrcs), None) if r > uploaded else None)
        while key in joins:
            key = joins[key]
        rows.append({"row": r, "title": title, "key": key or key_of(title), "fixed": bool(key), "isrcs": isrcs,
                     "year": (get(r, "release_year") or "")[:4],
                     "rank": rank.get(r, next((isrc_rank[i] for i in sorted(isrcs) if i in isrc_rank), 3) if r > uploaded else 3)})
    # a name only the LNV's versions carry joins the shorter name it starts with ('Maula Mere Maula Anwar Flip'), as
    # step 2 does for the DSP's
    names = sorted({x["key"] for x in rows if x["key"]}, key=len)
    for k in reversed(names):
        xs = [x for x in rows if x["key"] == k]
        base = next((b for b in reversed(names) if 8 <= len(b) < len(k) and k.startswith(b)), None)
        if base and k not in mains and xs and all(VERSION_RE.search(x["title"]) for x in xs):
            for x in xs:
                x["key"] = x["key"] if x["fixed"] else base
    by_isrc = {}
    for x in rows:
        for i in x["isrcs"]:
            by_isrc.setdefault(i, []).append(x)
    groups = {}
    for x in rows:
        if x["title"]:
            groups.setdefault(x["key"] or "row:" + str(x["row"]), []).append(x)

    main_of = {}
    for k, xs in groups.items():
        m = mains.get(k)
        here = {x["row"] for x in xs}
        found = None
        if m:
            hits = [y for i in m["isrcs"] for y in by_isrc.get(i, [])]
            hits.sort(key=lambda y: (y["row"] not in here, y["row"] not in m["rows"], y["row"]))
            found = hits[0] if hits else next((y for y in rows if y["row"] in m["rows"]), None)
        # the exact match's one row stands for the main version
        kept = next((y for y in xs if keeps.get(y["row"]) == k), None)
        if kept:
            found = kept
        if not found:   # no row of the DSP's main version: the LNV's oldest plain row of the name
            found = min(xs, key=lambda y: (plainness(y["title"]), y["year"] or "9999", y["row"]))
        main_of[k] = found

    def name(k):
        m = main_of[k]
        return _sort_text(m["title"] if m["key"] == k or k.startswith("row:") else min(x["title"] for x in groups[k]))
    order = []
    for k in sorted(groups, key=lambda k: (name(k), k)):
        m = main_of[k]
        order += sorted(groups[k], key=lambda y: (y is not m, y["rank"], _sort_text(y["title"]), y["row"]))
    if by == "album":   # the same order inside each album; the albums A–Z, rows with no album last
        at = {x["row"]: i for i, x in enumerate(order)}
        album = lambda x: _sort_text(get(x["row"], "movie"))
        order.sort(key=lambda x: (not album(x), album(x), at[x["row"]]))
    done_of = lambda x: checked.get(x["row"]) or (None if x["row"] <= uploaded else next((isrc_checked[i] for i in sorted(x["isrcs"]) if i in isrc_checked), None))
    only = bool(fam.get("only_checked"))
    if only:   # the songs checked in step 2 only: every other row is left out of the file
        order = [x for x in order if done_of(x)]
        ws.drop = set(ws.drop) | {x["row"] for x in rows if not done_of(x)}
    else:
        order += [x for x in rows if not x["title"]]   # rows with no title stay together at the end
    new_of = {x["row"]: n for n, x in enumerate(order, start=2)}
    ws.order = [x["row"] for x in order]
    # the serial numbers follow the new order: 1, 2, 3 … (each row's old number is in "Row in the uploaded LNV")
    sn_col = layout["fields"].get("sn")
    if sn_col is not None:
        for n, x in enumerate((x for x in order if x["title"]), start=1):
            ws.cell(x["row"], sn_col + 1).value = n

    # the three columns, after the LNV's last one
    col = _last_column(ws)
    for i, header in enumerate(ARRANGE_COLUMNS, start=1):
        _put(ws, 1, col + i, header, ADDED_FILL)
    for k, xs in groups.items():
        m = main_of[k]
        for x in xs:
            ws.cell(x["row"], col + 2).value = new_of.get(m["row"])   # (blank: its main version is not in this file)
            ws.cell(x["row"], col + 3).value = m["title"]
    for x in rows:
        if x["row"] <= uploaded and x["title"]:
            ws.cell(x["row"], col + 4).value = x["row"]
        done = done_of(x)
        if done:
            ws.cell(x["row"], col + 5).value = done

    renum = lambda text: re.sub(r"\b(rows?) (\d+)", lambda m: f"{m.group(1)} {new_of.get(int(m.group(2)), m.group(2))}", text)
    out = [[new_of.get(c[0], c[0]) if isinstance(c[0], int) else c[0], c[1], c[2], renum(c[3]) if isinstance(c[3], str) else c[3]] for c in changes
           if not isinstance(c[0], int) or c[0] in new_of]   # (a row left out of the file: its changes too)
    if only:
        out.insert(0, [None, "", "Checked songs only", f"The {len(order)} rows of the songs checked in step 2 (Original, Other version, "
                       "a new row, a typed song) – every other row of the LNV is left out. Download 'Every row' for the whole LNV."])
    out.insert(0, [None, "", "Serial numbers", "SN is 1, 2, 3 … in this file's order; the number each row had is in 'Row in the uploaded LNV'."] if sn_col is not None else None)
    out = [c for c in out if c]
    out.insert(0, [None, "", "Sorted A–Z by album" if by == "album" else "Sorted A–Z",
                   ("Rows by album A–Z (rows with no album last); in each album " if by == "album" else "Rows in alphabetical order, ")
                   + "each song's rows together, its main version first (Original is one row), then its other versions. "
                   "'Main version row' and 'Main version title' name each song's main version; 'Checked as' the section a row was checked in "
                   "(Original, Other version); 'Row in the uploaded LNV' is the row "
                   "each one had before. Row numbers in this list are the new ones."])
    return out


def step_workbook(step, result, actions=None):
    wb = _new_book()
    if step == "step1":
        add_step1(wb, result["iprs"])
    elif step == "step2":
        add_step2(wb, result["iprs"])
    elif step == "step3":
        add_step3(wb, result["mapping"])
    elif step == "step5":
        add_step5(wb, result["tunecodes"], actions)
    elif step == "all":
        if result["iprs"]:
            add_step1(wb, result["iprs"])
            add_step2(wb, result["iprs"])
        if result["mapping"]:
            add_step3(wb, result["mapping"])
        if result["tunecodes"]:
            add_step5(wb, result["tunecodes"], actions)
    return _bytes(wb)


# ---- client-level exports ------------------------------------------------------
def tasks_workbook(client, tasks):
    """Every follow-up for one client, ready to work from or send to a society."""
    wb = _new_book()
    rows = [[t["work"]["mrm_id"], t["work"]["title"], t["society"], t["type_label"], ", ".join(t["codes"]), t["state_label"],
             t["owner"], t["due_date"] or "", "\n".join(t["detail"]), t["note"], t["opened_report"] or "", t["closed_report"] or "",
             t["events"][-1]["text"] if t.get("events") else ""] for t in tasks]
    order = {"Open": 0, "In progress": 1, "Submitted": 2, "Verified in report": 3, "Done": 4, "Dismissed": 5}
    rows.sort(key=lambda r: (order.get(r[5], 9), r[2], r[3], r[1]))
    _sheet(wb, "Tasks", ["MRM ID", "Work", "Where", "Task", "Tune codes", "Status", "Owner", "Due", "Why", "Note",
                         "Found in report", "Closed in report", "Last update"], rows,
           widths={"Why": 70, "Note": 40, "Last update": 50})
    by_society = {}
    for t in tasks:
        if t["state"] not in ("verified", "done", "dismissed"):
            by_society.setdefault((t["society"], t["type_label"]), []).append(t)
    for (society, label), items in sorted(by_society.items()):
        _sheet(wb, f"{society} {label}"[:31], ["MRM ID", "Work", "Tune codes", "Why"],
               [[t["work"]["mrm_id"], t["work"]["title"], ", ".join(t["codes"]), "\n".join(t["detail"])] for t in items],
               widths={"Why": 80})
    return _bytes(wb)


def catalogue_workbook(client, works):
    """Works × society status matrix."""
    wb = _new_book()
    societies = sorted({s for w in works for s in w["registrations"]})
    header = ["MRM ID", "Work", "Source", "ISWC", "IPRS tune codes", "PRS tune codes"] + societies + ["Open tasks", "Client credited"]
    rows = []
    for w in works:
        rows.append([w["mrm_id"], w["title"], "Added from IPRS" if w["origin"] == "iprs" else "Master",
                     ", ".join(w["identifiers"].get("ISWC", [])), ", ".join(w["identifiers"].get("IPRS", [])),
                     ", ".join(w["identifiers"].get("PRS", []))]
                    + [w["registrations"].get(s, {}).get("label", "—") for s in societies]
                    + [w["open_tasks"], "Yes" if w["credited"] else "No"])
    _sheet(wb, "Catalogue", header, rows)
    return _bytes(wb)


# ---- Data clean -------------------------------------------------------------
def list_workbook(sheets):
    """A list of the review screen as Excel – the rows as the screen counts them, one sheet per list. Text stays text:
    a title that starts with "=" is not a formula."""
    wb = _new_book()
    used = set()
    for s in sheets:
        name = re.sub(r"[\[\]:*?/\\]", "-", str(s["name"]))[:31] or "List"
        while name.lower() in used:
            name = name[:28] + f" {len(used)}"
        used.add(name.lower())
        ws = _sheet(wb, name, s["header"], s["rows"])
        for line in ws.iter_rows(min_row=2):
            for cell in line:
                if isinstance(cell.value, str) and cell.data_type == "f":
                    cell.data_type = "s"
                cell.alignment = Alignment(vertical="top", wrap_text=True)
    return _bytes(wb)


CLEAN_CHOICES = {"duplicate": "Duplicate", "different": "Not the same", "owner": "ISRC belongs to one row",
                 "neither": "Neither row", "same": "Same", "fix": "Fix in LNV", "ok": "OK as is", "add": "Add to LNV",
                 "not_ours": "Not our work", "deleted": "Deleted", "accept": "Accept", "reject": "Reject", "none": "Not in LNV"}
CREDIT_LABELS = {"writer": "Client is a writer", "shared": "Other composers credited too", "medley": "Medley / mashup",
                 "performer": "Client not credited as writer"}


def _decision(item):
    d = item.get("decision")
    if not d:
        return "Open"
    label = ("App: " if d.get("auto") else "") + CLEAN_CHOICES.get(d["choice"], d["choice"])
    data = d.get("data") or {}
    if data.get("keep"):
        label += f" – keep {data['keep']}"
    if data.get("row"):
        label += f" – row {data['row']}"
    if data.get("rows"):
        label += " – rows " + ", ".join(str(r) for r in data["rows"])
    return label


def clean_workbook(client, dsp_name, result):
    """Step 1 discrepancy and duplicate report: today's LNV against one DSP sheet, with every reviewer decision."""
    wb = _new_book()
    s, src = result["summary"], result["source"]
    _sheet(wb, "Summary", ["", ""], [
        ["Client", client.name], ["DSP sheet", f"{dsp_name} ({src['name']} · sheet {src['sheet']})"],
        ["DSP rows", src["rows"]], ["Recordings (by ISRC)", src["recordings"]], ["Songs (versions together)", src["songs"]],
        ["LNV songs", result["lnv"]["songs"]], ["DSP songs found in the LNV", s["matched"]],
        ["LNV rows confirmed by the DSP", s["lnv_rows_matched"]], ["LNV rows not on this DSP sheet", s["lnv_not_on_dsp"]],
        ["Possible LNV duplicates (cases)", s["duplicates"]], ["Artist name spellings to check", s["names"]],
        ["DSP songs not in the LNV", s["unmatched"]], ["… where the client is a writer", s["missing_writer"]],
        ["LNV blanks the DSP can fill", s["fills"]], ["Links to check", s["check"]],
        ["Treated as the client", ", ".join(result["client_names"])],
    ], widths={"": 40})
    links = lambda ls: "; ".join(f"row {l['row']}: {l['lnv']['title']}" for l in ls)
    _sheet(wb, "Matched", ["DSP song", "Album", "ISRCs", "LNV rows", "Score /10", "Evidence", "How", "Decision", "Note"],
           [[m["song"]["title"], m["song"]["album"], ", ".join(m["song"]["isrcs"]), links(m["links"]),
             max(l["score"] for l in m["links"]), " · ".join(m["links"][0]["evidence"]),
             "Confirmed by reviewer" if m["confirmed"] else m.get("auto") or "Automatic", _decision(m),
             " · ".join(m.get("notes") or [])] for m in result["matched"]],
           widths={"Evidence": 60, "LNV rows": 50, "Note": 60})
    dup_rows = []
    for c in result["duplicates"]:
        for n, r in enumerate(c["rows"]):
            dup_rows.append([c["key"], "Wrong ISRC" if c["kind"] == "wrong_isrc" else "Duplicate", r["row"], r["title"], r["movie"],
                             ", ".join(r["isrcs"]), ", ".join(r["writers"]),
                             ", ".join(f"{k} {v}" for k, v in r["codes"].items()),
                             "Suggested keeper" if r["row"] == c["keeper"] else "",
                             " · ".join(c["reasons"]) if n == 0 else "", _decision(c) if n == 0 else ""])
    _sheet(wb, "LNV duplicates", ["Case", "Kind", "LNV row", "Title", "Movie", "ISRC", "Writers", "Society codes", "Keeper",
                                  "Why", "Decision"], dup_rows, widths={"Why": 60, "Case": 18})
    names = [n for n in result["names"] if n["kind"] == "spelling"]
    _sheet(wb, "Artist names", ["Spelling", "Other spellings", "Times (LNV / DSP)", "Looks like", "Times (LNV / DSP) ",
                                "Similarity %", "Songs", "Changes a match?", "Decision"],
           [[n["a"]["spelling"], ", ".join(n["a"]["spellings"][1:]), f"{n['a']['lnv']} / {n['a']['dsp']}", n["b"]["spelling"],
             f"{n['b']['lnv']} / {n['b']['dsp']}", n["similarity"], "; ".join(n["a"]["songs"] + n["b"]["songs"]),
             "No – for information" if n.get("info") else "Yes", _decision(n)]
            for n in names])
    _sheet(wb, "Junk names", ["Name", "Times", "Songs", "Decision"],
           [[n["name"], n["count"], "; ".join(n["songs"]), _decision(n)] for n in result["names"] if n["kind"] == "junk"])
    _sheet(wb, "Missing in LNV", ["DSP song", "Album", "Year", "Popularity", "Credit", "Lyricists", "Composers",
                                  "Other composers", "Versions", "ISRCs", "Link", "Decision"],
           [[m["title"], m["album"], m["year"], m["popularity"], CREDIT_LABELS[m["credit"]], ", ".join(m["lyricists"]),
             ", ".join(m["composers"]), ", ".join(m["other_composers"]),
             ", ".join(f"{k} ×{v}" for k, v in m["versions"].items()), ", ".join(m["isrcs"]), m["link"], _decision(m)]
            for m in result["missing"]], widths={"Link": 40})
    _sheet(wb, "Fill blanks", ["LNV row", "LNV title", "Field", "Value from DSP", "From DSP song", "Match score", "Decision"],
           [[f["row"], f["title"], f["field"], f["value"], f["song"], f["score"], _decision(f)] for f in result["fills"]])
    check_rows = []
    for c in result["check"]:
        for n, x in enumerate(c["candidates"]):
            check_rows.append([c["song"]["title"] if n == 0 else "", c["song"]["album"] if n == 0 else "",
                               ", ".join(c["song"]["isrcs"]) if n == 0 else "", x["row"], x["lnv"]["title"], x["score"],
                               " · ".join(x["evidence"]), " · ".join(x["flags"]), _decision(c) if n == 0 else ""])
    _sheet(wb, "To check", ["DSP song", "Album", "ISRCs", "LNV row", "LNV title", "Score /10", "Evidence", "Problem",
                            "Decision"], check_rows, widths={"Evidence": 50, "Problem": 60})
    return _bytes(wb)
