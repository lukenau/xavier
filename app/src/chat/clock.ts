// How a message's time reads on its bubble.
//
// `created_at` is the server's stamp (ISO, UTC), rendered in the phone's own
// zone. The time alone within a day; the weekday joins it once the message is
// from another day, and the date once it is from another year — enough to
// place a message without reading a full timestamp on every row.
export function clockOf(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  if (!Number.isFinite(when.getTime())) return '';
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay =
    when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
  if (sameDay) return time;
  const sameYear = when.getFullYear() === now.getFullYear();
  const day = when.toLocaleDateString([], sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  return `${day} · ${time}`;
}
