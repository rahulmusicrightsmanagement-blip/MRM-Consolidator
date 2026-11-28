/** What a button, a mark or a label means, in plain words – shown after the pointer rests on it (HintLayer). Short
 *  enough for two lines. No React here: unit-tested in Node. */

export const HINT_MAX = 82
export type HintSource = { text: string; label?: string; title?: string; placeholder?: string; bad?: boolean; tag: string; cls: string }

type Entry = [RegExp, string | ((m: RegExpMatchArray, s: HintSource) => string)]
const E: Entry[] = [
  // ---- the marks on a match
  [/^same recording$/i, (_, s) => s.bad ? 'Not the same recording: its title, album, ISRC or year is different.' : 'Title, album, ISRC and year agree: it is the same recording.'],
  [/^same work$/i, (_, s) => s.bad ? 'Not the same work: its writers, publisher or album are different.' : 'Same title, writers and publisher: it is the same composition.'],
  [/^(same|other) isrc$/i, (m) => m[1].toLowerCase() === 'same' ? 'Both have the same ISRC, the code of one recording.' : 'The ISRC codes differ, so these may be two recordings.'],
  [/^no isrc to compare$/i, 'One side has no ISRC, so the code could not be checked.'],
  [/^same title$/i, 'Both have the same song name and version.'],
  [/^other title or version$/i, 'The song name or the version (remix, lofi…) is different.'],
  [/^same album$/i, 'Both name the same film or album.'],
  [/^other album$/i, 'The film or album name is different on the two sides.'],
  [/^same year$/i, 'Both have the same release year.'],
  [/^other year$/i, 'The release year is different on the two sides.'],
  [/^later year/i, 'A later year only: the song went online after it was released.'],
  [/^same writers$/i, 'The lyricists and composers are the same people.'],
  [/^(~ )?writers: one name extra$/i, 'Same writers, but one side lists one more name.'],
  [/^different writers$/i, 'The lyricists or composers are not the same people.'],
  [/^writers missing/i, 'One side has no writers, so they could not be checked.'],
  [/^same publisher$/i, 'Both name the same music company.'],
  [/^(other|different) publisher$/i, 'The music company is different on the two sides.'],
  [/^publisher not checked$/i, 'One side has no publisher, so it could not be checked.'],
  [/^row already linked to/i, 'Another recording already has this LNV row.'],
  [/^only the isrc is the same$/i, 'The ISRC agrees, but the other details do not.'],
  [/^not the same song by the rule$/i, 'Neither the recording nor the work agrees with this row.'],
  [/^a version the lnv has$/i, 'The LNV already has a row for this version of the song.'],
  // ---- lists and counts
  [/^exact( match)?( ?:? ?[\d,]+.*)?$/i, 'ISRCs agree with an LNV row: the main version’s ISRC, one row in the LNV.'],
  [/^possible( match)?( ?:? ?[\d,]+.*)?$/i, 'Another ISRC, but title, album or writers agree: please check it.'],
  [/^other( versions?)?( ?:? ?[\d,]+.*)?$/i, 'Remix, lofi and other versions of the song, against the main version.'],
  [/^exact matches/i, 'Every match with the main version’s ISRC.'],
  [/^possible matches/i, 'Every match with another ISRC: please check it.'],
  [/^other versions/i, 'Every other version of a song: remix, lofi, unplugged …'],
  // ---- v1.8: the ISRC first, the singer second, the production; the three sections
  [/^same singer$/i, 'A singer is the same on both sides. Shown only: the ISRC decides.'],
  [/^other singer$/i, 'The singers differ. Shown only: the ISRC decides.'],
  [/^same production$/i, 'The label or production company is the same.'],
  [/^other production$/i, 'The label or production company is different.'],
  [/^– no (singer|production|isrc) to compare$/i, 'One side has nothing here, so it could not be compared.'],
  [/^another isrc – same song\?$/i, 'Another ISRC: check whether it is the same song.'],
  [/^goes into the lnv · one row$/i, 'Every exact match becomes this one LNV row: choose its values.'],
  [/^which section\?$/i, 'Exact match, possible match or other version: choose one.'],
  [/^(isrc|singer|production) match( [\d,]+)?$|^match on/i, 'Show only the songs with an LNV row of the same ISRC, singer or production.'],
  [/^any match( [\d,]+)?$/i, 'Show every song name.'],
  [/^change both$/i, 'Make the same change in the LNV row: one row, never two.'],
  [/^only muso$/i, 'Change only the Muso data, not the LNV row.'],
  [/^check all/i, 'Check every exact match of this song at once.'],
  [/^beside no lnv row/i, 'The LNV has no row of this version: it gets one of its own.'],
  [/^matches lnv row/i, 'This recording matches that LNV row. A change to it is offered there.'],
  [/^keep: exact match title$|^keep: lnv row \d+$|^keep lnv row \d+'s value$|^keep this title of the exact match$/i, 'A value of another row of the exact match is used.'],
  [/^(checked( ?: ?[\d,]+)?|all checked)$/i, 'Matches you have ticked as right, and songs you typed.'],
  [/^(to check ?:? ?[\d,]*|[\d,]+ to check|left to check.*)$/i, 'Matches that still need your tick.'],
  [/^not in the lnv/i, 'Songs of the sheet that no LNV row matches.'],
  [/^new row, if no other match is it$/i, 'This match is wrong. A new row is made only if no other one is right.'],
  [/^new row/i, 'Songs that go into the LNV as a new row.'],
  [/^deleted songs?/i, 'Songs you deleted: nothing of them goes into the LNV.'],
  [/^only in the lnv/i, 'LNV songs that the other sheet does not have.'],
  [/^songs( [\d,]+.*)?$/i, 'Songs that match an LNV row, grouped by song name.'],
  [/^every list$/i, 'One Excel file with each list on its own sheet.'],
  [/^show all/i, 'Show every song of this list.'],
  [/^needs an answer|^needs you/i, 'Songs waiting for your decision.'],
  [/^(all checked|done)( [\d,]+)?$/i, 'Songs that are finished.'],
  [/^review songs/i, 'Go through the songs and answer them.'],
  [/^saved to the lnv/i, 'Every saved answer, and what it puts into the LNV.'],
  [/^all saved$/i, 'Nothing is waiting: every change is saved.'],
  [/^save [\d,]+ changes?$/i, 'Save your waiting changes now. They also save by themselves.'],
  [/^answer [\d,]+ songs?$|^every doubt answered$/i, 'Songs the app could not decide: you answer them.'],
  [/^confirm [\d,]+ app|^app's answers confirmed$/i, 'The app has an answer for these: check and confirm it.'],
  [/^mark as completed$|^complete again$/i, 'Finish this stage: its LNV goes on to LNV vs IPRS.'],
  [/^biggest wins/i, 'One answer here settles many songs at once.'],
  [/^how it adds up|^hide how it adds up/i, 'Shows how all the counts make the total.'],
  [/^other questions$/i, 'Name spellings and LNV rows entered twice.'],
  // ---- one song
  [/^main version$/i, 'The oldest plain recording: everything is compared with it.'],
  [/^\w+ · main version$/i, 'The oldest plain recording: everything is compared with it.'],
  [/^lnv rows? [\d, ]+$/i, 'A row of the client’s LNV. Click to see everything in it.'],
  [/^typed · new row$/i, 'A song you typed. It becomes a new row in the LNV.'],
  [/^add a song$/i, 'Add one more song here: pick it from the sheet or type it.'],
  [/^add to this song$/i, 'Put this song under the song on screen.'],
  [/^choose from the sheet$/i, 'Pick a song that is already in the uploaded sheets.'],
  [/^type all details$/i, 'Type the song yourself, with every LNV field.'],
  [/^take out$/i, 'Put this song back under its own name.'],
  [/^undo selected/i, 'Take back the changes you ticked.'],
  [/^undo$/i, 'See the changes of this song and take any of them back.'],
  [/^make again$/i, 'Bring back a change that was undone.'],
  [/^delete( this)?( song)?$/i, 'Leave this song out of the LNV. You can bring it back later.'],
  [/^remove$/i, 'Take this out. Undo can bring it back.'],
  // ---- status, last updated, kept answers (v1.7)
  [/^partly checked/i, 'Some matches are answered, others are still to check.'],
  [/^not a match( ?:? ?[\d,]+)?$/i, 'You said this is not the song. It stays here until all is checked.'],
  [/^not a match – |^song deleted – |^not the client’s – |^mapped to “/i, 'What you decided for this match. Put back takes it back.'],
  [/^put back$/i, 'Take this answer back: the old value or match returns.'],
  [/^continue from here|^open$/i, 'Open this song and go on working from there.'],
  [/^last updated song/i, 'The song that was changed last, by anyone in the team.'],
  [/^last updated · |^updated (today|yesterday|\d)/i, 'When a change to this song was last saved.'],
  [/^still to answer$/i, 'It was here when you began this song. Please answer it too.'],
  [/^not (an? )?(exact|possible) match$/i, 'This is the wrong match: say where the song goes.'],
  [/^new row in the lnv$|^a row of its own$|^add as a new row$/i, 'Give this song its own new row in the LNV.'],
  [/^map to another song|^map to a song|^map to exact match/i, 'Say it belongs to another song, and pick that song.'],
  [/^only lnv rows? [\d, ]+ (is|are) not it$/i, 'Only this LNV row is wrong. The song keeps its other rows.'],
  [/^map to existing isrc/i, 'Say which existing song or ISRC it belongs to, and why.'],
  [/^map to an exact/i, 'Pick the exact or possible match it belongs to.'],
  [/^map it$/i, 'Save: the song is mapped, with its remark.'],
  [/^map back/i, 'Join it with its old LNV row again.'],
  [/^back to its match$|^restore$|^back to not in the lnv$/i, 'Put the song back where the app had it.'],
  [/^yes, (exact match|same song)$/i, 'Tick when this LNV row really is this song.'],
  [/^(exact match|same song)\?$/i, 'Tick below when it is the same song.'],
  [/^tick all/i, 'Tick every exact match of this song at once.'],
  [/^same song as row/i, 'This song and that LNV row are one song.'],
  [/^(new song – )?add to (the )?lnv/i, 'Add this song to the LNV as a new row.'],
  [/^not the client's/i, 'The client did not write it: nothing goes into the LNV.'],
  [/^keep separate/i, 'These recordings are different songs: keep them apart.'],
  [/^keep: lnv$|^keeps lnv$|^keep lnv|^keep the lnv's/i, 'The LNV’s own value stays.'],
  [/^keep: ipi list$|^keeps ipi list$|^keep the ipi list/i, 'The member’s real name from the IPI / CAE list is used.'],
  [/^keep: customised$|^keeps customised$|^customise/i, 'A value typed by you is used.'],
  [/^keep: main version$|^same as (the )?main version/i, 'The same title as the main version is used.'],
  [/^keep: all isrcs$|^keeps all isrcs$|^every isrc of the song/i, 'All ISRCs of the song go in, with | between them. None twice.'],
  [/^keep: automatic$|^keeps automatic$|^the work name that is not kept/i, 'The other side’s work name is filled in by itself.'],
  [/^keep: blank$|^keeps blank$|^leave it blank$/i, 'The field stays empty in the LNV.'],
  [/^keeps? ?:? \w+/i, 'The other sheet’s value goes into the LNV.'],
  [/^goes into the lnv$/i, 'This is the value the LNV will have.'],
  [/^pick one$/i, 'The two sides differ: choose the value the LNV keeps.'],
  [/^same people – pick the spelling$/i, 'Same people, spelt differently: choose one spelling.'],
  [/^x scroll$/i, 'Show the matches side by side, Muso next to the LNV row.'],
  [/^y scroll$/i, 'Show the matches one below another.'],
  [/^differs from the main version$/i, 'Yellow means: not the same as the main version.'],
  [/^ipi list/i, 'The member’s real name in the IPI / CAE list.'],
  [/^blank in the lnv|^blank – /i, 'The LNV has nothing here, so the other sheet’s value is used.'],
  [/^linked by the app$/i, 'The app was certain and linked it by itself.'],
  [/^checked by you/i, 'You checked this match. It stays editable.'],
  [/^the app says it is this row/i, 'The app’s suggestion: tick it when it is right.'],
  [/^the app would add it as a new row/i, 'The app would make a new row: tick it if it is this row instead.'],
  [/^list locked$|^lock list$/i, 'Keep the song list open, or let it close by itself.'],
  [/^hide details$|^show details$/i, 'Open or close the main version’s details.'],
  [/^typed by you$/i, 'You typed this value.'],
  [/^remix|^lofi|^unplugged|^singer \/ language|^re-release|^original$|version$/i, 'What kind of recording this is.'],
  // ---- fields
  [/^title( in the lnv)?$/i, 'The song name. Change it right here in this row.'],
  [/^film \/ album$|^album( required)?$|^movie name/i, 'The film or album the song is from.'],
  [/^lyricists?( .*required)?$|^authors?$/i, 'Who wrote the words.'],
  [/^composers?( .*required)?$/i, 'Who made the music.'],
  [/^publishers?( optional)?$/i, 'The music company that looks after the song.'],
  [/^singers?( optional)?$/i, 'Who sings the song.'],
  [/^isrc( required)?$/i, 'The code of one recording, 12 letters and digits.'],
  [/^iswc$/i, 'The code of the composition.'],
  [/^year$|^release year/i, 'The year the song came out.'],
  [/^release date$/i, 'The full release date, from the other sheet when the LNV has none.'],
  [/^alternative work name$/i, 'The song’s other name. It fills itself; the pencil changes it.'],
  [/^link$|^song links/i, 'Where the song can be played: Spotify or another site.'],
  [/^label$/i, 'The record label.'], [/^language$/i, 'The language of the song.'], [/^length$|^duration/i, 'How long the song is.'],
  [/^iprs code$|^iprs tunecode$/i, 'IPRS’s own number for the song.'],
  [/^cae \/ ipi required$/i, 'Each name here needs its CAE / IPI number.'],
  [/^cae( number)?$|^ipi( number)?$|^cae \/ ipi$/i, 'The society’s number for a person or company.'],
  [/^required$/i, 'This must be filled in.'], [/^optional$/i, 'This may stay empty.'],
  [/^every other lnv field/i, 'All the other columns of the client’s LNV.'],
  [/^role$/i, 'What the person did: composer, author, publisher…'],
  [/^base n(o|umber)$/i, 'The society’s number for the whole member.'],
  [/^other names in the list$/i, 'The member’s pseudonyms and group names.'],
  [/^(no )?remark$|^remark$|^several remarks$/i, 'Why the song is mapped. It shows in the LNV’s Remark column.'],
  [/^edit the list in settings$/i, 'Add or change remarks. Everyone sees the same list.'],
  [/^add remark$/i, 'Add this remark to the dropdown of every user.'],
  [/^put back$/i, 'Offer it in the dropdown again.'],
  [/^settings$/i, 'Lists that are the same for every user.'],
  [/^a song of its own, mapped/i, 'It gets its own LNV row, which names the song it belongs to.'],
  // ---- IPI list, files, steps
  [/^real names \(pa\)/i, 'The member’s real name, as registered.'], [/^pseudonyms \(pp\)/i, 'Other names a member uses.'], [/^group names \(pg\)/i, 'Names of a group, never one person.'],
  [/^pp$/i, 'Pseudonym: another name the member uses.'], [/^pg$/i, 'Group name: more than one person.'],
  [/^remove names not in this file/i, 'Replace the whole list: names missing in the file are removed.'],
  [/^clear the list$/i, 'Remove every name from the IPI / CAE list.'],
  [/^new$/i, 'Added by the latest upload.'], [/^updated$/i, 'Changed by the latest upload.'],
  [/^uploads \(/i, 'The files uploaded so far, and what each changed.'],
  [/^ipi \/ cae list$/i, 'The society’s member list: real names and their numbers.'],
  [/^clients$/i, 'All your clients.'], [/^add client$/i, 'Start a new client.'], [/^lnv vs iprs$/i, 'Check the LNV against the IPRS report.'], [/^muso vs lnv$/i, 'Compare the Muso sheet with the LNV.'],
  [/^iprs( report)?$/i, 'The client’s list of songs registered at IPRS.'], [/^lnv$/i, 'The client’s own catalogue, the master file.'], [/^muso$/i, 'The sheet of songs found in the stores.'],
  [/^stage 2 lnv/i, 'The LNV after Muso vs LNV: IPRS is checked against it.'], [/^stage 1 lnv$/i, 'The LNV with the answers of Muso vs LNV.'],
  [/^download stage 1 lnv|^download the lnv/i, 'Get the LNV as Excel, with your answers in it.'], [/^download the final lnv/i, 'Get the finished LNV as Excel.'], [/^download excel/i, 'Get any list as an Excel file.'],
  [/^order: /i, 'How the rows of the downloaded LNV are sorted.'],
  [/^checked songs$/i, 'Only the songs you checked, numbered 1, 2, 3 …'], [/^every row$/i, 'The whole LNV with your answers.'],
  [/^amend(ment list.*)?$/i, 'IPRS has the song, with other details: ask for a correction.'], [/^regist(er|ration)( list.*)?$/i, 'IPRS does not have the song yet: register it.'],
  [/^to decide$/i, 'Songs where you say which IPRS work it is.'], [/^change files$/i, 'Replace one of the uploaded files.'],
  [/^follow-up tasks$|^tasks$/i, 'The work still to be done at the societies.'], [/^catalogue$/i, 'Every song of this client.'], [/^more tools$/i, 'The society workspaces and other tools.'],
  // ---- everywhere
  [/^cancel$/i, 'Close this and change nothing.'], [/^close( \(esc\))?$/i, 'Close this window.'], [/^save$/i, 'Keep what you changed.'], [/^edit$/i, 'Change these details.'], [/^replace$/i, 'Put another file in its place.'],
  [/^previous$|^prev$/i, 'Go one back.'], [/^next$/i, 'Go one further.'], [/^open$/i, 'Open this song.'], [/^← back to the (list|search)$/i, 'Back to the list.'],
  [/^got it – hide$/i, 'Hide this guide. A small link brings it back.'], [/^how this screen works$/i, 'A short guide to this screen.'],
  [/^search/i, 'Find a song, a name or a number.'], [/^sign out$/i, 'Leave the app on this computer.'], [/^sign in$/i, 'Enter the app.'], [/^change password$/i, 'Choose another password.'], [/^users$/i, 'The people who can use the app.'],
  [/^all saved .*$/i, 'Every saved answer.'], [/^what is this step\?$|^less$|^more$/i, 'Open or close the explanation.'],
  [/^(v\d+\.\d+\.\d+|.*v\d+\.\d+\.\d+)$/i, 'The app’s version. Click to see what changed.'],
]

const tidy = (t?: string) => (t ?? '').replace(/\s+/g, ' ').replace(/^[~✓✕×•·]\s*/, '').trim()
/** A longer explanation cut to its first part. */
export function shorten(t: string, max = HINT_MAX): string {
  const s = tidy(t)
  if (s.length <= max) return s
  for (const cut of ['. ', '; ', ' – ', ': ', ', ']) {
    const i = s.indexOf(cut)
    if (i > 14 && i <= max) return cut === '. ' ? s.slice(0, i + 1) : s.slice(0, i)
  }
  return `${s.slice(0, max - 1).replace(/\s\S*$/, '')}…`
}
const find = (t: string, s: HintSource) => {
  if (!t || t.length > 70) return null
  for (const [re, say] of E) { const m = t.match(re); if (m) return typeof say === 'string' ? say : say(m, s) }
  return null
}

/** The explanation of one thing on screen – null when there is nothing to explain. */
export function hintFor(s: HintSource): string | null {
  if (/\bfx-dm\b/.test(s.cls) && s.tag === 'TD') return 'Yellow: this value is not the same as the main version’s.'
  // the three section buttons under a match (v1.8)
  if (/\bcls-btn\b/.test(s.cls)) return /\bon\b/.test(s.cls) ? 'Checked here. Click again to check it later.'
    : /\bnow\b/.test(s.cls) ? 'The app puts it here. Click to confirm: it is then checked.' : `Move it to ${tidy(s.text)}. You are asked first; then it is checked.`
  const text = tidy(s.text), label = tidy(s.label), title = tidy(s.title), ph = tidy(s.placeholder)
  const known = find(text, s) ?? find(label, s)
  if (known) return known
  if (/^https?:/i.test(title)) return 'Open this link in a new tab.'
  if (title) return shorten(title)
  if (/\bsm-item\b/.test(s.cls)) return 'Open this song on the right.'
  if (/\b(rv-ver-open|fx-rec|pc-title)\b/.test(s.cls)) return 'Open this song and see its details.'
  if (/\bun-tick\b/.test(s.cls) || /^select: /i.test(label)) return 'Tick the changes you want to undo.'
  if (/\bmp-item\b/.test(s.cls)) return 'Choose this song.'
  if (/\bdd-opt\b/.test(s.cls)) return 'Choose this.'
  if (/\bkeep-chip\b|\bfc-dd\b/.test(s.cls)) return 'Which value the LNV keeps.'
  if (label && label !== text) return shorten(label)
  if (ph) return shorten(`Type here: ${ph}`)
  if (/^(BUTTON|A|SUMMARY)$/.test(s.tag) && text) return `Click to open or choose “${text.length > 40 ? `${text.slice(0, 39).trim()}…` : text}”.`
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(s.tag)) return 'Type or choose a value here.'
  return null
}
