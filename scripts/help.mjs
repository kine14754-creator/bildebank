#!/usr/bin/env node
/**
 * `npm run help`: a short overview of the commands in this repo.
 *
 * The text lives in package.json, next to the scripts it describes:
 *   scriptsHelp   one entry per npm script: { desc, examples[] }
 *   commandsHelp  useful commands that are not npm scripts (e.g. npx wrangler tail)
 * A script without an entry is still listed, with a reminder to describe it.
 */
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const scripts = pkg.scripts ?? {}
const help = pkg.scriptsHelp ?? {}
const other = pkg.commandsHelp ?? {}

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s)
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s)

function section(title, entries) {
  console.log(bold(title))
  const width = Math.max(...entries.map(([name]) => name.length))
  for (const [name, { desc, examples = [] }] of entries) {
    console.log(`  ${bold(name.padEnd(width))}  ${desc}`)
    for (const ex of examples) console.log(`      ${dim('$')} ${ex}`)
  }
  console.log()
}

// package.json order of `scripts`, with the help text for each.
const entries = Object.keys(scripts).map((name) => [
  name,
  help[name] ?? { desc: `(no description; add one under scriptsHelp) → ${scripts[name]}` },
])
const stale = Object.keys(help).filter((name) => name !== '//' && !(name in scripts))

console.log()
section('npm scripts', entries)
if (Object.keys(other).length) section('Other commands', Object.entries(other))
if (stale.length) console.log(dim(`scriptsHelp has entries for missing scripts: ${stale.join(', ')}\n`))
