"""Step 1 – the DSP sheet merged into songs, the way MRM-Extractor's Song Merge does it:

  * An ISRC identifies one sound recording. Rows sharing an ISRC *and* the same lyricist / composer credits are one
    recording and are merged without asking.
  * A musical work is defined by its writers. Recordings with a similar title and exactly the same writers (case,
    punctuation and order ignored) are a merge suggestion: remix, lofi, live … of one song. Singers may differ.
  * Rows sharing an ISRC whose writer credits differ are an ISRC conflict: shown side by side, the reviewer decides.
    Its kind says how far apart the credits are – missing · extra · overlap · different.

The app's answer stands until the reviewer's (see SUGGESTED); review.py shows each item as a case to confirm.
Decisions are stored as "merge:G<row>" / "merge:C<row>" (row = the sheet row of the item's first recording) with
choice accepted · rejected · pending and data {"excluded": [recording ids]}; a recording's id is its first sheet row.
"""
import difflib
import io
import re
import unicodedata
from collections import Counter, OrderedDict, defaultdict

import xlsxwriter

from .dataclean import DSU, EDIT_FIELDS, ORIGINAL, _columns, _primary_order, clean_title, is_placeholder, isrc_tokens, title_key, version_type
from .xlsx_patch import compact

FUZZY_RATIO = 0.89
KINDS = ("missing", "extra", "overlap", "different")
MANUAL_TYPES = ["Original", "Re-release", "Remix", "Lofi", "Jhankar", "Slowed / Reverb", "Reprise",
                "Unplugged / Acoustic", "Live", "Instrumental", "Cover", "Recreated", "Medley / Mashup",
                "Male / Female Version", "Sad / Happy Version", "Singer / Language Version", "Other"]
# Sheet columns holding comma-separated names: merged name by name
LIST_COLS = {"main artist (all)", "singer", "lyricist", "composer", "producer", "recording engineer", "mixing engineer",
             "mastering engineer", "featured artist", "publisher", "record label (credited org)", "other credits",
             "artist's role(s)", "genre", "author"}
WRITER_COLS = {"lyricist", "author", "composer"}


def name_key(s):
    """Same name written differently (case, dashes, dots, spacing)."""
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower())


def _writers(rows, idxs):
    """(lyricists, composers) of some rows as name-key sets."""
    return (frozenset(k for i in idxs for n in rows[i]["lyricists"] if (k := name_key(n))),
            frozenset(k for i in idxs for n in rows[i]["composers"] if (k := name_key(n))))


def _names(rows, idxs, field):
    out = OrderedDict()
    for i in idxs:
        for n in rows[i][field]:
            out.setdefault(name_key(n), n)
    out.pop("", None)
    return list(out.values())


# ---------------------------------------------------------------- the analysis

def recordings(rows):
    """Rows sharing an ISRC with identical writer credits: one recording (row indexes, primary row first)."""
    dsu, first = DSU(len(rows)), {}
    for i, r in enumerate(rows):
        sig = _writers(rows, [i])
        for t in r["isrcs"]:
            if (t, sig) in first:
                dsu.union(first[(t, sig)], i)
            else:
                first[(t, sig)] = i
    groups = OrderedDict()
    for i in range(len(rows)):
        groups.setdefault(dsu.find(i), []).append(i)
    return [_primary_order(rows, g) for g in groups.values()]


def _types(rows, recs, rids):
    """Type of each recording among the versions of one song: the title's version tag (Lofi, Remix …); of the
    untagged ones the earliest release is the Original, the rest Re-release."""
    out, plain = {}, []
    for r in rids:
        t = version_type(rows[recs[r][0]]["title"])
        if t == ORIGINAL:
            plain.append(r)
        else:
            out[r] = t
    heads = {recs[r][0]: r for r in plain}
    for n, i in enumerate(_primary_order(rows, list(heads))):
        out[heads[i]] = "Re-release" if n else ORIGINAL
    return out


def _suggestions(rows, recs):
    """Recordings with a similar base title AND exactly the same lyricists and composers (both filled)."""
    blocks = defaultdict(list)
    for rid, idxs in enumerate(recs):
        lyr, comp = _writers(rows, idxs)
        key = title_key(rows[idxs[0]]["title"])
        if lyr and comp and key:
            blocks[(lyr, comp)].append((rid, key))
    out = []
    for items in blocks.values():
        if len(items) < 2:
            continue
        dsu, by_key = DSU(len(items)), defaultdict(list)
        for n, (_, k) in enumerate(items):
            by_key[k].append(n)
        for ns in by_key.values():
            for n in ns[1:]:
                dsu.union(ns[0], n)
        keys = list(by_key)
        for a in range(len(keys)):
            for b in range(a + 1, len(keys)):
                ka, kb = keys[a], keys[b]
                if min(len(ka), len(kb)) < 8:
                    continue
                sm = difflib.SequenceMatcher(None, ka, kb)
                if sm.quick_ratio() >= FUZZY_RATIO and sm.ratio() >= FUZZY_RATIO:
                    dsu.union(by_key[ka][0], by_key[kb][0])
        clusters = defaultdict(list)
        for n, (rid, _) in enumerate(items):
            clusters[dsu.find(n)].append(rid)
        for rids in clusters.values():
            if len(rids) > 1:
                heads = {recs[r][0]: r for r in rids}
                ordered = [heads[i] for i in _primary_order(rows, list(heads))]
                first = recs[ordered[0]]
                out.append({"kind": "suggestion", "rids": ordered,
                             "title": clean_title(rows[first[0]]["title"]) or rows[first[0]]["title"],
                             "writers": {"Lyricist": _names(rows, first, "lyricists"), "Composer": _names(rows, first, "composers")}})
    out.sort(key=lambda s: (-len(s["rids"]), s["title"].lower()))
    return out


def _conflicts(rows, recs):
    """Recordings that share an ISRC but were not merged because their writer credits differ.
    missing – the only difference is a blank credit · extra – one copy lists more writers than another ·
    overlap – credits differ but every pair shares a name · different – two copies credit different people."""
    owners = defaultdict(list)
    for rid, idxs in enumerate(recs):
        for t in OrderedDict.fromkeys(t for i in idxs for t in rows[i]["isrcs"]):
            owners[t].append(rid)
    dsu = DSU(len(recs))
    for rids in owners.values():
        for r in rids[1:]:
            dsu.union(rids[0], r)
    groups = OrderedDict()
    for rids in owners.values():
        if len(rids) > 1:
            groups.setdefault(dsu.find(rids[0]), set()).update(rids)
    rank = {k: n for n, k in enumerate(KINDS)}
    out = []
    for rids in groups.values():
        rids = sorted(rids)
        kind, diff = "missing", []
        for col, n in (("Lyricist", 0), ("Composer", 1)):
            sets = [_writers(rows, recs[r])[n] for r in rids]
            filled = [x for x in sets if x]
            if len(set(sets)) > 1:
                diff.append(col)
            if len(set(filled)) <= 1:
                continue
            if all(a <= b or b <= a for a in filled for b in filled):
                k = "extra"
            elif all(a & b for a in filled for b in filled):
                k = "overlap"
            else:
                k = "different"
            kind = max(kind, k, key=rank.get)
        isrcs = list(OrderedDict.fromkeys(t for r in rids for i in recs[r] for t in rows[i]["isrcs"]))
        shared = [t for t in isrcs if len(set(owners[t]) & set(rids)) > 1]
        out.append({"kind": kind, "rids": rids, "diff": diff, "isrcs": shared or isrcs,
                    "title": rows[recs[rids[0]][0]]["title"]})
    out.sort(key=lambda c: (rank[c["kind"]], c["isrcs"][0] if c["isrcs"] else ""))
    return out


def analyse(rows):
    """What the sheet holds before any decision: recordings, suggestions, conflicts (cached per sheet)."""
    recs = recordings(rows)
    ids = [rows[idxs[0]]["row"] for idxs in recs]
    items = OrderedDict()
    for s in _suggestions(rows, recs):
        items[f"G{min(ids[r] for r in s['rids'])}"] = s
    for c in _conflicts(rows, recs):
        items[f"C{min(ids[r] for r in c['rids'])}"] = c
    return {"recs": recs, "ids": ids, "items": items}


# Until the reviewer answers, the app's answer stands: versions with the same writers are one song, and so are copies
# of an ISRC whose credits only miss or add names; copies crediting other people stay apart.
SUGGESTED = {"suggestion", "missing", "extra"}


def moves(decisions):
    """Recordings the reviewer mapped onto an exactly matched song ("map:<recording id>" = join, data.to: that song's
    main recording id): {recording id: data}. A recording mapped onto one that is itself mapped stays where it is."""
    out = {}
    for key, d in decisions.items():
        if key.startswith("map:") and d.get("choice") == "join" and key[4:].isdigit():
            to = (d.get("data") or {}).get("to")
            if isinstance(to, int) or (isinstance(to, str) and to.isdigit()):
                out[int(key[4:])] = {**(d.get("data") or {}), "to": int(to)}
    return {k: v for k, v in out.items() if v["to"] not in out and v["to"] != k}


def decision(decisions, item_id, moved=None):
    """A merge item's answer: its status and the recordings left out of it – those the reviewer unticked, and those
    mapped onto another song (moved: moves(decisions), passed by callers that ask for many items)."""
    d = decisions.get(f"merge:{item_id}") or {}
    moved = moves(decisions) if moved is None else moved
    return d.get("choice") or "pending", set((d.get("data") or {}).get("excluded") or []) | set(moved)


def merged(item, status):
    """Does an item join its recordings – the reviewer's answer, or else the app's?"""
    return status == "accepted" or (status == "pending" and item["kind"] in SUGGESTED)


def songs(analysis, decisions):
    """The songs after step 1: lists of row indexes, primary recording first. A mapped recording leaves its own song
    and joins the song it was mapped onto."""
    recs, ids = analysis["recs"], analysis["ids"]
    moved = moves(decisions)
    dsu = DSU(len(recs))
    for item_id, item in analysis["items"].items():
        status, excluded = decision(decisions, item_id, moved)
        chosen = [r for r in item["rids"] if ids[r] not in excluded]
        if merged(item, status) and len(chosen) >= 2:
            for r in chosen[1:]:
                dsu.union(chosen[0], r)
    rid_of = {x: rid for rid, x in enumerate(ids)}
    for src, m in moved.items():
        if src in rid_of and m["to"] in rid_of:
            dsu.union(rid_of[m["to"]], rid_of[src])
    out = OrderedDict()
    for rid in range(len(recs)):
        out.setdefault(dsu.find(rid), []).append(rid)
    return [[i for r in rids for i in recs[r]] for rids in out.values()]


def moved_rows(analysis, decisions):
    """The sheet row indexes of the mapped recordings: never the main recording of the song they joined."""
    moved = moves(decisions)
    return {i for rid, x in enumerate(analysis["ids"]) if x in moved for i in analysis["recs"][rid]}


def _final(analysis, decisions):
    """Songs as lists of recording ids (rid), for types."""
    recs = analysis["recs"]
    by_row = {i: rid for rid, idxs in enumerate(recs) for i in idxs}
    return [list(OrderedDict.fromkeys(by_row[i] for i in song)) for song in songs(analysis, decisions)]


def manual_of(decisions):
    """{recording id: {type, cover}} typed by the reviewer."""
    return {int(k[5:]): {"type": (d.get("data") or {}).get("type", ""), "cover": (d.get("data") or {}).get("cover", "")}
            for k, d in decisions.items() if k.startswith("type:") and k[5:].isdigit()}


def edits_of(decisions):
    """The reviewer's corrections of the DSP data: {recording id: {field: value}} ("muso:<recording id>:<field>" = set)."""
    out = {}
    for key, d in decisions.items():
        if key.startswith("muso:") and d.get("choice") == "set":
            rid, _, field = key[5:].partition(":")
            if rid.isdigit() and field in EDIT_FIELDS and "value" in (d.get("data") or {}):
                out.setdefault(int(rid), {})[field] = d["data"]["value"]
    return out


def row_edits(analysis, decisions):
    """The same, per sheet row: {row index: {field: value}} – a correction counts for every row of its recording."""
    by_id = edits_of(decisions)
    return {i: by_id[x] for rid, x in enumerate(analysis["ids"]) if x in by_id for i in analysis["recs"][rid]} if by_id else {}


def titles_now(dsp, analysis, decisions):
    """{recording id: its title, corrected}: what "keep the DSP's title" writes."""
    edits = edits_of(decisions)
    return {x: (edits.get(x) or {}).get("Title") or dsp["rows"][analysis["recs"][rid][0]]["title"] for rid, x in enumerate(analysis["ids"])}


def follow(decisions, old, new):
    """Answers that name recordings by their sheet row ("title:" "map:" "muso:") when a newer export has other rows:
    {key: the key now, or None when the recording is gone} and the data changed with it. A recording is followed by its
    ISRCs and title; one that cannot be told apart is left behind. old · new: (sheet rows, analysis)."""
    from .normalize import norm_title

    def names(sheet):
        rows, analysis = sheet
        out = {}
        for rid, x in enumerate(analysis["ids"]):
            r = rows[analysis["recs"][rid][0]]
            for k in ([(t, norm_title(r["title"])) for t in r["isrcs"]] or [("", norm_title(r["title"]), norm_title(r["album"]))]):
                out.setdefault(k, []).append(x)
        return out
    was, now = names(old), names(new)
    at = {}
    for k, xs in was.items():
        if len(xs) == 1 and len(now.get(k, [])) == 1:
            at.setdefault(xs[0], now[k][0])
    out = {}
    for key, d in decisions.items():
        kind, _, rest = key.partition(":")
        rid, _, field = rest.partition(":")
        if kind not in ("title", "map", "muso") or not rid.isdigit():
            continue
        data = dict(d.get("data") or {})
        to = at.get(int(rid))
        if kind == "map":
            goes = at.get(int(data["to"])) if str(data.get("to", "")).isdigit() else None
            if goes is None:
                to = None
            data["to"] = goes
        out[key] = None if to is None else (f"{kind}:{to}" + (f":{field}" if kind == "muso" else ""), data)
    return out


def _merge_column(h, cells, c):
    """(original, duplicates) of one column across rows, primary row first – as MRM-Extractor writes them."""
    name = str(h or "").strip().lower()
    vals = [x[c] if c < len(x) else None for x in cells]
    if name in ("isrc", "isrcs", "isrc code"):
        per = [isrc_tokens(v) or ([str(v).strip()] if not is_placeholder(v) else []) for v in vals]
        key = str.upper
    elif name in LIST_COLS:
        per = [[n.strip() for n in str(v).split(",") if not is_placeholder(n)] if not is_placeholder(v) else [] for v in vals]
        key = name_key
    else:
        per = [[str(v).strip()] if not is_placeholder(v) and str(v).strip() else [] for v in vals]
        key = str.casefold
    seen, orig, dups = set(), [], []
    for vs in per:
        target = dups if orig else orig
        for v in vs:
            k = key(v)
            if k and k not in seen:
                seen.add(k)
                target.append(v)
    joined = name in LIST_COLS or name.startswith("isrc")
    return (", ".join(orig) if joined else (orig[0] if orig else "")), ", ".join(dups)


# ---------------------------------------------------------------- the Excel (MRM-Extractor's two sheets)

def workbook(dsp, analysis, decisions, credits):
    """'Merged Songs' – one row per song, each column with its (Duplicates) column – and 'All Songs' – every row of
    the sheet unchanged. Both end with Type, Manual Type (a dropdown) and Covers / Remix Song name. Songs where the
    client is not a writer are red."""
    rows, recs, ids = dsp["rows"], analysis["recs"], analysis["ids"]
    header = [str(h or f"Column {c + 1}") for c, h in enumerate(dsp.get("header") or [])]
    # the reviewer's corrections, in their own columns
    edits, at = row_edits(analysis, decisions), _columns(dsp.get("header") or [])
    column = {"Title": "title", "Film / album": "album", "Lyricist": "lyricist", "Composer": "composer", "Singer": "singer",
              "Publisher": "publisher", "ISRC": "isrc", "Release date": "date", "Link": "link"}
    if edits:
        rows = list(rows)
        for i, fields in edits.items():
            cells = list(rows[i]["cells"]) + [None] * (len(header) - len(rows[i]["cells"]))
            for f, v in fields.items():
                if column.get(f) in at:
                    cells[at[column[f]]] = ", ".join(v) if isinstance(v, list) else v
            rows[i] = {**rows[i], "cells": tuple(cells)}
    manual = manual_of(decisions)
    final = _final(analysis, decisions)
    types, song_of = {}, {}
    for n, song in enumerate(final):
        types.update(_types(rows, recs, song))
        song_of.update({r: n for r in song})
    extra = lambda rid: [types[rid], (manual.get(ids[rid]) or {}).get("type", ""), (manual.get(ids[rid]) or {}).get("cover", "")]
    tail = ["Type", "Manual Type", "Covers / Remix Song name"]
    isrc_col = next((c for c, h in enumerate(header) if h.strip().lower().startswith("isrc")), -1)
    not_ours = lambda song: credits.get(recs[song[0]][0], "writer") in ("performer", "medley")

    buf = io.BytesIO()
    # text stays text: a title that starts with "=" is never a formula
    wb = xlsxwriter.Workbook(buf, {"in_memory": True, "strings_to_urls": False, "strings_to_numbers": False, "strings_to_formulas": False})
    base = {"font_name": "Calibri", "font_size": 10, "valign": "top", "text_wrap": True, "border": 1, "border_color": "#BFBFBF"}
    fmt = {k: wb.add_format({**base, **v}) for k, v in {
        "hdr": {"bold": True, "font_size": 11, "font_color": "#FFFFFF", "bg_color": "#1F4E78", "align": "center", "valign": "vcenter"},
        "hdr_dup": {"bold": True, "font_size": 11, "font_color": "#FFFFFF", "bg_color": "#2E75B6", "align": "center", "valign": "vcenter"},
        "plain": {}, "dup": {"bg_color": "#FFF2CC"}, "isrc": {"bg_color": "#FFE699", "bold": True},
        "miss": {"bg_color": "#FDE2E1"}, "dup_miss": {"bg_color": "#F9CFCF"}}.items()}

    ws = wb.add_worksheet("Merged Songs")
    cols = [x for h in header + tail for x in (h, f"{h} (Duplicates)")]
    _header(ws, cols, fmt)
    for n, song in enumerate(final, start=1):
        heads = {recs[r][0]: r for r in song}
        ordered = [heads[i] for i in _primary_order(rows, list(heads))]   # original first
        out = []
        for c in range(len(header)):
            out.extend(_merge_column(header[c], [rows[i]["cells"] for r in ordered for i in recs[r]], c))
        per = [extra(r) for r in ordered]
        for k in range(len(tail)):
            dups = [v[k] for v in per[1:]]
            out += [per[0][k], ", ".join(x or "—" for x in dups) if any(dups) else ""]
        miss = not_ours(song)
        for c, v in enumerate(out):
            kind = ("dup_miss" if c % 2 else "miss") if miss else "dup" if c % 2 else "isrc" if c == 2 * isrc_col else "plain"
            ws.write(n, c, _value(v), fmt[kind])
    _finish(ws, cols, len(final))

    ws = wb.add_worksheet("All Songs")
    cols = header + tail
    _header(ws, cols, fmt)
    rid_of = {i: rid for rid, idxs in enumerate(recs) for i in idxs}
    for n, r in enumerate(rows, start=1):
        rid = rid_of[n - 1]
        miss = not_ours(final[song_of[rid]])
        cells = (list(r["cells"]) + [None] * len(header))[:len(header)]
        for c, v in enumerate(cells + extra(rid)):
            ws.write(n, c, _value(v), fmt["miss" if miss else "isrc" if c == isrc_col else "plain"])
    _finish(ws, cols, len(rows))
    wb.close()
    return compact(buf.getvalue())


def _value(v):
    if v is None:
        return ""
    return v if isinstance(v, (int, float)) else str(v)[:32000]


def _header(ws, cols, fmt):
    ws.set_row(0, 34)
    for c, h in enumerate(cols):
        dup = h.endswith("(Duplicates)")
        ws.write(0, c, h, fmt["hdr_dup" if dup else "hdr"])
        ws.set_column(c, c, 34 if dup else 24)


def _finish(ws, cols, n_rows):
    ws.freeze_panes(1, 1)
    ws.autofilter(0, 0, max(n_rows, 1), len(cols) - 1)
    c = cols.index("Manual Type")
    ws.data_validation(1, c, max(n_rows, 1), c, {"validate": "list", "source": MANUAL_TYPES, "error_type": "warning",
                                                 "error_title": "Manual Type", "error_message": "Not one of the listed types. Keep it anyway?"})
