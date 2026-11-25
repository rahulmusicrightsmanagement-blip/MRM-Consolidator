"""Write a few changes into a large .xlsx without loading it: the cells that change are rewritten in the first
sheet's XML, every other byte of the file is copied as it is. An LNV can hold over 4 million formatted cells (1,424
columns × 2,940 rows, a 94 MB sheet); openpyxl reads and writes every one of them – about a minute – to change a few
thousand. PatchSheet offers the part of openpyxl's worksheet the LNV writers use (cell(row, col).value / .fill,
ws[1], max_row), records the changes, and save() writes them, plus a "MRM changes" sheet, into a copy of the file.

The file saved is small: almost all of a big LNV is empty cells that only repeat the look their column or row has
anyway (5 MB of a 5.2 MB file). compact_sheet leaves those out – every value, formula, link, width and colour stays as
it was, cell by cell – and every part is compressed as far as it goes.
"""
import io
import re
import zipfile
from collections import Counter
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape, quoteattr

from openpyxl.utils import column_index_from_string, get_column_letter

from .normalize import is_link, printable
from .xlsx import Book, _xml

R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WORKSHEET = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
WORKSHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
ROW_RE = re.compile(r"<row\b[^>]*?(?:/>|>.*?</row>)", re.S)
CELL_RE = re.compile(r"<c\b([^>]*?)(?:/>|>(.*?)</c>)", re.S)
XF_RE = re.compile(r"<xf\b[^>]*?(?:/>|>.*?</xf>)", re.S)
HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
LEVEL = 9   # the most a zip can do: the sheet is small by then, so it costs little


# ---------------------------------------------------------------- empty cells that only repeat their column's look

# An empty cell as every writer puts it; any other form is left alone
EMPTY_RE = re.compile(r'<c r="([A-Z]+)\d+"(?: s="(\d+)")?\s*/>')
EMPTY_STYLE = re.compile(r'<c r="[A-Z]+\d+"(?: s="(\d+)")?\s*/>')
COL_RE = re.compile(r"<col\b[^>]*?/>")
WORTH = 5000        # empty cells of one look before the column takes it over
WIDE = 200          # cells of one colour in a row before the row takes it over
MAX_COLS = 16384


def visible_styles(styles):
    """The cell styles an empty cell shows (a fill or a border): {style index}."""
    root = _xml(styles if isinstance(styles, bytes) else styles.encode("utf-8"))
    fills = [f for f in root.find(f"{MAIN}fills") or []]
    borders = [b for b in root.find(f"{MAIN}borders") or []]
    filled = {i for i, f in enumerate(fills) if any(p.get("patternType") not in (None, "none") for p in f.iter(f"{MAIN}patternFill"))
              or f.find(f"{MAIN}gradientFill") is not None}
    lined = {i for i, b in enumerate(borders) if any(e.get("style") not in (None, "none") for e in b)}
    xfs = root.find(f"{MAIN}cellXfs")
    return {i for i, xf in enumerate(xfs if xfs is not None else [])
            if int(xf.get("fillId") or 0) in filled or int(xf.get("borderId") or 0) in lined}


def _attr(tag, name):
    m = re.search(rf'\s{name}="([^"]*)"', tag)
    return m.group(1) if m else None


def column_styles(xml):
    """{column: style} of the sheet's columns that have one."""
    out = {}
    for tag in COL_RE.findall(xml[:xml.find("<sheetData")]):
        style = _attr(tag, "style")
        if style and style != "0":
            for c in range(int(_attr(tag, "min")), min(int(_attr(tag, "max")), MAX_COLS) + 1):
                out[c] = int(style)
    return out


def _style_columns(xml, style, last):
    """The columns 1..last that have no look of their own given this one (it shows nothing on an empty cell)."""
    start = xml.find("<sheetData")
    head, body = xml[:start], xml[start:]
    tags = COL_RE.findall(head)
    m = re.search(r'defaultColWidth="([^"]+)"', head)
    width = m.group(1) if m else "9.140625"
    out, at = [], 1
    for tag in sorted(tags, key=lambda t: int(_attr(t, "min"))):
        lo, hi = int(_attr(tag, "min")), int(_attr(tag, "max"))
        if lo > at and at <= last:
            out.append(f'<col min="{at}" max="{min(lo - 1, last)}" width="{width}" style="{style}"/>')
        if _attr(tag, "style") in (None, "0") and lo <= last:
            bare = re.sub(r'\sstyle="[^"]*"', "", tag)
            if hi > last:   # only the part in use
                out.append(re.sub(r'\smax="[^"]*"', f' max="{last}"', bare).replace("<col", f'<col style="{style}"', 1))
                out.append(re.sub(r'\smin="[^"]*"', f' min="{last + 1}"', bare))
            else:
                out.append(bare.replace("<col", f'<col style="{style}"', 1))
        else:
            out.append(tag)
        at = max(at, hi + 1)
    if at <= last:
        out.append(f'<col min="{at}" max="{last}" width="{width}" style="{style}"/>')
    cols = f'<cols>{"".join(out)}</cols>'
    if "<cols>" in head:
        head = re.sub(r"<cols>.*?</cols>", lambda _: cols, head, flags=re.S)
    elif re.search(r"<cols\s*/>", head):
        head = re.sub(r"<cols\s*/>", lambda _: cols, head)
    else:
        head += cols
    return head + body


def compact_sheet(xml, visible):
    """A sheet's XML without the empty cells that only repeat what their column or row says anyway: a cell that is left
    out takes its row's look, else its column's – the very one it had. First the columns take over the look most empty
    cells have (one that shows nothing: no fill, no border), and a row coloured all the way across takes its colour."""
    if "<sheetData" not in xml:
        return xml
    xml = full_refs(xml)
    counts = Counter(EMPTY_STYLE.findall(xml))
    if not counts:
        return xml
    cols = before = column_styles(xml)
    last = max((column_index_from_string(m) for m in set(re.findall(r'<c r="([A-Z]+)\d+"', xml))), default=1)
    # the look the columns take over: none at all, unless far more empty cells have another that shows nothing
    plain = counts.get("", 0) + counts.get("0", 0)
    best = max(((n, s) for s, n in counts.items() if s not in ("", "0") and int(s) not in visible), default=(0, ""))
    if best[0] >= WORTH and best[0] > plain:
        xml = _style_columns(xml, best[1], last)
        cols = column_styles(xml)
    base = Counter(cols.get(c, 0) for c in range(1, last + 1)).most_common(1)[0][0]
    odd = {c: s for c, s in cols.items() if s != base and c <= last}
    odd.update({c: 0 for c in range(1, last + 1) if base and c not in cols})
    of = lambda letters: odd.get(column_index_from_string(letters), base)
    tag_of = lambda s: r'(?: s="0")?' if s == 0 else f' s="{s}"'
    # at C speed while few columns have a look of their own: every other cell of the base look goes
    quick = re.compile('<c r="' + (f'(?!(?:{"|".join(get_column_letter(c) for c in odd)})\\d)' if odd else "") + rf'[A-Z]+\d+"{tag_of(base)}\s*/>') if len(odd) <= 300 else None

    def row(m):
        x = m.group(0)
        tag = re.match(r"<row\b[^>]*>", x).group(0)
        if tag.endswith("/>"):
            return x
        own = int(_attr(tag, "s")) if _attr(tag, "customFormat") in ("1", "true") and _attr(tag, "s") else None
        if own is not None:
            less = re.sub(rf'<c r="[A-Z]+\d+"{tag_of(own)}\s*/>', "", x)
        else:
            less = quick.sub("", x) if quick else x
            if odd or not quick:
                less = EMPTY_RE.sub(lambda c: "" if int(c.group(2) or 0) == of(c.group(1)) else c.group(0), less)
        return _best_row(x, tag, own, cols, before) if len(EMPTY_STYLE.findall(less)) > WIDE else less
    return ROW_RE.sub(row, xml)


def _best_row(x, tag, own, cols, before):
    """A row with many empty cells, written the shortest way: the look most of them have becomes the row's – or, where a
    row's look is hidden by its own cells, the row has none – and only the cells that differ from it are written. All
    16,384 columns look as they did (own: the row's look now; before: the columns' looks in the file as it came)."""
    cells = {}
    for c in re.finditer(r'<c\b([^>]*?)(?:/>|>(.*?)</c>)', x[len(tag):], re.S):
        ref = re.search(r'\br="([A-Z]+)\d+"', c.group(1))
        if not ref:
            return x
        cells[column_index_from_string(ref.group(1))] = (c.group(0), int(_attr(" " + c.group(1), "s") or 0), EMPTY_RE.fullmatch(c.group(0)) is not None)
    look = [own if own is not None else before.get(c, 0) for c in range(MAX_COLS + 1)]
    for c, (_, style, _) in cells.items():
        look[c] = style
    blank = [c for c in range(1, MAX_COLS + 1) if c not in cells or cells[c][2]]
    cost = {None: sum(1 for c in blank if look[c] != cols.get(c, 0))}
    for style, n in Counter(look[c] for c in blank).most_common(2):
        cost[style] = len(blank) - n
    best = min(cost, key=lambda k: (cost[k], k is not None))
    n = _attr(tag, "r")
    kept = {c: t for c, (t, _, empty) in cells.items() if not empty}
    for c in blank:
        if look[c] != (cols.get(c, 0) if best is None else best):
            kept[c] = f'<c r="{get_column_letter(c)}{n}"' + (f' s="{look[c]}"' if look[c] else "") + "/>"
    bare = re.sub(r'\s(?:s|customFormat)="[^"]*"', "", tag)
    head = bare if best is None else f'{bare[:-1]} s="{best}" customFormat="1">'
    return head + "".join(kept[c] for c in sorted(kept)) + "</row>"


# a cell's start tag; its address when it has one
TAG_RE = re.compile(r"<c(?=[\s/>])([^>]*?)(/?)>")


def full_refs(xml):
    """Every cell with its address: short_refs taken back."""
    if not re.search(r'<c(?=[\s/>])(?![^>]*\sr=)', xml):
        return xml

    def row(m):
        x = m.group(0)
        tag = re.match(r"<row\b[^>]*>", x).group(0)
        n, at = _attr(tag, "r"), [0]

        def cell(c):
            ref = re.search(r'\sr="([A-Z]+)\d+"', c.group(1))
            at[0] = column_index_from_string(ref.group(1)) if ref else at[0] + 1
            return c.group(0) if ref else f'<c r="{get_column_letter(at[0])}{n}"{c.group(1)}{c.group(2)}>'
        return tag + TAG_RE.sub(cell, x[len(tag):])
    return ROW_RE.sub(row, xml)


def short_refs(xml, all_cells=False):
    """An empty cell right after another cell needs no address (the one before it says where it is). Cells with a value
    keep theirs, unless all_cells."""
    def row(m):
        x = m.group(0)
        if not all_cells and len(re.findall(r"<c(?=[\s/])[^>]*/>", x)) < 20:
            return x
        at = [0]

        def cell(c):
            ref = re.search(r'\sr="([A-Z]+)\d+"', c.group(1))
            if not ref:
                at[0] += 1
                return c.group(0)
            col = column_index_from_string(ref.group(1))
            follows, at[0] = col == at[0] + 1 and col > 1, col
            return f"<c{c.group(1).replace(ref.group(0), '', 1).rstrip()}{c.group(2)}>" if follows and (c.group(2) or all_cells) else c.group(0)
        return TAG_RE.sub(cell, x)
    return ROW_RE.sub(row, xml)


def _drop_calc_chain(files):
    """Excel's list of formula cells: it makes a fresh one when it opens the file, and a stale one is a damaged file."""
    if "xl/calcChain.xml" not in files:
        return
    del files["xl/calcChain.xml"]
    for name in ("xl/_rels/workbook.xml.rels", "[Content_Types].xml"):
        text = files[name].decode("utf-8")
        text = re.sub(r'<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*?/>', "", text)
        files[name] = re.sub(r'<Override\b[^>]*PartName="/xl/calcChain\.xml"[^>]*?/>', "", text).encode("utf-8")


SI_RE = re.compile(r"<si\b[^>]*?(?:/>|>.*?</si>)", re.S)
INLINE_RE = re.compile(r'(<c(?=\s)[^>]*?)\st="inlineStr"([^>]*)><is><t xml:space="preserve">([^<]*)</t></is></c>')
SHARED_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"
SHARED_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings"


def share_strings(files, first=None):
    """Every text of the workbook once, in the order the sheets use them (the sheet `first` before the others): rows put
    in another order, and texts written over, leave a list that packs badly. No text changes."""
    path = "xl/sharedStrings.xml"
    sheets = sorted((n for n in files if re.fullmatch(r"xl/worksheets/[^/]+\.xml", n)), key=lambda n: (n != first, n))
    old = SI_RE.findall(files[path].decode("utf-8")) if path in files else []
    texts = {n: files[n].decode("utf-8") for n in sheets}
    if any(int(m) >= len(old) for x in texts.values() for m in re.findall(r'\st="s"[^>]*><v>(\d+)</v>', x)):
        return   # a list that is not complete: left as it is
    index, uses = {}, [0]

    def at(si):
        uses[0] += 1
        return index.setdefault(si, len(index))
    for n, x in texts.items():
        text = lambda m: f'<si><t xml:space="preserve">{m.group(3)}</t></si>'
        texts[n] = INLINE_RE.sub(lambda m: f'{m.group(1)} t="s"{m.group(2)}><v>#{at(text(m))}</v></c>', x)
    if not index and not old:
        return
    # in the order of use, the inline ones where they stand
    inline = list(index)
    index, uses[0] = {}, 0
    any_shared = re.compile(r'(<c(?=\s)[^>]*?\st="s"[^>]*>(?:<f\b[^>]*?(?:/>|>[^<]*</f>))?<v>)(#?)(\d+)(</v>)')
    for n, x in texts.items():
        texts[n] = any_shared.sub(lambda m: f"{m.group(1)}{at(inline[int(m.group(3))] if m.group(2) else old[int(m.group(3))])}{m.group(4)}", x)
    files.update({n: x.encode("utf-8") for n, x in texts.items()})
    files[path] = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{uses[0]}" uniqueCount="{len(index)}">'
                   + "".join(index) + "</sst>").encode("utf-8")
    types = files["[Content_Types].xml"].decode("utf-8")
    if "/xl/sharedStrings.xml" not in types:
        files["[Content_Types].xml"] = types.replace("</Types>", f'<Override ContentType="{SHARED_TYPE}" PartName="/xl/sharedStrings.xml"/></Types>').encode("utf-8")
    rels = files["xl/_rels/workbook.xml.rels"].decode("utf-8")
    if "sharedStrings.xml" not in rels:
        files["xl/_rels/workbook.xml.rels"] = rels.replace("</Relationships>", f'<Relationship Id="rIdMrmS" Type="{SHARED_REL}" Target="sharedStrings.xml"/></Relationships>').encode("utf-8")


TARGET = 1000 * 1000   # what a file may weigh before every byte counts


def _zip(files):
    def pack():
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=LEVEL) as w:
            for name, data in files.items():
                w.writestr(name, data)
        return out.getvalue()
    packed = pack()
    if len(packed) <= TARGET:
        return packed
    for name in files:   # only for a big file: no address on any cell that follows another one
        if re.fullmatch(r"xl/worksheets/[^/]+\.xml", name):
            files[name] = short_refs(files[name].decode("utf-8"), all_cells=True).encode("utf-8")
    tight = pack()
    return tight if len(tight) < len(packed) else packed


def compact(content):
    """Any .xlsx (its bytes) as small as it gets with nothing lost: see compact_sheet. The file as it is when it cannot
    be read or would not get smaller."""
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            files = {i.filename: z.read(i.filename) for i in z.infolist() if not i.is_dir()}
        visible = visible_styles(files["xl/styles.xml"])
        for name in files:
            if re.fullmatch(r"xl/worksheets/[^/]+\.xml", name):
                files[name] = short_refs(compact_sheet(files[name].decode("utf-8"), visible)).encode("utf-8")
        share_strings(files)
        small = _zip(files)
    except (KeyError, ValueError, AttributeError, zipfile.BadZipFile, ET.ParseError):
        return content
    return small if len(small) < len(content) else content


# ---------------------------------------------------------------- formulas in moved rows

# a text, a reference into another sheet or file, or one in this sheet
REF_RE = re.compile(r"""("(?:[^"]|"")*")|((?:'(?:[^']|'')*'|[\w.\[\]]+)!\$?[A-Z]{0,3}\$?\d*(?::\$?[A-Z]{0,3}\$?\d*)?)"""
                    r"""|(?<![\w.$])(\$?[A-Z]{1,3}\$?)(\d+)(?::(\$?[A-Z]{1,3}\$?)(\d+))?(?![\w(.])""")


def moved_formula(text, new_of):
    """A formula after its sheet's rows moved: its references into this sheet follow their rows. None when one spans
    several rows (they parted): the cell then keeps its value only."""
    lost = []

    def ref(m):
        if m.group(1) or m.group(2):
            return m.group(0)
        a = int(m.group(4))
        if m.group(5) and int(m.group(6)) != a:
            lost.append(m.group(0))
            return m.group(0)
        n = new_of.get(a, a)
        return f"{m.group(3)}{n}" + (f":{m.group(5)}{n}" if m.group(5) else "")
    out = REF_RE.sub(ref, text)
    return None if lost else out


def _rgb(fill):
    """The colour of an openpyxl PatternFill as 8 hex digits."""
    rgb = str(getattr(getattr(fill, "fgColor", None), "rgb", "") or "")
    return ("FF" + rgb[-6:]).upper() if len(rgb) >= 6 else "FFFFFFFF"


class _Cell:
    __slots__ = ("sheet", "row", "col")

    def __init__(self, sheet, row, col):
        self.sheet, self.row, self.col = sheet, row, col

    @property
    def value(self):
        key = (self.row, self.col)
        if key in self.sheet.values:
            return self.sheet.values[key]
        r = self.sheet.rows[self.row - 1] if self.row - 1 < len(self.sheet.rows) else ()
        return r[self.col - 1] if self.col - 1 < len(r) else None

    @value.setter
    def value(self, v):
        self.sheet.values[(self.row, self.col)] = v

    @property
    def fill(self):
        return self.sheet.fills.get((self.row, self.col))

    @fill.setter
    def fill(self, f):
        self.sheet.fills[(self.row, self.col)] = _rgb(f)


class PatchSheet:
    """The first sheet of an .xlsx, read fast, with the changes kept until save()."""

    def __init__(self, path):
        self.path = path
        with Book(path) as book:
            self.rows = book.rows(book.sheetnames[0])
        self.values, self.fills = {}, {}
        # the rows in a new order (old row numbers, from row 2): None keeps them where they are
        self.order = None

    def cell(self, row, col):
        return _Cell(self, row, col)

    def __getitem__(self, row):
        width = max(len(self.rows[row - 1]) if row - 1 < len(self.rows) else 0, 1)
        return [_Cell(self, row, c) for c in range(1, width + 1)]

    @property
    def max_row(self):
        return max([len(self.rows)] + [r for r, _ in self.values])

    def save(self, log_rows, log_header, log_widths, log_name="MRM changes"):
        """The workbook bytes: the first sheet with the changes, and a fresh sheet listing them."""
        with zipfile.ZipFile(self.path) as z:
            files = {i.filename: z.read(i.filename) for i in z.infolist() if not i.is_dir()}
        _drop_calc_chain(files)
        workbook = files["xl/workbook.xml"].decode("utf-8")
        rels = files["xl/_rels/workbook.xml.rels"].decode("utf-8")
        types = files["[Content_Types].xml"].decode("utf-8")
        styles = files["xl/styles.xml"].decode("utf-8")

        # an earlier "MRM changes" sheet goes (this file may be a final LNV uploaded again)
        m = re.search(rf'<sheet\b[^>]*name="{re.escape(log_name)}"[^>]*/>', workbook)
        if m:
            rid = re.search(r'\bid="([^"]+)"', m.group(0)).group(1)
            target = re.search(rf'<Relationship\b[^>]*Id="{rid}"[^>]*/>', rels)
            dropped = "xl/" + re.search(r'Target="([^"]+)"', target.group(0)).group(1).lstrip("/").removeprefix("xl/")
            workbook = workbook.replace(m.group(0), "")
            rels = rels.replace(target.group(0), "")
            types = re.sub(rf'<Override\b[^>]*PartName="/{re.escape(dropped)}"[^>]*/>', "", types)
            files.pop(dropped, None)

        first = re.search(r"<sheet\b[^>]*/>", workbook).group(0)
        rid = re.search(r'\bid="([^"]+)"', first).group(1)
        target = re.search(r'Target="([^"]+)"', re.search(rf'<Relationship\b[^>]*Id="{rid}"[^>]*/>', rels).group(0)).group(1)
        sheet_path = "xl/" + target.lstrip("/").removeprefix("xl/")

        visible = visible_styles(styles)
        for name in files:   # the other sheets too: nothing in them changes
            if name != sheet_path and re.fullmatch(r"xl/worksheets/[^/]+\.xml", name):
                files[name] = short_refs(compact_sheet(files[name].decode("utf-8"), visible)).encode("utf-8")
        finish_styles, style_of, header_style = self._styles(styles)
        sheet = compact_sheet(files[sheet_path].decode("utf-8"), visible)
        sheet, links = self._hyperlinks(sheet)
        sheet = self._patch_sheet(sheet, style_of)
        if links:
            folder, _, base = sheet_path.rpartition("/")
            rels_path = f"{folder}/_rels/{base}.rels"
            own = files[rels_path].decode("utf-8") if rels_path in files else \
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
            files[rels_path] = re.sub(r"<Relationships\b([^>]*)/>", r"<Relationships\1></Relationships>", own).replace("</Relationships>", "".join(
                f'<Relationship Id="{i}" Type="{HYPERLINK}" Target={quoteattr(u)} TargetMode="External"/>' for i, u in links.items()) + "</Relationships>").encode("utf-8")
        if self.order:
            self._move_notes(files, sheet_path)

        # the change list as a new sheet
        n = 1
        while f"xl/worksheets/sheet{n}.xml" in files:
            n += 1
        new_rid = "rIdMrm" + str(n)
        sheet_id = max(int(x) for x in re.findall(r'sheetId="(\d+)"', workbook)) + 1
        prefix = re.search(r'\s(\w+):id="', first).group(1)
        workbook = workbook.replace("</sheets>", f'<sheet name="{escape(log_name)}" sheetId="{sheet_id}" {prefix}:id="{new_rid}"/></sheets>')
        rels = rels.replace("</Relationships>", f'<Relationship Id="{new_rid}" Type="{WORKSHEET}" Target="worksheets/sheet{n}.xml"/></Relationships>')
        types = types.replace("</Types>", f'<Override ContentType="{WORKSHEET_TYPE}" PartName="/xl/worksheets/sheet{n}.xml"/></Types>')
        files.update({"xl/workbook.xml": workbook.encode("utf-8"), "xl/_rels/workbook.xml.rels": rels.encode("utf-8"),
                      "[Content_Types].xml": types.encode("utf-8"), "xl/styles.xml": finish_styles().encode("utf-8"),
                      sheet_path: short_refs(sheet).encode("utf-8"),
                      f"xl/worksheets/sheet{n}.xml": self._log_sheet(log_header, log_rows, log_widths, header_style).encode("utf-8")})
        share_strings(files, sheet_path)
        return _zip(files)

    def _hyperlinks(self, xml):
        """A cell whose value changed opens its new link, not the old one – or nothing, when it is no link any more.
        Returns the sheet and the new links: {relationship id: url}."""
        links = {}

        def one(m):
            ref = re.search(r'\sref="([A-Z]+)(\d+)"', m.group(0))
            at = (int(ref.group(2)), column_index_from_string(ref.group(1))) if ref else None
            if at not in self.values:
                return m.group(0)
            url = str(self.values[at] or "").strip()
            if not is_link(url):
                return ""
            rid = f"rIdMrmL{len(links) + 1}"
            links[rid] = url
            return f'<hyperlink xmlns:r="{R_NS}" ref="{ref.group(1)}{ref.group(2)}" r:id="{rid}"/>'
        if "<hyperlink " in xml:
            end = xml.index("</sheetData>") if "</sheetData>" in xml else 0
            tail = re.sub(r"<hyperlink\b[^>]*?/>", one, xml[end:])
            xml = xml[:end] + re.sub(r"<hyperlinks>\s*</hyperlinks>", "", tail)
        return xml, links

    def _move_notes(self, files, sheet_path):
        """The notes and comments of the moved rows move with them."""
        folder, _, base = sheet_path.rpartition("/")
        rels = files.get(f"{folder}/_rels/{base}.rels", b"").decode("utf-8")
        new_of = {old: n for n, old in enumerate(self.order, start=2)}
        for target in re.findall(r'Target="([^"]*(?:comments|threadedComment|vmlDrawing)[^"]*)"', rels):
            path = target.lstrip("/") if target.startswith("/") else "xl/" + target.removeprefix("../")
            if path not in files:
                continue
            text = files[path].decode("utf-8")
            text = re.sub(r'(<(?:comment|threadedComment)\b[^>]*?\sref="[A-Z]+)(\d+)"', lambda m: f'{m.group(1)}{new_of.get(int(m.group(2)), int(m.group(2)))}"', text)
            text = re.sub(r"(<x:Row>)(\d+)(</x:Row>)", lambda m: f"{m.group(1)}{new_of.get(int(m.group(2)) + 1, int(m.group(2)) + 1) - 1}{m.group(3)}", text)
            files[path] = text.encode("utf-8")

    def _styles(self, styles):
        """Add a fill per colour used, and a cell style per (old style, colour) – the cell keeps its font and borders."""
        fills_m = re.search(r'<fills count="(\d+)">(.*?)</fills>', styles, re.S)
        xfs_m = re.search(r'<cellXfs count="(\d+)">(.*?)</cellXfs>', styles, re.S)
        fonts_m = re.search(r'<fonts count="(\d+)"([^>]*)>(.*?)</fonts>', styles, re.S)
        n_fills, xfs = int(fills_m.group(1)), XF_RE.findall(xfs_m.group(2))
        fill_id, new_fills, new_xfs, cache = {}, [], [], {}

        def fill_for(rgb):
            if rgb not in fill_id:
                fill_id[rgb] = n_fills + len(new_fills)
                new_fills.append(f'<fill><patternFill patternType="solid"><fgColor rgb="{rgb}"/><bgColor indexed="64"/></patternFill></fill>')
            return fill_id[rgb]

        def style_of(old, rgb):
            if not rgb:
                return old
            if (old, rgb) not in cache:
                base = xfs[old] if old is not None and old < len(xfs) else '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
                xf = re.sub(r'\sfillId="\d+"', "", base)
                xf = re.sub(r'\sapplyFill="\w+"', "", xf)
                xf = xf.replace("<xf", f'<xf fillId="{fill_for(rgb)}" applyFill="1"', 1)
                cache[(old, rgb)] = len(xfs) + len(new_xfs)
                new_xfs.append(xf)
            return cache[(old, rgb)]

        for rgb in sorted(set(self.fills.values())):
            fill_for(rgb)
        header_font = int(fonts_m.group(1))
        header_style = len(xfs) + len(new_xfs)
        new_xfs.append(f'<xf numFmtId="0" fontId="{header_font}" fillId="{fill_for("FF1F4E46")}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>')
        finish = lambda: (styles
                                .replace(fonts_m.group(0), f'<fonts count="{header_font + 1}"{fonts_m.group(2)}>{fonts_m.group(3)}'
                                         '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>')
                                .replace(fills_m.group(0), f'<fills count="{n_fills + len(new_fills)}">{fills_m.group(2)}{"".join(new_fills)}</fills>')
                                .replace(xfs_m.group(0), f'<cellXfs count="{len(xfs) + len(new_xfs)}">{xfs_m.group(2)}{"".join(new_xfs)}</cellXfs>'))
        return finish, style_of, header_style

    def _patch_sheet(self, xml, style_of):
        edits = {}
        for (r, c), v in self.values.items():
            edits.setdefault(r, {})[c] = [v, self.fills.get((r, c)), True]
        for (r, c), rgb in self.fills.items():
            edits.setdefault(r, {}).setdefault(c, [None, rgb, False])
        self.columns = column_styles(xml)
        start = xml.index("<sheetData")
        head_end = xml.index(">", start) + 1
        if xml[head_end - 2] == "/":   # <sheetData/>
            xml = xml[:head_end - 2] + "></sheetData>" + xml[head_end:]
            head_end -= 1
        end = xml.index("</sheetData>", head_end)
        out, pos, pending = [xml[:head_end]], head_end, sorted(edits)
        for m in ROW_RE.finditer(xml, head_end, end):
            r = int(re.search(r'\br="(\d+)"', m.group(0)[:200]).group(1))
            while pending and pending[0] < r:   # rows the sheet does not have yet
                out.append(xml[pos:m.start()])
                pos = m.start()
                out.append(self._row(pending[0], "", edits[pending.pop(0)], style_of))
            out.append(xml[pos:m.start()])
            pos = m.end()
            if pending and pending[0] == r:
                out.append(self._row(r, m.group(0), edits[pending.pop(0)], style_of))
            else:
                out.append(m.group(0))
        out.append(xml[pos:end])
        out.extend(self._row(r, "", edits[r], style_of) for r in pending)
        out.append(xml[end:])
        sheet = "".join(out)
        if self.order:
            sheet = self._reorder(sheet)
        last_row = max([len(self.rows)] + list(edits))
        return re.sub(r'(<dimension ref="[A-Z]+\d+:)([A-Z]+)(\d+)"',
                      lambda d: f'{d.group(1)}{d.group(2)}{max(int(d.group(3)), last_row)}"', sheet, count=1)

    def _reorder(self, xml):
        """The rows from row 2 put in self.order, each renumbered with its cells, and what names them by their row – links,
        colour rules, dropdowns, references in formulas – with them. A formula over several rows that parted keeps its
        value only. A merge within one row moves with it; one across rows is dropped."""
        start = xml.index("<sheetData")
        head_end = xml.index(">", start) + 1
        end = xml.index("</sheetData>", head_end)
        rows = {}
        for m in ROW_RE.finditer(xml, head_end, end):
            rows[int(re.search(r'\br="(\d+)"', m.group(0)[:200]).group(1))] = m.group(0)
        new_of = {old: n for n, old in enumerate(self.order, start=2)}

        def formula(m):
            tag, text = m.group(1), m.group(2)
            if 't="shared"' in tag or 't="array"' in tag or 't="dataTable"' in tag:
                return ""   # one formula over several rows: they parted, the cell keeps its value
            out = moved_formula(text or "", new_of)
            return f"<f{tag}>{out}</f>" if out else ""

        def renumber(x, n):
            x = re.sub(r'^(<row\b[^>]*?\br=")\d+"', lambda m: f'{m.group(1)}{n}"', x, count=1)
            return re.sub(r'(<c\b[^>]*?\br="[A-Z]+)\d+"', lambda m: f'{m.group(1)}{n}"', x)
        formulas = lambda x: re.sub(r"<f\b([^>]*?)(?:/>|>([^<]*)</f>)", formula, x) if "<f" in x else x
        placed = sorted(((new_of.get(r, r), formulas(renumber(x, new_of[r]) if r in new_of and new_of[r] != r else x)) for r, x in rows.items()),
                        key=lambda t: t[0])
        xml = xml[:head_end] + "".join(x for _, x in placed) + xml[end:]
        # what stands after the cells and names them by their row: links, colour rules, dropdowns
        at = xml.index("</sheetData>")
        moved = lambda ref: re.sub(r"(?<=[A-Z])\d+", str(new_of.get(int(re.search(r"\d+", ref).group(0)), 0) or re.search(r"\d+", ref).group(0)), ref) \
            if len(set(re.findall(r"\d+", ref))) == 1 else ref
        tail = re.sub(r'(<hyperlink\b[^>]*?\sref=")([^"]+)"', lambda m: f'{m.group(1)}{moved(m.group(2))}"', xml[at:])
        tail = re.sub(r'(<(?:conditionalFormatting|dataValidation)\b[^>]*?\ssqref=")([^"]+)"',
                      lambda m: m.group(1) + " ".join(moved(x) if re.fullmatch(r"[A-Z]+\d+(?::[A-Z]+\d+)?", x) else x for x in m.group(2).split()) + '"', tail)
        xml = xml[:at] + tail

        def merge(m):
            a, b = (int(x) for x in re.findall(r"\d+", m.group(1)))
            if a != b:   # across rows: it cannot follow rows that part
                return "" if a in new_of or b in new_of else m.group(0)
            return m.group(0).replace(m.group(1), re.sub(r"(?<=[A-Z])\d+", str(new_of.get(a, a)), m.group(1)))
        xml = re.sub(r'<mergeCell ref="([A-Z]+\d+:[A-Z]+\d+)"\s*/>', merge, xml)
        xml = re.sub(r'<mergeCells count="\d+"', lambda m: f'<mergeCells count="{len(re.findall("<mergeCell ", xml))}"', xml, count=1)
        return re.sub(r'<mergeCells count="0"\s*(?:/>|>\s*</mergeCells>)', "", xml)

    def _row(self, r, old, edits, style_of):
        """One <row>: its old cells, the edited ones rewritten, new ones added in column order."""
        cells, col = {}, 0
        tag = re.match(r"<row\b[^>]*", old)
        own = int(_attr(tag.group(0), "s")) if tag and _attr(tag.group(0), "customFormat") in ("1", "true") and _attr(tag.group(0), "s") else None
        for m in CELL_RE.finditer(old):
            ref = re.search(r'\br="([A-Z]+)\d+"', m.group(1))
            col = column_index_from_string(ref.group(1)) if ref else col + 1
            cells[col] = (m.group(1), m.group(2), m.group(0))
        for c, (value, rgb, has_value) in edits.items():
            attrs, inner, _ = cells.get(c, ("", None, ""))
            s = re.search(r'\bs="(\d+)"', attrs)
            # a cell the sheet has no entry for has its row's look, else its column's
            style = style_of(int(s.group(1)) if s else None if c in cells else own if own is not None else self.columns.get(c), rgb)
            ref = f"{get_column_letter(c)}{r}"
            st = f' s="{style}"' if style is not None else ""
            if not has_value:   # only the colour changes
                rest = re.sub(r'\s(r|s)="[^"]*"', "", attrs)
                cells[c] = (None, None, f'<c r="{ref}"{st}{rest}>{inner}</c>' if inner is not None else f'<c r="{ref}"{st}{rest}/>')
            elif value is None or value == "":
                cells[c] = (None, None, f'<c r="{ref}"{st}/>')
            elif isinstance(value, bool) or not isinstance(value, (int, float)):
                cells[c] = (None, None, f'<c r="{ref}"{st} t="inlineStr"><is><t xml:space="preserve">{escape(printable(str(value)))}</t></is></c>')
            else:
                cells[c] = (None, None, f'<c r="{ref}"{st}><v>{value}</v></c>')
        start = re.match(r"<row\b[^>]*?(?=/?>)", old)
        tag = re.sub(r'\sspans="[^"]*"', "", start.group(0)) if start else f'<row r="{r}"'
        return f'{tag}>{"".join(cells[c][2] for c in sorted(cells))}</row>'

    def _log_sheet(self, header, rows, widths, header_style):
        def cell(ref, v, style=None):
            st = f' s="{style}"' if style is not None else ""
            if v is None or v == "":
                return ""
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return f'<c r="{ref}"{st}><v>{v}</v></c>'
            return f'<c r="{ref}"{st} t="inlineStr"><is><t xml:space="preserve">{escape(printable(str(v)))}</t></is></c>'
        body = [f'<row r="1">{"".join(cell(f"{get_column_letter(i + 1)}1", h, header_style) for i, h in enumerate(header))}</row>']
        for n, row in enumerate(rows, start=2):
            body.append(f'<row r="{n}">{"".join(cell(f"{get_column_letter(i + 1)}{n}", v) for i, v in enumerate(row))}</row>')
        cols = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths))
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
                f'<cols>{cols}</cols><sheetData>{"".join(body)}</sheetData></worksheet>')

