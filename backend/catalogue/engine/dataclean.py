"""Data clean – step 1 of the consolidate process: today's LNV against one DSP sheet (Muso, Apple Music or Spotify,
as MRM-Extractor writes them). Matching and duplicate finding run as one pass over both sheets:

  * DSP rows sharing an ISRC are one recording; recordings with the same cleaned title and no conflicting writers
    are one song (remix, lofi, live … stay with their song).
  * Every DSP song is linked to the LNV rows it agrees with. Each link carries its evidence and a score out of 10;
    identifiers are compared exactly, never fuzzily, and the client's own name never counts as evidence.
  * What the links leave behind are the review queues: LNV duplicates, artist-name spellings, songs missing from
    the LNV, LNV blanks the DSP can fill, and uncertain or conflicting links.

Nothing is merged or changed here – every item waits for a reviewer. "Same person" decisions on names and link
decisions are fed back into the matching, so each decision improves the next run.
"""
import re
import unicodedata
from collections import Counter, OrderedDict, defaultdict
from functools import lru_cache

import openpyxl
from rapidfuzz import fuzz

from .normalize import alternate_titles, clean_text

# ---------------------------------------------------------------- song keys (from MRM-Extractor's Merge songs)

PLACEHOLDERS = {"", "N/A", "NA", "NONE", "NULL", "-", "UNAVAILABLE", "UNKNOWN", "NOT PROVIDED BY MUSO", "NOT EXPOSED BY PUBLIC API"}
ISRC_RE = re.compile(r"[A-Z]{2}[A-Z0-9]{3}\d{7}")

# Words marking a title part as a version tag rather than part of the song name
VERSION_WORDS = [
    "remix", "re-mix", "mix", "version", "from", "lofi", "lo-fi", "lo fi", "flip",
    "jhankar", "jhankaar", "jhankar beats", "beats", "hifi", "stereo", "reprise", "live",
    "unplugged", "acoustic", "instrumental", "karaoke", "slowed", "reverb", "sped up",
    "revisited", "revisit", "recreated", "recreation", "reloaded", "remastered",
    "remaster", "edit", "cover", "male", "female", "sad", "happy", "duet", "solo", "club",
    "trap", "house", "phonk", "bolly", "afro", "drill", "edm", "dj", "rmx", "vibe",
    "vibes", "trending", "unwind", "soundtrack", "original motion picture", "ost",
    "film", "theme", "guitar", "piano", "flute", "violin", "sax", "saxophone", "chill",
    "dance", "rework", "rewind", "2.0", "3.0", "dialogue", "part", "pt",
]
VERSION_RE = re.compile(r"(?<![a-z])(" + "|".join(re.escape(w) for w in VERSION_WORDS) + r")(?![a-z])", re.I)
TRAILING_RE = re.compile(r"(\s+(" + VERSION_RE.pattern + r")(\s+\S+)?)\s*$", re.I)
# Medleys/mashups hold several songs: never joined to one song by title
MEDLEY_RE = re.compile(r"medley|mash-?up|smashup|jukebox|non[\s-]?stop|commentry|commentary|\sx\s|\bvs\b", re.I)
VERSION_TYPES = [
    ("Medley / Mashup", MEDLEY_RE),
    ("Lofi", re.compile(r"lo[\s-]?fi", re.I)),
    ("Jhankar", re.compile(r"jh?ank+aa?r", re.I)),
    ("Slowed / Reverb", re.compile(r"slowed|reverb|sped up", re.I)),
    ("Remix", re.compile(r"remix|rmx|\bmix\b|club|trap|house|phonk|afro|drill|edm|\bdj\b|rework", re.I)),
    ("Reprise", re.compile(r"reprise", re.I)),
    ("Unplugged / Acoustic", re.compile(r"unplugged|acoustic", re.I)),
    ("Live", re.compile(r"\blive\b|concert", re.I)),
    ("Instrumental", re.compile(r"instrumental|karaoke|guitar|piano|flute|violin|sax|theme", re.I)),
    ("Recreated / Cover", re.compile(r"recreat|revisit|reloaded|cover|tribute|2\.0|3\.0", re.I)),
    ("Male / Female Version", re.compile(r"female|male", re.I)),
    ("Sad / Happy Version", re.compile(r"\bsad\b|\bhappy\b", re.I)),
]
ORIGINAL = "Original"
# Common Hinglish spelling variants, per word
WORD_FIX = {"hain": "hai", "nahin": "nahi", "mein": "me", "main": "me", "mai": "me", "hoon": "hu", "hun": "hu",
            "kyun": "kyu", "kyon": "kyu"}


def is_placeholder(v):
    return v is None or str(v).strip().upper() in PLACEHOLDERS


def _ascii(s):
    return unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()


@lru_cache(maxsize=131072)
def phonetic(s):
    """Spelling-insensitive key: 'Hungamaa Ho Gaya' == 'Hungama Hogaya', 'Pyaar' == 'Pyar'."""
    words = re.sub(r"[^a-z0-9]+", " ", _ascii(s)).split()
    s = "".join(WORD_FIX.get(w, w) for w in words)
    s = re.sub(r"(.)\1+", r"\1", s)  # "Peechhe" -> "Peche" before dropping h's
    s = s.replace("ph", "f").replace("ck", "k").replace("x", "ks")
    s = re.sub(r"([bcdgjkpstr])h", r"\1", s)
    s = s.replace("w", "v").replace("z", "j").replace("q", "k")
    s = s.replace("ee", "i").replace("oo", "u").replace("y", "i")
    return re.sub(r"(.)\1+", r"\1", s)


def is_medley(title):
    return bool(MEDLEY_RE.search(f" {title} "))


@lru_cache(maxsize=65536)
def clean_title(title):
    """Song name without version tags: 'Zeehale Muskin - From "Ghulami"' -> 'Zeehale Muskin'."""
    t = str(title or "")
    t = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", t)  # (From "Queen"), [Remix]
    t = re.sub(r",?\s*\b(pt|part)\.?\s*\d+\b", " ", t, flags=re.I)  # ", Pt. 1"
    m = re.search(r"\s+-\s+[^-/]*/(.*)$", t)  # "Song - Film / Soundtrack Version"
    if m and VERSION_RE.search(m.group(1)):
        t = t[:m.start()]
    parts = re.split(r"\s+[-–—|:]\s+|\s*/\s*|\s+-(?=\S)|(?<=\S)-\s+", t)
    for n in range(1, len(parts)):  # cut at the first part that is a version tag
        if VERSION_RE.search(parts[n]) or "/" in parts[n]:
            parts = parts[:n]
            break
    t = " ".join(parts)
    prev = None
    while prev != t:  # "Tera Naam Liya LoFi Flip", "Ek Hasina Thi Lofi Mix"
        prev = t
        m = TRAILING_RE.search(t)
        if m and m.start() > 0:
            t = t[:m.start()]
    return t.strip(" -–—|:/,.")


@lru_cache(maxsize=65536)
def title_key(title):
    if is_medley(title):
        return None
    return phonetic(clean_title(title)) or None


@lru_cache(maxsize=65536)
def version_type(title):
    t = str(title or "")
    for label, rx in VERSION_TYPES:
        if rx.search(t):
            return label
    return ORIGINAL


@lru_cache(maxsize=65536)
def title_similarity(a, b):
    """0-100: whole titles, or one cleaned title inside the other ('Ae Phansa' / 'Aye Phansa Are Are Are …')."""
    whole = fuzz.ratio(phonetic(a), phonetic(b))
    ca, cb = phonetic(clean_title(a)), phonetic(clean_title(b))
    part = fuzz.partial_ratio(ca, cb) if min(len(ca), len(cb)) >= 6 else 0
    return round(max(whole, part, 100 if ca and ca == cb else 0))


def isrc_tokens(v):
    return list(OrderedDict.fromkeys(ISRC_RE.findall(str(v or "").upper().replace("-", ""))))


def album_key(album):
    """'Ghulami (Original Motion Picture Soundtrack)' -> key of 'Ghulami'."""
    a = re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", str(album or ""))
    a = re.split(r"\s+-\s+", a)[0]
    return phonetic(a)


# ---------------------------------------------------------------- people

HONORIFIC = re.compile(r"^(late|pt|pandit|dr|ustad|shri|sri|smt|kavi|sant|mr|mrs|ms)\.?\s+", re.I)
NAME_SPLIT = re.compile(r"\s*(?:,|;|\s&\s|\s/\s)\s*")
JUNK_NAMES = {"iprs", "prs", "ipi", "na", "nil", "none", "unknown", "various", "various artists", "test", "not available"}


@lru_cache(maxsize=131072)
def person_key(name):
    """Order- and spelling-free key of a name: 'BAKSHI, ANAND', 'Anand Bakshi' and 'Anand Bakhshi' agree."""
    text = re.sub(r"[^\w\s]+", " ", HONORIFIC.sub("", clean_text(name)))  # 'Laxmikant–Pyarelal' is two words
    words = [phonetic(w) for w in re.findall(r"[a-z]+", _ascii(text))]
    full = [w for w in words if len(w) > 1]
    return " ".join(sorted(full or words))


@lru_cache(maxsize=262144)
def same_person(a, b):
    """Keys of one person: equal, or every word of the shorter name is in the longer one ('Manoj Muntashir' and
    'Shukla Manoj Muntashir'); a one-word name must be distinctive (5+ letters) to count."""
    if not a or not b:
        return False
    if a == b or a.replace(" ", "") == b.replace(" ", ""):   # 'Anandbakshi' / 'Anand Bakshi'
        return True
    x, y = set(a.split()), set(b.split())
    small, big = (x, y) if len(x) <= len(y) else (y, x)
    return small <= big and (len(small) >= 2 or len(next(iter(small))) >= 5)


@lru_cache(maxsize=65536)
def is_junk_name(name):
    text = clean_text(name).lower()
    return text in JUNK_NAMES or bool(re.search(r"\d", text))


def split_names(v):
    if is_placeholder(v):
        return []
    return [n.strip() for n in NAME_SPLIT.split(str(v)) if n.strip() and not is_placeholder(n)]


class DSU:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, i):
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[max(a, b)] = min(a, b)


# ---------------------------------------------------------------- reading the DSP sheet

class DspFormatError(Exception):
    pass


COLUMNS = {
    "title": ["name of the song / title", "name of the song", "song title", "title", "song", "song name", "track",
              "track name", "track title"],
    "album": ["name of the album", "album", "album name", "release title"],
    "isrc": ["isrc", "isrc code", "isrcs"],
    "date": ["song release date", "release date", "date", "released"],
    "singer": ["singer", "singers", "vocalist", "vocals", "performer", "performers"],
    "main_artist": ["main artist (all)", "main artist", "artist", "artists", "primary artist"],
    "lyricist": ["lyricist", "lyricists", "lyrics", "lyrics by", "lyricist(s)"],
    "author": ["author", "authors", "author(s)"],
    "composer": ["composer", "composers", "composer(s)", "music", "music by", "music director"],
    "label": ["music label", "label", "record label"],
    "duration": ["duration (mm:ss)", "duration"],
    "link": ["song link", "link", "url", "track link"],
    "popularity": ["popularity (0-100)", "popularity"],
    "spotify_id": ["spotify track id", "spotify id"],
    "muso_id": ["muso track id"],
}
_ALIAS = {a: field for field, aliases in COLUMNS.items() for a in aliases}
# Sheets MRM-Extractor writes as results: never read as the source
OUTPUT_SHEETS = {"Summary", "Merged Songs", "Merge Suggestions", "Merged by Song", "Song Versions", "Merged by ISRC", "Coverage"}


def _columns(header):
    cols = {}
    for i, h in enumerate(header):
        field = _ALIAS.get(re.sub(r"\s+", " ", str(h or "")).strip().lower())
        if field and field not in cols:
            cols[field] = i
    return cols


def _txt(v):
    return "" if is_placeholder(v) else clean_text(v)


def _number(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _read_rows(ws, cols):
    rows = []
    for n, r in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        get = lambda f: r[cols[f]] if f in cols and cols[f] < len(r) else None
        title = _txt(get("title"))
        if not title:
            continue
        date = _txt(get("date"))
        rows.append({
            "row": n, "title": title, "album": _txt(get("album")), "isrcs": isrc_tokens(get("isrc")),
            "date": date, "year": date[:4] if re.match(r"\d{4}", date) else "",
            "singers": split_names(get("singer")) or split_names(get("main_artist")),
            "lyricists": split_names(get("lyricist")) + split_names(get("author")),
            "composers": split_names(get("composer")),
            "label": _txt(get("label")), "duration": _txt(get("duration")), "link": _txt(get("link")),
            "popularity": _number(get("popularity")), "spotify_id": _txt(get("spotify_id")), "muso_id": _txt(get("muso_id")),
        })
    return rows


def parse_dsp(path, sheet=None):
    """One DSP sheet from MRM-Extractor (Muso Credits, Apple Music Songs, Spotify Songs …). Without `sheet`, the
    sheet with the most songs carrying an ISRC is used; the others are listed so another can be chosen."""
    try:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except Exception:
        raise DspFormatError("Could not read the file. Upload the Excel (.xlsx) sheet from MRM-Extractor.")
    found = []
    for ws in wb.worksheets:
        if ws.title in OUTPUT_SHEETS:
            continue
        header = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), None) or ()
        cols = _columns(header)
        if "title" in cols and "isrc" in cols and not any("(duplicates)" in str(h or "").lower() for h in header):
            rows = _read_rows(ws, cols)
            found.append({"sheet": ws.title, "cols": cols, "rows": rows, "usable": sum(1 for r in rows if r["isrcs"])})
    wb.close()
    if not found:
        raise DspFormatError("No sheet has a song title and an ISRC column. Upload a Muso, Apple Music or Spotify sheet from MRM-Extractor.")
    sheets = [{"name": f["sheet"], "songs": f["usable"]} for f in found]
    if sheet:
        pick = next((f for f in found if f["sheet"] == sheet), None)
        if not pick:
            raise DspFormatError(f"Sheet '{sheet}' has no song title and ISRC columns.")
    else:
        pick = max(found, key=lambda f: f["usable"])
    if not pick["usable"]:
        raise DspFormatError(f"Sheet '{pick['sheet']}' has no songs with an ISRC.")
    links = " ".join(r["link"] for r in pick["rows"][:200]).lower()
    if "muso_id" in pick["cols"]:
        source = "Muso"
    elif "music.apple.com" in links or "apple" in pick["sheet"].lower():
        source = "Apple Music"
    elif "open.spotify.com" in links or "spotify" in pick["sheet"].lower():
        source = "Spotify"
    else:
        source = "DSP"
    return {"source": source, "sheet": pick["sheet"], "sheets": sheets, "rows": pick["rows"],
            "stats": {"rows": len(pick["rows"]), "with_isrc": pick["usable"]}}


# ---------------------------------------------------------------- the match

class People:
    """Name keys with reviewer-approved aliases, and who the client is."""

    def __init__(self, aliases, client_keys):
        self.aliases = aliases
        self.client_keys = client_keys
        self.client_words = {w for k in client_keys for w in k.split()}
        self._client = {}

    def key(self, name):
        k = person_key(name)
        return self.aliases.get(k, k)

    def is_client(self, k):
        if k not in self._client:
            words = set(k.split())
            self._client[k] = any(same_person(k, c) for c in self.client_keys) or (len(words) >= 2 and words <= self.client_words)
        return self._client[k]

    def writers(self, names):
        """{key: display} of the writers who are not the client (the client is on every song: no evidence)."""
        out = {}
        for n in names:
            if is_junk_name(n):
                continue
            k = self.key(n)
            if k and not self.is_client(k):
                out.setdefault(k, n)
        return out


def _agree(a, b):
    """First pair of names that is one person in both writer lists, or None."""
    for x in a:
        for y in b:
            if same_person(x, y):
                return a[x]
    return None


def _client_keys(lnv, client_name):
    """The client: the client's own name, plus any writer on half or more of the LNV's credited songs (a duo's
    members, or the name the LNV spells the client with)."""
    counts, credited = Counter(), 0
    for s in lnv:
        keys = {person_key(p["name"]) for kind in ("authors", "composers") for p in s.get(kind, []) if not is_junk_name(p["name"])}
        if keys:
            credited += 1
            counts.update(k for k in keys if k)
    keys = {k for k, n in counts.items() if credited and n >= 0.5 * credited}
    if client_name and person_key(client_name):
        keys.add(person_key(client_name))
    return keys


def _lnv_songs(master, people):
    out = []
    for s in master["songs"]:
        titles = [s["title"]] + list(alternate_titles(s.get("alt_title") or ""))
        names = [p["name"] for kind in ("authors", "composers") for p in s.get(kind, [])]
        out.append({
            "row": s["row"], "title": s["title"], "song": s, "movie": s.get("movie") or "",
            "tkeys": {k for k in (title_key(t) for t in titles) if k},
            "isrcs": set(s["isrcs"]), "writers": people.writers(names),
            "has_writers": bool(names), "film": album_key(s.get("movie") or ""),
            "version": version_type(s["title"]),
            "codes": dict(Counter(r["society"] for r in s["registrations"] if r["code"])),
        })
    return out


def _primary_order(rows, idxs):
    """Primary version first: untagged title, earliest release, most popular."""
    return sorted(idxs, key=lambda i: (version_type(rows[i]["title"]) != ORIGINAL, rows[i]["date"] or "9999",
                                       -(rows[i]["popularity"] or 0), i))


def _dsp_songs(rows, people, lyricist_keys=frozenset()):
    """DSP rows → recordings (shared ISRC / track ID) → songs (same title, writers not conflicting)."""
    n = len(rows)
    dsu, seen = DSU(n), {}
    for i, r in enumerate(rows):
        ids = [("isrc", t) for t in r["isrcs"]]
        ids += [(f, r[f]) for f in ("spotify_id", "muso_id") if r[f]]
        for k in ids:
            if k in seen:
                dsu.union(seen[k], i)
            else:
                seen[k] = i
    comps = OrderedDict()
    for i in range(n):
        comps.setdefault(dsu.find(i), []).append(i)
    writers = {root: people.writers([x for i in idxs for x in rows[i]["lyricists"] + rows[i]["composers"]])
               for root, idxs in comps.items()}
    by_title = defaultdict(list)
    for root, idxs in comps.items():
        for k in OrderedDict.fromkeys(title_key(rows[i]["title"]) for i in idxs):
            if k:
                by_title[k].append(root)
    for roots in by_title.values():
        clusters = []  # [writers, root]
        for r in sorted(roots, key=lambda r: -len(comps[r])):
            for cl in clusters:
                if not writers[r] or not cl[0] or _agree(writers[r], cl[0]):
                    dsu.union(cl[1], r)
                    cl[0].update(writers[r])
                    break
            else:
                clusters.append([dict(writers[r]), r])
    groups = OrderedDict()
    for i in range(n):
        groups.setdefault(dsu.find(i), []).append(i)

    songs = []
    for idxs in groups.values():
        idxs = _primary_order(rows, idxs)
        p = rows[idxs[0]]
        isrcs = list(OrderedDict.fromkeys(t for i in idxs for t in rows[i]["isrcs"]))
        lyricists = list(OrderedDict((person_key(x), x) for i in idxs for x in rows[i]["lyricists"]).values())
        composers = list(OrderedDict((person_key(x), x) for i in idxs for x in rows[i]["composers"]).values())
        all_writers = [people.key(x) for x in lyricists + composers if not is_junk_name(x)]
        lyric_keys = {people.key(x) for x in lyricists}
        # Recordings: one per ISRC (rows without one count on their own)
        recs = OrderedDict()
        for i in idxs:
            recs.setdefault(rows[i]["isrcs"][0] if rows[i]["isrcs"] else f"row{i}", i)
        years = sorted(rows[i]["year"] for i in idxs if rows[i]["year"])
        songs.append({
            "key": sorted(isrcs)[0] if isrcs else "T:" + (title_key(p["title"]) or str(p["row"])),
            "rows": idxs, "title": p["title"], "base": clean_title(p["title"]) or p["title"], "album": p["album"],
            "isrcs": isrcs, "primary_isrc": p["isrcs"][0] if p["isrcs"] else (isrcs[0] if isrcs else ""),
            "tkeys": {k for k in (title_key(rows[i]["title"]) for i in idxs) if k},
            "film": album_key(p["album"]), "writers": people.writers(lyricists + composers),
            "lyricists": lyricists, "composers": composers, "singers": p["singers"],
            "year": years[0] if years else "", "duration": p["duration"], "label": p["label"], "link": p["link"],
            "popularity": max((rows[i]["popularity"] or 0) for i in idxs),
            "versions": dict(Counter(version_type(rows[i]["title"]) for i in recs.values())),
            "recordings": len(recs),
            "client_writer": any(people.is_client(k) for k in all_writers),
            # Composers besides the client who are not also the lyricist: the client may be credited for an
            # interpolation, or the DSP has the credit wrong
            "other_composers": [x for x in composers if not is_junk_name(x) and not people.is_client(people.key(x))
                                and people.key(x) not in lyric_keys and people.key(x) not in lyricist_keys],
            "medley": is_medley(p["title"]),
        })
    for s in songs:
        s["credit"] = ("medley" if s["medley"] else "performer" if not s["client_writer"]
                       else "shared" if len(s["other_composers"]) >= 2 else "writer")
    return songs


# Link score out of 10
POINTS = {"isrc": 5, "title": 3, "similar_title": 2, "writer": 3, "film": 1, "writer_conflict": -4, "film_conflict": -1}
MATCH_AT = 6     # this score or more, with nothing conflicting: matched without review
CANDIDATE_AT = 3  # below this a candidate is dropped
MAX_CANDIDATES = 5


def _evaluate(s, l, ev):
    """Score and evidence of one DSP song ↔ LNV row link."""
    pts, why, flags = 0, [], []
    if ev.get("isrc"):
        pts += POINTS["isrc"]
        why.append(f"ISRC {ev['isrc']}")
    t = ev.get("title")
    if t == 100:
        pts += POINTS["title"]
        why.append("Same title")
    elif t:
        pts += POINTS["similar_title"]
        why.append(f"Similar title ({t}%)")
    agreed = _agree(s["writers"], l["writers"])
    if agreed:
        pts += POINTS["writer"]
        why.append(f"Writer {agreed}")
    elif s["writers"] and l["writers"]:
        pts += POINTS["writer_conflict"]
        flags.append(f"Writers differ – DSP: {', '.join(list(s['writers'].values())[:3])} · LNV: {', '.join(list(l['writers'].values())[:3])}")
    if s["film"] and l["film"]:
        if s["film"] == l["film"] or (min(len(s["film"]), len(l["film"])) >= 5 and (s["film"] in l["film"] or l["film"] in s["film"])):
            pts += POINTS["film"]
            why.append(f"Film / album {l['movie']}")
        elif not ev.get("isrc"):
            pts += POINTS["film_conflict"]
    if ev.get("isrc") and not t:
        if title_similarity(s["title"], l["title"]) < 60:
            flags.append(f"Same ISRC but a different title – the ISRC may be on the wrong song in the LNV ('{l['title']}')")
    return {"row": l["row"], "score": max(0, min(10, pts)), "points": pts, "evidence": why, "flags": flags}


def _candidates(s, lnv, index):
    by_isrc, by_title, by_block, by_film = index
    cand = defaultdict(dict)
    for t in s["isrcs"]:
        for j in by_isrc.get(t, ()):
            cand[j].setdefault("isrc", t)
    for j, ev in cand.items():   # same recording: a title the keys miss ('Payal Ki Jhankar Raste-Raste') still counts
        sim = title_similarity(s["title"], lnv[j]["title"])
        if sim >= 85:
            ev["title"] = 100 if sim == 100 else sim
    for k in s["tkeys"]:
        for j in by_title.get(k, ()):
            cand[j]["title"] = 100
        if len(k) >= 8:
            for k2 in by_block.get(k[:4], ()):
                if k2 in s["tkeys"]:
                    continue
                r = round(fuzz.ratio(k, k2))
                if r >= 89:
                    for j in by_title[k2]:
                        cand[j]["title"] = max(cand[j].get("title") or 0, r) if cand[j].get("title") != 100 else 100
    # Same film: one title can be the start of the other ('Zeehale Muskin' / 'Zeehal E Maskin Makun Baranjish')
    if s["film"]:
        for j in by_film.get(s["film"], ()):
            if cand.get(j, {}).get("title"):
                continue
            best = max((round(fuzz.partial_ratio(a, b)) for a in s["tkeys"] for b in lnv[j]["tkeys"]
                        if min(len(a), len(b)) >= 8), default=0)
            if best >= 88:
                cand[j]["title"] = min(best, 99)
    return cand


def match(master, dsp, client_name="", aliases=None, links=None):
    """Compare the LNV (parse_master result) with one DSP sheet (parse_dsp result).
    aliases: {name key: canonical key} from "same person" decisions.
    links: {DSP song key: {"choice": "same" | "none", "rows": [LNV rows]}} from link decisions."""
    aliases, links = aliases or {}, links or {}
    people = People(aliases, _client_keys(master["songs"], client_name))
    lnv = _lnv_songs(master, people)
    by_row = {l["row"]: j for j, l in enumerate(lnv)}
    # Anyone credited as a lyricist anywhere (Muso often repeats the lyricist under composers) is not a rival composer
    lyricist_keys = {people.key(x) for r in dsp["rows"] for x in r["lyricists"]} \
        | {people.key(p["name"]) for l in lnv for p in l["song"].get("authors", [])}
    songs = _dsp_songs(dsp["rows"], people, lyricist_keys)
    lnv_titles = Counter(k for l in lnv for k in l["tkeys"])
    dsp_titles = Counter(k for s in songs for k in s["tkeys"])
    conflict_keys = set()   # writers whose spelling keeps a link open: only these name pairs are worth asking

    by_isrc, by_title, by_block, by_film = defaultdict(list), defaultdict(list), defaultdict(set), defaultdict(list)
    for j, l in enumerate(lnv):
        for t in l["isrcs"]:
            by_isrc[t].append(j)
        for k in l["tkeys"]:
            by_title[k].append(j)
            by_block[k[:4]].add(k)
        if l["film"]:
            by_film[l["film"]].append(j)
    index = (by_isrc, by_title, by_block, by_film)

    matched, check, unmatched = [], [], []
    lnv_links = defaultdict(list)   # LNV index -> [(song index, link)]
    for si, s in enumerate(songs):
        decided = links.get(s["key"])
        cands = sorted((_evaluate(s, lnv[j], ev) for j, ev in _candidates(s, lnv, index).items()),
                       key=lambda c: (-c["points"], c["row"]))
        cands = [c for c in cands if c["points"] >= CANDIDATE_AT or c["evidence"][0:1] and c["evidence"][0].startswith("ISRC")]
        if decided:
            if decided["choice"] == "none":
                s["decided"] = True
                unmatched.append(si)
                continue
            known = {c["row"]: c for c in cands}
            chosen = [known.get(r) or {"row": r, "score": 0, "points": 0, "evidence": [], "flags": []}
                      for r in decided.get("rows", []) if r in by_row]
            if chosen:
                for c in chosen:
                    c["confirmed"] = True
                    lnv_links[by_row[c["row"]]].append((si, c))
                matched.append({"song": si, "links": chosen, "confirmed": True})
                continue
        strong = [c for c in cands if c["points"] >= MATCH_AT and not c["flags"]]
        if not strong:
            unique = len(cands) == 1 and all(lnv_titles[k] == 1 and dsp_titles[k] == 1 for k in s["tkeys"] & lnv[by_row[cands[0]["row"]]]["tkeys"])
            sure = next(((c, why) for c in cands for why in [_certain(s, c, lnv[by_row[c["row"]]], unique)] if why), None)
            if sure:
                c, why = sure
                c["auto"], c["notes"], c["flags"] = why, c["flags"], []
                strong = [c]
        if strong:
            for c in strong:
                lnv_links[by_row[c["row"]]].append((si, c))
            matched.append({"song": si, "links": strong, "confirmed": False})
        elif cands:
            check.append({"song": si, "candidates": cands[:MAX_CANDIDATES]})
            for c in cands[:MAX_CANDIDATES]:
                if any(f.startswith("Writers differ") for f in c["flags"]):
                    conflict_keys.update(s["writers"], lnv[by_row[c["row"]]]["writers"])
        else:
            unmatched.append(si)

    return _report(lnv, songs, matched, check, unmatched, lnv_links, people, dsp, conflict_keys)


def _certain(s, c, l, unique):
    """Why a link the score left open is still certain, or None: the app answers it and says why."""
    if any("different title" in f for f in c["flags"]):
        return None
    ev = " ".join(c["evidence"])
    sim = title_similarity(s["title"], l["title"])
    if ev.startswith("ISRC") and sim >= 85:
        return "Same ISRC and title – the same recording"
    if "Same title" in ev and "Writer" in ev:
        return "Same title and same writer"
    if "Similar title" in ev and "Writer" in ev and sim >= 90:
        return "Almost the same title and same writer"
    if unique and "Same title" in ev and not c["flags"]:
        return "Same title, and no other song in either sheet has it"
    return None


# ---------------------------------------------------------------- the queues

def _lnv_brief(l):
    s = l["song"]
    return {"row": l["row"], "title": l["title"], "movie": l["movie"], "isrcs": sorted(l["isrcs"]),
            "writers": [p["name"] for kind in ("authors", "composers") for p in s.get(kind, [])][:6],
            "year": s.get("release_year") or "", "codes": l["codes"], "has_writers": l["has_writers"]}


def _song_brief(s):
    return {"key": s["key"], "title": s["title"], "album": s["album"], "isrcs": s["isrcs"][:6], "isrc_count": len(s["isrcs"]),
            "lyricists": s["lyricists"][:5], "composers": s["composers"][:6], "singers": s["singers"][:5],
            "year": s["year"], "popularity": s["popularity"], "versions": s["versions"], "recordings": s["recordings"],
            "link": s["link"], "client_writer": s["client_writer"], "other_composers": s["other_composers"][:5],
            "credit": s["credit"]}


def _filled(l):
    s = l["song"]
    return (bool(l["isrcs"]) * 2 + bool(l["has_writers"]) * 2 + sum(l["codes"].values()) * 2
            + sum(1 for f in ("movie", "release_year", "duration", "label", "language") if s.get(f)))


def _duplicates(lnv, lnv_links, songs):
    """LNV rows that look like one song: same ISRC, same DSP song, or same title with an agreeing writer."""
    dsu = DSU(len(lnv))
    reasons = defaultdict(list)   # frozenset(pair) -> reasons
    wrong_isrc = []

    def join(a, b, why):
        dsu.union(a, b)
        reasons[frozenset((a, b))].append(why)

    by_isrc = defaultdict(list)
    for j, l in enumerate(lnv):
        for t in l["isrcs"]:
            by_isrc[t].append(j)
    alike = lambda a, b: bool(lnv[a]["tkeys"] & lnv[b]["tkeys"]) or title_similarity(lnv[a]["title"], lnv[b]["title"]) >= 85
    for t, js in by_isrc.items():
        for x in range(len(js)):
            for y in range(x + 1, len(js)):
                a, b = js[x], js[y]
                if alike(a, b):
                    join(a, b, f"Same ISRC {t}")
                elif title_similarity(lnv[a]["title"], lnv[b]["title"]) < 60:
                    # Not a duplicate: a case of its own, so it never pulls other songs together
                    wrong_isrc.append((a, b, t))
    by_song = defaultdict(list)
    for j, ls in lnv_links.items():
        for si, _ in ls:
            by_song[si].append(j)
    for si, js in by_song.items():
        for x in range(len(js)):
            for y in range(x + 1, len(js)):
                a, b = js[x], js[y]
                if lnv[a]["version"] == lnv[b]["version"] and alike(a, b):
                    join(a, b, f"Both match the {songs[si]['title']!r} DSP song")
    by_title = defaultdict(list)
    for j, l in enumerate(lnv):
        for k in l["tkeys"]:
            by_title[k].append(j)
    for js in by_title.values():
        if len(js) < 2 or len(js) > 40:   # a very common title ('Title Song') says nothing on its own
            continue
        for x in range(len(js)):
            for y in range(x + 1, len(js)):
                a, b = lnv[js[x]], lnv[js[y]]
                if a["version"] != b["version"]:
                    continue
                who = _agree(a["writers"], b["writers"])
                if who:
                    join(js[x], js[y], f"Same title and writer {who}")

    groups = defaultdict(list)
    for j in range(len(lnv)):
        groups[dsu.find(j)].append(j)
    cases = []
    for js in groups.values():
        if len(js) < 2:
            continue
        keeper = max(js, key=lambda j: (_filled(lnv[j]), -lnv[j]["row"]))
        why = list(OrderedDict.fromkeys(w for pair, ws in reasons.items() if pair <= set(js) for w in ws))
        rows = sorted(js, key=lambda j: (j != keeper, lnv[j]["row"]))
        films = {lnv[j]["film"] for j in js if lnv[j]["film"]}
        sure = any(w.startswith("Same ISRC ") for w in why) and "same ISRC" \
            or any(w.startswith("Both match") for w in why) and len(films) <= 1 and "same song on the export, same film"
        cases.append({
            "key": "dup:" + "-".join(str(lnv[j]["row"]) for j in sorted(js, key=lambda j: lnv[j]["row"])),
            "kind": "duplicate", "title": lnv[keeper]["title"], "keeper": lnv[keeper]["row"], "reasons": why[:8],
            "rows": [_lnv_brief(lnv[j]) for j in rows],
            **({"auto": {"choice": "duplicate", "data": {"keep": lnv[keeper]["row"]},
                         "why": f"Certain: {sure}. Keeps row {lnv[keeper]['row']}, the most complete one"}} if sure else {}),
        })
    for a, b, t in wrong_isrc:
        a, b = sorted((a, b), key=lambda j: lnv[j]["row"])
        cases.append({
            "key": f"isrc:{t}:{lnv[a]['row']}-{lnv[b]['row']}", "kind": "wrong_isrc", "title": lnv[a]["title"], "keeper": None,
            "reasons": [f"Same ISRC {t} on two different songs – it belongs to only one of them"],
            "rows": [_lnv_brief(lnv[a]), _lnv_brief(lnv[b])],
        })
    cases.sort(key=lambda c: (c["kind"] != "wrong_isrc", -len(c["rows"]), c["title"].lower()))
    return cases


def _names(lnv, songs, people, conflict_keys=frozenset()):
    """Spellings of one person that do not match on their own ('Malik Verma' / 'Malik Varma'), and junk names."""
    seen = defaultdict(lambda: {"spellings": Counter(), "lnv": 0, "dsp": 0, "songs": []})
    junk = defaultdict(lambda: {"rows": [], "count": 0})

    def add(name, side, title):
        if is_junk_name(name):
            j = junk[clean_text(name)]
            j["count"] += 1
            if len(j["rows"]) < 5:
                j["rows"].append(title)
            return
        k = people.key(name)
        if not k:
            return
        e = seen[k]
        e["spellings"][clean_text(name)] += 1
        e[side] += 1
        if len(e["songs"]) < 3 and title not in e["songs"]:
            e["songs"].append(title)

    for l in lnv:
        for kind in ("authors", "composers", "singers"):
            for p in l["song"].get(kind, []):
                add(p["name"], "lnv", l["title"])
    for s in songs:
        for n in OrderedDict.fromkeys(s["lyricists"] + s["composers"] + s["singers"]):
            add(n, "dsp", s["title"])

    keys = sorted(seen)
    blocks = defaultdict(set)
    for k in keys:
        blocks[k[:2]].add(k)
        blocks["L" + max(k.split(), key=len)[:3]].add(k)
    pairs = {}
    for ks in blocks.values():
        ks = sorted(ks)
        for x in range(len(ks)):
            for y in range(x + 1, len(ks)):
                a, b = ks[x], ks[y]
                if same_person(a, b) or min(len(a), len(b)) < 6:
                    continue
                flat = fuzz.ratio(a.replace(" ", ""), b.replace(" ", ""))
                if flat >= 88 and abs(len(a.split()) - len(b.split())) <= 1:
                    pairs[(a, b)] = round(flat)
    out = []
    for (a, b), sim in pairs.items():
        ea, eb = seen[a], seen[b]
        if ea["lnv"] + ea["dsp"] < eb["lnv"] + eb["dsp"]:
            a, b, ea, eb = b, a, eb, ea   # the commoner spelling first
        side = lambda e: {"spelling": e["spellings"].most_common(1)[0][0], "spellings": [s for s, _ in e["spellings"].most_common(4)],
                          "lnv": e["lnv"], "dsp": e["dsp"], "songs": e["songs"]}
        out.append({"key": "name:" + "|".join(sorted((a, b))), "kind": "spelling", "a_key": a, "b_key": b,
                    "similarity": sim, "a": side(ea), "b": side(eb),
                    "client": people.is_client(a) or people.is_client(b),
                    # Spellings that change no match are only listed for information
                    "info": not any(same_person(k, c) for k in (a, b) for c in conflict_keys)})
    out.sort(key=lambda p: (p["info"], -(p["a"]["lnv"] + p["a"]["dsp"] + p["b"]["lnv"] + p["b"]["dsp"])))
    for name, j in sorted(junk.items(), key=lambda x: -x[1]["count"]):
        out.append({"key": "junk:" + name.lower(), "kind": "junk", "name": name, "count": j["count"], "songs": j["rows"]})
    return out


def _duration(v):
    """'4:21' -> '00:04:21' as the LNV writes durations."""
    m = re.fullmatch(r"(\d+):(\d{2})", v or "")
    return f"00:{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def _fills(lnv, songs, lnv_links):
    """Blank LNV fields the matched DSP song can fill."""
    out = []
    for j, ls in lnv_links.items():
        l, s_ = lnv[j], lnv[j]["song"]
        si, link = max(ls, key=lambda x: x[1]["points"])
        s = songs[si]
        offers = [
            ("ISRC", not l["isrcs"], s["primary_isrc"]),
            ("Release year", not s_.get("release_year"), s["year"]),
            ("Duration", not s_.get("duration"), _duration(s["duration"])),
            ("Label", not s_.get("label"), s["label"]),
            ("Movie / album", not s_.get("movie"), re.sub(r"\s*\((original|from).*$", "", s["album"], flags=re.I).strip()),
            ("Singers", not s_.get("singers"), ", ".join(s["singers"][:6])),
            ("Lyricists", not s_.get("authors"), ", ".join(s["lyricists"][:6])),
            ("Composers", not s_.get("composers"), ", ".join(s["composers"][:6])),
        ]
        for field, blank, value in offers:
            if blank and value:
                out.append({"key": f"fill:{l['row']}:{field}", "row": l["row"], "title": l["title"], "field": field,
                            "value": value, "song": s["title"], "song_key": s["key"], "score": link["score"],
                            "more": len(s["isrcs"]) - 1 if field == "ISRC" else 0,
                            "auto": {"choice": "accept", "why": f"Empty in the LNV; {field.lower()} of the matched song"}})
    out.sort(key=lambda f: (f["row"], f["field"]))
    return out


def _report(lnv, songs, matched, check, unmatched, lnv_links, people, dsp, conflict_keys=frozenset()):
    briefs = {}

    def song(si):
        if si not in briefs:
            briefs[si] = _song_brief(songs[si])
        return briefs[si]

    by_row = {l["row"]: l for l in lnv}
    with_lnv = lambda c: {**c, "lnv": _lnv_brief(by_row[c["row"]])}
    duplicates = _duplicates(lnv, lnv_links, songs)
    names = _names(lnv, songs, people, conflict_keys)
    missing = [{**song(si), "key": "missing:" + songs[si]["key"], "song_key": songs[si]["key"],
                "rejected": bool(songs[si].get("decided")),
                **({"auto": {"choice": "add", "why": "The client is the only composer credited and it is an original song"}}
                   if songs[si]["credit"] == "writer" and not songs[si]["other_composers"] and ORIGINAL in songs[si]["versions"]
                   and not songs[si].get("decided") else {})}
               for si in unmatched]
    credit_order = {"writer": 0, "shared": 1, "medley": 2, "performer": 3}
    missing.sort(key=lambda m: (credit_order[m["credit"]], -m["popularity"], m["title"].lower()))
    fills = _fills(lnv, songs, lnv_links)
    check_items = [{"key": "link:" + songs[c["song"]]["key"], "song": song(c["song"]),
                    "candidates": [with_lnv(x) for x in c["candidates"]],
                    "flagged": any(x["flags"] for x in c["candidates"])} for c in check]
    check_items.sort(key=lambda c: (not c["flagged"], -c["candidates"][0]["points"], -c["song"]["popularity"]))
    matched_items = [{"key": "link:" + songs[m["song"]]["key"], "song": song(m["song"]), "confirmed": m["confirmed"],
                      "links": [with_lnv(x) for x in m["links"]], "auto": next((x["auto"] for x in m["links"] if x.get("auto")), None),
                      "notes": [f for x in m["links"] for f in x.get("notes", [])]} for m in matched]
    matched_items.sort(key=lambda m: -m["song"]["popularity"])

    rows_matched = len(lnv_links)
    client_names = sorted({sp for l in lnv for kind in ("authors", "composers") for p in l["song"].get(kind, [])
                           for sp in [p["name"]] if people.is_client(people.key(sp))})[:8]
    return {
        "source": {"name": dsp["source"], "sheet": dsp["sheet"], "sheets": dsp["sheets"], "rows": len(dsp["rows"]),
                   "recordings": sum(s["recordings"] for s in songs), "songs": len(songs),
                   "versions": dict(Counter(v for s in songs for v, n in s["versions"].items() for _ in range(n)).most_common())},
        "lnv": {"songs": len(lnv), "with_writers": sum(1 for l in lnv if l["has_writers"]),
                "with_isrc": sum(1 for l in lnv if l["isrcs"])},
        "client_names": client_names,
        "summary": {
            "songs": len(songs), "matched": len(matched), "check": len(check), "unmatched": len(unmatched),
            "missing_writer": sum(1 for m in missing if m["credit"] == "writer"),
            "missing_credit": dict(Counter(m["credit"] for m in missing)),
            "lnv_rows_matched": rows_matched, "lnv_not_on_dsp": len(lnv) - rows_matched,
            "duplicates": len(duplicates), "duplicate_rows": sum(len(c["rows"]) for c in duplicates),
            "names": len(names), "fills": len(fills),
            "writers_differ": sum(1 for m in matched_items if m["notes"]),
        },
        "matched": matched_items, "check": check_items, "missing": missing, "duplicates": duplicates,
        "names": names, "fills": fills,
    }


QUEUES = ("duplicates", "names", "missing", "fills", "check")


def apply_decisions(result, decisions):
    """Each queue item gets the reviewer's decision ({choice, data}) and the summary counts what is still open.
    decisions: {item key: {"choice": ..., "data": {...}}}."""
    out = dict(result)
    open_counts, auto_counts = {}, {}
    for q in QUEUES + ("matched",):
        items = []
        for item in result[q]:
            d = decisions.get(item["key"])
            if d:
                items.append({**item, "decision": d})
            elif q != "matched" and item.get("auto"):
                items.append({**item, "decision": {**item["auto"], "auto": True}})
            else:
                items.append(item)
        out[q] = items
        asked = [i for i in items if not i.get("info") and not i.get("rejected") and (q != "missing" or i["credit"] == "writer")]
        open_counts[q] = sum(1 for i in asked if not i.get("decision"))
        auto_counts[q] = sum(1 for i in asked if (i.get("decision") or {}).get("auto"))
    out["open"] = open_counts
    out["auto"] = auto_counts
    out["decided"] = sum(1 for k in decisions if k.split(":", 1)[0] in ("dup", "name", "junk", "missing", "fill", "link"))
    return out


def learned(decisions):
    """What decisions feed back into the match: name aliases and link choices."""
    aliases, links = {}, {}
    parent = {}

    def find(k):
        while parent.get(k, k) != k:
            k = parent[k]
        return k
    for key, d in sorted(decisions.items()):
        if key.startswith("name:") and d["choice"] == "same":
            a, b = key[5:].split("|", 1)
            keep = (d.get("data") or {}).get("keep") or a
            other = b if keep == a else a
            ra, rb = find(keep), find(other)
            if ra != rb:
                parent[rb] = ra
        elif key.startswith("link:") and d["choice"] in ("same", "none"):
            links[key[5:]] = {"choice": d["choice"], "rows": [int(r) for r in (d.get("data") or {}).get("rows", [])]}
    for k in list(parent):
        aliases[k] = find(k)
    return aliases, links


def summary_counts(result):
    """Headline numbers kept on the DSP file so the client page shows them without re-running the match."""
    return {**result["summary"], "open": result["open"], "source": result["source"]["name"]}
