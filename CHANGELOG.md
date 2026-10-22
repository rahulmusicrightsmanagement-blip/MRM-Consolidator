# MRM changelog

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
