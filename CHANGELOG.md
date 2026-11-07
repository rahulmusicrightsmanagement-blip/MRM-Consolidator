# MRM changelog

<<<<<<< HEAD
## 1.0.0 – 2026-11-05 (major)
- New three-bucket Muso vs LNV comparison (exact, possible, not found) using the oldest release as the original; Original Work and Original Movie / Album columns next to Movie Name; every change in the output highlighted yellow; simpler Upload, Review, Download screens; version shown bottom right

## 0.40.1 – 2026-11-03 (patch)
- Saved is now its own tab above the list: every saved answer (yours and the app's), what it puts into the LNV, filters, search, Open and Undo

## 0.40.0 – 2026-11-03 (minor)
- Muso & LNV: two-stage matching (1 recording: title, album, ISRC, year · 2 work: title, album, writers, publisher – both = exact, one = possible); the matched recording is the original and every other recording gets its own LNV row naming it; choose the LNV or Muso value where they differ; new Saved tab listing every saved answer and what it puts into the LNV; saving no longer flips back

## 0.39.2 – 2026-11-03 (patch)
- One case per song with all its recordings (a song was split into several cases); a lofi or remix row the LNV has is never asked as the song itself, only checked under versions already in the LNV

## 0.39.1 – 2026-11-03 (patch)
- Fixed songs showing in the wrong tab and twice (two Muso songs with one ISRC shared an id), and versions already in the LNV showing under songs they don't belong to; the version check now shows the recording that has the LNV row's ISRC

## 0.39.0 – 2026-11-02 (minor)
- New matching rule: one Muso recording against one LNV row; Exact = same credits (title, version, album, writers, publisher) and same ISRC, linked by the app; Possible = only one of the two, you decide; neither = not in the LNV

## 0.38.0 – 2026-11-02 (minor)
- Possible match needs something in common (same ISRC, or the same title plus a shared writer besides the client or the same publisher); versions already in the LNV are shown beside their LNV row to check, with Right / Not this version

## 0.37.1 – 2026-11-02 (patch)
- Exact match now counts the same company under another name (Saregama India / Saregama US) and a shared ISRC; Possible only holds songs with the same ISRC or the same title with credits a little different; the rest go to Not in the LNV

## 0.37.0 – 2026-11-02 (minor)
- Song versions (remix, lofi, sad …) become their own LNV rows with Original Work and Original Movie / Album columns; only the original maps to the matched LNV row; a version's ISRC no longer fills the original's row

## 0.36.1 – 2026-10-31 (patch)
- LNV vs IPRS page made cleaner: repeated numbers and long text removed, extra details fold away, Accept strong asks first

## 0.36.0 – 2026-10-31 (minor)
- Muso & LNV and LNV vs IPRS: click an LNV row to see all three files, search looks through every song, the app remembers your place, keyboard help; fixed stale counts, slow downloads with no feedback, cut-off step text, and added a warning before sending lists to IPRS

## 0.35.1 – 2026-10-31 (patch)
- Muso & LNV: Exact match and Possible match tabs are back; dropdown fixed

## 0.35.0 – 2026-10-31 (minor)
- Muso & LNV: click any version to see all its details; cleaner page with one row of tabs, one filter and a simpler versions list

## 0.34.0 – 2026-10-31 (minor)
- LNV vs IPRS step is back to the original screen from the live version: How the catalogue came out, To decide, Client/General amend, Not registered, New from IPRS, side-by-side review with Same/Different; its count now matches To decide

## 0.33.0 – 2026-10-30 (minor)
- New tabs in step 2: Exact match, Possible match and Not in the LNV, including the songs the app linked by itself

## 0.32.3 – 2026-10-30 (patch)
- LNV rows with different writers or publisher no longer sit next to the Muso song: they are folded away as not the same song, and the only answers shown are add or skip

## 0.32.2 – 2026-10-30 (patch)
- Fixed the song list on the left not scrolling

## 0.32.1 – 2026-10-30 (patch)
- Clearer same-song screen: only names really missing on the other side are marked, the top line no longer reads as if Muso and the LNV match, Same company under another name is said plainly, versions show every writer and publisher difference

## 0.32.0 – 2026-10-30 (minor)
- Review uses the full width with no empty margin on the left, shorter top of the page, and Undo for the last answer after moving on

## 0.31.0 – 2026-10-30 (minor)
- Simpler review screen: Muso and LNV side by side with only the differing names marked, answer buttons always on screen, one click answers and moves on, fewer filters and repeated text

## 0.30.0 – 2026-10-30 (minor)
- Review without boxes: Muso and the LNV side by side in one table; folding sidebar, Expand for the song, Less/More on Biggest wins, each part and the step text

## 0.29.0 – 2026-10-30 (minor)
- New professional look: sidebar with the client's four steps, clean white pages with fine lines instead of boxes, a progress track for the steps

## 0.28.0 – 2026-10-30 (minor)
- One flow per client: 1 Files, 2 Muso & LNV, 3 LNV vs IPRS, 4 Final LNV; clients open at their step; client list shows where each client is; old tools moved to More tools

## 0.27.0 – 2026-10-30 (minor)
- Fewer songs to check (Needs you / App answered), IPRS step rebuilt like step 1, one final LNV with Muso and IPRS together, final LNV in seconds and faster first open

## 0.26.1 – 2026-10-30 (patch)
- Removed the progress card from step 1

## 0.26.0 – 2026-10-30 (minor)
- Biggest wins (one answer settles many songs: a name, a non-writer, a publisher) and a progress bar showing where every Muso song stands

## 0.25.0 – 2026-10-30 (minor)
- Same-song rule: Muso maps to an LNV row only with the same writers and a shared publisher; Same person? cases answered once for every client

## 0.24.0 – 2026-10-29 (minor)
- Step 1 shows the LNV as the master and Muso as what adds or updates it: LNV row cards, what changes in the LNV, Muso versions, one choice; new Download updated LNV

## 0.23.0 – 2026-10-29 (minor)
- Muso and LNV checked together: one case per song (its Muso versions + its LNV rows in one block), one Confirm, two steps instead of three

## 0.22.0 – 2026-10-29 (minor)
- Step 1 Clean Muso now works like MRM-Extractor's Song Merge: same ISRC + same writers merged, suggestions and ISRC conflicts to review (A/R keys), merged list, manual type, Excel download

## 0.21.0 – 2026-10-29 (minor)
- Consolidate in three steps, one after the other: 1 clean Muso (duplicate rows merged into songs), 2 Muso vs LNV, 3 LNV vs IPRS – every case shown as full records one below another with differences marked; no yes/no questions

## 0.20.1 – 2026-10-29 (patch)
- Uploads failed after a rebuild (backend/media was deleted by the tests and recreated by Docker as root): tests now use a temporary folder; the Add-client wizard waits for the LNV before the Muso and IPRS files

## 0.20.0 – 2026-10-29 (minor)
- Song check: LNV, Muso export and IPRS report checked together in one screen – one verdict per song, only the open questions asked one at a time; Add client is now two steps (details, the three files); spreadsheets read up to 20× faster

## 0.19.0 – 2026-10-29 (minor)
- Data clean rebuilt like the Extractor's Song Merge: one queue per kind of decision, list on the left and one case on the right compared field by field with Same / Different marks and evidence points, one-key decisions saved in the background; duplicates no longer lump versions, remakes or other recordings together (Laxmikant: 158 → 25 to decide); IPRS mapping compare look restored

## 0.18.1 – 2026-10-28 (patch)
- Data clean is now a side-by-side compare: LNV on the left, the export on the right, one line per song with a coloured status and an Outcome menu the app pre-fills; filters for To decide, Duplicates, Missing, ISRC problems; no more questions

## 0.18.0 – 2026-10-28 (minor)
- Data clean answers what it is sure of by itself (same ISRC + title, same title + writer, certain duplicates, clean missing songs, empty cells) and asks only the rest – Laxmikant: 1,918 questions down to 437; every app answer shows why and can be changed

## 0.17.2 – 2026-10-28 (patch)
- Data clean shows every problem of a check at once in one clear list – plain question and answer buttons on each row, To answer / Answered / All, search, tick-boxes to answer many together; one-question-at-a-time mode removed

## 0.17.1 – 2026-10-28 (patch)
- Data clean made simple: the two sheets clearly labelled (LNV vs export), a plain-language summary, a numbered list of checks, and one question at a time with Yes / No / Skip buttons (keys Y N S) – table view still there for doing many at once

## 0.17.0 – 2026-10-28 (minor)
- New Data clean step: today's LNV vs one Muso / Apple Music / Spotify sheet – matching and duplicate finding in one pass, review tabs for ISRC & duplicates, artist names, missing details and links to check, plus a discrepancy & duplicate report

## 0.16.4 – 2026-10-24 (patch)
- Opening a big report is much faster: catalogue save looks works up by index and only rewrites what changed; processed reports survive app updates

## 0.16.3 – 2026-10-24 (patch)
- Much faster matching for big catalogues (Laxmikant: ~7.5 min → ~23 s): master index for codes and titles, cached name clean-up; results unchanged
=======
## 2.0.1 – 2026-11-04 (major)
- Project handed over to SK
>>>>>>> e3c1eaf30f81765596ee4ce38adbfb1350a39132

## 0.16.2 – 2026-10-24 (patch)
- Removed unused files and old code; all spreadsheet types (xlsx, csv, ods …) kept out of git

## 0.16.1 – 2026-10-24 (patch)
- Updated master never changes a filled cell: any IPRS block with data stays untouched, new data and statuses go into the next empty block

## 0.16.0 – 2026-10-23 (minor)
- Earlier amendments in the master are kept: nothing new = block untouched; new problems or a changed status go into the next free IPRS block with only the new reasons

## 0.15.2 – 2026-10-23 (patch)
- Fix false amendments: a name initial no longer matches two words (S Rafeeq Ahmed ≠ Sushin Shyamprakash); a full word must agree

## 0.15.1 – 2026-10-23 (patch)
- Role code now beats the column in our master (no false 'role differs' amend; flagged as Fix our master); Excel view shows What to look at, Client tags and the master column of each writer

## 0.15.0 – 2026-10-23 (minor)
- Amend tabs explain each reason (impact, what to ask IPRS, proof, priority) and show the Purpose of amendment; Use IPRS / Keep ours on every differing row, choice replaces the other value; Excel view restyled

## 0.14.0 – 2026-10-23 (minor)
- IPRS steps 2 and 3 merged into one 'Match & review' step: outcome bar, To decide, new Client amend and General amend tabs grouped by reason, Not registered, New from IPRS

## 0.13.0 – 2026-10-23 (minor)
- Suggestion review: tick every master row that is the same song (versions sharing the IPRS code); all ticked rows get the IPRS work

## 0.12.0 – 2026-10-23 (minor)
- New suggestion review: IPRS vs master side by side, one-key decisions saved in batches, multi-select, Accept strong; LNV Alternate Work used for matching and IPRS title can be saved into it

## 0.11.0 – 2026-10-23 (minor)
- IPRS upload about 5x faster; Add client step 3 is Societies again – one upload lane per society (IPRS, PRS) with its own check and mapping button

## 0.10.0 – 2026-10-23 (minor)
- Add client now goes client → master → IPRS report → straight to mapping, resumes after a reload; simpler IPRS file-check step and step bar

## 0.9.7 – 2026-10-23 (patch)
- Fix: Continue on the Add client master step did nothing

## 0.9.6 – 2026-10-23 (patch)
- Add client page redesigned: step rail, live preview, icon fields, due-date quick picks and duplicate-client warning

## 0.9.5 – 2026-10-23 (patch)
- Sign-in page redesigned: split layout with brand panel, icon fields and Caps Lock warning

## 0.9.4 – 2026-10-23 (patch)
- Client tracker redesigned: total cards removed, richer client table with progress ring, society cards, owner chips and due-date pills

## 0.9.3 – 2026-10-22 (patch)
- Client pages load about 10x faster and show a loading screen until the data arrives

## 0.9.2 – 2026-10-22 (patch)
- Each slow page request now logs where its time went (database, Google Drive, processing); tracker counts load faster

## 0.9.1 – 2026-10-22 (patch)
- Pages load faster: processed reports stay cached, task lists skip report data, and an expired Google Drive sign-in no longer breaks the client list

## 0.9.0 – 2026-10-15 (minor)
- User roles: Rahul stays super admin; new Admin role (Durga) can add and manage members

## 0.8.3 – 2026-10-15 (patch)
- Super admin is now durgasingh.jr@gmail.com

## 0.8.2 – 2026-10-14 (patch)
- Deleting a client removes all its data in Neon and its files in Google Drive, all or nothing.

## 0.8.1 – 2026-10-14 (patch)
- Google Drive uploads run in the background (faster uploads); deleting a client now also removes its master file.

## 0.8.0 – 2026-10-14 (minor)
- Uploaded spreadsheets can be stored in Google Drive (manage.py drive_setup); local folder becomes a cache.

## 0.7.1 – 2026-10-14 (patch)
- Production settings tidy-up for deployment (HSTS over HTTPS, unused email setup removed).

## 0.7.0 – 2026-10-14 (minor)
- Neon Postgres (Singapore) is now the only database, starting fresh; IPRS/PRS uploads and pages much faster (bulk writes, shared cache).

## 0.6.1 – 2026-10-14 (patch)
- Removed the 'password too similar to name' rule when adding users.

## 0.6.0 – 2026-10-14 (minor)
- Database moved from SQLite to Neon Postgres (MRM_DATABASE_URL in .env); all existing data copied over.

## 0.5.0 – 2026-10-14 (minor)
- Login page: everyone must sign in; only the super admin (rahuljadhav0417@gmail.com) can add users. Excel files kept out of git.

## 0.4.1 – 2026-10-14 (patch)
- Renamed the app to MRM-Consolidator

## 0.4.0 – 2026-10-14 (minor)
- App can now be deployed with Docker (docker compose up), with production-safe settings and data kept in a volume

## 0.3.1 – 2026-10-08 (patch)
- Map with master: the song comparison is now one simple Excel-style table – green same, red different, yellow missing in our master, plain words, Use IPRS / Keep ours on the same row, 'Show only differences'

## 0.3.0 – 2026-10-08 (minor)
- Map with master: open any song to see every column of both files – side by side with Same / Different / Only in IPRS / Only in master, each writer next to their master slot, the IPRS rows as in the file, and all 1,398 master columns

## 0.2.0 – 2026-10-07 (minor)
- Reports step: Verification (re-reads the generated master, Amend and Registration files and checks every step – counts, no duplicates, right rows, IPRS values, statuses, and that every changed cell is explained) and a spreadsheet preview of the final master with before/after and where each value came from; faster LNV report export

## 0.1.1 – 2026-10-07 (patch)
- Map with master on a master with empty society columns: missing ISWC/ISRC count as 'Filled in step 3' (not Fix our master), waiting works get a 'Needs your decision' tile and are no longer counted as Only in master; footer version updates live in the dev server

## 0.1.0 – 2026-10-07 (minor)
- New IPRS step 3 'Fill IPRS columns': fills ISRC/ISWC/IPRS TUNECODE/Client status/General Status/Purpose of amendment per block from the IPRS report (one row per song, extra registrations in blocks 2-5), Not registered / Not our work, Confirm all suggestions, empty-master title+writers matching

## 0.0.1 – 2026-10-07 (patch)
- Map with master: chosen IPRS values now show in the master column (Added / Replaced in master, with the old value struck through); renamed titles show in the song list

## 0.0.0 – 2026-10-07 (baseline)
- Versioning starts. Society workspaces (IPRS, PRS) with Upload → Map with master → Reports.
- Map with master: choose per field which value our master keeps (Keep IPRS / Keep master, or Add to master when our master is empty); "Add all missing to master".
- Updated master (LNV format) download in Map with master and in Reports, with every chosen value applied.
- Footer shows the app version.
