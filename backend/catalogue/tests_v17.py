"""v1.7 – unit, integration and security tests: alternative work name, ISRCs with pipes, release dates, the DSP (Muso)
data and links corrected, matches kept until all are answered, last updated song, small files – and what a hostile or
broken request can do."""
import io
import json
import re
import shutil
import tempfile
import zipfile
from datetime import date, datetime

import openpyxl
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import Client as Browser
from django.test import SimpleTestCase, TestCase, override_settings

from .engine import dataclean, songmerge, typed
from .engine import xlsx_patch as xp
from .engine.master import lnv_link, parse_master
from .engine.normalize import is_link, isrc_list, isrc_rest, norm_date, pipe_isrcs, show_date
from .models import CleanChange, CleanDecision

# ---------------------------------------------------------------- files

HEAD = ["SN", "Work*", "ISRC", "ISWC", "Alternate Work", "Movie Name *", "Label *", "Release Year(YYYY) *", "Date Of Release(DD-MM-YYYY)",
        "Website1", "Website2", "YouTube", "SPOTIFY ID", "VERSION *",
        "Composer Name 1", "Artist CAE 1", "Artist Joshua ID 1", "Role 1", "Performance share 1", "Mechanical share 1",
        "Author Name 1", "Artist CAE 2", "Artist Joshua ID 2", "Role 2", "Performance share 2", "Mechanical share 2",
        "Publisher Name 1", "Artist CAE 3", "Artist Joshua ID 3", "Role 3", "Performance share 3", "Mechanical share 3",
        "Singer Name 1", "Artist CAE 4", "Artist Joshua ID 4", "Role 4", "Performance share 4", "Mechanical share 4",
        "ISRC 1", "ISWC 1", "IPRS TUNECODE 1", "Client status 1"]


def lnv_file(path, rows, head=HEAD):
    """rows: dicts of header -> value; composer / author / publisher in their first slots."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(head)
    short = {"title": "Work*", "isrc": "ISRC", "alt": "Alternate Work", "film": "Movie Name *", "year": "Release Year(YYYY) *", "date": "Date Of Release(DD-MM-YYYY)",
             "site": "Website1", "site2": "Website2", "tube": "YouTube", "spotify": "SPOTIFY ID", "composer": "Composer Name 1", "author": "Author Name 1",
             "publisher": "Publisher Name 1", "singer": "Singer Name 1", "isrc1": "ISRC 1"}
    for n, r in enumerate(rows, start=1):
        line = [None] * len(head)
        line[0] = n
        for k, v in r.items():
            if short[k] in head:
                line[head.index(short[k])] = v
        ws.append(line)
    wb.save(path)


MUSO_HEAD = ["Type of Object", "Name of the Song / Title", "Name of the Album", "ISRC", "Song Release Date", "Singer", "Lyricist", "Composer",
             "Music Label", "Duration (mm:ss)", "Song Link", "Publisher", "Popularity (0-100)", "Muso Track ID"]


def muso_file(path, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Muso Credits"
    ws.append(MUSO_HEAD)
    for n, r in enumerate(rows, start=1):
        ws.append(["Album", r["title"], r["album"], r["isrc"], r.get("date", "1990-05-01"), r.get("singer", "Lata Mangeshkar"), r["lyricist"], r.get("composer", CLIENT),
                   "Saregama", "4:21", r.get("link", f"https://open.spotify.com/track/{n:022d}"), r.get("publisher", "Saregama India Ltd"), r.get("pop", 10), f"m-{n}"])
    wb.save(path)


CLIENT = "Ravi Kumar Verma"
C, S = "Ravi Kumar Verma", "Saregama"
# one song name with four exact and two possible matches, and songs around it
LNV = [
    dict(title="Pyaar Ka Geet", isrc="INAA19000001", film="Film A", year=1990, composer=C, author="Anand Bakshi", publisher=S),                     # 2 exact
    dict(title="Dil Ki Baat", isrc=None, film="Film B", year=1991, composer=C, author="Gulzar", publisher=S, alt="Old Name"),                       # 3 exact, no ISRC
    dict(title="Neend Na Aaye", isrc="INAA19000030, INAA19000031;INAA19000030", film="Film D", year=1992, composer=C, author="Sameer", publisher=S), # 4
    dict(title="Saawan Ki Raat", isrc="INAA19000041", film="Film S", year=1993, composer=C, author="Javed Akhtar", publisher=S),                    # 5 possible: the same work,
    dict(title="Saawan Ki Raat", isrc="INAA19000042", film="Film S", year=1993, composer=C, author="Javed Akhtar", publisher=S),                    # 6 other ISRCs
    dict(title="Saawan Ki Raat", isrc="INAA19000043", film="Film S", year=1993, composer=C, author="Javed Akhtar", publisher=S),                    # 7
    dict(title="Text In Cell", isrc="TITLE TRACK (FR TV SER)", film="Film T", year=1994, composer=C, author="Anjaan", publisher=S),                 # 8
    dict(title="Has A Date", isrc="INAA19000050", film="Film H", year=1995, date="01-02-1995", site="https://open.spotify.com/track/" + "a" * 22,
         composer=C, author="Majrooh", publisher=S),                                                                                               # 9
]
MUSO = [
    dict(title="Pyaar Ka Geet", album="Film A", isrc="INAA19000001", lyricist="Anand Bakshi", date="1990-05-01"),                    # 2: rec
    dict(title="Pyaar Ka Geet", album="Film A", isrc="INAA19000002", lyricist="Anand Bakshi", date="2011-07-09"),                    # 3: same album, another ISRC
    dict(title="Pyaar Ka Geet - Lofi Flip", album="Lofi Hits", isrc="INAA19000003", lyricist="Anand Bakshi", date="2021-01-01"),     # 4: a version
    dict(title="Dil Ki Baat (From \"Film B\")", album="Film B", isrc="INAA19000010, INAA19000011", lyricist="Gulzar", date="1991-08-15"),   # 5: two ISRCs on one row
    dict(title="Neend Na Aaye", album="Film D", isrc="INAA19000030", lyricist="Sameer", date="1992-03-04"),                          # 6
    dict(title="Saawan Ki Raat", album="Film S", isrc="INAA19000040", lyricist="Javed Akhtar", date="1993-06-06"),             # 7: possible (another ISRC)
    dict(title="Text In Cell", album="Film T", isrc="INAA19000060", lyricist="Anjaan", date="1994-01-01"),                           # 8
    dict(title="Has A Date", album="Film H", isrc="INAA19000050", lyricist="Majrooh", date="1996-02-03"),                            # 9
    dict(title="Brand New Hit", album="Film E", isrc="INAA19000099", lyricist="Gulzar", date="2020-12-25", pop=70),                  # 10: not in the LNV
]


class Base(TestCase):
    lnv, muso = LNV, MUSO

    def setUp(self):
        cache.clear()
        self.user = get_user_model().objects.create_user("team@example.com", "team@example.com", "x", first_name="Asha")
        self.client.force_login(self.user)
        self.tmp = tempfile.mkdtemp()
        lnv_file(f"{self.tmp}/lnv.xlsx", self.lnv)
        muso_file(f"{self.tmp}/muso.xlsx", self.muso)
        self.cid = self.client.post("/api/clients/", {"name": CLIENT}, content_type="application/json").json()["id"]
        self.upload("master/", "lnv.xlsx")
        self.upload("clean/", "muso.xlsx")

    def tearDown(self):
        from django.conf import settings
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def upload(self, url, name, status=200):
        with open(f"{self.tmp}/{name}", "rb") as fh:
            res = self.client.post(f"/api/clients/{self.cid}/{url}", {"file": fh})
        self.assertEqual(res.status_code, status, res.content[:300])
        return res

    def send(self, url, body, status=200):
        res = self.client.post(f"/api/clients/{self.cid}/{url}", body, content_type="application/json")
        self.assertEqual(res.status_code, status, res.content[:400])
        return res.json()

    def save(self, *items, status=200):
        return self.send("clean/decisions/", {"quiet": True, "items": list(items)}, status)

    def step(self):
        res = self.client.get(f"/api/clients/{self.cid}/steps/?step=1")
        self.assertEqual(res.status_code, 200, res.content[:300])
        return res.json()["step"]

    def case(self, title, step=None):
        return next(c for c in (step or self.step())["cases"] if c["title"] == title and c["kind"] not in ("twice", "names"))

    def book(self, query="?stage=1&rows=all"):
        res = self.client.get(f"/api/clients/{self.cid}/steps/lnv/{query}")
        self.assertEqual(res.status_code, 200, res.content[:300])
        return res.content

    def sheet(self, content=None):
        """The stage 1 LNV as [{header: value}] and its changes as text."""
        wb = openpyxl.load_workbook(io.BytesIO(content or self.book()))
        rows = [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]
        return [dict(zip(rows[0], r)) for r in rows[1:]], [" ".join(str(c) for c in r if c is not None) for r in wb["MRM changes"].iter_rows(values_only=True)]

    def link_dil(self):
        """v1.8.0: Dil Ki Baat's LNV row has no ISRC – a possible match: the reviewer links it."""
        self.save({"key": f"link:{self.case('Dil Ki Baat (From \"Film B\")')['answer']['song']}", "choice": "same", "data": {"rows": [3]}})

    def lnv_row(self, title, film=None, rows=None):
        rows = rows or self.sheet()[0]
        return next(r for r in rows if r["Work*"] == title and (film is None or r["Movie Name *"] == film))


# ---------------------------------------------------------------- unit: the small parts

class NormalizeTests(SimpleTestCase):
    def test_several_isrcs_in_one_cell(self):
        self.assertEqual(isrc_list("INAA19000001"), ["INAA19000001"])
        self.assertEqual(isrc_list("In-AA1-90-00001"), ["INAA19000001"])
        for text in ("INAA19000001 | INAA19000002", "INAA19000001, INAA19000002", "INAA19000001;INAA19000002", "INAA19000001/INAA19000002",
                     "INAA19000001 INAA19000002", "inaa19000001|in-aa1-90-00002|INAA19000001", "INAA19000001\nINAA19000002"):
            self.assertEqual(isrc_list(text), ["INAA19000001", "INAA19000002"], text)
        self.assertEqual(isrc_list(["INAA19000001", "INAA19000001 | INAA19000002"]), ["INAA19000001", "INAA19000002"])
        for text in (None, "", "TITLE TRACK (FR TV SER)", "INAA1900000", "12345"):
            self.assertEqual(isrc_list(text), [], text)
        self.assertEqual(isrc_rest("INAA19000001 (old)"), "(old)")
        self.assertEqual(isrc_rest("INAA19000001 | INAA19000002"), "")
        self.assertEqual(pipe_isrcs(["A", "B", "A", "", "C"]), "A | B | C")
        self.assertEqual(isrc_list(pipe_isrcs(["INAA19000001", "INAA19000002"])), ["INAA19000001", "INAA19000002"])

    def test_dates(self):
        for v in ("2013-05-08", "08-05-2013", "08/05/2013", "8.5.2013", "8 May 2013", "May 8, 2013", "8th May 2013", datetime(2013, 5, 8, 10), date(2013, 5, 8), 41402, "2013-05-08 00:00:00"):
            self.assertEqual(norm_date(v), "2013-05-08", v)
            self.assertEqual(show_date(v), "08-05-2013", v)
        self.assertEqual(norm_date("05/28/2013"), "2013-05-28")   # only month first is a date
        for v in ("2013", 2013, 2013.0, "", None, "31-02-2013", "13-13-2013", "soon", "2013-05", True):
            self.assertEqual(norm_date(v), "", v)
        self.assertEqual(show_date("c. 1990"), "c. 1990")   # text that is no date stays

    def test_links(self):
        for u in ("https://open.spotify.com/track/abc?si=1", "http://a.b", "HTTPS://YOUTU.BE/x#t=1", "https://gaana.com/a,b"):
            self.assertTrue(is_link(u), u)
        for u in ("javascript:alert(1)", "data:text/html,x", "JAVASCRIPT:alert(1)//http://a.b", "ftp://a.b", "//a.b", "https://", "https://a", "https://a.b/ c",
                  "https://a.b/<script>", 'https://a.b/"onmouseover=', " https://a.b", "https://a.b\n", "vbscript:x", "file:///etc/passwd", None, "", "https://a.b/" + "x" * 3000):
            self.assertFalse(is_link(u), u)

    def test_lnv_link(self):
        self.assertEqual(lnv_link({"website": "https://a.b/1", "website2": "https://c.d"}), ("https://a.b/1", "website"))
        self.assertEqual(lnv_link({"website": "", "website2": "www.youtube.com/watch?v=1"}), ("https://www.youtube.com/watch?v=1", "website2"))
        self.assertEqual(lnv_link({"website2": " T-915.164.193-9"}), ("", ""))   # an ISWC in a link column
        self.assertEqual(lnv_link({"spotify_id": "x" * 22}), (f"https://open.spotify.com/track/{'x' * 22}", "spotify_id"))
        self.assertEqual(lnv_link({"youtube": "https://youtu.be/1"}), ("https://youtu.be/1", "youtube"))

    def test_work_names(self):
        self.assertTrue(dataclean.same_name("Veer - Zaara", "VEER-ZAARA"))
        self.assertTrue(dataclean.same_name("दिल", "दिल"))
        self.assertFalse(dataclean.same_name("दिल", "प्यार"))
        self.assertFalse(dataclean.same_name("Pyar", "Pyaar"))
        self.assertEqual(dataclean.other_names("A", "a", "B", "b ", "", "C"), ["B", "C"])

    def test_release_date(self):
        dates = ["1990-05-01", "2011-07-09"]
        self.assertEqual(dataclean.release_date(dates, "2011"), "09-07-2011")   # the one in the LNV's year
        self.assertEqual(dataclean.release_date(dates, "1985"), "01-05-1990")   # else the earliest
        self.assertEqual(dataclean.release_date(dates), "01-05-1990")
        self.assertEqual(dataclean.release_date([], "1990"), "")

    def test_corrections_are_checked(self):
        v = dataclean.edit_value
        self.assertEqual(v("Lyricist", "Gulzar, Sameer; Gulzar"), ["Gulzar", "Sameer"])
        self.assertEqual(v("ISRC", "in-aa1-90-00001 | INAA19000002"), ["INAA19000001", "INAA19000002"])
        self.assertEqual(v("Release date", "8 May 2013"), "08-05-2013")
        self.assertEqual(v("Year", "2013"), "2013")
        self.assertEqual(v("Link", "https://youtu.be/x"), "https://youtu.be/x")
        self.assertEqual((v("ISRC", ""), v("Link", ""), v("Release date", "")), ([], "", ""))   # blank is a correction too
        for f, bad in (("Title", ""), ("Title", "  "), ("ISRC", "INAA1"), ("ISRC", ["INAA19000001", "x"]), ("Release date", "2013"), ("Year", "13"), ("Link", "javascript:alert(1)")):
            with self.assertRaises(ValueError, msg=(f, bad)):
                v(f, bad)

    def test_typed_songs_take_several_isrcs(self):
        header = HEAD
        data = {"title": "T", "album": "A", "isrc": "INAA19000001 | in-aa1-90-00002 | INAA19000001", "links": ["https://a.b/c"], "to": "X", "to_title": "X",
                "people": {"composers": [{"name": "C", "ipi": "111111111"}]}}
        out = typed.clean(data, header)
        self.assertEqual(out["isrc"], "INAA19000001 | INAA19000002")
        self.assertEqual(typed.record(out)["fields"]["ISRC"], ["INAA19000001", "INAA19000002"])
        for bad in ("INAA19000001 | nope", "nope", ""):
            with self.assertRaises(typed.TypedError):
                typed.clean({**data, "isrc": bad}, header)
        with self.assertRaises(typed.TypedError):
            typed.clean({**data, "links": ["javascript:alert(1)//https://a.b"]}, header)


class IsrcsOnceTests(SimpleTestCase):
    def test_an_isrc_is_on_one_added_row_only(self):
        add = lambda *i: {"key": "k", "original": {"isrcs": list(i)}}
        row = lambda *i: {"isrcs": list(i)}
        versions, adds = dataclean.isrcs_once({"rows": [row("B"), row("C", "D"), row("E")], "named": ["n"]}, [add("A", "B", "C"), {"key": "x", "original": None}, add("L"), add("E")], {5: ["P"]}, {"L": [2], "H": [3]})
        self.assertEqual([m["original"]["isrcs"] if m["original"] else None for m in adds], [["A"], None, ["L"], ["E"]])   # its only ISRC stays, also one the LNV has
        self.assertEqual([r["isrcs"] for r in versions["rows"]], [["B"], ["C", "D"], ["E"]])
        self.assertEqual(versions["named"], ["n"])
        versions, _ = dataclean.isrcs_once({"rows": [row("P", "Q"), row("H", "Z")]}, [], {5: ["P"]}, {"H": [3]})
        self.assertEqual([r["isrcs"] for r in versions["rows"]], [["Q"], ["Z"]])
        self.assertEqual(dataclean.isrcs_once({}, [], {}, {}), ({"rows": []}, []))


class EditedRowsTests(SimpleTestCase):
    ROW = {"row": 2, "title": "T", "album": "A", "isrcs": ["INAA19000001"], "date": "1990-05-01", "year": "1990", "singers": ["S"], "lyricists": ["L"], "composers": ["C"],
           "publishers": ["P"], "label": "", "duration": "", "link": "https://a.b", "cells": ()}

    def test_the_sheet_stays_as_it_is(self):
        rows = [dict(self.ROW), {**self.ROW, "row": 3}]
        out = dataclean.edited_rows(rows, {1: {"Title": "New", "Release date": "08-05-2013", "ISRC": ["INAA19000002"], "Lyricist": ["X"], "Link": ""}})
        self.assertEqual((out[1]["title"], out[1]["date"], out[1]["year"], out[1]["isrcs"], out[1]["lyricists"], out[1]["link"]), ("New", "2013-05-08", "2013", ["INAA19000002"], ["X"], ""))
        self.assertEqual((rows[1]["title"], rows[1]["year"], out[0]), ("T", "1990", rows[0]))

    def test_a_year_typed_wins_and_unknown_fields_do_nothing(self):
        out = dataclean.edited_rows([dict(self.ROW)], {0: {"Year": "1985", "Release date": "08-05-2013", "Nonsense": "x", "Title": ""}})
        self.assertEqual((out[0]["year"], out[0]["date"], out[0]["title"]), ("1985", "2013-05-08", "T"))


class KeepRowsTests(SimpleTestCase):
    def test_the_rows_kept_are_what_deleting_the_others_leaves(self):
        from openpyxl.styles import PatternFill

        from .engine.export import _keep_rows

        def book():
            ws = openpyxl.Workbook().active
            for r in range(1, 41):
                for c in range(1, 6):
                    ws.cell(r, c).value = f"{r}-{c}"
                if r % 3 == 0:
                    ws.cell(r, 2).fill = PatternFill("solid", fgColor="FFC000")
                ws.cell(r, 4).hyperlink = f"https://a.example/{r}"
                ws.row_dimensions[r].height = 10 + r
            return ws
        keep = {2, 5, 6, 7, 20, 39, 40}
        a, b = book(), book()
        _keep_rows(a, keep)
        for r in range(40, 1, -1):
            if r not in keep:
                b.delete_rows(r)
        read = lambda ws: [[(c.value, c.fill.fgColor.rgb, c.hyperlink.target if c.hyperlink else None) for c in row] for row in ws.iter_rows(max_row=8)]
        self.assertEqual(read(a), read(b))
        self.assertEqual(a.max_row, 8)
        self.assertEqual([a.row_dimensions[r].height for r in range(1, 9)], [11, 12, 15, 16, 17, 30, 49, 50])   # each row with its own
        buf = io.BytesIO()
        a.parent.save(buf)
        back = openpyxl.load_workbook(io.BytesIO(buf.getvalue())).active
        self.assertEqual([back.cell(r, 4).hyperlink.target for r in (2, 3, 8)], ["https://a.example/2", "https://a.example/5", "https://a.example/40"])
        self.assertEqual([back.cell(r, 4).hyperlink.ref for r in (2, 3, 8)], ["D2", "D3", "D8"])


class FollowTests(SimpleTestCase):
    """Answers that name recordings by their sheet row, when a newer export has other rows."""
    @staticmethod
    def _sheet(rows):
        rows = [{"row": n, "title": t, "album": a, "isrcs": i, "date": "", "year": "", "singers": [], "lyricists": ["L"], "composers": ["C"], "publishers": [], "popularity": 0,
                 "label": "", "duration": "", "link": ""} for n, t, a, i in rows]
        return rows, songmerge.analyse(rows)

    def test_recordings_are_followed_by_isrc_and_title(self):
        old = self._sheet([(2, "A", "X", ["INAA19000001"]), (3, "B", "X", ["INAA19000002"]), (4, "C", "X", []), (5, "D", "X", ["INAA19000004"])])
        new = self._sheet([(2, "Zzz", "X", ["INAA19000009"]), (3, "B", "X", ["INAA19000002"]), (4, "A", "X", ["INAA19000001"]), (5, "C", "X", [])])
        d = {"title:2": {"choice": "custom", "data": {"value": "t"}}, "muso:3:Film / album": {"choice": "set", "data": {"value": "v"}}, "title:4": {"choice": "muso", "data": {"value": "c"}},
             "muso:5:Title": {"choice": "set", "data": {"value": "gone"}}, "map:2": {"choice": "join", "data": {"to": 3}}, "map:3": {"choice": "join", "data": {"to": 5}}, "link:x": {"choice": "none", "data": {}}}
        out = songmerge.follow(d, old, new)
        self.assertEqual(out["title:2"], ("title:4", {"value": "t"}))
        self.assertEqual(out["muso:3:Film / album"], ("muso:3:Film / album", {"value": "v"}))
        self.assertEqual(out["title:4"][0], "title:5")
        self.assertIsNone(out["muso:5:Title"])                        # its recording is gone
        self.assertEqual(out["map:2"], ("map:4", {"to": 3}))          # both ends followed
        self.assertIsNone(out["map:3"])                               # mapped onto a recording that is gone
        self.assertNotIn("link:x", out)


# ---------------------------------------------------------------- unit: small files

def effective(content, name="xl/worksheets/sheet1.xml"):
    """Every cell as it shows: {(row, column letters): (style, the rest of the cell)}, and what an absent cell shows."""
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        xml = xp.full_refs(z.read(name).decode())
    cols, rows, cells = xp.column_styles(xml), {}, {}
    for m in xp.ROW_RE.finditer(xml):
        tag = re.match(r"<row\b[^>]*>", m.group(0)).group(0)
        n = int(xp._attr(tag, "r"))
        if xp._attr(tag, "customFormat") in ("1", "true") and xp._attr(tag, "s"):
            rows[n] = int(xp._attr(tag, "s"))
        for c in re.finditer(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', m.group(0), re.S):
            s = re.search(r's="(\d+)"', c.group(2))
            cells[(n, c.group(1))] = (int(s.group(1)) if s else 0, c.group(3))
    return cells, lambda n, col: rows.get(n, cols.get(openpyxl.utils.column_index_from_string(col), 0))


class CompactTests(SimpleTestCase):
    def _book(self, build):
        wb = openpyxl.Workbook()
        build(wb.active, wb)
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    def assert_same(self, a, b):
        """Every cell shows the same value, formula and look; nothing else changed."""
        ca, da = effective(a)
        cb, db = effective(b)
        for k in set(ca) | set(cb):
            sa, va = ca.get(k) or (da(*k), None)
            sb, vb = cb.get(k) or (db(*k), None)
            self.assertEqual(va, vb, k)
            if k in ca:   # (an absent cell may take a look that shows nothing)
                self.assertEqual(sa, sb, k)
        wa, wb_ = openpyxl.load_workbook(io.BytesIO(a)), openpyxl.load_workbook(io.BytesIO(b))
        self.assertEqual(wa.sheetnames, wb_.sheetnames)
        for x, y in zip(wa.worksheets, wb_.worksheets):
            self.assertEqual([[c.value for c in r] for r in x.iter_rows()], [[c.value for c in r] for r in y.iter_rows(max_row=x.max_row, max_col=x.max_column)])
            self.assertEqual({k: v.width for k, v in x.column_dimensions.items() if v.customWidth}, {k: v.width for k, v in y.column_dimensions.items() if v.customWidth and k in x.column_dimensions})

    def test_empty_formatted_cells_go_and_nothing_else_changes(self):
        from openpyxl.styles import Alignment, Font, PatternFill
        centre, yellow = Alignment(horizontal="center"), PatternFill("solid", fgColor="FFFF00")

        def build(ws, wb):
            for r in range(1, 61):
                for c in range(1, 301):
                    ws.cell(r, c).alignment = centre
                ws.cell(r, 1).value, ws.cell(r, 2).value = r, f"Song {r}"
                ws.cell(r, 3).value = f"=A{r}+1"
            for c in range(1, 301):
                ws.cell(7, c).fill = yellow             # a row coloured all the way
            ws.cell(9, 200).fill = yellow               # one coloured cell far out
            ws.cell(9, 201).font = Font(bold=True)
            ws.column_dimensions["B"].width = 44
            wb.create_sheet("Other")["A1"] = "kept"
        a = self._book(build)
        b = xp.compact(a)
        self.assertLess(len(b), len(a) * 0.45)
        self.assert_same(a, b)
        self.assertEqual(xp.compact(b), b)   # done once, nothing more to do

    def test_a_plain_file_stays_as_it_is(self):
        a = self._book(lambda ws, wb: [ws.append([1, "x", None, "=A1"]) for _ in range(5)])
        self.assert_same(a, xp.compact(a))

    def test_what_is_no_workbook_comes_back(self):
        for junk in (b"", b"not a zip", b"PK\x03\x04broken"):
            self.assertEqual(xp.compact(junk), junk)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("a.txt", "x")
        self.assertEqual(xp.compact(buf.getvalue()), buf.getvalue())

    def test_short_addresses_read_back(self):
        row = '<row r="3">' + '<c r="A3" t="n"><v>1</v></c>' + "".join(f'<c r="{openpyxl.utils.get_column_letter(c)}3" s="2"/>' for c in range(2, 40)) \
            + '<c r="AN3" t="n"><v>2</v></c><c r="AQ3" s="2"/></row>'
        xml = f"<worksheet><sheetData>{row}</sheetData></worksheet>"
        short = xp.short_refs(xml)
        self.assertLess(len(short), len(xml))
        self.assertEqual(short.count(' r="A'), 3)   # A3, AN3, AQ3 keep their address (AQ after a gap)
        self.assertEqual(xp.full_refs(short), xml)

    def test_the_reader_counts_cells_without_an_address(self):
        from .engine.xlsx import _cells_by_row
        xml = b'<row r="1"><c r="A1"><v>1</v></c><c s="3"/><c><v>3</v></c><c r="F1"><v>6</v></c><c/><c><v>8</v></c></row>'
        self.assertEqual([(r, c) for r, c, *_ in _cells_by_row(xml)], [(1, 1), (1, 3), (1, 6), (1, 8)])

    def test_formulas_follow_their_rows(self):
        new = {2: 5, 3: 2, 5: 3}
        f = lambda t: xp.moved_formula(t, new)
        self.assertEqual(f("A2+B3"), "A5+B2")
        self.assertEqual(f("VLOOKUP(B2,'[1]Work (3)'!$P:$S,4,0)"), "VLOOKUP(B5,'[1]Work (3)'!$P:$S,4,0)")
        self.assertEqual(f("TRIM([1]Sheet1!J2)"), "TRIM([1]Sheet1!J2)")        # another file's row
        self.assertEqual(f("SUM(A2:C2)"), "SUM(A5:C5)")
        self.assertIsNone(f("SUM(A2:A9)"))                                     # its rows parted
        self.assertEqual(f('IF($A$2="B3",LOG10(A3),1)'), 'IF($A$5="B3",LOG10(A2),1)')


# ---------------------------------------------------------------- integration: 5, 6, 7 – work name, ISRCs, dates

class OutputTests(Base):
    def test_5_the_other_work_name_is_the_alternative(self):
        self.link_dil()
        rows, changes = self.sheet()
        r = self.lnv_row("Dil Ki Baat", rows=rows)
        # the LNV's name kept: Muso's is the alternative, after the one the LNV had
        self.assertEqual(r["Alternate Work"], 'Old Name | Dil Ki Baat (From "Film B")')   # (v1.8.0: a pipe between them)
        self.assertTrue(any("Alternative work name" in c for c in changes))
        # the same name on both sides: nothing to add
        self.assertIsNone(self.lnv_row("Pyaar Ka Geet", "Film A", rows)["Alternate Work"])
        # Muso's name chosen: the LNV's is the alternative
        c = self.case("Dil Ki Baat (From \"Film B\")")
        rid = c["muso"][0]["id"]
        self.save({"key": f"title:{rid}", "choice": "muso", "data": {"value": "Dil Ki Baat (From \"Film B\")"}})
        r = self.lnv_row('Dil Ki Baat (From "Film B")')
        self.assertEqual(r["Alternate Work"], "Old Name | Dil Ki Baat")
        # a title typed: both
        self.save({"key": f"title:{rid}", "choice": "custom", "data": {"value": "Dil Ki Baat Hai"}})
        self.assertEqual(self.lnv_row("Dil Ki Baat Hai")["Alternate Work"], 'Old Name | Dil Ki Baat | Dil Ki Baat (From "Film B")')
        # the reviewer's own value wins; the LNV's own kept on purpose too
        self.save({"key": "pick:3:Alternate title", "choice": "custom", "data": {"value": "Typed Name"}})
        self.assertEqual(self.lnv_row("Dil Ki Baat Hai")["Alternate Work"], "Typed Name")
        self.save({"key": "pick:3:Alternate title", "choice": "lnv", "data": {"value": "Old Name"}})
        self.assertEqual(self.lnv_row("Dil Ki Baat Hai")["Alternate Work"], "Old Name")

    def test_5_a_new_rows_title_chosen(self):
        rid = self.case("Brand New Hit")["muso"][0]["id"]
        self.save({"key": f"title:{rid}", "choice": "custom", "data": {"value": "Naya Geet"}})
        self.assertEqual(self.lnv_row("Naya Geet")["Alternate Work"], "Brand New Hit")

    def test_6_every_isrc_of_a_song_with_pipes_and_never_twice(self):
        self.link_dil()
        rows, changes = self.sheet()
        # the LNV's own first, then Muso's other recording on the same album
        self.assertEqual(self.lnv_row("Pyaar Ka Geet", "Film A", rows)["ISRC"], "INAA19000001 | INAA19000002")
        # no ISRC in the LNV: both of Muso's
        self.assertEqual(self.lnv_row("Dil Ki Baat", rows=rows)["ISRC"], "INAA19000010 | INAA19000011")
        # a cell that held several, one of them twice: a pipe between two, each once
        self.assertEqual(self.lnv_row("Neend Na Aaye", rows=rows)["ISRC"], "INAA19000030 | INAA19000031")
        # a cell with other text is never written over
        self.assertEqual(self.lnv_row("Text In Cell", rows=rows)["ISRC"], "TITLE TRACK (FR TV SER)")
        # the lofi has a row of its own, with its own ISRC only
        self.assertEqual(self.lnv_row("Pyaar Ka Geet - Lofi Flip", rows=rows)["ISRC"], "INAA19000003")
        every = [i for r in rows for i in isrc_list(r["ISRC"])]
        self.assertEqual(len(every), len(set(every)))
        self.assertTrue(any("ISRCs merged" in c and "INAA19000002 added from Muso" in c for c in changes))
        # the file is an LNV again: every ISRC is read back
        with tempfile.NamedTemporaryFile(suffix=".xlsx") as tmp:
            tmp.write(self.book())
            tmp.flush()
            back = {s["title"]: s["isrcs"] for s in parse_master(tmp.name)["songs"]}
        self.assertEqual(back["Pyaar Ka Geet"], ["INAA19000001", "INAA19000002"])

    def test_6_the_screen_says_what_the_file_gets(self):
        step = self.step()
        r = self.case("Pyaar Ka Geet", step)["lnv"][0]
        self.assertEqual((r["fields"]["ISRC"], r["isrc_add"]), (["INAA19000001"], ["INAA19000002"]))
        self.assertEqual(self.case('Dil Ki Baat (From "Film B")', step)["lnv"][0]["isrc_add"], ["INAA19000010", "INAA19000011"])
        self.assertEqual(self.case("Text In Cell", step)["lnv"][0]["isrc_text"], "TITLE TRACK (FR TV SER)")

    def test_6_the_reviewers_choice(self):
        self.save({"key": "pick:2:ISRC", "choice": "lnv", "data": {"value": ["INAA19000001"]}})
        self.assertEqual(self.lnv_row("Pyaar Ka Geet", "Film A")["ISRC"], "INAA19000001")
        self.save({"key": "pick:2:ISRC", "choice": "custom", "data": {"value": ["INAA19000077", "inaa19000078", "INAA19000077"]}})
        self.assertEqual(self.lnv_row("Pyaar Ka Geet", "Film A")["ISRC"], "INAA19000077 | INAA19000078")

    def test_7_release_year_and_the_complete_release_date(self):
        rows, _ = self.sheet()
        r = self.lnv_row("Pyaar Ka Geet", "Film A", rows)
        self.assertEqual((str(r["Release Year(YYYY) *"]), r["Date Of Release(DD-MM-YYYY)"]), ("1990", "01-05-1990"))
        # the LNV's own date stays; a new row has both
        self.assertEqual(self.lnv_row("Has A Date", rows=rows)["Date Of Release(DD-MM-YYYY)"], "01-02-1995")
        r = self.lnv_row("Brand New Hit", rows=rows)
        self.assertEqual((r["Release Year(YYYY) *"], r["Date Of Release(DD-MM-YYYY)"]), ("2020", "25-12-2020"))
        # both on screen, on both sides
        c = self.case("Has A Date")
        self.assertEqual((c["muso"][0]["fields"]["Year"], c["muso"][0]["fields"]["Release date"]), ("1996", "03-02-1996"))
        self.assertEqual((c["lnv"][0]["fields"]["Year"], c["lnv"][0]["fields"]["Release date"]), ("1995", "01-02-1995"))
        self.assertEqual(self.case("Pyaar Ka Geet")["lnv"][0]["date_add"], "01-05-1990")
        # Muso's chosen · typed · left blank
        self.save({"key": "pick:9:Release date", "choice": "muso", "data": {"value": "03-02-1996"}}, {"key": "pick:2:Release date", "choice": "lnv", "data": {"value": []}},
                  {"key": "pick:3:Release date", "choice": "custom", "data": {"value": "16 Aug 1991"}})
        rows, _ = self.sheet()
        self.assertEqual([self.lnv_row(t, rows=rows)["Date Of Release(DD-MM-YYYY)"] for t in ("Has A Date", "Pyaar Ka Geet", "Dil Ki Baat")], ["03-02-1996", None, "16-08-1991"])

    def test_7_an_lnv_without_the_columns_gets_them(self):
        head = [h for h in HEAD if h not in ("Date Of Release(DD-MM-YYYY)", "Alternate Work", "Website1")]
        lnv_file(f"{self.tmp}/bare.xlsx", LNV, head)
        self.upload("master/", "bare.xlsx")
        self.link_dil()
        rows, _ = self.sheet()
        r = self.lnv_row("Dil Ki Baat", rows=rows)
        self.assertEqual((r["Date Of Release(DD-MM-YYYY)"], r["Alternate Work"]), ("15-08-1991", 'Dil Ki Baat (From "Film B")'))
        self.assertTrue(r["Website1"].startswith("https://open.spotify.com/track/"))
        self.assertEqual(len(set(rows[0])), len([k for k in rows[0]]))   # no two columns on one place
        self.assertEqual(list(rows[0])[-1], "Remark")


# ---------------------------------------------------------------- integration: 8, 9 – the DSP data and the links corrected

class CorrectionTests(Base):
    def rec(self, title, i=0):
        return self.case(title)["muso"][i]

    def test_8_a_correction_shows_everywhere_and_keeps_the_sheets_value(self):
        r = self.rec("Brand New Hit")
        before = self.case("Brand New Hit")
        self.save({"key": f"muso:{r['id']}:Title", "choice": "set", "data": {"value": "Brand New Song"}},
                  {"key": f"muso:{r['id']}:Lyricist", "choice": "set", "data": {"value": "Sameer, Anjaan"}},
                  {"key": f"muso:{r['id']}:ISRC", "choice": "set", "data": {"value": "INAA19000098 | INAA19000097"}},
                  {"key": f"muso:{r['id']}:Release date", "choice": "set", "data": {"value": "26-12-2019"}})
        c = self.case("Brand New Song")
        f, was = c["muso"][0]["fields"], c["muso"][0]["edited"]
        self.assertEqual((f["Title"], f["Lyricist"], f["ISRC"], f["Release date"], f["Year"]), ("Brand New Song", ["Sameer", "Anjaan"], ["INAA19000098", "INAA19000097"], "26-12-2019", "2019"))
        self.assertEqual((was["Title"], was["Lyricist"], was["ISRC"], was["Release date"], was["Year"]), ("Brand New Hit", ["Gulzar"], ["INAA19000099"], "25-12-2020", "2020"))
        # the song stays where it is: its key, its name, its answers
        self.assertEqual((c["answer"]["song"], c["family"], c["id"], c["kind"]), (before["answer"]["song"], before["family"], before["id"], before["kind"]))
        self.assertEqual((c["new_row"]["Title"], c["new_row"]["ISRC"], c["new_row"]["Release date"]), ("Brand New Song", ["INAA19000098", "INAA19000097"], "26-12-2019"))
        # and goes into the LNV as corrected
        r2 = self.lnv_row("Brand New Song")
        self.assertEqual((r2["ISRC"], r2["Release Year(YYYY) *"], r2["Date Of Release(DD-MM-YYYY)"], r2["Author Name 1"]), ("INAA19000098 | INAA19000097", "2019", "26-12-2019", "Sameer"))
        # taken back: the sheet's value
        self.save(*[{"key": f"muso:{r['id']}:{x}", "choice": None} for x in ("Title", "Lyricist", "ISRC", "Release date")])
        c = self.case("Brand New Hit")
        self.assertNotIn("edited", c["muso"][0])
        self.assertEqual(self.lnv_row("Brand New Hit")["ISRC"], "INAA19000099")

    def test_8_a_corrected_value_fills_the_lnvs_blanks_and_the_match_stays(self):
        self.link_dil()
        c = self.case('Dil Ki Baat (From "Film B")')
        rid = c["muso"][0]["id"]
        level = c["lnv"][0]["check"]["level"]
        self.save({"key": f"muso:{rid}:ISRC", "choice": "set", "data": {"value": ["INAA19000015"]}},
                  {"key": f"muso:{rid}:Title", "choice": "set", "data": {"value": "Something Else Entirely"}},
                  {"key": f"muso:{rid}:Lyricist", "choice": "set", "data": {"value": ["Nobody"]}},
                  {"key": f"muso:{rid}:Release date", "choice": "set", "data": {"value": "20-08-1991"}})
        c2 = self.case("Something Else Entirely")
        self.assertEqual((c2["answer"], c2["lnv"][0]["row"], c2["lnv"][0]["check"]["level"], c2["family"]), (c["answer"], 3, level, c["family"]))
        r = self.lnv_row("Dil Ki Baat")
        self.assertEqual((r["ISRC"], r["Date Of Release(DD-MM-YYYY)"], r["Alternate Work"]), ("INAA19000015", "20-08-1991", "Old Name | Something Else Entirely"))

    def test_8_the_title_kept_from_muso_is_the_corrected_one(self):
        c = self.case("Has A Date")
        rid = c["muso"][0]["id"]
        self.save({"key": f"title:{rid}", "choice": "muso", "data": {"value": "Has A Date"}}, {"key": f"muso:{rid}:Title", "choice": "set", "data": {"value": "Has The Date"}})
        self.assertEqual(self.step()["titles"][str(rid)]["value"], "Has The Date")
        self.assertEqual(self.lnv_row("Has The Date")["Alternate Work"], "Has A Date")
        self.save({"key": f"muso:{rid}:Title", "choice": None})
        self.assertEqual(self.lnv_row("Has A Date")["Alternate Work"], None)

    def test_8_remarks_stay_with_a_song_whose_isrc_is_corrected(self):
        from .models import Remark
        remark = Remark.objects.create(name="Cover Test Remark")
        rid = self.rec("Brand New Hit")["id"]
        self.save({"key": "remark:INAA19000099", "choice": "set", "data": {"remark": remark.id, "value": "Cover Test Remark"}}, {"key": f"muso:{rid}:ISRC", "choice": "set", "data": {"value": "INAA19000098"}})
        self.assertEqual(self.lnv_row("Brand New Hit")["Remark"], "Cover Test Remark")

    def test_8_the_merged_sheet_has_the_corrections(self):
        rid = self.rec("Brand New Hit")["id"]
        self.save({"key": f"muso:{rid}:Title", "choice": "set", "data": {"value": "=1+1"}}, {"key": f"muso:{rid}:Singer", "choice": "set", "data": {"value": "New Singer"}})
        res = self.client.get(f"/api/clients/{self.cid}/steps/merged/")
        wb = openpyxl.load_workbook(io.BytesIO(res.content))
        cells = {c.value: c.data_type for r in wb["All Songs"].iter_rows() for c in r}
        self.assertIn("New Singer", cells)
        self.assertEqual(cells["=1+1"], "s")   # text, never a formula

    def test_8_undo_and_the_change_log(self):
        rid = self.rec("Brand New Hit")["id"]
        self.save({"key": f"muso:{rid}:Title", "choice": "set", "data": {"value": "X Y"}, "log": {"songs": [{"key": "f:x", "title": "Brand New Hit"}], "text": "Muso title corrected"}})
        ch = self.client.get(f"/api/clients/{self.cid}/changes/").json()["changes"]
        self.assertEqual(ch[0]["lines"], ["Muso title corrected"])
        self.send("changes/", {"undo": [ch[0]["id"]]})
        self.case("Brand New Hit")

    def test_8_a_newer_export_keeps_the_corrections_on_their_recordings(self):
        rid, gone = self.rec("Brand New Hit")["id"], self.rec("Has A Date")["id"]
        self.save({"key": f"muso:{rid}:Title", "choice": "set", "data": {"value": "Fixed Title"}}, {"key": f"title:{rid}", "choice": "custom", "data": {"value": "Chosen"}},
                  {"key": f"muso:{gone}:Singer", "choice": "set", "data": {"value": ["Z"]}})
        newer = [dict(title=t, album="Film Z", isrc=f"INAA1900050{n}", lyricist="Gulzar") for n, t in enumerate(("Another", "One More"))] + [*[m for m in MUSO if m["title"] != "Has A Date"]]
        muso_file(f"{self.tmp}/newer.xlsx", newer)
        self.upload("clean/", "newer.xlsx")
        c = self.case("Fixed Title")
        self.assertEqual(c["muso"][0]["edited"]["Title"], "Brand New Hit")
        self.assertNotEqual(c["muso"][0]["id"], rid)
        self.assertEqual(self.step()["titles"][str(c["muso"][0]["id"])]["value"], "Chosen")
        keys = set(CleanDecision.objects.filter(client_id=self.cid).values_list("key", flat=True))
        self.assertFalse([k for k in keys if k.endswith(":Singer")])   # its recording is not in the newer sheet
        self.assertEqual(len([k for k in keys if k.startswith("muso:")]), 1)

    def test_9_the_lnvs_link_is_replaced_where_it_stands(self):
        old = "https://open.spotify.com/track/" + "a" * 22
        c = self.case("Has A Date")
        self.assertEqual((c["lnv"][0]["fields"]["Link"], c["lnv"][0]["link"]), (old, old))
        self.save({"key": "pick:9:Link", "choice": "custom", "data": {"value": "https://youtu.be/working"}})
        rows, changes = self.sheet()
        self.assertEqual(self.lnv_row("Has A Date", rows=rows)["Website1"], "https://youtu.be/working")
        self.assertTrue(any("Link changed" in x and old in x and "youtu.be/working" in x for x in changes))
        # blank: Muso's fills it – or stays blank on purpose
        self.assertTrue(self.lnv_row("Pyaar Ka Geet", "Film A", rows)["Website1"].startswith("https://open.spotify.com/track/"))
        self.save({"key": "pick:2:Link", "choice": "lnv", "data": {"value": []}})
        self.assertIsNone(self.lnv_row("Pyaar Ka Geet", "Film A")["Website1"])
        # the DSP's link corrected: the new row has it
        rid = self.rec("Brand New Hit")["id"]
        self.save({"key": f"muso:{rid}:Link", "choice": "set", "data": {"value": "https://youtu.be/new"}})
        self.assertEqual(self.lnv_row("Brand New Hit")["Website1"], "https://youtu.be/new")
        self.assertEqual(self.rec("Brand New Hit")["link"], "https://youtu.be/new")

    def test_9_a_spotify_id_goes_with_its_link(self):
        from .engine.export import _write_link
        from .engine.master import read_layout
        lnv_file(f"{self.tmp}/s.xlsx", [dict(title="A", spotify="a" * 22), dict(title="B", site="https://open.spotify.com/track/" + "b" * 22, spotify="b" * 22), dict(title="C", site2="https://old.example/x")])
        ws = xp.PatchSheet(f"{self.tmp}/s.xlsx")
        layout = read_layout([c.value for c in ws[1]])
        at = lambda r, f: ws.cell(r, layout["fields"][f] + 1).value
        from openpyxl.styles import PatternFill
        fill = PatternFill("solid", fgColor="FFF1CC")
        new = "https://open.spotify.com/track/" + "z" * 22
        self.assertTrue(_write_link(ws, layout, 2, new, fill))
        self.assertEqual((at(2, "spotify_id"), at(2, "website")), ("z" * 22, None))
        _write_link(ws, layout, 3, new, fill)
        self.assertEqual((at(3, "spotify_id"), at(3, "website")), ("z" * 22, new))
        _write_link(ws, layout, 4, "https://youtu.be/1", fill)
        self.assertEqual((at(4, "website2"), at(4, "website")), ("https://youtu.be/1", None))   # in the column it stood in
        self.assertFalse(_write_link(ws, layout, 4, "javascript:alert(1)", fill))
        self.assertEqual(at(4, "website2"), "https://youtu.be/1")

    def test_9_the_cells_hyperlink_opens_the_new_link_and_moves_with_its_row(self):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(HEAD)
        for n, t in enumerate(("Zebra", "Alpha"), start=2):
            ws.cell(n, 2).value, ws.cell(n, 10).value = t, f"https://old.example/{t}"
            ws.cell(n, 10).hyperlink = f"https://old.example/{t}"
        ws.cell(2, 11).hyperlink, ws.cell(2, 11).value = "https://kept.example/z", "kept"
        wb.save(f"{self.tmp}/h.xlsx")
        sheet = xp.PatchSheet(f"{self.tmp}/h.xlsx")
        sheet.cell(2, 10).value = "https://new.example/zebra"
        sheet.cell(3, 10).value = "no link any more"
        sheet.order = [3, 2]   # A–Z: Alpha first
        out = openpyxl.load_workbook(io.BytesIO(sheet.save([["x"]], ["h"], (10,)))).worksheets[0]
        self.assertEqual([out.cell(r, 2).value for r in (2, 3)], ["Alpha", "Zebra"])
        self.assertIsNone(out.cell(2, 10).hyperlink)
        self.assertEqual((out.cell(3, 10).value, out.cell(3, 10).hyperlink.target), ("https://new.example/zebra", "https://new.example/zebra"))
        self.assertEqual(out.cell(3, 11).hyperlink.target, "https://kept.example/z")   # moved with its row


# ---------------------------------------------------------------- integration: 10 – matches kept until all are answered

class RetentionTests(Base):
    TITLE = "Saawan Ki Raat"

    def rows(self, c):
        """The song's LNV rows on screen: {row: to check | off}."""
        mine = [*(c["answer"].get("rows") or []), *(c["answer"].get("also") or [])] if c["answer"].get("by") == "you" else None
        out = {r["row"]: "open" for r in c["lnv"] if (r["row"] in mine if mine is not None else (r.get("check") or {}).get("level"))}
        out.update({r: "ticked" for r in (c["answer"].get("rows") or []) if c["answer"].get("by") == "you"})
        out.update({r["row"]: "off" for r in c.get("off_lnv") or []})
        return out

    def test_10_every_match_stays_until_each_is_answered(self):
        c = self.case(self.TITLE)
        self.assertEqual(self.rows(c), {5: "open", 6: "open", 7: "open"})
        song = c["answer"]["song"]
        # one ticked: the others stay
        self.save({"key": f"link:{song}", "choice": "same", "data": {"rows": [5], "also": [6, 7]}})
        self.assertEqual(self.rows(self.case(self.TITLE)), {5: "ticked", 6: "open", 7: "open"})
        # one turned down: it stays too, answered
        self.save({"key": f"off:{song}", "choice": "rows", "data": {"rows": [6]}})
        c = self.case(self.TITLE)
        self.assertEqual(self.rows(c), {5: "ticked", 6: "off", 7: "open"})
        self.assertTrue(c["off_lnv"][0]["check"]["level"])
        # the last one: every one is still on screen
        self.save({"key": f"off:{song}", "choice": "rows", "data": {"rows": [6, 7]}})
        self.assertEqual(self.rows(self.case(self.TITLE)), {5: "ticked", 6: "off", 7: "off"})
        # put back: to check again
        self.save({"key": f"off:{song}", "choice": "rows", "data": {"rows": [7]}}, {"key": f"link:{song}", "choice": "same", "data": {"rows": [5], "also": [6]}})
        self.assertEqual(self.rows(self.case(self.TITLE)), {5: "ticked", 6: "open", 7: "off"})

    def test_10_a_new_row_for_one_match_leaves_the_others(self):
        c = self.case(self.TITLE)
        song = c["answer"]["song"]
        self.save({"key": f"off:{song}", "choice": "rows", "data": {"rows": [5], "then": "add"}})
        c = self.case(self.TITLE)
        self.assertEqual((self.rows(c), c["off_then"]), ({5: "off", 6: "open", 7: "open"}, "add"))
        # the whole song sent to a new row: the rows it was matched to come with it, also the ones turned down before
        self.save({"key": f"link:{song}", "choice": "none", "data": {"rows": [5, 6, 7]}}, {"key": f"missing:{song}", "choice": "add"}, {"key": f"off:{song}", "choice": None})
        c = self.case(self.TITLE)
        self.assertEqual((c["answer"]["choice"], sorted(r["row"] for r in c["was"])), ("add", [5, 6, 7]))
        self.assertTrue(all(r["check"]["level"] for r in c["was"]))
        # put back: all three to check
        self.save({"key": f"link:{song}", "choice": None}, {"key": f"missing:{song}", "choice": None})
        self.assertEqual(self.rows(self.case(self.TITLE)), {5: "open", 6: "open", 7: "open"})

    def test_10_a_mapped_recording_is_shown_where_it_stood(self):
        c, home = self.case(self.TITLE), self.case("Pyaar Ka Geet")
        rid = c["muso"][0]["id"]
        self.save({"key": f"map:{rid}", "choice": "join", "data": {"to": home["muso"][0]["id"], "row": 2, "title": "Pyaar Ka Geet", "from": self.TITLE, "was": [5, 6], "family": c["family"]}})
        m = self.step()["moved"]
        self.assertEqual([(x["id"], x["family"], x["to_title"], [r["row"] for r in x["lnv"]]) for x in m], [(rid, c["family"], "Pyaar Ka Geet", [5, 6])])
        # a newer LNV has other rows: the old ones are forgotten
        self.upload("master/", "lnv.xlsx")
        self.assertEqual(self.step()["moved"], [])

    def test_10_a_row_given_to_another_recording_keeps_the_match_on_screen(self):
        """Two recordings fit one LNV row: the reviewer gives it to the other one – the first is not gone, it is asked."""
        r = lambda n, title, album, isrc, year: {"row": n, "title": title, "album": album, "isrcs": [isrc] if isrc else [], "date": f"{year}-01-01", "year": str(year), "singers": [], "lyricists": ["Gulzar"],
                                                 "composers": [CLIENT], "label": "", "duration": "", "link": "", "popularity": 0, "publishers": ["Saregama"], "cells": ()}
        rows = [r(2, "Ek Geet", "Film Q", "INBB10000001", 1990), r(3, "Ek Geet", "Film Q", "USCC10000002", 1990)]
        for x in (rows[1],):
            x["lyricists"] = ["Gulzar", "Extra Name"]
        sheet = {"rows": rows, "source": "Muso", "sheet": "x", "sheets": [], "header": []}
        lnv_file(f"{self.tmp}/one.xlsx", [dict(title="Ek Geet", film="Film Q", year=1990, composer=C, author="Gulzar", publisher=S)])
        master = parse_master(f"{self.tmp}/one.xlsx")
        groups = [[0], [1]]
        base = dataclean.match(master, sheet, CLIENT, {}, {}, groups)
        shown = lambda res: sorted((x["song"]["key"], l["row"]) for x in res["matched"] for l in x["links"] + x.get("also", [])) + sorted((x["song"]["key"], k["row"]) for x in res["check"] for k in x["candidates"])
        first = [k for k, _ in shown(base)]
        loser = next(k for k in ("INBB10000001", "USCC10000002") if k in first)
        other = "USCC10000002" if loser == "INBB10000001" else "INBB10000001"
        after = dataclean.match(master, sheet, CLIENT, {}, {other: {"choice": "same", "rows": [2]}}, groups)
        self.assertIn((loser, 2), shown(after))   # it does not go to "Not in the LNV" by itself
        self.assertIn((other, 2), shown(after))

    def hold(self, items, hold, status=200):
        return self.send("clean/decisions/", {"quiet": True, "items": items, "hold": hold}, status)

    def test_10_matches_on_screen_are_held_until_each_is_answered(self):
        """What was on screen when the song was begun stays there, whatever the match makes of the answers beside it."""
        c = self.case(self.TITLE)
        song = c["answer"]["song"]
        # row 9 is no match of this song at all – as if an answer had changed the match: held, it is still to answer
        self.hold([{"key": f"link:{song}", "choice": "same", "data": {"rows": [5]}}], {song: {"rows": {"5": "possible", "6": "possible", "7": "possible", "9": "exact"}, "vers": {}}})
        c = self.case(self.TITLE)
        self.assertEqual(self.rows(c), {5: "ticked", 6: "open", 7: "open", 9: "open"})
        kept = {r["row"]: (r.get("kept"), r["check"]["level"]) for r in c["lnv"]}
        self.assertEqual((kept[9], kept[6], kept[5][0]), ((True, "exact"), (True, "possible"), None))
        # each answered: ticked, or turned down
        self.save({"key": f"link:{song}", "choice": "same", "data": {"rows": [5, 9], "also": [6, 7]}}, {"key": f"off:{song}", "choice": "rows", "data": {"rows": [6]}})
        self.assertEqual(self.rows(self.case(self.TITLE)), {5: "ticked", 6: "off", 7: "open", 9: "ticked"})
        # the song sent out takes them along; put back, they are to check again
        self.save({"key": f"link:{song}", "choice": "none", "data": {"rows": [5, 6, 7, 9]}}, {"key": f"missing:{song}", "choice": "add"}, {"key": f"off:{song}", "choice": None})
        c = self.case(self.TITLE)
        self.assertEqual(([r["row"] for r in c["was"]], [r for r in c["lnv"] if r.get("kept")]), ([5, 6, 7, 9], []))
        self.save({"key": f"link:{song}", "choice": None}, {"key": f"missing:{song}", "choice": None})
        self.assertEqual(self.rows(self.case(self.TITLE)), {5: "open", 6: "open", 7: "open", 9: "open"})
        # a hold is no answer: nothing of it in the Undo section – and a newer LNV has other rows
        self.assertFalse([x for ch in CleanChange.objects.filter(client_id=self.cid) for x in ch.keys if x.startswith("hold:")])
        self.upload("master/", "lnv.xlsx")
        self.assertFalse(CleanDecision.objects.filter(client_id=self.cid, key__startswith="hold:").exists())

    def test_10_a_held_version_does_not_move_to_another_row(self):
        row = lambda *titles: dict(titles)
        lnv_file(f"{self.tmp}/v.xlsx", [dict(title="Geet", film="Film G", isrc="INAA10000001", year=1990, composer=C, author="Gulzar", publisher=S),
                                        dict(title="Geet (Lofi)", film="Film G", year=2020, composer=C, author="Gulzar", publisher=S),
                                        dict(title="Geet Lofi", film="Film G", year=2020, composer=C, author="Gulzar", publisher=S)])
        muso_file(f"{self.tmp}/v_m.xlsx", [dict(title="Geet", album="Film G", isrc="INAA10000001", lyricist="Gulzar"), dict(title="Geet - Lofi", album="Film G", isrc="INAA10000002", lyricist="Gulzar", date="2020-01-01")])
        self.upload("master/", "v.xlsx")
        self.upload("clean/", "v_m.xlsx")
        c = self.case("Geet")
        v = c["in_lnv"][0]
        other = {3: 4, 4: 3}[v["row"]]
        self.assertIsNone(v["answer"])
        self.hold([{"key": v["key"], "choice": "none", "data": {"rows": [v["row"]]}}], {c["answer"]["song"]: {"rows": {}, "vers": {v["key"]: v["row"]}}})
        now = self.case("Geet")["in_lnv"]
        self.assertEqual([(x["row"], x["answer"]) for x in now], [(v["row"], "none")])   # not quietly matched with the other row
        self.assertNotEqual(now[0]["row"], other)

    def test_10_undoing_everything_brings_the_screen_back(self):
        strip = lambda s: {k: v for k, v in s.items() if k != "updates"}
        before = strip(self.step())
        song = self.case(self.TITLE)["answer"]["song"]
        hold = {song: {"rows": {"5": "possible", "6": "possible", "7": "possible"}, "vers": {}}}
        rid = self.case("Brand New Hit")["muso"][0]["id"]
        log = lambda t: {"group": t, "songs": [{"key": "f:x", "title": "X"}], "text": t}
        self.hold([{"key": f"off:{song}", "choice": "rows", "data": {"rows": [6], "then": "add"}, "log": log("a")}], hold)
        self.hold([{"key": f"link:{song}", "choice": "same", "data": {"rows": [5], "also": [7]}, "log": log("b")}], hold)
        self.hold([{"key": f"muso:{rid}:Title", "choice": "set", "data": {"value": "Edited"}, "log": log("c")}, {"key": "pick:9:Link", "choice": "custom", "data": {"value": "https://youtu.be/x"}, "log": log("d")}], None)
        self.assertNotEqual(strip(self.step()), before)
        ids = [c["id"] for c in self.client.get(f"/api/clients/{self.cid}/changes/").json()["changes"]]
        self.assertEqual(len(ids), 4)
        self.send("changes/", {"undo": ids})
        self.assertEqual(strip(self.step()), before)

    def test_10_what_is_held_is_checked(self):
        item = [{"key": "title:2", "choice": "custom", "data": {"value": "x"}}]
        for bad in ("x", [1], {"": {"rows": {}}}, {"s": 1}, {"s": {"rows": {"x": "exact"}}}, {"s": {"rows": {"5": "sure"}}}, {"s": {"rows": [5]}}, {"s": {"vers": {"link:x": 5}}},
                    {"s": {"vers": {"version:x": "5"}}}, {"s": {"vers": {"version:x": True}}}, {"s" * 300: {"rows": {"5": "exact"}}}, {"s": {"rows": {str(n): "exact" for n in range(600)}}}):
            self.hold(item, bad, 400)
        self.assertFalse(CleanDecision.objects.filter(client_id=self.cid).exists())
        self.hold(item, {"s": {"rows": {"5": "exact"}, "vers": {"version:x": 5}}})
        self.hold(item, {"s": {"rows": {"5": "possible", "6": "possible"}}})
        self.assertEqual(CleanDecision.objects.get(client_id=self.cid, key="hold:s").data, {"rows": {"5": "exact", "6": "possible"}, "vers": {"version:x": 5}})
        # a hold cannot be sent as an answer
        self.save({"key": "hold:s", "choice": "rows", "data": {}}, status=400)
        self.step()

    def test_10_the_answers_undo_one_by_one(self):
        song = self.case(self.TITLE)["answer"]["song"]
        self.save({"key": f"off:{song}", "choice": "rows", "data": {"rows": [5]}, "log": {"group": "a", "songs": [{"key": "f:s", "title": self.TITLE}], "text": "LNV row 5 is not this song"}})
        ch = self.client.get(f"/api/clients/{self.cid}/changes/").json()["changes"][0]
        self.send("changes/", {"undo": [ch["id"]]})
        self.assertEqual(self.rows(self.case(self.TITLE)), {5: "open", 6: "open", 7: "open"})


# ---------------------------------------------------------------- integration: 11 – last updated

class LastUpdatedTests(Base):
    def change(self, title, n, by=None):
        self.save({"key": f"title:{n}", "choice": "custom", "data": {"value": f"T{n}"}, "log": {"group": f"g{n}", "songs": [{"key": f"f:{title.lower()}", "title": title}], "text": f"Title of {title}"}})

    def test_11_the_song_changed_last_with_when_and_by_whom(self):
        self.assertEqual(self.step()["updates"], {"last": [], "songs": {}})
        for n, t in enumerate(("Alpha", "Beta", "Gamma"), start=2):
            self.change(t, n)
        up = self.step()["updates"]
        self.assertEqual([x["title"] for x in up["last"]], ["Gamma", "Beta", "Alpha"])
        self.assertEqual((up["last"][0]["by"], up["last"][0]["what"], up["last"][0]["key"]), ("Asha", "Title of Gamma", "f:gamma"))
        self.assertIsNotNone(datetime.fromisoformat(up["last"][0]["at"]).tzinfo)
        self.assertEqual(set(up["songs"]), {"f:alpha", "f:beta", "f:gamma"})
        # a song changed again is the last one; an undone change counts too
        self.change("Alpha", 7)
        self.assertEqual([x["title"] for x in self.step()["updates"]["last"]], ["Alpha", "Gamma", "Beta"])
        beta = next(c for c in self.client.get(f"/api/clients/{self.cid}/changes/").json()["changes"] if c["songs"][0]["title"] == "Beta")
        self.send("changes/", {"undo": [beta["id"]]})
        up = self.step()["updates"]["last"]
        self.assertEqual((up[0]["title"], up[0]["what"][:8]), ("Beta", "Undone: "))
        # on the client list
        row = next(c for c in self.client.get("/api/clients/").json()["clients"] if c["id"] == self.cid)
        self.assertEqual((row["last_song"]["title"], row["last_song"]["by"]), ("Alpha", "Asha"))

    def test_11_another_clients_changes_are_not_this_ones(self):
        self.change("Alpha", 2)
        other = self.client.post("/api/clients/", {"name": "Other Client"}, content_type="application/json").json()["id"]
        rows = {c["id"]: c["last_song"] for c in self.client.get("/api/clients/").json()["clients"]}
        self.assertIsNone(rows[other])

    def test_11_names_and_other_answers_are_no_song(self):
        CleanChange.objects.create(client_id=self.cid, songs=[{"key": "other", "title": "Names"}], lines=["x"], keys=["name:a|b"], items=[], by="X")
        self.assertEqual(self.step()["updates"]["last"], [])


# ---------------------------------------------------------------- integration: 12 – the files

class FileSizeTests(Base):
    def test_12_the_lnv_with_a_wide_formatted_sheet_is_small_and_complete(self):
        from openpyxl.styles import Alignment, PatternFill
        wb = openpyxl.load_workbook(f"{self.tmp}/lnv.xlsx")
        ws = wb.active
        for r in range(1, 260):
            for c in range(43, 700):
                ws.cell(r, c).alignment = Alignment(horizontal="center")
        for c in range(1, 700):
            ws.cell(4, c).fill = PatternFill("solid", fgColor="FFC000")
        ws.cell(200, 650).value = "far out"
        wb.save(f"{self.tmp}/wide.xlsx")
        self.upload("master/", "wide.xlsx")
        import os
        big = os.path.getsize(f"{self.tmp}/wide.xlsx")
        out = self.book()
        self.assertLess(len(out), big / 5)
        ws = openpyxl.load_workbook(io.BytesIO(out)).worksheets[0]
        values = {c.value for r in ws.iter_rows() for c in r}
        self.assertIn("far out", values)
        rows, _ = self.sheet(out)
        self.assertEqual(sorted(r["Work*"] for r in rows if r["Work*"]), sorted([m["title"] for m in LNV] + ["Pyaar Ka Geet - Lofi Flip", "Brand New Hit"]))
        # the stage 2 LNV made from it, downloaded as the final one
        self.send("stage1/", {"done": True})
        final = self.book("")
        self.assertLess(len(final), big / 5)
        self.assertEqual(sorted(str(r["Work*"]) for r in self.sheet(final)[0]), sorted(str(r["Work*"]) for r in rows))

    def test_12_by_album_too(self):
        rows, _ = self.sheet(self.book("?stage=1&rows=all&order=album"))
        films = [r["Movie Name *"] for r in rows]
        self.assertEqual(films, sorted(films, key=lambda f: (not f, (f or "").lower())))

    def test_every_part_of_the_file_is_well_formed(self):
        import xml.etree.ElementTree as ET
        with zipfile.ZipFile(io.BytesIO(self.book())) as z:
            self.assertIsNone(z.testzip())
            names = z.namelist()
            self.assertEqual(len(names), len(set(names)))
            for n in names:
                if n.endswith((".xml", ".rels")):
                    ET.fromstring(z.read(n))
            types = z.read("[Content_Types].xml").decode()
            for part in re.findall(r'PartName="/([^"]+)"', types):
                self.assertIn(part, names)
            self.assertNotIn("xl/calcChain.xml", names)


# ---------------------------------------------------------------- 14 – the status lists

class StatusListTests(Base):
    def test_14_the_lists_as_excel_keep_text_as_text(self):
        res = self.client.post(f"/api/clients/{self.cid}/lists/", {"name": "Song status", "sheets": [
            {"name": "Song status", "header": ["Song name", "Status"], "rows": [["=HYPERLINK(\"http://evil\")", "Left to check"], ["+1", "All checked"], ["@x", "Partly checked"]]}]}, content_type="application/json")
        self.assertEqual(res.status_code, 200)
        ws = openpyxl.load_workbook(io.BytesIO(res.content)).active
        self.assertEqual([(c.value, c.data_type) for c in ws["A"][1:]], [("=HYPERLINK(\"http://evil\")", "s"), ("+1", "s"), ("@x", "s")])


# ---------------------------------------------------------------- security

class SecurityTests(Base):
    URLS = ["steps/?step=1", "steps/lnv/?stage=1", "steps/merged/", "clean/", "clean/export/", "clean/rows/?rows=2", "changes/", "songs/", "stage2/", ""]

    def test_nothing_without_signing_in(self):
        out = Browser()
        for u in self.URLS:
            self.assertEqual(out.get(f"/api/clients/{self.cid}/{u}").status_code, 401, u)
        for u in ("clean/decisions/", "changes/", "songs/", "lists/", "stage1/", "stage2/", "master/", "clean/"):
            self.assertEqual(out.post(f"/api/clients/{self.cid}/{u}", {}, content_type="application/json").status_code, 401, u)
        self.assertEqual(out.get("/api/clients/").status_code, 401)

    def test_a_forged_request_is_refused(self):
        strict = Browser(enforce_csrf_checks=True)
        strict.force_login(self.user)
        for u in ("clean/decisions/", "changes/", "songs/", "lists/", "stage1/"):
            self.assertEqual(strict.post(f"/api/clients/{self.cid}/{u}", "{}", content_type="application/json").status_code, 403, u)
        self.assertFalse(CleanDecision.objects.filter(client_id=self.cid).exists())

    def test_a_broken_answer_is_refused_and_never_breaks_the_client(self):
        bad = [
            {"key": "pick:x:Title", "choice": "custom", "data": {"value": "v"}}, {"key": "pick:2:Nonsense", "choice": "custom", "data": {"value": "v"}}, {"key": "pick:2", "choice": "custom", "data": {"value": "v"}},
            {"key": "muso:x:Title", "choice": "set", "data": {"value": "v"}}, {"key": "muso:2:Nonsense", "choice": "set", "data": {"value": "v"}}, {"key": "muso:2:Title", "choice": "set", "data": {}},
            {"key": "muso:2:Title", "choice": "set", "data": {"value": ""}}, {"key": "muso:2:ISRC", "choice": "set", "data": {"value": "'; DROP TABLE x"}},
            {"key": "muso:2:Link", "choice": "set", "data": {"value": "javascript:alert(document.cookie)"}}, {"key": "muso:2:Link", "choice": "set", "data": {"value": ["data:text/html,<script>"]}},
            {"key": "pick:9:Link", "choice": "custom", "data": {"value": "javascript:alert(1)"}}, {"key": "pick:9:Link", "choice": "muso", "data": {"value": ["vbscript:x"]}},
            {"key": "pick:9:Release date", "choice": "custom", "data": {"value": "tomorrow"}},
            {"key": "link:INAA19000001", "choice": "same", "data": {"rows": ["x"]}}, {"key": "link:INAA19000001", "choice": "same", "data": {"rows": "2"}}, {"key": "link:INAA19000001", "choice": "same", "data": {"rows": [2], "also": [{}]}},
            {"key": "off:INAA19000001", "choice": "rows", "data": {"rows": [None]}}, {"key": "off:INAA19000001", "choice": "rows", "data": {"rows": [1.5]}}, {"key": "off:INAA19000001", "choice": "rows", "data": {"rows": list(range(5000))}},
            {"key": "map:x", "choice": "join", "data": {"to": 2}}, {"key": "map:2", "choice": "join", "data": {"to": "x"}}, {"key": "map:2", "choice": "join", "data": {}}, {"key": "map:2", "choice": "join", "data": {"to": 3, "was": ["a"]}},
            {"key": "title:x", "choice": "custom", "data": {"value": "v"}}, {"key": "title:2", "choice": "custom", "data": {"value": {"a": 1}}}, {"key": "title:2", "choice": "custom", "data": {"value": [1, 2]}},
            {"key": "dup:2-3", "choice": "duplicate", "data": {"keep": "x"}}, {"key": "name:a|b", "choice": "same", "data": {"a": {"x": 1}}}, {"key": "name:a|b", "choice": "same", "data": {"songs": "x"}},
            {"key": "nope:1", "choice": "set", "data": {}}, {"key": "muso:2:Title", "choice": "drop", "data": {"value": "v"}}, {"key": "muso:2:Title", "choice": ["set"], "data": {"value": "v"}}, {"key": "link:", "choice": "same", "data": {"rows": [2]}},
            {"key": "link:" + "x" * 400, "choice": "same", "data": {"rows": [2]}}, {"key": "song:1", "choice": "typed", "data": {}},
            {"key": "remark:X", "choice": "set", "data": {"remark": "1 OR 1=1"}},
        ]
        for item in bad:
            res = self.client.post(f"/api/clients/{self.cid}/clean/decisions/", {"quiet": True, "items": [item]}, content_type="application/json")
            self.assertEqual(res.status_code, 400, (item, res.content[:200]))
        for body in ({"items": "x"}, {"items": [1]}, {"items": [None]}, {"items": {"a": 1}}):
            self.assertEqual(self.client.post(f"/api/clients/{self.cid}/clean/decisions/", body, content_type="application/json").status_code, 400, body)
        self.assertFalse(CleanDecision.objects.filter(client_id=self.cid).exists())
        # one bad answer in a save: none of it is saved
        self.save({"key": "title:2", "choice": "custom", "data": {"value": "fine"}}, {"key": "pick:x:Title", "choice": "custom", "data": {"value": "v"}}, status=400)
        self.assertFalse(CleanDecision.objects.filter(client_id=self.cid).exists())
        self.step()
        self.book()

    def test_an_old_answer_that_is_broken_does_not_break_the_screen(self):
        """What an earlier version may have let in."""
        for key, choice, data in (("muso:999:Title", "set", {"value": "x"}), ("muso:2:Nonsense", "set", {"value": "x"}), ("muso:2:Title", "set", {}), ("muso:abc:Title", "set", {"value": "x"})):
            CleanDecision.objects.create(client_id=self.cid, key=key, choice=choice, data=data)
        self.step()
        self.book()

    def test_text_goes_in_as_text(self):
        """Markup, formulas, quotes and control characters in a typed value: into the sheet as written, never run."""
        evil = ['=HYPERLINK("http://evil.example","x")', "<script>alert(1)</script>", "]]></t></is></c><c><f>1</f></c>", "&lt;x&gt; \"q\" 'q'", "+cmd|' /C calc'!A0", "@SUM(1)", "दिल 😀"]
        for n, text in enumerate(evil):
            rid = self.case("Brand New Hit")["muso"][0]["id"]
            self.save({"key": f"title:{rid}", "choice": "custom", "data": {"value": text}})
            wb = openpyxl.load_workbook(io.BytesIO(self.book()))
            cells = [c for r in wb.worksheets[0].iter_rows() for c in r if c.value == text]
            self.assertTrue(cells, text)
            self.assertEqual({c.data_type for c in cells}, {"s"}, text)

    def test_control_characters_do_not_break_the_file(self):
        rid = self.case("Brand New Hit")["muso"][0]["id"]
        self.save({"key": f"title:{rid}", "choice": "custom", "data": {"value": "Bad\x01\x0bName\x1f"}})
        wb = openpyxl.load_workbook(io.BytesIO(self.book()))
        self.assertIn("BadName", {c.value for r in wb.worksheets[0].iter_rows() for c in r})

    def test_rows_that_are_no_numbers(self):
        self.assertEqual(self.client.get(f"/api/clients/{self.cid}/steps/?row=abc").status_code, 400)
        self.assertEqual(self.client.get(f"/api/clients/{self.cid}/steps/?row=1 OR 1=1").status_code, 400)
        self.assertEqual(self.client.get(f"/api/clients/{self.cid}/clean/rows/?rows=2;DROP,x,3").status_code, 200)

    def test_an_unknown_client_is_not_found(self):
        for u in self.URLS:
            self.assertEqual(self.client.get(f"/api/clients/999999/{u}").status_code, 404, u)
        self.assertEqual(self.client.post("/api/clients/999999/clean/decisions/", {"items": []}, content_type="application/json").status_code, 404)

    def test_a_clients_name_never_breaks_out_of_the_file_name(self):
        cid = self.client.post("/api/clients/", {"name": 'A"; filename="evil.exe\r\nX-Evil: 1 /../../etc'}, content_type="application/json").json()["id"]
        old, self.cid = self.cid, cid
        self.upload("master/", "lnv.xlsx")
        self.upload("clean/", "muso.xlsx")
        for u in ("steps/lnv/?stage=1", "steps/lnv/", "steps/merged/", "clean/export/"):
            res = self.client.get(f"/api/clients/{cid}/{u}")
            self.assertEqual(res.status_code, 200, u)
            self.assertNotIn("X-Evil", res.headers)
            self.assertRegex(res["Content-Disposition"], r'^attachment; filename="[^"/\\\r\n]+\.xlsx"$')
        self.cid = old

    def test_uploads_that_are_no_spreadsheets(self):
        def post(url, name, data):
            return self.client.post(f"/api/clients/{self.cid}/{url}", {"file": io.BytesIO(data)} if not name else {"file": _named(name, data)})

        def _named(name, data):
            f = io.BytesIO(data)
            f.name = name
            return f
        for url in ("master/", "clean/", "stage2/"):
            for name, data in (("x.xlsx", b"not a zip"), ("../../evil.xlsx", b"PK\x03\x04"), ("x.xlsx", b""), ("shell.php", b"<?php ?>")):
                res = post(url, name, data)
                self.assertIn(res.status_code, (400, 422), (url, name, res.content[:200]))
        self.step()   # the client's own files are still there

    def _bomb(self, size):
        src = io.BytesIO()
        with zipfile.ZipFile(f"{self.tmp}/lnv.xlsx") as z, zipfile.ZipFile(src, "w", zipfile.ZIP_DEFLATED) as out:
            for i in z.infolist():
                data = z.read(i.filename)
                if i.filename == "xl/worksheets/sheet1.xml":
                    data = data.replace(b"</sheetData>", b"</sheetData>" + b" " * size)
                out.writestr(i.filename, data)
        src.name = "bomb.xlsx"
        src.seek(0)
        return src

    def test_a_zip_bomb_is_refused(self):
        from .engine import xlsx
        with override_settings():
            old = xlsx.MAX_UNZIPPED
            xlsx.MAX_UNZIPPED = 5_000_000
            try:
                for url in ("master/", "clean/"):
                    res = self.client.post(f"/api/clients/{self.cid}/{url}", {"file": self._bomb(20_000_000)})
                    self.assertEqual(res.status_code, 422, res.content[:200])
            finally:
                xlsx.MAX_UNZIPPED = old

    def test_entities_in_a_workbook_are_not_followed(self):
        src = io.BytesIO()
        with zipfile.ZipFile(f"{self.tmp}/lnv.xlsx") as z, zipfile.ZipFile(src, "w") as out:
            for i in z.infolist():
                data = z.read(i.filename)
                if i.filename == "xl/workbook.xml":
                    data = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd"><!ENTITY b "&a;">]>' + re.sub(rb"<\?xml[^>]*\?>", b"", data).replace(b'name="Sheet"', b'name="&a;"')
                out.writestr(i.filename, data)
        src.name = "xxe.xlsx"
        src.seek(0)
        res = self.client.post(f"/api/clients/{self.cid}/master/", {"file": src})
        self.assertEqual(res.status_code, 422)
        self.assertNotIn(b"root:", res.content)

    def test_odd_addresses_are_not_found_and_leak_nothing(self):
        for path in ("/%00", "/a%00b", "/" + "x" * 5000, "/..%2f..%2f.env", "/%2e%2e/%2e%2e/backend/mrm/settings.py", "/assets/../../../.env"):
            res = self.client.get(path)
            self.assertIn(res.status_code, (200, 404, 503), path)
            body = b"".join(res.streaming_content) if res.streaming else res.content
            self.assertNotIn(b"MRM_DATABASE_URL", body)
            self.assertNotIn(b"SECRET_KEY", body)

    def test_a_request_that_is_no_object_is_no_error(self):
        for body in ("[]", "null", "\"x\"", "1", "{", "\xff", "[" * 100000):
            for url in ("clean/decisions/", "changes/", "songs/", "lists/"):
                res = self.client.post(f"/api/clients/{self.cid}/{url}", body, content_type="application/json")
                self.assertLess(res.status_code, 500, (url, body[:20]))
        for body in ("[]", "null", '{"email": 1, "password": []}', '{"email": "a\\u0000", "password": "b"}'):
            self.assertEqual(Browser().post("/api/auth/login/", body, content_type="application/json").status_code, 400, body)

    def test_a_file_too_large_is_refused_before_it_is_read(self):
        with override_settings(MAX_REQUEST_BYTES=1000):
            self.assertEqual(self.upload("master/", "lnv.xlsx", 413).status_code, 413)
        self.step()

    def test_a_list_too_big_or_odd_is_refused(self):
        post = lambda b: self.client.post(f"/api/clients/{self.cid}/lists/", b, content_type="application/json").status_code
        self.assertEqual(post({"sheets": [{"name": "x", "header": ["a"] * 61, "rows": []}]}), 400)
        self.assertEqual(post({"sheets": [{"name": "x", "header": ["a"], "rows": "x"}]}), 400)
        self.assertEqual(post({"sheets": []}), 400)
        self.assertEqual(post({"sheets": [{"name": "x", "header": ["a"], "rows": [["\x00\x01ok"]]}]}), 200)

    def test_the_answers_of_one_client_stay_with_it(self):
        self.save({"key": "muso:2:Title", "choice": "set", "data": {"value": "Mine"}})
        other = self.client.post("/api/clients/", {"name": "Second"}, content_type="application/json").json()["id"]
        old, self.cid = self.cid, other
        self.upload("master/", "lnv.xlsx")
        self.upload("clean/", "muso.xlsx")
        self.assertNotIn("Mine", json.dumps(self.step()))
        # undoing with another client's change id does nothing to it
        ch = CleanChange.objects.filter(client_id=old).first()
        self.send("changes/", {"undo": [ch.id]}, 409)
        self.assertTrue(CleanDecision.objects.filter(client_id=old, key="muso:2:Title").exists())
        self.cid = old

    def test_the_answers_headers_are_safe(self):
        res = self.client.get(f"/api/clients/{self.cid}/steps/?step=1")
        self.assertEqual(res["X-Content-Type-Options"], "nosniff")
        self.assertEqual(res["X-Frame-Options"], "DENY")
        self.assertIn("same-origin", res["Referrer-Policy"])
        self.assertEqual(res["Content-Type"], "application/json")
        self.assertIn("default-src 'self'", res["Content-Security-Policy"])
        self.assertIn("frame-ancestors 'none'", res["Content-Security-Policy"])

    def test_the_admin_page_is_no_way_around_the_sign_in_lock(self):
        out = Browser()
        self.assertNotEqual(out.get("/admin/login/").status_code, 200)
        for _ in range(3):
            res = out.post("/admin/login/", {"username": "team@example.com", "password": "wrong"})
            self.assertIn(res.status_code, (302, 403, 404))
        # a member who is signed in is no admin either
        self.assertIn(self.client.get("/admin/").status_code, (302, 403, 404))
