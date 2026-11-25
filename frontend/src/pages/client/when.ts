/** When something was saved, in the reviewer's own time. No React here. */
export function whenText(iso: string, full = false): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const time = t.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  const day = t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (full) return `${day}, ${time}`
  return t.toDateString() === today.toDateString() ? `today, ${time}` : t.toDateString() === yesterday.toDateString() ? `yesterday, ${time}` : `${day}, ${time}`
}
