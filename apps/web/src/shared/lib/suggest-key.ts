/**
 * Suggest a KEY from a display name, so nobody has to invent one to get past a required field.
 *
 * Two shapes, because the two keys mean different things and their own forms advertise different
 * results — not because anyone preferred variety:
 *
 *   • `initials` — a TEAM key. `Core Platform` gives `CP`, which is exactly what the Create-team form
 *     shows as its placeholder. A team key is a short badge beside a name that is already on screen.
 *   • `prefix` — a PROJECT key. `Mini Rova` gives `MINI`, the behaviour the project form has always
 *     had. A project key prefixes every item id in it (`US-1`), so it reads as a word rather than as
 *     initials, and changing it would rewrite what a familiar form suggests.
 *
 * One home for both, because the project form had this logic inline and the team form had none — which
 * is how the team form came to ship with a required field, a placeholder promising `CP`, and nothing
 * filling it in.
 *
 * Always uppercase and `[A-Z0-9]` only, which is what both server schemas accept
 * (`^[A-Z][A-Z0-9]{1,9}$`). `initials` falls back to `prefix` when it cannot reach two characters —
 * a one-word name has one initial, and a one-character key is refused.
 */
export function suggestKey(
  name: string,
  { style, max }: { style: 'initials' | 'prefix'; max: number },
): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

  if (style === 'initials') {
    const initials = name
      .trim()
      .split(/\s+/)
      .map((word) => clean(word).charAt(0))
      .filter(Boolean)
      .join('')
    if (initials.length >= 2) return initials.slice(0, max)
  }

  return clean(name).slice(0, max)
}
