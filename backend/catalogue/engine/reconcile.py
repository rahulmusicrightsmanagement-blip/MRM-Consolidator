"""Muso (or any DSP sheet) against the LNV – the three-bucket comparison.

Step by step, the way the team works it by hand:

  1. Rows of the sheet with one ISRC and one title are one recording.
  2. Recordings with one song name and compatible writers are one family (S1, S1 - Lofi, S1 - Remix …). The oldest
     release of the plain title is the family's original – of the plain releases the LNV holds by ISRC, when it holds
     any, so a cover with a stray early date never becomes the original. Every other recording names the original in
     the output.
  3. Each recording is compared with the LNV on four things: title, film / album, ISRC, credits (composer + lyricist).

       exact      title, album, ISRC and credits all agree. Linked by the app – nobody has to look at it.
       possible   title and album agree, and credits, ISRC or both are a little different; or the ISRC is the same and
                  the album or title is not. A person decides.
       new        nothing lines up. The recording becomes a new LNV row.

  A blank credit is not a difference: the LNV row gets it filled from the sheet. A blank ISRC on the LNV proves nothing,
  so that row is a possible match, never an exact one.

An LNV row whose ISRC belongs to another recording of the sheet is that recording's row and is never offered to this
one, and an ISRC the LNV holds never becomes a new row. Nothing here changes a file: the result is the plan, export.py
writes it.

Decisions are stored as "rec:<recording key>": same (data.row) · new · skip · add.
"""
import re
from collections import Counter, OrderedDict, defaultdict
from functools import lru_cache

from rapidfuzz import fuzz

from .dataclean import (DSU, MEDLEY_RE, ORIGINAL, TRAILING_RE, People, _ascii, _client_keys, is_placeholder, person_key, phonetic,
                        same_person, version_type)
from .master import read_layout
from .normalize import alternate_titles, clean_text, norm_isrc
from .xlsx import Book

EXACT, POSSIBLE, NEW = "exact", "possible", "new"
REASONS = {
    "isrc_blank": "Same title, album and credits – the LNV has no ISRC",
    "isrc_blank_no_credits": "Same title and album – the LNV has no ISRC or credits",
    "credits": "Same title, album and ISRC – credits differ",
    "isrc_blank_credits": "Same title and album – no ISRC in the LNV, credits differ",
    "isrc": "Same title, album and credits – ISRC differs",
    "isrc_credits": "Same title and album – ISRC and credits differ",
    "album": "Same ISRC and title – album differs",
    "title": "Same ISRC – title differs",
    "no_ids": "Same title – the sheet has no ISRC or album for it",
}

# ---------------------------------------------------------------- titles

FROM_RE = re.compile(r"""\bfrom\s+(?:the\s+(?:film|movie|album)\s+)?["“”'‘’]?\s*([^"“”()\[\]]+?)\s*["“”'‘’]?\s*(?=$|[)\]])""", re.I)
BRACKET_RE = re.compile(r"\(([^()]*)\)|\[([^\[\]]*)\]")
FEAT_RE = re.compile(r"\s*\b(?:feat|ft|featuring)\b\.?\s+.*$", re.I)
NEUTRAL_TAG = re.compile(
    r"^(?:from\b.*|(?:feat|ft|featuring)\b.*|(?:original\s+)?(?:motion\s+picture\s+)?(?:soundtrack|ost)\b.*|original motion picture.*"
    r"|(?:film|album|original|full|main|single|radio)(?:\s+(?:version|edit|mix|song))?|explicit|e|clean)$", re.I)
# Words that only describe a version: stripped from the end of a title once a version word has been found there
STYLE_WORDS = re.compile(
    r"\s+(?:future|rave|melodic|progressive|deep|lounge|euro|latin|psy|uplifting|energy|hip\s*hop|chillhop|chill|synthwave|"
    r"amapiano|tabla|dubstep|analogue|new\s+age|workout|switch|recharged|extended|piano|flute|violin|guitar|instrumental|"
    r"club|house|trap|lofi|lo-?fi|slow|slowed|reverb|acoustic|unplugged|hindi|punjabi|telugu|tamil|bhojpuri|bengali)\s*$", re.I)
EXTRA_TAG_WORDS = re.compile(
    r"\s+(?:reimagined|re-imagined|revibe|revamped|revival|stutter|dubstep|synthwave|amapiano|lullaby|nightcore|bhojpuri|"
    r"telugu|tamil|punjabi|bengali|marathi|gujarati|kannada|malayalam)\s*$", re.I)
BY_RE = re.compile(r"\s+by\s+(?!me\b|you\b|my\b|your\b|the\b|side\b|us\b|him\b|her\b)\S.*$", re.I)
ROMAN = {"ii": "2", "iii": "3", "iv": "4", "vi": "6", "vii": "7", "viii": "8", "ix": "9"}
TAG_FILLER = {"by", "the", "a", "version", "mix", "song", "ver"}


@lru_cache(maxsize=65536)
def parse_title(title):
    """(base, tag, film): 'Tere Bin - Remix By Eric Pillai' -> ('Tere Bin', 'Remix By Eric Pillai', '');
    'Dhun (From "Saiyaara")' -> ('Dhun', '', 'Saiyaara'). A medley keeps its whole name as the base."""
    t = clean_text(title)
    film, tags = "", []

    def bracket(m):
        nonlocal film
        inner = (m.group(1) or m.group(2) or "").strip()
        f = FROM_RE.search(inner)
        if f and inner.lower().startswith("from"):
            film = film or f.group(1).strip()
        elif inner and not NEUTRAL_TAG.match(inner):
            tags.append(inner)
        return " "

    prev = None
    while prev != t:   # 'Remix (From "The Remix - Amazon Prime Original Episode 2")[Remix By X]'
        prev = t
        t = BRACKET_RE.sub(bracket, t)
    t = FEAT_RE.sub("", re.sub(r"[()\[\]]", " ", t))
    t = re.sub(r"\s+-\s+(\S{1,2})\s+-\s+", r"-\1-", t)   # 'Naam - E - Wafa'
    parts = [p.strip() for p in re.split(r"\s+[-–—|/]\s+|\s+/|/\s+", t) if p.strip()]
    if not parts:
        return clean_text(title), "", film
    head, keep = parts[0], []
    for p in parts[1:]:
        f = FROM_RE.search(p)
        if f and p.lower().startswith("from"):
            film = film or f.group(1).strip()
        elif not NEUTRAL_TAG.match(p):
            keep.append(p)
    if MEDLEY_RE.search(f" {clean_text(title)} "):
        return re.sub(r"\s+", " ", " ".join([head] + keep)).strip(" -–—|:/,."), " ".join(tags), film
    by = BY_RE.search(head)
    if by and by.start() > 0:   # 'Mar Jaayen Cover By Stereogrind', 'Khairiyat By Sakshi Holkar'
        tags.insert(0, head[by.start():].strip())
        head = head[:by.start()]
    while True:   # 'Tum Hi Ho Future Rave Mix', 'Tera Naam Liya LoFi Flip', 'Phir Mohabbat Acoustic'
        m = TRAILING_RE.search(head) or EXTRA_TAG_WORDS.search(head)
        if not m or m.start() == 0:
            break
        tags.insert(0, head[m.start():].strip())
        head = head[:m.start()]
        while (s := STYLE_WORDS.search(head)) and s.start() > 0:
            tags.insert(0, head[s.start():].strip())
            head = head[:s.start()]
    return head.strip(" -–—|:/,."), " ".join(keep + tags), film


def is_medley(title):
    return bool(MEDLEY_RE.search(f" {clean_text(title)} "))


def _base_key(title):
    return phonetic(parse_title(title)[0])


@lru_cache(maxsize=65536)
def _tag_words(tag):
    return frozenset(phonetic(w) for w in re.findall(r"[a-z0-9]+", _ascii(tag)) if w not in TAG_FILLER)


def _words(text):
    return [phonetic(w) for w in re.findall(r"[a-z0-9]+", _ascii(text))]


@lru_cache(maxsize=65536)
def _whole_words(title):
    """Every word of the title, film and featured names aside."""
    t = BRACKET_RE.sub(lambda m: " " if NEUTRAL_TAG.match((m.group(1) or m.group(2) or "").strip()) else f" {m.group(1) or m.group(2)} ", clean_text(title))
    return tuple(w for w in _words(FEAT_RE.sub("", t)) if w not in ("version", "mix"))


def _squash(title):
    """The whole title as one key: 'Naam - E - Wafa (Remix)' = 'Naam-E-Wafa (Remix Version)'."""
    return "".join(_whole_words(title))


def close_keys(a, b):
    """One song name spelled two ways ('Humdard' / 'Hamdard'), not two names ('Ji Huzoor' / 'Ji Huzoori', 'Chaahunga' /
    'Chaahungi'): the first and last letters agree."""
    return a == b or (min(len(a), len(b)) >= 6 and a[0] == b[0] and a[-1] == b[-1] and fuzz.ratio(a, b) >= 85)


@lru_cache(maxsize=131072)
def _title_check(a, b):
    ba, ta, _ = parse_title(a)
    bb, tb, _ = parse_title(b)
    ka, kb = phonetic(ba), phonetic(bb)
    if _squash(a) and _squash(a) == _squash(b):
        return "same"
    if ka and kb and close_keys(ka, kb):
        wa, wb = _tag_words(ta), _tag_words(tb)
        if wa == wb or (wa and wb and (wa <= wb or wb <= wa)):
            return "same"
        return "similar"
    # one title is the start of the other, whole words only ('Kucch Dard' / 'Kuch Dard Mujhe Tu')
    wa, wb = _words(ba), _words(bb)
    n = min(len(wa), len(wb))
    if n >= 2 and close_keys("".join(wa[:n]), "".join(wb[:n])):
        return "similar"
    wa, wb = _whole_words(a), _whole_words(b)
    n = min(len(wa), len(wb))
    return "similar" if n >= 2 and wa[:n] == wb[:n] else "differ"


def compare_titles(a, b, b_alts=()):
    """same · similar (the song name agrees, the version does not quite) · differ."""
    results = [_title_check(a, x) for x in (b, *b_alts)]
    return "same" if "same" in results else "similar" if "similar" in results else "differ"


# ---------------------------------------------------------------- albums

SOUNDTRACK_RE = re.compile(r"\b(original\s+)?(motion\s+picture\s+)?(soundtrack|ost)\b", re.I)


def _album_words(name):
    words = [ROMAN.get(w, w) for w in re.findall(r"[a-z0-9]+", _ascii(name))]
    return [w if w.isdigit() else phonetic(w) for w in words if w not in ("the", "vol", "volume", "part", "chapter", "pt")]


@lru_cache(maxsize=65536)
def album_names(album):
    """Word lists one album can be known by: the film named in 'From "X"', the name without the soundtrack note, and
    the part before a subtitle ('Aggar: Passion Betrayal Terror' is 'Aggar')."""
    a = clean_text(album)
    if not a:
        return ()
    names = [m.group(1) for m in FROM_RE.finditer(a)]
    plain = re.sub(r"\s*[-–]\s*(single|ep)\s*$", "", BRACKET_RE.sub(" ", a), flags=re.I)
    plain = clean_text(SOUNDTRACK_RE.sub(" ", plain)).strip(" -–:")
    if plain:
        names.append(plain)
        head = re.split(r"\s+[-–:]\s+|:\s+", plain)[0]
        if head != plain:
            names.append(head)
    for m in BRACKET_RE.finditer(a):
        inner = (m.group(1) or m.group(2) or "").strip()
        if inner and not inner.lower().startswith("from") and not NEUTRAL_TAG.match(inner) and not SOUNDTRACK_RE.search(inner):
            names.append(inner)
    out = []
    for n in names:
        w = tuple(_album_words(n))
        if w and w not in out:
            out.append(w)
    return tuple(out)


def _digits(words):
    return {w for w in words if w.isdigit()}


def _one_album(x, y):
    if x == y:
        return True
    if _digits(x) != _digits(y):   # 'Hate Story 2' is not 'Hate Story 4'; 'Khuda Haafiz' is not 'Khuda Haafiz 2'
        return False
    small, big = (x, y) if len(x) <= len(y) else (y, x)
    if set(small) <= set(big) and (len(small) >= 2 or (len(small[0]) >= 5 and small[0] == big[0])):
        return True
    return min(len(" ".join(x)), len(" ".join(y))) >= 6 and fuzz.ratio(" ".join(x), " ".join(y)) >= 90


@lru_cache(maxsize=65536)
def same_album(a, b):
    na, nb = album_names(a), album_names(b)
    return any(_one_album(x, y) for x in na for y in nb)


def film_of(album, title=""):
    """The film or album name fit for the Original Movie / Album column."""
    film = parse_title(title)[2] if title else ""
    m = FROM_RE.search(clean_text(album))
    if m:
        return m.group(1).strip()
    plain = clean_text(SOUNDTRACK_RE.sub(" ", BRACKET_RE.sub(" ", clean_text(album)))).strip(" -–:")
    plain = re.sub(r"\s*[-–]\s*(single|ep)\s*$", "", plain, flags=re.I)
    if film and (not plain or phonetic(plain) in (phonetic(parse_title(title)[0]), phonetic(title))):
        return film
    return plain or film


# ---------------------------------------------------------------- credits

NOT_A_WRITER = re.compile(r"inconnu|unknown|traditional|various|not provided|\brecords?\b|\bpublishing\b|\bpublisher\b", re.I)
DUO = re.compile(r"^([^\s-]{3,})\s*-\s*([^\s-]{3,})$")


def _fuzzy_word(x, y):
    """One word spelled two ways ('Varma' / 'Verma', 'Amitabha' / 'Amitabh'), never two names that rhyme ('Sajid' /
    'Wajid'): the first letter is the same."""
    return x == y or (len(x) >= 4 and len(y) >= 4 and x[0] == y[0] and fuzz.ratio(x, y) >= 80)


@lru_cache(maxsize=262144)
def same_name(a, b):
    """dataclean.same_person, plus the same words in any order and small spelling differences word by word."""
    if not a or not b:
        return False
    if same_person(a, b):
        return True
    x, y = set(a.split()), set(b.split())
    if x == y:
        return True
    small, big = (x, y) if len(x) <= len(y) else (y, x)
    return len(small) >= 2 and all(any(_fuzzy_word(w, v) for v in big) for w in small)


def _writer_keys(people, names):
    """{key: display} of real writers: companies and 'Unknown' out, a duo ('Sachet-Parampara') as its two members."""
    out = []
    for n in names:
        if NOT_A_WRITER.search(n):
            continue
        m = DUO.match(clean_text(n))
        out.extend([m.group(1), m.group(2)] if m and person_key(n) not in people.groups else [n])
    return people.work(out)


def credit_status(people, muso, lnv, singers=frozenset()):
    """(same | close | differ | blank, Muso-only names, LNV-only names). same: the same people on both sides – a
    Muso-only name who sings this very track aside, since Muso lists singers among composers. close: they share a
    writer besides the client. differ: the client at most in common."""
    if not muso or not lnv:
        return "blank", [], []
    only_m = [k for k in muso if not any(same_name(k, y) for y in lnv)]
    only_l = [k for k in lnv if not any(same_name(k, x) for x in muso)]
    extra = [k for k in only_m if not any(same_name(k, s) for s in singers)]
    if not only_l and not extra:
        return "same", [], []
    shared = [k for k in muso if k not in only_m and not people.is_client(k)]
    return ("close" if shared else "differ"), [muso[k] for k in only_m], [lnv[k] for k in only_l]


def _rhymes(a, b):
    """'Sajid Khan' and 'Wajid Khan' look like one person with a typo; they are brothers."""
    x, y = set(a.split()), set(b.split())
    rest_x, rest_y = x - y, y - x
    return bool(x & y) and len(rest_x) == 1 and len(rest_y) == 1 and fuzz.ratio(next(iter(rest_x)), next(iter(rest_y))) >= 70


def learn_aliases(pairs, people):
    """Stage names and legal names: when one ISRC ties a recording to an LNV row and exactly one name on each side is
    left over, those two are probably one person ('Turaz' / 'Aasmohammad Wahidahmed Choudhry'). Two such songs, with no
    competing partner for the name, make it a fact. Repeats while it teaches more."""
    learned = {}
    for _ in range(3):
        counts = Counter()
        for muso_names, lnv_names in pairs:
            m = {people.aliases.get(k, k) for k in muso_names}
            l = {people.aliases.get(k, k) for k in lnv_names}
            only_m = [k for k in m if not any(same_name(k, y) for y in l)]
            only_l = [k for k in l if not any(same_name(k, x) for x in m)]
            if len(only_m) == 1 and len(only_l) == 1 and not people.is_client(only_m[0]) and not people.is_client(only_l[0]):
                counts[(only_m[0], only_l[0])] += 1
        by_muso = defaultdict(list)
        for (a, b), n in counts.items():
            by_muso[a].append((n, b))
        fresh = 0
        for a, options in by_muso.items():
            options.sort(reverse=True)
            n, b = options[0]
            if n >= 2 and (len(options) == 1 or options[1][0] < n) and a not in people.aliases and not _rhymes(a, b):
                people.aliases[a] = b
                learned[a] = b
                fresh += 1
        if not fresh:
            break
    return learned


# ---------------------------------------------------------------- the LNV side

def _lnv_rows(master, people):
    out = []
    for s in master["songs"]:
        authors = [p["name"] for p in s.get("authors", [])]
        composers = [p["name"] for p in s.get("composers", [])]
        tag = parse_title(s["title"])[1]
        out.append({"row": s["row"], "title": s["title"], "alts": tuple(alternate_titles(s.get("alt_title") or "")), "album": "" if is_placeholder(s.get("movie")) else s["movie"],
                    "isrcs": set(s.get("isrcs") or ()), "authors": authors, "composers": composers,
                    "people": _writer_keys(people, authors + composers), "song": s, "tag": tag, "medley": is_medley(s["title"]),
                    "variant": bool(tag) or version_type(s["title"]) != ORIGINAL, "base": _base_key(s["title"]),
                    "original_work": s.get("original_work") or ""})
    return out


def other_sheets(path):
    """The LNV workbook's other sheets the team set aside ('NOT OUR', parked medleys): {isrcs, titles, bases} per sheet.
    A song the team already moved out of the catalogue is not added back on its own."""
    out = {}
    with Book(path) as book:
        for name in book.sheetnames[1:]:
            rows = book.rows(name)
            if not rows:
                continue
            col = read_layout(rows[0])["fields"].get("title")
            if col is None:
                continue
            isrc_cols = [i for i, h in enumerate(rows[0]) if clean_text(h).upper().startswith("ISRC")]
            isrcs, titles, bases = set(), set(), set()
            for r in rows[1:]:
                t = clean_text(r[col]) if col < len(r) else ""
                if not t:
                    continue
                titles.add(phonetic(t))
                if is_medley(t):
                    bases.add(_base_key(t))
                isrcs.update(v for c in isrc_cols if c < len(r) and (v := norm_isrc(r[c])))
            if titles:
                out[name] = {"isrcs": sorted(isrcs), "titles": sorted(titles), "bases": sorted(bases)}
    return out


# ---------------------------------------------------------------- the sheet side

def _recordings(rows, people):
    """Rows with one ISRC and one title are one recording. Muso can list several ISRCs on one row ('Baarish' with its
    Bengali, Telugu and Punjabi recordings): such a row never pulls those together, and an ISRC is owned by the row that
    names it most specifically, so the remix row owns the remix's ISRC."""
    n = len(rows)
    dsu, first = DSU(n), {}
    for i, r in enumerate(rows):
        for t in r["isrcs"]:
            if t in first:
                if _title_check(rows[first[t]]["title"], r["title"]) == "same":
                    dsu.union(first[t], i)
            else:
                first[t] = i
    alike = {}
    for i, r in enumerate(rows):
        if not r["isrcs"]:
            key = (phonetic(r["title"]), album_names(r["album"])[:1])
            if key in alike:
                dsu.union(alike[key], i)
            else:
                alike[key] = i
    groups = OrderedDict()
    for i in range(n):
        groups.setdefault(dsu.find(i), []).append(i)
    out, taken = [], set()
    for idxs in groups.values():
        idxs.sort(key=lambda i: (rows[i]["date"] or "9999", i))
        p = rows[idxs[0]]
        isrcs = list(OrderedDict.fromkeys(t for i in idxs for t in rows[i]["isrcs"]))
        key = isrcs[0] if isrcs else "T" + phonetic(p["title"])[:120]
        while key in taken:
            key += f"@{p['row']}"
        taken.add(key)
        lyricists = list(OrderedDict.fromkeys(x for i in idxs for x in rows[i]["lyricists"]))
        composers = list(OrderedDict.fromkeys(x for i in idxs for x in rows[i]["composers"]))
        singers = list(OrderedDict.fromkeys(x for i in idxs for x in rows[i]["singers"]))
        base, tag, film = parse_title(p["title"])
        titles = list(OrderedDict.fromkeys(rows[i]["title"] for i in idxs))
        tagged = bool(tag) or version_type(p["title"]) != ORIGINAL
        out.append({
            "key": key, "rows": [rows[i]["row"] for i in idxs], "title": p["title"], "base": base, "tag": tag,
            "films": [f for f in (parse_title(t)[2] for t in titles) if f], "base_key": phonetic(base), "album": p["album"],
            "albums": list(OrderedDict.fromkeys(rows[i]["album"] for i in idxs if rows[i]["album"])), "titles": titles,
            "isrcs": isrcs, "own": list(isrcs), "date": p["date"], "year": p["date"][:4] if p["date"] else "",
            "lyricists": lyricists, "composers": composers, "singers": singers, "people": _writer_keys(people, lyricists + composers),
            "credits": [c for c in (_writer_keys(people, rows[i]["lyricists"] + rows[i]["composers"]) for i in idxs) if c],
            "singer_keys": {people.key(x) for x in singers}, "label": p["label"], "duration": p["duration"], "link": p["link"],
            "medley": is_medley(p["title"]), "type": version_type(p["title"]), "variant": tagged,
            "popularity": max((rows[i]["popularity"] or 0) for i in idxs),
        })
    holders = defaultdict(list)
    for r in out:
        for t in r["isrcs"]:
            holders[t].append(r)
    for t, rs in holders.items():
        if len(rs) > 1:
            owner = min(rs, key=lambda r: (len(r["isrcs"]), r["rows"][0]))
            for r in rs:
                if r is not owner:
                    r["own"] = [x for x in r["own"] if x != t]
    return out


def same_song(people, a, b):
    """Two writer lists can be one song: a side has none, the client is on both, or they share a writer."""
    if not a or not b or (any(people.is_client(k) for k in a) and any(people.is_client(k) for k in b)):
        return True
    wa, wb = [k for k in a if not people.is_client(k)], [k for k in b if not people.is_client(k)]
    return not wa or not wb or any(same_name(x, y) for x in wa for y in wb)


def _compatible(a, b, people):
    """Two recordings with one song name are one song: the client on both, a shared writer, a side with no credits, one
    album, or a shared ISRC. 'Maahi Ve' of Kaante is not 'Maahi Ve' of Kal Ho Naa Ho."""
    if set(a["isrcs"]) & set(b["isrcs"]):
        return True
    if any(same_album(x, y) for x in a["albums"] for y in b["albums"]):
        return True
    return same_song(people, a["people"], b["people"])


def _families(recs, lnv, by_isrc, people):
    """The song families, each with its original. Of a family's plain releases: the oldest the LNV holds by ISRC, else
    the oldest. A family with only versions has no original on the sheet."""
    plain_bases = sorted({r["base_key"] for r in recs if not r["variant"] and not r["medley"] and r["base_key"]}, key=len, reverse=True)
    buckets = defaultdict(list)
    for i, r in enumerate(recs):
        if r["medley"] or not r["base_key"]:
            continue
        key = r["base_key"]
        if r["variant"] and key not in plain_bases:
            # the tag had no separator the parser knew: the longest plain song name this title starts with
            whole = phonetic(r["title"])
            key = next((b for b in plain_bases if len(b) >= 5 and whole.startswith(b)), key)
        buckets[key].append(i)
    keys = sorted(buckets)
    merged, by_start = DSU(len(keys)), defaultdict(list)
    for n, k in enumerate(keys):
        by_start[k[:1]].append(n)
    for ns in by_start.values():
        for a in range(len(ns)):
            for b in range(a + 1, len(ns)):
                if close_keys(keys[ns[a]], keys[ns[b]]):
                    merged.union(ns[a], ns[b])
    joined = defaultdict(list)
    for n, k in enumerate(keys):
        joined[merged.find(n)].extend(buckets[k])
    groups = []
    for members in joined.values():
        dsu = DSU(len(members))
        for a in range(len(members)):
            for b in range(a + 1, len(members)):
                if _compatible(recs[members[a]], recs[members[b]], people):
                    dsu.union(a, b)
        split = defaultdict(list)
        for n, i in enumerate(members):
            split[dsu.find(n)].append(i)
        groups.extend(split.values())

    def tied(r):
        """LNV rows that hold this recording's ISRC as the plain song ('Version 1' counts: that is how the LNV numbers a
        film's own recordings)."""
        rows = (lnv[j] for t in r["tied"] for j in by_isrc.get(t, ()))
        return [l for l in rows if _title_check(r["title"], l["title"]) != "differ" and (not l["variant"] or re.fullmatch(r"version\s*\d+", l["tag"].strip(), re.I))]

    def released(r, rows):
        """Muso's date can be a compilation's; the year the LNV gives the same ISRC counts too."""
        years = [str(l["song"].get("release_year") or "") for l in rows]
        return min([r["date"] or "9999"] + [y for y in years if re.fullmatch(r"\d{4}", y)])

    out = []
    for members in groups:
        when = {i: released(recs[i], tied(recs[i])) for i in members}
        plain = [i for i in members if not recs[i]["variant"]]
        pool = [i for i in plain if tied(recs[i])] or plain
        main = min(pool, key=lambda i: (when[i], recs[i]["rows"][0])) if pool else None
        oldest = min(members, key=lambda i: (when[i], recs[i]["rows"][0]))
        fam = {"id": len(out), "members": members, "main": main, "base": recs[members[0]]["base"], "base_key": recs[members[0]]["base_key"],
               "tagged_older": main is not None and recs[oldest]["variant"] and when[oldest] < when[main]}
        for i in members:
            recs[i]["family"] = fam["id"]
        out.append(fam)
    return out


# ---------------------------------------------------------------- one recording against one row

def _album_check(rec, l, fam_album, shared):
    """same · differ: any release of the recording; or – for a version the LNV files under its film – the original's
    album; with a shared ISRC, a self-titled single on either side is no different album either."""
    if any(same_album(a, l["album"]) for a in rec["albums"]) or any(same_album(f, l["album"]) for f in rec["films"]):
        return "same"
    if not l["album"]:
        return "same" if shared else "differ"
    if fam_album and same_album(fam_album, l["album"]) and (shared or (rec["variant"] and l["variant"])):
        return "same"
    if shared:
        titles = {phonetic(t) for t in rec["titles"]} | {rec["base_key"], _squash(rec["title"])}
        if any(phonetic(a) in titles or _squash(a) in titles for a in rec["albums"]) or phonetic(l["album"]) in {phonetic(l["title"]), l["base"]}:
            return "same"
    return "differ"


def _version_clash(rec, l):
    """Both sides name a version, and not the same one ('Remix' / 'Bengali Version'); a tag that is only the film's name
    ('Oru Kanam - Half Girlfriend') names no version."""
    def tags(tag, albums):
        return "" if not tag or any(same_album(tag, a) for a in albums) else tag
    a, b = tags(rec["tag"], rec["albums"] + rec["films"]), tags(l["tag"], [l["album"]] if l["album"] else [])
    if not a or not b:
        return False
    wa, wb = _tag_words(a), _tag_words(b)
    return not (wa <= wb or wb <= wa or fuzz.token_set_ratio(" ".join(sorted(wa)), " ".join(sorted(wb))) >= 80)


def compare(rec, l, people, fam_album=""):
    shared = bool(set(rec["tied"]) & l["isrcs"])
    isrc = "same" if shared else "blank" if not l["isrcs"] else "none" if not rec["isrcs"] else "differ"
    title = max((compare_titles(t, l["title"], l["alts"]) for t in rec["titles"]), key=("differ", "similar", "same").index)
    album = _album_check(rec, l, fam_album, shared)
    best, rank = None, {"same": 3, "blank": 2, "close": 1, "differ": 0}
    # the best of the recording's own rows: Muso sometimes credits one ISRC differently on two releases
    for muso in rec["credits"] or [rec["people"]]:
        r = credit_status(people, muso, l["people"], rec["singer_keys"])
        if best is None or rank[r[0]] > rank[best[0]]:
            best = r
    return {"row": l["row"], "isrc": isrc, "title": title, "album": album, "credits": best[0], "only_muso": best[1], "only_lnv": best[2],
            "clash": title != "same" and _version_clash(rec, l)}


def level(c, rec):
    """The team's rule on one comparison."""
    if c["isrc"] == "same":
        # A row with several ISRCs does not say which recording this is: there the title must agree too
        title_ok = c["title"] == "same" if len(rec["tied"]) > 1 else c["title"] != "differ" and not c["clash"]
        return EXACT if title_ok and c["album"] == "same" and c["credits"] in ("same", "blank") else POSSIBLE
    if c["title"] == "same" and (c["album"] == "same" or (not rec["isrcs"] and not rec["albums"])):
        return POSSIBLE
    return None


def reason(c, rec):
    """Why a possible match is not exact, for grouping the review list."""
    if not rec["isrcs"] and not rec["albums"]:
        return "no_ids"
    if c["isrc"] == "same":
        return "title" if c["title"] != "same" else "album" if c["album"] != "same" else "credits"
    bad = c["credits"] in ("close", "differ")
    if c["isrc"] == "blank":
        return "isrc_blank_credits" if bad else "isrc_blank" if c["credits"] == "same" else "isrc_blank_no_credits"
    return "isrc_credits" if bad else "isrc"


def _rank(c):
    return ({"same": 2, "similar": 1, "differ": 0}[c["title"]], c["album"] == "same", {"same": 3, "blank": 2, "close": 1, "differ": 0}[c["credits"]])


# ---------------------------------------------------------------- the comparison

def compare_all(master, dsp, client_name="", aliases=None, decisions=None, set_aside=None):
    """master: parse_master · dsp: dataclean.parse_dsp · aliases: reviewer-approved {name key: key} ·
    decisions: {"rec:<key>": {"choice", "data"}} · set_aside: other_sheets(lnv path)."""
    decisions = decisions or {}
    people = People(dict(aliases or {}), _client_keys(master["songs"], client_name))
    rows = dsp["rows"]
    lnv = _lnv_rows(master, people)
    recs = _recordings(rows, people)
    by_isrc = defaultdict(list)
    for j, l in enumerate(lnv):
        for t in l["isrcs"]:
            by_isrc[t].append(j)

    def tie(recordings):
        """The ISRCs tying each recording to the LNV: those it owns, else those another recording of the sheet shares
        with it – an ISRC the LNV holds is never added again as a new row."""
        for r in recordings:
            r["tied"] = [t for t in r["own"] if t in by_isrc] or [t for t in r["isrcs"] if t in by_isrc]
    tie(recs)

    # Rows tied by ISRC teach who is who; every key is then worked out again with what was learned
    learned = learn_aliases([(tuple(r["people"]), tuple(lnv[j]["people"])) for r in recs for j in {j for t in r["tied"] for j in by_isrc.get(t, ())}
                             if r["people"] and lnv[j]["people"]], people)
    if learned:
        lnv = _lnv_rows(master, people)
        recs = _recordings(rows, people)
        tie(recs)

    families = _families(recs, lnv, by_isrc, people)
    by_base = defaultdict(list)
    for j, l in enumerate(lnv):
        by_base[l["base"]].append(j)
        for alt in l["alts"]:
            if (k := _base_key(alt)) and j not in by_base[k]:
                by_base[k].append(j)
    by_first = defaultdict(set)
    for k in by_base:
        by_first[k[:1]].add(k)
    isrc_owner = {t: r["key"] for r in recs for t in r["own"]}
    row_index = {l["row"]: j for j, l in enumerate(lnv)}

    def main_of(rec):
        fam = families[rec["family"]] if "family" in rec else None
        return recs[fam["main"]] if fam and fam["main"] is not None else None

    def fam_album(rec):
        m = main_of(rec)
        return film_of(m["album"], m["title"]) if m and m["key"] != rec["key"] else ""

    def candidates(rec):
        js = {j for t in rec["tied"] for j in by_isrc.get(t, ())}
        k = rec["base_key"]
        keys = {x for x in by_first.get(k[:1], ()) if close_keys(k, x)} if k else set()
        if (whole := phonetic(rec["title"])) in by_base:
            keys.add(whole)
        for x in keys:
            js.update(by_base[x])
        return js

    # A row an ISRC ties to one recording is not free for another; nor is a row the reviewer gave to one
    claimed = defaultdict(set)
    for j, l in enumerate(lnv):
        claimed[j] = {isrc_owner[t] for t in l["isrcs"] if t in isrc_owner}
    answered = {row_index[int(d["data"]["row"])]: key[4:] for key, d in decisions.items()
                if key.startswith("rec:") and d.get("choice") == "same" and (d.get("data") or {}).get("row") and int(d["data"]["row"]) in row_index}

    results = []
    for rec in recs:
        comps = []
        for j in candidates(rec):
            l = lnv[j]
            c = compare(rec, l, people, fam_album(rec))
            lev = level(c, rec)
            if not lev:
                continue
            if c["isrc"] != "same":
                if (claimed[j] and rec["key"] not in claimed[j]) or answered.get(j, rec["key"]) != rec["key"] or rec["variant"] != l["variant"]:
                    continue   # another recording's row, or a remix against the plain song's row
            comps.append({**c, "level": lev, "j": j})
        # While a row with the very title is there, rows of other versions that only share an ISRC are not this recording
        if any(c["title"] == "same" for c in comps):
            comps = [c for c in comps if c["title"] == "same"]
        comps.sort(key=lambda c: (c["level"] != EXACT, c["isrc"] != "same", tuple(-x for x in _rank(c)), lnv[c["j"]]["row"]))
        results.append({"rec": rec, "comps": comps})

    # Exact links are final: a row one recording holds exactly is not offered to others without its ISRC
    exact_rows = {c["j"]: r["rec"]["key"] for r in results for c in r["comps"] if c["level"] == EXACT}
    for r in results:
        r["comps"] = [c for c in r["comps"] if c["isrc"] == "same" or exact_rows.get(c["j"], r["rec"]["key"]) == r["rec"]["key"]]
    return _report(lnv, recs, families, results, people, decisions, dsp, learned, set_aside or {}, row_index, main_of)


def _brief(rec):
    return {"key": rec["key"], "title": rec["title"], "album": rec["album"], "albums": rec["albums"], "isrcs": rec["isrcs"], "own": rec["own"], "date": rec["date"],
            "year": rec["year"], "lyricists": rec["lyricists"], "composers": rec["composers"], "singers": rec["singers"][:8],
            "label": rec["label"], "duration": rec["duration"], "link": rec["link"], "rows": rec["rows"], "type": rec["type"],
            "variant": rec["variant"], "medley": rec["medley"], "popularity": rec["popularity"]}


def _lnv_brief(l):
    s = l["song"]
    return {"row": l["row"], "title": l["title"], "album": l["album"], "isrcs": sorted(l["isrcs"]), "year": s.get("release_year") or "",
            "lyricists": l["authors"], "composers": l["composers"], "singers": [p["name"] for p in s.get("singers", [])][:8],
            "label": s.get("label") or "", "duration": s.get("duration") or "", "language": s.get("language") or ""}


def _duration(v):
    m = re.fullmatch(r"(\d+):(\d{2})", v or "")
    return f"00:{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def _fills(rec, l):
    """Blanks of an LNV row the matched recording can fill. Nothing the LNV holds is overwritten."""
    s = l["song"]
    offers = [("ISRC", not l["isrcs"], (rec["own"] or rec["isrcs"] or [""])[0]), ("Release year", not s.get("release_year"), rec["year"]),
              ("Duration", not s.get("duration"), _duration(rec["duration"])), ("Label", not s.get("label"), rec["label"]),
              ("Movie / album", not s.get("movie"), film_of(rec["album"], rec["title"])), ("Singers", not s.get("singers"), ", ".join(rec["singers"][:6])),
              ("Lyricists", not s.get("authors"), ", ".join(rec["lyricists"][:6])), ("Composers", not s.get("composers"), ", ".join(rec["composers"][:6]))]
    return [{"row": l["row"], "title": l["title"], "field": f, "value": v} for f, blank, v in offers if blank and v]


def _report(lnv, recs, families, results, people, decisions, dsp, learned, set_aside, row_index, main_of):
    linked, hint = {}, {}
    for r in results:
        rec, comps = r["rec"], r["comps"]
        d = decisions.get(f"rec:{rec['key']}") or {}
        r["status"] = EXACT if comps and comps[0]["level"] == EXACT else POSSIBLE if comps else NEW
        r["answer"] = d
        row = None
        if d.get("choice") == "same" and int((d.get("data") or {}).get("row") or 0) in row_index:
            row = int(d["data"]["row"])
        elif r["status"] == EXACT and d.get("choice") not in ("new", "skip"):
            row = comps[0]["row"]
        if row:
            linked[rec["key"]] = hint[rec["key"]] = row
        elif comps and comps[0]["isrc"] == "same" and comps[0]["title"] != "differ" and d.get("choice") != "new":
            hint[rec["key"]] = comps[0]["row"]   # not answered yet, but the name of the original can still be the LNV's

    def plain_row(base, like, skip=None):
        """The LNV's plain row of a song name, its credits not those of other people."""
        rows = [l for l in lnv if l["base"] == base and not l["variant"] and not l["medley"] and l["row"] != skip and same_song(people, like, l["people"])]
        return min(rows, key=lambda l: (not l["people"], l["row"])) if rows else None   # a row with credits, before one without

    def named_original(m):
        """The original as it is to be written: the LNV's own spelling when it holds it."""
        row = hint.get(m["key"])
        if row in row_index:
            l = lnv[row_index[row]]
            return {"title": m["base"] if l["variant"] else l["title"], "album": l["album"] or film_of(m["album"], m["title"]), "row": row,
                    "language": l["song"].get("language") or ""}
        return {"title": m["base"], "album": film_of(m["album"], m["title"]), "row": None, "language": ""}

    def original_of(rec):
        """(title, album, row) of a recording's original; None when it is the original, or nothing anchors one."""
        if "family" not in rec:
            return None
        fam = families[rec["family"]]
        m = main_of(rec)
        if m and m["key"] == rec["key"]:
            return None
        if m:
            o = named_original(m)
        else:   # the sheet has only versions: the LNV's plain row, if it has one
            l = plain_row(fam["base_key"], rec["people"])
            if not l:
                return None
            o = {"title": l["title"], "album": l["album"], "row": l["row"], "language": l["song"].get("language") or ""}
        # A plain release on the original's own album is the original again, not a version of it
        if not rec["variant"] and any(same_album(a, o["album"]) for a in rec["albums"]) and _title_check(rec["title"], o["title"]) != "differ":
            return None
        return o

    items = []
    for r in results:
        rec, comps, status, d = r["rec"], r["comps"], r["status"], r["answer"]
        row = linked.get(rec["key"])
        choice = d.get("choice")
        also = [c["row"] for c in comps[1:] if c["level"] == EXACT and c["row"] != row] if status == EXACT else []
        cands = [{"row": c["row"], "isrc": c["isrc"], "title": c["title"], "album": c["album"], "credits": c["credits"],
                  "only_muso": c["only_muso"], "only_lnv": c["only_lnv"], "level": c["level"],
                  "reason": reason(c, rec) if c["level"] != EXACT else None, "lnv": _lnv_brief(lnv[c["j"]])} for c in comps[:3]]
        final = "linked" if row else "skip" if choice == "skip" else "add" if (status == NEW or choice in ("new", "add")) else "pending"
        hold = ""
        if status == NEW and not choice:
            aside = next((name for name, s in set_aside.items() if set(rec["isrcs"]) & set(s["isrcs"]) or phonetic(rec["title"]) in s["titles"]
                          or (rec["medley"] and rec["base_key"] in s["bases"])), "")
            hold = aside
        items.append({"key": rec["key"], "status": status, "final": "hold" if hold and final == "add" else final, "hold": hold,
                      "by": "you" if choice else "app", "choice": choice, "row": row, "also": also, "muso": _brief(rec),
                      "candidates": cands, "reason": cands[0]["reason"] if status == POSSIBLE and cands else None,
                      "credited": any(people.is_client(k) for k in rec["people"]), "original": original_of(rec),
                      "fills": _fills(rec, lnv[row_index[row]]) if row in row_index else []})

    # LNV rows that are versions name their original, whether the sheet has that version or not
    item_by_row = {}
    for it in items:
        if it["row"]:
            item_by_row.setdefault(it["row"], it)
    fam_by_base = defaultdict(list)
    for f in families:
        fam_by_base[f["base_key"]].append(f)
    named = []
    for l in lnv:
        if l["medley"] or l["original_work"]:
            continue
        it = item_by_row.get(l["row"])
        o = it["original"] if it else None
        if not it and l["variant"]:
            o = _unlinked_original(l, fam_by_base, recs, named_original, plain_row, people)
        if not o or o.get("row") == l["row"] or _title_check(l["title"], o["title"]) == "same" and not l["variant"]:
            continue
        if not l["variant"] and same_album(l["album"], o["album"]):
            continue   # the plain song on the original's own album: nothing to name
        named.append({"row": l["row"], "title": l["title"], "original": o})

    counts = Counter(i["status"] for i in items)
    finals = Counter(i["final"] for i in items)
    return {
        "items": items, "named": named, "families": len(families), "learned": learned, "reasons": REASONS,
        "source": dsp["source"], "sheet": dsp["sheet"],
        "counts": {"recordings": len(items), "exact": counts[EXACT], "possible": counts[POSSIBLE], "new": counts[NEW],
                   "open": finals["pending"], "added": finals["add"], "linked": finals["linked"], "held": finals["hold"], "skipped": finals["skip"],
                   "named": len(named) + sum(1 for i in items if i["final"] == "add" and i["original"]),
                   "fills": sum(len(i["fills"]) for i in items), "lnv_rows": len(lnv), "families": len(families),
                   "lnv_untouched": len(lnv) - len({i["row"] for i in items if i["row"]}),
                   "tagged_older": sum(1 for f in families if f["tagged_older"])},
    }


REPORT_HEADER = ["Result", "Decided by", "Why", "Muso title", "Muso album", "ISRC", "Released", "LNV row", "LNV title", "LNV album", "LNV ISRC",
                 "Title", "Album", "ISRC check", "Credits", "Only on Muso", "Only on LNV", "Original Work", "Original Movie / Album"]
RESULT_LABEL = {"linked": "In the LNV", "add": "New row added", "hold": "Not added", "skip": "Not added", "pending": "Waiting for review"}
BUCKET_LABEL = {EXACT: "Exact match", POSSIBLE: "Possible match", NEW: "Not found"}


def export_plan(result):
    """What the final LNV writes: blanks filled, version rows named, new rows, and the full comparison as a sheet."""
    items = result["items"]
    adds = []
    for i in items:
        if i["final"] != "add":
            continue
        m, o = i["muso"], i["original"]
        adds.append({"key": i["key"], "title": m["title"], "album": film_of(m["album"], m["title"]), "isrcs": m["own"] or m["isrcs"], "year": m["year"], "date": m["date"],
                     "duration": _duration(m["duration"]), "label": m["label"], "link": m["link"], "lyricists": m["lyricists"], "composers": m["composers"],
                     "singers": m["singers"], "original": o})
    report = []
    for i in sorted(items, key=lambda x: ({POSSIBLE: 0, NEW: 1, EXACT: 2}[x["status"]], x["muso"]["title"].lower())):
        m, c, o = i["muso"], (i["candidates"][0] if i["candidates"] else None), i["original"] or {}
        if i["row"]:
            c = next((x for x in i["candidates"] if x["row"] == i["row"]), c)
        report.append([
            BUCKET_LABEL[i["status"]] + " – " + RESULT_LABEL[i["final"]], "Reviewer" if i["by"] == "you" else "App",
            f"On the '{i['hold']}' sheet of the LNV" if i["hold"] else REASONS.get(i["reason"], ""), m["title"], m["album"], ", ".join(m["isrcs"]), m["date"],
            (c or {}).get("row"), c["lnv"]["title"] if c else "", c["lnv"]["album"] if c else "", ", ".join(c["lnv"]["isrcs"]) if c else "",
            (c or {}).get("title", ""), (c or {}).get("album", ""), (c or {}).get("isrc", ""), (c or {}).get("credits", ""),
            ", ".join((c or {}).get("only_muso", [])), ", ".join((c or {}).get("only_lnv", [])), o.get("title", ""), o.get("album", "")])
    return {"source": result["source"], "fills": [f for i in items if i["final"] == "linked" for f in i["fills"]], "adds": adds, "named": result["named"],
            "report": {"name": "Match report", "header": REPORT_HEADER, "rows": report,
                       "widths": (28, 10, 46, 42, 34, 16, 12, 8, 42, 30, 16, 9, 9, 9, 9, 34, 34, 32, 30)}}


def _unlinked_original(l, fam_by_base, recs, named_original, plain_row, people):
    """The original of an LNV version the sheet does not link to: its song family's, else the LNV's own plain row."""
    for fam in fam_by_base.get(l["base"], ()):
        if fam["main"] is None:
            continue
        m = recs[fam["main"]]
        if same_song(people, m["people"], l["people"]) or same_album(m["album"], l["album"]):
            return named_original(m)
    p = plain_row(l["base"], l["people"], skip=l["row"])
    return {"title": p["title"], "album": p["album"], "row": p["row"], "language": p["song"].get("language") or ""} if p else None
