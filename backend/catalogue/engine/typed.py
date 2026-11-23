"""Songs the reviewer adds by typing them ("song:<id>" = typed): the form – every field of the client's own LNV – the
check of what was typed, and the LNV row it becomes. Required: title, album, ISRC, at least one song link, and at least
one composer or lyricist with a CAE / IPI number (every composer and lyricist needs one)."""
import re

from .master import _key, read_layout
from .normalize import clean_text, norm_ipi, norm_isrc, to_number

GROUPS = {"composers": ("Composer", "C"), "authors": ("Lyricist", "A"), "singers": ("Singer", "S"), "publishers": ("Publisher", "E")}
# columns the form's own parts fill: the rest of the LNV's work columns are offered as they are
OWN = {"SN", "WORK", "ISRC", "MOVIENAME", "WEBSITE1", "WEBSITE2", "YOUTUBE", "SPOTIFYID", "ORIGINALWORK", "ORIGINALMOVIEALBUM"}
MAX_LINKS = 20


class TypedError(ValueError):
    def __init__(self, fields):
        super().__init__(" · ".join(fields.values()))
        self.fields = fields


def form(header):
    """What the form asks for, from the LNV's header row: the other work columns, and how many of each contributor."""
    layout = read_layout(header)
    first = min([s["name"] for slots in layout["slots"].values() for s in slots] or [len(header)])
    more, seen = [], set()
    for h in header[:first]:
        k = _key(h or "")
        if k and k not in OWN and k not in seen:
            seen.add(k)
            more.append({"key": k, "label": clean_text(h).rstrip("* ").strip()})
    return {"more": more, "slots": {g: len(layout["slots"].get(g, [])) for g in GROUPS}}


def clean(data, header):
    """The typed song, tidied – or TypedError naming every field that is missing or wrong."""
    wrong = {}
    f = form(header)
    text = lambda k, n=300: clean_text(data.get(k))[:n]
    out = {"title": text("title"), "album": text("album")}
    for k, label in (("title", "Title"), ("album", "Album")):
        if not out[k]:
            wrong[k] = f"{label} is required"
    out["isrc"] = norm_isrc(data.get("isrc"))
    if not clean_text(data.get("isrc")):
        wrong["isrc"] = "ISRC is required"
    elif not out["isrc"]:
        wrong["isrc"] = "ISRC must be 12 characters, e.g. INH100510220"
    links = []
    for u in data.get("links") if isinstance(data.get("links"), list) else []:
        u = clean_text(u)[:500]
        if not u:
            continue
        if not re.match(r"https?://[^\s/]+\.[^\s/]+", u, re.I):
            wrong["links"] = f"Not a link: {u[:60]}"
        elif u not in links:
            links.append(u)
    out["links"] = links[:MAX_LINKS]
    if not links:
        wrong.setdefault("links", "At least one song link is required")
    people = data.get("people") if isinstance(data.get("people"), dict) else {}
    out["people"] = {}
    for g, (label, _) in GROUPS.items():
        rows = []
        for p in people.get(g) if isinstance(people.get(g), list) else []:
            if not isinstance(p, dict):
                continue
            name, raw = clean_text(p.get("name"))[:200], clean_text(p.get("ipi"))
            if not name and not raw:
                continue
            ipi = norm_ipi(raw) if re.fullmatch(r"[\d\s.]{8,14}", raw or "") else ""
            if not name:
                wrong[g] = f"{label}: a CAE / IPI number has no name"
            if raw and len(ipi) != 11:
                wrong[g] = f"{label} {name}: the CAE / IPI number must be 8 to 11 digits"
            if not raw and g in ("composers", "authors"):
                wrong[g] = f"{label} {name}: the CAE / IPI number is required"
            share = {}
            for s in ("perf", "mech"):
                v = to_number(p.get(s))
                if clean_text(p.get(s)) and (v is None or not 0 <= v <= 100):
                    wrong[g] = f"{label} {name}: a share must be a number from 0 to 100"
                elif v is not None:
                    share[s] = v
            rows.append({"name": name, "ipi": ipi, "joshua": clean_text(p.get("joshua"))[:60], **share})
        if len(rows) > f["slots"][g]:
            wrong[g] = f"The LNV has room for {f['slots'][g]} {label.lower()}s"
        out["people"][g] = rows
    if not out["people"]["composers"] and not out["people"]["authors"]:
        wrong.setdefault("composers", "At least one composer or lyricist with a CAE / IPI number is required")
    more, known = data.get("more") if isinstance(data.get("more"), dict) else {}, {m["key"] for m in f["more"]}
    out["more"] = {k: clean_text(v)[:500] for k, v in more.items() if k in known and clean_text(v)}
    out["to"], out["to_title"] = text("to", 120), text("to_title")
    if not out["to"]:
        wrong["to"] = "The song it is added to is missing"
    if wrong:
        raise TypedError(wrong)
    return out


def spotify_id(links):
    for u in links:
        m = re.search(r"spotify\.com/(?:[\w-]+/)?track/([A-Za-z0-9]{22})", u)
        if m:
            return m.group(1)
    return ""


def record(data):
    """A typed song as a review record (the screens show it like a Muso recording)."""
    names = lambda g: [p["name"] for p in (data.get("people") or {}).get(g, [])]
    return {"src": "Typed", "ref": "Typed", "link": (data.get("links") or [""])[0], "fields": {
        "Title": data.get("title", ""), "Film / album": data.get("album", ""), "Lyricist": names("authors"), "Composer": names("composers"),
        "Singer": names("singers"), "Publisher": names("publishers"), "ISRC": [data["isrc"]] if data.get("isrc") else [],
        "Year": (data.get("more") or {}).get("RELEASEYEARYYYY", "")}}


def write(ws, layout, header, row, sn, song, original, put, fill, cae):
    """One typed song as an LNV row: its own fields, its links (Website1, Website2, YouTube, Spotify ID), each
    contributor with CAE, role and shares, every other column typed, and the song it was added to as its original."""
    at = {}
    for i, h in enumerate(header):
        at.setdefault(_key(h or ""), i)
    links = song["links"]
    tube = [u for u in links if re.search(r"youtu\.?be", u, re.I)]
    rest = [u for u in links if u not in tube]
    if "YOUTUBE" not in at:
        rest, tube = links, []
    if not rest:   # only YouTube links: the website column has the first too
        rest = tube[:1]
    values = {"SN": sn, "WORK": song["title"], "ISRC": song["isrc"], "MOVIENAME": song["album"], "SPOTIFYID": spotify_id(links),
              "YOUTUBE": ", ".join(tube), **({"WEBSITE1": rest[0], "WEBSITE2": ", ".join(rest[1:])} if "WEBSITE2" in at else {"WEBSITE1": ", ".join(rest)})}
    if original:
        values["VERSION"] = "MOD"
    values.update(song.get("more") or {})
    for k, v in values.items():
        col = at.get(k)
        if v not in (None, "") and col is not None:
            put(ws, row, col, int(v) if k == "RELEASEYEARYYYY" and str(v).isdigit() else v, fill)
    if original:   # the columns naming the original may be the app's own, after the LNV's last one
        for f, k in (("original_work", "title"), ("original_movie", "album")):
            if original[k]:
                put(ws, row, layout["fields"].get(f), original[k], fill)
    for g, (_, role) in GROUPS.items():
        for slot, p in zip(layout["slots"].get(g, []), song["people"].get(g, [])):
            put(ws, row, slot["name"], p["name"], fill)
            put(ws, row, slot["role"], role, fill)
            for k, v in (("cae", cae(p["ipi"]) if p.get("ipi") else None), ("joshua", p.get("joshua")), ("perf", p.get("perf")), ("mech", p.get("mech"))):
                if v not in (None, ""):
                    put(ws, row, slot[k], v, fill)
