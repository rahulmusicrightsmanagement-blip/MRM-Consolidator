"""Fill the master's IPRS columns (ISRC n · ISWC n · IPRS TUNECODE n · Client status · General Status ·
Purpose of amendment) from the IPRS report.

One master song keeps one row: every IPRS work linked to it goes into the next IPRS block (1, 2, 3 …).
Client status   – "Amend" when IPRS has the client's own credit wrong (missing, share, role, IPI, society).
General Status  – "Amend" when anything else on the registration is wrong (other writers, publishers,
                  shares, ISWC, share totals, the same ISWC on two works).
Both "Uploaded" when the registration is right; the reasons go into "Purpose of amendment".
Songs IPRS does not have get "Not registered"; songs the reviewer marks "Not our work" get that in both.
"""
import re

from .mapping import master_people
from .normalize import clean_text, same_party, title_similarity

UPLOADED, AMEND, NOT_REGISTERED, NOT_OUR_WORK = "Uploaded", "Amend", "Not registered", "Not our work"
# IPRS report problems that call for an amendment (others, e.g. a non-member publisher, are information only).
GENERAL_ISSUES = {"SHARE_TOTAL": "Shares do not total 100%", "DUPLICATE_ISWC": "Same ISWC on two IPRS works – ask IPRS to merge"}
GROUP_ROLE = {"authors": "Author", "composers": "Composer"}


def is_not_our_work(text):
    """'Not our work' as typed in masters, including the common typo 'Not Our Wok'."""
    return re.sub(r"[^a-z]", "", clean_text(text).lower()) in ("notourwork", "notourwok")


def _client_entries(people, client):
    return [c for c in people if same_party(c["name"], client["name"], c.get("ipi", ""), client.get("ipi_name_no", ""))]


def client_reasons(work, song, client):
    """What IPRS has wrong about the client's own credit on this work."""
    mine = _client_entries(work["contributors"], client)
    if not mine:
        return ["Client not credited at IPRS"]
    reasons = []
    c = mine[0]
    if not c["ipi"]:
        reasons.append("Client IPI missing at IPRS")
    elif client.get("ipi_name_no") and c["ipi"] != client["ipi_name_no"]:
        reasons.append(f"Client IPI {c['ipi']} at IPRS, expected {client['ipi_name_no']}")
    if c["society"] and c["society"].upper() != "IPRS":
        reasons.append(f"Client shown with society {c['society']} at IPRS")
    if song and song.get("has_credits"):
        for group, role in GROUP_ROLE.items():
            at_iprs = bool(_client_entries(work[group], client))
            in_master = bool(_client_entries(master_people(song, group), client))
            if at_iprs and not in_master:
                reasons.append(f"Client is {role} at IPRS, not in our master")
            elif in_master and not at_iprs:
                reasons.append(f"Client is {role} in our master, not at IPRS")
        ours = [p for g in ("authors", "composers") for p in _client_entries(song.get(g, []), client) if p["perf"] is not None]
        if ours and c["per_own"] is not None and abs(ours[0]["perf"] - c["per_own"]) > 0.05:
            reasons.append(f"Client share {c['per_own']:g}% at IPRS, {ours[0]['perf']:g}% in our master")
    return reasons


def general_reasons(work, comparison, client):
    """Everything else on the registration that should be amended."""
    reasons = []
    for f in (comparison or {}).get("fields", []):
        if f["result"] != "different" or f["field"] not in ("Authors", "Composers", "Publishers", "ISWC"):
            continue
        if f["field"] == "ISWC":
            reasons.append(f"ISWC {f['iprs']} at IPRS, {f['master']} in our master")
            continue
        # Drop the parts about the client – those belong to Client status.
        parts = []
        for part in (f["note"] or "").split(" · "):
            label, _, names = part.partition(": ")
            if label in ("Only in IPRS", "Only in master"):
                others = [n for n in names.split(", ") if n and not same_party(n, client["name"])]
                if others:
                    parts.append(f"{label}: {', '.join(others)}")
            elif part and not same_party(label, client["name"]):
                parts.append(part)
        if parts:
            reasons.append(f"{f['field']} – " + "; ".join(parts))
    for code in dict.fromkeys(work["issue_codes"]):
        if code in GENERAL_ISSUES:
            reasons.append(GENERAL_ISSUES[code])
    return reasons


def _block(slot, work, comparison, song, client, existing):
    c_reasons = client_reasons(work, song, client)
    g_reasons = general_reasons(work, comparison, client)
    return {"slot": slot, "internal_no": work["internal_no"], "title": work["title"],
            "isrc": work["isrc_valid"] or work["isrc"], "iswc": work["iswc_valid"] or work["iswc"],
            "client_status": AMEND if c_reasons else UPLOADED, "general_status": AMEND if g_reasons else UPLOADED,
            "client_reasons": c_reasons, "general_reasons": g_reasons,
            "purpose": "; ".join(c_reasons + g_reasons), "already_in_master": existing,
            "round": "first", "earlier": []}


def current_blocks(row):
    """Each IPRS work's latest round: a kept block drops out once a newer block for the same code follows it."""
    newer = {b["internal_no"] for b in row["blocks"] if b["round"] == "new"}
    return [b for b in row["blocks"] if not (b["round"] == "kept" and b["internal_no"] in newer)]


def _reason_key(text):
    return re.sub(r"[^a-z0-9]", "", clean_text(text).lower())


def _kept(reg, work):
    """A block of the master that already records an amendment round for this IPRS work – written back unchanged."""
    reasons = [p for p in (reg.get("amendment_purpose") or "").split("; ") if p.strip()]
    return {"slot": reg["slot"], "internal_no": work["internal_no"], "title": work["title"], "isrc": reg.get("isrc", ""),
            "iswc": reg.get("iswc", ""), "client_status": reg.get("client_status", ""), "general_status": reg.get("general_status", ""),
            "client_reasons": [], "general_reasons": reasons, "purpose": reg.get("amendment_purpose", ""),
            "already_in_master": True, "round": "kept", "earlier": [], "date": reg.get("amendment_date", "")}


def fill_iprs_columns(iprs, master, mapping, final, client, not_our_work=(), slots=5):
    """Plan, per final-report song, what goes into each IPRS block. not_our_work: song keys the reviewer marked."""
    works = {w["internal_no"]: w for w in iprs["works"]}
    links = {l["internal_no"]: l for l in mapping["links"]}
    songs = {s["row"]: s for s in master["songs"]}
    flagged = set(not_our_work)
    pending_rows = {c["row"] for l in mapping["links"] if l["state"] == "review" for c in l["candidates"][:1]}
    rows = []
    for r in final["rows"]:
        song = songs.get(r["master_row"])
        # Any block with something in it (ISRC, ISWC, tune code, a status, a purpose, a date …) is never written:
        # new information always goes into the next completely empty block, so every earlier round stays as it was.
        occupied = {slot for soc, slot in (song or {}).get("occupied", []) if soc == "IPRS"}
        recorded = {}  # code -> the master's blocks holding it
        status_only = []  # blocks with a status but no tune code ("Not registered" / "Not our work")
        master_flag = False
        for reg in (song or {}).get("registrations", []):
            if reg["society"] == "IPRS":
                if reg.get("code"):
                    recorded.setdefault(reg["code"], []).append(reg)
                elif reg.get("client_status") or reg.get("general_status"):
                    status_only.append(reg)
                master_flag = master_flag or is_not_our_work(reg.get("client_status", "")) or is_not_our_work(reg.get("general_status", ""))
        not_ours = r["key"] in flagged or master_flag
        linked = [works[i] for i in r["iprs_works"] if i in works]
        # Exact-title registrations first, then versions; oldest IPRS number first.
        linked.sort(key=lambda w: (title_similarity(w["title"], r["title"]) < 100, int(w["internal_no"]) if w["internal_no"].isdigit() else 0))
        blocks, overflow = [], []
        taken = set(occupied)

        def next_empty():
            slot = next((n for n in range(1, slots + 1) if n not in taken), None)
            if slot is not None:
                taken.add(slot)
            return slot

        for w in linked:
            comparison = links.get(w["internal_no"], {}).get("comparison")
            new = _block(0, w, comparison, song, client, False)
            if not_ours:
                new.update(client_status=NOT_OUR_WORK, general_status=NOT_OUR_WORK, client_reasons=[], general_reasons=[], purpose="")
            earlier = sorted(recorded.get(w["internal_no"], []), key=lambda g: g["slot"])
            kept = [_kept(g, w) for g in earlier]
            if earlier:
                # Already in the master: add a block only when something is new – a problem not listed yet, or a
                # different status – and then only with the new problems.
                last = earlier[-1]
                # A reason can itself contain "; ", so it counts as listed when it appears anywhere in the earlier text.
                old = _reason_key(" ".join(g.get("amendment_purpose") or "" for g in earlier))
                fresh_c = [t for t in new["client_reasons"] if _reason_key(t) not in old]
                fresh_g = [t for t in new["general_reasons"] if _reason_key(t) not in old]
                same = lambda a, b: _reason_key(a) == _reason_key(b) or (is_not_our_work(a) and is_not_our_work(b))
                changed = not (same(new["client_status"], last.get("client_status", "")) and same(new["general_status"], last.get("general_status", "")))
                if not fresh_c and not fresh_g and not changed:
                    blocks += kept
                    continue
                if fresh_c or fresh_g:
                    new.update(client_reasons=fresh_c, general_reasons=fresh_g, purpose="; ".join(fresh_c + fresh_g))
            slot = next_empty()
            if slot is None:
                blocks += kept
                overflow.append(w["internal_no"])
                continue
            blocks += kept + [{**new, "slot": slot, "round": "new" if earlier else "first", "earlier": [g["slot"] for g in earlier]}]
        blocks.sort(key=lambda b: b["slot"])
        # A song with no IPRS registration gets its status once, in the first empty block – unless a block already says it.
        status_slot = None
        if not linked and r["master_row"] not in pending_rows:
            text = NOT_OUR_WORK if not_ours else NOT_REGISTERED
            if not any(_reason_key(g.get("client_status", "")) == _reason_key(text) or (not_ours and is_not_our_work(g.get("client_status", "")))
                       for g in status_only):
                status_slot = next_empty()
        current = current_blocks({"blocks": blocks})
        if blocks:
            state = "not_our_work" if not_ours else "amend" if any(AMEND in (b["client_status"], b["general_status"]) for b in current) else "uploaded"
        elif r["master_row"] in pending_rows:
            state = "pending"
        else:
            state = "not_our_work" if not_ours else "not_registered"
        rows.append({"key": r["key"], "origin": r["origin"], "master_row": r["master_row"], "title": r["title"],
                     "state": state, "blocks": blocks, "overflow": overflow, "not_our_work": not_ours, "status_slot": status_slot,
                     "marked_in_master": master_flag})
    summary = {s: sum(1 for x in rows if x["state"] == s) for s in ("uploaded", "amend", "not_registered", "not_our_work", "pending")}
    summary.update(blocks=sum(len(x["blocks"]) for x in rows), multi=sum(1 for x in rows if len(x["blocks"]) > 1),
                   overflow=sum(len(x["overflow"]) for x in rows),
                   client_amend=sum(1 for x in rows for b in current_blocks(x) if b["client_status"] == AMEND),
                   general_amend=sum(1 for x in rows for b in current_blocks(x) if b["general_status"] == AMEND),
                   new_rounds=sum(1 for x in rows for b in x["blocks"] if b["round"] == "new"),
                   kept=sum(1 for x in rows for b in x["blocks"] if b["round"] == "kept"))
    return {"rows": rows, "summary": summary, "slots": slots}

