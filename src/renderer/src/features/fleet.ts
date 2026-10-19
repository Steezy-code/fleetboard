// Lead/worker teams: the Inbox overlay and its styles.
import '../styles/fleet.css'
import { BOARD_OVERLAYS } from '../board/BoardOverlays'
import { Inbox } from '../fleet/Inbox'

if (!BOARD_OVERLAYS.includes(Inbox)) BOARD_OVERLAYS.push(Inbox)
