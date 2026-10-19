import { useEffect } from 'react'
import { useApp } from './state/store'
import type { Recovery } from '@shared/types'
import { on, invoke } from './lib/api'
import { wireConsoleEvents } from './engine/consoles'
import { wireFleet } from './engine/fleet'
import { startEngines } from './engine/engines'
import { Board } from './board/Board'
import { TopBar } from './chrome/TopBar'
import { LeftRail, RightRail } from './chrome/Rails'
import { BottomBar, BottomLeft, ZoomControl } from './chrome/BottomBar'
import { Home } from './chrome/Home'
import { Minimap } from './chrome/Minimap'
import { FocusBar } from './chrome/FocusBar'
import { Overlays } from './ui/Overlays'
import { DRAWERS, PANELS } from './panels/registry'
import { BoardOverlays } from './board/BoardOverlays'
import './features'
import './debug'

export function App() {
  const project = useApp((s) => s.project)
  const panel = useApp((s) => s.panel)
  const drawer = useApp((s) => s.drawer)
  const focused = useApp((s) => !!s.focusedNode)

  useEffect(() => {
    useApp.getState().init()
    wireConsoleEvents()
    wireFleet()
    startEngines()
    return on('app:confirmQuit', async (n: number) => {
      const ok = await useApp.getState().confirm({
        title: `Quit with ${n} console${n === 1 ? '' : 's'} running?`,
        body: 'Their processes stop. When you reopen, each console comes back in place and offers to resume its conversation.',
        confirm: 'Quit',
        danger: true
      })
      if (ok) {
        const p = useApp.getState().project
        if (p) await invoke('store:saveProject', p)
        invoke('app:quit')
      }
    })
  }, [])

  // a state file that could not be read was set aside and restored from a snapshot: say so
  useEffect(() => {
    const tell = (r: Recovery) => {
      const when = r.snapshot ? new Date(Number(/-(\d+)\.json$/.exec(r.snapshot)?.[1])).toLocaleString() : ''
      const what = r.what === 'app' ? 'The settings file' : "This board's file"
      const then = r.snapshot ? `restored the copy saved ${when}` : r.what === 'app' ? 'started with default settings' : 'started an empty board'
      useApp.getState().toast(`${what} could not be read, so Fleetboard ${then}. The damaged file is kept at ${r.corruptCopy}`, 'warn')
    }
    invoke<Recovery[]>('store:recoveries')
      .then((rs) => rs.filter((r) => r.what === 'app').forEach(tell))
      .catch(() => {})
    return on('store:recovered', tell)
  }, [])

  const Panel = panel ? PANELS[panel.name] : null
  const DrawerC = drawer ? DRAWERS[drawer.name] : null

  return (
    <div className="app">
      {project ? (
        <>
          <Board key={project.activeWorkspaceId} />
          <TopBar />
          {/* rails and bars step aside in focus mode; the Inbox stays */}
          <div className={`board-chrome ${focused ? 'hidden' : ''}`}>
            <LeftRail />
            <RightRail />
            <BottomBar />
            <BottomLeft />
            <ZoomControl />
            <Minimap />
          </div>
          <FocusBar />
          <BoardOverlays />
          {DrawerC && <DrawerC {...(drawer!.props ?? {})} />}
        </>
      ) : (
        <Home />
      )}
      {Panel && <Panel {...(panel!.props ?? {})} />}
      <Overlays />
    </div>
  )
}
