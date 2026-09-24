export type ExecutionTimeZone = "UTC" | "Europe/Warsaw";

const warsaw = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function parseIbExecutionTime(raw: string, configuredTimeZone?: ExecutionTimeZone): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2}) +([0-9]{2}):([0-9]{2}):([0-9]{2})(?: (UTC|GMT))?$/.exec(raw);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < 2000 || year > 2100) return null;
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() + 1 !== month ||
    wall.getUTCDate() !== day || wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second) return null;
  if (match[7] || configuredTimeZone === "UTC") return wall;
  if (configuredTimeZone !== "Europe/Warsaw") return null;

  // Warsaw uses UTC+1/UTC+2 in the supported calendar range. Require exactly
  // one round trip: a DST gap has no match and an ambiguous repeated hour has two.
  const candidates = [1, 2].map(offset => new Date(wall.getTime() - offset * 3_600_000))
    .filter(date => {
      const parts = Object.fromEntries(warsaw.formatToParts(date).map(p => [p.type, p.value]));
      return Number(parts.year) === year && Number(parts.month) === month && Number(parts.day) === day &&
        Number(parts.hour) === hour && Number(parts.minute) === minute && Number(parts.second) === second;
    });
  return candidates.length === 1 ? candidates[0] : null;
}
