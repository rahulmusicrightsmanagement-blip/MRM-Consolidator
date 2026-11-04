"""Fast read of .xlsx sheets: only cells that hold a value are looked at.

LNV exports carry formatting on millions of empty cells (one Javed Akhtar LNV: 4.2 million cells, 80 thousand
with a value). openpyxl builds every one of them and needs ~25 s for that file; this reader needs ~1 s.
Values come out as openpyxl gives them with data_only=True (shared strings, numbers, dates by number format).
"""
import html
import posixpath
import re
import zipfile
from datetime import datetime
from xml.etree import ElementTree as ET

from openpyxl.styles.numbers import BUILTIN_FORMATS, is_date_format, is_timedelta_format
from openpyxl.utils.datetime import CALENDAR_MAC_1904, CALENDAR_WINDOWS_1900, from_excel

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
ROW = re.compile(rb"<row\b[^>]*?\br=\"(\d+)\"[^>]*?(?:/>|(?<!/)>(.*?)</row>)", re.S)
# Only cells with content: an empty cell ends in "/>" and never matches the ">" after its attributes.
CELL = re.compile(rb"<c\b((?:\s+[\w:]+=\"[^\"]*\")*)\s*>(.*?)</c>", re.S)
REF = re.compile(rb"([A-Z]+)(\d+)")
ATTR = re.compile(rb"([\w:]+)=\"([^\"]*)\"")
VALUE = re.compile(rb"<v>(.*?)</v>", re.S)
TEXT = re.compile(rb"<t\b[^>]*?(?:/>|>(.*?)</t>)", re.S)
PHONETIC = re.compile(rb"<rPh\b.*?</rPh>", re.S)


def _col(ref):
    n = 0
    for ch in ref:
        if ch < 65:   # first digit: the row number starts
            break
        n = n * 26 + ch - 64
    return n


def _unescape(raw):
    """Text as an XML parser gives it: line breaks normalised to \\n, then entities (&#13; stays a \\r)."""
    return html.unescape(raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n").decode())


def _text(xml):
    """Plain text of a <si> or <is> element (rich-text runs joined, phonetic hints left out)."""
    return "".join(_unescape(m) for m in TEXT.findall(PHONETIC.sub(b"", xml)) if m)


def _number(raw):
    return float(raw) if b"." in raw or b"E" in raw or b"e" in raw else int(raw)


class Book:
    def __init__(self, path):
        self.zip = zipfile.ZipFile(path)
        wb = ET.fromstring(self.zip.read("xl/workbook.xml"))
        rels = ET.fromstring(self.zip.read("xl/_rels/workbook.xml.rels"))
        targets = {r.get("Id"): r.get("Target") for r in rels}
        self.sheets = []
        for s in wb.iter(f"{NS}sheet"):
            target = targets.get(s.get(REL), "")
            if "worksheets/" not in target:   # chart sheets have no cells
                continue
            path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
            self.sheets.append((s.get("name"), path))
        pr = wb.find(f"{NS}workbookPr")
        self.epoch = CALENDAR_MAC_1904 if pr is not None and pr.get("date1904") in ("1", "true") else CALENDAR_WINDOWS_1900
        self._strings = None
        self._styles = None

    @property
    def sheetnames(self):
        return [name for name, _ in self.sheets]

    def close(self):
        self.zip.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def strings(self):
        if self._strings is None:
            try:
                xml = self.zip.read("xl/sharedStrings.xml")
            except KeyError:
                xml = b""
            self._strings = [_text(si) for si in re.findall(rb"<si\b[^>]*>(.*?)</si>|<si\s*/>", xml, re.S)]
        return self._strings

    def styles(self):
        """Style index → "date" / "timedelta" for cells whose number format shows a date or a time."""
        if self._styles is None:
            self._styles = {}
            try:
                root = ET.fromstring(self.zip.read("xl/styles.xml"))
            except KeyError:
                return self._styles
            custom = {int(f.get("numFmtId")): f.get("formatCode") for f in root.iter(f"{NS}numFmt")}
            xfs = root.find(f"{NS}cellXfs")
            for i, xf in enumerate(xfs if xfs is not None else []):
                fid = int(xf.get("numFmtId") or 0)
                fmt = custom.get(fid) or BUILTIN_FORMATS.get(fid)
                if fmt and is_date_format(fmt):
                    self._styles[i] = "timedelta" if is_timedelta_format(fmt) else "date"
        return self._styles

    def rows(self, sheet=0):
        """Every row of the sheet (by index or name) as a tuple, from row 1 to the last row with a value.
        Rows are as wide as the widest row; empty rows are empty tuples."""
        name, path = self.sheets[sheet] if isinstance(sheet, int) else next(s for s in self.sheets if s[0] == sheet)
        xml = self.zip.read(path)
        strings, styles = None, self.styles()
        found = {}
        for row, col, attrs, inner in _cells(xml):
            kind = attrs.get(b"t", b"n")
            if kind == b"inlineStr":
                m = re.search(rb"<is>(.*?)</is>", inner, re.S)
                value = _text(m.group(1)) if m else None
            else:
                m = VALUE.search(inner)
                if not m:
                    continue
                raw = m.group(1)
                if kind == b"s":
                    strings = strings if strings is not None else self.strings()
                    value = strings[int(raw)]
                elif kind in (b"str", b"e"):
                    value = _unescape(raw)
                elif kind == b"b":
                    value = bool(int(raw))
                elif kind == b"d":
                    value = datetime.fromisoformat(raw.decode().rstrip("Z"))
                else:
                    value = _number(raw)
                    style = styles.get(int(attrs.get(b"s", b"0")))
                    if style:
                        value = from_excel(value, self.epoch, timedelta=style == "timedelta")
            if value is not None:
                found.setdefault(row, {})[col] = value
        if not found:
            return []
        width = max(max(c) for c in found.values())
        out = []
        for n in range(1, max(found) + 1):
            cells = found.get(n)
            if not cells:
                out.append(())
                continue
            row = [None] * width
            for c, v in cells.items():
                row[c - 1] = v
            out.append(tuple(row))
        return out


def _cells(xml):
    """(row, column, attributes, inner xml) of every cell with content. Such a cell is the only kind that ends in
    "</c>", so the search jumps from one to the next instead of walking millions of empty cells."""
    out = []
    pos = 0
    while True:
        end = xml.find(b"</c>", pos)
        if end < 0:
            return out
        start = xml.rfind(b"<c ", pos, end)
        gt = xml.find(b">", start)
        attrs = dict(ATTR.findall(xml, start, gt)) if start >= 0 else {}
        ref = REF.fullmatch(attrs.get(b"r", b""))
        if not ref:   # a cell without its address (rare writers): read row by row instead
            return _cells_by_row(xml)
        out.append((int(ref.group(2)), _col(ref.group(1)), attrs, xml[gt + 1:end]))
        pos = end + 4


def _cells_by_row(xml):
    out = []
    for rm in ROW.finditer(xml):
        n, col = int(rm.group(1)), 0
        for cm in CELL.finditer(rm.group(2) or b""):
            attrs = dict(ATTR.findall(cm.group(1)))
            ref = REF.fullmatch(attrs.get(b"r", b""))
            col = _col(ref.group(1)) if ref else col + 1
            out.append((n, col, attrs, cm.group(2)))
    return out


def read_rows(path, sheet=0):
    with Book(path) as book:
        return book.rows(sheet)
