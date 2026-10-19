// A sandbox where `gemini` is the real Gemini CLI talking to a local mock of the Gemini API.
import fs from 'node:fs'
import path from 'node:path'
import type { Sandbox } from '../harness'

export function setupGemini(sb: Sandbox, repo: string, gemini: string, mockPort: number) {
  fs.writeFileSync(path.join(sb.bin, 'gemini'), `#!/bin/sh\nexec "${gemini}" "$@"\n`, { mode: 0o755 })
  fs.appendFileSync(path.join(sb.home, '.bash_profile'), `export GEMINI_API_KEY=mock GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:${mockPort}\n`)
  const dot = path.join(sb.home, '.gemini')
  fs.mkdirSync(dot, { recursive: true })
  fs.writeFileSync(path.join(dot, 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }))
  fs.writeFileSync(path.join(dot, 'trustedFolders.json'), JSON.stringify({ [repo]: 'TRUST_FOLDER' }))
}
