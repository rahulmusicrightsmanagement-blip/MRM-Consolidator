"""Step 3 (map IPRS works to the master) and step 4 (fill the gaps).

Identifiers are compared exactly after normalisation; titles may be fuzzy but
a fuzzy-only link always waits for a reviewer.
"""
from .iprs import PUBLISHER_ROLES
from .master import codes_for
from .normalize import alternate_titles, norm_title, same_party, title_similarity

AUTO_TITLE_SCORE = 100      # exact title (after normalisation) + shared contributor links automatically
SUGGEST_TITLE_SCORE = 85    # anything from here up is offered to the reviewer
REVIEW_BELOW = 5.0          # a link scoring under 5/10 always waits for a person

CA_ROLES = {"CA", "C|A", "AC", "A|C"}
GROUPS = [("authors", "Authors"), ("composers", "Composers"), ("publishers", "Publishers")]


def role_group(person, column):
    """The writer group a master slot really holds. The role code wins over the column it sits in: a name in an
    "Author" column with role code C is a composer (MASTER_ROLE_COLUMN flags that row). CA counts for both."""
    role = person["role"]
    if role in CA_ROLES:
        return {"authors", "composers"}
    if role == "A":
        return {"authors"}
    if role == "C":
        return {"composers"}
    return {column}


def master_people(song, group):
    """Master contributors for a role group (authors / composers by role code, publishers by column)."""
    if group == "publishers":
        return list(song.get("publishers", []))
    return [p for col in ("authors", "composers") for p in song.get(col, []) if group in role_group(p, col)]


def all_master_people(song):
    return [p for g, _ in GROUPS for p in song.get(g, [])]


def shared_contributors(work, song):
    return sum(1 for c in work["contributors"] if any(same_party(c["name"], p["name"], c["ipi"], p["ipi"])
                                                         for p in all_master_people(song)))


def compare_pair(work, song):
    """Field-by-field comparison of one IPRS work against one master song."""
    fields = []

    def add(field, iprs, master, result, note=""):
        fields.append({"field": field, "iprs": iprs, "master": master, "result": result, "note": note})

    score = title_similarity(work["title"], song["title"])
    add("Title", work["title"], song["title"], "same" if score == 100 else "different",
        "" if score == 100 else f"{score}% similar")
    if work["duration"] or song.get("duration"):
        if not song.get("duration"):
            add("Duration", work["duration"], "", "missing_master")
        elif not work["duration"]:
            add("Duration", "", song["duration"], "missing_iprs")
        else:
            add("Duration", work["duration"], song["duration"], "same" if work["duration"] == song["duration"] else "different")
    for label, value, valid, pool in (("ISWC", work["iswc"], work["iswc_valid"], song["iswcs"]),
                                      ("ISRC", work["isrc"], work["isrc_valid"], song["isrcs"])):
        if not valid:
            if pool:
                add(label, "", ", ".join(pool), "missing_iprs")
            continue
        if valid in pool:
            add(label, value, valid, "same")
        elif not pool:
            # Our master keeps ISWC / ISRC in the society blocks, which "Fill IPRS columns" writes – not a difference.
            add(label, value, "", "fill", "Filled into the IPRS block in step 3")
        else:
            add(label, value, ", ".join(pool), "different")

    for group, label in GROUPS:
        iprs_people, master_list = work[group], master_people(song, group)
        if not iprs_people and not master_list:
            continue
        iprs_text = "; ".join(f"{c['name']} ({c['per_own'] or 0:g}%)" for c in iprs_people)
        master_text = "; ".join(f"{p['name']} ({p['perf'] or 0:g}%)" if p["perf"] is not None else p["name"] for p in master_list)
        if not master_list:
            add(label, iprs_text, "", "missing_master")
            continue
        if not iprs_people:
            add(label, "", master_text, "missing_iprs")
            continue
        only_iprs = [c["name"] for c in iprs_people if not any(same_party(c["name"], p["name"], c["ipi"], p["ipi"]) for p in master_list)]
        only_master = [p["name"] for p in master_list if not any(same_party(c["name"], p["name"], c["ipi"], p["ipi"]) for c in iprs_people)]
        share_diff, ipi_diff = [], []
        for c in iprs_people:
            for p in master_list:
                if not same_party(c["name"], p["name"], c["ipi"], p["ipi"]):
                    continue
                if p["perf"] is not None and c["per_own"] is not None and abs(p["perf"] - c["per_own"]) > 0.05:
                    share_diff.append(f"{c['name']}: IPRS {c['per_own']:g}% vs master {p['perf']:g}%")
                if c["ipi"] and p["ipi"] and c["ipi"] != p["ipi"]:
                    ipi_diff.append(f"{c['name']}: IPI {c['ipi']} in IPRS vs {p['ipi']} in master")
        notes = []
        if only_iprs:
            notes.append("Only in IPRS: " + ", ".join(only_iprs))
        if only_master:
            notes.append("Only in master: " + ", ".join(only_master))
        notes += share_diff
        result = "different" if notes else "same"
        add(label, iprs_text, master_text, result, " · ".join(notes + ipi_diff))
        if ipi_diff and result == "same":
            fields[-1]["result"] = "ipi_mismatch"

    differences = [f for f in fields if f["result"] in ("different", "missing_master")]
    return {"fields": fields, "differences": len(differences),
            "status": "matched" if not differences else "differences"}


# Evidence weights for the 0–10 match score (Fellegi–Sunter style: agreement adds, disagreement subtracts).
# Identifiers are exact checks only; a missing value is "not comparable", never agreement.
WEIGHTS = {"tunecode": 4.0, "iswc": 3.0, "iswc_conflict": -3.0, "isrc": 2.0, "title_exact": 1.5, "title_core": 1.0,
           "title_close": 0.5, "title_mismatch": -1.0, "people_strong": 1.5, "people_some": 0.75, "people_none": -1.5,
           "duration": 0.5}


def title_match(work, song):
    """Best title similarity, also counting the master's "Alternate Work" names and the IPRS alternate title.
    Returns (score, the alternate name that gave it – "" when the main titles did)."""
    best, via = title_similarity(work["title"], song["title"]), ""
    if best == 100:
        return best, via
    for alt in alternate_titles(song.get("alt_title") or ""):
        s = title_similarity(work["title"], alt)
        if s > best:
            best, via = s, alt
    for alt in alternate_titles(work.get("alt_title") or ""):
        s = title_similarity(alt, song["title"])
        if s > best:
            best, via = s, alt
    return best, via


def score_pair(work, song):
    """0–10 score for 'this IPRS work is this master song', with the points behind it."""
    evidence = []

    def add(field, points, note):
        evidence.append({"field": field, "points": points, "note": note})

    if work["internal_no"] in codes_for(song, "IPRS"):
        add("IPRS tunecode", WEIGHTS["tunecode"], f"{work['internal_no']} is on the master row")
    if work["iswc_valid"]:
        if work["iswc_valid"] in song["iswcs"]:
            add("ISWC", WEIGHTS["iswc"], f"{work['iswc_valid']} on both")
        elif song["iswcs"]:
            add("ISWC", WEIGHTS["iswc_conflict"], f"IPRS {work['iswc_valid']} vs master {', '.join(song['iswcs'])}")
        else:
            add("ISWC", 0, "not in master – not comparable")
    if work["isrc_valid"] and work["isrc_valid"] in song["isrcs"]:
        add("ISRC", WEIGHTS["isrc"], f"{work['isrc_valid']} on both")
    t, via = title_match(work, song)
    if via and t >= 85:
        add("Title", WEIGHTS["title_exact"] if t == 100 else WEIGHTS["title_core"] if t >= 92 else WEIGHTS["title_close"],
            f"same as the alternate title “{via}”" if t >= 92 else f"{t}% similar to the alternate title “{via}”")
    elif t == 100:
        add("Title", WEIGHTS["title_exact"], "same title")
    elif t >= 92:
        add("Title", WEIGHTS["title_core"], "same title without version text")
    elif t >= 85:
        add("Title", WEIGHTS["title_close"], f"{t}% similar spelling")
    else:
        add("Title", WEIGHTS["title_mismatch"], f"only {t}% similar")
    people = [c for c in work["contributors"] if c["role"] not in PUBLISHER_ROLES]
    master_list = [p for g in ("authors", "composers") for p in song.get(g, [])]
    if people and master_list:
        shared = sum(1 for c in people if any(same_party(c["name"], p["name"], c["ipi"], p["ipi"]) for p in master_list))
        ratio = shared / len(people)
        if ratio >= 0.8:
            add("Writers", WEIGHTS["people_strong"], f"{shared} of {len(people)} writers agree")
        elif shared:
            add("Writers", WEIGHTS["people_some"], f"{shared} of {len(people)} writers agree")
        else:
            add("Writers", WEIGHTS["people_none"], "no writer in common")
    else:
        add("Writers", 0, "master has no writers – not comparable")
    if work["duration"] and song.get("duration") and work["duration"] == song["duration"]:
        add("Duration", WEIGHTS["duration"], "same duration")
    score = max(0.0, min(10.0, sum(e["points"] for e in evidence)))
    return {"score": round(score, 1), "evidence": evidence}


def _candidates(work, songs):
    """Every master song with evidence for this IPRS work, strongest first."""
    found = {}
    for song in songs:
        methods = []
        if work["internal_no"] in codes_for(song, "IPRS"):
            methods.append("IPRS tunecode")
        if work["iswc_valid"] and work["iswc_valid"] in song["iswcs"]:
            methods.append("ISWC")
        if work["isrc_valid"] and work["isrc_valid"] in song["isrcs"]:
            methods.append("ISRC")
        score, via = title_match(work, song)
        if not methods and score < SUGGEST_TITLE_SCORE:
            continue
        found[song["row"]] = {"row": song["row"], "title": song["title"], "methods": methods,
                              "title_score": score, "alt_title": via, "shared_contributors": shared_contributors(work, song),
                              "match": score_pair(work, song)}
    return sorted(found.values(), key=lambda c: (len(c["methods"]), c["match"]["score"], c["title_score"]), reverse=True)


def _resolve_decision(decision, by_row, songs):
    """A decision made on an earlier report names a master row; rows move between master versions, so the
    remembered title wins. A decision whose song cannot be found any more is dropped (back to automatic)."""
    if not decision or not decision.get("master_title"):
        return decision
    want = norm_title(decision["master_title"])
    row = decision.get("master_row")
    if row in by_row and norm_title(by_row[row]["title"]) == want:
        return decision
    same = [s["row"] for s in songs if norm_title(s["title"]) == want]
    return {**decision, "master_row": same[0] if len(same) == 1 else None}


def map_to_master(iprs, master, decisions):
    """Link every IPRS work to a master song (or none). decisions: {internal_no: {...}}."""
    songs = master["songs"]
    by_row = {s["row"]: s for s in songs}
    links = []
    for work in iprs["works"]:
        cands = _candidates(work, songs)
        decision = _resolve_decision(decisions.get(work["internal_no"]), by_row, songs)
        rejected = set(decision.get("rejected_rows", [])) if decision else set()
        cands = [c for c in cands if c["row"] not in rejected]
        link = {"internal_no": work["internal_no"], "title": work["title"], "candidates": cands[:5],
                "master_row": None, "method": "", "state": "unmatched", "reason": ""}

        # The IPRS tunecode is the strongest identifier, then ISWC, then ISRC.
        id_rows = set()
        for method in ("IPRS tunecode", "ISWC", "ISRC"):
            id_rows = {c["row"] for c in cands if method in c["methods"]}
            if id_rows:
                break
        other_rows = {c["row"] for c in cands if c["methods"]} - id_rows
        if decision and decision.get("master_row") in by_row:
            link.update(master_row=decision["master_row"], state="linked", method="Confirmed by reviewer")
            also = [r for r in decision.get("also_rows") or [] if r in by_row and r != decision["master_row"]]
            if also:
                link["also_rows"] = also
        elif len(id_rows) == 1:
            best = next(c for c in cands if c["row"] in id_rows)
            link.update(master_row=best["row"], state="linked", method=" + ".join(best["methods"]))
            if other_rows:
                titles = ", ".join(by_row[r]["title"] for r in sorted(other_rows))
                link["reason"] = f"Same ISWC/ISRC also appears on master song(s): {titles}"
        elif len(id_rows) > 1:
            link.update(state="review", reason="Identifiers point to more than one master song")
        elif cands:
            best = cands[0]
            unique = len([c for c in cands if c["title_score"] == best["title_score"]]) == 1
            evidence = best["shared_contributors"] > 0 or not by_row[best["row"]]["has_credits"]
            iswc_conflict = any(e["points"] < 0 and e["field"] == "ISWC" for e in best["match"]["evidence"])
            if best["title_score"] >= AUTO_TITLE_SCORE and unique and evidence and best["match"]["score"] >= REVIEW_BELOW:
                link.update(master_row=best["row"], state="linked", method="Title + contributors")
            elif best["title_score"] >= AUTO_TITLE_SCORE and unique and best["shared_contributors"] > 0 and not iswc_conflict:
                # A master whose society columns are still empty has no identifiers to compare, so the score
                # cannot reach 5. A unique exact title with a writer in common and no clashing ISWC is enough.
                link.update(master_row=best["row"], state="linked", method="Title + writers")
            else:
                link.update(state="review", reason="Possible match by title only – please confirm")
        if link["master_row"] is not None:
            link["comparison"] = compare_pair(work, by_row[link["master_row"]])
            link["match"] = score_pair(work, by_row[link["master_row"]])
            if link["state"] == "linked" and link["method"] not in ("Confirmed by reviewer", "Title + writers") \
                    and link["match"]["score"] < REVIEW_BELOW:
                link["state"] = "review"
                link["reason"] = link["reason"] or f"Match score only {link['match']['score']}/10 – please confirm"
            link["master_title"] = by_row[link["master_row"]]["title"]
            link["needs_code_fill"] = work["internal_no"] not in codes_for(by_row[link["master_row"]], "IPRS")
        links.append(link)

    linked_rows = {l["master_row"] for l in links if l["master_row"] is not None} | {r for l in links for r in l.get("also_rows", [])}
    # A song suggested for a work that waits for the reviewer is not "only in master" yet.
    waiting_rows = {l["candidates"][0]["row"] for l in links if l["state"] == "review" and l["candidates"]}
    master_only = [{"row": s["row"], "title": s["title"], "iprs_codes": codes_for(s, "IPRS")}
                   for s in songs if s["row"] not in linked_rows | waiting_rows]
    summary = {
        "iprs_works": len(links),
        "linked": sum(1 for l in links if l["state"] == "linked"),
        "matched": sum(1 for l in links if l.get("comparison", {}).get("status") == "matched"),
        "with_differences": sum(1 for l in links if l.get("comparison", {}).get("status") == "differences"),
        "review": sum(1 for l in links if l["state"] == "review"),
        "iprs_only": sum(1 for l in links if l["state"] == "unmatched"),
        "master_songs": len(songs),
        "master_linked": len(linked_rows),
        "master_only": len(master_only),
        "code_fills": sum(1 for l in links if l.get("needs_code_fill")),
    }
    return {"links": links, "master_only": master_only, "summary": summary}


def fill_gaps(iprs, master, mapping):
    """Step 4: the final report = every master song + every IPRS work the master is missing."""
    works = {w["internal_no"]: w for w in iprs["works"]}
    links_by_row = {}
    for link in mapping["links"]:
        if link["master_row"] is not None:
            # One IPRS work can be several master rows (versions the reviewer marked as the same song).
            for row in [link["master_row"], *link.get("also_rows", [])]:
                links_by_row.setdefault(row, []).append(link)

    rows = []
    for song in master["songs"]:
        linked = links_by_row.get(song["row"], [])
        codes = codes_for(song, "IPRS")
        fills = [{"field": "IPRS TUNECODE", "value": l["internal_no"], "reason": f"Linked by {l['method']}"}
                 for l in linked if l["internal_no"] not in codes]
        # Other fields (ISWC, writers, …) go into the master only when the reviewer picks them (MasterEdit).
        rows.append({"key": f"M{song['row']}", "origin": "master", "master_row": song["row"], "title": song["title"],
                     "iprs_works": [l["internal_no"] for l in linked], "fills": fills})
    added = []
    for link in mapping["links"]:
        if link["state"] == "unmatched":
            w = works[link["internal_no"]]
            added.append({"key": f"I{w['internal_no']}", "origin": "iprs", "master_row": None, "title": w["title"],
                          "iprs_works": [w["internal_no"]], "fills": [],
                          "iswc": w["iswc"], "isrc": w["isrc"], "language": w["language"], "category": w["category"]})
    pending = [l for l in mapping["links"] if l["state"] == "review"]
    summary = {"master_songs": len(rows), "added": len(added), "final_total": len(rows) + len(added),
               "pending_review": len(pending), "rows_with_fills": sum(1 for r in rows if r["fills"])}
    return {"rows": rows + added, "added": added, "pending": [p["internal_no"] for p in pending], "summary": summary}
