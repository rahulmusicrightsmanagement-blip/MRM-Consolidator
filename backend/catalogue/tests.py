"""Checks against the real Dhanya Suresh sample files in the project root."""
import io
import os
import shutil
import tempfile
from pathlib import Path

import openpyxl
from unittest import skipUnless

from django.test import TestCase, override_settings

from .engine.iprs import IPRSFormatError, parse_iprs
from .engine.normalize import alternate_titles, norm_ipi, norm_isrc, norm_iswc, same_party
from .engine.pipeline import run_pipeline
from .models import Client, Work

SAMPLES = Path(__file__).resolve().parents[2]
IPRS = SAMPLES / "DHANYA SURESH_WORKLISTING.xlsx"
MASTER = SAMPLES / "Dhanya Suresh Menon LNV Report.xlsx"
PRS = SAMPLES / "my_works_Dhanya_Suresh.csv"
# The sample spreadsheets are kept out of git; tests that need them skip when they are missing.
needs_samples = skipUnless(IPRS.exists() and MASTER.exists() and PRS.exists(), "sample files not in project root")


class NormalizeTests(TestCase):
    def test_identifiers(self):
        self.assertEqual(norm_iswc("T-332.565.700-5"), "T3325657005")
        self.assertEqual(norm_isrc("In-T20-24-04686"), "INT202404686")
        self.assertEqual(norm_ipi("1076531558"), "01076531558")
        self.assertEqual(norm_iswc("In-H10-24-07886"), "")

    def test_alternate_titles(self):
        self.assertEqual(alternate_titles("Navarasam By Vipin Lal; Nava"), ("Navarasam By Vipin Lal", "Navarasam", "Nava"))
        self.assertEqual(alternate_titles(""), ())

    def test_role_code_beats_column(self):
        from .engine.mapping import master_people
        song = {"authors": [{"name": "S Rafeeq Ahmed", "role": "C"}], "composers": [{"name": "Vidya Sagar", "role": "C"}],
                "publishers": []}
        self.assertEqual([p["name"] for p in master_people(song, "composers")], ["S Rafeeq Ahmed", "Vidya Sagar"])
        self.assertEqual(master_people(song, "authors"), [])

    def test_names(self):
        self.assertTrue(same_party("SURESH, DHANYA", "Dhanya Suresh Menon"))
        self.assertTrue(same_party("PEETHAMBARAN, PARIYADATH", "PARIYADATH, PEETHAMBARAN"))
        self.assertTrue(same_party("P, RAJAT", "Rajat Prakash"))
        self.assertFalse(same_party("NELSON, ASHOK BETTY", "ANISH, T N"))
        # One initial cannot stand for two words, and at least one full word must agree.
        self.assertFalse(same_party("Sushin Shyamprakash", "S RAFEEQ AHMED"))
        self.assertTrue(same_party("AHMED, S RAFEEQ", "S Rafeeq Ahmed"))


@needs_samples
class PipelineTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.result = run_pipeline(IPRS, MASTER, PRS)

    def test_step1_reads_every_work(self):
        iprs = self.result["iprs"]
        self.assertEqual(iprs["stats"]["works"], 67)
        self.assertEqual(iprs["stats"]["contributor_rows"], 389)
        self.assertEqual(iprs["stats"]["rows_per_work"], {3: 49, 4: 1, 14: 17})
        self.assertTrue(all(c["passed"] for c in iprs["checks"]))
        codes = [i["code"] for i in iprs["issues"]]
        self.assertEqual(codes.count("SHARE_TOTAL"), 1)          # Saraname sync = 50%
        self.assertEqual(codes.count("NAME_WRAPPED"), 2)         # SUPER CASSETTES / INDUSTRIES LTD

    def test_step1_joins_wrapped_publisher(self):
        work = next(w for w in self.result["iprs"]["works"] if w["internal_no"] == "21639905")
        self.assertEqual(work["publishers"][0]["name"], "SUPER CASSETTES INDUSTRIES LTD")

    def test_step2_composer_author_in_both(self):
        work = next(w for w in self.result["iprs"]["works"] if w["internal_no"] == "21313595")
        self.assertIn("SUNIL, VARUN", [c["name"] for c in work["authors"]])
        self.assertIn("SUNIL, VARUN", [c["name"] for c in work["composers"]])

    def test_match_scores(self):
        links = {l["internal_no"]: l for l in self.result["mapping"]["links"]}
        self.assertEqual(links["21313595"]["match"]["score"], 10.0)          # AAL AYAAL: tunecode + ISWC + ISRC + title
        self.assertLess(links["32133881"]["match"]["score"], 7)              # Poochi: ISWC + title + writers only
        self.assertTrue(all(0 <= l["match"]["score"] <= 10 for l in links.values() if l.get("match")))

    def test_step3_mapping(self):
        s = self.result["mapping"]["summary"]
        self.assertEqual(s["linked"] + s["review"] + s["iprs_only"], 67)
        self.assertEqual(s["iprs_only"], 9)
        self.assertEqual(s["master_only"], 15)
        links = {l["internal_no"]: l for l in self.result["mapping"]["links"]}
        self.assertEqual(links["21185358"]["state"], "linked")    # IPRS tunecode beats the ISWC on the wrong row
        self.assertEqual(links["32133881"]["method"], "ISWC")     # Poochi: no tunecode in master

    def test_step4_final_report(self):
        final = self.result["final"]["summary"]
        self.assertEqual(final["final_total"], 76)
        self.assertEqual(final["added"], 9)

    def test_step5_statuses(self):
        rows = {r["title"]: r["societies"] for r in self.result["tunecodes"]["rows"]}
        self.assertEqual(rows["Shiv Taandav"]["IPRS"]["status"], "Registration")
        self.assertEqual(rows["THEEVANDI"]["PRS"]["status"], "Amend")       # client not credited at PRS
        self.assertEqual(rows["KANDU NEE ENNE"]["PRS"]["status"], "Match")
        self.assertEqual(rows["NJANAA"]["PRS"]["status"], "Registration")
        self.assertEqual(rows["Navarasam"]["IPRS"]["status"], "Amend")       # publisher differs

    def test_rejects_wrong_format(self):
        with tempfile.NamedTemporaryFile(suffix=".xlsx") as tmp:
            wb = openpyxl.Workbook()
            wb.active.append(["TITLE", "SOMETHING"])
            wb.save(tmp.name)
            with self.assertRaises(IPRSFormatError):
                parse_iprs(tmp.name)


@needs_samples
@override_settings(MEDIA_ROOT=tempfile.mkdtemp())
class Step3CountTests(TestCase):
    def test_header_counts_come_from_the_fill_plan(self):
        from catalogue.engine.steps import step3
        result = {"iprs": {"works": []}, "final": {"rows": []}, "mapping": {"links": []}, "tunecodes": {"rows": []}}
        counts = step3({"songs": []}, result, {}, set(), fill={"amend": 7, "not_registered": 3, "pending": 2})["counts"]
        self.assertEqual((counts["on_screen_amend"], counts["on_screen_register"], counts["waiting"]), (7, 3, 2))


class ToDecideTests(TestCase):
    def test_counts_what_the_to_decide_tab_shows(self):
        from catalogue.engine.steps import to_decide
        link = lambda state, method="", reason="": {"state": state, "method": method, "reason": reason}
        self.assertEqual(to_decide([link("review"), link("linked", "Title + contributors"), link("linked", "ISWC", "Differs"),
                                    link("linked", "ISWC"), link("linked", "Confirmed by reviewer", "Differs"), link("new")]), 3)


@needs_samples
class ApiTests(TestCase):
    """The step-wise flow: add client → master → one society workspace at a time."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from django.core.cache import cache
        cache.clear()  # database ids restart between tests; cached results must not
        self.client.force_login(get_user_model().objects.create_user("team@example.com", "team@example.com", "x"))

    def tearDown(self):
        from django.conf import settings
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)

    def _post_file(self, url, path):
        with open(path, "rb") as fh:
            return self.client.post(url, {"file": fh})

    def _client(self, societies=("IPRS", "PRS")):
        c = self.client.post("/api/clients/", {"name": "Dhanya Suresh", "ipi": "1076531558", "owner": "Rahul"},
                             content_type="application/json").json()
        self.assertEqual(c["ipi"], "01076531558")
        res = self._post_file(f"/api/clients/{c['id']}/master/", MASTER)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["master"]["stats"]["songs"], 67)
        self.client.post(f"/api/clients/{c['id']}/societies/", {"societies": list(societies)}, content_type="application/json")
        return c["id"]

    def _society_report(self, cid, society, path, report_date=None):
        run = self.client.post(f"/api/clients/{cid}/societies/{society}/", {"report_date": report_date}, content_type="application/json").json()
        res = self._post_file(f"/api/runs/{run['id']}/files/auto/", path)
        self.assertEqual(res.status_code, 200, res.content[:300])
        return run["id"], res.json()

    def test_stepwise_flow(self):
        cid = self._client()
        detail = self.client.get(f"/api/clients/{cid}/").json()
        self.assertEqual(detail["stage"]["label"], "Master loaded")
        self.assertEqual([s["status"] for s in detail["societies"]], ["not_started", "not_started"])

        # IPRS workspace: only IPRS is checked.
        iprs_run, res = self._society_report(cid, "IPRS", IPRS)
        self.assertEqual(list(res["result"]["tunecodes"]["summary"]), ["IPRS", "master_updates"])
        detail = self.client.get(f"/api/clients/{cid}/").json()
        self.assertEqual(detail["works"], 76)
        self.assertEqual(detail["coverage"]["IPRS"]["registered"], 61)
        self.assertNotIn("PRS", detail["coverage"])
        self.assertEqual(detail["tasks"]["by_type"]["IPRS|register"]["open"], 15)

        # Steps are confirmed one by one, then the society is marked complete.
        self.client.patch(f"/api/runs/{iprs_run}/", {"confirmed_step": 3, "completed": True}, content_type="application/json")
        detail = self.client.get(f"/api/clients/{cid}/").json()
        self.assertEqual(detail["societies"][0]["status"], "completed")
        self.assertEqual(detail["stage"]["label"], "Societies in progress")

        # PRS workspace: compared with the catalogue as IPRS completed it; IPRS tasks untouched.
        prs_run, res = self._society_report(cid, "PRS", PRS)
        self.assertEqual(res["result"]["tunecodes"]["summary"]["PRS"], {"Match": 52, "Amend": 22, "Registration": 2})
        detail = self.client.get(f"/api/clients/{cid}/").json()
        self.assertEqual(detail["works"], 76)                                   # same works, no duplicates
        self.assertIn("PRS", detail["coverage"])
        self.assertEqual(detail["tasks"]["by_type"]["IPRS|register"]["open"], 15)
        self.assertGreater(detail["tasks"]["by_type"]["PRS|add_client_credit"]["open"], 0)
        self.client.patch(f"/api/runs/{prs_run}/", {"completed": True}, content_type="application/json")
        self.assertEqual(self.client.get(f"/api/clients/{cid}/").json()["stage"]["label"], "All societies complete")

        tracker = self.client.get("/api/clients/").json()["clients"][0]
        self.assertEqual([s["code"] for s in tracker["societies"]], ["IPRS", "PRS"])
        for name in ("tasks", "catalogue"):
            self.assertEqual(self.client.get(f"/api/clients/{cid}/export/{name}/").status_code, 200)
        for name in ("step1", "step2", "step3", "step5", "all", "final"):
            self.assertEqual(self.client.get(f"/api/runs/{iprs_run}/export/{name}/").status_code, 200, name)

    def test_pair_shows_every_column_of_both_files(self):
        cid = self._client(("IPRS",))
        run_id, res = self._society_report(cid, "IPRS", IPRS)
        link = next(l for l in res["result"]["mapping"]["links"] if l["internal_no"] == "21313595")
        pair = self.client.get(f"/api/runs/{run_id}/pair/", {"work": "21313595", "row": link["master_row"]}).json()
        work, blocks, rest = pair["sections"]
        rows = {r["label"]: r for r in work["rows"]}
        self.assertEqual((rows["Title"]["iprs_col"], rows["Title"]["master_col"], rows["Title"]["status"]),
                         ("D · TITLE", "B · Work*", "same"))
        self.assertEqual(rows["Language"]["status"], "different")              # HINDI vs Malayalam
        self.assertEqual(rows["ISWC"]["status"], "same")                       # found in the IPRS block, not column D
        self.assertEqual({r["label"]: r["status"] for r in blocks["rows"]}["IPRS block 1 · Tune code"], "same")
        self.assertIn("PRS TUNECODE 1", [r["label"] for r in rest["rows"]])
        self.assertEqual([p["master"]["slot"] for p in pair["people"]], ["Author 1", "Composer 1", "Publisher 1"])
        self.assertEqual(len(pair["iprs_raw"]["rows"]), 3)
        self.assertEqual(len(pair["master_raw"]["columns"]), res["result"]["master"]["stats"]["columns"])
        # Every filled master cell appears once in the side-by-side view.
        shown = {r["master_col"].split(" · ")[0] for s in pair["sections"] for r in s["rows"] if r["master"]}
        shown |= {p["master"]["col"] for p in pair["people"]}
        self.assertLessEqual(len(shown), pair["master_filled"])
        # A song only one file has.
        only = next(l for l in res["result"]["mapping"]["links"] if not l["master_row"])
        self.assertEqual(self.client.get(f"/api/runs/{run_id}/pair/", {"work": only["internal_no"]}).status_code, 200)
        self.assertEqual(self.client.get(f"/api/runs/{run_id}/pair/", {"work": "nope"}).status_code, 404)

    def test_master_edits_go_into_the_updated_master(self):
        cid = self._client(("IPRS",))
        run_id, res = self._society_report(cid, "IPRS", IPRS)
        links = [l for l in res["result"]["mapping"]["links"] if l.get("comparison")]
        missing = next((l, f) for l in links for f in l["comparison"]["fields"] if f["result"] == "missing_master" and f["field"] == "Publishers")
        differ = next((l, f) for l in links for f in l["comparison"]["fields"] if f["result"] == "different" and f["field"] == "Title")
        edits = [{"master_row": l["master_row"], "field": f["field"], "internal_no": l["internal_no"], "choice": "iprs"} for l, f in (missing, differ)]
        res = self.client.post(f"/api/runs/{run_id}/master-edits/", {"edits": edits}, content_type="application/json")
        self.assertEqual(len(res.json()["master_edits"]), 2)
        ws = openpyxl.load_workbook(io.BytesIO(self.client.get(f"/api/runs/{run_id}/export/final/").content)).worksheets[0]
        header = [c.value for c in ws[1]]
        col = {h.strip().upper().rstrip("*"): i + 1 for i, h in reversed(list(enumerate(header))) if isinstance(h, str)}
        self.assertEqual(ws.cell(missing[0]["master_row"], col["PUBLISHER NAME 1"]).value, missing[1]["iprs"].split(" (")[0])
        self.assertEqual(ws.cell(differ[0]["master_row"], col["WORK"]).value, differ[1]["iprs"])
        # Keeping our master's value changes nothing; clearing removes the choice.
        edits[1]["choice"] = "master"
        self.client.post(f"/api/runs/{run_id}/master-edits/", {"edits": edits}, content_type="application/json")
        ws = openpyxl.load_workbook(io.BytesIO(self.client.get(f"/api/runs/{run_id}/export/final/").content)).worksheets[0]
        self.assertEqual(ws.cell(differ[0]["master_row"], col["WORK"]).value.strip(), differ[1]["master"])
        res = self.client.post(f"/api/runs/{run_id}/master-edits/", {"edits": [{**e, "choice": None} for e in edits]}, content_type="application/json")
        self.assertEqual(res.json()["master_edits"], [])

    def test_batch_decisions_and_alternate_title(self):
        cid = self._client(("IPRS",))
        run_id, res = self._society_report(cid, "IPRS", IPRS)
        withc = [l for l in res["result"]["mapping"]["links"] if l["candidates"]]
        res_works = res["result"]["iprs"]["works"]
        new, link = withc[0], withc[1]
        items = [{"internal_no": new["internal_no"], "action": "new", "rejected_rows": [c["row"] for c in new["candidates"]]},
                 {"internal_no": link["internal_no"], "master_row": link["candidates"][0]["row"]}]
        res = self.client.post(f"/api/runs/{run_id}/decisions/", {"items": items}, content_type="application/json").json()
        by_no = {l["internal_no"]: l for l in res["result"]["mapping"]["links"]}
        self.assertEqual(by_no[new["internal_no"]]["state"], "unmatched")       # added to the final report as a new song
        self.assertEqual(by_no[link["internal_no"]]["method"], "Confirmed by reviewer")
        # The IPRS title goes into the master's "Alternate Work" column of the linked song.
        row = link["candidates"][0]["row"]
        edit = {"master_row": row, "field": "Alternate title", "internal_no": link["internal_no"], "choice": "iprs"}
        self.client.post(f"/api/runs/{run_id}/master-edits/", {"edits": [edit]}, content_type="application/json")
        ws = openpyxl.load_workbook(io.BytesIO(self.client.get(f"/api/runs/{run_id}/export/final/").content)).worksheets[0]
        col = next(i + 1 for i, c in enumerate(ws[1]) if isinstance(c.value, str) and c.value.strip().upper() == "ALTERNATE WORK")
        self.assertIn(link["title"], ws.cell(row, col).value)
        v = self.client.get(f"/api/runs/{run_id}/verify/").json()
        self.assertFalse([c for c in v["checks"] if c["id"] == "lineage" and c["status"] == "fail"], "alternate title is explained")
        # Film / album and singers can be taken from IPRS too; the verifier explains those cells.
        work = next(w for w in res_works if w["internal_no"] == link["internal_no"])
        edits = [{"master_row": row, "field": f, "internal_no": link["internal_no"], "choice": "iprs"} for f in ("Film / album", "Singers")]
        self.client.post(f"/api/runs/{run_id}/master-edits/", {"edits": edits}, content_type="application/json")
        ws = openpyxl.load_workbook(io.BytesIO(self.client.get(f"/api/runs/{run_id}/export/final/").content)).worksheets[0]
        movie = next(i + 1 for i, c in enumerate(ws[1]) if isinstance(c.value, str) and c.value.strip().upper().startswith("MOVIE NAME"))
        if work["production"]:
            self.assertEqual(ws.cell(row, movie).value, work["production"])
        v = self.client.get(f"/api/runs/{run_id}/verify/").json()
        self.assertFalse([c for c in v["checks"] if c["id"] == "lineage" and c["status"] == "fail"], "film / singers are explained")
        # One IPRS work can be several master rows (a version of the same song): every ticked row gets the work.
        other = next(s["row"] for s in res["result"]["master"]["songs"] if s["row"] != row)
        items = [{"internal_no": link["internal_no"], "master_row": row, "also_rows": [other]}]
        res = self.client.post(f"/api/runs/{run_id}/decisions/", {"items": items}, content_type="application/json").json()
        finals = {f["master_row"]: f for f in res["result"]["final"]["rows"] if f["master_row"]}
        self.assertIn(link["internal_no"], finals[row]["iprs_works"])
        self.assertIn(link["internal_no"], finals[other]["iprs_works"])
        self.assertNotIn(other, [m["row"] for m in res["result"]["mapping"]["master_only"]])

    def test_updated_master_never_changes_a_filled_cell(self):
        """Every non-empty cell of the uploaded master reads the same in the updated master – new data only
        goes into empty blocks (e.g. the 'Not our work' rows keep their block 1 and get nothing new)."""
        cid = self._client(("IPRS",))
        run_id, res = self._society_report(cid, "IPRS", IPRS)
        before = openpyxl.load_workbook(MASTER).worksheets[0]
        after = openpyxl.load_workbook(io.BytesIO(self.client.get(f"/api/runs/{run_id}/export/final/").content)).worksheets[0]
        text = lambda v: "" if v is None else str(v).strip()
        changed = [(r, c) for r in range(1, before.max_row + 1) for c in range(1, before.max_column + 1)
                   if text(before.cell(r, c).value) and text(after.cell(r, c).value) != text(before.cell(r, c).value)]
        self.assertEqual(changed, [])
        marked = [f for f in res["result"]["fill"]["rows"] if f["marked_in_master"]]
        self.assertTrue(marked)
        self.assertTrue(all(b["round"] == "kept" for f in marked for b in f["blocks"]))

    def test_earlier_amendment_is_kept_and_new_findings_go_to_the_next_block(self):
        """A block that already records an amendment stays as it is; something new opens the next free block."""
        wb = openpyxl.load_workbook(MASTER)
        ws = wb.worksheets[0]
        head = [c.value.strip().upper() if isinstance(c.value, str) else "" for c in ws[1]]
        code1 = head.index("IPRS TUNECODE 1") + 1
        status = next(i for i in range(code1, len(head)) if head[i] == "CLIENT STATUS") + 1
        purpose = next(i for i in range(code1, len(head)) if head[i] == "PURPOSE OF AMENDMENT") + 1
        code2 = head.index("IPRS TUNECODE 2") + 1
        row = next(r for r in range(2, ws.max_row + 1) if ws.cell(r, code1).value and not ws.cell(r, code2).value)
        code = str(ws.cell(row, code1).value).split(".")[0]
        ws.cell(row, status).value, ws.cell(row, status + 1).value = "Uploaded", "Amend"
        ws.cell(row, purpose).value = "An amendment sent last year"
        with tempfile.NamedTemporaryFile(suffix=".xlsx") as tmp:
            wb.save(tmp.name)
            cid = self.client.post("/api/clients/", {"name": "Dhanya Suresh", "ipi": "1076531558"}, content_type="application/json").json()["id"]
            self.assertEqual(self._post_file(f"/api/clients/{cid}/master/", tmp.name).status_code, 200)
        self.client.post(f"/api/clients/{cid}/societies/", {"societies": ["IPRS"]}, content_type="application/json")
        run_id, res = self._society_report(cid, "IPRS", IPRS)
        blocks = next(f for f in res["result"]["fill"]["rows"] if f["master_row"] == row)["blocks"]
        self.assertEqual([(b["slot"], b["round"]) for b in blocks if b["internal_no"] == code], [(1, "kept"), (2, "new")])
        out = openpyxl.load_workbook(io.BytesIO(self.client.get(f"/api/runs/{run_id}/export/final/").content)).worksheets[0]
        self.assertEqual(out.cell(row, purpose).value, "An amendment sent last year")      # the earlier round, untouched
        self.assertEqual(str(out.cell(row, code2).value), code)                             # the new round, next block
        v = self.client.get(f"/api/runs/{run_id}/verify/").json()
        self.assertFalse([c for c in v["checks"] if c["id"] in ("once", "status") and c["status"] == "fail"])

    def test_fill_iprs_columns_into_an_empty_master(self):
        """A master with every society column empty gets its IPRS blocks rebuilt from the IPRS report –
        the same tune codes in the same rows as the hand-filled master."""
        wb = openpyxl.load_workbook(MASTER)
        ws = wb.worksheets[0]
        blocks = [i for i, h in enumerate(c.value for c in ws[1]) if isinstance(h, str) and h.strip().startswith("IPRS TUNECODE")]
        truth = {}
        for r in range(2, ws.max_row + 1):
            truth[r] = {str(ws.cell(r, b + 1).value).strip() for b in blocks if ws.cell(r, b + 1).value}
            for col in range(blocks[0] - 1, ws.max_column + 1):  # from "ISRC 1" onwards
                ws.cell(r, col).value = None
        with tempfile.NamedTemporaryFile(suffix=".xlsx") as tmp:
            wb.save(tmp.name)
            c = self.client.post("/api/clients/", {"name": "Dhanya Suresh", "ipi": "1076531558"}, content_type="application/json").json()
            cid = c["id"]
            self.assertEqual(self._post_file(f"/api/clients/{cid}/master/", tmp.name).status_code, 200)
        self.client.post(f"/api/clients/{cid}/societies/", {"societies": ["IPRS"]}, content_type="application/json")
        run_id, res = self._society_report(cid, "IPRS", IPRS)
        self.assertEqual(res["run"]["steps"], ["Upload file & check headers", "Match & review", "Reports"])
        links = res["result"]["mapping"]["links"]
        self.assertEqual(sum(1 for l in links if l["method"] == "Title + writers"), 37)
        # "Confirm all": every waiting work takes its top suggestion.
        items = [{"internal_no": l["internal_no"], "master_row": l["candidates"][0]["row"]} for l in links if l["state"] == "review"]
        self.assertEqual(len(items), 21)
        res = self.client.post(f"/api/runs/{run_id}/decisions/", {"items": items}, content_type="application/json").json()
        fill = {f["key"]: f for f in res["result"]["fill"]["rows"]}
        self.assertEqual([b["internal_no"] for b in fill["M3"]["blocks"]], ["21185348", "21338657"])   # Urumbu: blocks 1 and 2
        self.assertEqual(len(fill["M5"]["blocks"]), 3)                                                 # Chathe + live version
        self.assertEqual(fill["M10"]["state"], "not_registered")                                       # Shiv Taandav
        self.assertEqual(res["result"]["fill"]["summary"]["pending"], 0)
        # "Not our work" for a song, then the download.
        res = self.client.post(f"/api/runs/{run_id}/song-flags/", {"keys": ["M36"], "on": True}, content_type="application/json").json()
        self.assertEqual(next(f for f in res["result"]["fill"]["rows"] if f["key"] == "M36")["blocks"][0]["client_status"], "Not our work")
        out = openpyxl.load_workbook(io.BytesIO(self.client.get(f"/api/runs/{run_id}/export/final/").content)).worksheets[0]
        extra = set()
        for r, codes in truth.items():
            got = {str(out.cell(r, b + 1).value) for b in blocks if out.cell(r, b + 1).value}
            self.assertLessEqual(codes, got, f"row {r}")
            if got - codes:
                self.assertFalse(codes, f"row {r}")  # only gaps in the hand-filled master get extra codes
                extra.add(r)
        # Poochi, Kanthurannu, Kannil Kannil, Manassil njanano, Kalyanamane, Pushpaka: registered at IPRS but
        # left empty in the hand-filled master.
        self.assertEqual(extra, {11, 12, 18, 19, 28, 31})
        status = blocks[0] + 6  # 1-based column of "Client status" in IPRS block 1
        self.assertEqual(out.cell(36, status).value, "Not our work")
        self.assertEqual(out.cell(10, status).value, "Not registered")
        self.assertIn(out.cell(2, status).value, ("Uploaded", "Amend"))
        self.assertEqual(out.max_row, 68 + 9)                                                          # 9 songs added, no duplicates

        # The verifier reads the produced files back: a correct run has no failures …
        v = self.client.get(f"/api/runs/{run_id}/verify/").json()
        self.assertEqual(v["summary"]["fail"], 0, [c for c in v["checks"] if c["status"] == "fail"])
        self.assertEqual(v["summary"]["cells_unexplained"], 0)
        self.assertEqual(len(v["preview"]["rows"]), 67 + 9)
        # … and a tampered file is caught: a title edited by hand and one tune code copied into a second row.
        from .engine import export
        from .engine.verify import verify
        from .views import _inputs, _master_edits, compute, fill_plan
        from .models import Run
        run = Run.objects.get(pk=run_id)
        result = compute(run)
        master = _inputs(run)["master"].file.path
        fill = fill_plan(run, result)
        book = openpyxl.load_workbook(io.BytesIO(export.final_report(master, result["iprs"], result["final"], [], fill)))
        sheet = book.worksheets[0]
        sheet.cell(2, 2).value = "Navarasam (typo)"
        sheet.cell(4, blocks[0] + 1).value = sheet.cell(3, blocks[0] + 1).value
        buf = io.BytesIO()
        book.save(buf)
        bad = verify(master, buf.getvalue(), result["iprs"], result["mapping"], result["final"], fill, result["tunecodes"], [], result["iprs"]["client"])
        failed = {c["id"] for c in bad["checks"] if c["status"] == "fail"}
        self.assertTrue({"once", "lineage", "rows_kept"} <= failed, failed)

    def test_prs_before_iprs_uses_master_only(self):
        cid = self._client()
        _, res = self._society_report(cid, "PRS", PRS)
        self.assertEqual(res["result"]["tunecodes"]["summary"]["PRS"]["Match"], 46)
        self.assertEqual(self.client.get(f"/api/clients/{cid}/").json()["works"], 67)
        # IPRS done afterwards finds the same works and adds the 9 missing songs.
        self._society_report(cid, "IPRS", IPRS)
        self.assertEqual(self.client.get(f"/api/clients/{cid}/").json()["works"], 76)

    def test_wrong_files_are_rejected(self):
        cid = self._client()
        self.assertEqual(self._post_file(f"/api/clients/{cid}/master/", IPRS).status_code, 422)  # IPRS dropped as master
        run = self.client.post(f"/api/clients/{cid}/societies/IPRS/", {}, content_type="application/json").json()
        res = self._post_file(f"/api/runs/{run['id']}/files/auto/", PRS)                        # PRS file in IPRS workspace
        self.assertEqual(res.status_code, 422)
        self.assertIn("PRS workspace", res.json()["error"])
        other = self.client.post("/api/clients/", {"name": "Someone Else", "ipi": "999"}, content_type="application/json").json()
        self._post_file(f"/api/clients/{other['id']}/master/", MASTER)
        self.client.post(f"/api/clients/{other['id']}/societies/", {"societies": ["IPRS"]}, content_type="application/json")
        run = self.client.post(f"/api/clients/{other['id']}/societies/IPRS/", {}, content_type="application/json").json()
        res = self._post_file(f"/api/runs/{run['id']}/files/auto/", IPRS)                       # another client's IPRS report
        self.assertEqual(res.status_code, 422)
        self.assertIn("not Someone Else", res.json()["error"])

    def test_next_report_keeps_ids_and_carries_decisions(self):
        cid = self._client()
        run1, _ = self._society_report(cid, "IPRS", IPRS, "2026-09-01")
        before = {w["title"]: w["mrm_id"] for w in self.client.get(f"/api/clients/{cid}/works/").json()["works"]}
        self.client.post(f"/api/runs/{run1}/decisions/", {"internal_no": "32133881", "action": "reject", "master_row": 11},
                         content_type="application/json")
        run2, res2 = self._society_report(cid, "IPRS", IPRS, "2026-10-01")
        links = {l["internal_no"]: l for l in res2["result"]["mapping"]["links"]}
        self.assertEqual(links["32133881"]["state"], "unmatched")
        after = {w["title"]: w["mrm_id"] for w in self.client.get(f"/api/clients/{cid}/works/").json()["works"]}
        self.assertTrue(set(before.items()) <= set(after.items()))

    def test_task_updates_and_history(self):
        cid = self._client(("IPRS",))
        run_id, _ = self._society_report(cid, "IPRS", IPRS)
        tasks = self.client.get(f"/api/clients/{cid}/tasks/").json()["tasks"]
        first = tasks[0]
        self.client.post(f"/api/clients/{cid}/tasks/bulk/", {"ids": [first["id"]], "state": "done", "owner": "Asha"},
                         content_type="application/json")
        from django.core.cache import cache
        cache.clear()
        self.client.get(f"/api/runs/{run_id}/")
        again = {t["id"]: t for t in self.client.get(f"/api/clients/{cid}/tasks/").json()["tasks"]}
        self.assertEqual(len(again), len(tasks))
        self.assertEqual(again[first["id"]]["state"], "done")
        events = self.client.get(f"/api/tasks/{first['id']}/").json()["events"]
        self.assertEqual([e["kind"] for e in events], ["created", "state", "owner"])

    def test_delete_and_society_removal(self):
        cid = self._client()
        self._society_report(cid, "IPRS", IPRS)
        self._society_report(cid, "PRS", PRS)
        self.assertEqual(self.client.get(f"/api/clients/{cid}/").json()["works"], 76)
        # Deleting IPRS removes its reports, statuses and the 9 songs only IPRS added; PRS stays.
        detail = self.client.delete(f"/api/clients/{cid}/societies/IPRS/").json()
        self.assertEqual([s["code"] for s in detail["societies"]], ["PRS"])
        self.assertNotIn("IPRS", detail["coverage"])
        self.assertFalse(any(k.startswith("IPRS|") for k in detail["tasks"]["by_type"]))
        self.assertEqual(Work.objects.filter(client_id=cid).count(), 67)
        # Deleting the master leaves the client waiting for a new one.
        detail = self.client.delete(f"/api/clients/{cid}/master/").json()
        self.assertIsNone(detail["master"])
        self.assertEqual(detail["stage"]["label"], "Needs master")
        self.client.delete(f"/api/clients/{cid}/")
        self.assertEqual(self.client.get("/api/clients/").json()["clients"], [])


@needs_samples
@override_settings(MEDIA_ROOT=tempfile.mkdtemp())
class ClientDeleteTests(TestCase):
    """Deleting a client removes every row it owns in the database, and its uploaded files."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from django.core.cache import cache
        cache.clear()
        self.client.force_login(get_user_model().objects.create_user("d@example.com", "d@example.com", "x"))

    def _post_file(self, url, path):
        with open(path, "rb") as fh:
            return self.client.post(url, {"file": fh})

    def _full_client(self, name, ipi):
        J = "application/json"
        cid = self.client.post("/api/clients/", {"name": name, "ipi": ipi}, content_type=J).json()["id"]
        self._post_file(f"/api/clients/{cid}/master/", MASTER)
        self.client.post(f"/api/clients/{cid}/societies/", {"societies": ["IPRS", "PRS"]}, content_type=J)
        rid = self.client.post(f"/api/clients/{cid}/societies/IPRS/", {}, content_type=J).json()["id"]
        p = self._post_file(f"/api/runs/{rid}/files/iprs/", IPRS).json()
        r2 = self.client.post(f"/api/clients/{cid}/societies/PRS/", {}, content_type=J).json()["id"]
        self._post_file(f"/api/runs/{r2}/files/prs/", PRS)
        link = next(l for l in p["result"]["mapping"]["links"] if l.get("master_row"))
        self.client.post(f"/api/runs/{rid}/decisions/", {"internal_no": link["internal_no"], "action": "reject",
                                                         "master_row": link["master_row"]}, content_type=J)
        self.client.post(f"/api/runs/{rid}/song-flags/", {"keys": ["M3"], "on": True}, content_type=J)
        task = self.client.get(f"/api/clients/{cid}/tasks/").json()["tasks"][0]
        self.client.patch(f"/api/tasks/{task['id']}/", {"state": "done", "note": "x"}, content_type=J)
        with tempfile.TemporaryDirectory() as tmp:
            _muso_file(f"{tmp}/muso.xlsx", MUSO_ROWS)
            self.assertEqual(self._post_file(f"/api/clients/{cid}/clean/", f"{tmp}/muso.xlsx").status_code, 200)
        self.client.post(f"/api/clients/{cid}/clean/decisions/", {"items": [{"key": "missing:INXY12300099", "choice": "add"}]}, content_type=J)
        return cid

    def _counts(self):
        from django.apps import apps
        return {m._meta.label: m.objects.count() for m in apps.get_app_config("catalogue").get_models()}

    def test_delete_removes_everything(self):
        from django.conf import settings
        keep = self._full_client("Other client", "")
        before_other = self._counts()
        cid = self._full_client("Dhanya Suresh", "")
        self.assertTrue(all(n > 0 for label, n in self._counts().items() if label not in ("catalogue.MasterEdit", "catalogue.NameAlias")))
        with self.captureOnCommitCallbacks(execute=True):
            r = self.client.delete(f"/api/clients/{cid}/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self._counts(), before_other)          # only the other client's rows are left
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(f"/api/clients/{keep}/")
        self.assertEqual(set(self._counts().values()), {0})     # every catalogue table is now empty
        leftover = [p for p in Path(settings.MEDIA_ROOT).rglob("*") if p.is_file()]
        self.assertEqual(leftover, [])                          # and no uploaded file is left behind


class TaskLifecycleTests(TestCase):
    """Auto-verification and reopening across reports, on synthetic report rows."""

    def test_verify_then_reopen(self):
        from datetime import date
        from .models import Client, Run, Task, Work
        from .sync import _reconcile_tasks
        client = Client.objects.create(name="Test", ipi="1")
        work = Work.objects.create(client=client, mrm_id="W-0001", title="Song")
        runs = [Run.objects.create(name=f"r{i}", client=client, report_date=date(2026, i, 1)) for i in (1, 2, 3)]
        missing = {"societies": {"IPRS": {"issues": [{"code": "NOT_FOUND", "text": "No IPRS tunecode found"}]}}, "master_updates": []}
        fine = {"societies": {"IPRS": {"issues": []}}, "master_updates": []}
        changes = {"verified": [], "reopened": [], "new_tasks": []}

        _reconcile_tasks(client, work, missing, runs[0], changes)
        task = Task.objects.get(work=work)
        self.assertEqual((task.type, task.state), ("register", "open"))
        _reconcile_tasks(client, work, fine, runs[1], changes)
        task.refresh_from_db()
        self.assertEqual(task.state, "verified")
        _reconcile_tasks(client, work, missing, runs[2], changes)
        task.refresh_from_db()
        self.assertEqual(task.state, "open")
        self.assertEqual([e.kind for e in task.events.all()], ["created", "auto_verified", "reopened"])


@override_settings(SUPER_ADMIN_EMAIL="boss@example.com")
class AuthTests(TestCase):
    """Sign-in is required everywhere; only the super admin manages users."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from django.core.cache import cache
        cache.clear()
        User = get_user_model()
        self.boss = User.objects.create_user("boss@example.com", "boss@example.com", "Boss-pass-2026")
        self.member = User.objects.create_user("member@example.com", "member@example.com", "Member-pass-2026")

    def _login(self, email, password):
        return self.client.post("/api/auth/login/", {"email": email, "password": password}, content_type="application/json")

    def test_api_needs_login(self):
        self.assertEqual(self.client.get("/api/clients/").status_code, 401)
        self.assertIsNone(self.client.get("/api/auth/me/").json()["user"])

    def test_login_and_logout(self):
        self.assertEqual(self._login("member@example.com", "wrong").status_code, 400)
        r = self._login("MEMBER@example.com", "Member-pass-2026")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["user"]["is_super_admin"])
        self.assertEqual(self.client.get("/api/clients/").status_code, 200)
        self.client.post("/api/auth/logout/")
        self.assertEqual(self.client.get("/api/clients/").status_code, 401)

    def test_lockout_after_wrong_passwords(self):
        for _ in range(8):
            self._login("member@example.com", "wrong")
        self.assertEqual(self._login("member@example.com", "Member-pass-2026").status_code, 429)

    def test_only_super_admin_adds_users(self):
        new = {"email": "new@example.com", "name": "New", "password": "New-pass-2026"}
        self._login("member@example.com", "Member-pass-2026")
        self.assertEqual(self.client.get("/api/users/").status_code, 403)
        self.assertEqual(self.client.post("/api/users/", new, content_type="application/json").status_code, 403)

        self._login("boss@example.com", "Boss-pass-2026")
        self.assertTrue(self.client.get("/api/auth/me/").json()["user"]["is_super_admin"])
        r = self.client.post("/api/users/", new, content_type="application/json")
        self.assertEqual(r.status_code, 201)
        self.assertEqual(self.client.post("/api/users/", new, content_type="application/json").status_code, 400)
        weak = {**new, "email": "weak@example.com", "password": "123"}
        self.assertEqual(self.client.post("/api/users/", weak, content_type="application/json").status_code, 400)
        self.assertEqual(self.client.delete(f"/api/users/{self.boss.id}/").status_code, 400)

        uid = r.json()["id"]
        self.client.patch(f"/api/users/{uid}/", {"is_active": False}, content_type="application/json")
        self.client.post("/api/auth/logout/")
        self.assertEqual(self._login("new@example.com", "New-pass-2026").status_code, 400)

    def test_admin_manages_members_only(self):
        from django.contrib.auth import get_user_model
        admin = get_user_model().objects.create_user("admin@example.com", "admin@example.com", "Admin-pass-2026", is_staff=True)
        other = get_user_model().objects.create_user("other@example.com", "other@example.com", "Other-pass-2026", is_staff=True)
        self._login("admin@example.com", "Admin-pass-2026")
        me = self.client.get("/api/auth/me/").json()["user"]
        self.assertEqual((me["role"], me["is_admin"], me["is_super_admin"]), ("admin", True, False))
        self.assertEqual(self.client.get("/api/users/").status_code, 200)
        new = {"email": "new@example.com", "password": "New-pass-2026"}
        self.assertEqual(self.client.post("/api/users/", new, content_type="application/json").json()["role"], "member")
        as_admin = {**new, "email": "x@example.com", "role": "admin"}
        self.assertEqual(self.client.post("/api/users/", as_admin, content_type="application/json").status_code, 403)
        patch = lambda u, body: self.client.patch(f"/api/users/{u.id}/", body, content_type="application/json").status_code
        self.assertEqual(patch(self.member, {"is_active": False}), 200)
        self.assertEqual(patch(self.member, {"role": "admin"}), 403)
        self.assertEqual(patch(other, {"is_active": False}), 403)
        self.assertEqual(patch(admin, {"name": "Me"}), 403)
        self.assertEqual(patch(self.boss, {"is_active": False}), 400)

        self._login("boss@example.com", "Boss-pass-2026")
        self.assertEqual(patch(self.member, {"role": "admin"}), 200)
        roles = {u["email"]: u["role"] for u in self.client.get("/api/users/").json()["users"]}
        self.assertEqual(roles["member@example.com"], "admin")
        self.assertEqual(patch(other, {"role": "member"}), 200)
        self.assertFalse(get_user_model().objects.get(id=other.id).is_staff)

    def test_disable_or_reset_signs_user_out(self):
        from django.test import Client as HttpClient
        member = HttpClient()
        member.post("/api/auth/login/", {"email": "member@example.com", "password": "Member-pass-2026"}, content_type="application/json")
        self.assertEqual(member.get("/api/clients/").status_code, 200)
        self._login("boss@example.com", "Boss-pass-2026")
        self.client.patch(f"/api/users/{self.member.id}/", {"password": "Reset-pass-2026"}, content_type="application/json")
        self.assertEqual(member.get("/api/clients/").status_code, 401)
        member.post("/api/auth/login/", {"email": "member@example.com", "password": "Reset-pass-2026"}, content_type="application/json")
        self.assertEqual(member.get("/api/clients/").status_code, 200)
        self.client.patch(f"/api/users/{self.member.id}/", {"is_active": False}, content_type="application/json")
        self.assertEqual(member.get("/api/clients/").status_code, 401)

    def test_change_own_password(self):
        self._login("member@example.com", "Member-pass-2026")
        bad = {"current": "nope", "new": "Another-pass-2026"}
        self.assertEqual(self.client.post("/api/auth/password/", bad, content_type="application/json").status_code, 400)
        ok = {"current": "Member-pass-2026", "new": "Another-pass-2026"}
        self.assertEqual(self.client.post("/api/auth/password/", ok, content_type="application/json").status_code, 200)
        self.assertEqual(self.client.get("/api/clients/").status_code, 200)

    def test_csrf_enforced(self):
        from django.test import Client as HttpClient
        browser = HttpClient(enforce_csrf_checks=True)
        browser.force_login(self.member)
        self.assertEqual(browser.post("/api/clients/", {"name": "X"}, content_type="application/json").status_code, 403)
        browser.get("/api/auth/me/")
        token = browser.cookies["csrftoken"].value
        r = browser.post("/api/clients/", {"name": "X"}, content_type="application/json", HTTP_X_CSRFTOKEN=token)
        self.assertIn(r.status_code, (200, 201))

    def test_superadmin_command(self):
        import os
        from io import StringIO
        from django.core.management import call_command
        from django.contrib.auth import get_user_model
        get_user_model().objects.filter(id=self.boss.id).delete()
        os.environ["MRM_SUPER_ADMIN_PASSWORD"] = "Fresh-boss-2026"
        try:
            call_command("superadmin", "--no-input", stdout=StringIO())
        finally:
            del os.environ["MRM_SUPER_ADMIN_PASSWORD"]
        boss = get_user_model().objects.get(username="boss@example.com")
        self.assertTrue(boss.is_superuser and boss.check_password("Fresh-boss-2026"))


class FakeDrive:
    """In-memory stand-in for the Google Drive REST API used by catalogue.drive."""

    class Response:
        def __init__(self, status=200, data=None, content=b""):
            self.status_code, self._data, self.content, self.text = status, data or {}, content, ""

        def json(self):
            return self._data

    def __init__(self, fail=False):
        self.files, self.fail = {}, fail   # id -> (name, parent, bytes)

    def post(self, url, data=None, json=None, headers=None, params=None, timeout=None):
        if self.fail:
            return self.Response(503, {"error": {"message": "backend error"}})
        import json as _json
        import re
        boundary = re.search(r"boundary=(\w+)", headers["Content-Type"]).group(1).encode()
        parts = data.split(b"--" + boundary)
        meta = _json.loads(parts[1].split(b"\r\n\r\n", 1)[1].strip())
        body = parts[2].split(b"\r\n\r\n", 1)[1][:-2]
        file_id = f"id{len(self.files) + 1}"
        self.files[file_id] = (meta["name"], meta["parents"][0], body)
        return self.Response(200, {"id": file_id})

    def get(self, url, params=None, timeout=None):
        params = params or {}
        if params.get("alt") == "media":
            file_id = url.rsplit("/", 1)[1]
            return self.Response(200, content=self.files[file_id][2]) if file_id in self.files else self.Response(404)
        name = params["q"].split("name = '", 1)[1].split("' and '", 1)[0].replace("\\'", "'")
        return self.Response(200, {"files": [{"id": i} for i, f in self.files.items() if f[0] == name][:1]})

    def delete(self, url, timeout=None):
        return self.Response(204 if self.files.pop(url.rsplit("/", 1)[1], None) else 404)


class DriveStorageTests(TestCase):
    """Uploaded files kept in Google Drive, with the local media folder only as a cache."""

    def setUp(self):
        from unittest import mock
        from django.core.cache import cache
        from .drive import DriveStorage
        cache.clear()
        self.media = tempfile.mkdtemp()
        self.fake = FakeDrive()
        for target, value in (("catalogue.drive.session", self.fake), ("catalogue.drive.time.sleep", None)):
            patcher = mock.patch(target, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.media, True)
        self.storage = DriveStorage(folder_id="folder1", cache_dir=self.media)
        self.storage.background = False

    def _wait_for_uploads(self):
        import threading
        for t in threading.enumerate():
            if t.name.startswith("drive-upload"):
                t.join(10)

    def test_save_redownload_delete(self):
        from django.core.cache import cache
        from django.core.files.base import ContentFile
        name = self.storage.save("runs/1/iprs/report's file.xlsx", ContentFile(b"spreadsheet bytes"))
        self.assertRegex(name, r"^runs/1/iprs/report's file_[0-9a-f]{8}\.xlsx$")   # unique name, no Drive lookup
        self.assertEqual([(f[0], f[1], f[2]) for f in self.fake.files.values()], [(name, "folder1", b"spreadsheet bytes")])
        Path(self.storage.path(name)).unlink()           # the server's disk was wiped
        cache.clear()                                    # …and the id cache with it
        self.assertEqual(Path(self.storage.path(name)).read_bytes(), b"spreadsheet bytes")
        self.assertTrue(self.storage.exists(name))
        self.storage.delete(name)
        self.assertEqual(self.fake.files, {})
        self.assertFalse(self.storage.exists(name))

    def test_background_upload(self):
        from django.core.files.base import ContentFile
        self.storage.background = True
        name = self.storage.save("runs/2/prs/works.csv", ContentFile(b"csv"))
        self.assertEqual(Path(self.storage.path(name)).read_bytes(), b"csv")   # usable before Drive has it
        self._wait_for_uploads()
        self.assertEqual([f[0] for f in self.fake.files.values()], [name])

    def test_background_upload_failure_keeps_local_copy_and_sync_sends_it(self):
        from io import StringIO
        from unittest import mock
        from django.core.files.base import ContentFile
        from django.core.management import call_command
        self.storage.background = True
        self.fake.fail = True
        name = self.storage.save("clients/1/master/lnv.xlsx", ContentFile(b"master"))
        self._wait_for_uploads()
        self.assertEqual(self.fake.files, {})
        self.assertTrue((Path(self.media) / name).exists())
        self.fake.fail = False
        keys = dict.fromkeys(("MRM_GDRIVE_CLIENT_ID", "MRM_GDRIVE_CLIENT_SECRET", "MRM_GDRIVE_REFRESH_TOKEN"), "x")
        with override_settings(MEDIA_ROOT=self.media), mock.patch.dict(os.environ, {**keys, "MRM_GDRIVE_FOLDER_ID": "folder1"}), \
                mock.patch("catalogue.drive.list_names", side_effect=lambda http, folder: {f[0] for f in self.fake.files.values()}):
            out = StringIO()
            call_command("drive_setup", "--sync", stdout=out)
            self.assertIn("uploaded 1 file(s)", out.getvalue())
            call_command("drive_setup", "--sync", stdout=out)
            self.assertIn("uploaded 0 file(s); 1 already there", out.getvalue())
        self.assertEqual([f[0] for f in self.fake.files.values()], [name])

    def test_delete_during_background_upload_leaves_nothing(self):
        from django.core.files.base import ContentFile
        self.storage.background = True
        name = self.storage.save("runs/3/iprs/x.xlsx", ContentFile(b"x"))
        self.storage.delete(name)
        self._wait_for_uploads()
        self.assertEqual(self.fake.files, {})

    def test_failed_master_upload_keeps_client_data(self):
        from unittest import mock
        from django.contrib.auth import get_user_model
        from .models import Client, MasterEdit, MasterFile
        self.fake.fail = True
        self.client.force_login(get_user_model().objects.create_user("t@example.com", "t@example.com", "x"))
        client = Client.objects.create(name="C")
        MasterEdit.objects.create(client=client, master_row=3, field="Title", internal_no="1", choice="iprs")
        if not MASTER.exists():
            self.skipTest("sample master not in project root")
        with mock.patch.object(MasterFile._meta.get_field("file"), "storage", self.storage), open(MASTER, "rb") as fh:
            r = self.client.post(f"/api/clients/{client.id}/master/", {"file": fh})
        self.assertEqual(r.status_code, 502)
        self.assertIn("Google Drive could not", r.json()["error"])
        self.assertEqual(MasterFile.objects.count(), 0)
        self.assertEqual(MasterEdit.objects.filter(client=client).count(), 1)

    def test_setup_writes_env(self):
        from .management.commands.drive_setup import write_env
        env = Path(self.media) / ".env"
        env.write_text("MRM_DATABASE_URL='postgres://x'\nMRM_GDRIVE_FOLDER_ID='old'\n")
        write_env({"MRM_GDRIVE_FOLDER_ID": "new", "MRM_GDRIVE_REFRESH_TOKEN": "tok"}, path=env)
        text = env.read_text()
        self.assertIn("MRM_DATABASE_URL='postgres://x'", text)
        self.assertNotIn("'old'", text)
        self.assertIn("MRM_GDRIVE_FOLDER_ID='new'", text)
        self.assertEqual(oct(env.stat().st_mode & 0o777), "0o600")


# ---------------------------------------------------------------- data clean (LNV against one DSP sheet)

def _lnv_file(path, rows):
    """A small LNV master: (title, isrc, movie, composer, author)."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["SN", "Work*", "ISRC", "ISWC", "Alternate Work", "Movie Name *",
               "Composer Name 1", "Artist CAE 1", "Artist Joshua ID 1", "Role 1", "Performance share 1", "Mechanical share 1",
               "Author Name 1", "Artist CAE 2", "Artist Joshua ID 2", "Role 2", "Performance share 2", "Mechanical share 2",
               "ISRC 1", "ISWC 1", "IPRS TUNECODE 1"])
    for n, (title, isrc, movie, composer, author) in enumerate(rows, start=1):
        ws.append([n, title, isrc, None, None, movie, composer, None, None, "C", 50, 50, author, None, None, "A", 50, 50, None, None, None])
    wb.save(path)


def _muso_file(path, rows):
    """A small Muso Credits sheet: (title, album, isrc, lyricist, composer, popularity)."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Muso Credits"
    ws.append(["Type of Object", "Name of the Song / Title", "Name of the Album", "ISRC", "Song Release Date", "Singer",
               "Lyricist", "Composer", "Music Label", "Duration (mm:ss)", "Song Link", "Popularity (0-100)", "Muso Track ID"])
    for n, (title, album, isrc, lyricist, composer, pop) in enumerate(rows, start=1):
        ws.append(["Album", title, album, isrc, "1990-05-01", "Lata Mangeshkar", lyricist, composer, "Saregama", "4:21",
                   f"https://open.spotify.com/track/{n}", pop, f"m-{n}"])
    wb.save(path)


CLIENT = "Ravi Kumar Verma"
LNV_ROWS = [
    ("Pyaar Ka Geet", None, "Film A", "VERMA, RAVI KUMAR", "BAKSHI, ANAND"),           # row 2
    ("Pyar Ka Geet", None, "Film A", "Ravi Kumar Verma", "Anand Bakshi"),              # row 3: same song again
    ("Dil Ki Baat", "INAB12300001", "Film B", "Ravi Kumar Verma", "MALIK VERMA"),      # row 4
    ("Some Other Song", "INAB12300001", "Film X", "Ravi Kumar Verma", "Sameer"),       # row 5: the same ISRC
    ("Neend Na Aaye", None, "Film D", "Ravi Kumar Verma", "IPRS"),                     # row 6: junk author
]
MUSO_ROWS = [
    ("Pyaar Ka Geet - Lofi Flip", "Film A (Original Motion Picture Soundtrack)", "INXY12300010", "Anand Bakshi", "Ravi Kumar Verma, Anand Bakshi", 20),
    ("Pyaar Ka Geet", "Film A (Original Motion Picture Soundtrack)", "INXY12300011", "Anand Bakshi", "Ravi Kumar Verma, Anand Bakshi", 40),
    ("Dil Ki Baat", "Film B", "INAB12300001", "Malik Varma", "Ravi Kumar Verma", 30),
    ("Brand New Hit", "Film E", "INXY12300099", "Gulzar", "Ravi Kumar Verma", 70),
]


class DataCleanEngineTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        from .engine.dataclean import parse_dsp
        from .engine.master import parse_master
        cls.tmp = tempfile.mkdtemp()
        _lnv_file(f"{cls.tmp}/lnv.xlsx", LNV_ROWS)
        _muso_file(f"{cls.tmp}/muso.xlsx", MUSO_ROWS)
        cls.master, cls.dsp = parse_master(f"{cls.tmp}/lnv.xlsx"), parse_dsp(f"{cls.tmp}/muso.xlsx")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)
        super().tearDownClass()

    def _match(self, decisions=None):
        """The match after step 1 with every merge suggestion accepted."""
        from .engine.dataclean import apply_decisions, learned, match
        from .engine.songmerge import analyse, songs
        aliases, links = learned(decisions or {})
        merge = analyse(self.dsp["rows"])
        groups = songs(merge, {f"merge:{k}": {"choice": "accepted"} for k in merge["items"]})
        return apply_decisions(match(self.master, self.dsp, CLIENT, aliases, links, groups), decisions or {})

    def test_matching_tolerances_from_real_catalogues(self):
        from .engine.dataclean import _same_album, _year, from_tag, person_key as pk, publisher_key, same_person
        # a first name in full or short, the surname the same – never two different first names
        self.assertTrue(same_person(pk("Lalit Pandit"), pk("Lalitraj Pandit")))
        self.assertFalse(same_person(pk("Jatin Pandit"), pk("Lalitraj Pandit")))
        self.assertFalse(same_person(pk("Sajid Khan"), pk("Wajid Khan")))
        # royalty administrators are not the song's publisher; real publishers still are
        self.assertEqual([publisher_key(x) for x in ("The Royalty Network Inc.", "MUSERK LLC", "MUSIC SERVICES", "SENTRIC MUSIC LIMITED")], ["", "", "", ""])
        self.assertEqual(publisher_key("SUPER CASSETTES INDUSTRIES LTD"), "super")
        # the DSP's year is when the song went online: later contradicts nothing, earlier is another recording
        self.assertEqual((_year("2009", "1996"), _year("1990", "1996"), _year("1997", "1996"), _year("", "1996")), ("later", "differ", "same", "blank"))
        # a film and its subtitle; numbers must agree
        self.assertTrue(_same_album("Don", "Don - The Chase Begins Again"))
        self.assertTrue(_same_album("1942 A Love Story", "1942: A Love Story"))
        self.assertFalse(_same_album("Don", "Don 2"))
        self.assertFalse(_same_album("Don", "Dil Chahta Hai"))
        # the film a DSP single names in its title
        self.assertEqual(from_tag('Main Yahaan Hoon (From "Veer-Zaara")'), "Veer-Zaara")
        self.assertEqual(from_tag("Sharara - Extended Version (From “Mere Yaar Ki Shaadi Hai”)"), "Mere Yaar Ki Shaadi Hai")
        self.assertEqual(from_tag("Kal Ho Naa Ho"), "")
        self.assertEqual(from_tag('Main Phir Bhi Tumko Chaahunga - From "Half Girlfriend"'), "Half Girlfriend")

    def test_one_recording_one_row(self):
        """'Phir Bhi Tumko Chaahungi' (Mithoon): every recording of a song is told apart by the version its title names,
        and gets its own LNV row – never the song linked to two singers' versions at once."""
        from .engine.dataclean import ORIGINAL, _parts, same_tag, tag_fits, version_type
        # another singer's or language's recording is a version; the film / album / soundtrack version is the song
        self.assertEqual([version_type(t) for t in ("Phir Bhi Tumko Chaahungi - Aakanksha Version", "Phir Bhi Tumko Chaahunga (Nikhil Iyer Version)",
                                                    "Udd Jaa Kaale Kaava - Bhojpuri Version", "Jogan Jogan - Badhaai Ho Badhaai / Soundtrack Version",
                                                    "Pichle Saat Dinon Mein (Album Version)", "Krishna Aayega (JB)")],
                         ["Singer / Language Version", "Singer / Language Version", "Singer / Language Version", ORIGINAL, ORIGINAL, "Jhankar"])
        # the version named must be the same one; filler words and spelling do not count
        self.assertFalse(same_tag("Phir Bhi Tumko Chaahungi - Aakanksha Version", "Phir Bhi Tumko Chaahunga (Nikhil Iyer Version)"))
        self.assertFalse(same_tag("Phir Bhi Tumko Chaahunga - Lofi Mix", "Phir Bhi Tumko Chaahunga - L3AD LoFi Mix"))
        self.assertFalse(same_tag("Maula Mere Maula - Chill", "Maula Mere Maula - Stutter"))
        self.assertTrue(same_tag("Tum Hi Ho (Female)", "Tum Hi Ho - Female Version"))
        self.assertTrue(same_tag("Pyaar Ka Geet - Lofi Flip", "Pyaar Ka Geet Lofi"))
        self.assertTrue(same_tag("Phir Bhi Tumko Chaahungi – Aakanksha Version", "Phir Bhi Tumko Chaahungi (Akanksha Version)"))
        # a version named in fewer words: on the same film only
        self.assertTrue(tag_fits("Ik Junoon (Remix By Dj Shiva)", "Zindagi Na Milegi Dobara", "Ik Junoon (remix)", "Zindagi Na Milegi Dobara"))
        self.assertFalse(tag_fits("Thodasa Pagla - Afro Mix", "Thodasa Pagla (Afro Mix)", "Thodasa Pagla (remix)", "Kool And Krazy Remixes 2"))

        def row(n, title, album, isrc, year):
            return {"row": n, "title": title, "album": album, "isrcs": [isrc], "year": year, "date": year, "duration": "", "label": "",
                    "singers": [], "popularity": 0}
        rows = [row(79, "Phir Bhi Tumko Chaahungi", "Half Girlfriend (Original Motion Picture Soundtrack)", "INZ031402335", "2017"),
                row(38, 'Main Phir Bhi Tumko Chaahunga - From "Half Girlfriend"', 'Main Phir Bhi Tumko Chaahunga (From "Half Girlfriend")', "INZ031421093", "2026"),
                row(763, "Phir Bhi Tumko Chaahungi – Aakanksha Version", "Phir Bhi Tumko Chaahungi – Aakanksha Version", "INZ031402398", "2017"),
                row(720, "Phir Bhi Tumko Chaahungi - Jyotica Version", "Phir Bhi Tumko Chaahungi (Jyotica Version)", "INZ031402402", "2017"),
                row(251, "Phir Bhi Tumko Chaahunga (Nikhil Iyer Version)", "Phir Bhi Tumko Chaahunga (Nikhil Iyer Version)", "INZ031419465", "2025")]
        original, parts = _parts(rows, list(range(len(rows))))
        # the female song is the original alone – the male song on the same film is a recording of its own, and so is
        # each singer's version (they were one row's worth before)
        self.assertEqual(original["isrcs"], ["INZ031402335"])
        self.assertEqual(sorted(len(p["isrcs"]) for p in parts), [1, 1, 1, 1])

    def test_keys(self):
        from .engine.dataclean import person_key, same_person, title_key, version_type
        self.assertEqual(person_key("BAKSHI, ANAND"), person_key("Anand Bakshi"))
        self.assertEqual(person_key("Laxmikant–Pyarelal"), person_key("Laxmikant Pyarelal"))
        self.assertTrue(same_person(person_key("Manoj Muntashir"), person_key("Shukla Manoj Muntashir")))
        self.assertFalse(same_person(person_key("Malik Verma"), person_key("Sameer")))
        self.assertEqual(title_key("Pyaar Ka Geet - Lofi Flip"), title_key("Pyar Ka Geet"))
        self.assertEqual(version_type("Pyaar Ka Geet - Lofi Flip"), "Lofi")

    def test_song_merge_as_mrm_extractor(self):
        from .engine.songmerge import analyse, songs

        def row(n, title, isrc, lyricists, composers):
            return {"row": n, "title": title, "isrcs": [isrc], "date": "", "popularity": 0, "lyricists": lyricists, "composers": composers}
        rows = [
            row(2, "Tum Ho", "INAA10000001", ["Gulzar"], ["R D Burman"]),
            row(3, "Tum Ho", "INAA10000001", ["GULZAR"], ["R. D. Burman"]),          # same ISRC, same writers: one recording
            row(4, "Tum Ho (Lofi)", "INAA10000002", ["Gulzar"], ["R D Burman"]),     # same writers, similar title: suggestion
            row(5, "Tum Ho (Remix)", "INAA10000003", ["Gulzar"], ["R D Burman", "DJ X"]),   # a remixer added: no suggestion
            row(6, "Tum Ho", "INAA10000003", ["Gulzar"], []),                       # its ISRC, the composer blank: conflict
            row(7, "Other", "INAA10000009", ["Sameer"], ["Anu Malik"]),
            row(8, "Other", "INAA10000009", ["Javed Akhtar"], ["Jatin Lalit"]),      # same ISRC, other people: conflict
        ]
        a = analyse(rows)
        self.assertEqual([[rows[i]["row"] for i in r] for r in a["recs"]], [[2, 3], [4], [5], [6], [7], [8]])
        self.assertEqual({k: (i["kind"], [a["ids"][r] for r in i["rids"]]) for k, i in a["items"].items()},
                         {"G2": ("suggestion", [2, 4]), "C5": ("missing", [5, 6]), "C7": ("different", [7, 8])})
        # Until the reviewer answers, the app's: versions and "only missing credits" join; different people stay apart
        self.assertEqual(sorted(sorted(rows[i]["row"] for i in s) for s in songs(a, {})), [[2, 3, 4], [5, 6], [7], [8]])
        self.assertEqual(len(songs(a, {"merge:G2": {"choice": "rejected"}, "merge:C5": {"choice": "rejected"}})), 6)
        self.assertEqual(len(songs(a, {"merge:G2": {"choice": "accepted", "data": {"excluded": [4]}}})), 5)
        self.assertEqual(len(songs(a, {"merge:C7": {"choice": "accepted"}})), 3)

    def test_the_same_song_rule(self):
        from .engine.dataclean import People, person_key, publisher_key, rules_of, work_check
        # Publishers: one company however it is written; a society is no publisher
        self.assertEqual({publisher_key(x) for x in ("Saregama India Ltd", "SAREGAMA PLC", "HMV")}, {"saregama"})
        self.assertEqual(publisher_key("MUSIC INDIA LTD."), publisher_key("Universal Music Publishing Pvt Ltd"))
        self.assertEqual(publisher_key("IPRS"), "")
        rules = rules_of({"writer:" + person_key("Raju Singh"): {"choice": "ignore"}, "pub:big|super": {"choice": "same"},
                          "pub:eros|yash": {"choice": "different"}})
        self.assertEqual(rules, {"ignore": [person_key("Raju Singh")], "pubs": {"super": "big"}})
        people = People({}, {person_key("Javed Akhtar")}, rules)

        def song(writers, pubs, singers=()):
            return {"people": people.work(writers), "pubkeys": {people.pub(p) for p in pubs},
                    "aside": {people.key(x) for x in singers} | people.ignore}
        lnv = song(["Javed Akhtar", "Shankar Mahadevan", "Ehsaan Noorani", "Loy Mendonsa"], ["Super Cassettes Industries Ltd"])
        # A group is its members; the same company under another name (the reviewer's answer) shares the publisher
        self.assertEqual(work_check(song(["Javed Akhtar", "Shankar-Ehsaan-Loy"], ["BIG Music"]), lnv), ("same", "same"))
        # A singer listed among the composers, or a name the reviewer set aside, does not make another work
        self.assertEqual(work_check(song(["Javed Akhtar", "Shankar-Ehsaan-Loy", "Sonu Nigam"], ["T-Series"], ["Sonu Nigam"]), lnv)[0], "same")
        self.assertEqual(work_check(song(["Javed Akhtar", "Shankar-Ehsaan-Loy", "Raju Singh"], []), lnv), ("same", "unchecked"))
        # Any other writer, or another publisher: a different song
        self.assertEqual(work_check(song(["Javed Akhtar", "Shankar-Ehsaan-Loy", "Akshay Mandale"], []), lnv)[0], "differ")
        self.assertEqual(work_check(song(["Javed Akhtar", "Shankar-Ehsaan-Loy"], ["Eros International"]), lnv)[1], "differ")
        self.assertEqual(work_check(song([], []), lnv)[0], "blank")

    def test_reads_the_dsp_sheet(self):
        self.assertEqual(self.dsp["source"], "Muso")
        self.assertEqual(self.dsp["sheet"], "Muso Credits")
        self.assertEqual(self.dsp["stats"]["rows"], 4)

    def test_one_pass_finds_every_queue(self):
        r = self._match()
        self.assertEqual(r["source"]["songs"], 3)   # the lofi flip stays with its song
        self.assertIn("Ravi Kumar Verma", r["client_names"])
        matched = {m["song"]["title"]: sorted(l["row"] for l in m["links"]) for m in r["matched"]}
        self.assertEqual(matched, {"Pyaar Ka Geet": [2, 3]})
        # The user's two stages: 1 the recording (title, album, ISRC, year) · 2 the work (title, album, writers,
        # publisher); both = exact, one = possible. Dil Ki Baat has row 4's ISRC, title and film but "Malik Varma" on
        # Muso and "MALIK VERMA" in the LNV: stage 1 only, possible – a person decides, the two spellings asked once.
        # Row 5 shares only the ISRC: listed so it is never added twice
        self.assertEqual([(c["song"]["title"], [(x["row"], x["rec"]["level"]) for x in c["candidates"]]) for c in r["check"]],
                         [("Dil Ki Baat", [(4, "possible"), (5, "isrc_only")])])
        self.assertEqual((r["check"][0]["candidates"][0]["rec"]["stage1"], r["check"][0]["candidates"][0]["rec"]["stage2"]), (True, False))
        self.assertEqual([m["title"] for m in r["missing"]], ["Brand New Hit"])
        dups = {c["kind"]: c for c in r["duplicates"]}
        self.assertEqual(sorted(x["row"] for x in dups["duplicate"]["rows"]), [2, 3])
        self.assertEqual(dups["duplicate"]["decision"]["choice"], "duplicate")   # answered by the app: same song, same film
        self.assertTrue(dups["duplicate"]["decision"]["auto"])
        self.assertEqual([x["row"] for x in dups["wrong_isrc"]["rows"]], [4, 5])
        self.assertNotIn("decision", dups["wrong_isrc"])                          # a person decides which song owns the ISRC
        spelling = [n for n in r["names"] if n["kind"] == "spelling"]
        self.assertEqual({spelling[0]["a"]["spelling"].lower(), spelling[0]["b"]["spelling"].lower()}, {"malik verma", "malik varma"})
        self.assertFalse(spelling[0]["info"])
        # "Same person": now the writers are the same and Dil Ki Baat is LNV row 4
        r = self._match({spelling[0]["key"]: {"choice": "same", "data": {}}})
        self.assertEqual({m["song"]["title"]: sorted(l["row"] for l in m["links"]) for m in r["matched"]}, {"Pyaar Ka Geet": [2, 3], "Dil Ki Baat": [4]})
        self.assertEqual([n["name"] for n in r["names"] if n["kind"] == "junk"], ["IPRS"])
        self.assertEqual([(m["title"], m["credit"], m["decision"]["choice"]) for m in r["missing"]], [("Brand New Hit", "writer", "add")])
        isrc_fills = {f["row"]: f["value"] for f in r["fills"] if f["field"] == "ISRC"}
        # the original's ISRC, not the lofi's – and on one of the song's two rows only (v1.7: never twice within a song)
        self.assertEqual(isrc_fills, {2: "INXY12300011"})
        self.assertTrue(all(f["decision"]["auto"] for f in r["fills"]))
        self.assertEqual(r["open"]["fills"], 0)

    def test_versions_and_recordings_are_not_duplicates(self):
        from .engine.dataclean import People, _duplicates, album_key, title_key, version_type
        people = People({}, set())

        def row(n, title, movie="", isrcs=(), writers=(), alt=""):
            keys = {k for k in (title_key(title), title_key(alt)) if k}
            return {"row": n, "title": title, "movie": movie, "tkeys": keys, "isrcs": set(isrcs), "version": version_type(title),
                    "writers": people.writers(writers), "has_writers": bool(writers), "film": album_key(movie), "codes": {},
                    "song": {"title": title, "alt_title": alt, "authors": [{"name": w} for w in writers], "composers": [], "singers": []}}
        lnv = [
            row(1, "Ek Pyar Ka Nagma Hai", "Shor", writers=["Santosh Anand"]),
            row(2, "Ek Pyar Ka Nagma Hai", "Shor", writers=["Santosh Anand"]),                        # entered twice
            row(3, "Ek Pyar Ka Naghma Hai - Bengali Version", "Ek Pyar Ka Naghma Hai - Bengali Version", writers=["Sayan Das"]),
            row(4, "Ek Pyar Ka Nagma Hai", "Retro", writers=["Santosh Anand", "Bharat Bhushan Pant"]),  # a remake: another lyricist too
            row(5, "Ek Pyar Ka Nagma Hai", isrcs=["INAA12300001"]),                                     # no writers: blank is unknown
            row(6, "Ek Pyar Ka Nagma Hai", isrcs=["INAA12300002"]),                                     # another recording
            row(7, "Bol Kaun Hai Tu", "Chacha", writers=["Anand Bakshi"], alt="Bhoot Raja Bahar Aaja"),
            row(8, "Bhoot Raja Bahar Aaja", "Chacha", writers=["Anand Bakshi"], alt="Bol Kaun Hai Tu"),
        ]
        groups = [sorted(x["row"] for x in c["rows"]) for c in _duplicates(lnv, {}, []) if c["kind"] == "duplicate"]
        self.assertEqual(groups, [[1, 2]])   # versions, remakes, other recordings and alternate titles stay apart
        # A row fits a group only when it fits every row in it: the blank row 5 joins 1 and 2, but never pulls in row 3
        links = {j: [(0, {})] for j in (0, 1, 2, 4)}
        groups = [sorted(x["row"] for x in c["rows"]) for c in _duplicates(lnv, links, [{"title": "Ek Pyar Ka Nagma Hai"}]) if c["kind"] == "duplicate"]
        self.assertEqual(groups, [[1, 2, 5]])

    def test_decisions_teach_the_match(self):
        r = self._match()
        pair = next(n for n in r["names"] if n["kind"] == "spelling")
        r = self._match({pair["key"]: {"choice": "same", "data": {}}})
        dil = next(m for m in r["matched"] if m["song"]["title"] == "Dil Ki Baat")
        self.assertEqual(dil["notes"], [])        # one person now: the writers agree
        # The reviewer's answer beats the app's
        dup = next(c for c in r["duplicates"] if c["kind"] == "duplicate")
        r = self._match({dup["key"]: {"choice": "different", "data": {}}})
        self.assertNotIn("auto", next(c for c in r["duplicates"] if c["key"] == dup["key"])["decision"])
        # "Not in the LNV" sends a song to the missing list; choosing rows confirms the link
        r = self._match({"link:INXY12300011": {"choice": "none", "data": {}}})
        self.assertIn("Pyaar Ka Geet", [m["title"] for m in r["missing"]])
        r = self._match({"link:INXY12300011": {"choice": "same", "data": {"rows": [3]}}})
        self.assertEqual([(l["row"], l.get("confirmed")) for m in r["matched"] if m["key"] == "link:INXY12300011" for l in m["links"]], [(3, True)])

    def test_versions_get_rows_of_their_own(self):
        from openpyxl import load_workbook
        from .engine import dataclean, export
        r = self._match()
        song = next(m for m in r["matched"] if m["song"]["title"] == "Pyaar Ka Geet")["song"]
        # The original is the song's LNV row; the lofi is a version of it, with its own recording
        self.assertEqual(song["original"]["isrcs"], ["INXY12300011"])
        self.assertEqual([(p["type"], p["isrcs"], p["lnv_row"]) for p in song["parts"]], [("Lofi", ["INXY12300010"], None)])
        self.assertNotIn("INXY12300010", [f["value"] for f in r["fills"]])   # a version's ISRC never fills the original's row
        plan = dataclean.lnv_versions(r, self.master["songs"])
        self.assertEqual([(v["title"], v["original"]["title"], v["original"]["album"], v["original"]["row"]) for v in plan["rows"]],
                         [("Pyaar Ka Geet - Lofi Flip", "Pyaar Ka Geet", "Film A", 2)])
        out = f"{self.tmp}/final.xlsx"
        with open(out, "wb") as f:
            f.write(export.final_report(f"{self.tmp}/lnv.xlsx", dsp={"fills": [], "adds": [], "repeats": [], "source": "Muso", "versions": plan}))
        rows = [list(x) for x in load_workbook(out).active.iter_rows(values_only=True)]
        head = rows[0]
        added = next(x for x in rows if x[1] == "Pyaar Ka Geet - Lofi Flip")
        self.assertEqual((added[head.index("ISRC")], added[head.index("Original Work")], added[head.index("Original Movie / Album")]),
                         ("INXY12300010", "Pyaar Ka Geet", "Film A"))
        # An LNV row that already is the version is linked to it, named, and never added again
        lnv = f"{self.tmp}/lnv_lofi.xlsx"
        _lnv_file(lnv, LNV_ROWS + [("Pyaar Ka Geet Lofi", None, "Lofi Hits", "Ravi Kumar Verma", "Anand Bakshi")])
        from .engine.master import parse_master
        master = parse_master(lnv)
        from .engine.songmerge import analyse, songs
        merge = analyse(self.dsp["rows"])
        groups = songs(merge, {f"merge:{k}": {"choice": "accepted"} for k in merge["items"]})
        r = dataclean.apply_decisions(dataclean.match(master, self.dsp, CLIENT, groups=groups), {})
        song = next(m for m in r["matched"] if m["song"]["title"] == "Pyaar Ka Geet")
        self.assertEqual(sorted(l["row"] for l in song["links"]), [2, 3])
        plan = dataclean.lnv_versions(r, master["songs"])
        self.assertEqual((plan["rows"], [(v["row"], v["original"]["row"]) for v in plan["named"]]), ([], [(7, 2)]))
        self.assertNotIn(7, [c["row"] for c in song["song"]["near"]])   # never offered as the song itself
        # The reviewer says row 7 is not this version: it is added as a new row, and row 7 is left as it is
        decisions = {"version:INXY12300010": {"choice": "none", "data": {"rows": [7]}}}
        aliases, links = dataclean.learned(decisions)
        r = dataclean.apply_decisions(dataclean.match(master, self.dsp, CLIENT, aliases, links, groups), decisions)
        plan = dataclean.lnv_versions(r, master["songs"])
        self.assertEqual(([v["title"] for v in plan["rows"]], plan["named"]), (["Pyaar Ka Geet - Lofi Flip"], []))

    def test_song_family_key(self):
        """Step 2 shows every song one name holds on one screen: remixes, lofis, parts and film tags share the key."""
        from .engine.review import _family
        base = _family("Maula Mere Maula")
        for t in ("Maula Mere Maula - Stutter", "Maula Mere Maula, Pt. 3", "Maula Mere Maula Lofi Sad Mix",
                  'Maula Mere Maula (From "Anwar") - Remix', "Maula Mere Maula - LoFi"):
            self.assertEqual(_family(t), base, t)
        self.assertNotEqual(_family("Tum Hi Ho"), base)
        self.assertIsNone(_family("Bollywood Medley"))

    def test_map_onto_exact_song_and_titles(self):
        """A recording mapped onto an exactly matched song leaves its own song and becomes that song's version (a row
        of its own naming the song's LNV row); the titles the reviewer chose land where each recording goes."""
        from openpyxl import load_workbook
        from .engine import dataclean, export
        from .engine.songmerge import analyse, moved_rows, moves, songs
        merge = analyse(self.dsp["rows"])
        # sheet rows: 2 Lofi Flip · 3 Pyaar Ka Geet · 4 Dil Ki Baat · 5 Brand New Hit
        decisions = {f"merge:{k}": {"choice": "accepted"} for k in merge["items"]}
        decisions["map:5"] = {"choice": "join", "data": {"to": 3, "row": 2, "title": "Pyaar Ka Geet", "from": "Brand New Hit"}}
        decisions["map:4"] = {"choice": "join", "data": {"to": 5}}   # onto a recording that is itself mapped: ignored
        self.assertEqual(list(moves(decisions)), [5])
        r = dataclean.apply_decisions(dataclean.match(self.master, self.dsp, CLIENT, groups=songs(merge, decisions),
                                                      moved=moved_rows(merge, decisions)), decisions)
        self.assertNotIn("Brand New Hit", [m["title"] for m in r["missing"]])
        song = next(m for m in r["matched"] if m["song"]["title"] == "Pyaar Ka Geet")
        self.assertEqual(song["song"]["key"], "INXY12300011")   # the song keeps its main recording, and its answers
        self.assertIn(2, [l["row"] for l in song["links"]])
        plan = dataclean.lnv_versions(r, self.master["songs"])
        self.assertEqual(sorted((v["title"], v["original"]["row"]) for v in plan["rows"]),
                         [("Brand New Hit", 2), ("Pyaar Ka Geet - Lofi Flip", 2)])

        # titles: the main version takes a typed title on its LNV row; the mapped recording's row takes the main's
        decisions["title:3"] = {"choice": "custom", "data": {"value": "Pyaar Ka Geet (Film A)"}}
        decisions["title:5"] = {"choice": "main", "data": {"value": "Pyaar Ka Geet (Film A)"}}
        decisions["title:4"] = {"choice": "custom", "data": {"value": "  "}}   # blank: no title
        titles = dataclean.titles_of(decisions)
        self.assertEqual(sorted(titles), [3, 5])
        picks, plan, adds = dataclean.apply_titles(r, plan, [], titles)
        self.assertIn({"row": 2, "field": "Title", "value": "Pyaar Ka Geet (Film A)", "why": "a title typed by the reviewer, chosen by the reviewer"}, picks)
        self.assertEqual(sorted((v["title"], v["original"]["title"]) for v in plan["rows"]),
                         [("Pyaar Ka Geet (Film A)", "Pyaar Ka Geet (Film A)"), ("Pyaar Ka Geet - Lofi Flip", "Pyaar Ka Geet (Film A)")])
        out = f"{self.tmp}/titles.xlsx"
        with open(out, "wb") as f:
            f.write(export.final_report(f"{self.tmp}/lnv.xlsx", dsp={"fills": [], "adds": adds, "repeats": [], "source": "Muso",
                                                                       "versions": plan, "picks": picks}))
        rows = [list(x) for x in load_workbook(out).active.iter_rows(values_only=True)]
        self.assertEqual(rows[1][1], "Pyaar Ka Geet (Film A)")
        # every LNV row the song is linked to, and the mapped recording's own row
        self.assertEqual(sum(1 for x in rows if x[1] == "Pyaar Ka Geet (Film A)"), len(song["links"]) + 1)


@override_settings(MEDIA_ROOT=tempfile.mkdtemp())
class DataCleanApiTests(TestCase):
    def setUp(self):
        from django.contrib.auth import get_user_model
        from django.core.cache import cache
        cache.clear()
        self.client.force_login(get_user_model().objects.create_user("team@example.com", "team@example.com", "x"))
        self.tmp = tempfile.mkdtemp()
        _lnv_file(f"{self.tmp}/lnv.xlsx", LNV_ROWS)
        _muso_file(f"{self.tmp}/muso.xlsx", MUSO_ROWS)

    def tearDown(self):
        from django.conf import settings
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _post(self, url, path):
        with open(path, "rb") as fh:
            return self.client.post(url, {"file": fh})

    def test_upload_review_export(self):
        cid = self.client.post("/api/clients/", {"name": CLIENT}, content_type="application/json").json()["id"]
        url = f"/api/clients/{cid}/clean/"
        self.assertIsNone(self.client.get(url).json()["result"])
        self.assertEqual(self._post(f"/api/clients/{cid}/master/", f"{self.tmp}/lnv.xlsx").status_code, 200)
        # The LNV dropped here by mistake is recognised
        res = self._post(url, f"{self.tmp}/lnv.xlsx")
        self.assertEqual(res.status_code, 422)
        self.assertIn("LNV master", res.json()["error"])
        res = self._post(url, f"{self.tmp}/muso.xlsx")
        self.assertEqual(res.status_code, 200, res.content[:300])
        body = res.json()
        self.assertEqual(body["dsp"]["source"], "Muso")
        self.assertEqual(body["result"]["summary"]["matched"], 1)   # Pyaar Ka Geet; Dil Ki Baat waits for "Malik Varma = Malik Verma"?

        dup = next(c for c in body["result"]["duplicates"] if c["kind"] == "duplicate")
        res = self.client.post(f"{url}decisions/", {"items": [
            {"key": dup["key"], "choice": "duplicate", "data": {"keep": dup["keeper"]}},
            {"key": "missing:INXY12300099", "choice": "add"},
        ]}, content_type="application/json")
        self.assertEqual(res.status_code, 200)
        r = res.json()["result"]
        self.assertEqual(next(c for c in r["duplicates"] if c["key"] == dup["key"])["decision"]["choice"], "duplicate")
        # Dil Ki Baat waits for a person: a possible match – same ISRC, the writer spelled differently
        self.assertEqual((r["open"]["missing"], r["open"]["check"]), (0, 1), [(m["key"], m.get("decision")) for m in r["missing"]])
        bad = self.client.post(f"{url}decisions/", {"items": [{"key": "missing:X", "choice": "duplicate"}]}, content_type="application/json")
        self.assertEqual(bad.status_code, 400)
        # Client page shows the open counts
        self.assertEqual(self.client.get(f"/api/clients/{cid}/").json()["clean"]["summary"]["open"]["check"], 1)

        res = self.client.get(f"{url}export/")
        self.assertEqual(res.status_code, 200)
        wb = openpyxl.load_workbook(io.BytesIO(res.content))
        self.assertIn("LNV duplicates", wb.sheetnames)
        self.assertIn("Duplicate – keep", " ".join(str(c.value) for row in wb["LNV duplicates"].iter_rows() for c in row))

        # A new LNV: decisions on its rows go, the missing-song decision stays
        self._post(f"/api/clients/{cid}/master/", f"{self.tmp}/lnv.xlsx")
        keys = set(Client.objects.get(pk=cid).clean_decisions.values_list("key", flat=True))
        self.assertEqual(keys, {"missing:INXY12300099"})

    def test_typed_values_and_mapping_a_new_song_onto_an_lnv_row(self):
        """v1.3: a value the reviewer typed goes into the downloaded LNV, said so in MRM changes; a lyricist picked
        replaces the LNV's; a song not in the LNV linked to an LNV row by the reviewer counts as in the LNV (Songs);
        each record carries its link."""
        cid = self.client.post("/api/clients/", {"name": CLIENT}, content_type="application/json").json()["id"]
        self.assertEqual(self._post(f"/api/clients/{cid}/master/", f"{self.tmp}/lnv.xlsx").status_code, 200)
        self.assertEqual(self._post(f"/api/clients/{cid}/clean/", f"{self.tmp}/muso.xlsx").status_code, 200)
        res = self.client.post(f"/api/clients/{cid}/clean/decisions/", {"quiet": True, "items": [
            {"key": "pick:2:Film / album", "choice": "custom", "data": {"value": "Typed Film"}},
            {"key": "pick:4:Lyricist", "choice": "muso", "data": {"value": ["Malik Varma"]}},
            # "Brand New Hit" is not in the LNV: the reviewer maps it onto LNV row 6 as the same song
            {"key": "link:INXY12300099", "choice": "same", "data": {"rows": [6]}},
        ]}, content_type="application/json")
        self.assertEqual(res.status_code, 200, res.content[:300])

        step = self.client.get(f"/api/clients/{cid}/steps/?step=1").json()["step"]
        hit = next(c for c in step["cases"] if c["title"] == "Brand New Hit")
        self.assertEqual((hit["answer"]["choice"], hit["answer"]["rows"], hit["answer"]["by"]), ("same", [6], "you"))
        from .engine import review
        self.assertEqual(review._level(hit), "possible")   # listed under Songs, no longer under Not in the LNV
        self.assertTrue(hit["muso"][0]["link"].startswith("https://open.spotify.com/track/"))
        self.assertIn("link", hit["lnv"][0])

        res = self.client.get(f"/api/clients/{cid}/steps/lnv/")
        self.assertEqual(res.status_code, 200)
        wb = openpyxl.load_workbook(io.BytesIO(res.content))
        changes = [" ".join(str(c) for c in r if c is not None) for r in wb["MRM changes"].iter_rows(values_only=True)]
        self.assertTrue(any("Typed Film – typed by the reviewer" in c for c in changes), changes)
        self.assertTrue(any("Lyricist changed" in c and "Malik Varma" in c for c in changes), changes)
        cells = [str(c) for r in wb.active.iter_rows(values_only=True) for c in r if c is not None]
        self.assertIn("Typed Film", cells)
        self.assertIn("Malik Varma", cells)
        # linked to row 6: not added as a new row – its name is that row's alternative work name (v1.7)
        rows = [[c for c in r] for r in wb.active.iter_rows(values_only=True)]
        self.assertNotIn("Brand New Hit", [r[rows[0].index("Work*")] for r in rows])
        self.assertEqual([r[rows[0].index("Alternate Work")] for r in rows].count("Brand New Hit"), 1)

    def test_lnv_link(self):
        from .engine.steps import lnv_link
        self.assertEqual(lnv_link({"website": "open.spotify.com/track/abc"}), "https://open.spotify.com/track/abc")
        self.assertEqual(lnv_link({"website": "", "spotify_id": "2HNG9q8rXbnijbPTwCMgsb"}), "https://open.spotify.com/track/2HNG9q8rXbnijbPTwCMgsb")
        self.assertEqual(lnv_link({"spotify_id": "not an id"}), "")


class XlsxReaderTests(TestCase):
    """The fast reader gives what openpyxl gives, without walking the formatted empty cells."""

    def test_same_values_as_openpyxl(self):
        from datetime import date, time
        from .engine.xlsx import Book, read_rows
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["Title", "Year", "Share", "Released", "Length", "Note", "Flag"])
        ws.append(["Pyaar & Geet <1>", 1977, 12.5, date(1990, 5, 1), time(0, 4, 21), "line one\r\nline two", True])
        ws.append([])
        ws.append(["Last", None, None, None, None, None, None])
        for col in range(1, 400):   # formatting on empty cells, as LNV exports carry
            ws.cell(row=6, column=col).number_format = "0.00"
        wb.create_sheet("Second").append(["only", "here"])
        wb.save(f"{tmp}/t.xlsx")

        ref = openpyxl.load_workbook(f"{tmp}/t.xlsx", read_only=True, data_only=True)
        ws = ref.worksheets[0]
        ws.reset_dimensions()
        expected = [tuple(r) for r in ws.iter_rows(values_only=True)]
        def trim(rows):   # openpyxl ends a row at its last formatted cell, the reader at the widest value
            out = [list(r) for r in rows if any(v is not None for v in r)]
            for r in out:
                while r and r[-1] is None:
                    r.pop()
            return out
        got = read_rows(f"{tmp}/t.xlsx")
        self.assertEqual(trim(got), trim(expected))
        self.assertEqual(got[1][5], "line one\nline two")
        self.assertEqual(got[2], ())
        self.assertEqual(len(got), 4)
        with Book(f"{tmp}/t.xlsx") as book:
            self.assertEqual(book.sheetnames, ["Sheet", "Second"])
            self.assertEqual(book.rows("Second"), [("only", "here")])


class StepsApiTests(TestCase):
    """The consolidate flow: 1 clean the DSP sheet · 2 the DSP songs against the LNV · 3 the LNV against IPRS."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from django.core.cache import cache
        cache.clear()
        self.client.force_login(get_user_model().objects.create_user("team@example.com", "team@example.com", "x"))
        self.tmp = tempfile.mkdtemp()
        _lnv_file(f"{self.tmp}/lnv.xlsx", LNV_ROWS)
        _muso_file(f"{self.tmp}/muso.xlsx", MUSO_ROWS)

    def tearDown(self):
        from django.conf import settings
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _post(self, url, path):
        with open(path, "rb") as fh:
            return self.client.post(url, {"file": fh})

    def test_clean_rows_show_every_filled_column_of_a_version(self):
        cid = self.client.post("/api/clients/", {"name": CLIENT}, content_type="application/json").json()["id"]
        url = f"/api/clients/{cid}/clean/rows/?rows=3,999,x"
        self.assertEqual(self.client.get(url).status_code, 409)
        self._post(f"/api/clients/{cid}/master/", f"{self.tmp}/lnv.xlsx")
        self._post(f"/api/clients/{cid}/clean/", f"{self.tmp}/muso.xlsx")
        rows = self.client.get(url).json()["rows"]
        self.assertEqual([r["row"] for r in rows], [3])
        values = [f["value"] for f in rows[0]["fields"]]
        self.assertIn("Pyaar Ka Geet", values)
        self.assertIn("INXY12300011", values)
        self.assertNotIn("", values)

    def test_clean_then_compare_with_the_lnv(self):
        cid = self.client.post("/api/clients/", {"name": CLIENT}, content_type="application/json").json()["id"]
        url = f"/api/clients/{cid}/steps/"
        self.assertEqual(self.client.get(f"{url}?step=1").json()["counts"], {"1": None, "3": None})
        self._post(f"/api/clients/{cid}/master/", f"{self.tmp}/lnv.xlsx")
        self._post(f"/api/clients/{cid}/clean/", f"{self.tmp}/muso.xlsx")
        decide = lambda *items: self.client.post(f"/api/clients/{cid}/clean/decisions/", {"items": list(items), "quiet": True},
                                                 content_type="application/json").json()
        cases = lambda: {c["kind"] + ":" + c["title"]: c for c in self.client.get(f"{url}?step=1").json()["step"]["cases"]}

        # One case per song, the Muso versions and the LNV rows in one block, the app's answer selected:
        # the original and its lofi flip are one song (same writers), and that song is LNV rows 2 and 3.
        one = self.client.get(f"{url}?step=1").json()
        c = one["counts"]["1"]
        self.assertEqual((c["rows"], c["recordings"], c["songs"], c["in_lnv"], c["adding"]), (4, 4, 3, 1, 1))
        got = cases()
        self.assertEqual(sorted(got), ["check:Dil Ki Baat", "missing:Brand New Hit", "names:Malik Varma  ·  MALIK VERMA",
                                       "twice:Dil Ki Baat", "twice:Pyaar Ka Geet", "versions:Pyaar Ka Geet"])
        # Dil Ki Baat: a possible match (same ISRC, the writer spelled differently) – shown, not linked; the same
        # recording (ISRC, name, album), so the app proposes row 4 for the reviewer to confirm – nothing saved yet
        dil = got["check:Dil Ki Baat"]
        self.assertEqual(([r["row"] for r in dil["lnv"]], dil["lnv"][0]["check"]["level"], dil["answer"]["choice"]), ([4, 5], "possible", "same"))
        self.assertEqual((dil["answer"]["by"], dil["answer"]["rows"], dil["done"]), ("app", [4], False))
        self.assertIn("Different writers", [w["text"] for w in dil["lnv"][0]["why"]])
        # "Same person", answered once for every client: Dil Ki Baat is LNV row 4 now
        name = got["names:Malik Varma  ·  MALIK VERMA"]
        decide({"key": name["answer"]["key"], "choice": "same", "data": name["names"]})
        got = cases()
        self.assertTrue(got["names:Malik Varma  ·  MALIK VERMA"]["done"])
        self.assertEqual((got["check:Dil Ki Baat"]["auto"], got["check:Dil Ki Baat"]["answer"]["rows"]), (True, [4]))   # exact now
        self.assertEqual(self.client.get(f"{url}?step=1").json()["counts"]["1"]["in_lnv"], 2)
        v = got["versions:Pyaar Ka Geet"]
        self.assertEqual([(r["fields"]["Title"], r["version"], r["in"]) for r in v["muso"]],
                         [("Pyaar Ka Geet", "Original", True), ("Pyaar Ka Geet - Lofi Flip", "Lofi", True)])
        self.assertEqual(([r["row"] for r in v["lnv"]], v["answer"]["choice"], v["answer"]["by"], v["done"]), ([2, 3], "same", "app", False))
        # one case per song: the merge items it is made of travel with it, each with its recordings
        self.assertEqual([(m["key"], m["ids"]) for m in v["merge"]["items"]], [("merge:G2", [3, 2])])
        self.assertEqual(got["missing:Brand New Hit"]["answer"]["choice"], "add")
        self.assertEqual(c["open"], 6)

        # Confirm with the lofi unticked and only row 2: the lofi becomes a song of its own.
        lofi = v["muso"][1]["id"]
        self.assertEqual(decide({"key": v["merge"]["key"], "choice": "accepted", "data": {"excluded": [lofi]}},
                                {"key": "link:" + v["answer"]["song"], "choice": "same", "data": {"rows": [2]}}), {"saved": 2})
        one = self.client.get(f"{url}?step=1").json()
        self.assertEqual(one["counts"]["1"]["songs"], 4)
        v = next(x for x in one["step"]["cases"] if x["kind"] == "versions")
        self.assertEqual(([r["in"] for r in v["muso"]], v["answer"]["rows"], v["done"]), ([True, False], [2], True))
        # "Not the client's song" on the one only Muso has
        hit = cases()["missing:Brand New Hit"]
        decide({"key": "link:" + hit["answer"]["song"], "choice": "none"}, {"key": "missing:" + hit["answer"]["song"], "choice": "not_ours"})
        one = self.client.get(f"{url}?step=1").json()
        # the lofi on its own is a new recording of LNV row 2 (same title and writers): added, naming that original
        self.assertEqual((one["counts"]["1"]["adding"], one["counts"]["1"]["not_ours"]), (1, 1))
        lofi_case = next(x for x in one["step"]["cases"] if x["title"] == "Pyaar Ka Geet - Lofi Flip")
        self.assertEqual((lofi_case["origin"]["row"], lofi_case["answer"]["choice"]), (2, "add"))
        self.assertTrue(next(x for x in one["step"]["cases"] if x["title"] == "Brand New Hit")["done"])

        # The LNV updated with the answers: the lofi (its own song now) and nothing else is added; the change log says so
        res = self.client.get(f"/api/clients/{cid}/steps/lnv/")
        self.assertEqual(res.status_code, 200)
        log = openpyxl.load_workbook(io.BytesIO(res.content))["MRM changes"]
        self.assertNotIn("Brand New Hit", [r[1] for r in log.iter_rows(min_row=2, values_only=True)])
        # the rows A–Z, each song's rows together under its main version (the oldest Muso recording with no tag), with
        # the main version's row and title, and the row each one had in the uploaded LNV
        sheet = openpyxl.load_workbook(io.BytesIO(res.content)).worksheets[0]
        head = [c.value for c in sheet[1]]
        got = [(r[1], r[head.index("Main version row")], r[head.index("Main version title")], r[head.index("Row in the uploaded LNV")])
               for r in sheet.iter_rows(min_row=2, values_only=True) if r[1]]
        self.assertEqual(got, [("Dil Ki Baat", 2, "Dil Ki Baat", 4), ("Neend Na Aaye", 3, "Neend Na Aaye", 6),
                               ("Pyaar Ka Geet", 4, "Pyaar Ka Geet", 2), ("Pyaar Ka Geet - Lofi Flip", 4, "Pyaar Ka Geet", None),
                               ("Pyar Ka Geet", 4, "Pyaar Ka Geet", 3), ("Some Other Song", 7, "Some Other Song", 5)])
        # the lofi's new row names its original, uploaded LNV row 2 – row 4 once sorted; the list's rows are the new ones
        self.assertIn(("Pyaar Ka Geet - Lofi Flip", "Added version", "Lofi of 'Pyaar Ka Geet' (row 4)"), [(r[1], r[2], r[3].split(";")[0]) for r in log.iter_rows(min_row=2, values_only=True)])
        # A value the reviewer took from Muso over the LNV's own goes into that LNV cell
        self.assertEqual(decide({"key": "pick:4:Title", "choice": "muso", "data": {"value": "Dil Ki Baat (Muso)"}}), {"saved": 1})
        self.assertEqual(self.client.get(f"{url}?step=1").json()["step"]["picks"], {"pick:4:Title": "Dil Ki Baat (Muso)"})
        book = openpyxl.load_workbook(io.BytesIO(self.client.get(f"/api/clients/{cid}/steps/lnv/").content))
        self.assertEqual(book.worksheets[0].cell(2, 2).value, "Dil Ki Baat (Muso)")   # uploaded row 4, first A–Z
        self.assertIn((2, "Title changed"), [(r[0], r[2]) for r in book["MRM changes"].iter_rows(min_row=2, values_only=True)])
        res = self.client.get(f"/api/clients/{cid}/steps/merged/")
        self.assertEqual(res.status_code, 200)
        wb = openpyxl.load_workbook(io.BytesIO(res.content))
        self.assertEqual((wb.sheetnames, wb["Merged Songs"].max_row, wb["All Songs"].max_row), (["Merged Songs", "All Songs"], 5, 5))
        # A new export names other rows: the merge answers go.
        self._post(f"/api/clients/{cid}/clean/", f"{self.tmp}/muso.xlsx")
        v = cases()["versions:Pyaar Ka Geet"]
        self.assertEqual((v["merge"]["status"], [r["in"] for r in v["muso"]]), ("pending", [True, True]))
        self.assertEqual(self.client.get(f"{url}?row=4").json()["records"][0]["fields"]["Title"], "Dil Ki Baat")

    @needs_samples
    def test_with_the_iprs_report(self):
        cid = self.client.post("/api/clients/", {"name": "Dhanya Suresh", "ipi": "1076531558"}, content_type="application/json").json()["id"]
        self._post(f"/api/clients/{cid}/master/", MASTER)
        self.client.post(f"/api/clients/{cid}/societies/", {"societies": ["IPRS"]}, content_type="application/json")
        run = self.client.post(f"/api/clients/{cid}/societies/IPRS/", {}, content_type="application/json").json()["id"]
        res = self._post(f"/api/runs/{run}/files/iprs/", IPRS)
        self.assertEqual(res.status_code, 200)
        body = self.client.get(f"/api/clients/{cid}/steps/?step=3").json()
        self.assertEqual(body["run"], run)
        three = body["step"]
        self.assertEqual(body["counts"]["3"]["register"], 15)
        self.assertEqual(sum(body["counts"]["3"][k] for k in ("matched", "amend", "register")), 67)
        self.assertTrue(all(a["records"][0]["src"] == "LNV" and a["records"][1]["src"] == "IPRS" for a in three["amend"]))
        self.assertIsNone(body["counts"]["1"])   # no Muso export yet

    def test_stage1_completed_makes_the_stage2_lnv(self):
        """Muso vs LNV marked completed: its result (the stage 1 LNV) is kept as the stage 2 LNV, which IPRS is checked
        against; a corrected one can be uploaded in its place. The stage 1 LNV downloads A–Z by song or by album."""
        cid = self.client.post("/api/clients/", {"name": CLIENT}, content_type="application/json").json()["id"]
        self._post(f"/api/clients/{cid}/master/", f"{self.tmp}/lnv.xlsx")
        detail = self.client.get(f"/api/clients/{cid}/").json()
        self.assertEqual(detail["journey"]["step"], 1)   # the LNV and the Muso export – no IPRS report asked for
        self._post(f"/api/clients/{cid}/clean/", f"{self.tmp}/muso.xlsx")
        journey = self.client.get(f"/api/clients/{cid}/").json()["journey"]
        self.assertEqual((journey["step"], journey["stage1"], journey["lnv2"]), (2, None, None))
        self.assertEqual(self.client.get(f"/api/clients/{cid}/stage2/").status_code, 404)

        titles = lambda content: [r[1] for r in openpyxl.load_workbook(io.BytesIO(content)).worksheets[0].iter_rows(min_row=2, values_only=True) if r[1]]
        by_song = self.client.get(f"/api/clients/{cid}/steps/lnv/?stage=1")
        self.assertEqual(by_song.status_code, 200)
        self.assertIn("LNV_stage1_", by_song["Content-Disposition"])
        self.assertEqual(titles(by_song.content)[:2], ["Brand New Hit", "Dil Ki Baat"])
        by_album = self.client.get(f"/api/clients/{cid}/steps/lnv/?stage=1&order=album")
        self.assertIn("_by_album_", by_album["Content-Disposition"])
        book = openpyxl.load_workbook(io.BytesIO(by_album.content))
        head = [c.value for c in book.worksheets[0][1]]
        albums = [r[head.index("Movie Name *")] for r in book.worksheets[0].iter_rows(min_row=2, values_only=True) if r[1]]
        self.assertEqual(albums, sorted(albums, key=lambda a: (a or "~").lower()))
        self.assertEqual(titles(by_album.content)[-1], "Some Other Song")   # Film X
        self.assertEqual(next(book["MRM changes"].iter_rows(min_row=2, values_only=True))[2], "Sorted A–Z by album")

        done = self.client.post(f"/api/clients/{cid}/stage1/", {"done": True}, content_type="application/json").json()
        self.assertEqual(done["client"]["stage1"]["by"], "team@example.com")
        self.assertEqual((done["journey"]["step"], done["journey"]["lnv2"]["origin"], done["journey"]["lnv2"]["stage"]), (3, "stage1", 2))
        lnv2 = self.client.get(f"/api/clients/{cid}/stage2/")
        self.assertEqual(lnv2.status_code, 200)
        self.assertEqual(titles(lnv2.content), titles(by_song.content))
        steps_now = self.client.get(f"/api/clients/{cid}/steps/?step=1").json()
        self.assertEqual((steps_now["files"]["lnv2"]["origin"], steps_now["stage1"]["changed"]), ("stage1", False))
        # step 2 still reads the LNV as uploaded
        self.assertEqual(self.client.get(f"/api/clients/{cid}/steps/?row=4").json()["records"][0]["fields"]["Title"], "Dil Ki Baat")
        # an answer given after completing: the stage 2 LNV does not have it
        self.client.post(f"/api/clients/{cid}/clean/decisions/", {"items": [{"key": "pick:4:Year", "choice": "custom", "data": {"value": "1999"}}],
                                                                  "quiet": True}, content_type="application/json")
        self.assertTrue(self.client.get(f"/api/clients/{cid}/steps/?step=1").json()["stage1"]["changed"])
        # no IPRS report yet: the final LNV is the stage 2 LNV
        self.assertEqual(titles(self.client.get(f"/api/clients/{cid}/steps/lnv/").content), titles(lnv2.content))

        # a corrected stage 2 LNV uploaded in its place; a file that is no LNV is refused
        fixed = f"{self.tmp}/fixed.xlsx"
        with open(fixed, "wb") as fh:
            fh.write(lnv2.content)
        up = self._post(f"/api/clients/{cid}/stage2/", fixed)
        self.assertEqual(up.status_code, 200, up.content[:300])
        self.assertEqual((up.json()["journey"]["lnv2"]["origin"], up.json()["journey"]["lnv2"]["name"]), ("upload", "fixed.xlsx"))
        self.assertEqual(self._post(f"/api/clients/{cid}/stage2/", f"{self.tmp}/muso.xlsx").status_code, 422)
        self.assertEqual(self.client.get(f"/api/clients/{cid}/stage2/")["Content-Disposition"], 'attachment; filename="fixed.xlsx"')

        # opened again: back to step 2, the stage 2 LNV stays; a new LNV opens it again too
        back = self.client.post(f"/api/clients/{cid}/stage1/", {"done": False}, content_type="application/json").json()
        self.assertEqual((back["client"]["stage1"], back["journey"]["step"], back["journey"]["lnv2"]["name"]), (None, 2, "fixed.xlsx"))
        self.client.post(f"/api/clients/{cid}/stage1/", {"done": True}, content_type="application/json")
        self._post(f"/api/clients/{cid}/master/", f"{self.tmp}/lnv.xlsx")
        self.assertIsNone(self.client.get(f"/api/clients/{cid}/").json()["client"]["stage1"])

    def test_map_and_title_through_the_api(self):
        """Step 2's map and title answers: saved, shown on the step (the mapped recording under the song it joined,
        the title by recording id) and written into the final LNV."""
        cid = self.client.post("/api/clients/", {"name": CLIENT}, content_type="application/json").json()["id"]
        self._post(f"/api/clients/{cid}/master/", f"{self.tmp}/lnv.xlsx")
        self._post(f"/api/clients/{cid}/clean/", f"{self.tmp}/muso.xlsx")
        save = lambda items: self.client.post(f"/api/clients/{cid}/clean/decisions/", {"items": items, "quiet": True}, content_type="application/json")
        self.assertEqual(save([{"key": "map:5", "choice": "move"}]).status_code, 400)
        self.assertEqual(save([{"key": "map:5", "choice": "join", "data": {"to": 3, "row": 2, "title": "Pyaar Ka Geet", "from": "Brand New Hit"}},
                               {"key": "title:5", "choice": "custom", "data": {"value": "Brand New Hit (Remake)"}}]).status_code, 200)
        step = self.client.get(f"/api/clients/{cid}/steps/?step=1").json()["step"]
        self.assertEqual(step["titles"]["5"], {"mode": "custom", "value": "Brand New Hit (Remake)"})
        home = next(c for c in step["cases"] if c["title"] == "Pyaar Ka Geet")
        mapped = next(r for r in home["muso"] if r["id"] == 5)
        self.assertEqual(mapped["moved"], {"from": "Brand New Hit", "row": 2, "title": "Pyaar Ka Geet"})
        self.assertNotIn("Brand New Hit", [c["title"] for c in step["cases"]])
        res = self.client.get(f"/api/clients/{cid}/steps/lnv/")
        self.assertEqual(res.status_code, 200, res.content[:300])
        rows = [list(x) for x in openpyxl.load_workbook(io.BytesIO(res.content)).active.iter_rows(values_only=True)]
        head = rows[0]
        added = next(x for x in rows if x[1] == "Brand New Hit (Remake)")
        self.assertEqual(added[head.index("Original Work")], "Pyaar Ka Geet")


# ---------------------------------------------------------------- v1.5: the IPI / CAE list, new rows and deleted songs

IPI_HEADER = ["SR_NO", "INTERNAL NO", "LOCAL INTERNAL NO", "NAME", "IPI NO", "BASE NO", "NAME TYPE", "ROLE", None]
IPI_ROWS = [
    (1, 100, 100, "RAVI KUMAR,VERMA", "00111111111", "I-000000001-1", "PA", "CA"),
    (None, 101, None, "RKV", "00111111112", "I-000000001-1", "PP", "CA"),
    None,
    (2, 200, 200, "MALIK,VERMA", 222222221, "I-000000002-2", "PA", "A"),   # a number, as Excel keeps it
    (None, 201, None, "MALIK VARMA", "00222222222", "I-000000002-2", "PP", "A"),
    None,
    (3, 300, 300, "LATA DINANATH,MANGESHKAR", "00333333331", "I-000000003-3", "PA", "C"),
    (None, 301, None, "LATA MANGESHKAR", "00333333332", "I-000000003-3", "PP", "C"),
    None,
    (4, 400, 400, "PRITAM,CHAKRABORTY", "00444444441", "I-000000004-4", "PA", "C"),
    (None, 401, None, "PRITAM", "00444444442", "I-000000004-4", "PP", "C"),
    (None, 402, None, "JEET PRITAM", "00999999999", None, "PG", "C"),
    None,
    (5, 500, 500, "PRITAM,DAS", "00555555551", "I-000000005-5", "PA", "C"),
    (None, 501, None, "PRITAM", "00555555552", "I-000000005-5", "PP", "C"),
    (None, 402, None, "JEET PRITAM", "00999999999", None, "PG", "C"),
    None,
]


def _ipi_file(path, rows=IPI_ROWS):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "AllNameType"
    ws.append(IPI_HEADER)
    for r in rows:
        ws.append(list(r) if r else [None] * 8)
    wb.save(path)


class IpiEngineTests(TestCase):
    """The member list read block by block, and names found in it."""

    @classmethod
    def setUpTestData(cls):
        from .engine import ipi
        cls.tmp = tempfile.mkdtemp()
        _ipi_file(f"{cls.tmp}/list.xlsx")
        cls.entries = ipi.parse(f"{cls.tmp}/list.xlsx")
        cls.index = ipi.Index(cls.entries, 1)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)
        super().tearDownClass()

    def test_reads_members_and_their_names(self):
        from .engine import ipi
        self.assertEqual(len({e["member"] for e in self.entries}), 5)
        mithun = [e for e in self.entries if e["member"] == "I-000000002-2"]
        self.assertEqual([(e["name"], e["type"], e["ipi"]) for e in mithun],
                         [("MALIK,VERMA", "PA", "00222222221"), ("MALIK VARMA", "PP", "00222222222")])
        self.assertTrue(all(e["member_name"] == "Malik Verma" for e in mithun))
        # a group name under two members is kept once per member, never as one person
        self.assertEqual(sum(1 for e in self.entries if e["type"] == "PG"), 2)
        self.assertEqual(ipi.display("MITHUN NARESH,SHARMA"), "Mithun Naresh Sharma")
        self.assertEqual(ipi.display("RK"), "RK")
        self.assertEqual(ipi.display("SAREGAMA INDIA,LTD"), "Saregama India Ltd")

    def test_not_a_member_list(self):
        from .engine import ipi
        path = f"{self.tmp}/lnv.xlsx"
        _lnv_file(path, LNV_ROWS)
        with self.assertRaises(ipi.IpiFormatError):
            ipi.parse(path)

    def test_resolve_by_ipi_then_name(self):
        r = self.index.resolve("Malik Varma")
        self.assertEqual((r["name"], r["ipi"], r["via"]), ("Malik Verma", "00222222221", "name"))
        self.assertEqual(self.index.resolve("anything at all", "222222222")["name"], "Malik Verma")   # the CAE decides
        self.assertEqual(self.index.resolve("Ravi Kumar Verma (RKV)")["name"], "Ravi Kumar Verma")
        self.assertEqual(self.index.resolve("RKV")["name"], "Ravi Kumar Verma")
        self.assertIsNone(self.index.resolve("Gulzar"))
        # "Pritam" is two members: only the song's own CAE numbers say which
        self.assertIsNone(self.index.resolve("Pritam"))
        self.assertEqual(self.index.resolve("Pritam", "", self.index.hints(["00555555551"]))["name"], "Pritam Das")
        self.assertIsNone(self.index.resolve("Jeet Pritam"))   # a group's name is not one person
        names, ids, changed = self.index.names(["Malik Varma", "Malik Verma", "Gulzar"])
        self.assertEqual((names, ids, changed), (["Malik Verma", "Gulzar"], ["00222222221", ""], True))

    def test_aliases_for_the_match(self):
        from .engine import ipi
        from .engine.dataclean import person_key as pk
        master = {"songs": [{"authors": [{"name": "Anything", "ipi": "00222222222"}], "composers": [], "singers": [], "publishers": []}]}
        al = ipi.aliases(self.index, master, [{"lyricists": ["Malik Varma"], "composers": ["Pritam"], "singers": [], "publishers": []}])
        self.assertEqual(al[pk("Malik Varma")], pk("Malik Verma"))
        self.assertEqual(al[pk("Anything")], pk("Malik Verma"))
        self.assertNotIn(pk("Pritam"), al)
        self.assertEqual(ipi.aliases(ipi.EMPTY, master, []), {})


class IpiApiTests(TestCase):
    """The IPI / CAE List screen, and the list in step 2 and in the stage 1 LNV."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        from django.core.cache import cache
        cache.clear()
        User = get_user_model()
        self.user = User.objects.create_user("team@example.com", "team@example.com", "x")
        self.client.force_login(self.user)
        self.tmp = tempfile.mkdtemp()
        _ipi_file(f"{self.tmp}/list.xlsx")
        _lnv_file(f"{self.tmp}/lnv.xlsx", LNV_ROWS)
        _muso_file(f"{self.tmp}/muso.xlsx", MUSO_ROWS)

    def tearDown(self):
        from django.conf import settings
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _post(self, url, path, **extra):
        with open(path, "rb") as fh:
            return self.client.post(url, {"file": fh, **extra})

    def _client(self):
        cid = self.client.post("/api/clients/", {"name": CLIENT}, content_type="application/json").json()["id"]
        self.assertEqual(self._post(f"/api/clients/{cid}/master/", f"{self.tmp}/lnv.xlsx").status_code, 200)
        self.assertEqual(self._post(f"/api/clients/{cid}/clean/", f"{self.tmp}/muso.xlsx").status_code, 200)
        return cid

    def _lnv_cells(self, cid):
        res = self.client.get(f"/api/clients/{cid}/steps/lnv/?stage=1")
        self.assertEqual(res.status_code, 200)
        wb = openpyxl.load_workbook(io.BytesIO(res.content))
        sheet = [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]
        changes = [" ".join(str(c) for c in r if c is not None) for r in wb["MRM changes"].iter_rows(values_only=True)]
        return sheet, changes

    def test_upload_update_search_replace_clear(self):
        body = self.client.get("/api/ipi/").json()
        self.assertEqual((body["summary"]["names"], body["summary"]["version"], body["members"]), (0, 0, []))
        bad = self._post("/api/ipi/", f"{self.tmp}/lnv.xlsx")
        self.assertEqual(bad.status_code, 422)
        self.assertIn("not an IPI / CAE member list", bad.json()["error"])
        self.assertEqual(self.client.post("/api/ipi/", {}).status_code, 400)

        res = self._post("/api/ipi/", f"{self.tmp}/list.xlsx")
        self.assertEqual(res.status_code, 200, res.content[:300])
        body = res.json()
        self.assertEqual(body["upload"]["stats"]["added"], 12)
        self.assertEqual((body["summary"]["members"], body["summary"]["names"]), (5, 12))
        self.assertEqual(body["summary"]["types"], {"PA": 5, "PP": 5, "PG": 2})
        self.assertEqual([m["name"] for m in body["members"]], ["Lata Dinanath Mangeshkar", "Malik Verma", "Pritam Chakraborty", "Pritam Das", "Ravi Kumar Verma"])
        malik = next(m for m in body["members"] if m["name"] == "Malik Verma")
        self.assertEqual((malik["ipi"], [n["name"] for n in malik["names"]], malik["new"]), ("00222222221", ["MALIK,VERMA", "MALIK VARMA"], True))

        # search: by any name, by IPI digits, by words in another order
        self.assertEqual([m["name"] for m in self.client.get("/api/ipi/?q=varma").json()["members"]], ["Malik Verma"])
        self.assertEqual([m["name"] for m in self.client.get("/api/ipi/?q=33333").json()["members"]], ["Lata Dinanath Mangeshkar"])
        self.assertEqual([m["name"] for m in self.client.get("/api/ipi/?q=verma ravi").json()["members"]], ["Ravi Kumar Verma"])
        self.assertEqual(self.client.get("/api/ipi/?q=nobody").json()["total"], 0)

        # the same file again: nothing changes
        again = self._post("/api/ipi/", f"{self.tmp}/list.xlsx").json()["upload"]["stats"]
        self.assertEqual((again["added"], again["updated"], again["unchanged"]), (0, 0, 12))

        # a newer list: one member renamed, one new, one missing – the missing one stays unless replaced
        rows = [r for r in IPI_ROWS if not r or r[4] not in ("00555555551", "00555555552") and r[0] != 5]
        rows = [(r[0], r[1], r[2], "MALIK,VERMAA", *r[4:]) if r and r[3] == "MALIK,VERMA" else r for r in rows]
        rows += [(6, 600, 600, "GULZAR", "00666666661", "I-000000006-6", "PA", "CA"), (None, 601, None, "S S GULZAR", "00666666662", "I-000000006-6", "PP", "CA"), None]
        _ipi_file(f"{self.tmp}/list2.xlsx", rows)
        st = self._post("/api/ipi/", f"{self.tmp}/list2.xlsx").json()["upload"]["stats"]
        # both Malik names carry the new PA name; Pritam Das's three names are not in it (a group name left alone is no member)
        self.assertEqual((st["added"], st["updated"], st["kept"], st["removed"]), (2, 2, 3, 0), st)
        new = self.client.get("/api/ipi/?show=new").json()
        self.assertEqual([m["name"] for m in new["members"]], ["Gulzar"])
        upd = self.client.get("/api/ipi/?show=updated").json()
        self.assertEqual([m["name"] for m in upd["members"]], ["Malik Vermaa"])
        self.assertEqual(self.client.get("/api/ipi/lookup/?name=S S Gulzar").json()["found"]["name"], "Gulzar")

        st = self._post("/api/ipi/", f"{self.tmp}/list2.xlsx", replace="1").json()
        self.assertEqual((st["upload"]["kind"], st["upload"]["stats"]["removed"]), ("replace", 3))
        self.assertNotIn("Pritam Das", [m["name"] for m in st["members"]])
        self.assertEqual(len(st["summary"]["uploads"]), 4)

        # clearing: admins only
        self.assertEqual(self.client.delete("/api/ipi/").status_code, 403)
        self.user.is_staff = True
        self.user.save()
        body = self.client.delete("/api/ipi/").json()
        self.assertEqual((body["summary"]["names"], body["summary"]["latest"]["kind"]), (0, "clear"))
        self.assertIsNone(self.client.get("/api/ipi/lookup/?name=Gulzar").json()["found"])

    def test_the_list_in_step2_and_the_stage1_lnv(self):
        cid = self._client()
        step = self.client.get(f"/api/clients/{cid}/steps/?step=1").json()["step"]
        dil = next(c for c in step["cases"] if c["title"] == "Dil Ki Baat" and c["kind"] != "twice")
        self.assertNotEqual(dil["lnv"][0]["check"]["level"], "exact")   # "Malik Varma" / "MALIK VERMA": not one person yet
        self.assertNotIn("ipi", step)
        sheet, _ = self._lnv_cells(cid)
        self.assertIn("VERMA, RAVI KUMAR", [c for r in sheet for c in r])

        self.assertEqual(self._post("/api/ipi/", f"{self.tmp}/list.xlsx").status_code, 200)
        step = self.client.get(f"/api/clients/{cid}/steps/?step=1").json()["step"]
        self.assertEqual(step["ipi"]["members"], 5)
        # the list says Malik Varma is Malik Verma: the same writers now – an exact match
        dil = next(c for c in step["cases"] if c["title"] == "Dil Ki Baat" and c["kind"] != "twice")
        self.assertEqual(dil["lnv"][0]["check"]["level"], "exact")
        muso = dil["muso"][0]
        self.assertEqual(muso["ipi"]["Lyricist"], {"names": ["Malik Verma"], "ids": ["00222222221"]})
        self.assertEqual(muso["ipi"]["Singer"]["names"], ["Lata Dinanath Mangeshkar"])   # the singer under the member's PA name
        self.assertEqual(muso["fields"]["Singer"], ["Lata Mangeshkar"])                   # what Muso wrote is kept beside it

        # the stage 1 LNV: the LNV's names as the list has them, each with the member's IPI where the LNV had no CAE
        sheet, changes = self._lnv_cells(cid)
        head = sheet[0]
        at = lambda n: next(r for r in sheet[1:] if r[head.index("Row in the uploaded LNV")] == n)   # the download is A–Z
        row2 = at(2)
        self.assertEqual(row2[head.index("Composer Name 1")], "Ravi Kumar Verma")
        self.assertEqual(row2[head.index("Artist CAE 1")], 111111111)
        self.assertTrue(any("Composer – IPI / CAE list" in c and "VERMA, RAVI KUMAR → Ravi Kumar Verma" in c for c in changes), changes)
        self.assertNotIn("VERMA, RAVI KUMAR", [c for r in sheet for c in r])

        # the reviewer keeps the LNV's own spelling on one field, and takes the list's name (with its IPI) on another
        res = self.client.post(f"/api/clients/{cid}/clean/decisions/", {"quiet": True, "items": [
            {"key": "pick:2:Composer", "choice": "lnv", "data": {"value": ["VERMA, RAVI KUMAR"]}},
            {"key": "pick:6:Lyricist", "choice": "ipi", "data": {"value": ["Lata Dinanath Mangeshkar"], "ipis": ["00333333331"]}},
        ]}, content_type="application/json")
        self.assertEqual(res.status_code, 200, res.content[:300])
        step = self.client.get(f"/api/clients/{cid}/steps/?step=1").json()["step"]
        self.assertEqual(step["picks"]["pick:2:Composer"], ["VERMA, RAVI KUMAR"])
        self.assertEqual(step["counts"]["picks"], 1)   # keeping the LNV's own is no change
        sheet, changes = self._lnv_cells(cid)
        at = lambda n: next(r for r in sheet[1:] if r[head.index("Row in the uploaded LNV")] == n)
        self.assertEqual(at(2)[head.index("Composer Name 1")], "VERMA, RAVI KUMAR")
        self.assertIsNone(at(2)[head.index("Artist CAE 1")])
        self.assertEqual(at(2)[head.index("Author Name 1")], "BAKSHI, ANAND")   # a name the list does not know stays as written
        row6 = at(6)
        self.assertEqual((row6[head.index("Author Name 1")], row6[head.index("Artist CAE 2")]), ("Lata Dinanath Mangeshkar", 333333331))
        self.assertTrue(any("Lyricist changed" in c and "the name in the IPI / CAE list" in c for c in changes), changes)

    def test_deleted_songs_and_new_rows(self):
        """A song the reviewer deletes – one the LNV matched, or one not in it – puts nothing into the LNV and is listed
        as deleted; taken back, it is where the app had it. A song sent to a new row is added."""
        cid = self._client()
        url = f"/api/clients/{cid}/clean/decisions/"
        step = self.client.get(f"/api/clients/{cid}/steps/?step=1").json()["step"]
        pyaar = next(c for c in step["cases"] if c["title"] == "Pyaar Ka Geet")
        song = pyaar["answer"]["song"]
        rows = [r["row"] for r in pyaar["lnv"]]
        self.assertTrue(rows)
        res = self.client.post(url, {"quiet": True, "items": [
            {"key": f"link:{song}", "choice": "none", "data": {"rows": rows}}, {"key": f"missing:{song}", "choice": "deleted"},
            {"key": "link:INXY12300099", "choice": "none"}, {"key": "missing:INXY12300099", "choice": "deleted"},
        ]}, content_type="application/json")
        self.assertEqual(res.status_code, 200, res.content[:300])
        bad = self.client.post(url, {"items": [{"key": "pick:2:Title", "choice": "deleted"}]}, content_type="application/json")
        self.assertEqual(bad.status_code, 400)
        step = self.client.get(f"/api/clients/{cid}/steps/?step=1").json()["step"]
        gone = {c["title"]: c for c in step["cases"] if c["answer"].get("choice") == "deleted"}
        self.assertEqual(set(gone), {"Pyaar Ka Geet", "Brand New Hit"})
        self.assertTrue(all(c["answer"]["by"] == "you" and c["done"] for c in gone.values()))
        self.assertEqual(step["counts"]["deleted"], 2)
        from .engine import review
        # a deleted song keeps the LNV rows it matched: "Back to its match" and the Deleted songs list show them
        self.assertEqual([r["row"] for r in gone["Pyaar Ka Geet"]["was"]], rows)
        self.assertNotIn("was", gone["Brand New Hit"])
        fam = review.families(step["cases"])
        self.assertFalse(any(m["title"] in ("Pyaar Ka Geet", "Brand New Hit") for m in fam["mains"].values()))
        sheet, changes = self._lnv_cells(cid)
        cells = [c for r in sheet for c in r]
        self.assertNotIn("Brand New Hit", cells)
        self.assertNotIn("Pyaar Ka Geet - Lofi Flip", cells)   # its versions are not added either

        # taken back: Pyaar Ka Geet is the app's match again; Brand New Hit goes to a new row
        self.client.post(url, {"quiet": True, "items": [
            {"key": f"link:{song}", "choice": None}, {"key": f"missing:{song}", "choice": None},
            {"key": "missing:INXY12300099", "choice": "add"},
        ]}, content_type="application/json")
        step = self.client.get(f"/api/clients/{cid}/steps/?step=1").json()["step"]
        self.assertEqual(step["counts"]["deleted"], 0)
        back = next(c for c in step["cases"] if c["title"] == "Pyaar Ka Geet")
        self.assertEqual(sorted(back["answer"].get("rows") or []), sorted(pyaar["answer"].get("rows") or []))
        new = next(c for c in step["cases"] if c["title"] == "Brand New Hit")
        self.assertEqual((new["answer"]["choice"], new["answer"]["by"]), ("add", "you"))
        sheet, _ = self._lnv_cells(cid)
        self.assertIn("Brand New Hit", [c for r in sheet for c in r])


# ---------------------------------------------------------------- v1.6: add a song, undo, lists, synced ticks

def _full_lnv_file(path, rows):
    """An LNV with the columns a typed song fills: links, year, label, singers and publishers."""
    wb = openpyxl.Workbook()
    ws = wb.active
    head = ["SN", "Work*", "ISRC", "ISWC", "Movie Name *", "Label *", "Release Year(YYYY) *", "Language *", "VERSION *", "Website1", "Website2", "YouTube", "SPOTIFY ID"]
    n = 0
    for kind, slots in (("Singer Name", 2), ("Composer Name", 2), ("Author Name", 2), ("Publisher Name", 1)):
        for i in range(1, slots + 1):
            n += 1
            head += [f"{kind} {i}", f"Artist CAE {n}", f"Artist Joshua ID {n}", f"Role {n}", f"Performance share {n}", f"Mechanical share {n}"]
    ws.append(head + ["ISRC 1", "ISWC 1", "IPRS TUNECODE 1"])
    for k, (title, isrc, movie, composer, author) in enumerate(rows, start=1):
        r = [None] * len(head)
        r[0], r[1], r[2], r[4] = k, title, isrc, movie
        r[head.index("Composer Name 1")], r[head.index("Author Name 1")] = composer, author
        ws.append(r + [None, None, None])
    wb.save(path)


class SongWorkTests(TestCase):
    def setUp(self):
        from django.contrib.auth import get_user_model
        from django.core.cache import cache
        cache.clear()
        self.client.force_login(get_user_model().objects.create_user("team@example.com", "team@example.com", "x"))
        self.tmp = tempfile.mkdtemp()
        _full_lnv_file(f"{self.tmp}/lnv.xlsx", LNV_ROWS)
        _muso_file(f"{self.tmp}/muso.xlsx", MUSO_ROWS)
        self.cid = self.client.post("/api/clients/", {"name": CLIENT}, content_type="application/json").json()["id"]
        self._post(f"/api/clients/{self.cid}/master/", f"{self.tmp}/lnv.xlsx")
        self._post(f"/api/clients/{self.cid}/clean/", f"{self.tmp}/muso.xlsx")

    def tearDown(self):
        from django.conf import settings
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _post(self, url, path):
        with open(path, "rb") as fh:
            res = self.client.post(url, {"file": fh})
        self.assertEqual(res.status_code, 200, res.content[:300])

    def _send(self, url, body, status=200):
        res = self.client.post(f"/api/clients/{self.cid}/{url}", body, content_type="application/json")
        self.assertEqual(res.status_code, status, res.content[:400])
        return res.json()

    def _save(self, *items):
        return self._send("clean/decisions/", {"quiet": True, "items": list(items)})

    def _step(self):
        return self.client.get(f"/api/clients/{self.cid}/steps/?step=1").json()["step"]

    def _case(self, title, step=None):
        return next(c for c in (step or self._step())["cases"] if c["title"] == title and c["kind"] not in ("twice", "names"))

    def _changes(self):
        return self.client.get(f"/api/clients/{self.cid}/changes/").json()["changes"]

    def _lnv(self):
        res = self.client.get(f"/api/clients/{self.cid}/steps/lnv/?stage=1")
        self.assertEqual(res.status_code, 200)
        wb = openpyxl.load_workbook(io.BytesIO(res.content))
        rows = [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]
        return rows[0], rows[1:], [" ".join(str(c) for c in r if c is not None) for r in wb["MRM changes"].iter_rows(values_only=True)]

    TYPED = {"title": "Typed Song", "album": "Film T", "isrc": "in-xy1-23-00777", "to": "INXY12300011", "to_title": "Pyaar Ka Geet",
             "links": ["https://open.spotify.com/track/2HNG9q8rXbnijbPTwCMgsb?si=1", "https://youtu.be/abc", "https://music.apple.com/in/album/x/1"],
             "people": {"composers": [{"name": "Ravi Kumar Verma", "ipi": "111111111", "perf": "50", "mech": 50}],
                        "authors": [{"name": "Anand Bakshi", "ipi": "00333333331"}], "singers": [{"name": "Some Singer"}], "publishers": []},
             "more": {"LABEL": "Saregama", "RELEASEYEARYYYY": "2020", "NOTACOLUMN": "x"}}

    def test_linking_one_row_leaves_the_others_to_check(self):
        """One tick moves the numbers by one: the other rows on screen stay until each is answered – linked too, or said
        not to be the song."""
        c = self._case("Pyaar Ka Geet")
        rows = [r["row"] for r in c["lnv"]]
        self.assertEqual(rows, [2, 3])
        song = c["answer"]["song"]
        self._save({"key": f"link:{song}", "choice": "same", "data": {"rows": [2], "also": [3]}})
        c = self._case("Pyaar Ka Geet")
        self.assertEqual((c["answer"]["rows"], c["answer"]["also"], sorted(r["row"] for r in c["lnv"])), ([2], [3], [2, 3]))
        self.assertTrue(next(r for r in c["lnv"] if r["row"] == 3)["check"]["level"])
        # row 3 is not it: gone, the link stays
        self._save({"key": f"off:{song}", "choice": "rows", "data": {"rows": [3]}})
        c = self._case("Pyaar Ka Geet")
        self.assertEqual((c["answer"]["rows"], [r["row"] for r in c["lnv"]]), ([2], [2]))
        # an answer saved before this version has no "also": as it was
        self._save({"key": f"off:{song}", "choice": None}, {"key": f"link:{song}", "choice": "same", "data": {"rows": [2]}})
        self.assertEqual([r["row"] for r in self._case("Pyaar Ka Geet")["lnv"]], [2])

    def test_rows_a_song_is_not_are_never_matched_again(self):
        c = self._case("Pyaar Ka Geet")
        self._save({"key": f"off:{c['answer']['song']}", "choice": "rows", "data": {"rows": [2, 3]}})
        c = self._case("Pyaar Ka Geet")
        from .engine import review
        self.assertEqual((c["lnv"], review._level(c)), ([], "new"))

    def test_a_song_added_to_another_sits_under_its_name(self):
        self._save({"key": "link:INXY12300099", "choice": "same", "data": {"rows": [6]}},
                   {"key": "family:INXY12300099", "choice": "join", "data": {"to": "INXY12300011"}})
        step = self._step()
        pyaar, hit = self._case("Pyaar Ka Geet", step), self._case("Brand New Hit", step)
        self.assertEqual(hit["family"], pyaar["family"])
        self.assertEqual((hit["joined"]["to"], hit["joined"]["title"], hit["answer"]["rows"]), ("INXY12300011", "Pyaar Ka Geet", [6]))
        from .engine import review
        fam = review.families(step["cases"])
        self.assertEqual(fam["mains"][pyaar["family"]]["title"], "Pyaar Ka Geet")   # it never becomes the main version
        head, rows, _ = self._lnv()
        row6 = next(r for r in rows if r[head.index("Row in the uploaded LNV")] == 6)
        self.assertEqual(row6[head.index("Main version title")], "Pyaar Ka Geet")
        # taken back: under its own name
        self._save({"key": "family:INXY12300099", "choice": None})
        self.assertNotEqual(self._case("Brand New Hit")["family"], pyaar["family"])
        # a circle is no join at all, and does not hang
        self._save({"key": "family:INXY12300099", "choice": "join", "data": {"to": "INXY12300011"}},
                   {"key": "family:INXY12300011", "choice": "join", "data": {"to": "INXY12300099"}})
        self.assertTrue(self._step()["cases"])

    def test_typed_song(self):
        form = self.client.get(f"/api/clients/{self.cid}/songs/").json()
        self.assertEqual([m["key"] for m in form["more"]], ["ISWC", "LABEL", "RELEASEYEARYYYY", "LANGUAGE", "VERSION"])
        self.assertEqual(form["slots"], {"composers": 2, "authors": 2, "singers": 2, "publishers": 1})
        # every required field named
        bad = self._send("songs/", {"data": {"to": "INXY12300011"}}, 422)["fields"]
        self.assertEqual(set(bad), {"title", "album", "isrc", "links", "composers"})
        bad = self._send("songs/", {"data": {**self.TYPED, "isrc": "123", "links": ["not a link"],
                                            "people": {"composers": [{"name": "X"}], "authors": [{"name": "Y", "ipi": "12"}]}}}, 422)["fields"]
        self.assertEqual(set(bad), {"isrc", "links", "composers", "authors"})
        # an ISRC one of the sheets has is chosen from the sheet
        self.assertIn("LNV row 4", self._send("songs/", {"data": {**self.TYPED, "isrc": "INAB12300001"}}, 422)["fields"]["isrc"])
        self.assertIn("Brand New Hit", self._send("songs/", {"data": {**self.TYPED, "isrc": "INXY12300099"}}, 422)["fields"]["isrc"])
        # not through the decisions
        self._send("clean/decisions/", {"items": [{"key": "song:x", "choice": "typed", "data": {}}]}, 400)

        key = self._send("songs/", {"data": self.TYPED, "log": {"songs": [{"key": "f", "title": "Pyaar Ka Geet"}], "text": "Song typed"}})["key"]
        self.assertIn("typed this ISRC", self._send("songs/", {"data": self.TYPED}, 422)["fields"]["isrc"])
        step = self._step()
        t = step["typed"][0]
        self.assertEqual((t["family"], t["record"]["fields"]["ISRC"], step["counts"]["typed"]), (self._case("Pyaar Ka Geet", step)["family"], ["INXY12300777"], 1))
        head, rows, log = self._lnv()
        r = next(x for x in rows if x[1] == "Typed Song")
        at = lambda h: r[head.index(h)]
        self.assertEqual((at("ISRC"), at("Movie Name *"), at("Label *"), at("Release Year(YYYY) *"), at("VERSION *")), ("INXY12300777", "Film T", "Saregama", 2020, "MOD"))
        self.assertEqual((at("Website1"), at("Website2"), at("YouTube"), at("SPOTIFY ID")), (self.TYPED["links"][0], self.TYPED["links"][2], self.TYPED["links"][1], "2HNG9q8rXbnijbPTwCMgsb"))
        self.assertEqual((at("Composer Name 1"), at("Artist CAE 3"), at("Role 3"), at("Performance share 3")), ("Ravi Kumar Verma", 111111111, "C", 50))
        self.assertEqual((at("Author Name 1"), at("Artist CAE 5"), at("Singer Name 1"), at("Artist CAE 1")), ("Anand Bakshi", 333333331, "Some Singer", None))
        self.assertEqual((at("Original Work"), at("Main version title")), ("Pyaar Ka Geet", "Pyaar Ka Geet"))
        self.assertTrue(any("Added song (typed)" in x for x in log), log)
        # corrected, then removed
        self._send("songs/", {"key": key, "data": {**self.TYPED, "title": "Typed Song 2"}})
        self.assertEqual(self._step()["typed"][0]["data"]["title"], "Typed Song 2")
        self._save({"key": key, "choice": None})
        self.assertEqual(self._step()["typed"], [])
        self._send("songs/", {"key": key, "data": self.TYPED}, 409)
        self.assertFalse(any(x[1] == "Typed Song" for x in self._lnv()[1]))
        # each of those is a change, and undoing the removal brings it back
        ch = self._changes()
        self.assertEqual(len(ch), 3)
        self._send("changes/", {"undo": [ch[0]["id"]]})
        self.assertEqual(self._step()["typed"][0]["data"]["title"], "Typed Song 2")

    def test_undo_song_by_song(self):
        """A recording moved from song A to song B is listed under both; undoing it puts it back and leaves other songs'
        changes alone; a later change on the same decisions goes with it; nothing changed elsewhere is overwritten."""
        before = self._step()
        lofi = next(r for r in self._case("Pyaar Ka Geet", before)["muso"] if "Lofi" in r["fields"]["Title"])
        to = self._case("Brand New Hit", before)["muso"][0]["id"]
        A, B = {"key": "a", "title": "Pyaar Ka Geet"}, {"key": "b", "title": "Brand New Hit"}
        self._save({"key": f"map:{lofi['id']}", "choice": "join", "data": {"to": to, "title": "Brand New Hit"},
                    "log": {"group": "move", "songs": [A, B], "text": "“Lofi Flip” moved from “Pyaar Ka Geet” to “Brand New Hit”"}})
        self._save({"key": "pick:4:Lyricist", "choice": "custom", "data": {"value": ["X"]}, "log": {"songs": [{"key": "c", "title": "Dil Ki Baat"}], "text": "Lyricist typed"}},
                   {"key": "pick:4:Year", "choice": None, "log": {"text": "nothing changed here"}})
        self.assertEqual([r["fields"]["Title"] for r in self._case("Brand New Hit")["muso"]][1:], ["Pyaar Ka Geet - Lofi Flip"])
        ch = self._changes()
        self.assertEqual([c["lines"] for c in ch], [["Lyricist typed"], ["“Lofi Flip” moved from “Pyaar Ka Geet” to “Brand New Hit”"]])   # no line for what did not change
        self.assertEqual([s["title"] for s in ch[1]["songs"]], ["Pyaar Ka Geet", "Brand New Hit"])
        # saving the same again is no change
        self._save({"key": "pick:4:Lyricist", "choice": "custom", "data": {"value": ["X"]}})
        self.assertEqual(len(self._changes()), 2)

        self._send("changes/", {"undo": [ch[1]["id"]]})
        self.assertIn("Pyaar Ka Geet - Lofi Flip", [r["fields"]["Title"] for r in self._case("Pyaar Ka Geet")["muso"]])
        self.assertEqual(len(self._case("Brand New Hit")["muso"]), 1)
        self.assertEqual(self._step()["picks"], {"pick:4:Lyricist": ["X"]})   # the other song's change stays
        ch = self._changes()
        self.assertIsNotNone(ch[1]["undone_at"])
        self._send("changes/", {"undo": [ch[1]["id"]]}, 409)
        self._send("changes/", {"redo": ch[1]["id"]})
        self.assertEqual(len(self._case("Brand New Hit")["muso"]), 2)

        # a later change on the same decision goes with it
        self._save({"key": "pick:4:Lyricist", "choice": "custom", "data": {"value": ["Y"]}, "log": {"text": "typed again"}})
        ch = self._changes()
        first = next(c for c in ch if c["lines"] == ["Lyricist typed"])
        again = next(c for c in ch if c["lines"] == ["typed again"])
        self.assertEqual(first["with"], [again["id"]])
        self.assertEqual(self._send("changes/", {"undo": [first["id"]]})["undone"], sorted([first["id"], again["id"]]))
        self.assertEqual(self._step()["picks"], {})
        # made again only when nothing changed since
        self._save({"key": "pick:4:Lyricist", "choice": "custom", "data": {"value": ["Z"]}})
        self._send("changes/", {"redo": first["id"]}, 409)
        # changed outside the list: not overwritten
        z = self._changes()[0]
        Client.objects.get(pk=self.cid).clean_decisions.filter(key="pick:4:Lyricist").update(data={"value": ["elsewhere"]})
        self._send("changes/", {"undo": [z["id"]]}, 409)
        self.assertEqual(self._step()["picks"], {"pick:4:Lyricist": ["elsewhere"]})
        self._send("changes/", {}, 400)
        # a new LNV has other rows: what came before cannot be undone
        self._post(f"/api/clients/{self.cid}/master/", f"{self.tmp}/lnv.xlsx")
        self.assertTrue(all(c["closed"] for c in self._changes()))
        self._send("changes/", {"undo": [z["id"]]}, 409)

    def test_undo_a_deleted_song_and_a_shared_name(self):
        song = self._case("Pyaar Ka Geet")["answer"]["song"]
        self._save({"key": f"link:{song}", "choice": "none", "data": {"rows": [2, 3]}, "log": {"group": "d", "text": "Deleted", "minor": True}},
                   {"key": f"missing:{song}", "choice": "deleted", "log": {"group": "d", "text": "Deleted"}},
                   {"key": "name:anand bakshi|malik varma", "choice": "same", "data": {"a": "x", "b": "y"}, "log": {"group": "n", "text": "One person"}})
        ch = self._changes()
        self.assertEqual(sorted(c["lines"] for c in ch), [["Deleted"], ["One person"]])
        self._send("changes/", {"undo": [c["id"] for c in ch]})
        self.assertEqual(self._case("Pyaar Ka Geet")["answer"]["choice"], "same")
        from .models import NameAlias
        self.assertEqual(NameAlias.objects.count(), 0)

    def test_lists_as_excel(self):
        res = self.client.post(f"/api/clients/{self.cid}/lists/", {"name": "Exact matches", "sheets": [
            {"name": "Exact/matches", "header": ["Song", "LNV row"], "rows": [["=1+1", 4], ["पुराना", 5]]},
            {"name": "Exact/matches", "header": ["Song"], "rows": []}]}, content_type="application/json")
        self.assertEqual(res.status_code, 200)
        self.assertIn("Ravi_Kumar_Verma_Exact_matches_", res["Content-Disposition"])
        wb = openpyxl.load_workbook(io.BytesIO(res.content))
        self.assertEqual(len(wb.sheetnames), 2)
        ws = wb.worksheets[0]
        self.assertEqual([[c.value for c in r] for r in ws.iter_rows()], [["Song", "LNV row"], ["=1+1", 4], ["पुराना", 5]])
        self.assertEqual(ws["A2"].data_type, "s")   # text, never a formula
        self._send("lists/", {"sheets": []}, 400)
        self._send("lists/", {"sheets": [{"name": "x"}]}, 400)
        self.client.logout()
        self.assertEqual(self.client.post(f"/api/clients/{self.cid}/lists/", {}, content_type="application/json").status_code, 401)


class RemarkTests(TestCase):
    """v1.6.1: why a song not in the LNV is mapped – the shared Remark list (Settings) and the LNV's Remark column."""

    ROWS = MUSO_ROWS + [
        ("Pyaar Ka Geet", "Film A", "INXY12300021", "Anand Bakshi", "Somebody Else", 10),   # the same name and film, another recording
        ("Priya Geetham", "Film Z", "INXY12300022", "Other Writer", "Ravi Kumar Verma", 5),
    ]
    setUp, tearDown = SongWorkTests.setUp, SongWorkTests.tearDown
    _post, _send, _save, _step, _case, _lnv, _changes = (SongWorkTests.__dict__[k] for k in ("_post", "_send", "_save", "_step", "_case", "_lnv", "_changes"))

    def _remarks(self):
        return self.client.get("/api/remarks/").json()["remarks"]

    def _api(self, method, url, body=None, status=200):
        res = getattr(self.client, method)(url, body or {}, content_type="application/json")
        self.assertEqual(res.status_code, status, res.content[:300])
        return res.json()

    def _named(self, name):
        return next(r for r in self._remarks() if r["name"] == name)

    def test_the_shared_list(self):
        names = [r["name"] for r in self._remarks()]
        self.assertEqual(names, ["Adaptation", "Uncredited Adaptation", "Lyrical Adaptation", "Language Adaptation", "Credited Adaptation",
                                 "Same melody, translated lyrics", "Same melody, completely new lyrics", "Same melody and lyrics, different singer",
                                 "Same melody, different instrumentation", "Melody substantially modified"])
        self.assertIn("Cover Version/New Recording", self._named("Same melody and lyrics, different singer")["help"])
        self._api("post", "/api/remarks/", {"name": "  Sample   used "})
        self.assertEqual(self._remarks()[-1]["name"], "Sample used")
        for bad in ("", "sample USED", "x" * 121):
            self._api("post", "/api/remarks/", {"name": bad}, 400)
        r = self._named("Sample used")
        self._api("patch", f"/api/remarks/{r['id']}/", {"name": "Adaptation"}, 400)
        self._api("patch", f"/api/remarks/{r['id']}/", {"name": "Sample", "help": "Part of it"})
        self.assertEqual((self._named("Sample")["help"], self._named("Sample")["by"]), ("Part of it", "team@example.com"))
        self._api("patch", f"/api/remarks/{r['id']}/", {"move": -1})
        self.assertEqual([x["name"] for x in self._remarks()][-2:], ["Sample", "Melody substantially modified"])
        # removed: not offered, put back
        self._api("delete", f"/api/remarks/{r['id']}/")
        self.assertFalse(self._named("Sample")["active"])
        self.assertNotIn("Sample", [x["name"] for x in self._step()["remark_list"]])
        self._api("patch", f"/api/remarks/{r['id']}/", {"active": True})
        # every user sees the same list
        from django.contrib.auth import get_user_model
        self.client.force_login(get_user_model().objects.create_user("b@example.com", "b@example.com", "x"))
        self.assertIn("Sample", [x["name"] for x in self._step()["remark_list"]])
        self.client.logout()
        self.assertEqual(self.client.get("/api/remarks/").status_code, 401)

    def _set(self, key, name):
        r = self._named(name)
        return {"key": f"remark:{key}", "choice": "set", "data": {"remark": r["id"], "value": r["name"]}}

    def test_the_lnv_column(self):
        head, rows, _ = self._lnv()
        self.assertEqual(head[-1], "Remark")   # the last column, blank while no song has one
        self.assertFalse(any(r[len(head) - 1:] and r[-1] for r in rows if len(r) == len(head)))
        step = self._step()
        pyaar, hit = self._case("Pyaar Ka Geet", step), self._case("Brand New Hit", step)
        # mapped onto an LNV row as a version: a row of its own naming that row, with the remark
        self._save({"key": f"map:{hit['muso'][0]['id']}", "choice": "join", "data": {"to": pyaar["muso"][0]["id"], "row": 3, "title": "Pyar Ka Geet"}},
                   self._set("INXY12300099", "Same melody, translated lyrics"))
        self.assertEqual(self._step()["remarks"]["INXY12300099"]["name"], "Same melody, translated lyrics")
        head, rows, log = self._lnv()
        at = lambda r, h: r[head.index(h)]
        new = next(r for r in rows if r[1] == "Brand New Hit")
        self.assertEqual((at(new, "ISRC"), at(new, "Remark"), at(new, "Original Work")), ("INXY12300099", "Same melody, translated lyrics", "Pyar Ka Geet"))
        self.assertEqual(sum(1 for r in rows if at(r, "Remark")), 1)
        self.assertEqual(head.index("Remark"), len(head) - 1)
        self.assertTrue(any("Remark Same melody, translated lyrics" in x for x in log), log)
        # renamed in Settings: the new name, everywhere; removed there: the songs keep it
        r = self._named("Same melody, translated lyrics")
        self._api("patch", f"/api/remarks/{r['id']}/", {"name": "Lyrical Translation"})
        self._api("delete", f"/api/remarks/{r['id']}/")
        head, rows, _ = self._lnv()
        self.assertEqual(next(x for x in rows if x[1] == "Brand New Hit")[head.index("Remark")], "Lyrical Translation")
        # taken off – and undone
        self._save({"key": "remark:INXY12300099", "choice": None})
        self.assertEqual(self._step()["remarks"], {})
        self._send("changes/", {"undo": [self._changes()[0]["id"]]})
        self.assertEqual(self._step()["remarks"]["INXY12300099"]["name"], "Lyrical Translation")

    def test_on_an_existing_row_and_on_a_new_row(self):
        # the same song as an LNV row: the remark is on that row
        self._save({"key": "link:INXY12300099", "choice": "same", "data": {"rows": [6]}}, self._set("INXY12300099", "Credited Adaptation"))
        head, rows, _ = self._lnv()
        row6 = next(r for r in rows if r[head.index("Row in the uploaded LNV")] == 6)
        self.assertEqual(row6[head.index("Remark")], "Credited Adaptation")
        self.assertFalse(any(r[1] == "Brand New Hit" for r in rows))
        # added as a new row: on that one
        self._save({"key": "link:INXY12300099", "choice": None}, {"key": "missing:INXY12300099", "choice": "add"})
        head, rows, _ = self._lnv()
        self.assertEqual(next(r for r in rows if r[1] == "Brand New Hit")[head.index("Remark")], "Credited Adaptation")
        self.assertEqual(sum(1 for r in rows if r[head.index("Remark")]), 1)
        # not the client's, deleted: no row, no remark
        self._save({"key": "missing:INXY12300099", "choice": "deleted"})
        head, rows, _ = self._lnv()
        self.assertFalse(any(r[head.index("Remark")] for r in rows))

    def test_a_cover_of_the_same_name_and_film_gets_its_own_row(self):
        _muso_file(f"{self.tmp}/muso.xlsx", self.ROWS)
        self._post(f"/api/clients/{self.cid}/clean/", f"{self.tmp}/muso.xlsx")
        step = self._step()
        cover = next(c for c in step["cases"] if c["kind"] not in ("twice", "names") and any("INXY12300021" in r["fields"]["ISRC"] for r in c["muso"]))
        rec = next(r for r in cover["muso"] if "INXY12300021" in r["fields"]["ISRC"])
        main = next(c for c in step["cases"] if c["kind"] not in ("twice", "names") and c["answer"].get("song") == "INXY12300011")
        self.assertNotEqual(rec["id"], main["muso"][0]["id"])
        self._save({"key": f"map:{rec['id']}", "choice": "join", "data": {"to": main["muso"][0]["id"], "row": 2, "title": "Pyaar Ka Geet"}},
                   self._set("INXY12300021", "Same melody and lyrics, different singer"))
        head, rows, _ = self._lnv()
        new = [r for r in rows if r[head.index("ISRC")] == "INXY12300021"]
        self.assertEqual(len(new), 1)
        self.assertEqual((new[0][head.index("Remark")], new[0][head.index("Original Work")]), ("Same melody and lyrics, different singer", "Pyaar Ka Geet"))
        self.assertEqual(sum(1 for r in rows if r[head.index("Remark")]), 1)   # the original's own row has none

    def test_mapped_onto_a_match_not_answered_yet_it_is_in_the_lnv_all_the_same(self):
        _muso_file(f"{self.tmp}/muso.xlsx", self.ROWS)
        self._post(f"/api/clients/{self.cid}/clean/", f"{self.tmp}/muso.xlsx")
        step = self._step()
        dil, other = self._case("Dil Ki Baat", step), self._case("Priya Geetham", step)
        self.assertFalse(dil["done"])
        self._save({"key": f"map:{other['muso'][0]['id']}", "choice": "join", "data": {"to": dil["muso"][0]["id"], "row": 4, "title": "Dil Ki Baat"}},
                   self._set("INXY12300022", "Uncredited Adaptation"))
        self.assertFalse(self._case("Dil Ki Baat")["done"])
        head, rows, _ = self._lnv()
        new = next(r for r in rows if r[1] == "Priya Geetham")
        self.assertEqual((new[head.index("Remark")], new[head.index("Original Work")]), ("Uncredited Adaptation", "Dil Ki Baat"))
        self.assertEqual(sum(1 for r in rows if r[1] == "Priya Geetham"), 1)

    def test_a_mapped_medley_is_in_the_lnv(self):
        _muso_file(f"{self.tmp}/muso.xlsx", MUSO_ROWS + [("Non Stop Remix Mashup 2020", "Party", "INXY12300033", "Anand Bakshi", "Ravi Kumar Verma", 5)])
        self._post(f"/api/clients/{self.cid}/clean/", f"{self.tmp}/muso.xlsx")
        step = self._step()
        from .engine.dataclean import is_medley
        self.assertTrue(is_medley("Non Stop Remix Mashup 2020"))
        medley, pyaar = self._case("Non Stop Remix Mashup 2020", step), self._case("Pyaar Ka Geet", step)
        self._save({"key": f"map:{medley['muso'][0]['id']}", "choice": "join", "data": {"to": pyaar["muso"][0]["id"], "row": 2, "title": "Pyaar Ka Geet"}},
                   self._set("INXY12300033", "Adaptation"))
        head, rows, _ = self._lnv()
        new = [r for r in rows if r[head.index("ISRC")] == "INXY12300033"]
        self.assertEqual([(r[1], r[head.index("Remark")], r[head.index("Original Work")]) for r in new], [("Non Stop Remix Mashup 2020", "Adaptation", "Pyaar Ka Geet")])

    def test_remarks_survive_a_new_muso_export(self):
        self._save(self._set("INXY12300099", "Adaptation"), self._set("#5", "Adaptation"))
        self._post(f"/api/clients/{self.cid}/clean/", f"{self.tmp}/muso.xlsx")
        self.assertEqual(list(self._step()["remarks"]), ["INXY12300099"])   # known by its ISRC; a sheet row is another one now
