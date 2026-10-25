import { TeamGuide } from './chrome/TeamGuide'
import { useEffect, useRef } from 'react'
import { useApp } from './state/store'
import { SCHEMA_VERSION, type Recovery } from '@shared/types'
import { request, errorText, fb, on, invoke } from './lib/api'
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
import { Boundary } from './ui/Boundary'
import { useThemeSync } from './ui/theme'
import { InboxTray } from './fleet/InboxTray'
import { useInboxWatcher } from './fleet/inboxModel'
import { mayDropUnsaved } from './lib/unsaved'
import { useAsciiReveal } from 'ascii-reveal'
import { markBoardRevealed } from './lib/reveal'

export function App() {
  const project = useApp((s) => s.project)
  const panel = useApp((s) => s.panel)
  const drawer = useApp((s) => s.drawer)
  const focused = useApp((s) => !!s.focusedNode)
  // One wave over everything on screen the first time the board is up. The glyph grid is measured
  // from the real elements where they already are, so what scrambles is the shape of the content it
  // is about to become — no hand-written skeleton to keep in step with the layout.
  const launch = useAsciiReveal({ preset: 'terminal', revealOnMount: false })
  const launched = useRef(false)

  useThemeSync()
  useInboxWatcher()

  useEffect(() => {
    if (!project || launched.current) return
    launched.current = true
    // cinematic is the slow showcase wave; 'fast' here keeps data readable in ~400 ms instead
    // mark it done either way: a wave that failed must not stop later consoles animating
    void launch.reveal({ duration: 'cinematic' }).then(markBoardRevealed, markBoardRevealed)
  }, [project, launch])

  useEffect(() => {
    useApp.getState().init()
    wireConsoleEvents()
    wireFleet()
    startEngines()
    /** Save the board now (the normal save is debounced), then quit. */
    const saveThenQuit = async () => {
      const p = useApp.getState().project
      if (p) {
        // a save that fails must not keep the app from quitting, nor lose the board without a word
        const failed = await request('store:saveProject', p).then(
          () => null,
          (e) => errorText(e)
        )
        if (failed) {
          const anyway = await useApp.getState().confirm({
            title: 'The board could not be saved',
            body: `${failed}. Quit anyway? Changes since the last save are lost.`,
            confirm: 'Quit anyway',
            danger: true
          })
          if (!anyway) return
        }
      }
      invoke('app:quit')
    }
    const offConfirm = on('app:confirmQuit', async (n: number) => {
      if (!(await mayDropUnsaved('Quit'))) return
      const ok = await useApp.getState().confirm({
        title: `Quit with ${n} console${n === 1 ? '' : 's'} running?`,
        body: 'Their processes stop. When you reopen, each console comes back in place and offers to resume its conversation.',
        confirm: 'Quit',
        danger: true
      })
      if (ok) await saveThenQuit()
    })
    // Closing with nothing running asks nothing, but the board still has to be written: the debounced
    // save may be mid-wait. The ack goes first, so the main process knows this page is alive and does
    // not close the window out from under the save.
    const offSaveAndQuit = on('app:saveAndQuit', async () => {
      fb.send('app:quitAck')
      // unsaved edits in an editor: asked first, and "no" leaves the window open (nothing quits
      // until this page says app:quit)
      if (!(await mayDropUnsaved('Quit'))) return
      void saveThenQuit()
    })
    return () => {
      offConfirm()
      offSaveAndQuit()
    }
  }, [])

  // a state file that could not be read was set aside and restored from a snapshot: say so
  useEffect(() => {
    const tell = (r: Recovery) => {
      if (r.tooNew) {
        useApp
          .getState()
          .toast(
            `This board was saved by a newer version of Fleetboard (board format ${r.tooNew}; this one reads ${SCHEMA_VERSION}). It was left untouched and not opened. Update Fleetboard to open it.`,
            'warn'
          )
        return
      }
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
    <div className="app" ref={launch.ref}>
      {project ? (
        <>
          <Boundary what="The board" resetKey={project.activeWorkspaceId} actions={[{ label: 'Back to home', run: () => useApp.getState().closeProject() }]}>
            <Board key={project.activeWorkspaceId} />
          </Boundary>
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
          {focused && <InboxTray floating />}
          <BoardOverlays />
          <TeamGuide />
          {DrawerC && (
            <Boundary what={`The ${drawer!.name} drawer`} resetKey={drawer} actions={[{ label: 'Close', run: () => useApp.getState().closeDrawer() }]}>
              <DrawerC {...(drawer!.props ?? {})} />
            </Boundary>
          )}
        </>
      ) : (
        <Home />
      )}
      {Panel && (
        <Boundary what={`The ${panel!.name} panel`} resetKey={panel} actions={[{ label: 'Close', run: () => useApp.getState().closePanel() }]}>
          <Panel {...(panel!.props ?? {})} />
        </Boundary>
      )}
      <Overlays />
    </div>
  )
}
