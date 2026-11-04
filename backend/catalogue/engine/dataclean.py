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

from rapidfuzz import fuzz

from .normalize import alternate_titles, clean_text
from .xlsx import Book

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
    "dance", "rework", "rewind", "2.0", "3.0", "dialogue", "part", "pt", "bpm",
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
    if " " in a + b and len(a) >= 10 and sorted(a.replace(" ", "")) == sorted(b.replace(" ", "")):   # 'Shivkumar' / 'Shiv Kumar'
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
    "publisher": ["publisher", "publishers", "publisher(s)"],
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


def _read_rows(sheet_rows, cols):
    rows = []
    for n, r in enumerate(sheet_rows[1:], start=2):
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
            "publishers": split_names(get("publisher")),
            "cells": tuple(r),
        })
    return rows


def parse_dsp(path, sheet=None):
    """One DSP sheet from MRM-Extractor (Muso Credits, Apple Music Songs, Spotify Songs …). Without `sheet`, the
    sheet with the most songs carrying an ISRC is used; the others are listed so another can be chosen."""
    try:
        book = Book(path)
    except Exception:
        raise DspFormatError("Could not read the file. Upload the Excel (.xlsx) sheet from MRM-Extractor.")
    found = []
    with book:
        for title in book.sheetnames:
            if title in OUTPUT_SHEETS:
                continue
            sheet_rows = book.rows(title)
            header = sheet_rows[0] if sheet_rows else ()
            cols = _columns(header)
            if "title" in cols and "isrc" in cols and not any("(duplicates)" in str(h or "").lower() for h in header):
                rows = _read_rows(sheet_rows, cols)
                found.append({"sheet": title, "cols": cols, "rows": rows, "header": [str(h or "").strip() for h in header],
                              "usable": sum(1 for r in rows if r["isrcs"])})
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
    return {"source": source, "sheet": pick["sheet"], "sheets": sheets, "rows": pick["rows"], "header": pick["header"],
            "stats": {"rows": len(pick["rows"]), "with_isrc": pick["usable"]}}


# ---------------------------------------------------------------- the match

# Composer groups credited under one name: the group is its members ("Shankar-Ehsaan-Loy" = the three of them)
GROUPS = {
    "Shankar-Ehsaan-Loy": ["Shankar Mahadevan", "Ehsaan Noorani", "Loy Mendonsa"],
    "Laxmikant-Pyarelal": ["Laxmikant Kudalkar", "Pyarelal Sharma"],
    "Jatin-Lalit": ["Jatin Pandit", "Lalit Pandit"],
    "Vishal-Shekhar": ["Vishal Dadlani", "Shekhar Ravjiani"],
    "Shiv-Hari": ["Shivkumar Sharma", "Hariprasad Chaurasia"],
    "Salim-Sulaiman": ["Salim Merchant", "Sulaiman Merchant"],
    "Sajid-Wajid": ["Sajid Khan", "Wajid Khan"],
    "Nadeem-Shravan": ["Nadeem Saifi", "Shravan Rathod"],
    "Anand-Milind": ["Anand Chitragupt", "Milind Chitragupt"],
    "Kalyanji-Anandji": ["Kalyanji Virji Shah", "Anandji Virji Shah"],
    "Shankar-Jaikishan": ["Shankar Singh Raghuvanshi", "Jaikishan Dayabhai Panchal"],
    "Sachin-Jigar": ["Sachin Sanghvi", "Jigar Saraiya"],
    "Ajay-Atul": ["Ajay Gogavale", "Atul Gogavale"],
    "Meet Bros": ["Manmeet Singh", "Harmeet Singh"],
    "Sonik-Omi": ["Master Sonik", "Om Prakash Sonik"],
}
# One person under the name the DSPs use and the full name the LNV and IPRS use – known facts, not guesses
KNOWN_SAME = {
    "Loy Mendonsa": ["Aloysuis Peter Mendonsa", "Aloysius Peter Mendonsa", "Aloysius Mendonsa", "Aloysuis Mendonsa"],
}

# Publishers: the same company is written many ways ("Saregama India Ltd" / "SAREGAMA PLC"); its first distinctive
# word is the key. Renamed or bought companies map onto today's name; collecting societies are not publishers.
PUB_GENERIC = {"the", "m", "s", "messrs", "music", "musics", "india", "indian", "records", "recording", "recordings", "tapes",
               "entertainment", "entertainments", "enterprises", "publishing", "publishers", "publisher", "pub", "pvt",
               "private", "ltd", "limited", "plc", "inc", "llp", "llc", "co", "company", "corp", "corporation", "songs",
               "industries", "media", "digital", "and", "of", "worldwide", "group", "international"}
PUB_ALIASES = {"tseries": "super", "hmv": "saregama", "gramophone": "saregama", "yrf": "yash", "sme": "sony",
               "venus": "ishtar", "musicindia": "universal", "polygram": "universal", "mgb": "universal"}
LEGAL = {"the", "m", "s", "pvt", "private", "ltd", "limited", "plc", "inc", "llp", "llc", "co", "company", "corp"}
NOT_PUBLISHERS = {"iprs", "prs", "ipi", "ascap", "bmi", "socan", "na", "unknown", "none", "self", "independent"}


@lru_cache(maxsize=8192)
def publisher_key(name):
    words = re.findall(r"[a-z0-9]+", _ascii(clean_text(name)).replace("-", "").replace("'", ""))
    if not words or "".join(words) in NOT_PUBLISHERS:
        return ""
    own = [w for w in words if w not in PUB_GENERIC]
    key = own[0] if own else "".join(w for w in words if w not in LEGAL)   # 'Music India Ltd' -> 'musicindia'

    return PUB_ALIASES.get(key, key)


def _alike(a, b):
    """Two name keys worth asking about: they share a word (a surname) or are spelled almost alike."""
    return bool({w for w in a.split() if len(w) >= 3} & {w for w in b.split() if len(w) >= 3}) \
        or fuzz.ratio(a.replace(" ", ""), b.replace(" ", "")) >= 80


def same_people(a, b):
    """Two writer lists are the same people: every name on each side is someone on the other side."""
    return all(any(same_person(x, y) for y in b) for x in a) and all(any(same_person(x, y) for x in a) for y in b)


def work_check(s, l):
    """The rule for one DSP song and one LNV row being the same work: the same writers (lyricists and composers,
    as people – a DSP-only name that is also the song's singer aside) and at least one shared publisher. writers: same · differ · blank (missing is not matching);
    publisher: same · differ · unchecked (a side has none)."""
    if not s["people"] or not l["people"]:
        writers = "blank"
    elif same_people(s["people"], l["people"]):
        writers = "same"
    else:
        # The DSP often lists a song's singers among its composers: a DSP-only name that also sings this very song
        # does not make it another work, as long as every LNV writer is on the DSP side
        extra = [k for k in s["people"] if not any(same_person(k, y) for y in l["people"])]
        writers = "same" if extra and all(any(same_person(y, x) for x in s["people"]) for y in l["people"]) \
            and all(any(same_person(k, x) for x in s.get("aside", ())) for k in extra) else "differ"
    if not s["pubkeys"] or not l["pubkeys"]:
        publisher = "unchecked"
    else:
        publisher = "same" if s["pubkeys"] & l["pubkeys"] else "differ"
    return writers, publisher


class People:
    """Name keys with reviewer-approved aliases, and who the client is."""

    def __init__(self, aliases, client_keys, rules=None):
        self.aliases = dict(aliases)
        for name, others in KNOWN_SAME.items():   # the reviewer's answers win; these only fill in
            for other in others:
                self.aliases.setdefault(person_key(other), self.aliases.get(person_key(name), person_key(name)))
        rules = rules or {}
        self.ignore = set(rules.get("ignore", ()))      # DSP writer names that are not writers ("Raju Singh")
        self.pubs = dict(rules.get("pubs", {}))          # publisher keys that are one company ("big" -> "super")
        self.groups = {person_key(g): members for g, members in GROUPS.items()}
        self.client_keys = client_keys
        self.client_words = {w for k in client_keys for w in k.split()}
        self._client = {}

    def key(self, name):
        k = person_key(name)
        return self.aliases.get(k, k)

    def pub(self, name):
        k = publisher_key(name)
        return self.pubs.get(k, k)

    def is_client(self, k):
        if k not in self._client:
            words = set(k.split())
            self._client[k] = any(same_person(k, c) for c in self.client_keys) or (len(words) >= 2 and words <= self.client_words)
        return self._client[k]

    def work(self, names):
        """{key: display} of every writer, the client too, with groups as their members – who wrote the work."""
        out = {}
        for n in names:
            if is_junk_name(n):
                continue
            k = self.key(n)
            for name in self.groups.get(person_key(n), [n]) if k else []:
                out.setdefault(self.key(name), name)
        return out

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
            "people": people.work(names), "pubkeys": {k for p in s.get("publishers", []) if (k := people.pub(p["name"]))},
            "version": version_type(s["title"]), "year": str(s.get("release_year") or "")[:4],
            "codes": dict(Counter(r["society"] for r in s["registrations"] if r["code"])),
        })
    return out


def _primary_order(rows, idxs):
    """Primary version first: untagged title, earliest release, most popular."""
    return sorted(idxs, key=lambda i: (version_type(rows[i]["title"]) != ORIGINAL, rows[i]["date"] or "9999",
                                       -(rows[i]["popularity"] or 0), i))


MEDLEY = "Medley / Mashup"
REISSUE = "Re-release"   # the untagged title on another album, under another ISRC: a recording of its own


def _part(rows, idxs, kind):
    """One LNV row's worth of a song's recordings: the original, or one version."""
    p = rows[idxs[0]]
    years = sorted(rows[i]["year"] for i in idxs if rows[i]["year"])
    return {"type": kind, "title": p["title"], "album": p["album"], "rows": idxs, "sheet": [rows[i]["row"] for i in idxs],
            "isrcs": list(OrderedDict.fromkeys(t for i in idxs for t in rows[i]["isrcs"])),
            "year": years[0] if years else "", "duration": p["duration"], "label": p["label"], "singers": p["singers"][:6],
            "lnv_row": None}


def _parts(rows, idxs):
    """A song's recordings the way the LNV keeps them (the user's rule: the recording the LNV has is the original, every
    other recording a new row naming it): the original – the untagged title on its first album, with the copies on
    that album – is the song's own row; the untagged title on another album (a re-release, a cover series, a
    compilation under its own ISRC) and each tagged version (remix, lofi, sad version …) are rows of their own,
    recordings with one title together. Medleys hold other songs too: never a version row. idxs in primary order."""
    recs = OrderedDict()
    for i in idxs:
        recs.setdefault(rows[i]["isrcs"][0] if rows[i]["isrcs"] else f"row{i}", []).append(i)
    albums, versions = OrderedDict(), OrderedDict()
    for members in recs.values():
        title = rows[members[0]]["title"]
        kind = version_type(title)
        if kind == ORIGINAL:
            album = album_full(rows[members[0]]["album"])
            key = next((k for k in albums if k == album or _same_album(rows[albums[k][0]]["album"], rows[members[0]]["album"])), album)
            albums.setdefault(key, []).extend(members)
        elif kind != MEDLEY:
            versions.setdefault(phonetic(title), (kind, []))[1].extend(members)
    groups = list(albums.values())
    original = _part(rows, groups[0], ORIGINAL) if groups else None
    return original, [_part(rows, m, REISSUE) for m in groups[1:]] + [_part(rows, m, k) for k, m in versions.values()]


def _home_first(s, cands):
    """The recording the LNV has is the song's original (the user's rule): when the LNV matches one of the song's
    re-releases and not its first album, that re-release becomes the original and the first album a re-release."""
    rank = {"exact": 0, "possible": 1}
    vias = [c["rec"]["via"] for c in sorted(cands, key=lambda c: rank.get(c["rec"]["level"], 9)) if c["rec"]["level"] in rank]
    o = s.get("original")
    if not o or not vias or any(v in o["sheet"] for v in vias):
        return
    for v in vias:
        k = next((k for k, p in enumerate(s["parts"]) if p["type"] == REISSUE and v in p["sheet"]), None)
        if k is not None:
            s["original"], s["parts"][k] = {**s["parts"][k], "type": ORIGINAL}, {**o, "type": REISSUE}
            return


def version_id(part):
    """A version's decision key: its first ISRC, else its title."""
    return "version:" + (part["isrcs"][0] if part["isrcs"] else "T" + phonetic(part["title"]))


def _version_rows(s, cands, lnv, by_row, answers=None):
    """The LNV row each version of the song already is: the row holding one of its ISRCs (whatever its title – an
    ISRC is never put in the LNV twice), else a row of the same version (the same tag in its title) with the same
    title, whose writers are not other people – a remixer the LNV adds is fine – or the only one of that kind on both
    sides with the same writers. answers: {version key: {"choice": same | none, "rows": [..]}} – the reviewer's word;
    a row they turned down is never that version again."""
    answers, used = answers or {}, set()
    for part in s["parts"]:
        part["key"] = version_id(part)
        a = answers.get(part["key"]) or {}
        part["refused"] = a.get("rows", []) if a.get("choice") == "none" else []
        part["confirmed"] = a.get("choice") == "same"
    ok = lambda part, c: c["row"] not in used and c["row"] not in part["refused"]
    for part in s["parts"]:
        for c in cands:
            if ok(part, c) and set(part["isrcs"]) & lnv[by_row[c["row"]]]["isrcs"]:
                part["lnv_row"] = c["row"]
                used.add(c["row"])
                break
    kinds = Counter(p["type"] for p in s["parts"])
    home_album = (s.get("original") or {}).get("album")
    for part in s["parts"]:
        if part["lnv_row"]:
            continue
        if part["type"] == REISSUE:   # never the original's own row: the same title on this re-release's album only
            l_of = lambda c: lnv[by_row[c["row"]]]
            pick = next((c for c in cands if ok(part, c) and c["title"] and l_of(c)["version"] == ORIGINAL
                         and _same_album(part["album"], l_of(c)["movie"]) and not (home_album and _same_album(home_album, l_of(c)["movie"]))), None)
            if pick:
                part["lnv_row"] = pick["row"]
                used.add(pick["row"])
            continue
        alike = [c for c in cands if ok(part, c) and lnv[by_row[c["row"]]]["version"] == part["type"]]
        same = [c for c in alike if (c["writers"] != "differ" or not c["odd"][0])
                and fuzz.ratio(phonetic(part["title"]), phonetic(lnv[by_row[c["row"]]]["title"])) >= 90]
        alike = [c for c in alike if c["writers"] != "differ"]
        pick = same[0] if same else alike[0] if len(alike) == 1 and kinds[part["type"]] == 1 else None
        if pick:
            part["lnv_row"] = pick["row"]
            used.add(pick["row"])
    return used


def _recordings(rows, idxs, people):
    """A song's recordings (rows sharing an ISRC), each with its own credits: an LNV row is compared with one
    recording at a time, never with the names of every version pooled."""
    recs = OrderedDict()
    for i in idxs:
        recs.setdefault(rows[i]["isrcs"][0] if rows[i]["isrcs"] else f"row{i}", []).append(i)
    out = []
    for members in recs.values():
        p = rows[members[0]]
        years = sorted(rows[i]["year"] for i in members if rows[i]["year"])
        out.append({"via": p["row"], "title": p["title"], "film": album_key(p["album"]), "album": p["album"] or "",
                    "year": years[0] if years else "",
                    "isrcs": {t for i in members for t in rows[i]["isrcs"]},
                    "people": people.work([x for i in members for x in rows[i]["lyricists"] + rows[i]["composers"]]),
                    "aside": {people.key(x) for i in members for x in rows[i]["singers"] if not is_junk_name(x)} | people.ignore,
                    "pubkeys": {k for i in members for x in rows[i].get("publishers", []) if (k := people.pub(x))}})
    return out


def _dsp_songs(rows, people, groups, lyricist_keys=frozenset()):
    """DSP songs from step 1's merge (songmerge.songs: lists of row indexes)."""
    songs = []
    for idxs in groups:
        idxs = _primary_order(rows, idxs)
        p = rows[idxs[0]]
        original, parts = _parts(rows, idxs)
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
            # the primary (original) recording's ISRC: unticking a version in step 1 keeps the song's answers
            "key": p["isrcs"][0] if p["isrcs"] else isrcs[0] if isrcs else "T:" + (title_key(p["title"]) or str(p["row"])),
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
            "people": people.work(lyricists + composers),
            # DSP-only names that do not make another work: this song's singers, and names the reviewer said are no writers
            "aside": {people.key(x) for i in idxs for x in rows[i]["singers"] if not is_junk_name(x)} | people.ignore,
            "publishers": list(OrderedDict.fromkeys(x for i in idxs for x in rows[i].get("publishers", []))),
            "pubkeys": {k for i in idxs for x in rows[i].get("publishers", []) if (k := people.pub(x))},
            "original": original, "parts": parts, "recs": _recordings(rows, idxs, people),
        })
    # One ISRC on two DSP songs (an ISRC conflict kept apart) would give both one key: the later one gets its row
    seen = set()
    for s in songs:
        if s["key"] in seen:
            s["key"] = f"{s['key']}@{rows[s['rows'][0]]['row']}"
        seen.add(s["key"])
    for s in songs:
        s["credit"] = ("medley" if s["medley"] else "performer" if not s["client_writer"]
                       else "shared" if len(s["other_composers"]) >= 2 else "writer")
    return songs


# Link score out of 10
POINTS = {"isrc": 5, "title": 3, "similar_title": 2, "writer": 3, "film": 1, "writer_conflict": -4, "film_conflict": -1}
CANDIDATE_AT = 3  # below this a candidate is dropped
MAX_CANDIDATES = 5


def _same_film(a, b):
    return bool(a and b) and (a == b or (min(len(a), len(b)) >= 5 and (a in b or b in a)))


def _close_writers(r, l):
    """The writers differ only a little: one side lists every writer of the other plus one more name (a DSP often adds
    a singer, arranger or remixer). A name in place of another is a different person, never "a little"."""
    a, b = r["people"], l["people"]
    if not a or not b:
        return False
    only_a = [k for k in a if not any(same_person(k, y) for y in b)]
    only_b = [k for k in b if not any(same_person(k, x) for x in a)]
    return len(only_a) + len(only_b) == 1


def _same_title(r, l, isrc=False):
    """The same song name and the same version: a spelling a little off counts ('Pyaar' / 'Pyar'), and so does a
    title that is the start of the other ('Raat Ki Hatheli Par' / '… Chand Jhagmagata Hai'). A version (remix,
    lofi …) must have the whole title alike – 'Remix' is not 'Trap Mix'. Rows sharing the ISRC are one recording: a
    version tag only one side writes does not matter."""
    tagged = version_type(r["title"]) != ORIGINAL or l["version"] != ORIGINAL
    if version_type(r["title"]) != l["version"] and not isrc:
        return False
    if tagged and not isrc and fuzz.ratio(phonetic(r["title"]), phonetic(l["title"])) < 85:
        return False
    k = title_key(r["title"])
    near = 80 if isrc else 90   # one recording: 'Khush Rahena' / 'Khush Rehna'
    return bool(k) and (k in l["tkeys"] or any(len(k) >= 6 and fuzz.ratio(k, t) >= near for t in l["tkeys"])
                        or title_similarity(r["title"], l["title"]) >= near)


@lru_cache(maxsize=65536)
def album_full(album):
    """The whole film / album name, spelling-insensitive: 'Veer - Zaara' == 'Veer-Zaara'; '(Original Motion Picture
    Soundtrack)' and the like left out."""
    return phonetic(re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", str(album or "")))


@lru_cache(maxsize=65536)
def _same_album(a, b):
    """Two film / album names are one: the same whole name, or one inside the other, or a spelling a little off – the
    numbers always the same ('Vol 3' is not 'Vol 4'). The bracketed part counts too: 'Earth (1947: Earth)' is
    '1947: Earth'."""
    da, db = re.findall(r"\d+", album_full(a)), re.findall(r"\d+", album_full(b))
    if da and db and da != db:
        return False
    for fa in {album_full(a), phonetic(a or "")}:
        for fb in {album_full(b), phonetic(b or "")}:
            if fa and fb and (fa == fb or (min(len(fa), len(fb)) >= 5 and (fa in fb or fb in fa)) or fuzz.ratio(fa, fb) >= 90):
                return True
    ka, kb = album_key(a), album_key(b)
    return len(ka) >= 5 and ka == kb


def _year(a, b):
    """same (a year apart counts: a release at the turn of the year) · blank (a side has none) · differ."""
    if not (a and b and a.isdigit() and b.isdigit()):
        return "blank"
    return "same" if abs(int(a) - int(b)) <= 1 else "differ"


def _level(s, l, publishers=True):
    """The user's rule – two stages, one DSP recording against one LNV row:
      stage 1 (the recording):  song name · film / album · ISRC · release year
      stage 2 (the work):       song name · film / album · writers (lyricist + composer, as people) · publisher
    exact: both stages hold, small differences allowed (spelling, one extra writer name, one company under two names;
    a blank on the LNV side – no ISRC, no year yet – is filled, not a difference) · possible: one stage holds ·
    None: neither – another song (an ISRC alone is flagged, "isrc_only", so it is never added twice).
    The song's level is its best recording's. publishers: False when the DSP sheet has no publisher column."""
    best = None
    rank = {"exact": 3, "possible": 2, "isrc_only": 1, None: 0}
    for r in s["recs"]:
        isrc = bool(r["isrcs"] & l["isrcs"])
        checks = {"isrc": "same" if isrc else "blank" if not l["isrcs"] or not r["isrcs"] else "differ",
                  "title": _same_title(r, l, isrc), "album": _same_album(r["album"], l["movie"]),
                  "year": _year(r.get("year"), l.get("year"))}
        writers, publisher = work_check(r, l)
        if writers == "differ" and _close_writers(r, l):
            writers = "close"
        checks["writers"] = writers
        checks["publisher"] = publisher if publishers else None
        name = checks["title"] and checks["album"]
        # stage 1: the same recording. One ISRC on both is the recording's own number – then a year that differs is
        # a typo to pick from, not another recording; without an ISRC on one side, the year stands in for it (a blank
        # contradicts nothing: the LNV row gets it filled)
        stage1 = name and (isrc or (checks["isrc"] == "blank" and checks["year"] != "differ"))
        # stage 2: the same work
        stage2 = name and writers in ("same", "close") and checks["publisher"] != "differ"
        level = "exact" if stage1 and stage2 else "possible" if stage1 or stage2 else "isrc_only" if isrc else None
        checks.update(stage1=bool(stage1), stage2=bool(stage2))
        score = (rank[level], isrc, sum(1 for k in ("title", "album") if checks[k]) + (writers == "same") + (checks["publisher"] == "same")
                 + (checks["year"] == "same"))
        if best is None or score > best[0]:
            best = (score, {**checks, "level": level, "via": r["via"]})
    return best[1] if best else {"level": None}


def _origin(s, cands, lnv, by_row):
    """A song the LNV does not have as a recording may still be a work it has: an LNV row with the same song name
    (version tags aside) and the same writers – one name extra at most – under a publisher that does not differ. The
    song is then a new recording of that work: its new row names that row as the original (the user's rule).
    sure: the writers are the same people; else they only share a writer besides the client – the reviewer decides."""
    best = None
    for c in cands:
        l = lnv[by_row[c["row"]]]
        if l["version"] != ORIGINAL or not (s["tkeys"] & l["tkeys"] or {title_key(s["base"])} & l["tkeys"]) or c["publisher"] == "differ":
            continue
        sure = c["writers"] == "same" or (c["writers"] == "differ" and _close_writers(s, l))
        # not sure: they share a writer besides the client and are at most two names apart ('Maahi Ve' of Kaante, by
        # Dev Kohli, is not 'Maahi Ve' of Kal Ho Naa Ho)
        if not sure and not (c.get("shared") and sum(c.get("odd", (9, 9))) <= 2):
            continue
        key = (sure, c["points"])
        if best is None or key > best[0]:
            best = (key, {"row": l["row"], "title": l["title"], "album": l["movie"], "language": l["song"].get("language") or "", "sure": sure})
    return best[1] if best else None


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
    writers, publisher = work_check(s, l)
    only_s = only_l = []
    if writers == "same":
        pts += POINTS["writer"]
        why.append("Same writers")
    elif writers == "differ":
        pts += POINTS["writer_conflict"]
        only_s = [v for k, v in s["people"].items() if not any(same_person(k, y) for y in l["people"])]
        only_l = [v for k, v in l["people"].items() if not any(same_person(k, x) for x in s["people"])]
        flags.append("Different writers – " + " · ".join(x for x in (f"DSP also: {', '.join(only_s[:3])}" if only_s else "",
                                                                     f"LNV also: {', '.join(only_l[:3])}" if only_l else "") if x))
    else:
        flags.append("Writers missing on one side – cannot be checked")
    if publisher == "same":
        why.append("Same publisher")
    elif publisher == "differ":
        flags.append(f"Different publisher – DSP: {', '.join(sorted(s['pubkeys']))[:60]} · LNV: {', '.join(p['name'] for p in l['song'].get('publishers', [])[:2])}")
    if s["film"] and l["film"]:
        if s["film"] == l["film"] or (min(len(s["film"]), len(l["film"])) >= 5 and (s["film"] in l["film"] or l["film"] in s["film"])):
            pts += POINTS["film"]
            why.append(f"Film / album {l['movie']}")
        elif not ev.get("isrc"):
            pts += POINTS["film_conflict"]
    if ev.get("isrc") and not t:
        if title_similarity(s["title"], l["title"]) < 60:
            flags.append(f"Same ISRC but a different title – the ISRC may be on the wrong song in the LNV ('{l['title']}')")
    return {"row": l["row"], "score": max(0, min(10, pts)), "points": pts, "evidence": why, "flags": flags,
            "writers": writers, "publisher": publisher, "isrc": bool(ev.get("isrc")), "title": t or 0,
            "odd": [len(only_s), len(only_l)],   # writers on one side only: how far apart the credits are
            # writers on both sides besides the client (the client is on every song: no evidence)
            "shared": sum(1 for k in s["writers"] if any(same_person(k, y) for y in l["writers"]))}


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


def match(master, dsp, client_name="", aliases=None, links=None, groups=None, rules=None):
    """Compare the LNV (parse_master result) with one DSP sheet (parse_dsp result).
    aliases: {name key: canonical key} from "same person" decisions.
    links: {DSP song key: {"choice": "same" | "none", "rows": [LNV rows]}} from link decisions.
    groups: the DSP songs from step 1 (songmerge.songs); without them, only rows sharing an ISRC and writers are one."""
    aliases, links = aliases or {}, links or {}
    versions = {k[2:]: v for k, v in links.items() if k.startswith("V:")}   # the reviewer's answers on version rows
    people = People(aliases, _client_keys(master["songs"], client_name), rules)
    publishers = any(r.get("publishers") for r in dsp["rows"])   # a sheet without publishers cannot be checked on them
    lnv = _lnv_songs(master, people)
    by_row = {l["row"]: j for j, l in enumerate(lnv)}
    # Anyone credited as a lyricist anywhere (Muso often repeats the lyricist under composers) is not a rival composer
    lyricist_keys = {people.key(x) for r in dsp["rows"] for x in r["lyricists"]} \
        | {people.key(p["name"]) for l in lnv for p in l["song"].get("authors", [])}
    if groups is None:
        from .songmerge import analyse, songs as merged
        groups = merged(analyse(dsp["rows"]), {})
    songs = _dsp_songs(dsp["rows"], people, groups, lyricist_keys)
    name_pairs = defaultdict(lambda: {"n": 0, "songs": []})   # one name each side keeps a link apart: worth asking
    # The other single causes worth one decision: one extra DSP writer, or one publisher under two names
    extra_writers = defaultdict(lambda: {"n": 0, "songs": []})
    pub_pairs = defaultdict(lambda: {"n": 0, "songs": []})
    pub_names = {}
    for l in lnv:
        for p in l["song"].get("publishers", []):
            pub_names.setdefault(people.pub(p["name"]), p["name"])
    for r in dsp["rows"]:
        for x in r.get("publishers", []):
            pub_names.setdefault(people.pub(x), x)

    def count(table, key, title, **shown):
        e = table[key]
        e.update(shown)
        if title not in e["songs"]:
            e["n"] += 1
            if len(e["songs"]) < 4:
                e["songs"].append(title)

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
        for c in cands:
            c["rec"] = _level(s, lnv[by_row[c["row"]]], publishers)
        # every LNV row with the same recording or title stays a candidate – the writers decide below, not the points
        cands = [c for c in cands if c["isrc"] or c["title"] or c["points"] >= CANDIDATE_AT]
        _home_first(s, cands)
        # LNV rows that are one of the song's versions are that version's row, never the song's own (they are shown
        # and checked under "already in the LNV"); and while an LNV row with the plain title is there, a remix /
        # lofi … row is not the song's own row either
        taken = _version_rows(s, cands, lnv, by_row, versions)

        def own(cs):
            mine = [c for c in cs if c["row"] not in taken]
            return [c for c in mine if lnv[by_row[c["row"]]]["version"] == ORIGINAL] or mine
        tie = lambda: [lnv_links[by_row[p["lnv_row"]]].append((si, {"row": p["lnv_row"], "points": 0, "part": k}))
                       for k, p in enumerate(s["parts"]) if p["lnv_row"]]
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
                tie()
                matched.append({"song": si, "links": chosen, "confirmed": True})
                continue
        # The rule (_level): the same credits and ISRC are the same song – the app links it; the same ISRC or the
        # same credits alone may be – the reviewer decides; anything else is another song
        same = own([c for c in cands if c["rec"]["level"]])
        strong = own([c for c in same if c["rec"]["level"] == "exact"])
        for c in strong:
            same_what = "title, album, writers" + (", publisher" if publishers else "")
            c["auto"] = f"Same {same_what} and ISRC" if c["rec"]["isrc"] == "same" else f"Same {same_what} – the LNV has no ISRC yet"
        if strong:
            for c in strong:
                lnv_links[by_row[c["row"]]].append((si, c))
            tie()
            matched.append({"song": si, "links": strong, "confirmed": False})
            continue
        unsure = same
        near = [c for c in cands if c not in unsure]
        shown = [c for c in near if c["row"] not in taken]
        s["near"] = ([c for c in shown if lnv[by_row[c["row"]]]["version"] == ORIGINAL] or shown)[:3]
        for c in cands:   # what keeps the song from a row it is not linked to: one answer may settle it
            l = lnv[by_row[c["row"]]]
            only_s = [k for k in s["people"] if not any(same_person(k, y) for y in l["people"])]
            only_l = [k for k in l["people"] if not any(same_person(k, x) for x in s["people"])]
            if c["writers"] == "differ" and len(only_s) == 1 and len(only_l) == 1 and _alike(only_s[0], only_l[0]):
                count(name_pairs, (only_s[0], only_l[0]), s["title"], a=s["people"][only_s[0]], b=l["people"][only_l[0]])
            elif c["writers"] == "differ" and len(only_s) == 1 and not only_l and c["publisher"] != "differ":
                count(extra_writers, only_s[0], s["title"], name=s["people"][only_s[0]])
            elif c["writers"] == "same" and c["publisher"] == "differ":
                for x in s["pubkeys"]:
                    for y in l["pubkeys"]:
                        count(pub_pairs, tuple(sorted((x, y))), s["title"], a=pub_names.get(x, x), b=pub_names.get(y, y))
        if unsure:
            check.append({"song": si, "candidates": unsure[:MAX_CANDIDATES]})
        else:
            s["origin"] = _origin(s, cands, lnv, by_row)
            unmatched.append(si)

    result = _report(lnv, songs, matched, check, unmatched, lnv_links, people, dsp, name_pairs)
    # One decision each settles every song it counts – the "biggest wins", most songs first
    result["wins"] = sorted(
        [{"key": "writer:" + k, "kind": "writer", "name": e["name"], "songs": e["n"], "examples": e["songs"]}
         for k, e in extra_writers.items() if e["n"] >= 2 and not people.is_client(k)]
        + [{"key": "pub:" + "|".join(k), "kind": "publisher", "a": e["a"], "b": e["b"], "songs": e["n"], "examples": e["songs"]}
           for k, e in pub_pairs.items() if e["n"] >= 2],
        key=lambda w: -w["songs"])
    return result


# ---------------------------------------------------------------- the queues

def _lnv_brief(l):
    s = l["song"]
    names = lambda kind, n=6: [p["name"] for p in s.get(kind, [])][:n]
    return {"row": l["row"], "title": l["title"], "movie": l["movie"], "isrcs": sorted(l["isrcs"]),
            "writers": [p["name"] for kind in ("authors", "composers") for p in s.get(kind, [])][:6],
            "lyricists": names("authors"), "composers": names("composers"), "singers": names("singers", 5),
            "alt_title": s.get("alt_title") or "", "label": s.get("label") or "", "duration": s.get("duration") or "",
            "language": s.get("language") or "",
            "year": s.get("release_year") or "", "codes": l["codes"], "has_writers": l["has_writers"]}


def _song_brief(s):
    return {"key": s["key"], "title": s["title"], "album": s["album"], "isrcs": s["isrcs"][:6], "isrc_count": len(s["isrcs"]),
            "lyricists": s["lyricists"][:5], "composers": s["composers"][:6], "singers": s["singers"][:5],
            "year": s["year"], "popularity": s["popularity"], "versions": s["versions"], "recordings": s["recordings"],
            "link": s["link"], "client_writer": s["client_writer"], "other_composers": s["other_composers"][:5],
            "credit": s["credit"], "members": s["rows"], "duration": s["duration"], "label": s["label"],
            "publishers": s["publishers"][:4], "near": s.get("near", []),
            "base": s["base"], "original": s["original"], "parts": s["parts"], "origin": s.get("origin")}


def lnv_versions(result, master_songs):
    """What the answers add to the LNV beside the songs themselves. A song in the LNV (or added to it) keeps its
    original on its own row; each of its versions the LNV does not have becomes a row of its own naming the original
    work and its film / album ("rows"), and LNV rows that already are one of its versions get that name too ("named").
    A version row added for a song the LNV does not have names the song's added row ("add": the song's key)."""
    by_row = {s["row"]: s for s in master_songs}
    choice = lambda item: (item.get("decision") or {}).get("choice")
    homes = [(m["song"], [l["row"] for l in m["links"]]) for m in result["matched"]]
    homes += [(c["song"], (c["decision"].get("data") or {}).get("rows", [])) for c in result["check"] if choice(c) == "same"]
    homes += [(m, None) for m in result["missing"] if choice(m) == "add"]
    rows, named, seen = [], [], set()
    for song, links in homes:
        if not song.get("parts"):
            continue
        taken = {p["lnv_row"] for p in song["parts"] if p["lnv_row"]}
        if links is None and song.get("origin"):   # added, a new recording of an LNV work: that row is the original
            g = song["origin"]
            original = {"title": g["title"], "album": g["album"], "row": g["row"], "add": None, "language": g.get("language", "")}
        elif links is None:   # added: the original is the song's new row – or, with no original on the DSP, unnamed
            o = song.get("original") or {}
            original = {"title": o.get("title") or song["base"], "album": o.get("album", ""), "row": None,
                        "add": song["key"] if o else None, "language": ""}
        else:
            home = next((by_row[r] for r in links if r not in taken and r in by_row), None) \
                or next((by_row[r] for r in links if r in by_row), None)
            if not home:
                continue
            original = {"title": home["title"], "album": home.get("movie", ""), "row": home["row"], "add": None,
                        "language": home.get("language", "")}
        for p in song["parts"]:
            if p["lnv_row"]:   # an LNV row with a plain title that holds the version's ISRC is not named a version
                if p["lnv_row"] != original["row"] and p["lnv_row"] in by_row \
                        and (p["type"] == REISSUE or version_type(by_row[p["lnv_row"]]["title"]) != ORIGINAL):
                    named.append({"row": p["lnv_row"], "type": p["type"], "original": original})
                continue
            # one recording on two DSP songs (an ISRC conflict kept apart) is added once
            if seen & set(p["isrcs"]):
                continue
            seen.update(p["isrcs"])
            rows.append({**p, "lyricists": song["lyricists"], "composers": song["composers"], "original": original})
    return {"rows": rows, "named": named}


def _filled(l):
    s = l["song"]
    return (bool(l["isrcs"]) * 2 + bool(l["has_writers"]) * 2 + sum(l["codes"].values()) * 2
            + sum(1 for f in ("movie", "release_year", "duration", "label", "language") if s.get(f)))


TAG_FILLER = {phonetic(w) for w in ("film", "from", "movie", "original", "motion", "picture", "soundtrack", "ost", "the", "feat", "ft")}


@lru_cache(maxsize=131072)
def _words(text):
    return frozenset(phonetic(w) for w in re.findall(r"[a-z0-9]+", _ascii(text)) if len(w) > 1)


def _versions_differ(a, b):
    """The two titles carry different version tags ('Revival', 'Bengali Version', 'Chill Hop'): two versions of
    a song, not one song entered twice. Words of either song name or either film do not count as a tag."""
    skip = TAG_FILLER.union(*(_words(clean_title(x)) for x in (a["title"], b["title"], a["movie"], b["movie"])))
    return (_words(a["title"]) - skip) != (_words(b["title"]) - skip)


def _same_writers(a, b):
    """Every writer of one row is a writer of the other (the client aside): the same credits, any order or spelling.
    One shared name is not enough – a remake keeps the composer and changes the lyricist."""
    return all(any(same_person(x, y) for y in b) for x in a) and all(any(same_person(y, x) for x in a) for y in b)


def _twins(a, b):
    """Nothing says these two rows are different entries: no different version tag, no different writers, and not
    two different recordings (each row with its own ISRCs). Blank values are unknown, never agreement."""
    if _versions_differ(a, b):
        return False
    if a["isrcs"] and b["isrcs"] and not a["isrcs"] & b["isrcs"]:
        return False
    return not a["writers"] or not b["writers"] or _same_writers(a["writers"], b["writers"])


def _duplicates(lnv, lnv_links, songs):
    """LNV rows that are one song entered twice: same ISRC, or the same DSP song / same title with the same writers.
    Versions (remix, revival, a language version …) and different recordings are not duplicates, and a row joins a
    group only when it fits every row already in it (A ≈ B and B ≈ C never pulls in a C that differs from A)."""
    dsu = DSU(len(lnv))
    members = {j: [j] for j in range(len(lnv))}
    reasons = defaultdict(list)   # frozenset(pair) -> reasons
    wrong_isrc = []

    def join(a, b, why, check=True):
        ra, rb = dsu.find(a), dsu.find(b)
        if ra != rb:
            if check and not all(_twins(lnv[x], lnv[y]) for x in members[ra] for y in members[rb]):
                return
            dsu.union(ra, rb)
            root = dsu.find(ra)
            members[root] = members.pop(ra) + members.pop(rb) if root == ra else members.pop(rb) + members.pop(ra)
        reasons[frozenset((a, b))].append(why)

    by_isrc = defaultdict(list)
    for j, l in enumerate(lnv):
        for t in l["isrcs"]:
            by_isrc[t].append(j)
    alike = lambda a, b: bool(lnv[a]["tkeys"] & lnv[b]["tkeys"]) or title_similarity(lnv[a]["title"], lnv[b]["title"]) >= 85
    # Without a shared ISRC the main titles must agree: the LNV's alternate title sometimes names another song
    same_title = lambda a, b: title_key(lnv[a]["title"]) == title_key(lnv[b]["title"]) or title_similarity(lnv[a]["title"], lnv[b]["title"]) >= 85
    for t, js in by_isrc.items():
        for x in range(len(js)):
            for y in range(x + 1, len(js)):
                a, b = js[x], js[y]
                if alike(a, b):
                    join(a, b, f"Same ISRC {t}", check=False)   # one recording: the same entry whatever else differs
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
                if lnv[a]["version"] == lnv[b]["version"] and same_title(a, b):
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
                if a["version"] == b["version"] and a["writers"] and b["writers"] and same_title(js[x], js[y]) \
                        and _same_writers(a["writers"], b["writers"]):
                    join(js[x], js[y], f"Same title and same writers ({', '.join(list(a['writers'].values())[:3])})")

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


def _names(lnv, songs, people, name_pairs=None):
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
                    "info": True})
    # One name each side is all that keeps a DSP song and an LNV row apart: is it one person? Worth asking.
    asked = {tuple(sorted((x["a_key"], x["b_key"]))): x for x in out}
    for (a, b), p in (name_pairs or {}).items():
        if a in people.aliases or b in people.aliases:
            continue
        side = lambda name, n: {"spelling": name, "spellings": [name], "lnv": 0, "dsp": n, "songs": p["songs"]}
        item = asked.get(tuple(sorted((a, b))))
        if item:
            item.update(info=False, links=p["n"])
            continue
        out.append({"key": "name:" + "|".join(sorted((a, b))), "kind": "spelling", "a_key": a, "b_key": b,
                    "similarity": round(fuzz.ratio(a, b)), "a": side(p["a"], p["n"]), "b": side(p["b"], 0),
                    "client": people.is_client(a) or people.is_client(b), "info": False, "links": p["n"]})
    out.sort(key=lambda p: (p["info"], -p.get("links", 0), -(p["a"]["lnv"] + p["a"]["dsp"] + p["b"]["lnv"] + p["b"]["dsp"])))
    for name, j in sorted(junk.items(), key=lambda x: -x[1]["count"]):
        out.append({"key": "junk:" + name.lower(), "kind": "junk", "name": name, "count": j["count"], "songs": j["rows"]})
    return out


def _duration(v):
    """'4:21' -> '00:04:21' as the LNV writes durations."""
    m = re.fullmatch(r"(\d+):(\d{2})", v or "")
    return f"00:{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def _fills(lnv, songs, lnv_links):
    """Blank LNV fields the matched DSP song can fill: a version's row from that version's recordings, the song's
    own row from the original's – a remix's ISRC never goes onto the original. The writers are the song's."""
    out = []
    for j, ls in lnv_links.items():
        l, s_ = lnv[j], lnv[j]["song"]
        si, link = next((x for x in ls if "part" in x[1]), None) or max(ls, key=lambda x: x[1]["points"])
        s = songs[si]
        rec = s["parts"][link["part"]] if "part" in link else s["original"] or {}
        offers = [
            ("ISRC", not l["isrcs"], (rec.get("isrcs") or [""])[0]),
            ("Release year", not s_.get("release_year"), rec.get("year", "")),
            ("Duration", not s_.get("duration"), _duration(rec.get("duration", ""))),
            ("Label", not s_.get("label"), rec.get("label", "")),
            ("Movie / album", not s_.get("movie"), re.sub(r"\s*\((original|from).*$", "", rec.get("album", ""), flags=re.I).strip()),
            ("Singers", not s_.get("singers"), ", ".join(rec.get("singers", [])[:6])),
            ("Lyricists", not s_.get("authors"), ", ".join(s["lyricists"][:6])),
            ("Composers", not s_.get("composers"), ", ".join(s["composers"][:6])),
        ]
        for field, blank, value in offers:
            if blank and value:
                out.append({"key": f"fill:{l['row']}:{field}", "row": l["row"], "title": l["title"], "field": field,
                            "value": value, "song": rec.get("title") or s["title"], "song_key": s["key"], "score": link.get("score"),
                            "more": len(rec.get("isrcs", [])) - 1 if field == "ISRC" else 0,
                            "auto": {"choice": "accept", "why": f"Empty in the LNV; {field.lower()} of the matched song"}})
    out.sort(key=lambda f: (f["row"], f["field"]))
    return out


def _report(lnv, songs, matched, check, unmatched, lnv_links, people, dsp, name_pairs=None):
    briefs = {}

    def song(si):
        if si not in briefs:
            briefs[si] = _song_brief(songs[si])
        return briefs[si]

    by_row = {l["row"]: l for l in lnv}
    with_lnv = lambda c: {**c, "lnv": _lnv_brief(by_row[c["row"]])}
    duplicates = _duplicates(lnv, lnv_links, songs)
    names = _names(lnv, songs, people, name_pairs)
    missing = [{**song(si), "key": "missing:" + songs[si]["key"], "song_key": songs[si]["key"],
                "rejected": bool(songs[si].get("decided")),
                **({"auto": {"choice": "add", "why": f"A new recording of LNV row {songs[si]['origin']['row']} – it gets a row of its own naming that original"}}
                   if songs[si]["credit"] in ("writer", "shared") and (songs[si].get("origin") or {}).get("sure") and not songs[si].get("decided")
                   else {"auto": {"choice": "add", "why": "The client is a credited writer, it is an original song, and no LNV row is close"}}
                   if songs[si]["credit"] in ("writer", "shared") and ORIGINAL in songs[si]["versions"]
                   and not songs[si].get("decided") and not songs[si].get("near") else {})}   # a near LNV row: a person decides
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
                      "notes": [f for x in m["links"] for f in x.get("notes", [])],
                      "unchecked": not m["confirmed"] and any(x.get("unchecked") for x in m["links"])} for m in matched]
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
    out["decided"] = sum(1 for k in decisions if k.split(":", 1)[0] in ("dup", "name", "junk", "missing", "fill", "link", "version"))
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
        elif key.startswith(("link:", "version:")) and d["choice"] in ("same", "none"):
            rows = [int(r) for r in (d.get("data") or {}).get("rows", [])]
            links[key[5:] if key.startswith("link:") else "V:" + key] = {"choice": d["choice"], "rows": rows}
    for k in list(parent):
        aliases[k] = find(k)
    return aliases, links


def rules_of(decisions):
    """The reviewer's catalogue-wide rules: writer names to set aside ("writer:<key>" = ignore) and publisher names
    that are one company ("pub:<a>|<b>" = same)."""
    ignore, parent = set(), {}

    def find(k):
        while parent.get(k, k) != k:
            k = parent[k]
        return k
    for key, d in sorted(decisions.items()):
        if key.startswith("writer:") and d["choice"] == "ignore":
            ignore.add(key[7:])
        elif key.startswith("pub:") and d["choice"] == "same":
            a, b = key[4:].split("|", 1)
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra
    return {"ignore": sorted(ignore), "pubs": {k: find(k) for k in parent}}


def summary_counts(result):
    """Headline numbers kept on the DSP file so the client page shows them without re-running the match."""
    return {**result["summary"], "open": result["open"], "source": result["source"]["name"]}
