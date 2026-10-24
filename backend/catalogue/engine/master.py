"""Read the MRM client master ("LNV report"): one row per song, repeating
contributor slots and repeating society blocks, located by header text."""
import re
from collections import defaultdict

import openpyxl

from .normalize import clean_id, clean_text, norm_ipi, norm_isrc, norm_iswc, to_number

WORK_FIELDS = {
    "SN": "sn", "WORK": "title", "ISRC": "isrc", "ISWC": "iswc", "ALTERNATEWORK": "alt_title",
    "MOVIENAME": "movie", "LABEL": "label", "RELEASEYEARYYYY": "release_year", "LANGUAGE": "language",
    "TYPEOFWORK": "type_of_work", "WORKSUBCATEGORY": "sub_category", "DURATIONHHMMSS": "duration",
}
SLOT_KINDS = {"SINGERNAME": "singers", "COMPOSERNAME": "composers", "AUTHORNAME": "authors", "PUBLISHERNAME": "publishers"}
BLOCK_FIELDS = {
    "SOCIETYNO": "society_no", "PRODUCTIONID": "production_id", "LASTDATEOFDISTRIBUTION": "last_distribution",
    "ACTIVECASEINDICATOR": "active_case", "CLIENTSTATUS": "client_status", "GENERALSTATUS": "general_status",
    "PURPOSEOFAMENDMENT": "amendment_purpose", "AMENDMENTREGISTEREDONDDMMYYYY": "amendment_date",
    "ENJWNO": "enjw_no", "ICEWORKKEY": "ice_work_key", "MCPSLASTDISTRIBUTION": "mcps_last_distribution",
}
TUNECODE_RE = re.compile(r"^(.*?)\s*TUNECODE\s*(\d+)\s*$", re.I)


class MasterFormatError(Exception):
    pass


def _key(text):
    return "".join(ch for ch in clean_text(text).upper() if ch.isalnum())


def _slot_kind(header_key):
    for prefix, kind in SLOT_KINDS.items():
        if re.fullmatch(prefix + r"\d+", header_key):
            return kind
    return None


def read_layout(header):
    """Locate work fields, contributor slots and society blocks from the header row."""
    layout = {"fields": {}, "slots": defaultdict(list), "blocks": []}
    keys = [_key(h) for h in header]
    for idx, k in enumerate(keys):
        if k in WORK_FIELDS and WORK_FIELDS[k] not in layout["fields"]:
            layout["fields"][WORK_FIELDS[k]] = idx
        kind = _slot_kind(k)
        if kind:
            layout["slots"][kind].append({"name": idx, "cae": idx + 1, "joshua": idx + 2, "role": idx + 3,
                                          "perf": idx + 4, "mech": idx + 5})
        m = TUNECODE_RE.match(clean_text(header[idx]))
        if m:
            block = {"society": clean_text(m.group(1)).upper(), "slot": int(m.group(2)),
                     "isrc": idx - 2, "iswc": idx - 1, "code": idx, "fields": {}}
            for j in range(idx + 1, min(idx + 14, len(keys))):
                if keys[j].startswith("ISRC"):
                    break
                field = BLOCK_FIELDS.get(keys[j])
                if field and field not in block["fields"]:
                    block["fields"][field] = j
            layout["blocks"].append(block)
    layout["slots"] = dict(layout["slots"])
    return layout


def parse_master(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb.worksheets[0]
    ws.reset_dimensions()
    rows = [tuple(r) for r in ws.iter_rows(values_only=True)]
    wb.close()
    if not rows:
        raise MasterFormatError("The master sheet is empty")
    header = rows[0]
    layout = read_layout(header)
    missing = [f for f in ("title",) if f not in layout["fields"]]
    if missing or not layout["blocks"]:
        raise MasterFormatError("Master needs a 'Work*' column and at least one '<Society> TUNECODE n' column")

    def get(row, idx):
        return row[idx] if idx is not None and idx < len(row) else None

    songs, issues = [], []
    multiline_cells = 0
    for offset, row in enumerate(rows[1:]):
        row_no = offset + 2
        if all(v in (None, "") for v in row):
            continue
        multiline_cells += sum(1 for v in row if isinstance(v, str) and "\n" in v.strip())
        song = {"row": row_no}
        for field, idx in layout["fields"].items():
            song[field] = clean_id(get(row, idx)) if field in ("sn", "release_year") else clean_text(get(row, idx))
        if not song.get("title"):
            continue
        for kind in SLOT_KINDS.values():
            people = []
            for n, slot in enumerate(layout["slots"].get(kind, []), start=1):
                name = clean_text(get(row, slot["name"]))
                if not name:
                    continue
                people.append({"slot": n, "name": name, "ipi": norm_ipi(get(row, slot["cae"])),
                               "role": clean_text(get(row, slot["role"])).upper(),
                               "perf": to_number(get(row, slot["perf"])), "mech": to_number(get(row, slot["mech"]))})
            song[kind] = people

        registrations, isrcs, iswcs = [], set(), set()
        occupied = []  # [society, slot] of every block with anything in it – the export never writes into those
        for top in ("isrc", "iswc"):
            value = song.get(top, "")
            (isrcs if top == "isrc" else iswcs).add((norm_isrc if top == "isrc" else norm_iswc)(value))
        for block in layout["blocks"]:
            code = clean_id(get(row, block["code"]))
            isrc_raw, iswc_raw = clean_text(get(row, block["isrc"])), clean_text(get(row, block["iswc"]))
            isrc, iswc = norm_isrc(isrc_raw), norm_iswc(iswc_raw)
            if iswc_raw and not iswc and norm_isrc(iswc_raw):
                issues.append({"row": row_no, "title": song["title"], "severity": "warning", "code": "ID_IN_WRONG_COLUMN",
                               "message": f"ISRC {iswc_raw} is stored in the ISWC column of the {block['society']} {block['slot']} block"})
                isrc = isrc or norm_isrc(iswc_raw)
            isrcs.add(isrc)
            iswcs.add(iswc)
            extra = {f: clean_text(get(row, idx)) for f, idx in block["fields"].items()}
            if code or isrc_raw or iswc_raw or any(extra.values()):
                occupied.append([block["society"], block["slot"]])
            if code or any(extra.values()):
                registrations.append({"society": block["society"], "slot": block["slot"], "code": code,
                                      "isrc": isrc_raw, "iswc": iswc_raw, **extra})
        song["registrations"] = registrations
        song["occupied"] = occupied
        song["isrcs"] = sorted(i for i in isrcs if i)
        song["iswcs"] = sorted(i for i in iswcs if i)
        song["has_credits"] = bool(song.get("composers") or song.get("authors") or song.get("publishers"))
        for col, other, code in (("authors", "Composer", "C"), ("composers", "Author", "A")):
            for p in song.get(col, []):
                if p["role"] == code:
                    issues.append({"row": row_no, "title": song["title"], "severity": "warning", "code": "MASTER_ROLE_COLUMN",
                                   "message": f"{p['name']} is in the {col[:-1].title()} column but has role code {code} "
                                              f"({other.lower()}) – move them to {'an' if other == 'Author' else 'a'} {other} column or fix the role code"})
        if not song["has_credits"]:
            issues.append({"row": row_no, "title": song["title"], "severity": "warning", "code": "NO_CREDITS",
                           "message": "No composer, author or publisher filled in"})
        songs.append(song)

    by_code = defaultdict(list)
    for s in songs:
        for r in s["registrations"]:
            if r["code"]:
                by_code[(r["society"], r["code"])].append(s)
    for (society, code), owners in by_code.items():
        if len({o["row"] for o in owners}) > 1:
            names = ", ".join(f"'{o['title']}' (row {o['row']})" for o in owners)
            for o in owners:
                issues.append({"row": o["row"], "title": o["title"], "severity": "error", "code": "DUPLICATE_CODE",
                               "message": f"{society} tunecode {code} is used on several songs: {names}"})

    stats = {"songs": len(songs), "columns": len(header), "blocks": len(layout["blocks"]),
             "societies": sorted({b["society"] for b in layout["blocks"]}),
             "multiline_cells": multiline_cells,
             "with_credits": sum(1 for s in songs if s["has_credits"])}
    return {"songs": songs, "issues": issues, "stats": stats, "layout": layout}


def codes_for(song, society):
    return [r["code"] for r in song["registrations"] if r["society"] == society and r["code"]]
