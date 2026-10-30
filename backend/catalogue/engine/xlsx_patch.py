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

R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WORKSHEET = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
WORKSHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
ROW_RE = re.compile(r"<row\b[^>]*?(?:/>|>.*?</row>)", re.S)
CELL_RE = re.compile(r"<c\b([^>]*?)(?:/>|>(.*?)</c>)", re.S)
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
            names = z.namelist()
            parts = {n: z.read(n) for n in ("xl/workbook.xml", "xl/_rels/workbook.xml.rels", "[Content_Types].xml", "xl/styles.xml")}
            workbook = parts["xl/workbook.xml"].decode("utf-8")
            rels = parts["xl/_rels/workbook.xml.rels"].decode("utf-8")
            types = parts["[Content_Types].xml"].decode("utf-8")
            styles = parts["xl/styles.xml"].decode("utf-8")

            # an earlier "MRM changes" sheet goes (this file may be a final LNV uploaded again)
            dropped = None
            m = re.search(rf'<sheet\b[^>]*name="{re.escape(log_name)}"[^>]*/>', workbook)
            if m:
                rid = re.search(r'\bid="([^"]+)"', m.group(0)).group(1)
                target = re.search(rf'<Relationship\b[^>]*Id="{rid}"[^>]*/>', rels)
                dropped = "xl/" + re.search(r'Target="([^"]+)"', target.group(0)).group(1).lstrip("/").removeprefix("xl/")
                workbook = workbook.replace(m.group(0), "")
                rels = rels.replace(target.group(0), "")
                types = re.sub(rf'<Override\b[^>]*PartName="/{re.escape(dropped)}"[^>]*/>', "", types)

            first = re.search(r"<sheet\b[^>]*/>", workbook).group(0)
            rid = re.search(r'\bid="([^"]+)"', first).group(1)
            target = re.search(r'Target="([^"]+)"', re.search(rf'<Relationship\b[^>]*Id="{rid}"[^>]*/>', rels).group(0)).group(1)
            sheet_path = "xl/" + target.lstrip("/").removeprefix("xl/")

            finish_styles, style_of, header_style = self._styles(styles)
            sheet = self._patch_sheet(z.read(sheet_path).decode("utf-8"), style_of)
            styles = finish_styles()   # after the sheet: its cells made the new styles

            # the change list as a new sheet
            n = 1
            while f"xl/worksheets/sheet{n}.xml" in names:
                n += 1
            log_path = f"xl/worksheets/sheet{n}.xml"
            new_rid = "rIdMrm" + str(n)
            sheet_id = max(int(x) for x in re.findall(r'sheetId="(\d+)"', workbook)) + 1
            prefix = re.search(r'\s(\w+):id="', first).group(1)
            workbook = workbook.replace("</sheets>", f'<sheet name="{escape(log_name)}" sheetId="{sheet_id}" {prefix}:id="{new_rid}"/></sheets>')
            rels = rels.replace("</Relationships>", f'<Relationship Id="{new_rid}" Type="{WORKSHEET}" Target="worksheets/sheet{n}.xml"/></Relationships>')
            types = types.replace("</Types>", f'<Override ContentType="{WORKSHEET_TYPE}" PartName="/{log_path}"/></Types>')
            log = self._log_sheet(log_header, log_rows, log_widths, header_style)

            out = io.BytesIO()
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=3) as w:
                changed = {"xl/workbook.xml": workbook, "xl/_rels/workbook.xml.rels": rels, "[Content_Types].xml": types,
                           "xl/styles.xml": styles, sheet_path: sheet}
                for info in z.infolist():
                    if info.filename == dropped:
                        continue
                    if info.filename in changed:
                        w.writestr(info.filename, changed[info.filename].encode("utf-8"))
                    else:
                        w.writestr(info, z.read(info.filename))
                w.writestr(log_path, log.encode("utf-8"))
        return out.getvalue()

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
            style = style_of(int(s.group(1)) if s else None, rgb)
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

