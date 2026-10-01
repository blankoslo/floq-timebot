import { WebClient } from "@slack/web-api";
import { GoogleAuth } from "google-auth-library";
import moment from "moment";

// === Config ===
const platformUri =
  process.env.PLATFORM_URI || "https://api-test.platform.floq.no";
const floqAuthBaseUrl =
  process.env.FLOQ_AUTH_BASE_URL || "https://test.floq.no";
const floqServiceTokenAudience =
  process.env.FLOQ_SERVICE_TOKEN_AUDIENCE || floqAuthBaseUrl;
const slack = new WebClient(process.env.SLACK_API_TOKEN || "");
const DRY_RUN = process.env.DRY_RUN === "true";
const FLOQ_TIMESTAMP_URL =
  process.env.FLOQ_TIMESTAMP_URL || "https://inni.blank.no/timestamp/";
const FLOQ_INVOICE_URL =
  process.env.FLOQ_INVOICE_URL || "https://inni.blank.no/invoice";
// When set, only this employee's data is processed (filters the target
// list) — useful for previewing how a real Slack render looks without
// spamming everyone.
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL?.toLowerCase().trim();
// When set, all Slack DMs are routed to this address instead of the
// employee's own. Lets you impersonate someone (combined with
// TEST_USER_EMAIL) to see their exact message rendered in your own DM.
const TEST_USER_SLACK_EMAIL =
  process.env.TEST_USER_SLACK_EMAIL?.toLowerCase().trim();
// Ignore small deltas so a 7 t vs 7,5 t day doesn't trigger a notification.
const REPORT_TOLERANCE_HOURS = 0.5;

// === Ledig kapasitet (staffing/availability) ===
// Channel that receives the "free capacity next N weeks" overview. Posted by
// name (chat.postMessage accepts "#name") — the bot just needs to be a member.
const CAPACITY_CHANNEL =
  process.env.CAPACITY_CHANNEL || "admin-bemanningogsalg-diskusjon";
// How many ISO weeks ahead (including the current week) the overview covers.
const CAPACITY_WEEKS_AHEAD = Number(process.env.CAPACITY_WEEKS_AHEAD || "6");

moment.locale("nb");

// === Mocked "today" ===
// MOCK_TODAY=YYYY-MM-DD pins every flow's idea of the current date, so the
// date-gated ones (invoicing send-day, first-of-month, first Monday) can be
// exercised on any calendar day instead of waiting for it to come round.
// Strict parsing: a typo must fail loudly at boot, not silently fall back to
// the real date and send a wrong month to everyone.
const MOCK_TODAY = process.env.MOCK_TODAY?.trim();
if (MOCK_TODAY && !moment(MOCK_TODAY, "YYYY-MM-DD", true).isValid()) {
  throw new Error(
    `MOCK_TODAY must be a valid YYYY-MM-DD date, got "${MOCK_TODAY}"`,
  );
}
// Every "what is now" read goes through this — never call moment() bare, or
// that call site silently ignores MOCK_TODAY. Returns a fresh instance each
// time because moment objects are mutable and callers chain .subtract() etc.
const now = (): moment.Moment =>
  MOCK_TODAY ? moment(MOCK_TODAY, "YYYY-MM-DD", true) : moment();

// Bonus comes from floq-platform's billing-degree report, which owns
// per-week FG, the majority-week-in-month rule, the non-FG-code adjustment
// and the Fagleder bonus tiers — so the bot mirrors none of that logic.

// Note: we used to hardcode an absence-code list here, but it was both
// incomplete (missed several codes Floq counts as unavailable) and wrong
// for PER1000 (Permisjon m/lønn — counted as non-billable, not absence).
// Categorization now reads `billable` from /projects instead, so the
// API is the single source of truth.

// === Types ===
type TimeTrackingStatusRow = {
  name: string;
  email: string;
  availableHours: number;
  billableHours: number;
  nonBillableHours: number;
  unregisteredDays: number;
  lastDate: string | null;
};

type EmployeeRow = {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string | null;
  dateOfEmployment: string | null;
  terminationDate: string | null;
};
type HolidayRow = { date: string; name: string | null };
type AbsenceRow = {
  date: string;
  employeeId: number;
  reason: string;
  percentage: number;
};
type InvoiceProjectRow = {
  id: string;
  name: string;
  // oppdragsansvarlig, an employees.id
  responsible: number;
};
type BillingDegreePeriodRow = {
  employeeId: number;
  billableHours: number;
  capacityHours: number;
};
// One row per (employee, project, day) with hours; days without are no row.
type ProjectHoursPerDayRow = {
  employeeId: number;
  projectId: string;
  projectName: string;
  // "billable" | "nonbillable" | "unavailable"
  status: string;
  date: string;
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
const FLOQ_API_SCOPE = "role:read_only";
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;

const googleAuth = new GoogleAuth();
let cachedApiToken: { accessToken: string; expiresAt: number } | null = null;

async function apiToken(): Promise<string> {
  if (cachedApiToken && cachedApiToken.expiresAt > Date.now()) {
    return cachedApiToken.accessToken;
  }

  const idTokenClient = await googleAuth.getIdTokenClient(
    floqServiceTokenAudience,
  );
  const idToken = await idTokenClient.idTokenProvider.fetchIdToken(
    floqServiceTokenAudience,
  );

  const res = await fetch(`${floqAuthBaseUrl}/login/oauth/as/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      scope: FLOQ_API_SCOPE,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Floq token exchange failed: ${res.status} ${res.statusText} ${await res.text()}`,
    );
  }
  const { access_token, expires_in } = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedApiToken = {
    accessToken: access_token,
    expiresAt:
      Date.now() + Math.max(expires_in - TOKEN_EXPIRY_BUFFER_SECONDS, 0) * 1000,
  };
  return cachedApiToken.accessToken;
}

// Pick which Slack user to DM. Honors TEST_USER_SLACK_EMAIL override so we
// can impersonate someone else's data while having the message land in our
// own inbox.
function pickSlackRecipient(
  slackUsers: Array<{
    id?: string;
    name?: string;
    profile?: { email?: string };
  }>,
  originalEmail: string,
): { id?: string; name?: string; profile?: { email?: string } } | undefined {
  const targetEmail = (TEST_USER_SLACK_EMAIL ?? originalEmail).toLowerCase();
  return slackUsers.find(
    (u) => u.profile?.email?.toLowerCase() === targetEmail,
  );
}

async function apiFetch(path: string, body?: unknown): Promise<Response> {
  const method = body === undefined ? "GET" : "POST";
  const res = await fetch(`${platformUri}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await apiToken()}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `${method} ${path} failed: ${res.status} ${res.statusText} ${await res.text()}`,
    );
  }
  return res;
}

async function apiGet<T>(path: string): Promise<T> {
  return (await apiFetch(path)).json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return (await apiFetch(path, body)).json() as Promise<T>;
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
// Availability overview posts to the bemanning/salg channel — its own flag so
// it doesn't ride along with the Monday digest unless explicitly scheduled.
const isAvailabilityCheck = process.env.IS_AVAILABILITY === "true";
// Aggregated admin "missing time" overview — its own flag so it can be
// scheduled and tested independently of the personal Monday/Tuesday/month
// nudges. ADMIN_MISSING_PERIOD picks which period it reports on.
const isAdminMissing = process.env.IS_ADMIN_MISSING === "true";
const adminMissingPeriod =
  process.env.ADMIN_MISSING_PERIOD === "month" ? "month" : "week";
// Fired every weekday; notifyInvoicingResponsible self-gates to the send day.
// INVOICING_REMINDER_FORCE bypasses that gate for testing (previous month).
const isInvoicingReminder = process.env.IS_INVOICING_REMINDER === "true";
const invoicingReminderForce = process.env.INVOICING_REMINDER_FORCE === "true";
// The monthly recap rides along with the Monday run, but only on the first
// Monday of the month (date 1–7) — by then every "majority-of-days-in-
// previous-month" week has finished, so bonus + FG are stable. No separate
// cron needed. IS_MONTHLY_RECAP=true forces it for local testing.
const isMonthlyRecap =
  process.env.IS_MONTHLY_RECAP === "true" || (isMonday && now().date() <= 7);

// Previous calendar week (Mon–Sun before today). Used by both the Monday
// digest and the Tuesday follow-up — both report on the just-finished week.
const getLastFullWeekRange = () => ({
  startDate: now().subtract(1, "week").startOf("isoWeek"),
  endDate: now().subtract(1, "week").endOf("isoWeek"),
});

// === Data fetching ===

async function fetchTimeTrackingStatus(
  startDate: moment.Moment,
  endDate: moment.Moment,
): Promise<TimeTrackingStatusRow[]> {
  return apiGet<TimeTrackingStatusRow[]>(
    `/reports/time-tracking-status?from=${startDate.format("YYYY-MM-DD")}&to=${endDate.format("YYYY-MM-DD")}`,
  );
}

// Bulk fetchers below intentionally do NOT catch — a failed shared fetch
// must abort the whole run (the error propagates to main's allSettled and
// no messages go out) rather than silently degrade every message.

async function fetchHolidays(
  startDate: string,
  endDate: string,
): Promise<HolidayRow[]> {
  // The platform only serves the whole table.
  const holidays = await apiGet<HolidayRow[]>("/timesheet/holidays");
  return holidays.filter((h) => h.date >= startDate && h.date <= endDate);
}

async function fetchAllAbsencesForWeek(
  startDate: string,
  endDate: string,
): Promise<AbsenceRow[]> {
  return apiGet<AbsenceRow[]>(
    `/timesheet/absence?from=${startDate}&to=${endDate}`,
  );
}

async function fetchAllEmployees(): Promise<EmployeeRow[]> {
  return apiGet<EmployeeRow[]>("/employees");
}

// employee id → week_start → hours of avspasering confirmed for that week.
// confirmed-weeks only answers which confirmations still hold (the week's
// balance hasn't slipped below what was confirmed); the minutes live on the
// confirmation itself. Those are the signed week balance, so only a negative
// value is a shortfall the user has owned up to.
async function fetchConfirmedShortfalls(
  employeeIds: number[],
  fromMonday: string,
  toDate: string,
): Promise<Map<number, Map<string, number>>> {
  const result = new Map<number, Map<string, number>>();
  // An empty employeeIds is an empty answer, not everyone's.
  if (employeeIds.length === 0) return result;

  const weeks = await apiGet<{ employeeId: number; weekStart: string }[]>(
    `/timesheet/confirmed-weeks?employeeIds=${employeeIds.join(",")}&from=${fromMonday}&to=${toDate}`,
  );
  const confirmations = await Promise.all(
    weeks.map(async (w) => {
      const res = await apiFetch(
        `/timesheet/balance-confirmation?employeeId=${w.employeeId}&weekStart=${w.weekStart}`,
      );
      // 204 = never confirmed. Can't follow a confirmed-weeks hit unless it
      // was withdrawn in between.
      if (res.status === 204) return null;
      const { minutes } = (await res.json()) as { minutes: number };
      return { ...w, minutes };
    }),
  );

  for (const c of confirmations) {
    if (!c || c.minutes >= 0) continue;
    const byWeek = result.get(c.employeeId) ?? new Map<string, number>();
    byWeek.set(c.weekStart, -c.minutes / 60);
    result.set(c.employeeId, byWeek);
  }
  return result;
}

async function fetchActiveBillableProjectsWithResponsible(): Promise<
  InvoiceProjectRow[]
> {
  const projects = await apiGet<
    { id: string; name: string; responsible: number | null }[]
  >("/projects?active=true&billable=true");
  return projects.filter((p): p is InvoiceProjectRow => p.responsible !== null);
}

async function fetchHoursByEmployee(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<Map<number, ProjectHoursPerDayRow[]>> {
  const byEmployee = new Map<number, ProjectHoursPerDayRow[]>();
  // The route refuses an empty list rather than answering nobody.
  if (employeeIds.length === 0) return byEmployee;

  const rows = await apiPost<ProjectHoursPerDayRow[]>(
    "/reports/employee-hours",
    { employeeIds, from: startDate, to: endDate },
  );
  for (const r of rows) {
    const list = byEmployee.get(r.employeeId);
    if (list) list.push(r);
    else byEmployee.set(r.employeeId, [r]);
  }
  return byEmployee;
}

// FG over exactly start..end, as fg_employee_period gave it. The per-employee
// report's month bucket is not a substitute: it follows the majority-week rule
// the bonus uses, so its hours don't add up to the calendar month.
async function fetchAllFGForRange(
  start: string,
  end: string,
): Promise<Map<number, { billable: number; available: number }>> {
  const { employees } = await apiGet<{ employees: BillingDegreePeriodRow[] }>(
    `/reports/billing-degree/achieved/period?from=${start}&to=${end}`,
  );
  return new Map(
    employees.map((e) => [
      e.employeeId,
      { billable: e.billableHours, available: e.capacityHours },
    ]),
  );
}

// Per-employee fetcher: throws on a real API error. Callers wrap the loop
// body so one employee's failure skips just them (loud), not the whole run.
// No route serves every employee's bonus at once.
async function fetchMonthlyBonus(
  employeeId: number,
  month: string, // YYYY-MM
): Promise<number> {
  const { months } = await apiGet<{ months: { bonusAmount: number }[] }>(
    `/reports/billing-degree/achieved/employee?employeeId=${employeeId}&fromMonth=${month}&toMonth=${month}`,
  );
  return months[0]?.bonusAmount ?? 0;
}

// === Per-day breakdown ===

// Absence-calendar reasons that excuse a workday without registered hours
// (codes from floq-db's absence_reasons view). Fagutvikling (FAG1000) is left
// out on purpose
const EXCUSED_ABSENCE_REASONS = new Set([
  "AVS", // Avspasering
  "FER1000", // Ferie
  "SYK1000",
  "SYK1001",
  "SYK1002",
  "PER1000",
  "PER1001",
  "PER1002",
]);

type ExcusedAbsenceDays = { days: number; dates: Set<string> };

// `days` is percentage-weighted, so a 50 % entry counts as half a day.
function excusedAbsenceByEmployee(
  absences: AbsenceRow[],
): Map<number, ExcusedAbsenceDays> {
  const result = new Map<number, ExcusedAbsenceDays>();
  for (const a of absences) {
    if (!EXCUSED_ABSENCE_REASONS.has(a.reason)) continue;
    const day = moment(a.date).day();
    if (day < 1 || day > 5) continue;
    const cur = result.get(a.employeeId) ?? { days: 0, dates: new Set() };
    cur.days += a.percentage / 100;
    cur.dates.add(a.date);
    result.set(a.employeeId, cur);
  }
  return result;
}

// Standard work day length. Part-timers may see slight noise here; we'll fix
// that when we surface stillingsprosent properly.
const STANDARD_WORKDAY_HOURS = 7.5;

function buildPerDayBreakdown(
  startDate: moment.Moment,
  endDate: moment.Moment,
  rows: ProjectHoursPerDayRow[],
  holidays: HolidayRow[],
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
    const weekend = isWeekend(d);

    let status: DayStatus;
    let hoursExpected: number;

    if (weekend) {
      // Weekend wins over holiday so weekend-holidays (17. mai on Sunday)
      // get filtered out rather than surfacing as a row.
      status = "weekend";
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

function statusIcon(s: DayStatus, gapConfirmed = false): string {
  // Per design: only flag days that warrant attention. Complete days and
  // absence days don't need a visual marker — the row already conveys it.
  switch (s) {
    case "partial":
      return gapConfirmed ? "" : "⚠️";
    case "empty":
      return gapConfirmed ? "" : "⛔️";
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

function buildTableRow(
  day: DayBreakdown,
  gapConfirmed = false,
): Record<string, unknown>[] {
  const m = moment(day.date);
  const dayDateLabel = `${DAY_NAMES_NB[m.day()]} ${m.format("D. MMMM")}`;
  const icon = statusIcon(day.status, gapConfirmed);
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
  totalExpected: number,
  gapConfirmed = false,
): Record<string, unknown> {
  const headerRow = [
    headerCell("Dag"),
    headerCell("Timer"),
    headerCell("Prosjekt"),
    headerCell("Status"),
  ];
  const dataRows = days.map((d) => buildTableRow(d, gapConfirmed));
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

function formatPerDayLine(day: DayBreakdown, gapConfirmed = false): string {
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
    return `${hoursStr} t ${statusIcon(day.status, gapConfirmed)}`.trimEnd();
  }

  // complete or partial — show hours and project(s)
  const projectStr =
    day.projects.length > 0
      ? day.projects.slice(0, 3).join(" + ") +
        (day.projects.length > 3 ? " m.fl." : "")
      : "-";
  const base = `${hoursStr} t (${projectStr})`;
  const icon = statusIcon(day.status, gapConfirmed);
  return icon ? `${base} ${icon}` : base;
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
  partialDays: number,
): string {
  const totalDays = emptyDays + partialDays;
  const missingLabel = `*${formatHoursShort(missingHours)} time${missingHours === 1 ? "" : "r"}*`;
  const closing =
    emptyDays === 0
      ? "Ser du over og enten bekrefter avspasering eller fører resten? 🙏"
      : "Ser du over og evt. fører resten? 🙏";

  if (totalDays === 0) {
    return `Du mangler totalt ${missingLabel}. ${closing}`;
  }

  const dayCountLabel = totalDays === 1 ? "*1 dag*" : `*${totalDays} dager*`;

  if (emptyDays > 0 && partialDays > 0) {
    const empty = emptyDays === 1 ? "én hel" : `${numberWord(emptyDays)} hele`;
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
  hasIssues: boolean,
  gapConfirmed = false,
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
  const periodLabel = `uke ${weekNumber} (${firstDate}-${lastDate})`;

  const perDayLines = days
    .map((d) => formatPerDayLine(d, gapConfirmed))
    .join("\n");

  const emptyDays = days.filter((d) => d.status === "empty").length;
  const partialDays = days.filter((d) => d.status === "partial").length;
  const missingHours = Math.max(0, totalExpected - totalActual);

  // Intro is brief by default; on shortfall we append the summary line.
  // Caller decides via hasIssues (typically true when there's a gap, but
  // suppressed when monthly recap fires the same day so we don't repeat
  // shortfall info already in the recap).
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
  blocks.push(buildTableBlock(days, totalActual, totalExpected, gapConfirmed));

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
  // week vacation/parental leave (availableHours = 0) get nothing.
  let targets = rows.filter((r) => r.availableHours > 0);
  console.info(`${targets.length} employees with availableHours > 0`);

  if (TEST_USER_EMAIL) {
    const before = targets.length;
    targets = targets.filter((r) => r.email.toLowerCase() === TEST_USER_EMAIL);
    console.info(
      `TEST_USER_EMAIL=${TEST_USER_EMAIL} — filtered ${before} → ${targets.length} target(s)`,
    );
    if (targets.length === 0) {
      console.warn(
        `No employee matching ${TEST_USER_EMAIL} in time_tracking_status — nothing to send`,
      );
      return;
    }
  }

  if (targets.length === 0) {
    console.info("Nothing to notify, exiting notifySlackers.");
    return;
  }

  // Fetch shared data once
  const [holidays, slackUsersResp, allEmployees] = await Promise.all([
    fetchHolidays(startStr, endStr),
    slack.users.list(),
    fetchAllEmployees(),
  ]);

  const slackUsers = slackUsersResp.members;
  if (!slackUsers) {
    console.error("No slack users in response:", slackUsersResp);
    return;
  }

  const idByEmail = new Map(
    allEmployees.map((e) => [e.email.toLowerCase(), e.id]),
  );
  const targetIds = targetEmployeeIds(targets, idByEmail);
  const [confirmedByEmployee, hoursByEmployee] = await Promise.all([
    fetchConfirmedShortfallHours(targetIds, startDate, endDate),
    fetchHoursByEmployee(targetIds, startStr, endStr),
  ]);

  for (const row of targets) {
    const employeeId = idByEmail.get(row.email.toLowerCase());
    if (!employeeId) {
      console.warn(`No employee_id for ${row.email}, skipping`);
      continue;
    }
    const days = buildPerDayBreakdown(
      startDate,
      endDate,
      hoursByEmployee.get(employeeId) ?? [],
      holidays,
    );

    // Headline totals sum across all surviving days. The filter inside
    // buildPerDayBreakdown already dropped weekends-without-work and other
    // noise — anything still here counts. Absence and holiday days have
    // hoursExpected = 0 so they only contribute to the "actual" side.
    const totalActual = days.reduce((s, d) => s + d.hoursActual, 0);
    const totalExpected = days.reduce((s, d) => s + d.hoursExpected, 0);

    const targetUser = pickSlackRecipient(slackUsers, row.email);
    if (!targetUser) {
      console.error(`No Slack user found for ${row.email}`);
      continue;
    }

    // Include shortfall paragraph when there's a gap — except on first-
    // Monday runs, where the monthly recap fires the same day and would
    // duplicate the shortfall info at a wider scope.
    const hasEmpty = days.some((d) => d.status === "empty");
    const missing = Math.max(0, totalExpected - totalActual);
    const hasShortfall = hasEmpty || missing > REPORT_TOLERANCE_HOURS;

    // ...and except when the gap is already confirmed as avspasering. Same
    // rule as the Tuesday nudge and the admin table (bare >=, so the
    // confirmation goes stale once the shortfall grows past what was
    // confirmed) — the > 0 guard keeps a missing-free week from matching a
    // non-existent confirmation. `missing` is already absence-adjusted:
    // absence days carry hoursExpected = 0.
    const confirmedHours = confirmedByEmployee.get(employeeId) ?? 0;
    const confirmedCoversGap = confirmedHours > 0 && confirmedHours >= missing;
    if (hasShortfall && confirmedCoversGap) {
      console.info(
        `${row.email}: dropper shortfall-avsnitt — ${formatHours(missing)} t dekket av ${formatHours(confirmedHours)} t bekreftet avspasering`,
      );
    }

    const hasIssues = hasShortfall && !isMonthlyRecap && !confirmedCoversGap;

    const { text, blocks } = buildSlackMessage(
      startDate,
      endDate,
      days,
      totalActual,
      totalExpected,
      hasIssues,
      confirmedCoversGap,
    );

    const emptyDays = days.filter((d) => d.status === "empty").length;
    const partialDays = days.filter((d) => d.status === "partial").length;
    const variant = hasIssues ? "issues" : "brief";
    console.info(
      `Notifying @${targetUser.name} (${row.email}) [${variant}] — ${formatHours(totalActual)}/${formatHours(totalExpected)} t, ${emptyDays} empty + ${partialDays} partial`,
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

  let entries: { paidDate: string | null }[];
  try {
    const all = await apiGet<{ paidDate: string | null }[]>(
      "/timesheet/overtime",
    );
    entries = all.filter((e) => e.paidDate === null);
  } catch (err) {
    console.error("Failed to fetch overtime:", err);
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

// === Reminder til oppdragsansvarlig: fakturering ===
//
// DM every project's oppdragsansvarlig (projects.responsible) to invoice the
// just-finished month. Send-day: the first day of the following month if it's a
// virkedag, else rolled forward to the next virkedag (past weekends and
// holidays). The reminder always covers the month before the send-day.

// First day of monthAnchor's month, rolled forward to the first virkedag on or
// after it (isoWeekday 6/7 = Sat/Sun).
function invoicingReminderSendDate(
  monthAnchor: moment.Moment,
  holidaySet: Set<string>,
): moment.Moment {
  const d = monthAnchor.clone().startOf("month");
  while (d.isoWeekday() >= 6 || holidaySet.has(d.format("YYYY-MM-DD"))) {
    d.add(1, "day");
  }
  return d;
}

function buildInvoicingReminderMessage(
  monthLabel: string,
  projects: InvoiceProjectRow[],
): { text: string; blocks: Array<Record<string, unknown>> } {
  const projectLines = projects.map((p) => `• ${p.name} (${p.id})`).join("\n");
  const ownsClause =
    projects.length === 1
      ? "dette oppdraget"
      : `disse ${projects.length} oppdragene`;
  const intro =
    `Det er på tide å fakturere for *${monthLabel}* 🧾\n` +
    `Du står som oppdragsansvarlig for ${ownsClause}:`;
  const message = `${intro}\n${projectLines}`;

  const text =
    message.replace(/\*/g, "") + `\n\nÅpne fakturering: ${FLOQ_INVOICE_URL}`;

  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: message } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Åpne fakturering i Floq" },
          url: FLOQ_INVOICE_URL,
        },
      ],
    },
  ];

  return { text, blocks };
}

const notifyInvoicingResponsible = async () => {
  const today = now().startOf("day");

  // Two send-days get evaluated below — this month's, and next month's for the
  // "next" log line — and each rolls forward through holidays, so fetch both
  // months whole rather than guessing how far a roll can travel.
  const holStart = today.clone().startOf("month").format("YYYY-MM-DD");
  const holEnd = today
    .clone()
    .startOf("month")
    .add(1, "month")
    .endOf("month")
    .format("YYYY-MM-DD");

  const holidays = await fetchHolidays(holStart, holEnd);
  const holidaySet = new Set(holidays.map((h) => h.date));

  // The send-day sits at the start of the month, so whenever we do send, it's
  // for the month that just ended — the gate below decides whether, not which.
  const monthLabel = today
    .clone()
    .startOf("month")
    .subtract(1, "month")
    .format("MMMM YYYY");

  if (invoicingReminderForce) {
    console.info("INVOICING_REMINDER_FORCE — bypassing the send-day gate.");
  } else {
    const sendDate = invoicingReminderSendDate(today, holidaySet);
    if (!today.isSame(sendDate, "day")) {
      // Past this month's send-day, the next one comes off next month's 1st.
      const next = sendDate.isAfter(today)
        ? sendDate
        : invoicingReminderSendDate(today.clone().add(1, "month"), holidaySet);
      console.info(
        `Not an invoicing reminder day (today=${today.format("YYYY-MM-DD")}, next=${next.format("YYYY-MM-DD")}). Skipping.`,
      );
      return;
    }
  }

  console.info(`Invoicing reminder for ${monthLabel}`);

  const [projects, allEmployees, slackUsersResp] = await Promise.all([
    fetchActiveBillableProjectsWithResponsible(),
    fetchAllEmployees(),
    slack.users.list(),
  ]);

  const slackUsers = slackUsersResp.members;
  if (!slackUsers) {
    console.error("No slack users in response");
    return;
  }

  const emailById = new Map(allEmployees.map((e) => [e.id, e.email]));

  let targets = projects;
  if (TEST_USER_EMAIL) {
    const before = targets.length;
    targets = targets.filter(
      (p) => emailById.get(p.responsible)?.toLowerCase() === TEST_USER_EMAIL,
    );
    console.info(
      `TEST_USER_EMAIL=${TEST_USER_EMAIL} — filtered ${before} → ${targets.length} target(s)`,
    );
  }

  const projectsByResponsible = new Map<number, InvoiceProjectRow[]>();
  for (const p of targets) {
    const list = projectsByResponsible.get(p.responsible);
    if (list) list.push(p);
    else projectsByResponsible.set(p.responsible, [p]);
  }

  console.info(
    `${targets.length} billable project(s) across ${projectsByResponsible.size} oppdragsansvarlig`,
  );

  if (projectsByResponsible.size === 0) {
    console.info("Nothing to send for invoicing reminder.");
    return;
  }

  for (const [responsibleId, ownedProjects] of Array.from(
    projectsByResponsible,
  )) {
    const email = emailById.get(responsibleId);
    if (!email) {
      console.warn(
        `No email for responsible employee ${responsibleId}, skipping`,
      );
      continue;
    }
    const targetUser = pickSlackRecipient(slackUsers, email);
    if (!targetUser) {
      console.error(`No Slack user found for ${email}`);
      continue;
    }

    ownedProjects.sort((a, b) => a.name.localeCompare(b.name, "nb"));

    const { text, blocks } = buildInvoicingReminderMessage(
      monthLabel,
      ownedProjects,
    );

    console.info(
      `Invoicing reminder → @${targetUser.name} (${email}) — ${ownedProjects.length} prosjekt(er)`,
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

// === Ledig kapasitet: hvem har ubemannede dager de neste N ukene ===
//
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
): { text: string; blocks: Array<Record<string, unknown>> } {
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

const notifyAvailableConsultants = async () => {
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

  const { text, blocks } = buildAvailabilityMessage(
    weekStart,
    windowEnd,
    isoWeeks,
    workdays.length,
    people,
  );

  console.info(
    `Availability: ${people.length}/${employees.length} employees with ≥1 free day over ${workdays.length} workdays`,
  );

  if (DRY_RUN) {
    console.info("DRY_RUN — availability preview:\n" + text);
    return;
  }

  try {
    await slack.chat.postMessage({
      channel: `#${CAPACITY_CHANNEL}`,
      text,
      blocks: blocks as any,
      as_user: true,
    });
    console.info(`Sent availability overview to #${CAPACITY_CHANNEL}`);
  } catch (err) {
    console.error(`Failed to post to #${CAPACITY_CHANNEL}:`, err);
  }
};

// === Tuesday: follow-up nudge to stragglers ===

function buildLateRegisterMessage(
  periodLabel: string,
  missingHours: number,
  missingDays: number,
): { text: string; blocks: Array<Record<string, unknown>> } {
  const hoursLabel = `*${formatHoursShort(missingHours)} time${missingHours === 1 ? "" : "r"}*`;
  const daysLabel = missingDays === 1 ? "*1 dag*" : `*${missingDays} dager*`;

  // The day count comes from the API's unregisteredDays, which only counts
  // fully empty workdays. At 0 the gap sits in partial days, more likely
  // avspasering than forgotten timeføring, so ask for a confirmation instead
  // (and skip the "fordelt på N dager" clause, which would read "0 dager").
  const message =
    missingDays === 0
      ? `Du mangler fortsatt ${hoursLabel} for *${periodLabel}*. ` +
        `Ser du over og enten bekrefter avspasering eller fører resten? 🙏`
      : `Du mangler fortsatt ${hoursLabel} fordelt på ${daysLabel} for *${periodLabel}*. ` +
        `Husk at avspasering skal markeres i fraværskalender og at ferie- og permisjonsdager også skal timeføres. ` +
        `Ser du over og evt. fører resten? 🙏`;

  const text =
    message.replace(/\*/g, "") + `\n\nÅpne timeføring: ${FLOQ_TIMESTAMP_URL}`;

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
  const startDate = now().subtract(1, "month").startOf("month");
  const endDate = startDate.clone().endOf("month");
  return {
    startDate,
    endDate,
    label: startDate.format("MMMM YYYY"),
    logTag: "First-of-month nag",
  };
}

// employee id → hours of avspasering confirmed within the period. Floq stores
// one balance per week, so a week straddling the period's edge (a month
// starting mid-week) counts by the share of its Mon–Fri inside it.
function confirmedShortfallHours(
  shortfalls: Map<number, Map<string, number>>,
  startDate: moment.Moment,
  endDate: moment.Moment,
): Map<number, number> {
  const byEmployee = new Map<number, number>();
  for (const [employeeId, byWeek] of shortfalls) {
    for (const [weekStart, weekHours] of byWeek) {
      let weekdaysInPeriod = 0;
      for (let i = 0; i < 5; i++) {
        const day = moment(weekStart).add(i, "days");
        if (day.isBetween(startDate, endDate, "day", "[]")) weekdaysInPeriod++;
      }
      const hours = weekHours * (weekdaysInPeriod / 5);
      byEmployee.set(employeeId, (byEmployee.get(employeeId) ?? 0) + hours);
    }
  }
  return byEmployee;
}

function targetEmployeeIds(
  rows: TimeTrackingStatusRow[],
  idByEmail: Map<string, number>,
): number[] {
  return rows.flatMap((r): number[] => {
    const id = idByEmail.get(r.email.toLowerCase());
    return id === undefined ? [] : [id];
  });
}

async function fetchConfirmedShortfallHours(
  employeeIds: number[],
  startDate: moment.Moment,
  endDate: moment.Moment,
): Promise<Map<number, number>> {
  const shortfalls = await fetchConfirmedShortfalls(
    employeeIds,
    startDate.clone().startOf("isoWeek").format("YYYY-MM-DD"),
    endDate.format("YYYY-MM-DD"),
  );
  return confirmedShortfallHours(shortfalls, startDate, endDate);
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
    if (r.availableHours <= 0) return false;
    const registered = r.billableHours + r.nonBillableHours;
    return registered < r.availableHours - REPORT_TOLERANCE_HOURS;
  });
  console.info(`${targets.length} still below availableHours`);

  if (TEST_USER_EMAIL) {
    const before = targets.length;
    targets = targets.filter((r) => r.email.toLowerCase() === TEST_USER_EMAIL);
    console.info(
      `TEST_USER_EMAIL=${TEST_USER_EMAIL} — filtered ${before} → ${targets.length} target(s)`,
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
    allEmployees.map((e) => [e.email.toLowerCase(), e.id]),
  );

  const excusedAbsence = excusedAbsenceByEmployee(allAbsences);

  const confirmedByEmployee = await fetchConfirmedShortfallHours(
    targetEmployeeIds(targets, idByEmail),
    period.startDate,
    period.endDate,
  );

  for (const row of targets) {
    const apiMissing =
      row.availableHours - row.billableHours - row.nonBillableHours;

    const employeeId = idByEmail.get(row.email.toLowerCase());
    const excusedDays = employeeId ? excusedAbsence.get(employeeId) : undefined;
    const toleratedByAbsence =
      (excusedDays?.days ?? 0) * STANDARD_WORKDAY_HOURS;

    // If excused days in the absence calendar fully explain the gap (within
    // tolerance), skip.
    if (apiMissing <= toleratedByAbsence + REPORT_TOLERANCE_HOURS) {
      console.info(
        `Skipping ${row.email}: ${formatHours(excusedDays?.days ?? 0)} fraværskalender-dag(er) forklarer gapet på ${formatHours(apiMissing)} t`,
      );
      continue;
    }

    // Subtract the absence-explained portion from both totals shown in the
    // message so the user sees the remaining real gap.
    const missingHours = apiMissing - toleratedByAbsence;
    const missingDays = Math.max(
      0,
      row.unregisteredDays - (excusedDays?.dates.size ?? 0),
    );

    // The user has already owned up to this week as avspasering, so don't nag
    // about it. Bare >= is Floq's own isBalanceConfirmed rule: the
    // confirmation goes stale once the shortfall grows past what was confirmed.
    const confirmed = employeeId
      ? (confirmedByEmployee.get(employeeId) ?? 0)
      : 0;
    if (confirmed >= missingHours) {
      console.info(
        `Skipping ${row.email}: ${formatHours(missingHours)} t dekket av ${formatHours(confirmed)} t bekreftet avspasering`,
      );
      continue;
    }

    const targetUser = pickSlackRecipient(slackUsers, row.email);
    if (!targetUser) {
      console.error(`No Slack user found for ${row.email}`);
      continue;
    }

    const { text, blocks } = buildLateRegisterMessage(
      periodLabel,
      missingHours,
      missingDays,
    );

    console.info(
      `Nudging @${targetUser.name} (${row.email}) — still missing ${formatHours(missingHours)} t, ${missingDays} empty day(s) (after ${formatHours(excusedDays?.days ?? 0)} absence-cal day(s) tolerance)`,
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

// === Admin: aggregert oversikt over manglende timeføring ===
//
// A single table posted to the bemanning/salg channel listing who still has a
// *real* shortfall for the period — i.e. after subtracting excused days in the
// absence calendar, so people on ferie don't clutter the list. Rides along with
// the Monday/Tuesday/first-of-month triggers as an admin's-eye companion to the
// personal DMs.
//
// Honours confirmed avspasering on the same terms as the personal nudge.

type MissingTimeRow = {
  name: string;
  lastDate: string | null;
  missingHours: number;
};

function buildAdminMissingMessage(
  periodLabel: string,
  rows: MissingTimeRow[],
): { text: string; blocks: Array<Record<string, unknown>> } {
  if (rows.length === 0) {
    const line = `Alle har ført timene sine for *${periodLabel}* 🎉`;
    return {
      text: line.replace(/\*/g, ""),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: line } }],
    };
  }

  const fmtDate = (d: string | null) =>
    d ? moment(d).format("D. MMM YYYY") : "aldri";

  const totalMissing = rows.reduce((s, r) => s + r.missingHours, 0);
  const introLine = `*Manglende timeføring for ${periodLabel}*`;
  const summaryLine = `*${rows.length}* ${rows.length === 1 ? "person mangler" : "personer mangler"} timeføring (totalt ${formatHoursShort(totalMissing)} t).`;

  const textLines = [
    introLine.replace(/\*/g, ""),
    "",
    summaryLine.replace(/\*/g, ""),
    "",
    ...rows.map(
      (r) =>
        `${r.name} — sist ført ${fmtDate(r.lastDate)} — mangler ${formatHours(r.missingHours)} t`,
    ),
  ];
  const text = textLines.join("\n");

  const headerRow = [
    headerCell("Ansatt"),
    headerCell("Sist ført dato"),
    headerCell("Manglende timeføring"),
  ];
  const dataRows = rows.map((r) => [
    textCell(r.name),
    textCell(fmtDate(r.lastDate)),
    textCell(`${formatHours(r.missingHours)} t`),
  ]);

  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: introLine } },
    { type: "section", text: { type: "mrkdwn", text: summaryLine } },
    {
      type: "table",
      column_settings: [
        { align: "left" }, // Ansatt
        { align: "left" }, // Sist ført dato
        { align: "right" }, // Manglende timeføring
      ],
      rows: [headerRow, ...dataRows],
    },
  ];

  return { text, blocks };
}

const notifyAdminMissingTime = async (period: ShortfallPeriod) => {
  const { startDate, endDate, label: periodLabel, logTag } = period;
  const startStr = startDate.format("YYYY-MM-DD");
  const endStr = endDate.format("YYYY-MM-DD");

  console.info(
    `Admin missing-time overview (${logTag}) for ${startStr} → ${endStr}`,
  );

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

  // Only those who owed time this period (registered < available).
  const candidates = rows.filter((r) => {
    if (r.availableHours <= 0) return false;
    const registered = r.billableHours + r.nonBillableHours;
    return registered < r.availableHours - REPORT_TOLERANCE_HOURS;
  });

  // Excused days in the absence calendar explain part of a gap.
  const [allAbsences, allEmployees] = await Promise.all([
    fetchAllAbsencesForWeek(startStr, endStr),
    fetchAllEmployees(),
  ]);
  const idByEmail = new Map(
    allEmployees.map((e) => [e.email.toLowerCase(), e.id]),
  );
  const confirmedByEmployee = await fetchConfirmedShortfallHours(
    targetEmployeeIds(candidates, idByEmail),
    period.startDate,
    period.endDate,
  );
  const excusedAbsence = excusedAbsenceByEmployee(allAbsences);

  const missingRows: MissingTimeRow[] = [];
  for (const row of candidates) {
    const apiMissing =
      row.availableHours - row.billableHours - row.nonBillableHours;
    const employeeId = idByEmail.get(row.email.toLowerCase());
    const excusedDays = employeeId
      ? (excusedAbsence.get(employeeId)?.days ?? 0)
      : 0;
    const realMissing = apiMissing - excusedDays * STANDARD_WORKDAY_HOURS;
    if (realMissing <= REPORT_TOLERANCE_HOURS) continue; // explained by absence

    // Same rule as the personal nudge, so the two lists agree: bare >= is
    // Floq's own isBalanceConfirmed, and the confirmation goes stale once the
    // shortfall grows past what was confirmed.
    const confirmed = employeeId
      ? (confirmedByEmployee.get(employeeId) ?? 0)
      : 0;
    if (confirmed >= realMissing) {
      console.info(
        `Skipping ${row.email}: ${formatHours(realMissing)} t dekket av ${formatHours(confirmed)} t bekreftet avspasering`,
      );
      continue;
    }

    missingRows.push({
      name: row.name,
      lastDate: row.lastDate,
      missingHours: realMissing,
    });
  }

  // Biggest gaps first; ties by name.
  missingRows.sort(
    (a, b) =>
      b.missingHours - a.missingHours || a.name.localeCompare(b.name, "nb"),
  );

  const { text, blocks } = buildAdminMissingMessage(periodLabel, missingRows);

  console.info(
    `Admin missing-time: ${missingRows.length} with a real shortfall for ${periodLabel}`,
  );

  if (DRY_RUN) {
    console.info("DRY_RUN — admin missing-time preview:\n" + text);
    return;
  }

  try {
    await slack.chat.postMessage({
      channel: `#${CAPACITY_CHANNEL}`,
      text,
      blocks: blocks as any,
      as_user: true,
    });
    console.info(`Sent admin missing-time overview to #${CAPACITY_CHANNEL}`);
  } catch (err) {
    console.error(`Failed to post to #${CAPACITY_CHANNEL}:`, err);
  }
};

// === First-of-month: monthly recap ===

type ProjectCategory = "billable" | "non_billable" | "absence";
type ProjectHours = {
  name: string;
  hours: number;
  category: ProjectCategory;
};

function aggregateProjectHours(rows: ProjectHoursPerDayRow[]): ProjectHours[] {
  // Collapse across dates per project. Categories drive how rows are grouped
  // in the table and whether they're counted as "work" or "absence".
  const totals = new Map<string, ProjectHours>();
  for (const r of rows) {
    if (r.hours <= 0) continue;
    const cur = totals.get(r.projectId);
    if (cur) {
      cur.hours += r.hours;
      continue;
    }
    const category: ProjectCategory =
      r.status === "unavailable"
        ? "absence"
        : r.status === "billable"
          ? "billable"
          : "non_billable";
    totals.set(r.projectId, { name: r.projectName, hours: r.hours, category });
  }
  const result = Array.from(totals.values());
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
  availableHours: number,
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
    column_settings: [{ align: "left", is_wrapped: true }, { align: "right" }],
    rows,
  };
}

// "4., 5. og 12. august" — all dates are assumed to be in the same month.
function formatDatesInMonth(dates: string[]): string {
  const days = dates.map((d) => moment(d).format("D."));
  const joined =
    days.length === 1
      ? days[0]
      : `${days.slice(0, -1).join(", ")} og ${days[days.length - 1]}`;
  return `${joined} ${moment(dates[0]).format("MMMM")}`;
}

function buildMonthlyRecapMessage(params: {
  monthLabel: string;
  missingHours: number; // 0 if no shortfall
  emptyDates: string[]; // workdays with nothing registered and no excuse
  fgPct: number | null;
  billableHours: number;
  availableHours: number;
  bonusKr: number;
  projects: ProjectHours[];
}): { text: string; blocks: Array<Record<string, unknown>> } {
  const {
    monthLabel,
    missingHours,
    emptyDates,
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

  // Fully empty days are named explicitly: the net total alone can hide them
  // (7,5 t missing on one day minus 1,5 t extra elsewhere read as "6 timer
  // fordelt på 1 dag"). Partial-only gaps are more likely avspasering, so
  // those get the confirm-or-register phrasing used by the weekly nudges.
  let shortfallLine: string | null = null;
  const hasMissingHours = missingHours > REPORT_TOLERANCE_HOURS;
  const hoursLabel = `*${formatHoursShort(missingHours)} time${missingHours === 1 ? "" : "r"}*`;
  if (emptyDates.length > 0) {
    const totalClause = hasMissingHours
      ? ` Totalt for *${monthLabel}* mangler du ${hoursLabel}.`
      : "";
    shortfallLine =
      `Du har ikke ført noen timer på *${formatDatesInMonth(emptyDates)}*.${totalClause} ` +
      `Husk at avspasering skal markeres i fraværskalender og at ferie- og permisjonsdager også skal timeføres. ` +
      `Ser du over og evt. fører resten? 🙏`;
  } else if (hasMissingHours) {
    shortfallLine =
      `Du mangler fortsatt ${hoursLabel} for *${monthLabel}*. ` +
      `Ser du over og enten bekrefter avspasering eller fører resten? 🙏`;
  }

  const statsLines: string[] = [];
  if (fgPct !== null && availableHours > 0) {
    statsLines.push(
      `*Faktureringsgrad:* ${formatHours(fgPct)} %  (${formatHours(billableHours)} av ${formatHours(availableHours)} t)`,
    );
  }
  statsLines.push(
    `*Bonus i ${monthLabel}:* ${bonusKr.toLocaleString("nb-NO")} kr`,
  );

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
          `  Endring i fleksitid: ${formatSignedHours(workTotal - availableHours)}`,
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
  const monthStart = now().subtract(1, "month").startOf("month");
  const monthEnd = monthStart.clone().endOf("month");
  const startStr = monthStart.format("YYYY-MM-DD");
  const endStr = monthEnd.format("YYYY-MM-DD");
  const monthLabel = monthStart.format("MMMM YYYY");
  const month = monthStart.format("YYYY-MM");

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

  let targets = rows.filter((r) => r.availableHours > 0);
  console.info(`${targets.length} employees with availableHours > 0`);

  if (TEST_USER_EMAIL) {
    const before = targets.length;
    targets = targets.filter((r) => r.email.toLowerCase() === TEST_USER_EMAIL);
    console.info(
      `TEST_USER_EMAIL=${TEST_USER_EMAIL} — filtered ${before} → ${targets.length} target(s)`,
    );
  }

  if (targets.length === 0) {
    console.info("Nothing to send for monthly recap.");
    return;
  }

  const [allEmployees, allAbsences, holidays, slackUsersResp] =
    await Promise.all([
      fetchAllEmployees(),
      fetchAllAbsencesForWeek(startStr, endStr),
      fetchHolidays(startStr, endStr),
      slack.users.list(),
    ]);

  const slackUsers = slackUsersResp.members;
  if (!slackUsers) {
    console.error("No slack users in response");
    return;
  }

  const idByEmail = new Map(
    allEmployees.map((e) => [e.email.toLowerCase(), e.id]),
  );

  const excusedAbsence = excusedAbsenceByEmployee(allAbsences);

  // Weeks the employee has confirmed as avspasering, so their empty days
  // aren't named as forgotten.
  const targetIds = targetEmployeeIds(targets, idByEmail);
  const [confirmedShortfalls, hoursByEmployee, fgByEmployee] =
    await Promise.all([
      fetchConfirmedShortfalls(
        targetIds,
        monthStart.clone().startOf("isoWeek").format("YYYY-MM-DD"),
        endStr,
      ),
      fetchHoursByEmployee(targetIds, startStr, endStr),
      fetchAllFGForRange(startStr, endStr),
    ]);
  const confirmedByEmployee = confirmedShortfallHours(
    confirmedShortfalls,
    monthStart,
    monthEnd,
  );

  for (const row of targets) {
    const employeeId = idByEmail.get(row.email.toLowerCase());
    if (!employeeId) {
      console.warn(`No employee_id for ${row.email}, skipping`);
      continue;
    }
    const projectRows = hoursByEmployee.get(employeeId) ?? [];
    // Per-employee fetch wrapped: a single failure skips just this person.
    let bonusKr: number;
    try {
      bonusKr = await fetchMonthlyBonus(employeeId, month);
    } catch (err) {
      console.error(`Skipping ${row.email} — fetch failed:`, err);
      continue;
    }
    const fgRange = fgByEmployee.get(employeeId) ?? {
      billable: 0,
      available: 0,
    };
    const fgPct =
      fgRange.available > 0
        ? (fgRange.billable / fgRange.available) * 100
        : null;

    const projects = aggregateProjectHours(projectRows);

    // Defensive: if FG indicates the employee did register hours but our
    // project query came back empty, something went wrong (404, parse
    // error, etc.). Skip rather than sending a misleading empty table.
    if (
      projects.length === 0 &&
      (fgRange.billable > 0 || fgRange.available > 0)
    ) {
      console.warn(
        `Skipping ${row.email}: empty project breakdown despite FG data (${fgRange.billable}/${fgRange.available} t) — likely a fetch failure.`,
      );
      continue;
    }

    // Shortfall: same logic as Tuesday, with absence-calendar tolerance
    const apiMissing =
      row.availableHours - row.billableHours - row.nonBillableHours;
    const excusedDays = excusedAbsence.get(employeeId);
    const toleratedByAbsence =
      (excusedDays?.days ?? 0) * STANDARD_WORKDAY_HOURS;

    const excusedDates = excusedDays?.dates ?? new Set();
    const confirmedWeeks = new Set(
      confirmedShortfalls.get(employeeId)?.keys() ?? [],
    );
    const emptyDays = buildPerDayBreakdown(
      monthStart,
      monthEnd,
      projectRows,
      holidays,
    ).filter((d) => d.status === "empty" && !excusedDates.has(d.date));
    const emptyDates = emptyDays
      .filter(
        (d) =>
          !confirmedWeeks.has(
            moment(d.date).startOf("isoWeek").format("YYYY-MM-DD"),
          ),
      )
      .map((d) => d.date);

    // Confirmed hours, not confirmed empty days: avspasering taken as shorter
    // days leaves no day empty.
    const realMissing = Math.max(
      0,
      apiMissing -
        toleratedByAbsence -
        (confirmedByEmployee.get(employeeId) ?? 0),
    );

    const targetUser = pickSlackRecipient(slackUsers, row.email);
    if (!targetUser) {
      console.error(`No Slack user found for ${row.email}`);
      continue;
    }

    const { text, blocks } = buildMonthlyRecapMessage({
      monthLabel,
      missingHours: realMissing,
      emptyDates,
      fgPct,
      billableHours: fgRange.billable,
      availableHours: fgRange.available,
      bonusKr,
      projects,
    });

    console.info(
      `Monthly recap → @${targetUser.name} (${row.email}) — FG ${fgPct?.toFixed(1) ?? "n/a"} %, bonus ${bonusKr} kr, ${projects.length} prosjekt(er), missing ${formatHours(realMissing)} t, ${emptyDates.length} empty day(s)`,
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
  if (isAvailabilityCheck) {
    tasks.push(notifyAvailableConsultants());
  }
  if (isInvoicingReminder) {
    tasks.push(notifyInvoicingResponsible());
  }
  if (isAdminMissing) {
    const period =
      adminMissingPeriod === "month"
        ? lastMonthShortfallPeriod()
        : lastWeekShortfallPeriod();
    tasks.push(notifyAdminMissingTime(period));
  }
  if (isTuesday) {
    // Skip Tuesday's weekly nag when today is also the 1st of the month.
    // On those days the 1st-of-month cron sends a month-wide nag which
    // covers the whole month (last week included), so the per-week nag
    // is a strict subset and would just duplicate the message.
    const todayIsFirstOfMonth = now().date() === 1;
    if (todayIsFirstOfMonth) {
      console.info(
        "Skipping Tuesday nag — today is also 1st of month, monthly nag covers it.",
      );
    } else {
      tasks.push(notifyLateRegisterers(lastWeekShortfallPeriod()));
    }
  }
  if (isFirstOfMonth) {
    // Skip the nag if today is *also* the first Monday of the month — the
    // Monday cron will send a monthly recap, which already includes a
    // shortfall paragraph for anyone with missing hours. Without this
    // check, those people would get the same "mangler X t for {måned}"
    // info twice (~once a year, when 1st falls on a Monday).
    const todayIsFirstMonday = now().day() === 1 && now().date() <= 7;
    if (todayIsFirstMonday) {
      console.info(
        "Skipping first-of-month nag — today is also first Monday, monthly recap covers it.",
      );
    } else {
      tasks.push(notifyLateRegisterers(lastMonthShortfallPeriod()));
    }
  }
  if (isMonthlyRecap) {
    // Full digest with FG/bonus/project table. Fires on the first Monday
    // of a new month so all majority-in-month weeks are settled.
    tasks.push(notifyMonthlyRecap());
  }

  if (tasks.length === 0) {
    console.info(
      `Nothing scheduled today (run with IS_MONDAY, IS_TUESDAY, IS_OVERTIME, IS_AVAILABILITY, IS_INVOICING_REMINDER, IS_ADMIN_MISSING, IS_FIRST_OF_MONTH or IS_MONTHLY_RECAP=true to test).`,
    );
    return;
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") console.error("Top-level error:", r.reason);
  }
};

main();
