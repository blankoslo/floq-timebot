import moment from "moment";

export function formatHours(n: number): string {
  // One decimal always (Norwegian comma) — keeps "7,0 t" aligned with
  // "7,5 t" in the day list and makes the table easier to scan.
  return n.toFixed(1).replace(".", ",");
}

export function formatHoursShort(n: number): string {
  // Strip trailing ",0" — used in the headline where "30 / 30 t" reads
  // cleaner than "30,0 / 30,0 t".
  return formatHours(n).replace(/,0$/, "");
}

export function formatSignedHours(n: number): string {
  // For deltas (flexitime change). Round to zero when within rounding error.
  if (Math.abs(n) < 0.05) return "0 t";
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${formatHours(Math.abs(n))} t`;
}

// "29. september og 1. oktober", "2., 9. og 16. september".
export function formatDates(dates: string[]): string {
  const parts = dates.map((d, i) => {
    const m = moment(d);
    const next = dates[i + 1];
    return next && moment(next).month() === m.month()
      ? m.format("D.")
      : m.format("D. MMMM");
  });
  return parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} og ${parts[parts.length - 1]}`;
}
