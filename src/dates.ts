// All calendar math is done on local-time YYYY-MM-DD strings. Constructing
// Date only via (y, m-1, d) numeric args keeps everything in local time.
export function toDateStr(y: number, m: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${y}-${pad(m)}-${pad(d)}`
}

export function parseDateStr(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number)
  return { y, m, d }
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDateStr(date)
  const dt = new Date(y, m - 1, d + n)
  return toDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
}

export function todayStr(): string {
  const now = new Date()
  return toDateStr(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

export function formatDateLong(date: string): string {
  const { y, m, d } = parseDateStr(date)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function monthLabel(y: number, m: number): string {
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

export function firstWeekday(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay()
}
