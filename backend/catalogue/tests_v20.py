"""v2.0.0 – the song screen's sections: every match starts in To check; the reviewer puts it in Original (the first one put
there is the song's ONE row in the LNV, the titles of the ones after it its Alternative Work Name), Other version (a row
of its own) or Deleted (out of the LNV). Nothing goes into a section by itself. A song checked through is saved to the
LNV after its preview: completed."""
from .tests_v17 import Base
from .tests_v18 import TWICE, CheckedInTheLnvTests


class OriginalTests(Base):
    lnv = TWICE

    def pyaar(self):
        return next(c for c in self.step()["cases"] if c["title"] == "Pyaar Ka Geet" and c["kind"] not in ("twice", "names") and c["answer"].get("rows"))

    def test_nothing_is_in_original_by_itself(self):
        rows, _ = self.sheet()
        at = {r["Row in the uploaded LNV"]: r["Checked as"] for r in rows if r["Row in the uploaded LNV"]}
        self.assertEqual((at[2], at[10]), (None, None))   # the same ISRC, linked by the app – still to check
        self.assertIn("Pyaar Ka Geet - Male Version", [r["Work*"] for r in rows])

    def test_the_first_put_in_original_is_the_row(self):
        # row 10 first, then row 2: row 10 is the song's row, row 2 merged into it – its title the alternative work name
        self.save({"key": "class:10", "choice": "exact", "data": {"at": 1000}}, {"key": "class:2", "choice": "exact", "data": {"at": 2000}})
        rows, changes = self.sheet()
        self.assertEqual(sum(1 for r in rows if r["Row in the uploaded LNV"] in (2, 10)), 1)
        keep = next(r for r in rows if r["Row in the uploaded LNV"] == 10)
        self.assertEqual(keep["Checked as"], "Original – one row")
        self.assertIn("Pyaar Ka Geet", keep["Alternate Work"].split(" | "))
        self.assertTrue(any("Row 2" in c and "merged into this row" in c for c in changes))
        # the other way round: row 2 the song's row
        self.save({"key": "class:2", "choice": "exact", "data": {"at": 500}})
        rows, _ = self.sheet()
        self.assertEqual([r["Row in the uploaded LNV"] for r in rows if r["Row in the uploaded LNV"] in (2, 10)], [2])

    def test_deleted_leaves_the_lnv(self):
        c = self.pyaar()
        self.save({"key": f"link:{c['answer']['song']}", "choice": "same", "data": {"rows": [2, 10, 11]}},
                  {"key": "class:2", "choice": "exact"}, {"key": "class:11", "choice": "deleted"})
        rows, changes = self.sheet()
        self.assertNotIn("Kuch Aur Hi", [r["Work*"] for r in rows])
        self.assertTrue(any("Deleted" in c and "Kuch Aur Hi" in c for c in changes))
        self.assertIn("Pyaar Ka Geet - Male Version", [r["Work*"] for r in rows])   # not checked: stays as it is
        # put back (to check): in the file again
        self.save({"key": "class:11", "choice": None})
        self.assertIn("Kuch Aur Hi", [r["Work*"] for r in self.sheet()[0]])

    def test_a_song_is_completed_after_its_preview(self):
        self.save({"key": "complete:pyaar ka geet", "choice": "yes"})
        self.assertEqual(self.step()["completed"], ["pyaar ka geet"])
        self.save({"key": "complete:pyaar ka geet", "choice": "done"}, status=400)
        self.save({"key": "complete:pyaar ka geet", "choice": None})
        self.assertEqual(self.step()["completed"], [])


class VersionsOnlyOriginalTests(Base):
    """Original holds Muso recordings beside no LNV row only: the first one put there is a new row, the others' titles
    its alternative work name – one row, never two; a deleted one gets no row."""
    muso = CheckedInTheLnvTests.muso + [dict(title="Saawan Ki Raat - Reprise", album="Lofi Nights", isrc="INAA19000045", lyricist="Javed Akhtar", date="2022-03-03"),
                                        dict(title="Saawan Ki Raat - Slowed", album="Lofi Nights", isrc="INAA19000046", lyricist="Javed Akhtar", date="2022-04-04")]

    def test_recordings_only(self):
        saawan = next(c for c in self.step()["cases"] if c["title"] == "Saawan Ki Raat" and c["kind"] not in ("twice", "names"))
        rid = {r["fields"]["Title"]: r["id"] for r in saawan["muso"]}
        self.save({"key": f"class:m{rid['Saawan Ki Raat - Reprise']}", "choice": "exact", "data": {"at": 1}},
                  {"key": f"class:m{rid['Saawan Ki Raat - Lofi']}", "choice": "exact", "data": {"at": 2}},
                  {"key": f"class:m{rid['Saawan Ki Raat - Slowed']}", "choice": "deleted"})
        titles = [r["Work*"] for r in self.sheet()[0]]
        self.assertIn("Saawan Ki Raat - Reprise", titles)
        self.assertNotIn("Saawan Ki Raat - Lofi", titles)
        self.assertNotIn("Saawan Ki Raat - Slowed", titles)
        lead = self.lnv_row("Saawan Ki Raat - Reprise")
        self.assertEqual(lead["Alternate Work"], "Saawan Ki Raat - Lofi")
        self.assertIn("INAA19000044", lead["ISRC"])

