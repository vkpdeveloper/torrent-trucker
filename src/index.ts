#!/usr/bin/env bun
import { commandAdd } from './commands/add.ts'
import { commandPs } from './commands/ps.ts'
import { commandLs } from './commands/ls.ts'
import { commandRm } from './commands/rm.ts'
import { commandDaemon } from './commands/daemon.ts'

const args = process.argv.slice(2)
const cmd = args[0]

const HELP = `
tt — Torrent Trucker

USAGE
  tt daemon            Start the background daemon
  tt add <magnet>      Queue a magnet link for download
  tt ps                Live progress of active downloads
  tt ls                List all downloads
  tt rm <id>           Remove a download

OPTIONS
  -h, --help           Show this help
`

if (!cmd || cmd === '-h' || cmd === '--help') {
  process.stdout.write(HELP)
  process.exit(0)
}

switch (cmd) {
  case 'daemon':
    await commandDaemon()
    break
  case 'add':
    await commandAdd(args.slice(1))
    break
  case 'ps':
    await commandPs()
    break
  case 'ls':
    await commandLs()
    break
  case 'rm':
    await commandRm(args.slice(1))
    break
  default:
    process.stderr.write(`tt: unknown command "${cmd}"\nRun "tt --help" for usage.\n`)
    process.exit(1)
}
