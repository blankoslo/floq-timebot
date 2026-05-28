import fetch from "node-fetch";
import { WebClient } from "@slack/web-api";
import * as jwt from "jsonwebtoken";
import moment from "moment";

// === Config ===
const apiUri = process.env.API_URI || "https://api-test.floq.no";
const slack = new WebClient(process.env.SLACK_API_TOKEN || "");
const DRY_RUN = process.env.DRY_RUN === "true";
const FLOQ_TIMESTAMP_URL =
  process.env.FLOQ_TIMESTAMP_URL || "https://inni.blank.no/timestamp/";
// When set, only this employee's data is processed (filters the target
// list) — useful for previewing how a real Slack render looks without
// spamming everyone.
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL?.toLowerCase().trim();
// When set, all Slack DMs are routed to this address instead of the
// employee's own. Lets you impersonate someone (combined with
// TEST_USER_EMAIL) to see their exact message rendered in your own DM.
const TEST_USER_SLACK_EMAIL = process.env.TEST_USER_SLACK_EMAIL?.toLowerCase().trim();
// Ignore small deltas so a 7 t vs 7,5 t day doesn't trigger a notification.
const REPORT_TOLERANCE_HOURS = 0.5;

moment.locale("nb");

// Bonus is now computed entirely in the database via the
// fg_bonus_employee_monthly RPC (blankoslo/floq-db). It handles per-week FG,
// the majority-week-in-month rule, the non-FG-code adjustment, and the
// Fagleder bonus tiers — so the bot no longer mirrors any of that logic.

// Note: we used to hardcode an absence-code list here, but it was both
// incomplete (missed several codes Floq counts as unavailable) and wrong
// for PER1000 (Permisjon m/lønn — counted as non-billable, not absence).
// Categorization now reads `billable` from /projects instead, so the
// API is the single source of truth.

// === Types ===
type TimeTrackingStatusRow = {
  name: string;
  email: string;
  available_hours: number;
  billable_hours: number;
  non_billable_hours: number;
  unavailable_hours: number;
  unregistered_days: number;
  last_date: string | null;
  last_created: string | null;
};

type EmployeeRow = { id: number; email: string };
type HolidayRow = { date: string; name: string };
type AbsenceRow = { date: string; employee_id: number; reason: string };
type ProjectRow = {
  id: string;
  name: string;
  // From floq: "billable" | "non_billable" | "unavailable" (verified via API)
  billable: string;
};
type FGPeriodRow = {
  employee_id: number;
  available_hours: number;
  billable_hours: number;
  fg_rate: number;
};
type MonthlyBonusRow = {
  employee_id: number;
  month_start: string;
  month_end: string;
  bonus_available_hours: number;
  billable_hours: number;
  fg_bonus_rate: number;
  bonus: number; // kr, already computed
};
// entries_sums_for_employee_with_project view: project name + hours already
// aggregated per (work_date, project). Use this instead of /time_entry,
// which is event-based (multiple rows per change → naive sums overcount).
type ProjectHoursPerDayRow = {
  work_date: string;
  employee_id: number;
  project: string;
  hours: number;
};

type DayStatus =
  | "complete" //  ≥ 7,5 t with at least some work time
  | "absence" //   ≥ 7,5 t purely absence
  | "partial" //   0 < total < 7,5 t
  | "empty" //     0 t
  | "holiday"
  | "weekend"; //  dropped from display unless work was logged

type DayBreakdown = {
  date: string; // YYYY-MM-DD
  status: DayStatus;
  hoursActual: number; // work + absence total (both count toward "registered")
  hoursExpected: number; // 7,5 for workdays, 0 otherwise
  projects: string[]; // pretty labels — includes absence types like "Ferie"
  holidayName?: string;
};

// === API helpers ===
const apiToken = () =>
  jwt.sign({ role: "root" }, process.env.API_JWT_SECRET || "dev-secret-shhh");

// Pick which Slack user to DM. Honors TEST_USER_SLACK_EMAIL override so we
// can impersonate someone else's data while having the message land in our
// own inbox.
function pickSlackRecipient(
  slackUsers: Array<{ id?: string; name?: string; profile?: { email?: string } }>,
  originalEmail: string
): { id?: string; name?: string; profile?: { email?: string } } | undefined {
  const targetEmail = (TEST_USER_SLACK_EMAIL ?? originalEmail).toLowerCase();
  return slackUsers.find((u) => u.profile?.email?.toLowerCase() === targetEmail);
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${apiUri}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiToken()}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(
      `GET ${path} failed: ${res.status} ${res.statusText} ${await res.text()}`
    );
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiUri}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `POST ${path} failed: ${res.status} ${res.statusText} ${await res.text()}`
    );
  }
  return res.json() as Promise<T>;
}

// === Schedule flags ===
// IMPORTANT: these are env-var-only, NOT auto-detected from the current
// weekday. Auto-detection caused a bug where any job running on a Monday
// (e.g. the monthly recap job) also fired the weekly flow — double messages.
// Each Cloud Scheduler trigger now sets exactly the flag it intends.
const isMonday = process.env.IS_MONDAY === "true";
const isTuesday = process.env.IS_TUESDAY === "true";
const isFirstOfMonth = process.env.IS_FIRST_OF_MONTH === "true";
// Overtime check posts to the #overtid channel — own flag so it doesn't
// fire on every Monday-digest test run.
const isOvertimeCheck = process.env.IS_OVERTIME === "true";
// The monthly recap rides along with the Monday run, but only on the first
// Monday of the month (date 1–7) — by then every "majority-of-days-in-
// previous-month" week has finished, so bonus + FG are stable. No separate
// cron needed. IS_MONTHLY_RECAP=true forces it for local testing.
const isMonthlyRecap =
  process.env.IS_MONTHLY_RECAP === "true" ||
  (isMonday && moment().date() <= 7);

// Previous calendar week (Mon–Sun before today). Used by both the Monday
// digest and the Tuesday follow-up — both report on the just-finished week.
const getLastFullWeekRange = () => ({
  startDate: moment().subtract(1, "week").startOf("isoWeek"),
  endDate: moment().subtract(1, "week").endOf("isoWeek"),
});

// === Data fetching ===

async function fetchTimeTrackingStatus(
  startDate: moment.Moment,
  endDate: moment.Moment
): Promise<TimeTrackingStatusRow[]> {
  return apiPost<TimeTrackingStatusRow[]>("/rpc/time_tracking_status", {
    start_date: startDate.format("YYYY-MM-DD"),
    end_date: endDate.format("YYYY-MM-DD"),
  });
}

async function fetchEmployeeIdByEmail(email: string): Promise<number | null> {
  // Throws on a real API error (caller's loop skips the employee). Returns
  // null only when the employee genuinely isn't found.
  const rows = await apiGet<EmployeeRow[]>(
    `/employees?select=id&email=eq.${encodeURIComponent(email)}`
  );
  return rows[0]?.id ?? null;
}

// Bulk fetchers below intentionally do NOT catch — a failed shared fetch
// must abort the whole run (the error propagates to main's allSettled and
// no messages go out) rather than silently degrade every message.

async function fetchProjectInfoMap(): Promise<Map<string, ProjectRow>> {
  // The view returns project IDs (e.g. "AID1000"); fetch human-readable
  // names and the billable category so we can split work vs absence in
  // the project breakdown.
  const projects = await apiGet<ProjectRow[]>(
    "/projects?select=id,name,billable"
  );
  return new Map(projects.map((p) => [p.id, p]));
}

async function fetchHolidays(
  startDate: string,
  endDate: string
): Promise<HolidayRow[]> {
  return apiGet<HolidayRow[]>(
    `/holidays?date=gte.${startDate}&date=lte.${endDate}`
  );
}

async function fetchAllAbsencesForWeek(
  startDate: string,
  endDate: string
): Promise<AbsenceRow[]> {
  return apiGet<AbsenceRow[]>(
    `/absence?date=gte.${startDate}&date=lte.${endDate}`
  );
}

async function fetchAllEmployees(): Promise<EmployeeRow[]> {
  return apiGet<EmployeeRow[]>("/employees?select=id,email");
}

// Per-employee fetcher: throws on a real API error. Callers wrap the loop
// body so one employee's failure skips just them (loud), not the whole run.
async function fetchProjectHoursPerDay(
  employeeId: number,
  startDate: string,
  endDate: string
): Promise<ProjectHoursPerDayRow[]> {
  // Note: RPC parameters are `from_date`/`to_date`, NOT start_date/end_date
  // (verified via PostgREST hint when called with wrong names).
  return apiGet<ProjectHoursPerDayRow[]>(
    `/rpc/entries_sums_for_employee_with_project?employee_id=${employeeId}&from_date=${startDate}&to_date=${endDate}`
  );
}

async function fetchAllFGForRange(
  start: string,
  end: string
): Promise<Map<number, { billable: number; available: number }>> {
  // emp_id optional — omit it to get every employee's FG for the period in
  // one call. (fg_employee_period from blankoslo/floq-db PR 91.)
  const rows = await apiGet<FGPeriodRow[]>(
    `/rpc/fg_employee_period?from_date=${start}&to_date=${end}`
  );
  return new Map(
    rows.map((r) => [
      r.employee_id,
      { billable: r.billable_hours, available: r.available_hours },
    ])
  );
}

async function fetchAllMonthlyBonuses(
  year: number,
  month: number // 1–12
): Promise<Map<number, number>> {
  // emp_id is optional — omitting it returns every employee's bonus in one
  // call. The DB does everything: per-week FG with bonus_hours_for_employee,
  // majority-week-in-month assignment, and the Fagleder bonus tiers.
  const rows = await apiGet<MonthlyBonusRow[]>(
    `/rpc/fg_bonus_employee_monthly?year=${year}&month=${month}`
  );
  return new Map(rows.map((r) => [r.employee_id, r.bonus]));
}

// === Per-day breakdown ===

// Standard work day length. Part-timers may see slight noise here; we'll fix
// that when we surface stillingsprosent properly.
const STANDARD_WORKDAY_HOURS = 7.5;

function buildPerDayBreakdown(
  startDate: moment.Moment,
  endDate: moment.Moment,
  rows: ProjectHoursPerDayRow[],
  holidays: HolidayRow[],
  projectInfo: Map<string, ProjectRow>
): DayBreakdown[] {
  // Aggregate per date: absence entries and work entries both count toward
  // "registered time" so e.g. 6 t Permisjon u/lønn shows as ⚠️ partial
  // rather than being hidden as ☑️ Permisjon (masking a missing 1,5 t).
  type DayAgg = {
    totalHours: number;
    workHours: number;
    absenceHours: number;
    projectCodes: string[]; // ordered, deduped — resolved to names below
  };
  const byDate = new Map<string, DayAgg>();
  for (const r of rows) {
    let cur = byDate.get(r.work_date);
    if (!cur) {
      cur = {
        totalHours: 0,
        workHours: 0,
        absenceHours: 0,
        projectCodes: [],
      };
      byDate.set(r.work_date, cur);
    }
    cur.totalHours += r.hours;
    // The view's `project` field is the project ID (code) e.g. "AID1000",
    // "FER1000". A day counts as absence only if the project's billable
    // field says "unavailable" — Permisjon m/lønn is "non_billable"
    // (i.e. work), not absence.
    const billable = projectInfo.get(r.project)?.billable;
    if (billable === "unavailable") {
      cur.absenceHours += r.hours;
    } else {
      cur.workHours += r.hours;
    }
    // Skip zero-hour entries (UI markers, e.g. "Ferie marked but not
    // registered") and dedupe by code per day.
    if (r.hours > 0 && !cur.projectCodes.includes(r.project)) {
      cur.projectCodes.push(r.project);
    }
  }

  const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));
  const isWeekend = (d: moment.Moment) => d.day() === 0 || d.day() === 6;

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
    const holidayName = holidayByDate.get(ds);
    const weekend = isWeekend(d);

    let status: DayStatus;
    let hoursExpected: number;

    if (weekend) {
      // Weekend wins over holiday so weekend-holidays (17. mai on Sunday)
      // get filtered out rather than surfacing as a row.
      status = "weekend";
      hoursExpected = 0;
    } else if (holidayName) {
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

    const projects = agg
      ? agg.projectCodes.map((code) => projectInfo.get(code)?.name ?? code)
      : [];
    result.push({
      date: ds,
      status,
      hoursActual: totalHours,
      hoursExpected,
      projects,
      holidayName,
    });
  }

  // Drop weekends unless someone registered hours on them
  return result.filter((d) => d.status !== "weekend" || d.hoursActual > 0);
}

// === Formatting ===

function formatHours(n: number): string {
  // One decimal always (Norwegian comma) — keeps "7,0 t" aligned with
  // "7,5 t" in the day list and makes the table easier to scan.
  return n.toFixed(1).replace(".", ",");
}

function formatHoursShort(n: number): string {
  // Strip trailing ",0" — used in the headline where "30 / 30 t" reads
  // cleaner than "30,0 / 30,0 t".
  return formatHours(n).replace(/,0$/, "");
}

function formatSignedHours(n: number): string {
  // For deltas (flexitime change). Round to zero when within rounding error.
  if (Math.abs(n) < 0.05) return "0 t";
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${formatHours(Math.abs(n))} t`;
}

// Full Norwegian weekday names, used in the table view.
const DAY_NAMES_NB = [
  "Søndag",
  "Mandag",
  "Tirsdag",
  "Onsdag",
  "Torsdag",
  "Fredag",
  "Lørdag",
];

function statusIcon(s: DayStatus): string {
  // Per design: only flag days that warrant attention. Complete days and
  // absence days don't need a visual marker — the row already conveys it.
  switch (s) {
    case "partial":
      return "⚠️";
    case "empty":
      return "⛔️";
    case "holiday":
      return "🗓️";
    default:
      return "";
  }
}

// Header / footer cells get bold text; data cells use plain raw_text.
function headerCell(text: string): Record<string, unknown> {
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [{ type: "text", text, style: { bold: true } }],
      },
    ],
  };
}

function textCell(text: string): Record<string, unknown> {
  // Slack rejects raw_text cells with empty text ("must be more than 0
  // characters"). Use a non-breaking space as a visually-empty placeholder
  // so the table layout stays intact for holiday/absence/totalt rows.
  return { type: "raw_text", text: text.length > 0 ? text : " " };
}

function buildTableRow(day: DayBreakdown): Record<string, unknown>[] {
  const m = moment(day.date);
  const dayDateLabel = `${DAY_NAMES_NB[m.day()]} ${m.format("D. MMMM")}`;
  const icon = statusIcon(day.status);
  const hoursStr = `${formatHours(day.hoursActual)} t`;

  if (day.status === "holiday") {
    // Holidays with registered work: surface both the project and that it
    // happened on a holiday — and crucially, show the hours so they're
    // visible (and counted in the total below).
    if (day.hoursActual > 0) {
      const projectStr =
        day.projects.length > 0 ? day.projects.join(" + ") : "";
      const holidayName = day.holidayName ?? "Helligdag";
      const combined = projectStr
        ? `${projectStr} (${holidayName})`
        : holidayName;
      return [
        textCell(dayDateLabel),
        textCell(hoursStr),
        textCell(combined),
        textCell(icon),
      ];
    }
    return [
      textCell(dayDateLabel),
      textCell(""), // no Timer for holidays without work
      textCell(day.holidayName ?? "Helligdag"),
      textCell(icon),
    ];
  }
  if (day.status === "absence") {
    const label = day.projects.length > 0 ? day.projects.join(" + ") : "Fravær";
    return [
      textCell(dayDateLabel),
      textCell(hoursStr),
      textCell(label),
      textCell(""), // no icon for absence
    ];
  }
  if (day.status === "empty") {
    return [
      textCell(dayDateLabel),
      textCell(hoursStr),
      textCell(""),
      textCell(icon),
    ];
  }
  // complete or partial
  const projectStr =
    day.projects.length > 0
      ? day.projects.slice(0, 3).join(" + ") +
        (day.projects.length > 3 ? " m.fl." : "")
      : "";
  return [
    textCell(dayDateLabel),
    textCell(hoursStr),
    textCell(projectStr),
    textCell(icon),
  ];
}

function buildTableBlock(
  days: DayBreakdown[],
  totalActual: number,
  totalExpected: number
): Record<string, unknown> {
  const headerRow = [
    headerCell("Dag"),
    headerCell("Timer"),
    headerCell("Prosjekt"),
    headerCell("Status"),
  ];
  const dataRows = days.map(buildTableRow);
  const totalRow = [
    headerCell("Totalt"),
    headerCell(`${formatHours(totalActual)} t`),
    headerCell(`av ${formatHoursShort(totalExpected)} t`),
    textCell(""),
  ];

  return {
    type: "table",
    column_settings: [
      { align: "left" }, // Dag (day + date combined)
      { align: "right" }, // Timer
      { align: "left", is_wrapped: true }, // Prosjekt
      { align: "center" }, // Status
    ],
    rows: [headerRow, ...dataRows, totalRow],
  };
}

function formatPerDayLine(day: DayBreakdown): string {
  // The day is implicit from row order (Mon–Fri matches the period in the
  // headline), so we skip the prefix entirely. This sidesteps the alignment
  // problem entirely and keeps each row to its essentials.

  if (day.status === "holiday") {
    const holidayName = day.holidayName ?? "Helligdag";
    if (day.hoursActual > 0) {
      const projectStr =
        day.projects.length > 0 ? day.projects.join(" + ") : holidayName;
      return `${formatHours(day.hoursActual)} t (${projectStr}, ${holidayName}) 🗓️`;
    }
    return `${holidayName} 🗓️`;
  }
  if (day.status === "absence") {
    // Fully covered by absence — show the absence type without hours, since
    // "7,5 t (Ferie)" reads like work.
    return day.projects.length > 0 ? day.projects.join(" + ") : "Fravær";
  }

  const hoursStr = formatHours(day.hoursActual);

  if (day.status === "empty") {
    return `${hoursStr} t ⛔️`;
  }

  // complete or partial — show hours and project(s)
  const projectStr =
    day.projects.length > 0
      ? day.projects.slice(0, 3).join(" + ") +
        (day.projects.length > 3 ? " m.fl." : "")
      : "-";
  const base = `${hoursStr} t (${projectStr})`;
  return day.status === "partial" ? `${base} ⚠️` : base;
}

const numberWord = (n: number): string => {
  const words = [
    "null",
    "én",
    "to",
    "tre",
    "fire",
    "fem",
    "seks",
    "sju",
    "åtte",
    "ni",
    "ti",
  ];
  return words[n] ?? String(n);
};

function summarize(
  missingHours: number,
  emptyDays: number,
  partialDays: number
): string {
  const totalDays = emptyDays + partialDays;
  const missingLabel = `*${formatHoursShort(missingHours)} time${missingHours === 1 ? "" : "r"}*`;
  const closing = "Ser du over og evt. fører resten? 🙏";

  if (totalDays === 0) {
    return `Du mangler totalt ${missingLabel}. ${closing}`;
  }

  const dayCountLabel = totalDays === 1 ? "*1 dag*" : `*${totalDays} dager*`;

  if (emptyDays > 0 && partialDays > 0) {
    const empty =
      emptyDays === 1 ? "én hel" : `${numberWord(emptyDays)} hele`;
    const partial =
      partialDays === 1 ? "én halvveis" : `${numberWord(partialDays)} halvveis`;
    return `Til sammen mangler ${missingLabel} fordelt på ${dayCountLabel} (${empty} og ${partial}). ${closing}`;
  }

  return `Til sammen mangler ${missingLabel} fordelt på ${dayCountLabel}. ${closing}`;
}

function buildSlackMessage(
  startDate: moment.Moment,
  endDate: moment.Moment,
  days: DayBreakdown[],
  totalActual: number,
  totalExpected: number,
  hasIssues: boolean
): { text: string; blocks: Array<Record<string, unknown>> } {
  const weekNumber = startDate.isoWeek();
  // Display the work week (mon–fri) rather than the calendar week (mon–sun).
  // For 1st-of-month partial-week runs, cap at endDate so we don't claim
  // dates that haven't happened yet.
  const fridayOfWeek = startDate.clone().add(4, "days");
  const displayEnd = endDate.isBefore(fridayOfWeek) ? endDate : fridayOfWeek;
  const sameMonth = startDate.month() === displayEnd.month();
  const firstDate = sameMonth
    ? startDate.format("D.")
    : startDate.format("D. MMMM");
  const lastDate = displayEnd.format("D. MMMM");
  const periodLabel = `uke ${weekNumber} (${firstDate}–${lastDate})`;

  const perDayLines = days.map(formatPerDayLine).join("\n");

  const emptyDays = days.filter((d) => d.status === "empty").length;
  const partialDays = days.filter((d) => d.status === "partial").length;
  const missingHours = Math.max(0, totalExpected - totalActual);

  // Intro and summary merge into one paragraph. Brief variant stops after
  // the intro; issues variant appends "Til sammen mangler ...".
  const baseIntro = `Her er en oversikt over timene dine for *${periodLabel}*.`;
  const introLine = hasIssues
    ? `${baseIntro} ${summarize(missingHours, emptyDays, partialDays)}`
    : baseIntro;

  // Plain-text fallback (no markdown asterisks)
  const textLines = [
    introLine.replace(/\*/g, ""),
    "",
    perDayLines,
    "",
    `Åpne timeføring: ${FLOQ_TIMESTAMP_URL}`,
  ];
  const text = textLines.join("\n");

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: introLine },
    },
  ];
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Åpne timeføring i Floq" },
        url: FLOQ_TIMESTAMP_URL,
      },
    ],
  });
  // Slack moves the table to the bottom of the message as an attachment
  // regardless of where it sits in the blocks array — so order here is
  // for the API, not for visual flow.
  blocks.push(buildTableBlock(days, totalActual, totalExpected));

  return { text, blocks };
}

// === Main flows ===

const notifySlackers = async () => {
  const { startDate, endDate } = getLastFullWeekRange();
  const startStr = startDate.format("YYYY-MM-DD");
  const endStr = endDate.format("YYYY-MM-DD");

  console.info(`Checking time tracking for ${startStr} → ${endStr}`);

  let rows: TimeTrackingStatusRow[];
  try {
    rows = await fetchTimeTrackingStatus(startDate, endDate);
  } catch (err) {
    console.error("time_tracking_status failed:", err);
    return;
  }
  if (!Array.isArray(rows)) {
    console.error("time_tracking_status did not return an array:", rows);
    return;
  }
  console.info(`Got ${rows.length} rows from time_tracking_status`);

  // We notify everyone who is expected to work this week — including those
  // who are fully registered (they get the brief variant). People on full-
  // week vacation/parental leave (available_hours = 0) get nothing.
  let targets = rows.filter((r) => r.available_hours > 0);
  console.info(`${targets.length} employees with available_hours > 0`);

  if (TEST_USER_EMAIL) {
    const before = targets.length;
    targets = targets.filter(
      (r) => r.email.toLowerCase() === TEST_USER_EMAIL
    );
    console.info(
      `TEST_USER_EMAIL=${TEST_USER_EMAIL} — filtered ${before} → ${targets.length} target(s)`
    );
    if (targets.length === 0) {
      console.warn(
        `No employee matching ${TEST_USER_EMAIL} in time_tracking_status — nothing to send`
      );
      return;
    }
  }

  if (targets.length === 0) {
    console.info("Nothing to notify, exiting notifySlackers.");
    return;
  }

  // Fetch shared data once
  const [holidays, projectInfo, slackUsersResp] = await Promise.all([
    fetchHolidays(startStr, endStr),
    fetchProjectInfoMap(),
    slack.users.list(),
  ]);

  const slackUsers = slackUsersResp.members;
  if (!slackUsers) {
    console.error("No slack users in response:", slackUsersResp);
    return;
  }

  for (const row of targets) {
    // Per-employee fetches are wrapped so one person's API failure skips
    // just them (loud) rather than sending a wrong message or aborting the
    // whole run.
    let employeeId: number | null;
    let projectRows: ProjectHoursPerDayRow[];
    try {
      employeeId = await fetchEmployeeIdByEmail(row.email);
      if (!employeeId) {
        console.warn(`No employee_id for ${row.email}, skipping`);
        continue;
      }
      projectRows = await fetchProjectHoursPerDay(employeeId, startStr, endStr);
    } catch (err) {
      console.error(`Skipping ${row.email} — fetch failed:`, err);
      continue;
    }
    const days = buildPerDayBreakdown(
      startDate,
      endDate,
      projectRows,
      holidays,
      projectInfo
    );

    // Headline totals sum across all surviving days. The filter inside
    // buildPerDayBreakdown already dropped weekends-without-work and other
    // noise — anything still here counts. Absence and holiday days have
    // hoursExpected = 0 so they only contribute to the "actual" side.
    const totalActual = days.reduce((s, d) => s + d.hoursActual, 0);
    const totalExpected = days.reduce((s, d) => s + d.hoursExpected, 0);

    // Issues-variant only when there's an actual shortfall worth flagging.
    // A 🟡 partial day on its own doesn't qualify if the week's total is
    // already over target (someone may have logged 7 t Fri because they
    // left early after working 8 t Mon–Wed — they're fine).
    const hasEmpty = days.some((d) => d.status === "empty");
    const missing = Math.max(0, totalExpected - totalActual);
    const hasIssues = hasEmpty || missing > REPORT_TOLERANCE_HOURS;

    const targetUser = pickSlackRecipient(slackUsers, row.email);
    if (!targetUser) {
      console.error(`No Slack user found for ${row.email}`);
      continue;
    }

    const { text, blocks } = buildSlackMessage(
      startDate,
      endDate,
      days,
      totalActual,
      totalExpected,
      hasIssues
    );

    const emptyDays = days.filter((d) => d.status === "empty").length;
    const partialDays = days.filter((d) => d.status === "partial").length;
    const variant = hasIssues ? "issues" : "brief";
    console.info(
      `Notifying @${targetUser.name} (${row.email}) [${variant}] — ${formatHours(totalActual)}/${formatHours(totalExpected)} t, ${emptyDays} empty + ${partialDays} partial`
    );

    if (DRY_RUN) {
      console.info("DRY_RUN — message preview:\n" + text);
      continue;
    }

    try {
      await slack.chat.postMessage({
        channel: targetUser.id!,
        text,
        // Casting because we build blocks as plain objects; Slack's KnownBlock
        // union is overly restrictive for our simple section/actions/context mix.
        blocks: blocks as any,
        as_user: true,
      });
      console.info(`Sent to @${targetUser.name}`);
    } catch (err) {
      console.error(`Failed to send to @${targetUser.name}:`, err);
    }
  }
};

const notifyAdminAboutOvertime = async () => {
  const channelName = "overtid";

  let entries: any[];
  try {
    entries = await apiGet<any[]>(`/paid_overtime?paid_date=is.null`);
  } catch (err) {
    console.error("Failed to fetch paid_overtime:", err);
    return;
  }

  if (entries.length === 0) return;

  const message =
    "Det ser ut som noen har ført overtid som ikke er utbetalt 💰\n\n" +
    "Overtid: https://inni.blank.no/overtime";

  console.info(`Overtime entries: ${entries.length}`);
  console.info(message);

  if (DRY_RUN) {
    console.info("DRY_RUN — not posting overtime notification");
    return;
  }

  // Post directly by channel name — chat.postMessage accepts "#name" and
  // doesn't require enumerating channels first, which would have needed
  // groups:read scope for private channels. Bot just needs to be a member.
  try {
    await slack.chat.postMessage({
      channel: `#${channelName}`,
      text: message,
      as_user: true,
    });
    console.info(`Sent to #${channelName}`);
  } catch (err) {
    console.error(`Failed to post to #${channelName}:`, err);
  }
};

// === Tuesday: follow-up nudge to stragglers ===

function buildLateRegisterMessage(
  periodLabel: string,
  missingHours: number,
  missingDays: number
): { text: string; blocks: Array<Record<string, unknown>> } {
  const hoursLabel = `*${formatHoursShort(missingHours)} time${missingHours === 1 ? "" : "r"}*`;
  // The day count comes from the API's unregistered_days, which only counts
  // fully empty workdays. Drop the "fordelt på N dager" clause when it's 0
  // (someone with only partial days) to avoid the awkward "0 dager".
  const daysClause =
    missingDays > 0
      ? ` fordelt på ${missingDays === 1 ? "*1 dag*" : `*${missingDays} dager*`}`
      : "";

  const message =
    `Du mangler fortsatt ${hoursLabel}${daysClause} for *${periodLabel}*. ` +
    `Husk at avspasering skal markeres i fraværskalender og at ferie- og permisjonsdager også skal timeføres. ` +
    `Ser du over og evt. fører resten? 🙏`;

  const text =
    message.replace(/\*/g, "") +
    `\n\nÅpne timeføring: ${FLOQ_TIMESTAMP_URL}`;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: { type: "mrkdwn", text: message },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Åpne timeføring i Floq" },
          url: FLOQ_TIMESTAMP_URL,
        },
      ],
    },
  ];

  return { text, blocks };
}

type ShortfallPeriod = {
  startDate: moment.Moment;
  endDate: moment.Moment;
  label: string; // user-facing, e.g. "uke 20 (11.–15. mai)" or "april 2026"
  logTag: string; // for log lines, e.g. "Tuesday follow-up" or "Monthly nag"
};

function lastWeekShortfallPeriod(): ShortfallPeriod {
  const { startDate, endDate } = getLastFullWeekRange();
  const weekNumber = startDate.isoWeek();
  const fridayOfWeek = startDate.clone().add(4, "days");
  const displayEnd = endDate.isBefore(fridayOfWeek) ? endDate : fridayOfWeek;
  const sameMonth = startDate.month() === displayEnd.month();
  const first = sameMonth
    ? startDate.format("D.")
    : startDate.format("D. MMMM");
  const last = displayEnd.format("D. MMMM");
  return {
    startDate,
    endDate,
    label: `uke ${weekNumber} (${first}–${last})`,
    logTag: "Tuesday follow-up",
  };
}

function lastMonthShortfallPeriod(): ShortfallPeriod {
  const startDate = moment().subtract(1, "month").startOf("month");
  const endDate = startDate.clone().endOf("month");
  return {
    startDate,
    endDate,
    label: startDate.format("MMMM YYYY"),
    logTag: "First-of-month nag",
  };
}

const notifyLateRegisterers = async (period: ShortfallPeriod) => {
  const { startDate, endDate, label: periodLabel, logTag } = period;
  const startStr = startDate.format("YYYY-MM-DD");
  const endStr = endDate.format("YYYY-MM-DD");

  console.info(`${logTag} for ${startStr} → ${endStr}`);

  let rows: TimeTrackingStatusRow[];
  try {
    rows = await fetchTimeTrackingStatus(startDate, endDate);
  } catch (err) {
    console.error("time_tracking_status failed:", err);
    return;
  }
  if (!Array.isArray(rows)) {
    console.error("time_tracking_status did not return an array:", rows);
    return;
  }

  // Only nag the ones who *still* have a shortfall after Monday's reminder.
  let targets = rows.filter((r) => {
    if (r.available_hours <= 0) return false;
    const registered = r.billable_hours + r.non_billable_hours;
    return registered < r.available_hours - REPORT_TOLERANCE_HOURS;
  });
  console.info(`${targets.length} still below available_hours`);

  if (TEST_USER_EMAIL) {
    const before = targets.length;
    targets = targets.filter(
      (r) => r.email.toLowerCase() === TEST_USER_EMAIL
    );
    console.info(
      `TEST_USER_EMAIL=${TEST_USER_EMAIL} — filtered ${before} → ${targets.length} target(s)`
    );
  }

  if (targets.length === 0) {
    console.info("Nothing to nag on Tuesday.");
    return;
  }

  // Fetch absence calendar + employees + slack users in parallel. Bulk
  // queries instead of per-employee loops.
  const [allAbsences, allEmployees, slackUsersResp] = await Promise.all([
    fetchAllAbsencesForWeek(startStr, endStr),
    fetchAllEmployees(),
    slack.users.list(),
  ]);

  const slackUsers = slackUsersResp.members;
  if (!slackUsers) {
    console.error("No slack users in response");
    return;
  }

  // Build lookup: email → employee_id (lowercased emails)
  const idByEmail = new Map(
    allEmployees.map((e) => [e.email.toLowerCase(), e.id])
  );

  // Build lookup: employee_id → number of weekday absence calendar entries
  // (Mon-Fri) within the period.
  const absenceWeekdaysByEmployee = new Map<number, number>();
  for (const a of allAbsences) {
    const day = moment(a.date).day();
    if (day < 1 || day > 5) continue; // skip weekend absence entries
    absenceWeekdaysByEmployee.set(
      a.employee_id,
      (absenceWeekdaysByEmployee.get(a.employee_id) ?? 0) + 1
    );
  }

  for (const row of targets) {
    const apiMissing =
      row.available_hours - row.billable_hours - row.non_billable_hours;

    const employeeId = idByEmail.get(row.email.toLowerCase());
    const absenceDays = employeeId
      ? absenceWeekdaysByEmployee.get(employeeId) ?? 0
      : 0;
    const toleratedByAbsence = absenceDays * STANDARD_WORKDAY_HOURS;

    // If marked-absence days fully explain the gap (within tolerance), skip.
    if (apiMissing <= toleratedByAbsence + REPORT_TOLERANCE_HOURS) {
      console.info(
        `Skipping ${row.email}: ${absenceDays} fraværskalender-dag(er) forklarer gapet på ${formatHours(apiMissing)} t`
      );
      continue;
    }

    // Subtract the absence-explained portion from both totals shown in the
    // message so the user sees the remaining real gap.
    const missingHours = apiMissing - toleratedByAbsence;
    const missingDays = Math.max(0, row.unregistered_days - absenceDays);

    const targetUser = pickSlackRecipient(slackUsers, row.email);
    if (!targetUser) {
      console.error(`No Slack user found for ${row.email}`);
      continue;
    }

    const { text, blocks } = buildLateRegisterMessage(
      periodLabel,
      missingHours,
      missingDays
    );

    console.info(
      `Nudging @${targetUser.name} (${row.email}) — still missing ${formatHours(missingHours)} t, ${missingDays} empty day(s) (after ${absenceDays} absence-cal day(s) tolerance)`
    );

    if (DRY_RUN) {
      console.info("DRY_RUN — message preview:\n" + text);
      continue;
    }

    try {
      await slack.chat.postMessage({
        channel: targetUser.id!,
        text,
        blocks: blocks as any,
        as_user: true,
      });
      console.info(`Sent to @${targetUser.name}`);
    } catch (err) {
      console.error(`Failed to send to @${targetUser.name}:`, err);
    }
  }
};

// === First-of-month: monthly recap ===

type ProjectCategory = "billable" | "non_billable" | "absence";
type ProjectHours = {
  name: string;
  hours: number;
  category: ProjectCategory;
};

function aggregateProjectHours(
  rows: ProjectHoursPerDayRow[],
  projectInfo: Map<string, ProjectRow>
): ProjectHours[] {
  // Collapse across dates per project ID, then resolve name and category
  // via the projects map. Categories drive how rows are grouped in the
  // table and whether they're counted as "work" or "absence".
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.hours <= 0) continue;
    totals.set(r.project, (totals.get(r.project) ?? 0) + r.hours);
  }
  const result: ProjectHours[] = [];
  for (const [code, hours] of Array.from(totals)) {
    const info = projectInfo.get(code);
    let category: ProjectCategory;
    if (info?.billable === "unavailable") {
      category = "absence";
    } else if (info?.billable === "billable") {
      category = "billable";
    } else {
      // Defaults to non_billable when projects.billable says "non_billable"
      // or when the project is missing from /projects entirely.
      category = "non_billable";
    }
    const name = info?.name ?? code;
    result.push({ name, hours, category });
  }
  // Sort: work projects first (billable, then non_billable), then absence.
  // Within each category, biggest hours at the top.
  const order: Record<ProjectCategory, number> = {
    billable: 0,
    non_billable: 1,
    absence: 2,
  };
  result.sort((a, b) => {
    if (a.category !== b.category) return order[a.category] - order[b.category];
    return b.hours - a.hours;
  });
  return result;
}

function buildProjectTableBlock(
  projects: ProjectHours[],
  availableHours: number
): Record<string, unknown> {
  const headerRow = [headerCell("Prosjekt"), headerCell("Timer")];
  const workProjects = projects.filter((p) => p.category !== "absence");
  const absenceProjects = projects.filter((p) => p.category === "absence");

  const workRows = workProjects.map((p) => [
    textCell(p.name),
    textCell(`${formatHours(p.hours)} t`),
  ]);
  const workTotal = workProjects.reduce((s, p) => s + p.hours, 0);
  const sumRow = [
    headerCell("Sum arbeid"),
    headerCell(`${formatHours(workTotal)} t`),
  ];
  // Endring i fleksitid: work delta vs expected. Positive = built up
  // flex balance, negative = used flex / owe time. Only show when we
  // know what "expected" is (availableHours > 0).
  const flexChange = workTotal - availableHours;
  const flexRow =
    availableHours > 0
      ? [
          headerCell("Endring i fleksitid"),
          headerCell(formatSignedHours(flexChange)),
        ]
      : null;
  const absenceRows = absenceProjects.map((p) => [
    textCell(p.name),
    textCell(`${formatHours(p.hours)} t`),
  ]);

  // Rows: work → Sum arbeid → Endring i fleksitid → absences.
  const rows: Array<Array<Record<string, unknown>>> = [headerRow, ...workRows];
  if (workProjects.length > 0) {
    rows.push(sumRow);
    if (flexRow) rows.push(flexRow);
  }
  rows.push(...absenceRows);

  return {
    type: "table",
    column_settings: [
      { align: "left", is_wrapped: true },
      { align: "right" },
    ],
    rows,
  };
}

function buildMonthlyRecapMessage(params: {
  monthLabel: string;
  missingHours: number; // 0 if no shortfall
  missingDays: number;
  fgPct: number | null;
  billableHours: number;
  availableHours: number;
  bonusKr: number;
  projects: ProjectHours[];
}): { text: string; blocks: Array<Record<string, unknown>> } {
  const {
    monthLabel,
    missingHours,
    missingDays,
    fgPct,
    billableHours,
    availableHours,
    bonusKr,
    projects,
  } = params;

  const workTotal = projects
    .filter((p) => p.category !== "absence")
    .reduce((s, p) => s + p.hours, 0);

  const introLine = `Her er månedsoppsummeringen din for *${monthLabel}*.`;

  let shortfallLine: string | null = null;
  if (missingHours > REPORT_TOLERANCE_HOURS) {
    const hoursLabel = `*${formatHoursShort(missingHours)} time${missingHours === 1 ? "" : "r"}*`;
    const daysClause =
      missingDays > 0
        ? ` fordelt på ${missingDays === 1 ? "*1 dag*" : `*${missingDays} dager*`}`
        : "";
    shortfallLine =
      `Du mangler fortsatt ${hoursLabel}${daysClause} for *${monthLabel}*. ` +
      `Husk at avspasering skal markeres i fraværskalender og at ferie- og permisjonsdager også skal timeføres. ` +
      `Ser du over og evt. fører resten? 🙏`;
  }

  const statsLines: string[] = [];
  if (fgPct !== null && availableHours > 0) {
    statsLines.push(
      `*Faktureringsgrad:* ${formatHours(fgPct)} %  (${formatHours(billableHours)} av ${formatHours(availableHours)} t)`
    );
  }
  statsLines.push(`*Bonus i ${monthLabel}:* ${bonusKr.toLocaleString("nb-NO")} kr`);

  // Plain-text fallback
  const textLines = [introLine.replace(/\*/g, "")];
  if (shortfallLine) {
    textLines.push("", shortfallLine.replace(/\*/g, ""));
  }
  textLines.push("", ...statsLines.map((l) => l.replace(/\*/g, "")));
  textLines.push("", "Timer per prosjekt:");
  for (const p of projects) {
    textLines.push(`  ${p.name}: ${formatHours(p.hours)} t`);
    // Insert sum-arbeid + endring i fleksitid after the last non-absence row.
    const isLastWorkRow =
      p.category !== "absence" &&
      (projects.indexOf(p) === projects.length - 1 ||
        projects[projects.indexOf(p) + 1]?.category === "absence");
    if (isLastWorkRow) {
      textLines.push(`  Sum arbeid: ${formatHours(workTotal)} t`);
      if (availableHours > 0) {
        textLines.push(
          `  Endring i fleksitid: ${formatSignedHours(workTotal - availableHours)}`
        );
      }
    }
  }
  textLines.push("", `Åpne timeføring: ${FLOQ_TIMESTAMP_URL}`);
  const text = textLines.join("\n");

  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: introLine } },
  ];
  if (shortfallLine) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: shortfallLine },
    });
  }
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: statsLines.join("\n") },
  });
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Åpne timeføring i Floq" },
        url: FLOQ_TIMESTAMP_URL,
      },
    ],
  });
  blocks.push(buildProjectTableBlock(projects, availableHours));

  return { text, blocks };
}

const notifyMonthlyRecap = async () => {
  // Previous calendar month — e.g. on June 1 covers May 1 → May 31.
  const monthStart = moment().subtract(1, "month").startOf("month");
  const monthEnd = monthStart.clone().endOf("month");
  const startStr = monthStart.format("YYYY-MM-DD");
  const endStr = monthEnd.format("YYYY-MM-DD");
  const monthLabel = monthStart.format("MMMM YYYY");
  const year = monthStart.year();
  const month = monthStart.month() + 1; // moment month is 0-indexed; SQL wants 1–12

  console.info(`Monthly recap for ${monthLabel} (${startStr} → ${endStr})`);

  let rows: TimeTrackingStatusRow[];
  try {
    rows = await fetchTimeTrackingStatus(monthStart, monthEnd);
  } catch (err) {
    console.error("time_tracking_status failed:", err);
    return;
  }
  if (!Array.isArray(rows)) {
    console.error("time_tracking_status did not return an array:", rows);
    return;
  }

  let targets = rows.filter((r) => r.available_hours > 0);
  console.info(`${targets.length} employees with available_hours > 0`);

  if (TEST_USER_EMAIL) {
    const before = targets.length;
    targets = targets.filter(
      (r) => r.email.toLowerCase() === TEST_USER_EMAIL
    );
    console.info(
      `TEST_USER_EMAIL=${TEST_USER_EMAIL} — filtered ${before} → ${targets.length} target(s)`
    );
  }

  if (targets.length === 0) {
    console.info("Nothing to send for monthly recap.");
    return;
  }

  const [
    allEmployees,
    allAbsences,
    projectInfo,
    bonusByEmployee,
    fgByEmployee,
    slackUsersResp,
  ] = await Promise.all([
    fetchAllEmployees(),
    fetchAllAbsencesForWeek(startStr, endStr),
    fetchProjectInfoMap(),
    fetchAllMonthlyBonuses(year, month),
    fetchAllFGForRange(startStr, endStr),
    slack.users.list(),
  ]);

  const slackUsers = slackUsersResp.members;
  if (!slackUsers) {
    console.error("No slack users in response");
    return;
  }

  const idByEmail = new Map(
    allEmployees.map((e) => [e.email.toLowerCase(), e.id])
  );

  const absenceWeekdaysByEmployee = new Map<number, number>();
  for (const a of allAbsences) {
    const day = moment(a.date).day();
    if (day < 1 || day > 5) continue;
    absenceWeekdaysByEmployee.set(
      a.employee_id,
      (absenceWeekdaysByEmployee.get(a.employee_id) ?? 0) + 1
    );
  }

  for (const row of targets) {
    const employeeId = idByEmail.get(row.email.toLowerCase());
    if (!employeeId) {
      console.warn(`No employee_id for ${row.email}, skipping`);
      continue;
    }
    // Per-employee fetch wrapped: a single failure skips just this person.
    let projectRows: ProjectHoursPerDayRow[];
    try {
      projectRows = await fetchProjectHoursPerDay(employeeId, startStr, endStr);
    } catch (err) {
      console.error(`Skipping ${row.email} — fetch failed:`, err);
      continue;
    }
    const fgRange = fgByEmployee.get(employeeId) ?? {
      billable: 0,
      available: 0,
    };
    const bonusKr = bonusByEmployee.get(employeeId) ?? 0;

    const fgPct =
      fgRange.available > 0 ? (fgRange.billable / fgRange.available) * 100 : null;

    const projects = aggregateProjectHours(projectRows, projectInfo);

    // Defensive: if FG indicates the employee did register hours but our
    // project query came back empty, something went wrong (404, parse
    // error, etc.). Skip rather than sending a misleading empty table.
    if (
      projects.length === 0 &&
      (fgRange.billable > 0 || fgRange.available > 0)
    ) {
      console.warn(
        `Skipping ${row.email}: empty project breakdown despite FG data (${fgRange.billable}/${fgRange.available} t) — likely a fetch failure.`
      );
      continue;
    }

    // Shortfall: same logic as Tuesday, with absence-calendar tolerance
    const apiMissing =
      row.available_hours - row.billable_hours - row.non_billable_hours;
    const absenceDays = absenceWeekdaysByEmployee.get(employeeId) ?? 0;
    const toleratedByAbsence = absenceDays * STANDARD_WORKDAY_HOURS;
    const realMissing = Math.max(0, apiMissing - toleratedByAbsence);
    const realMissingDays = Math.max(0, row.unregistered_days - absenceDays);

    const targetUser = pickSlackRecipient(slackUsers, row.email);
    if (!targetUser) {
      console.error(`No Slack user found for ${row.email}`);
      continue;
    }

    const { text, blocks } = buildMonthlyRecapMessage({
      monthLabel,
      missingHours: realMissing,
      missingDays: realMissingDays,
      fgPct,
      billableHours: fgRange.billable,
      availableHours: fgRange.available,
      bonusKr,
      projects,
    });

    console.info(
      `Monthly recap → @${targetUser.name} (${row.email}) — FG ${fgPct?.toFixed(1) ?? "n/a"} %, bonus ${bonusKr} kr, ${projects.length} prosjekt(er), missing ${formatHours(realMissing)} t`
    );

    if (DRY_RUN) {
      console.info("DRY_RUN — message preview:\n" + text);
      continue;
    }

    try {
      await slack.chat.postMessage({
        channel: targetUser.id!,
        text,
        blocks: blocks as any,
        as_user: true,
      });
      console.info(`Sent to @${targetUser.name}`);
    } catch (err) {
      console.error(`Failed to send to @${targetUser.name}:`, err);
    }
  }
};

const main = async () => {
  const tasks: Promise<unknown>[] = [];
  if (isMonday) {
    tasks.push(notifySlackers());
  }
  if (isOvertimeCheck) {
    tasks.push(notifyAdminAboutOvertime());
  }
  if (isTuesday) {
    tasks.push(notifyLateRegisterers(lastWeekShortfallPeriod()));
  }
  if (isFirstOfMonth) {
    // Nag stragglers about the *previous calendar month*. Reuses the
    // Tuesday template, just with a different period.
    tasks.push(notifyLateRegisterers(lastMonthShortfallPeriod()));
  }
  if (isMonthlyRecap) {
    // Full digest with FG/bonus/project table. Fires on the first Monday
    // of a new month so all majority-in-month weeks are settled.
    tasks.push(notifyMonthlyRecap());
  }

  if (tasks.length === 0) {
    console.info(
      `Nothing scheduled today (run with IS_MONDAY, IS_TUESDAY, IS_OVERTIME, IS_FIRST_OF_MONTH or IS_MONTHLY_RECAP=true to test).`
    );
    return;
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") console.error("Top-level error:", r.reason);
  }
};

main();
