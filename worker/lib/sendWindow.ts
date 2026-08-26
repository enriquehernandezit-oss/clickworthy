// Business-hours send window. Cold email lands best mid-morning on a weekday,
// and a restaurant owner should never get a 6am ping — so every outbound Touch
// 1 / bump is gated to 9am–12pm LOCAL TIME for the recipient, Monday–Friday.
//
// "Local" is the recipient's, not ours: the target cities span ET→PT, so a
// single sender-clock window can't be business hours for everyone (10am AST is
// 6am in Los Angeles). We map each target city to its IANA zone and check the
// wall clock THERE. An unmapped city falls back to the sender's zone (AST) so
// it still sends in a sane window rather than never.
//
// This gates the actual send (worker/jobs/sendOutreach.ts + sendBumps.ts), not
// the cron: drafting stays frequent so the review pile is always fresh, and
// bumps (which fire on the reply-poll cron, not the send cron) are covered by
// the same check. Pure + dependency-free so it's unit-tested against fixed
// UTC instants (see sendWindow.test.ts).

// AST — the sender's zone (Puerto Rico, UTC-4 year-round, no DST). The fallback
// for any recipient city we can't map.
export const SENDER_TIME_ZONE = "America/Puerto_Rico";

// The 9am–12pm local window, and the weekdays it applies on (1=Mon … 5=Fri).
export const SEND_WINDOW = { startHour: 9, endHour: 12 } as const;

// config.targetCities → IANA zone. Keys are lowercased city names WITHOUT the
// state suffix ("miami", not "Miami, FL"); resolveTimeZone() normalizes the
// stored restaurant.city (free-text from Google Places) before lookup.
export const CITY_TIME_ZONES: Record<string, string> = {
  miami: "America/New_York",
  "new york": "America/New_York",
  chicago: "America/Chicago",
  nashville: "America/Chicago",
  denver: "America/Denver",
  "los angeles": "America/Los_Angeles",
  "san diego": "America/Los_Angeles",
};

// Normalize a stored city string to a lookup key: take the part before the
// first comma (drops ", FL"), lowercase, collapse whitespace. Returns the
// matched IANA zone, or the sender zone when nothing matches.
export function resolveTimeZone(city: string | null | undefined): string {
  if (!city) return SENDER_TIME_ZONE;
  const key = city.split(",")[0]!.trim().toLowerCase().replace(/\s+/g, " ");
  if (CITY_TIME_ZONES[key]) return CITY_TIME_ZONES[key];
  // Substring fallback — Google sometimes returns a neighborhood ("Wynwood")
  // or a fuller name; match any known city contained in the string.
  for (const [name, tz] of Object.entries(CITY_TIME_ZONES)) {
    if (key.includes(name)) return tz;
  }
  return SENDER_TIME_ZONE;
}

// Does an explicit CITY_TIME_ZONES entry exist for this city (i.e. NOT the
// silent AST fallback)? Used by the boot coverage check below.
export function hasExplicitTimeZone(city: string): boolean {
  const key = city.split(",")[0]!.trim().toLowerCase().replace(/\s+/g, " ");
  if (CITY_TIME_ZONES[key]) return true;
  return Object.keys(CITY_TIME_ZONES).some((name) => key.includes(name));
}

// Returns the target cities that have NO timezone mapping and would fall back
// to the sender's AST — meaning outreach to them could fire hours off local
// business time (e.g. Phoenix, UTC-7, gated on a UTC-4 clock → ~6am sends).
// The worker logs a loud warning at boot for any of these (worker/index.ts),
// and a test asserts the shipped default list is fully covered so this can't
// regress silently when someone edits targetCities + CITY_TIME_ZONES apart.
export function uncoveredCities(cities: string[]): string[] {
  return cities.filter((c) => !hasExplicitTimeZone(c));
}

// The hour (0–23) and ISO weekday (1=Mon … 7=Sun) at `nowMs` in `tz`.
// Intl is the only DST-correct way to read a wall clock in another zone;
// AST has no DST but ET/CT/MT/PT do, so this must not hardcode offsets.
function zonedNow(tz: string, nowMs: number): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(nowMs));

  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const wdStr = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { hour: Number(hourStr) % 24, weekday: WEEKDAYS[wdStr] ?? 1 };
}

// Is it currently inside the recipient's local send window? Weekday
// (Mon–Fri) AND startHour ≤ localHour < endHour, evaluated in the recipient's
// own zone.
export function isInLocalWindow(city: string | null | undefined, nowMs: number): boolean {
  const { hour, weekday } = zonedNow(resolveTimeZone(city), nowMs);
  const isWeekday = weekday >= 1 && weekday <= 5;
  return isWeekday && hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour;
}

// Human-readable window description for the Controls page — e.g.
// "9am–12pm local time, Mon–Fri (per recipient's city)".
export function describeSendWindow(): string {
  const fmt = (h: number) => {
    const period = h >= 12 ? "pm" : "am";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${period}`;
  };
  return `${fmt(SEND_WINDOW.startHour)}–${fmt(SEND_WINDOW.endHour)} local time, Mon–Fri (per recipient's city)`;
}
