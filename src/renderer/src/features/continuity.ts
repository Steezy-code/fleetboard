// Continuity feature entry: usage watch (pill + drawer), accounts, memory, skills, settings styles.
import '../styles/continuity.css'
import { registerEngine } from '../engine/engines'
import { startUsageWatch } from '../continuity/usageStore'

registerEngine(() => startUsageWatch())
