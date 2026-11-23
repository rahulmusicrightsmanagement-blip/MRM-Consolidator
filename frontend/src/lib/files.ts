/** A file the server made, saved by the browser: the link is in the page while it is clicked and the file is kept a
 *  moment – Firefox and Safari drop a download whose link is not in the page or whose file is freed at once. */
export function saveBlob(blob: Blob, name: string) {
  const href = URL.createObjectURL(blob)
  const link = Object.assign(document.createElement('a'), { href, download: name, style: 'display:none' })
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(href), 60_000)
}
