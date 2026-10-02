import moment from "moment";
import { REPORT_TOLERANCE_HOURS, onlyTestUser } from "./config.js";
import {
  DayBreakdown,
  DayStatus,
  EmployeeRow,
  HolidayRow,
  ProjectHoursPerDayRow,
  TimeTrackingStatusRow,
} from "./types.js";
import {
  fetchAllEmployees,
  fetchConfirmedWeeks,
  fetchHolidays,
  fetchHoursByEmployee,
  fetchTimeTrackingStatus,
} from "./api.js";
import { ReportPeriod } from "./periods.js";
import { formatDates, formatHoursShort } from "./format.js";

const STANDARD_WORKDAY_HOURS = 7.5;

// Days outside the employee's employment are "off", like weekends, matching
// availableHours. The absence calendar is planning, so it plays no part: only
// logged hours and confirmed avspasering count.
function buildPerDayBreakdown(
  startDate: moment.Moment,
  endDate: moment.Moment,
  rows: ProjectHoursPerDayRow[],
  holidays: HolidayRow[],
  employee: EmployeeRow,
): DayBreakdown[] {
  // Aggregate per date: absence entries and work entries both count toward
  // "registered time" so e.g. 6 t Permisjon u/lønn shows as ⚠️ partial
  // rather than being hidden as ☑️ Permisjon (masking a missing 1,5 t).
  type DayAgg = {
    totalHours: number;
    workHours: number;
    absenceHours: number;
    projects: Map<string, string>; // id → name, in first-seen order
  };
  const byDate = new Map<string, DayAgg>();
  for (const r of rows) {
    let cur = byDate.get(r.date);
    if (!cur) {
      cur = {
        totalHours: 0,
        workHours: 0,
        absenceHours: 0,
        projects: new Map(),
      };
      byDate.set(r.date, cur);
    }
    cur.totalHours += r.hours;
    // A day counts as absence only if the project's status is
    // "unavailable" — Permisjon m/lønn is "nonbillable" (i.e. work).
    if (r.status === "unavailable") {
      cur.absenceHours += r.hours;
    } else {
      cur.workHours += r.hours;
    }
    // Skip zero-hour entries (UI markers, e.g. "Ferie marked but not
    // registered").
    if (r.hours > 0) cur.projects.set(r.projectId, r.projectName);
  }

  const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));
  const isWeekend = (d: moment.Moment) => d.day() === 0 || d.day() === 6;
  // Dates are fixed-width YYYY-MM-DD, so string order is date order.
  const isEmployed = (ds: string) =>
    employee.dateOfEmployment !== null &&
    ds >= employee.dateOfEmployment &&
    (employee.terminationDate === null || ds <= employee.terminationDate);

  // Enumerate all days in the period
  const allDays: moment.Moment[] = [];
  const cur = startDate.clone();
  while (cur.isSameOrBefore(endDate, "day")) {
    allDays.push(cur.clone());
    cur.add(1, "day");
  }

  const result: DayBreakdown[] = [];
  for (const d of allDays) {
    const ds = d.format("YYYY-MM-DD");
    const agg = byDate.get(ds);
    const totalHours = agg?.totalHours ?? 0;
    const workHours = agg?.workHours ?? 0;
    const isHoliday = holidayByDate.has(ds);
    const holidayName = holidayByDate.get(ds) ?? undefined;

    let status: DayStatus;
    let hoursExpected: number;

    if (isWeekend(d) || !isEmployed(ds)) {
      // Before holiday so weekend-holidays (17. mai on Sunday) get filtered
      // out rather than surfacing as a row.
      status = "off";
      hoursExpected = 0;
    } else if (isHoliday) {
      status = "holiday";
      hoursExpected = 0;
    } else {
      hoursExpected = STANDARD_WORKDAY_HOURS;
      if (totalHours >= hoursExpected - REPORT_TOLERANCE_HOURS) {
        // Fully registered. If there's no work component, surface it as
        // an absence day so the visual reads "this was Sykmelding" instead
        // of "🟢 7,5 t (Sykmelding)" which sounds like work.
        status = workHours > 0 ? "complete" : "absence";
      } else if (totalHours > 0) {
        status = "partial";
      } else {
        status = "empty";
      }
    }

    const projects = agg ? Array.from(agg.projects.values()) : [];
    result.push({
      date: ds,
      status,
      hoursActual: totalHours,
      hoursExpected,
      projects,
      holidayName,
    });
  }

  // Drop off days unless someone registered hours on them
  return result.filter((d) => d.status !== "off" || d.hoursActual > 0);
}

export type Shortfall = {
  missingHours: number;
  // Fully empty workdays, except in weeks confirmed as avspasering.
  emptyDates: string[];
  confirmedHours: number;
};

const isoWeekOf = (date: string) =>
  moment(date).startOf("isoWeek").format("YYYY-MM-DD");

// `days` cover whole ISO weeks. A confirmed week's gap is covered in date
// order, so two months sharing a week split it the same way whichever runs
// first, instead of each taking it whole.
function shortfallOf(
  days: DayBreakdown[],
  start: string,
  end: string,
  confirmedWeeks = new Set<string>(),
): Shortfall {
  const daysByWeek = new Map<string, DayBreakdown[]>();
  for (const d of days) {
    const w = isoWeekOf(d.date);
    daysByWeek.set(w, [...(daysByWeek.get(w) ?? []), d]);
  }
  const gapOf = (ds: DayBreakdown[]) =>
    ds.reduce((sum, d) => sum + d.hoursExpected - d.hoursActual, 0);
  const inPeriod = (d: DayBreakdown) => d.date >= start && d.date <= end;

  let gap = 0;
  let confirmedHours = 0;
  const coveredWeeks = new Set<string>();
  for (const [w, weekDays] of daysByWeek) {
    const insideGap = gapOf(weekDays.filter(inPeriod));
    const beforeGap = gapOf(weekDays.filter((d) => d.date < start));
    gap += insideGap;
    const usable = confirmedWeeks.has(w) ? Math.max(0, gapOf(weekDays)) : 0;
    const left = usable - Math.min(usable, Math.max(0, beforeGap));
    const confirmed = Math.min(left, Math.max(0, insideGap));
    confirmedHours += confirmed;
    if (confirmed > 0 && confirmed >= insideGap - REPORT_TOLERANCE_HOURS) {
      coveredWeeks.add(w);
    }
  }

  return {
    missingHours: Math.max(0, gap - confirmedHours),
    emptyDates: days
      .filter(
        (d) =>
          inPeriod(d) &&
          d.status === "empty" &&
          !coveredWeeks.has(isoWeekOf(d.date)),
      )
      .map((d) => d.date),
    confirmedHours,
  };
}

type EmployeePeriod = {
  employee: EmployeeRow;
  rows: ProjectHoursPerDayRow[];
  days: DayBreakdown[];
  shortfall: Shortfall;
};

// Lowercased email → each target's days and shortfall over the period.
async function loadEmployeePeriods(
  targets: TimeTrackingStatusRow[],
  startDate: moment.Moment,
  endDate: moment.Moment,
): Promise<Map<string, EmployeePeriod>> {
  const startStr = startDate.format("YYYY-MM-DD");
  const endStr = endDate.format("YYYY-MM-DD");
  // Whole ISO weeks, so a week straddling the period's edge can be split.
  const weekStart = startDate.clone().startOf("isoWeek");
  const weekEnd = endDate.clone().endOf("isoWeek");
  const weekStartStr = weekStart.format("YYYY-MM-DD");
  const weekEndStr = weekEnd.format("YYYY-MM-DD");
  const [allEmployees, holidays] = await Promise.all([
    fetchAllEmployees(),
    fetchHolidays(weekStartStr, weekEndStr),
  ]);

  const byEmail = new Map(allEmployees.map((e) => [e.email.toLowerCase(), e]));
  const employees = targets.flatMap((r) => {
    const e = byEmail.get(r.email.toLowerCase());
    if (!e) console.warn(`No employee_id for ${r.email}, skipping`);
    return e ? [e] : [];
  });
  const ids = employees.map((e) => e.id);
  const [confirmed, hours] = await Promise.all([
    fetchConfirmedWeeks(ids, weekStartStr, endStr),
    fetchHoursByEmployee(ids, weekStartStr, weekEndStr),
  ]);

  const result = new Map<string, EmployeePeriod>();
  for (const e of employees) {
    const weekRows = hours.get(e.id) ?? [];
    const weekDays = buildPerDayBreakdown(
      weekStart,
      weekEnd,
      weekRows,
      holidays,
      e,
    );
    result.set(e.email.toLowerCase(), {
      employee: e,
      rows: weekRows.filter((r) => r.date >= startStr && r.date <= endStr),
      days: weekDays.filter((d) => d.date >= startStr && d.date <= endStr),
      shortfall: shortfallOf(weekDays, startStr, endStr, confirmed.get(e.id)),
    });
  }
  return result;
}

export const hasShortfall = ({ missingHours, emptyDates }: Shortfall) =>
  emptyDates.length > 0 || missingHours > REPORT_TOLERANCE_HOURS;

type PeriodTarget = EmployeePeriod & { status: TimeTrackingStatusRow };

// Everyone expected to work in the period. People on leave the whole period
// (availableHours = 0) are left out.
export async function loadPeriodTargets(
  { startDate, endDate }: ReportPeriod,
  { testUserOnly }: { testUserOnly: boolean },
): Promise<PeriodTarget[]> {
  const rows = await fetchTimeTrackingStatus(startDate, endDate);
  if (!Array.isArray(rows)) {
    throw new Error(
      `time_tracking_status did not return an array: ${JSON.stringify(rows)}`,
    );
  }
  let targets = rows.filter((r) => r.availableHours > 0);
  if (testUserOnly) targets = onlyTestUser(targets, (r) => r.email);
  console.info(`${targets.length} employee(s) with availableHours > 0`);

  const periods = await loadEmployeePeriods(targets, startDate, endDate);
  return targets.flatMap((status) => {
    const period = periods.get(status.email.toLowerCase());
    return period ? [{ ...period, status }] : [];
  });
}

// Fully empty days are named explicitly: the net total alone can hide them
// (7,5 t missing on one day minus 1,5 t extra elsewhere read as "6 timer
// fordelt på 1 dag"). A gap only in partial days is more likely avspasering,
// so that one asks for a confirmation instead.
export function shortfallSentence(
  { missingHours, emptyDates }: Shortfall,
  periodLabel: string,
): string {
  const hoursLabel = `*${formatHoursShort(missingHours)} time${missingHours === 1 ? "" : "r"}*`;
  if (emptyDates.length === 0) {
    return (
      `Du mangler fortsatt ${hoursLabel} for *${periodLabel}*. ` +
      `Ser du over og enten bekrefter avspasering eller fører resten? 🙏`
    );
  }
  const totalClause =
    missingHours > REPORT_TOLERANCE_HOURS
      ? ` Totalt for *${periodLabel}* mangler du ${hoursLabel}.`
      : "";
  // Past a handful, a list of dates is harder to read than the count.
  const emptyClause =
    emptyDates.length > 5
      ? `Du har *${emptyDates.length} dager* uten timer.`
      : `Du har ikke ført noen timer på *${formatDates(emptyDates)}*.`;
  return (
    `${emptyClause}${totalClause} ` +
    `Husk at ferie- og permisjonsdager også skal timeføres, og at avspasering skal bekreftes. ` +
    `Ser du over og evt. fører resten? 🙏`
  );
}
