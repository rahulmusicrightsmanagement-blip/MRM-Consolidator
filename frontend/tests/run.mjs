// Unit tests of step 2's answer logic (no browser): each tests/*.test.ts is bundled with rolldown (it reads the app's
// TypeScript and JSX) into a temporary folder, then run with Node's own test runner.   npm test
import { readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'rolldown'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'mrm-tests-'))
const files = readdirSync(here).filter((f) => f.endsWith('.test.ts'))
try {
  for (const f of files) {
    await build({ input: join(here, f), platform: 'node', logLevel: 'warn', external: [/^node:/],
      output: { file: join(out, f.replace(/\.ts$/, '.mjs')), format: 'esm' } })
  }
  const r = spawnSync(process.execPath, ['--test', ...files.map((f) => join(out, f.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' })
  process.exitCode = r.status ?? 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
