// Shared between the server page (validates ?sort= and builds the orderBy)
// and the client SortSelect (renders the options) so the two can't drift.

export const SORT_OPTIONS = [
  { value: "date-asc", label: "Date drafted — oldest first" },
  { value: "date-desc", label: "Date drafted — newest first" },
  { value: "restaurant", label: "Restaurant name (A–Z)" },
  { value: "city", label: "City (A–Z)" },
] as const;

export type SortValue = (typeof SORT_OPTIONS)[number]["value"];

const VALUES = SORT_OPTIONS.map((o) => o.value) as readonly string[];

// Default matches the queue's original behavior (oldest first — work through
// the pile in the order it arrived) so leaving ?sort= off changes nothing.
export function parseSort(raw: string | string[] | undefined): SortValue {
  return typeof raw === "string" && VALUES.includes(raw) ? (raw as SortValue) : "date-asc";
}
