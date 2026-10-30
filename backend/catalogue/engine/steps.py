"""The consolidate flow, as comparison blocks for the screen.

    Step 1  The DSP sheet (Muso / Spotify / Apple) and the LNV, one case per song – see review.py and songmerge.py.
    Step 2  The LNV against the IPRS report: to check · amend · register · only at IPRS (step3 below; ?step=3).

A block is a set of records shown one below another (the flowchart's "display possible duplicates one below
another"): the reference record first, then the others ranked, every field side by side. The app's answer is already
applied; the reviewer only changes what is wrong.
"""
import re

from .dataclean import work_check
from .normalize import display_name, norm_title

WHY = {
    "CREDITS_DIFFER": "Writers or shares differ",
    "ISWC_DIFFERS": "ISWC differs",
    "CLIENT_NOT_CREDITED": "Client not credited at IPRS",
    "CODE_NOT_IN_EXPORT": "IPRS code not in the client's IPRS report",
    "NOT_FOUND": "Not found at IPRS",
}
EVIDENCE = {"IPRS tunecode": "Same IPRS code", "ISWC": "Same ISWC", "ISRC": "Same ISRC", "Title": "Title",
            "Writers": "Writers", "Duration": "Length", "Film": "Film"}


def title_key(text):
    return norm_title(text or "").replace(" ", "")


def _names(people):
    out = []
    for p in people:
        name = display_name(p["name"]) if isinstance(p, dict) else p
        if name and name not in out:
            out.append(name)
    return out


# ---------------------------------------------------------------- records: one source's view of a song

def lnv_record(song):
    codes = [r["code"] for r in song.get("registrations", []) if r["society"] == "IPRS" and r["code"]]
    return {"src": "LNV", "ref": f"Row {song['row']}", "row": song["row"], "fields": {
        "Title": song["title"], "Film / album": song.get("movie", ""), "Lyricist": _names(song.get("authors", [])),
        "Composer": _names(song.get("composers", [])), "Singer": _names(song.get("singers", []))[:6],
        "ISRC": song.get("isrcs", []), "ISWC": song.get("iswcs", []), "IPRS code": codes,
        "Year": song.get("release_year", ""), "Label": song.get("label", ""), "Length": song.get("duration", ""),
        "Publisher": _names(song.get("publishers", []))[:3],
    }}


def dsp_song_record(song, source):
    """One clean DSP song (all its rows together)."""
    return {"src": source, "ref": source, "key": song["key"], "link": song.get("link", ""), "fields": {
        "Title": song["title"], "Film / album": song.get("album", ""), "Lyricist": song.get("lyricists", []),
        "Composer": song.get("composers", []), "Singer": song.get("singers", [])[:6],
        "ISRC": song.get("isrcs", [])[:4], "Year": song.get("year", ""),
    }}


def iprs_record(work):
    return {"src": "IPRS", "ref": f"IPRS {work['internal_no']}", "code": work["internal_no"], "fields": {
        "Title": work["title"].title(), "Film / album": (work.get("production") or "").title(),
        "Lyricist": _names(work.get("authors", [])), "Composer": _names(work.get("composers", [])),
        "Singer": [p.strip().title() for p in re.split(r"[/,]", work.get("performer") or "") if p.strip()][:6],
        "ISRC": [work["isrc_valid"]] if work.get("isrc_valid") else [],
        "ISWC": [work["iswc_valid"]] if work.get("iswc_valid") else [],
        "IPRS code": [work["internal_no"]], "Length": work.get("duration", ""),
        "Publisher": _names(work.get("publishers", []))[:3],
    }}


def _evidence(match):
    out = []
    for e in (match or {}).get("evidence", []):
        label = EVIDENCE.get(e["field"], e["field"])
        out.append({"text": label if e["field"] in ("IPRS tunecode", "ISWC", "ISRC") else f"{label}: {e['note']}",
                    "good": e["points"] > 0})
    return out


def _user(item):
    """The reviewer's own decision on a Data clean item (not the app's)."""
    d = item.get("decision") or {}
    return None if not d or d.get("auto") else {"choice": d["choice"], "data": d.get("data") or {}}


# ---------------------------------------------------------------- step 1: the DSP songs

def _all_songs(clean):
    """Every DSP song of the match with where it ended up: (brief, song key, in the LNV?)."""
    out = [(i["song"], i["song"]["key"], True) for i in clean["matched"]]
    out += [(i["song"], i["song"]["key"], True) for i in clean["check"]]
    out += [(m, m["song_key"], False) for m in clean["missing"]]
    return out


def credits(clean):
    """{DSP row index: how the client is credited on its song} – writer · shared · performer · medley."""
    return {i: brief["credit"] for brief, _, _ in _all_songs(clean) for i in brief.get("members") or []}


# ---------------------------------------------------------------- step 2: the LNV against the IPRS report

def _side(people, authors, composers, publishers):
    """Who wrote it and who publishes it, as the same-song rule compares them."""
    return {"people": people.work([p["name"] for p in authors + composers]),
            "pubkeys": {k for p in publishers if (k := people.pub(p["name"]))}, "aside": set()}


def _rule(people, song, work):
    """The same-song rule on one LNV row and one IPRS work: writers same · differ · blank, publisher same · differ ·
    unchecked."""
    if people is None:
        return None
    writers, publisher = work_check(_side(people, work.get("authors", []), work.get("composers", []), work.get("publishers", [])),
                                    _side(people, song.get("authors", []), song.get("composers", []), song.get("publishers", [])))
    return {"writers": writers, "publisher": publisher}


def step3(master, iprs, run_decisions, flags, people=None):
    """people: dataclean.People with the reviewer's aliases and rules, for the same-song checks on each pair."""
    songs_by_row = {s["row"]: s for s in master["songs"]}
    works = {w["internal_no"]: w for w in iprs["iprs"]["works"]}
    works_by_row = {r["master_row"]: r["iprs_works"] for r in iprs["final"]["rows"] if r["master_row"]}
    review, amend, register, only, matched = [], [], [], [], []
    for link in iprs["mapping"]["links"]:
        decided = run_decisions.get(link["internal_no"])
        if link["state"] != "review" and not decided:
            continue
        work = works.get(link["internal_no"])
        cands = [c for c in link["candidates"] if c["row"] in songs_by_row][:6]
        if not work or not cands:
            continue
        review.append({"key": link["internal_no"], "title": work["title"].title(), "reason": link.get("reason", ""),
                       "records": [iprs_record(work)] + [{**lnv_record(songs_by_row[c["row"]]), "score": (c.get("match") or {}).get("score"),
                                                          "why": _evidence(c.get("match")),
                                                          "check": _rule(people, songs_by_row[c["row"]], work)} for c in cands],
                       "decision": None if not decided else {"row": decided["master_row"]} if decided.get("master_row") else {"none": True}})
    for row in iprs["tunecodes"]["rows"]:
        st = row["societies"].get("IPRS") or {}
        if row["origin"] == "iprs":
            code = (st.get("codes") or [""])[0]
            if code in works:
                only.append({"key": row["key"], "title": row["title"].title(), "record": iprs_record(works[code]),
                             "not_ours": row["key"] in flags})
            continue
        song = songs_by_row.get(row["master_row"])
        if not song:
            continue
        line = {"row": song["row"], "title": song["title"], "film": song.get("movie", ""),
                "codes": st.get("codes") or [], "why": list(dict.fromkeys(WHY.get(i["code"], i["text"]) for i in st.get("issues", [])))}
        if st.get("status") == "Amend":
            recs = [lnv_record(song)] + [{**iprs_record(works[c]), "check": _rule(people, song, works[c])}
                                         for c in works_by_row.get(song["row"], []) if c in works]
            amend.append({**line, "detail": st.get("reasons", [])[:6], "records": recs})
        elif st.get("status") == "Registration":
            register.append({**line, "record": lnv_record(song)})
        else:
            matched.append(line)
    return {"counts": {"works": len(works), "matched": len(matched), "review": len(review),
                       "review_open": sum(1 for r in review if not r["decision"]), "amend": len(amend),
                       "register": len(register), "iprs_only": sum(1 for o in only if not o["not_ours"])},
            "review": review, "amend": amend, "register": register, "iprs_only": only, "matched": matched}


def records_for_row(master, clean, iprs, row, source):
    """Everything the three files hold for one LNV row, one below another."""
    song = next((s for s in master["songs"] if s["row"] == row), None)
    if not song:
        return []
    out = [lnv_record(song)]
    if clean:
        linked = [i["song"] for i in clean["matched"] if any(link["row"] == row for link in i["links"])]
        out += [dsp_song_record(x, source) for x in linked[:3]]
    if iprs and iprs.get("final"):
        works = {w["internal_no"]: w for w in iprs["iprs"]["works"]}
        codes = next((r["iprs_works"] for r in iprs["final"]["rows"] if r["master_row"] == row), [])
        out += [iprs_record(works[c]) for c in codes[:3] if c in works]
    return out
