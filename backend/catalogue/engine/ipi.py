"""The IPI / CAE list: the society's member list (the IPRS "AllNameType" export). One block per member – the real
name (PA, patronym) first, then the member's pseudonyms (PP) and group names (PG) – each with its IPI name number,
the member's base number (I-…) and role (C composer · A author · CA both · E publisher).

Names in the LNV, the Muso export and the IPRS report are compared with it: a pseudonym or another spelling of a member
becomes the member's PA name ("RK" -> "Ram Krishna"). An LNV name with a CAE number is found by that number first, so
the LNV needs no spelling to agree. A name two members share ("Pritam") is only resolved when the song itself says which
member it is (one of them is on the same LNV row by CAE); a group name (PG) is never turned into one person.
"""
import csv
import re
from collections import defaultdict
from functools import lru_cache

from .normalize import clean_id, clean_text, norm_ipi

NAME_TYPES = ("PA", "PP", "PG", "HR", "DF", "OR", "ST", "MO")
ROLES = {"C": "Composer", "A": "Author", "CA": "Composer & author", "E": "Publisher", "AR": "Arranger", "SE": "Sub-publisher",
         "AD": "Adapter", "TR": "Translator", "SA": "Sub-author", "PA": "Publisher"}
# The columns of the export, found by their header text (any order)
HEADERS = {"sr": ("SR_NO", "SR NO", "SRNO", "S NO", "SN"), "internal": ("INTERNAL NO", "INTERNAL_NO"),
           "local": ("LOCAL INTERNAL NO", "LOCAL_INTERNAL_NO"), "name": ("NAME", "MEMBER NAME", "IP NAME"),
           "ipi": ("IPI NO", "IPI", "IPI NAME NO", "IPI NAME NUMBER", "CAE", "CAE NO", "IPI/CAE"),
           "base": ("BASE NO", "IPI BASE NO", "BASE", "IPI BASE NUMBER"), "type": ("NAME TYPE", "TYPE", "NAMETYPE"),
           "role": ("ROLE", "ROLE CODE")}


class IpiFormatError(ValueError):
    pass


def _head(value):
    return re.sub(r"[\s_]+", " ", clean_text(value).upper()).strip()


def _columns(header):
    heads = [_head(h) for h in header]
    cols = {}
    for key, names in HEADERS.items():
        names = {_head(n) for n in names}
        cols[key] = next((i for i, h in enumerate(heads) if h in names), None)
    return cols


def _read(path):
    if str(path).lower().endswith(".csv"):
        with open(path, newline="", encoding="utf-8-sig", errors="replace") as fh:
            return [tuple(r) for r in csv.reader(fh)]
    from .xlsx import read_rows
    return read_rows(path)


def display(name):
    """'MITHUN NARESH,SHARMA' -> 'Mithun Naresh Sharma'. A short word with no vowel stays as written ('RK', 'DJ')."""
    words = clean_text(" ".join(p.strip() for p in clean_text(name).split(","))).split(" ")
    out = []
    for w in words:
        if not w:
            continue
        out.append(w.upper() if len(w) <= 3 and w.isalpha() and not re.search(r"[aeiouy]", w, re.I) and w.upper() not in ("LTD", "PVT")
                   else w.title())
    return " ".join(out)


def parse(path):
    """The member list as entries: {key, member, member_name, name, type, ipi, role, internal_no, sr}. A member is the
    block from its numbered row (SR_NO) to the next blank row; its id is the base number (I-…)."""
    rows = _read(path)
    at = next((i for i, r in enumerate(rows[:30]) if r and {"NAME"} <= {_head(c) for c in r}
               and any(_head(c) in {_head(x) for x in HEADERS["type"] + HEADERS["ipi"]} for c in r)), None)
    if at is None:
        raise IpiFormatError("This is not an IPI / CAE member list: no NAME, NAME TYPE and IPI NO columns were found.")
    cols = _columns(rows[at])
    if cols["name"] is None or (cols["ipi"] is None and cols["base"] is None):
        raise IpiFormatError("The member list needs a NAME column and an IPI NO (or BASE NO) column.")
    get = lambda r, k: r[cols[k]] if cols[k] is not None and cols[k] < len(r) else None
    blocks, block = [], None
    for r in rows[at + 1:]:
        name = clean_text(get(r, "name"))
        if not name:
            if not any(clean_text(c) for c in r):
                block = None   # a blank row ends the member
            continue
        sr = clean_id(get(r, "sr"))
        if block is None or sr:
            block = []
            blocks.append(block)
        block.append({"sr": sr, "name": name, "ipi": norm_ipi(get(r, "ipi")), "base": clean_text(get(r, "base")).upper(),
                      "type": (clean_text(get(r, "type")).upper() or "PA")[:4], "role": clean_text(get(r, "role")).upper()[:4],
                      "internal_no": clean_id(get(r, "internal"))})
    entries, seen = [], set()
    for b in blocks:
        if all(x["type"] == "PG" for x in b):   # group names with no member above them
            continue
        pa = next((x for x in b if x["type"] == "PA"), b[0])
        member = pa["base"] or next((x["base"] for x in b if x["base"]), "") or (f"SR-{pa['sr']}" if pa["sr"] else f"IPI-{pa['ipi']}")
        if not member or member == "IPI-":
            continue
        for x in b:
            key = f"{member}|{x['ipi'] or x['type'] + ':' + x['name'].upper()}"[:120]
            if key in seen:
                continue
            seen.add(key)
            entries.append({"key": key, "member": member[:40], "member_name": display(pa["name"])[:300], "name": x["name"][:300],
                            "type": x["type"], "ipi": x["ipi"], "role": x["role"], "internal_no": x["internal_no"][:40],
                            "sr": x["sr"][:20]})
    if not entries:
        raise IpiFormatError("The member list has no names under its header.")
    return entries


# ---------------------------------------------------------------- finding a name in the list

def _key(name):
    from .dataclean import person_key
    return person_key(name)


_PAREN = re.compile(r"\s*[(\[]([^)\]]*)[)\]]\s*")


@lru_cache(maxsize=262144)
def _keys(name):
    """The keys one written name may be found under: the whole name, the name without its bracket, the bracket alone
    ('Mithun Naresh Sharma (Mithoon)' -> the full name, 'Mithun Naresh Sharma', 'Mithoon')."""
    text = clean_text(name)
    out = [_key(text)]
    inner = _PAREN.findall(text)
    if inner:
        out.append(_key(_PAREN.sub(" ", text)))
        out += [_key(x) for x in inner]
    return tuple(dict.fromkeys(k for k in out if k))


class Index:
    """The list ready to look names up: by IPI name number, and by name key (PA and PP names)."""

    def __init__(self, entries, version=0):
        self.version = version
        self.members = {}   # member -> {"name": PA display, "ipi": the PA's IPI, "role"}
        self.by_ipi = defaultdict(set)
        self.by_key = defaultdict(set)
        other = {}   # a member's first own IPI, for one whose PA row has none
        for e in entries:
            m = e["member"]
            info = self.members.setdefault(m, {"name": e["member_name"] or display(e["name"]), "ipi": "", "role": e["role"]})
            if e["type"] == "PA":
                info.update(name=e["member_name"] or display(e["name"]), ipi=e["ipi"] or info["ipi"], role=e["role"] or info["role"])
            if e["type"] == "PG":   # a group's name is not one person's
                continue
            if e["ipi"]:
                self.by_ipi[e["ipi"]].add(m)
                other.setdefault(m, e["ipi"])
            for k in _keys(e["name"]):
                self.by_key[k].add(m)
        for m, info in self.members.items():
            if not info["ipi"]:
                info["ipi"] = other.get(m, "")
        self._cache = {}

    def __bool__(self):
        return bool(self.members)

    def member_of_ipi(self, ipi):
        ms = self.by_ipi.get(norm_ipi(ipi)) if ipi else None
        return next(iter(ms)) if ms and len(ms) == 1 else None

    def resolve(self, name, ipi="", hints=frozenset()):
        """{"member", "name" (the PA name), "ipi" (its IPI), "via": "ipi" | "name"} for one written name – or None when
        the list does not know it, or two members carry it and the song does not say which."""
        name = clean_text(name)
        if not name or not self.members:
            return None
        ck = (name, norm_ipi(ipi) if ipi else "", hints)
        if ck in self._cache:
            return self._cache[ck]
        out = None
        m = self.member_of_ipi(ipi)
        if m:
            out = {"member": m, **self.members[m], "via": "ipi"}
        else:
            for k in _keys(name):
                ms = self.by_key.get(k)
                if not ms:
                    continue
                pick = ms if len(ms) == 1 else ms & set(hints)
                if len(pick) == 1:
                    m = next(iter(pick))
                    out = {"member": m, **self.members[m], "via": "name"}
                break   # the first key the list knows decides: a bracket is only looked at when the whole name is unknown
        self._cache[ck] = out
        return out

    def hints(self, ipis):
        """The members a song's own CAE numbers name: they decide a name two members share."""
        return frozenset(m for i in ipis if (m := self.member_of_ipi(i)))

    def names(self, names, ipis=(), hints=frozenset()):
        """A list of written names as the list has them: (names, ipis, changed). Two names of one member become one."""
        out, ids, changed = [], [], False
        for n, name in enumerate(names):
            r = self.resolve(name, ipis[n] if n < len(ipis) else "", hints)
            new = r["name"] if r else name
            if r and new != clean_text(name):
                changed = True
            if new in out:
                changed = True
                continue
            out.append(new)
            ids.append(r["ipi"] if r else (norm_ipi(ipis[n]) if n < len(ipis) and ipis[n] else ""))
        return out, ids, changed


EMPTY = Index([])


# ---------------------------------------------------------------- what the list changes in step 2

NAME_FIELDS = ("Lyricist", "Composer", "Singer", "Publisher")


def annotate(record, index, hints=frozenset()):
    """A review record's names as the list has them: record["ipi"][field] = {"names", "ids"} where they differ from the
    names the file wrote (an LNV name is looked up by its CAE number first)."""
    out = {}
    cae = record.get("cae") or {}
    for f in NAME_FIELDS:
        names = record["fields"].get(f) or []
        if not isinstance(names, list) or not names:
            continue
        new, ids, changed = index.names(names, cae.get(f) or [], hints)
        if changed:
            out[f] = {"names": new, "ids": ids}
    if out:
        record["ipi"] = out
    else:
        record.pop("ipi", None)
    return record


def annotate_step(step, index):
    """Every record of step 2 (cases, their versions in the LNV, the original work) with the list's names; an added
    song's new row gets them too (the LNV writes those). The members an LNV row names by CAE decide shared names."""
    if not index:
        return step
    for c in step.get("cases", []):
        lnv = list(c.get("lnv") or []) + [v["lnv"] for v in c.get("in_lnv") or []] + ([c["origin"]] if c.get("origin") else []) \
            + list(c.get("was") or [])
        hints = index.hints([i for r in lnv for ids in (r.get("cae") or {}).values() for i in ids if i])
        for r in lnv:
            annotate(r, index, hints)
        for r in list(c.get("muso") or []) + [v["muso"] for v in c.get("in_lnv") or []]:
            annotate(r, index, hints)
        row = c.get("new_row")
        if row:
            for f in ("Lyricist", "Composer", "Singer"):
                if isinstance(row.get(f), list) and row[f]:
                    row[f] = index.names(row[f], (), hints)[0]
    step["ipi"] = {"version": index.version, "members": len(index.members)}
    return step


def aliases(index, master, dsp_rows):
    """Name keys of this client's files that are one member: {name key: the PA name's key}, for the match (People).
    An LNV name is found by its CAE number; a name found as two members is left alone."""
    from .dataclean import person_key
    if not index:
        return {}
    found = defaultdict(set)
    for s in master.get("songs", []):
        people = [p for kind in ("authors", "composers", "singers", "publishers") for p in s.get(kind, [])]
        hints = index.hints([p.get("ipi") for p in people if p.get("ipi")])
        for p in people:
            r = index.resolve(p["name"], p.get("ipi") or "", hints)
            if r:
                found[person_key(p["name"])].add(person_key(r["name"]))
    for row in dsp_rows:
        for kind in ("lyricists", "composers", "singers", "publishers"):
            for n in row.get(kind) or []:
                r = index.resolve(n)
                if r:
                    found[person_key(n)].add(person_key(r["name"]))
    return {k: next(iter(v)) for k, v in found.items() if k and len(v) == 1 and next(iter(v)) and next(iter(v)) != k}
