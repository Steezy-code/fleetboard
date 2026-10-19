import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import './styles/board.css'
import { App } from './App'
import { Boundary } from './ui/Boundary'

// last resort: whatever fails above every other boundary still leaves a way out
createRoot(document.getElementById('root')!).render(
  <Boundary what="Fleetboard" actions={[{ label: 'Reload', run: () => location.reload() }]}>
    <App />
  </Boundary>
)
