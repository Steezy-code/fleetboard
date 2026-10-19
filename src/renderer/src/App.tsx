import { useEffect } from 'react'
import { useApp } from './state/store'
import { on, invoke } from './lib/api'
import { wireConsoleEvents } from './engine/consoles'
import { startEngines } from './engine/engines'
import { Board } from './board/Board'
import { TopBar } from './chrome/TopBar'
import { LeftRail, RightRail } from './chrome/Rails'
import { BottomBar, BottomLeft, ZoomControl } from './chrome/BottomBar'
import { Home } from './chrome/Home'
import { Minimap } from './chrome/Minimap'
import { Overlays } from './ui/Overlays'
import { DRAWERS, PANELS } from './panels/registry'
import { BoardOverlays } from './board/BoardOverlays'
import './features'

export function App() {
  const project = useApp((s) => s.project)
  const panel = useApp((s) => s.panel)
  const drawer = useApp((s) => s.drawer)

  useEffect(() => {
    useApp.getState().init()
    wireConsoleEvents()
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

  const Panel = panel ? PANELS[panel.name] : null
  const DrawerC = drawer ? DRAWERS[drawer.name] : null

  return (
    <div className="app">
      {project ? (
        <>
          <Board key={project.activeWorkspaceId} />
          <TopBar />
          <LeftRail />
          <RightRail />
          <BottomBar />
          <BottomLeft />
          <ZoomControl />
          <Minimap />
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
