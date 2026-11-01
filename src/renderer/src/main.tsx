import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './styles/board.css'
import './styles/motion.css'
import { App } from './App'
import { Boundary } from './ui/Boundary'
import { catchStrayErrors } from './lib/strayErrors'

// before anything renders: errors React's boundaries never see (a rejected promise, a worker, a
// listener that throws after render) used to go nowhere at all
catchStrayErrors()

// last resort: whatever fails above every other boundary still leaves a way out
createRoot(document.getElementById('root')!).render(
  <Boundary what="Fleetboard" actions={[{ label: 'Reload', run: () => location.reload() }]}>
    <App />
  </Boundary>
)
