// Lets `node --test` import the app's TypeScript sources as they are: path aliases (@shared, @),
// extensionless relative imports, TS/TSX (compiled with the same oxc transform Vite uses) and
// asset imports (CSS, ?worker, ?url) that only mean something to the bundler.
// Usage: node --import ./test/support/register.mjs --test ...
import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)
