"""Write a few changes into a large .xlsx without loading it: the cells that change are rewritten in the first
sheet's XML, every other byte of the file is copied as it is. An LNV can hold over 4 million formatted cells (1,424
columns × 2,940 rows, a 94 MB sheet); openpyxl reads and writes every one of them – about a minute – to change a few
thousand. PatchSheet offers the part of openpyxl's worksheet the LNV writers use (cell(row, col).value / .fill,
ws[1], max_row), records the changes, and save() writes them, plus a "MRM changes" sheet, into a copy of the file.
"""
import io
import re
import zipfile
from xml.sax.saxutils import escape

from openpyxl.utils import column_index_from_string, get_column_letter

from .xlsx import Book

MAX_COLUMN = 16384   # Excel's last column, XFD
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WORKSHEET = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
WORKSHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
ROW_RE = re.compile(r"<row\b[^>]*?(?:/>|>.*?</row>)", re.S)
CELL_RE = re.compile(r"<c\b([^>]*?)(?:/>|>(.*?)</c>)", re.S)
CELL_REF_RE = re.compile(r'(<c\b[^>]*?\br=")([A-Z]+)(\d+")')
RANGE_REF_RE = re.compile(r"(\$?)([A-Z]{1,3})(\$?)(\d+)")
# Attributes outside the cells that hold cell references on this sheet
SHEET_REFS = re.compile(r'\b(ref|sqref|activeCell|topLeftCell)="([^"]*)"')
XF_RE = re.compile(r"<xf\b[^>]*?(?:/>|>.*?</xf>)", re.S)


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
        self.inserted = None   # (columns before the new ones, how many) once insert_columns ran
        self.new_header_style = None

    def insert_columns(self, after, count):
        """Make room for `count` new columns right after 1-based column `after`, moving everything to their right.
        Everything read or written afterwards uses the new positions. False when the sheet has no room left."""
        width = max((len(r) for r in self.rows), default=0)
        with zipfile.ZipFile(self.path) as z:
            xml = z.read(self._sheet_path(z)).decode("utf-8")
            others = [z.read(n).decode("utf-8", "ignore") for n in z.namelist() if n.startswith("xl/worksheets/sheet") and n != self._sheet_path(z)]
            first_name = re.search(r'<sheet\b[^>]*name="([^"]+)"', z.read("xl/workbook.xml").decode("utf-8")).group(1)
        m = re.search(r'<dimension ref="[A-Z]+\d+:([A-Z]+)\d+"', xml)
        if self.inserted or self.values or self.fills or max(width, column_index_from_string(m.group(1)) if m else 0) + count > MAX_COLUMN:
            return False
        # Things that point at cells in ways this does not rewrite: the columns then go after the last one instead
        if re.search(r"<(drawing|legacyDrawing|tableParts)\b", xml):
            return False
        if any(RANGE_REF_RE.search(re.sub(r"\[\d+\][^!]*!\$?[A-Z]+\$?\d+(:\$?[A-Z]+\$?\d+)?", "", f)) for f in re.findall(r"<f\b[^>]*>([^<]*)</f>", xml)):
            return False
        if any(first_name + "!" in f or f"'{first_name}'!" in f for other in others for f in re.findall(r"<f\b[^>]*>([^<]*)</f>", other) if not re.search(r"\[\d+\]", f)):
            return False
        self.inserted = (after, count)
        self.rows = [tuple(r[:after]) + (None,) * count + tuple(r[after:]) if len(r) > after else r for r in self.rows]
        return True

    def _sheet_path(self, z):
        workbook = z.read("xl/workbook.xml").decode("utf-8")
        rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
        rid = re.search(r'\bid="([^"]+)"', re.search(r"<sheet\b[^>]*/>", workbook).group(0)).group(1)
        rel = next(x for x in re.findall(r"<Relationship\b[^>]*/>", rels) if f'Id="{rid}"' in x)
        return "xl/" + re.search(r'Target="([^"]+)"', rel).group(1).lstrip("/").removeprefix("xl/")

    def _shift(self, xml):
        """The first sheet's XML with the room insert_columns asked for: cell references, column widths and the ranges
        of filters, panes and the like move; the header gets the neighbouring header cell's style for the new cells."""
        after, count = self.inserted

        def move(letters):
            c = column_index_from_string(letters)
            return get_column_letter(c + count) if c > after else letters

        def move_refs(value):
            return RANGE_REF_RE.sub(lambda m: f"{m.group(1)}{move(m.group(2))}{m.group(3)}{m.group(4)}", value)

        start = xml.index("<sheetData")
        end = xml.index("</sheetData>", start) if "</sheetData>" in xml else start
        head, body, tail = xml[:start], xml[start:end], xml[end:]
        beside = re.search(rf'<c\b[^>]*\br="{get_column_letter(after)}1"[^>]*>', body)
        style = re.search(r'\bs="(\d+)"', beside.group(0)) if beside else None
        self.new_header_style = int(style.group(1)) if style else None
        body = CELL_REF_RE.sub(lambda m: f"{m.group(1)}{move(m.group(2))}{m.group(3)}", body)
        # formulas keep their text; a shared formula's own range moves with its cells
        body = re.sub(r'(<f\b[^>]*?\bref=")([^"]+)(")', lambda m: m.group(1) + move_refs(m.group(2)) + m.group(3), body)
        ref = lambda m: f'{m.group(1)}="{move_refs(m.group(2))}"'
        head, tail = SHEET_REFS.sub(ref, head), SHEET_REFS.sub(ref, tail)
        body = re.sub(r'(<row\b[^>]*?)\sspans="[^"]*"', r"\1", body)   # a row's column hint would be out of date

        def cols(m):
            out = []
            for c in re.findall(r"<col\b[^>]*/>", m.group(1)):
                lo, hi = int(re.search(r'\bmin="(\d+)"', c).group(1)), int(re.search(r'\bmax="(\d+)"', c).group(1))
                put = lambda a, b: re.sub(r'\bmax="\d+"', f'max="{b}"', re.sub(r'\bmin="\d+"', f'min="{a}"', c))
                if hi <= after:
                    out.append(c)
                elif lo > after:
                    out.append(put(lo + count, min(hi + count, MAX_COLUMN)))
                else:   # the new columns fall inside this block of equal widths
                    out.extend([put(lo, after), put(after + count + 1, min(hi + count, MAX_COLUMN))])
            new = "".join(f'<col min="{after + n + 1}" max="{after + n + 1}" width="32" customWidth="1"/>' for n in range(count))
            at = next((n for n, c in enumerate(out) if int(re.search(r'\bmin="(\d+)"', c).group(1)) > after), len(out))
            return "<cols>" + "".join(out[:at]) + new + "".join(out[at:]) + "</cols>"
        head = re.sub(r"<cols>(.*?)</cols>", cols, head, flags=re.S)
        return head + body + tail

    def cell(self, row, col):
        return _Cell(self, row, col)

    def __getitem__(self, row):
        width = max(len(self.rows[row - 1]) if row - 1 < len(self.rows) else 0, 1)
        return [_Cell(self, row, c) for c in range(1, width + 1)]

    @property
    def max_row(self):
        return max([len(self.rows)] + [r for r, _ in self.values])

    def save(self, log_rows, log_header, log_widths, log_name="MRM changes", extra_sheets=()):
        """The workbook bytes: the first sheet with the changes, and a fresh sheet listing them. extra_sheets:
        [(name, header, rows, widths)] – more fresh sheets after it; a sheet of that name from an earlier run goes."""
        with zipfile.ZipFile(self.path) as z:
            names = z.namelist()
            parts = {n: z.read(n) for n in ("xl/workbook.xml", "xl/_rels/workbook.xml.rels", "[Content_Types].xml", "xl/styles.xml")}
            workbook = parts["xl/workbook.xml"].decode("utf-8")
            rels = parts["xl/_rels/workbook.xml.rels"].decode("utf-8")
            types = parts["[Content_Types].xml"].decode("utf-8")
            styles = parts["xl/styles.xml"].decode("utf-8")

            # earlier sheets of ours go (this file may be a final LNV uploaded again)
            dropped = set()
            for name in [log_name] + [e[0] for e in extra_sheets]:
                m = re.search(rf'<sheet\b[^>]*name="{re.escape(escape(name))}"[^>]*/>', workbook)
                if not m:
                    continue
                rid = re.search(r'\bid="([^"]+)"', m.group(0)).group(1)
                target = re.search(rf'<Relationship\b[^>]*Id="{rid}"[^>]*/>', rels)
                gone = "xl/" + re.search(r'Target="([^"]+)"', target.group(0)).group(1).lstrip("/").removeprefix("xl/")
                dropped.add(gone)
                workbook = workbook.replace(m.group(0), "")
                rels = rels.replace(target.group(0), "")
                types = re.sub(rf'<Override\b[^>]*PartName="/{re.escape(gone)}"[^>]*/>', "", types)

            first = re.search(r"<sheet\b[^>]*/>", workbook).group(0)
            rid = re.search(r'\bid="([^"]+)"', first).group(1)
            target = re.search(r'Target="([^"]+)"', re.search(rf'<Relationship\b[^>]*Id="{rid}"[^>]*/>', rels).group(0)).group(1)
            sheet_path = "xl/" + target.lstrip("/").removeprefix("xl/")

            finish_styles, style_of, header_style = self._styles(styles)
            source = z.read(sheet_path).decode("utf-8")
            if self.inserted:
                source = self._shift(source)
                workbook = self._move_defined_names(workbook)
                # Excel's list of formula cells names their old positions: without it Excel simply rebuilds it
                if "xl/calcChain.xml" in names:
                    dropped.add("xl/calcChain.xml")
                    rels = re.sub(r'<Relationship\b[^>]*calcChain[^>]*/>', "", rels)
                    types = re.sub(r'<Override\b[^>]*calcChain[^>]*/>', "", types)
            sheet = self._patch_sheet(source, style_of)
            styles = finish_styles()   # after the sheet: its cells made the new styles
            if "_xlnm._FilterDatabase" in workbook:
                workbook = re.sub(r'(<definedName\b[^>]*_xlnm\._FilterDatabase[^>]*localSheetId="0"[^>]*>[^<]*\$)(\d+)(</definedName>)',
                                  lambda d: f"{d.group(1)}{max(int(d.group(2)), self.last_row)}{d.group(3)}", workbook)

            # the change list, and any other sheets, as new sheets
            prefix = re.search(r'\s(\w+):id="', first).group(1)
            new_sheets, n = {}, 1
            for name, header, rows, widths in [(log_name, log_header, log_rows, log_widths), *extra_sheets]:
                while f"xl/worksheets/sheet{n}.xml" in names:
                    n += 1
                path, new_rid = f"xl/worksheets/sheet{n}.xml", f"rIdMrm{n}"
                n += 1
                sheet_id = max(int(x) for x in re.findall(r'sheetId="(\d+)"', workbook)) + 1
                workbook = workbook.replace("</sheets>", f'<sheet name="{escape(name)}" sheetId="{sheet_id}" {prefix}:id="{new_rid}"/></sheets>')
                rels = rels.replace("</Relationships>", f'<Relationship Id="{new_rid}" Type="{WORKSHEET}" Target="worksheets/{path.rsplit("/", 1)[1]}"/></Relationships>')
                types = types.replace("</Types>", f'<Override ContentType="{WORKSHEET_TYPE}" PartName="/{path}"/></Types>')
                new_sheets[path] = self._log_sheet(header, rows, widths, header_style)

            out = io.BytesIO()
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=3) as w:
                changed = {"xl/workbook.xml": workbook, "xl/_rels/workbook.xml.rels": rels, "[Content_Types].xml": types,
                           "xl/styles.xml": styles, sheet_path: sheet}
                for info in z.infolist():
                    if info.filename in dropped and info.filename not in new_sheets:
                        continue
                    if info.filename in changed:
                        w.writestr(info.filename, changed[info.filename].encode("utf-8"))
                    elif info.filename not in new_sheets:
                        w.writestr(info, z.read(info.filename))
                for path, xml in new_sheets.items():
                    w.writestr(path, xml.encode("utf-8"))
        return out.getvalue()

    def _move_defined_names(self, workbook):
        """Names on the first sheet (Excel's filter range) move with its columns."""
        first = re.search(r'<sheet\b[^>]*name="([^"]+)"', workbook).group(1)
        after, count = self.inserted

        def move(m):
            text = m.group(2)
            if f"{first}!" not in text and f"'{first}'!" not in text:
                return m.group(0)
            shift = lambda r: f"{r.group(1)}{get_column_letter(column_index_from_string(r.group(2)) + count) if column_index_from_string(r.group(2)) > after else r.group(2)}{r.group(3)}{r.group(4)}"
            sheet, _, cells = text.rpartition("!")
            return f"{m.group(1)}{sheet}!{RANGE_REF_RE.sub(shift, cells)}{m.group(3)}"
        return re.sub(r"(<definedName\b[^>]*>)([^<]*)(</definedName>)", move, workbook)

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
        last_row = max([len(self.rows)] + list(edits))
        self.last_row = last_row
        # the sheet's filter takes in the rows added below it
        sheet = re.sub(r'(<autoFilter\b[^>]*\bref="[A-Z]+\d+:[A-Z]+)(\d+)"', lambda d: f'{d.group(1)}{max(int(d.group(2)), last_row)}"', sheet, count=1)
        return re.sub(r'(<dimension ref="[A-Z]+\d+:)([A-Z]+)(\d+)"',
                      lambda d: f'{d.group(1)}{d.group(2)}{max(int(d.group(3)), last_row)}"', sheet, count=1)

    def _row(self, r, old, edits, style_of):
        """One <row>: its old cells, the edited ones rewritten, new ones added in column order."""
        cells, col = {}, 0
        for m in CELL_RE.finditer(old):
            ref = re.search(r'\br="([A-Z]+)\d+"', m.group(1))
            col = column_index_from_string(ref.group(1)) if ref else col + 1
            cells[col] = (m.group(1), m.group(2), m.group(0))
        for c, (value, rgb, has_value) in edits.items():
            attrs, inner, _ = cells.get(c, ("", None, ""))
            s = re.search(r'\bs="(\d+)"', attrs)
            new_header = r == 1 and self.inserted and self.inserted[0] < c <= self.inserted[0] + self.inserted[1]
            style = style_of(int(s.group(1)) if s else self.new_header_style if new_header else None, rgb)
            ref = f"{get_column_letter(c)}{r}"
            st = f' s="{style}"' if style is not None else ""
            if not has_value:   # only the colour changes
                rest = re.sub(r'\s(r|s)="[^"]*"', "", attrs)
                cells[c] = (None, None, f'<c r="{ref}"{st}{rest}>{inner}</c>' if inner is not None else f'<c r="{ref}"{st}{rest}/>')
            elif value is None or value == "":
                cells[c] = (None, None, f'<c r="{ref}"{st}/>')
            elif isinstance(value, bool) or not isinstance(value, (int, float)):
                cells[c] = (None, None, f'<c r="{ref}"{st} t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>')
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
            return f'<c r="{ref}"{st} t="inlineStr"><is><t xml:space="preserve">{escape(str(v))}</t></is></c>'
        body = [f'<row r="1">{"".join(cell(f"{get_column_letter(i + 1)}1", h, header_style) for i, h in enumerate(header))}</row>']
        for n, row in enumerate(rows, start=2):
            body.append(f'<row r="{n}">{"".join(cell(f"{get_column_letter(i + 1)}{n}", v) for i, v in enumerate(row))}</row>')
        cols = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths))
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
                f'<cols>{cols}</cols><sheetData>{"".join(body)}</sheetData></worksheet>')

