// Mirrors backend normalize.same_party so the UI groups people the same way the engine does.
const CORP = new Set(['ltd', 'limited', 'pvt', 'private', 'co', 'company', 'the', 'inc', 'llc', 'industries', 'india',
  'entertainment', 'entertainments', 'records', 'music'])

function tokens(name: string) {
  const all = (name.toLowerCase().match(/[a-z0-9]+/g) ?? [])
  const meaningful = all.filter((t) => !CORP.has(t))
  return meaningful.length ? meaningful : all
}

// Each word pairs with its own word (same word, or a one-letter initial of it); at least one full word must agree.
function covers(small: string[], big: string[]) {
  const pool = [...big]
  let exact = 0
  for (const x of [...small].sort((a, b) => b.length - a.length)) {
    const i = pool.indexOf(x) >= 0 ? pool.indexOf(x)
      : pool.findIndex((y) => (x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y)))
    if (i < 0) return false
    if (pool[i] === x && x.length > 1) exact++
    pool.splice(i, 1)
  }
  return exact > 0
}

const digits = (ipi: string) => ipi.replace(/\D/g, '').padStart(11, '0')

export function samePerson(a: string, b: string, ipiA = '', ipiB = '') {
  if (ipiA && ipiB && digits(ipiA) === digits(ipiB)) return true
  const x = tokens(a), y = tokens(b)
  if (!x.length || !y.length) return false
  return covers(x, y) || covers(y, x)
}

export function displayName(name: string) {
  const parts = name.split(',').map((p) => p.trim())
  const text = parts.length === 2 ? `${parts[1]} ${parts[0]}` : name
  return text.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}
