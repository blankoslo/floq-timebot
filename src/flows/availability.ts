import moment from "moment";
import { CAPACITY_CHANNEL, CAPACITY_WEEKS_AHEAD, now } from "../config.js";
import { AbsenceRow, EmployeeRow, HolidayRow } from "../types.js";
import { SlackMessage, headerCell, postMessage, textCell } from "../slack.js";
import {
  apiGet,
  fetchAllAbsencesForWeek,
  fetchAllEmployees,
  fetchHolidays,
} from "../api.js";

// "Ledig" mirrors Floq's own availability model (floq-db `available_dates`):
// a working day is free when it's a weekday, not a holiday, and the employee
// isn't fully booked that day. Bookings come from two sources — planned
// staffing (the `staffing` table) and the absence calendar (`absence`, e.g.
// Ferie/Permisjon). We sum both percentages per (employee, day); any day with
// < 100 % booked has free capacity. Anyone with one or more such days in the
// window shows up in the overview.
//
// Everything is fetched in bulk (4 calls total: employees, staffing, absence,
// holidays) and the per-employee loop runs in memory — no
// per-employee API round-trips.

type StaffingRow = {
  employeeId: number;
  date: string; // YYYY-MM-DD
  percentage: number;
};

type WeekFreeDays = {
  isoWeek: number;
  freeDays: number;
};

type EmployeeAvailability = {
  name: string;
  role: string;
  totalFreeDays: number;
  // Only weeks that actually have free days, in chronological order.
  perWeek: WeekFreeDays[];
};

// Desired role ordering in the overview. Anything unknown sorts last.
const ROLE_ORDER = ["Designer", "Teknolog", "Annet"];
function roleRank(role: string): number {
  const i = ROLE_ORDER.indexOf(role);
  return i === -1 ? ROLE_ORDER.length : i;
}

// Overlap semantics, as floq-db's get_employees_in_dates had them: anyone
// employed for any part of the window. computeAvailability then drops the
// days outside each person's ansettelse. No hire date means not (yet)
// employed, as the RPC's `date_of_employment <= end_date` read it.
function employedInWindow(
  employees: EmployeeRow[],
  startDate: string,
  endDate: string,
): EmployeeRow[] {
  return employees.filter(
    (e) =>
      e.dateOfEmployment !== null &&
      e.dateOfEmployment <= endDate &&
      (e.terminationDate === null || e.terminationDate >= startDate),
  );
}

async function fetchStaffingForRange(
  startDate: string,
  endDate: string,
): Promise<StaffingRow[]> {
  return apiGet<StaffingRow[]>(
    `/staffing/days?from=${startDate}&to=${endDate}`,
  );
}

// "employeeId|date" → summed booked percentage. Multiple staffing rows (several
// projects on the same day) and absence all add up.
function bookingKey(employeeId: number, date: string): string {
  return `${employeeId}|${date}`;
}

function computeAvailability(
  employees: EmployeeRow[],
  staffing: StaffingRow[],
  absences: AbsenceRow[],
  workdays: Array<{ date: string; isoWeek: number }>,
): EmployeeAvailability[] {
  const bookedByEmpDate = new Map<string, number>();
  const addBooking = (empId: number, date: string, pct: number) => {
    const k = bookingKey(empId, date);
    bookedByEmpDate.set(k, (bookedByEmpDate.get(k) ?? 0) + pct);
  };
  for (const s of staffing) addBooking(s.employeeId, s.date, s.percentage);
  for (const a of absences) addBooking(a.employeeId, a.date, a.percentage);

  const result: EmployeeAvailability[] = [];
  let clampedCount = 0;
  for (const e of employees) {
    const perWeekMap = new Map<number, number>();
    let total = 0;
    // Days outside the employment period aren't capacity. Staffing rows simply
    // stop at termination, so without this a leaver who was booked 100 % right
    // up to their last day reads as fully ledig afterwards — and a new hire
    // reads as ledig before they start.
    let clamped = false;
    for (const wd of workdays) {
      // Dates are fixed-width YYYY-MM-DD, so string order is date order.
      if (e.dateOfEmployment && wd.date < e.dateOfEmployment) {
        clamped = true;
        continue;
      }
      if (e.terminationDate && wd.date > e.terminationDate) {
        clamped = true;
        continue;
      }
      const booked = bookedByEmpDate.get(bookingKey(e.id, wd.date)) ?? 0;
      // Strictly less than 100 % booked → there's capacity to sell that day.
      if (booked < 100 - 1e-9) {
        total += 1;
        perWeekMap.set(wd.isoWeek, (perWeekMap.get(wd.isoWeek) ?? 0) + 1);
      }
    }
    if (clamped) clampedCount += 1;
    if (total === 0) continue;
    const perWeek = Array.from(perWeekMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([isoWeek, freeDays]) => ({ isoWeek, freeDays }));
    result.push({
      name: `${e.firstName} ${e.lastName}`,
      role: e.role ?? "",
      totalFreeDays: total,
      perWeek,
    });
  }
  // Group by role (Designer → Teknolog → Annet); within a role, most
  // available first, then by name.
  result.sort(
    (a, b) =>
      roleRank(a.role) - roleRank(b.role) ||
      b.totalFreeDays - a.totalFreeDays ||
      a.name.localeCompare(b.name, "nb"),
  );
  console.info(
    `${clampedCount} employee(s) had days removed by the employment-span clamp`,
  );
  return result;
}

function buildAvailabilityMessage(
  weekStart: moment.Moment,
  windowEnd: moment.Moment,
  isoWeeks: number[],
  totalWorkdays: number,
  people: EmployeeAvailability[],
): SlackMessage {
  // Nobody free → a single celebratory line, no headline or table.
  if (people.length === 0) {
    const line = `Det er ingen med ledig tid neste ${isoWeeks.length} uker 🎉`;
    return {
      text: line,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: line } }],
    };
  }

  const firstWeek = isoWeeks[0];
  const lastWeek = isoWeeks[isoWeeks.length - 1];
  const periodLabel = `uke ${firstWeek}–${lastWeek}, ${weekStart.format("D. MMMM")}–${windowEnd.format("D. MMMM")}`;

  const introLine = `*Ledig kapasitet de neste ${isoWeeks.length} ukene (${periodLabel}):*`;
  const summaryLine = `*${people.length}* ${people.length === 1 ? "person" : "personer"} har minst én ubemannet dag (vinduet har ${totalWorkdays} arbeidsdager).`;

  // Compact per-week tokens, e.g. "u27: 5, u29: 3" — only weeks with free days.
  const weekTokens = (p: EmployeeAvailability) =>
    p.perWeek.map((w) => `u${w.isoWeek}: ${w.freeDays}`).join(", ");

  // Plain-text fallback (no markdown asterisks)
  const textLines = [
    introLine.replace(/\*/g, ""),
    "",
    summaryLine.replace(/\*/g, ""),
  ];
  if (people.length > 0) {
    textLines.push("");
    for (const p of people) {
      textLines.push(
        `${p.name} (${p.role}): ${p.totalFreeDays} dag${p.totalFreeDays === 1 ? "" : "er"} — ${weekTokens(p)}`,
      );
    }
  }
  const text = textLines.join("\n");

  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: introLine } },
    { type: "section", text: { type: "mrkdwn", text: summaryLine } },
  ];

  if (people.length > 0) {
    const headerRow = [
      headerCell("Navn"),
      headerCell("Rolle"),
      headerCell("Ledige dager"),
      headerCell("Fordelt på uker"),
    ];
    const dataRows = people.map((p) => [
      textCell(p.name),
      textCell(p.role),
      textCell(`${p.totalFreeDays}`),
      textCell(weekTokens(p)),
    ]);
    blocks.push({
      type: "table",
      column_settings: [
        { align: "left" }, // Navn
        { align: "left" }, // Rolle
        { align: "right" }, // Ledige dager
        { align: "left", is_wrapped: true }, // Fordelt på uker
      ],
      rows: [headerRow, ...dataRows],
    });
  }

  return { text, blocks };
}

export const notifyAvailableConsultants = async () => {
  const today = now().startOf("day");
  // Window: Monday of the current ISO week through the end of the N-th week.
  const weekStart = today.clone().startOf("isoWeek");
  const windowEnd = weekStart
    .clone()
    .add(CAPACITY_WEEKS_AHEAD, "weeks")
    .subtract(1, "day");
  const startStr = weekStart.format("YYYY-MM-DD");
  const endStr = windowEnd.format("YYYY-MM-DD");

  console.info(
    `Availability overview ${startStr} → ${endStr} (${CAPACITY_WEEKS_AHEAD} weeks)`,
  );

  let employees: EmployeeRow[];
  let staffing: StaffingRow[];
  let absences: AbsenceRow[];
  let holidays: HolidayRow[];
  try {
    [employees, staffing, absences, holidays] = await Promise.all([
      fetchAllEmployees(),
      fetchStaffingForRange(startStr, endStr),
      fetchAllAbsencesForWeek(startStr, endStr),
      fetchHolidays(startStr, endStr),
    ]);
  } catch (err) {
    console.error("availability fetch failed:", err);
    return;
  }

  // Enumerate workdays from *today* (skip already-passed days of the current
  // week — you can't sell yesterday) through the window end: weekdays only,
  // excluding holidays.
  const holidaySet = new Set(holidays.map((h) => h.date));
  const workdays: Array<{ date: string; isoWeek: number }> = [];
  const isoWeeksSet = new Set<number>();
  const cur = today.clone();
  while (cur.isSameOrBefore(windowEnd, "day")) {
    const ds = cur.format("YYYY-MM-DD");
    if (cur.isoWeekday() <= 5 && !holidaySet.has(ds)) {
      const w = cur.isoWeek();
      workdays.push({ date: ds, isoWeek: w });
      isoWeeksSet.add(w);
    }
    cur.add(1, "day");
  }
  const isoWeeks = Array.from(isoWeeksSet).sort((a, b) => a - b);

  const people = computeAvailability(
    employedInWindow(employees, startStr, endStr),
    staffing,
    absences,
    workdays,
  );

  console.info(
    `Availability: ${people.length}/${employees.length} employees with ≥1 free day over ${workdays.length} workdays`,
  );
  await postMessage(
    `#${CAPACITY_CHANNEL}`,
    `#${CAPACITY_CHANNEL}`,
    buildAvailabilityMessage(
      weekStart,
      windowEnd,
      isoWeeks,
      workdays.length,
      people,
    ),
  );
};
