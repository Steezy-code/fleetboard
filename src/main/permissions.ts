// What a page may do: the app's own window, and a page in a web tile.
//
// Electron's default is to grant every permission it is not told to refuse, and both handlers matter —
// a *check* with no handler falls through to that same default. A web tile browses the open web and,
// by design, the user's own dev servers, which run whatever an agent last wrote into the project.

/** Permissions that cannot reach anything outside the tile, so any page may have them. */
const HARMLESS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'])
/** And what a page served from the user's own machine may have on top of those. */
const LOOPBACK_OK = new Set(['notifications'])

const loopback = (url: string | undefined) => {
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(url ?? '').hostname)
  } catch {
    return false
  }
}

/**
 * What a page in a web tile may have.
 *
 * Electron grants everything unless told otherwise, and the answer here used to be "whatever it asks
 * for, if it is served from loopback — like a browser the user controls". But a browser *asks*, and
 * these pages are the project's own dev server, running code an agent wrote minutes ago. Everything
 * not in the harmless set went through: openExternal, which hands a URL straight to the OS protocol
 * handler; geolocation; clipboard-read; serial, hid and usb; fileSystem; idle-detection;
 * window-management; and media — the camera, which appPermission below refuses to the app's own
 * window on purpose. A tile got what the app itself would not.
 *
 * So: the harmless set for anyone, plus notifications and the microphone for loopback, and nothing
 * else. A refusal is announced, because a dev server that genuinely needs one should not be a mystery.
 */
export function webPermission(permission: string, url: string | undefined, mediaTypes?: string[]): boolean {
  if (HARMLESS.has(permission)) return true
  if (!loopback(url)) return false
  // the microphone, and only when it says so: unlike the app's own window, a request here that does
  // not name audio alone is refused rather than given the benefit of the doubt
  if (permission === 'media') return mediaTypes?.length === 1 && mediaTypes[0] === 'audio'
  return LOOPBACK_OK.has(permission)
}

/** Electron says mediaTypes on a request and mediaType on a check; 'unknown' is no answer at all. */
export function mediaTypesOf(details: unknown): string[] | undefined {
  const d = details as { mediaTypes?: string[]; mediaType?: string } | undefined
  if (d?.mediaTypes?.length) return d.mediaTypes
  return d?.mediaType && d.mediaType !== 'unknown' ? [d.mediaType] : undefined
}

/**
 * What the app's own window may have. Push-to-talk needs the microphone, and in Electron the 'media'
 * permission covers the camera too — granting it outright handed over both. Anything that asks for
 * video is refused; audio-only, and a request that does not say (older Electron, or a check rather
 * than a request), still goes through, because denying those would break push-to-talk.
 */
export function appPermission(permission: string, mediaTypes?: string[]) {
  if (permission === 'media') return !mediaTypes?.includes('video')
  return permission === 'clipboard-read' || permission === 'notifications'
}
