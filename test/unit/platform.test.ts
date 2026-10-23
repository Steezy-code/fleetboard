// Windows support that can be checked anywhere: reading npm's .cmd wrappers, cmd.exe quoting, PATH
// lookup whatever the variable's case. (Process trees and PowerShell consoles are covered by CI on Windows.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cmdQuote, findExecutable, pathOf, shimScript } from '../../src/main/platform'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-platform-'))

test("an npm .cmd wrapper gives the script it runs with node; anything else doesn't", () => {
  const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code')
  fs.mkdirSync(pkg, { recursive: true })
  fs.writeFileSync(path.join(pkg, 'cli.js'), '')
  const shim = path.join(dir, 'claude.cmd')
  // what npm writes (cmd-shim), CRLF and all
  fs.writeFileSync(
    shim,
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'
    ].join('\r\n')
  )
  assert.equal(shimScript(shim), path.join(dir, 'node_modules\\@anthropic-ai\\claude-code\\cli.js'.replace(/\\/g, path.sep)))
  const other = path.join(dir, 'build.cmd')
  fs.writeFileSync(other, '@echo off\r\nmsbuild %*\r\n')
  assert.equal(shimScript(other), null)
  assert.equal(shimScript(path.join(dir, 'missing.cmd')), null)
})

test('cmd.exe quoting keeps spaces, quotes and trailing backslashes intact', () => {
  assert.equal(cmdQuote('plain'), 'plain')
  assert.equal(cmdQuote('two words'), '"two words"')
  // doubled, not backslash-escaped: cmd.exe counts raw quotes, so \" would end the quoted run and
  // let whatever follows be read as shell syntax (model-written prompts reach this on Windows)
  assert.equal(cmdQuote('say "hi"'), '"say ""hi"""')
  assert.equal(cmdQuote('x" & calc & "y'), '"x"" & calc & ""y"', 'a quote cannot break out into a command')
  assert.equal(cmdQuote('C:\\dir with space\\'), '"C:\\dir with space\\\\"')
  assert.equal(cmdQuote(''), '""')
  assert.equal(cmdQuote('a&b'), '"a&b"')
})

test('PATH is found whatever its case (Windows spells it Path)', () => {
  assert.equal(pathOf({ Path: 'C:\\bin' }), 'C:\\bin')
  assert.equal(pathOf({ PATH: '/usr/bin', Path: 'x' }), '/usr/bin')
  assert.equal(pathOf({}), '')
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  // Windows needs an extension from PATHEXT (and prefers it in that order); POSIX the executable bit
  const tool = path.join(bin, process.platform === 'win32' ? 'mytool.cmd' : 'mytool')
  fs.writeFileSync(tool, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(findExecutable('mytool', { Path: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }), tool)
  assert.equal(findExecutable('nothere', { PATH: bin }), null)
})

/** How a C runtime (post-2008 MSVCRT/UCRT, CommandLineToArgvW) splits a command line into argv. */
function crtSplit(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++
    if (i >= line.length) break
    let arg = ''
    let quoted = false
    while (i < line.length && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
      if (line[i] === '\\') {
        let n = 0
        while (line[i] === '\\') (n++, i++)
        // backslashes count only before a quote: 2n give n and leave the quote to act; 2n+1 give n and a literal quote
        if (line[i] !== '"') arg += '\\'.repeat(n)
        else {
          arg += '\\'.repeat(Math.floor(n / 2))
          if (n % 2) (arg += '"', i++)
        }
      } else if (line[i] === '"') {
        if (quoted && line[i + 1] === '"') (arg += '"', (i += 2))
        else (quoted = !quoted, i++)
      } else arg += line[i++]
    }
    out.push(arg)
  }
  return out
}

test('a prompt with backslashes and quotes reaches a .cmd CLI as one argument', () => {
  for (const prompt of ['x\\" --dangerously-skip-permissions', 'a\\\\" b', 'path C:\\dir\\ "quoted" \\"end', 'ends with \\', 'plain " quote']) {
    const line = ['agent.exe', '-p', prompt].map(cmdQuote).join(' ')
    assert.deepEqual(crtSplit(line), ['agent.exe', '-p', prompt], JSON.stringify(prompt))
  }
})
