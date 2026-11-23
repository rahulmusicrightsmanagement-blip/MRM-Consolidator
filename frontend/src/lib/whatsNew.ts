/** What changed in each version, in short plain points – for the "What's new" popup. A version not written here shows
 *  its CHANGELOG entry, cut at its semicolons. No React here: unit-tested in Node. */

export const POINTS: Record<string, string[]> = {
  '1.6.1': [
    'Not in the LNV: map a song to an existing ISRC or song, from the Muso or the LNV list.',
    'Remark: choose why the song is mapped.',
    'Settings: add and edit the remarks. Everyone sees the same list.',
    'The LNV has a Remark column at the end, with the same words.',
    'A song mapped to another gets its own LNV row, unless you say it is the same song.',
    'Sidebar fixed: the icon you point at is the one that opens.',
  ],
  '1.6.0': [
    'Rest the pointer on anything for 5 seconds: a small box says what it means.',
    'Change the title right in the Title row. The extra title row is gone.',
    'Download Excel: exact matches, possible matches, left to check, not in the LNV and more.',
    'Add a song: pick it from the sheet, or type all its details.',
    'Undo: open a song, see its changes, and take back the ones you choose.',
    'Counts stay right: one tick moves one match from “to check” to “checked”.',
    '“Only this LNV row is not it”: turn down one wrong row, keep the rest.',
    'What’s new: this box opens once per version. Click the version to see it again.',
  ],
  '1.5.1': [
    'Possible matches in two tables: Muso versions, then LNV rows, against the main version.',
    'A Delete song button on every match.',
    'Counts are in the list dropdown.',
  ],
  '1.5.0': [
    'IPI / CAE list: upload it once, names show as the member’s real name.',
    'New row and Deleted songs lists. Songs in them map back.',
    'Possible matches scroll across or down.',
  ],
  '1.4.1': ['The pencil and the Keep button are always at the same place.'],
  '1.4.0': ['The sidebar and the song list close by themselves. Lock them to keep them open.', 'Two stages in the sidebar: Muso vs LNV, then LNV vs IPRS.', 'New logo.'],
  '1.3.2': ['Customise: the pencil opens the box to type right there.'],
  '1.3.1': ['Mark Muso vs LNV as completed.', 'New page: LNV vs IPRS.', 'Download the LNV sorted by song or by album.'],
  '1.3.0': ['Keep the LNV’s value, take Muso’s, or type your own.', 'Map a song that is not in the LNV to a match.', 'Links to Spotify and other sites.'],
}

export type Release = { version: string; date: string; points: string[] }

export function releases(changelog: string): Release[] {
  const out: Release[] = []
  for (const part of changelog.split(/^## /m).slice(1)) {
    const m = part.match(/^(\d+\.\d+\.\d+) – (\d{4}-\d{2}-\d{2})/)
    if (!m) continue
    const notes = part.split('\n').slice(1).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
    out.push({ version: m[1], date: m[2], points: POINTS[m[1]] ?? notes.flatMap((t) => t.split(/;\s+/)).map((t) => t.trim()).filter(Boolean).map((t) => t[0].toUpperCase() + t.slice(1)) })
  }
  return out
}

const KEY = 'mrm-seen-version'
/** Does this browser's user still have to see this version's changes? */
export const unseen = (version: string) => { try { return localStorage.getItem(KEY) !== version } catch { return false } }
export const markSeen = (version: string) => { try { localStorage.setItem(KEY, version) } catch { /* private mode */ } }
