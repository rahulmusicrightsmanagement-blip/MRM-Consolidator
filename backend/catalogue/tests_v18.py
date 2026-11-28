"""(v2.0.0 changed the sections: Original · Other version · Deleted, nothing put in one by itself – see tests_v20.)
v1.8.0 – matching rebuilt, the ISRC first: the main version's ISRC is an exact match (one row in the LNV, the other titles
its Alternative Work Name); three sections the reviewer checks or moves a match between (Exact match · Possible match ·
Other version); the singer shown, never deciding; stage names (PP) into the LNV as the IPI / CAE list's real names (PA)."""
import io
import tempfile

import openpyxl
from django.test import SimpleTestCase

from .engine import dataclean, export, review
from .engine.ipi import Index
from .tests_v17 import CLIENT, HEAD, LNV, MUSO, Base, lnv_file


class RuleTests(SimpleTestCase):
    def test_the_section_until_the_reviewer_moves_it(self):
        self.assertEqual(review.default_class(["INAA1"], ["INAA1"], False), "exact")
        self.assertEqual(review.default_class(["INAA1"], ["INAA1"], True), "exact")      # one ISRC: one recording
        self.assertEqual(review.default_class(["INAA2"], ["INAA1"], True), "version")
        self.assertIsNone(review.default_class([], ["INAA1"], False))   # v2.0: no suggestion – it waits in To check
        # v2.0: Original (exact) · Other version · Deleted – a v1.8 Possible match is an other version
        self.assertEqual(review.classes_of({"class:4": {"choice": "exact"}, "class:m7": {"choice": "version"}, "class:5": {"choice": "nonsense"},
                                            "class:6": {"choice": "possible"}, "class:8": {"choice": "deleted"}, "pick:4:Title": {"choice": "muso"}}),
                         {"class:4": "exact", "class:m7": "version", "class:6": "version", "class:8": "deleted"})
        self.assertEqual(review.class_at({"class:4": {"choice": "exact", "data": {"at": 5}}, "class:5": {"choice": "exact", "data": {"at": True}}}), {"class:4": 5})


# the same song entered again under the main version's ISRC as a "male version", and a row of another song sharing it
TWICE = LNV + [
    dict(title="Pyaar Ka Geet - Male Version", isrc="INAA19000001", film="Film A", year=1990, composer=CLIENT, author="Anand Bakshi", publisher="Saregama"),   # 10
    dict(title="Kuch Aur Hi", isrc="INAA19000001", film="Film Q", year=2001, composer=CLIENT, author="Sameer", publisher="Saregama"),                       # 11
]


class ExactOneRowTests(Base):
    lnv = TWICE

    def pyaar(self, step=None):
        return next(c for c in (step or self.step())["cases"] if c["title"] == "Pyaar Ka Geet" and c["kind"] not in ("twice", "names") and c["answer"].get("rows"))

    def test_the_isrc_decides_and_the_app_links_only_a_title_alike(self):
        c = self.pyaar()
        levels = {r["row"]: r["check"]["level"] for r in c["lnv"] if r.get("check")}
        self.assertEqual((levels[2], levels[10], levels[11]), ("exact", "exact", "exact"))   # a male version, another title: the same ISRC
        self.assertEqual(sorted(c["answer"]["rows"]), [2, 10])   # 'Kuch Aur Hi' only shares it: never linked by the app
        self.assertEqual(c["answer"]["by"], "app")

    def test_every_exact_row_checked_is_one_row_in_the_lnv(self):
        rows, _ = self.sheet()
        titles = [r["Work*"] for r in rows]
        # not checked yet: every row is still there
        self.assertIn("Pyaar Ka Geet - Male Version", titles)
        self.save({"key": "class:2", "choice": "exact"}, {"key": "class:10", "choice": "exact"})
        self.assertEqual(self.step()["classes"], {"class:2": "exact", "class:10": "exact"})
        rows, changes = self.sheet()
        titles = [r["Work*"] for r in rows]
        self.assertNotIn("Pyaar Ka Geet - Male Version", titles)            # merged into row 2
        self.assertIn("Kuch Aur Hi", titles)                                 # never linked: its own row
        keep = self.lnv_row("Pyaar Ka Geet", "Film A", rows)
        self.assertIn("Pyaar Ka Geet - Male Version", keep["Alternate Work"].split(" | "))
        self.assertEqual(keep["Row in the uploaded LNV"], 2)
        self.assertTrue(any("Original – one row" in c and "Row 10" in c for c in changes))
        self.assertEqual(sum(1 for r in rows if r["Row in the uploaded LNV"] == 2), 1)
        # moved to Other version: its row comes back – a row of its own after the possible matches, the main title beside it
        self.save({"key": "class:10", "choice": "version"})
        rows, _ = self.sheet()
        back = self.lnv_row("Pyaar Ka Geet - Male Version", rows=rows)
        self.assertEqual(back["Main version title"], "Pyaar Ka Geet")
        order = [r["Work*"] for r in rows]
        self.assertLess(order.index("Pyaar Ka Geet"), order.index("Pyaar Ka Geet - Male Version"))

    def test_a_section_is_checked_and_named_by_row_or_recording(self):
        self.save({"key": "class:abc", "choice": "exact"}, status=400)
        self.save({"key": "class:5", "choice": "somewhere"}, status=400)
        self.save({"key": "class:5", "choice": "possible"}, status=400)   # v2.0: no Possible match any more
        self.save({"key": "class:5", "choice": "exact", "data": {"at": "soon"}}, status=400)
        rid = self.pyaar()["muso"][0]["id"]
        self.save({"key": f"class:m{rid}", "choice": "version", "data": {"at": 7}}, {"key": "class:5", "choice": "deleted"})
        step = self.step()
        self.assertEqual((step["classes"], step["class_at"]), ({f"class:m{rid}": "version", "class:5": "deleted"}, {f"class:m{rid}": 7}))
        self.save({"key": "class:5", "choice": None})
        self.assertNotIn("class:5", self.step()["classes"])


class CheckedInTheLnvTests(Base):
    """Every song checked in step 2 is in the stage 1 LNV, with the section it was checked in ("Checked as")."""
    muso = MUSO + [dict(title="Saawan Ki Raat - Lofi", album="Lofi Nights", isrc="INAA19000044", lyricist="Javed Akhtar", date="2022-02-02")]

    def test_a_version_checked_is_in_the_lnv_while_its_song_is_not_answered(self):
        saawan = next(c for c in self.step()["cases"] if c["title"] == "Saawan Ki Raat" and c["kind"] not in ("twice", "names"))
        self.assertIsNone(saawan["answer"]["choice"])   # a possible match, not answered yet
        lofi = next(r for r in saawan["muso"] if r["fields"]["Title"] == "Saawan Ki Raat - Lofi")
        self.assertNotIn("Saawan Ki Raat - Lofi", [r["Work*"] for r in self.sheet()[0]])
        self.save({"key": f"class:m{lofi['id']}", "choice": "version"})
        rows, _ = self.sheet()
        r = self.lnv_row("Saawan Ki Raat - Lofi", rows=rows)
        self.assertEqual((r["Checked as"], r["Main version title"], r["Original Work"], r["ISRC"]), ("Other version", "Saawan Ki Raat", "Saawan Ki Raat", "INAA19000044"))
        # an LNV row checked (linked, in its section) says so; one not checked says nothing
        self.save({"key": f"link:{saawan['answer']['song']}", "choice": "same", "data": {"rows": [5]}}, {"key": "class:5", "choice": "version"})
        rows, _ = self.sheet()
        at = {r["Row in the uploaded LNV"]: r["Checked as"] for r in rows if r["Row in the uploaded LNV"]}
        self.assertEqual((at[5], at[6], at[2]), ("Other version", None, None))
        self.assertEqual(sum(1 for r in rows if r["Work*"] == "Saawan Ki Raat - Lofi"), 1)   # once, now its song is answered too


class CheckedOnlyDownloadTests(Base):
    """The stage 1 download holds the songs checked in step 2 only, numbered 1, 2, 3 … in its own order (SN); Every row
    gives the whole LNV, also numbered anew; the stage 2 LNV (Mark as completed) keeps every row."""
    muso = CheckedInTheLnvTests.muso

    def test_only_what_is_checked_numbered_anew(self):
        rows, changes = self.sheet(self.book("?stage=1"))
        self.assertEqual([(r["Work*"], r["Checked as"], r["Row in the uploaded LNV"]) for r in rows], [])   # nothing checked yet: no song in it
        saawan = next(c for c in self.step()["cases"] if c["title"] == "Saawan Ki Raat" and c["kind"] not in ("twice", "names"))
        lofi = next(r for r in saawan["muso"] if r["fields"]["Title"] == "Saawan Ki Raat - Lofi")
        self.save({"key": f"link:{saawan['answer']['song']}", "choice": "same", "data": {"rows": [5, 7]}}, {"key": "class:5", "choice": "version"},
                  {"key": "class:7", "choice": "version"}, {"key": f"class:m{lofi['id']}", "choice": "version"},
                  {"key": "class:9", "choice": "exact"})   # (row 9: linked by the app – put in Original)
        rows, changes = self.sheet(self.book("?stage=1"))
        self.assertEqual([(r["SN"], r["Work*"], r["Row in the uploaded LNV"], r["Checked as"]) for r in rows],
                         [(1, "Has A Date", 9, "Original"), (2, "Saawan Ki Raat", 5, "Other version"), (3, "Saawan Ki Raat", 7, "Other version"),
                          (4, "Saawan Ki Raat - Lofi", None, "Other version")])
        self.assertTrue(any("Checked songs only" in c for c in changes))
        # every row: the whole LNV, the serial numbers 1 … n in its order too
        rows, _ = self.sheet(self.book("?stage=1&rows=all"))
        self.assertEqual([r["SN"] for r in rows if r["Work*"]], list(range(1, len([r for r in rows if r["Work*"]]) + 1)))
        self.assertGreater(len(rows), 4)
        # the stage 2 LNV keeps every row
        done = self.send("stage1/", {"done": True})
        self.assertEqual(done["journey"]["lnv2"]["origin"], "stage1")
        res = self.client.get(f"/api/clients/{self.cid}/stage2/")
        self.assertEqual(len([r for r in openpyxl.load_workbook(io.BytesIO(res.content)).worksheets[0].iter_rows(min_row=2, values_only=True) if r[1]]),
                         len([r for r in rows if r["Work*"]]))


class OneRowTests(SimpleTestCase):
    def test_a_song_of_versions_only_linked_to_a_row_is_that_row_never_a_second_one(self):
        """The Muso recording beside an LNV row in Possible match (its title corrected on both, say): the LNV row is it –
        no row of its own besides, and the title chosen for it goes on that row."""
        part = {"lnv_row": None, "isrcs": ["INAA19000077"], "type": "Remix", "title": "Pyaar Ka Geet (Remix)", "album": "", "year": "", "sheet": [5]}
        song = {"key": "INAA19000077", "base": "Pyaar Ka Geet", "title": "Pyaar Ka Geet (Remix)", "lyricists": [], "composers": [], "original": None, "parts": [part]}
        result = {"matched": [{"song": song, "links": [{"row": 2}]}], "check": [], "missing": []}
        lnv = [{"row": 2, "title": "Pyaar Ka Geet - Remix", "movie": "Film A"}]
        self.assertEqual(dataclean.lnv_versions(result, lnv)["rows"], [])
        picks, _, _ = dataclean.apply_titles(result, {"rows": [], "named": []}, [], {5: {"mode": "custom", "value": "Pyaar Ka Geet Remix Edited"}})
        self.assertEqual([(p["row"], p["value"]) for p in picks], [(2, "Pyaar Ka Geet Remix Edited")])
        self.assertEqual(dataclean.alternative_names(result, {5: {"mode": "custom", "value": "Pyaar Ka Geet Remix Edited"}}, lnv),
                         {2: ["Pyaar Ka Geet - Remix"]})   # (the Muso title is the same name, written otherwise)


class StageNameTests(SimpleTestCase):
    """Muso and the LNV write stage names (PP): the LNV gets the member's real name (PA) – a value picked from Muso, or typed."""

    def test_a_name_picked_goes_in_as_the_list_has_it(self):
        index = Index([
            {"member": "I-1", "member_name": "Ram Krishna", "name": "KRISHNA,RAM", "type": "PA", "ipi": "00111111111", "role": "C", "internal_no": "", "sr": 1},
            {"member": "I-1", "member_name": "Ram Krishna", "name": "RK", "type": "PP", "ipi": "00111111112", "role": "C", "internal_no": "", "sr": 1},
        ])
        with tempfile.TemporaryDirectory() as tmp:
            lnv_file(f"{tmp}/lnv.xlsx", LNV, HEAD)
            out = export.final_report(f"{tmp}/lnv.xlsx", dsp={"fills": [], "adds": [], "repeats": [], "source": "Muso", "ipi": index,
                                                             "picks": [{"row": 2, "field": "Singer", "value": ["RK"], "choice": "muso"},
                                                                       {"row": 3, "field": "Composer", "value": ["RK", "Somebody"], "choice": "custom"}]})
        ws = openpyxl.load_workbook(io.BytesIO(out)).worksheets[0]
        head = [c.value for c in ws[1]]
        at = lambda r, h: ws.cell(r, head.index(h) + 1).value
        self.assertEqual((at(2, "Singer Name 1"), at(2, "Artist CAE 4")), ("Ram Krishna", 111111111))
        self.assertEqual(at(3, "Composer Name 1"), "Ram Krishna")
        self.assertNotIn("RK", [c.value for r in ws.iter_rows() for c in r])
