import { useEffect, useState } from 'react'

/** The time, re-rendered every `ms`: for figures that age ("12 min") without anything else changing. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}
