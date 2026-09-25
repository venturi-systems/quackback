import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'

interface TimeAgoProps {
  date: Date | string
  className?: string
}

function getTimeAgo(date: Date | string | null | undefined): string {
  if (!date) return ''
  const d = typeof date === 'string' ? new Date(date) : date
  // Check for invalid date
  if (isNaN(d.getTime())) return ''
  return formatDistanceToNow(d, { addSuffix: true })
}

export function TimeAgo({ date, className }: TimeAgoProps) {
  // Initialize with computed value for SSR
  const [timeAgo, setTimeAgo] = useState<string>(() => getTimeAgo(date))
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    // Update immediately in case server/client time differs slightly
    setTimeAgo(getTimeAgo(date))

    // Update every minute
    const interval = setInterval(() => {
      setTimeAgo(getTimeAgo(date))
    }, 60000)

    return () => clearInterval(interval)
  }, [date])

  // The server and the browser compute the distance at different moments, so
  // across a boundary ("less than a minute ago" / "1 minute ago") the text
  // legitimately differs and React fails hydration on it: the signed-in render
  // check caught a text hydration failure (minified error #418) on the admin
  // feed, whose post cards render this component. The mismatch is expected for
  // this one text node, so its warning is suppressed; the span is then
  // remounted once after mount, because a suppressed mismatch otherwise keeps
  // showing the server's text.
  return (
    <span key={mounted ? 'mounted' : 'hydrating'} className={className} suppressHydrationWarning>
      {timeAgo}
    </span>
  )
}
