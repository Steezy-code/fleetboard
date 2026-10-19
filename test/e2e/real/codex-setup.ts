// A sandbox where `codex` is the real Codex CLI talking to a local mock of the Responses API.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Sandbox } from '../harness'

export function setupCodex(sb: Sandbox, repo: string, codex: string, mockPort: number) {
  fs.writeFileSync(path.join(sb.bin, 'codex'), `#!/bin/sh\nexec "${codex}" "$@"\n`, { mode: 0o755 })
  fs.appendFileSync(path.join(sb.home, '.bash_profile'), 'export MOCK_KEY=mock\n')
  fs.mkdirSync(path.join(sb.home, '.codex'), { recursive: true })
  fs.writeFileSync(
    path.join(sb.home, '.codex', 'config.toml'),
    [
      'model = "mock-model"',
      'model_provider = "mock"',
      // a catalog entry for the mock model: without it Codex offers the model no tools
      ...(process.env.FLEETBOARD_CODEX_CATALOG ? [`model_catalog_json = ${JSON.stringify(process.env.FLEETBOARD_CODEX_CATALOG)}`] : []),
      'check_for_update_on_startup = false',
      '[model_providers.mock]',
      'name = "Mock"',
      `base_url = "http://127.0.0.1:${mockPort}/v1"`,
      'wire_api = "responses"',
      'env_key = "MOCK_KEY"',
      `[projects.${JSON.stringify(repo)}]`,
      'trust_level = "trusted"',
      '[tui]',
      'screen_reader_detection_done = true'
    ].join('\n') + '\n'
  )
}

/** Codex starts a background app-server of its own; it would outlive the test (and hold its pipes). */
export function stopCodexDaemons(sb: Sandbox) {
  try {
    execFileSync('pkill', ['-f', `${sb.home}/.codex/`])
  } catch {
    /* none left */
  }
}
