# MRM changelog

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
