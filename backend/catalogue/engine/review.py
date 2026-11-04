"""Step 1 – the DSP export and the LNV in one pass, one case per song (flowchart page 4: "display possible duplicates
one below another"). A case is a block of records: the song's DSP versions first, then the LNV rows that may be the
same song, ranked, each with its evidence. The app's answer is already selected; the reviewer confirms or changes it.

Cases
    versions   recordings with a similar title and the same writers (songmerge suggestion) – one song?
    isrc       rows sharing an ISRC whose writer credits differ (songmerge conflict) – one song?
    check      a song whose LNV row the app is not sure of
    missing    a song the LNV does not have – add it?
    left_out   the client only sings or performs it, or a medley (not asked; the reviewer can still add it)
    twice      LNV rows that are one song entered twice (or share an ISRC)
    names      two spellings that alone keep a DSP song and an LNV row apart – one person? (answered once, for
               every client)

The rule for "the same song": the same writers (lyricists and composers, as people) and a shared publisher
(dataclean.work_check). An LNV row that fails it is shown as the closest row, never linked by the app.

Answers are the decisions the screens already use: "merge:<item>" (songmerge), "link:<song>" (same rows | none),
"missing:<song>" (add | not_ours) and "dup:" / "isrc:" for LNV rows. A case is done when the reviewer answered each of
its parts.
"""
import re
from collections import OrderedDict

from . import dataclean, songmerge
from .steps import _names, _user, lnv_record

KIND_HELP = {
    "missing": "One copy leaves a writer blank; every name that is filled in matches.",
    "extra": "One copy lists more writers than the other; nothing contradicts.",
    "overlap": "The copies share some writers, but each lists names the other does not.",
    "different": "The copies credit completely different people – a data error or a different work.",
}
ORDER = {"names": 0, "versions": 1, "isrc": 2, "check": 3, "missing": 4, "twice": 5, "left_out": 6}


def _recording(rows, recs, ids, rid, rtype, source):
    idxs = recs[rid]
    p = rows[idxs[0]]
    dates = sorted(rows[i]["date"] for i in idxs if re.match(r"\d{4}", rows[i]["date"] or ""))
    sheet_rows = [rows[i]["row"] for i in idxs]
    return {"src": source, "ref": f"Row {sheet_rows[0]}" + (f" +{len(idxs) - 1}" if len(idxs) > 1 else ""), "id": ids[rid],
            "sheet_rows": sheet_rows, "link": p["link"], "version": rtype, "fields": {
                "Title": p["title"], "Film / album": p["album"],
                "Lyricist": songmerge._names(rows, idxs, "lyricists"), "Composer": songmerge._names(rows, idxs, "composers"),
                "Singer": songmerge._names(rows, idxs, "singers")[:6],
                "Publisher": list(OrderedDict.fromkeys(x for i in idxs for x in rows[i].get("publishers", [])))[:4],
                "ISRC": list(OrderedDict.fromkeys(t for i in idxs for t in rows[i]["isrcs"])),
                "Year": dates[0][:10] if dates else ""}}


def _marks(r):
    """The user's two stages over one Muso recording and one LNV row, as short marks: what is the same (good) and
    what differs (bad). A blank in the LNV is no difference – Muso fills it."""
    why = []
    add = lambda text, good: why.append({"text": text, "good": good})
    isrc = r.get("isrc")
    if isrc == "same":
        add("Same ISRC", True)
    elif isrc == "blank":
        add("No ISRC to compare", True)
    elif isrc:
        add("Other ISRC", False)
    add("Same title" if r.get("title") else "Other title or version", bool(r.get("title")))
    add("Same album" if r.get("album") else "Other album", bool(r.get("album")))
    if r.get("year") in ("same", "differ"):
        add("Same year" if r["year"] == "same" else "Other year", r["year"] == "same")
    w = r.get("writers")
    if w:
        add({"same": "Same writers", "close": "Writers: one name extra", "differ": "Different writers",
             "blank": "Writers missing – cannot check"}[w], w in ("same", "close"))
    pub = r.get("publisher")
    if pub:
        add({"same": "Same publisher", "differ": "Other publisher", "unchecked": "Publisher not checked"}[pub], pub != "differ")
    return why


def _candidate(rec, c):
    """An LNV record as a candidate: the user's two stages on it, against the DSP recording that fits it best (via)."""
    r = c.get("rec") or {}
    return {**rec(c["row"]), "score": c.get("score"), "why": _marks(r),
            "check": {"writers": c.get("writers"), "publisher": c.get("publisher"), "isrc": bool(c.get("isrc")),
                      "title": c.get("title") or 0, "odd": c.get("odd", [0, 0]), "shared": c.get("shared", 0),
                      "level": r.get("level"), "via": r.get("via"), "stage1": r.get("stage1"), "stage2": r.get("stage2")}
            if c.get("writers") else None}


def _lnv_part(kind, item, rec):
    """The LNV side of a song: ranked LNV records, and the answer – the reviewer's, else the app's.
    answer.choice: same (rows) · add · not_ours · None (not answered, no app answer)."""
    song = item["song"]["key"] if kind != "missing" else item["song_key"]
    if kind == "matched":
        d = _user(item)
        rows = [l["row"] for l in item["links"]]
        recs = [_candidate(rec, l) for l in item["links"]]
        if d:
            return recs, {"song": song, "choice": "same", "rows": d["data"].get("rows") or rows, "by": "you"}
        return recs, {"song": song, "choice": "same", "rows": rows, "by": "app", "why": item.get("auto") or "Same writers and publisher"}
    if kind == "check":
        d = _user(item)
        recs = [_candidate(rec, c) for c in item["candidates"]]
        if d and d["choice"] == "same":
            return recs, {"song": song, "choice": "same", "rows": d["data"].get("rows", []), "by": "you"}
        return recs, {"song": song, "choice": None, "rows": [], "by": None}
    d = item.get("decision") or {}
    answer = {"song": song, "choice": d.get("choice"), "rows": [], "by": None if not d else "app" if d.get("auto") else "you"}
    if answer["by"] == "app":
        answer["why"] = d.get("why") or "The client is a credited writer, it is an original song, and no LNV row is close"
    elif not d and item["credit"] in ("performer", "medley"):
        answer.update(choice="not_ours", by="app", why="The client only sings or performs it" if item["credit"] == "performer"
                      else "A medley of several songs")
    # the closest LNV rows: shown, never linked – they fail the same-song rule
    return [_candidate(rec, c) for c in item.get("near") or []], answer


def _wins(clean, decisions):
    """Single answers that settle many songs at once, most songs first: one person under two spellings, a name the
    DSP lists that is no writer, one company under two publisher names. Answered ones are not offered again."""
    out = [{"key": x["key"], "kind": "name", "a": x["a"]["spelling"], "b": x["b"]["spelling"], "songs": x.get("links", 0),
            "examples": x["a"]["songs"][:4]}
           for x in clean["names"] if x["kind"] == "spelling" and not x["info"] and x.get("links", 0) >= 2]
    out += clean.get("wins", [])
    return sorted((w for w in out if w["key"] not in decisions), key=lambda w: -w["songs"])[:12]


def _name_case(key, a, b, songs, links, d, source):
    return {"id": key, "kind": "names", "title": f"{a}  ·  {b}",
            "why": (f"These two spellings alone keep {links} {source} song{'s' if links != 1 else ''} apart from their LNV row. "
                    if links else "") + "Your answer counts for every client.",
            "merge": None, "muso": [], "lnv": [], "new_row": None, "updates": [],
            "names": {"a": a, "b": b, "songs": songs[:3]}, "popularity": links,   # most songs unlocked first
            "answer": {"key": key, "choice": (d or {}).get("choice"), "by": "you" if d else None}, "done": bool(d)}


def _in_lnv(song, rec, recording, rid_of, isrcs_of, rids):
    """The song's versions the LNV already has, each beside its LNV row, for the reviewer to check. answer: same
    (the reviewer said right) · none (they said it is not this version – it is then added as a new row) · None (the
    app's match, from a shared ISRC or the same title and version tag)."""
    album = lambda r: dataclean.album_key(r["fields"].get("Film / album") or "")
    year = lambda r: str(r["fields"].get("Year") or "")[:4]
    out = []
    for p in song.get("parts", []):
        row = p["lnv_row"] or (p["refused"][-1] if p.get("refused") else None)
        if not row:
            continue
        lnv = rec(row)
        # the recording that is the LNV row: the one with its ISRC, else the version's first
        at = next((i for i in p["rows"] if set(isrcs_of(i)) & set(lnv["fields"]["ISRC"])), p["rows"][0])
        if rid_of[at] not in rids:
            continue   # a version of the song this case does not show
        muso = recording(rid_of[at])
        out.append({"key": p["key"], "type": p["type"], "row": row, "muso": muso, "lnv": lnv,
                    "isrc": bool(set(muso["fields"]["ISRC"]) & set(lnv["fields"]["ISRC"])),
                    "album": bool(album(muso)) and album(muso) == album(lnv), "year": bool(year(muso)) and year(muso) == year(lnv),
                    "answer": "none" if not p["lnv_row"] else "same" if p.get("confirmed") else None})
    return out


def _origin(song, rec):
    """The LNV work a new recording belongs to (dataclean._origin): its row, shown beside the song, and named in the
    new row's Original Work and Original Movie / Album columns."""
    g = song.get("origin")
    if not g:
        return None
    return {**rec(g["row"]), "sure": g["sure"]}


FILL_FIELDS = {"Movie / album": "Film / album", "Release year": "Year", "Lyricists": "Lyricist", "Composers": "Composer",
               "Singers": "Singer"}


def _new_row(song):
    """The LNV row an added song becomes: its original (each version gets a row of its own), or with no original on
    the DSP, its main version."""
    o = song.get("original") or (song.get("parts") or [song])[0]
    return {"Title": o["title"], "Film / album": o.get("album", ""), "Lyricist": song.get("lyricists", [])[:6],
            "Composer": song.get("composers", [])[:6], "Singer": o.get("singers", [])[:6], "ISRC": o.get("isrcs", [])[:1],
            "Year": o.get("year", ""), "Length": o.get("duration", ""), "Label": o.get("label", "")}


def _updates(fills_by_row, rows):
    """Blank fields of the chosen LNV rows the DSP song fills; the app accepts them unless the reviewer said no."""
    out = []
    for row in rows:
        for f in fills_by_row.get(row, []):
            d = f.get("decision") or {}
            out.append({"key": f["key"], "row": row, "field": FILL_FIELDS.get(f["field"], f["field"]), "value": f["value"],
                        "more": f.get("more", 0), "accept": d.get("choice", "accept") != "reject", "by": "app" if d.get("auto") or not d else "you"})
    return out


def build(dsp, analysis, decisions, clean, master):
    source = dsp["source"]
    rows, recs, ids = dsp["rows"], analysis["recs"], analysis["ids"]
    songs_by_row = {s["row"]: s for s in master["songs"]}
    rec = lambda row: lnv_record(songs_by_row[row])
    fills_by_row = {}
    for f in clean["fills"]:
        fills_by_row.setdefault(f["row"], []).append(f)
    song_of = lambda kind, item: item if kind == "missing" else item["song"]

    # Where each DSP row ended up in the match: the song item it belongs to
    entry_of, entries = {}, []
    for kind in ("matched", "check", "missing"):
        for item in clean[kind]:
            members = (item["song"] if kind != "missing" else item).get("members") or []
            entries.append((kind, item, members))
            for i in members:
                entry_of[i] = len(entries) - 1
    final_songs = songmerge.songs(analysis, decisions)
    rid_of = {i: rid for rid, idxs in enumerate(recs) for i in idxs}
    types = {}
    for song in songmerge._final(analysis, decisions):
        types.update(songmerge._types(rows, recs, song))
    # Where each DSP row goes in the LNV: the song's own row (the original), or a version's row – one the LNV has
    # (lnv_row), else a new one naming the original
    goes = {}
    for kind, item, _ in entries:
        s = song_of(kind, item)
        goes.update({i: {"part": "original"} for i in (s.get("original") or {}).get("rows", [])})
        goes.update({i: {"part": "version", "lnv_row": p["lnv_row"]} for p in s.get("parts", []) for i in p["rows"]})
    isrcs_of = lambda i: rows[i]["isrcs"]
    recording = lambda rid, rtype=None: {**_recording(rows, recs, ids, rid, rtype or types[rid], source), **goes.get(recs[rid][0], {})}

    # One case per song: step 1's merge items (version groups, ISRC conflicts) that make up one song are shown together,
    # every recording of the song beside the LNV rows once; the ticks still answer each item ("merge:<item>")
    by_song, covered = OrderedDict(), set()
    for item_id, it in analysis["items"].items():
        status, excluded = songmerge.decision(decisions, item_id)
        joined = songmerge.merged(it, status)
        main = next((r for r in it["rids"] if ids[r] not in excluded), it["rids"][0])
        e = entry_of.get(recs[main][0])
        if e is None:
            continue
        covered.add(e)
        if joined:   # the other recordings are in this song too
            covered.update(entry_of[recs[r][0]] for r in it["rids"] if ids[r] not in excluded and recs[r][0] in entry_of)
        by_song.setdefault(e, []).append((item_id, it, status, excluded, joined))

    cases = []
    for e, items in by_song.items():
        kind, item, members = entries[e]
        song = song_of(kind, item)
        in_song = list(OrderedDict.fromkeys(rid_of[i] for i in members))   # the song's recordings, main first
        apart = [r for _, it, *_ in items for r in it["rids"] if r not in in_song]   # left out of it: shown unticked
        shown = in_song + list(OrderedDict.fromkeys(apart))
        own = songmerge._types(rows, recs, in_song)
        lnv, answer = _lnv_part(kind, item, rec)
        muso = [{**recording(r, own.get(r)), "in": r in in_song} for r in shown]
        muso[0]["in"] = True
        groups = [it for _, it, *_ in items]
        statuses = [st for _, _, st, *_ in items]
        merges = [{"key": f"merge:{item_id}", "ids": [ids[r] for r in it["rids"]], "status": st} for item_id, it, st, *_ in items]
        conflict = next((it for it in groups if it["kind"] != "suggestion"), None)
        cases.append({
            "id": items[0][0], "kind": "versions" if any(it["kind"] == "suggestion" for it in groups) else "isrc",
            "title": song["title"],
            "why": "Similar title, the same lyricist and composer" if not conflict
            else f"Same ISRC {', '.join(conflict['isrcs'][:2])} – " + KIND_HELP[conflict["kind"]],
            "tone": "warn" if any(it["kind"] in ("overlap", "different") for it in groups) else None,
            "merge": {"key": merges[0]["key"], "items": merges,
                      "status": "pending" if "pending" in statuses else statuses[0],
                      "by": "app" if "pending" in statuses else "you"},
            "muso": muso, "lnv": lnv, "answer": answer, "new_row": _new_row(song),
            "updates": _updates(fills_by_row, answer["rows"]),
            "in_lnv": _in_lnv(song, rec, recording, rid_of, isrcs_of, set(shown)),
            "done": "pending" not in statuses and answer["by"] == "you",
        })

    for e, (kind, item, members) in enumerate(entries):
        if e in covered:
            continue
        # songs the app linked surely (same writers, same publisher) are not asked: only the match tabs list them
        auto = kind == "matched" and not _user(item) and not item.get("unchecked")
        lnv, answer = _lnv_part(kind, item, rec)
        if item.get("unchecked"):
            answer.pop("why", None)   # the case's own line says it
        rids = list(OrderedDict.fromkeys(rid_of[i] for i in members))
        muso = [{**recording(r), "in": True} for r in rids]
        left_out = kind == "missing" and item["credit"] in ("performer", "medley")
        case_kind = "check" if kind in ("check", "matched") else "left_out" if left_out else "missing"
        cases.append({
            "id": item["key"], "kind": case_kind, "title": song_of(kind, item)["title"],
            "why": {"check": "Exact match – stage 1 (the recording) and stage 2 (the work) both hold: the app linked it" if auto
                    else "Possible match – only one stage holds (1 the recording: title, album, ISRC, year · 2 the work: title, album, writers, publisher): check and decide",
                    "missing": (f"A new recording of LNV row {song_of(kind, item)['origin']['row']} – it gets a row of its own naming that original"
                                if (song_of(kind, item).get("origin") or {}).get("sure") else
                                f"Not in the LNV – maybe a new recording of LNV row {song_of(kind, item)['origin']['row']}: check the writers"
                                if song_of(kind, item).get("origin") else
                                f"No LNV row has this {source} song's ISRC or credits" + (" – the closest are other songs" if lnv else "")),
                    "left_out": answer.get("why", "")}[case_kind],
            "merge": None, "muso": muso, "lnv": lnv, "answer": answer, "new_row": _new_row(song_of(kind, item)),
            "origin": _origin(song_of(kind, item), rec) if kind == "missing" else None,
            "updates": _updates(fills_by_row, answer["rows"]), "popularity": song_of(kind, item).get("popularity") or 0,
            "in_lnv": _in_lnv(song_of(kind, item), rec, recording, rid_of, isrcs_of, set(rids)),
            "done": answer["by"] == "you" or left_out or auto, "auto": auto,
        })

    for case in clean["duplicates"]:
        rws = [r["row"] for r in case["rows"] if r["row"] in songs_by_row]
        if len(rws) < 2:
            continue
        d = case.get("decision") or {}
        user = bool(d) and not d.get("auto")
        keep = (d.get("data") or {}).get("keep") or (d.get("data") or {}).get("row") or case.get("keeper")
        cases.append({
            "id": case["key"], "kind": "twice", "title": case["title"],
            "why": "; ".join(case["reasons"][:2]) or "The LNV has this song more than once",
            "isrc": case["kind"] == "wrong_isrc", "merge": None, "muso": [], "lnv": [rec(r) for r in rws], "new_row": None, "updates": [],
            "answer": {"key": case["key"], "choice": d.get("choice"), "keep": keep, "by": "you" if user else "app" if d else None,
                       "why": d.get("why", "")},
            "done": user,
        })

    # "Same person?" – asked once for every client; answered pairs stay listed (their data keeps the spellings)
    asked = set()
    for x in clean["names"]:
        if x["kind"] != "spelling" or x["info"]:
            continue
        asked.add(x["key"])
        d = decisions.get(x["key"])
        cases.append(_name_case(x["key"], x["a"]["spelling"], x["b"]["spelling"], x["a"]["songs"], x.get("links", 0), d, source))
    for key, d in decisions.items():
        if key.startswith("name:") and key not in asked and (d.get("data") or {}).get("a"):
            cases.append(_name_case(key, d["data"]["a"], d["data"].get("b", ""), d["data"].get("songs", []), 0, d, source))

    cases.sort(key=lambda c: (c["done"], ORDER[c["kind"]], -len(c["muso"]), -c.get("popularity", 0), c["title"].lower()))
    asked_cases = [c for c in cases if not c.get("auto")]
    linked = {r for c in clean["matched"] for r in [l["row"] for l in c["links"]]} \
        | {r for c in clean["check"] for r in ((_user(c) or {}).get("data") or {}).get("rows", [])} \
        | {p["lnv_row"] for c in clean["matched"] for p in c["song"].get("parts", []) if p["lnv_row"]}
    lnv_only = [{"row": s["row"], "title": s["title"], "film": s.get("movie", ""), "year": s.get("release_year", ""),
                 "writers": _names(s.get("authors", []) + s.get("composers", []))[:4]}
                for s in master["songs"] if s["row"] not in linked]
    choice = lambda m: (m.get("decision") or {}).get("choice") or ("not_ours" if m["credit"] in ("performer", "medley") else None)
    versions = dataclean.lnv_versions(clean, master["songs"])
    return {
        "source": source,
        "counts": {"rows": len(rows), "recordings": len(recs), "songs": len(final_songs),
                   "in_lnv": len(clean["matched"]) + sum(1 for c in clean["check"] if (_user(c) or {}).get("choice") == "same"),
                   "adding": sum(1 for m in clean["missing"] if choice(m) == "add"),
                   "not_ours": sum(1 for m in clean["missing"] if choice(m) == "not_ours"),
                   "undecided": sum(1 for m in clean["missing"] if not choice(m)),
                   "fills": sum(1 for f in clean["fills"] if (f.get("decision") or {}).get("choice") == "accept"),
                   "filled_rows": len({f["row"] for f in clean["fills"] if (f.get("decision") or {}).get("choice") == "accept"}),
                   "picks": sum(1 for k in decisions if k.startswith("pick:")),
                   "versions_new": len(versions["rows"]), "versions_named": len(versions["named"]),
                   "lnv": len(master["songs"]), "lnv_only": len(lnv_only),
                   "cases": len(asked_cases), "open": sum(1 for c in asked_cases if not c["done"]),
                   # open cases the app has no answer for: the real doubts
                   "needs": sum(1 for c in asked_cases if not c["done"] and c["answer"].get("choice") is None),
                   "kinds": {k: sum(1 for c in asked_cases if c["kind"] == k) for k in ORDER}},
        "cases": cases, "lnv_only": lnv_only,
        # values the reviewer took from the DSP over the LNV's own ("pick:<row>:<field>")
        "picks": {k: (d.get("data") or {}).get("value") for k, d in decisions.items() if k.startswith("pick:")},
        "wins": _wins(clean, decisions),
    }

