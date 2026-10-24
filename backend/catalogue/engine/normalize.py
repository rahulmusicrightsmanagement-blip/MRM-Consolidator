"""Value cleaning and comparison helpers shared by every step.

Originals are always kept by callers; these functions only produce
comparison-ready values.
"""
import re
from functools import lru_cache

from rapidfuzz import fuzz

# Words that carry no identity in company names ("TIPS MUSIC LIMITED" vs "TIPS MUSIC").
_CORP_WORDS = {
    "ltd", "limited", "pvt", "private", "co", "company", "the", "inc", "llc",
    "industries", "india", "entertainment", "entertainments", "records", "music",
}


def clean_text(value):
    """Trim, drop line breaks, collapse spaces and strip stray trailing commas."""
    if value is None:
        return ""
    text = str(value).replace("\r", " ").replace("\n", " ").replace("\xa0", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text.rstrip(",").strip()


def clean_id(value):
    """Excel stores numeric IDs as floats (21313595.0) - return them as plain text."""
    if value is None or value == "":
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return clean_text(value)


def to_number(value):
    if value in (None, ""):
        return None
    try:
        return round(float(str(value).strip()), 4)
    except ValueError:
        return None


_NOT_ALNUM = re.compile(r"[^a-z0-9]")
_TITLE_TAIL = re.compile(r"\s+-\s+|\(|\bfeat\.?\b|\bft\.?\b")


# Cached: mapping compares every IPRS work with every master song, so each title would otherwise be cleaned
# thousands of times per report.
@lru_cache(maxsize=65536)
def norm_title(title):
    """Case, spacing and punctuation free title used for exact title comparison."""
    return _NOT_ALNUM.sub("", clean_text(title).lower())


VERSION_TAIL = re.compile(r"(\s+(live(\s+sessions?)?|lyric(al)?\s+video|video|unplugged|acoustic|reprise|remix|cover|version))+\s*$")


@lru_cache(maxsize=65536)
def title_core(title):
    """Title without featuring/version tails: 'KANNE - FEAT X' -> 'kanne', 'CHATHE LIVE' -> 'chathe'."""
    text = clean_text(title).lower()
    text = _TITLE_TAIL.split(text)[0]
    text = VERSION_TAIL.sub("", text)
    return _NOT_ALNUM.sub("", text)


_BY_TAIL = re.compile(r"\s+by\s+\S.*$", re.I)


@lru_cache(maxsize=65536)
def alternate_titles(text):
    """Names in an "Alternate Work" / "Alternate Title" cell, each also without a trailing "By <artist>":
    'Navarasam By Vipin Lal; Nava' -> ('Navarasam By Vipin Lal', 'Navarasam', 'Nava')."""
    out = []
    for part in re.split(r"[;|]", clean_text(text)):
        part = part.strip()
        for name in (part, _BY_TAIL.sub("", part)):
            if name and name not in out:
                out.append(name)
    return tuple(out)


def title_similarity(a, b):
    """0-100 similarity of two titles after normalisation."""
    na, nb = norm_title(a), norm_title(b)
    if not na or not nb:
        return 0
    if na == nb:
        return 100
    ca = title_core(a)
    if ca and ca == title_core(b):
        return 92
    return round(fuzz.ratio(na, nb))


def norm_iswc(value):
    """'T-332.565.700-5' / 'T3325657005' -> 'T3325657005'; '' if not a valid ISWC."""
    text = re.sub(r"[^0-9A-Za-z]", "", clean_text(value)).upper()
    return text if re.fullmatch(r"T\d{10}", text) else ""


def norm_isrc(value):
    """'In-T20-24-04686' -> 'INT202404686'; '' if not a valid ISRC."""
    text = re.sub(r"[^0-9A-Za-z]", "", clean_text(value)).upper()
    return text if re.fullmatch(r"[A-Z]{2}[A-Z0-9]{3}\d{7}", text) else ""


def norm_ipi(value):
    """IPI / CAE numbers are 11 digits; the master drops leading zeros."""
    digits = re.sub(r"\D", "", clean_id(value))
    return digits.zfill(11) if digits else ""


def name_tokens(name):
    tokens = re.findall(r"[a-z0-9]+", clean_text(name).lower())
    meaningful = frozenset(t for t in tokens if t not in _CORP_WORDS)
    return meaningful or frozenset(tokens)


def same_party(name_a, name_b, ipi_a="", ipi_b=""):
    """True when two contributor entries are the same person or company.

    Equal IPI numbers decide. Otherwise names are compared as word sets so
    'SURESH, DHANYA', 'DHANYA, SURESH' and 'Dhanya Suresh Menon' agree (a person
    can hold several IPI name numbers, and the master often has them mistyped).
    """
    ipi_a, ipi_b = norm_ipi(ipi_a), norm_ipi(ipi_b)
    if ipi_a and ipi_a == ipi_b:
        return True
    a, b = name_tokens(name_a), name_tokens(name_b)
    if not a or not b:
        return False
    return _covers(a, b) or _covers(b, a)


def _covers(small, big):
    """Every word of `small` pairs with its own word of `big`: the same word, or a one-letter initial of it.
    Each word is used once and at least one full word must be the same, so 'S Rafeeq Ahmed' never matches
    'Sushin Shyamprakash' (one initial "S" cannot stand for two words)."""
    pool = list(big)
    exact = 0
    for x in sorted(small, key=len, reverse=True):  # full words first, initials last
        y = next((y for y in pool if y == x), None) \
            or next((y for y in pool if (len(x) == 1 and y.startswith(x)) or (len(y) == 1 and x.startswith(y))), None)
        if y is None:
            return False
        pool.remove(y)
        exact += x == y and len(x) > 1
    return exact > 0


def display_name(name):
    """'SURESH, DHANYA' -> 'Dhanya Suresh' for readable reports."""
    text = clean_text(name)
    if "," in text:
        last, first = [p.strip() for p in text.split(",", 1)]
        text = f"{first} {last}".strip()
    return text.title()
