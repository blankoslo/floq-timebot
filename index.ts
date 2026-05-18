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
// When set, only this employee's email will receive a message — useful for
// previewing how a real Slack render looks without spamming everyone.
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL?.toLowerCase().trim();
// Ignore tiny deltas so a 7,45h vs 7,5h day doesn't trigger a notification.
const REPORT_TOLERANCE_HOURS = 0.25;

moment.locale("nb");

// Project codes that represent absence, not work. Mirrors
// floq-timetracker-v2/src/constants/codes.ts.
const ABSENCE_LABEL: Record<string, string> = {
  FER1000: "Ferie",
  SYK1000: "Egenmelding",
  SYK1001: "Sykmelding",
  SYK1002: "Sykt barn",
  AVS: "Avspasering",
  PER1000: "Permisjon m/lønn",
  PER1001: "Permisjon u/lønn",
  PER1002: "Foreldrepermisjon",
};

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
type TimeEntryRow = {
  id: number;
  project: string;
  minutes: number;
  date: string;
};
type HolidayRow = { date: string; name: string };
type ProjectRow = { id: string; name: string };

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

// === Date helpers ===
const isFirstOfMonth =
  process.env.IS_FIRST_OF_MONTH === "true" || moment().date() === 1;
const isMonday = process.env.IS_MONDAY === "true" || moment().day() === 1;

const getStartAndEndDate = () => {
  let startDate: moment.Moment;
  let endDate: moment.Moment;

  if (isFirstOfMonth && !isMonday) {
    // First-of-month run that isn't a Monday: cover the current partial week
    startDate = moment().startOf("isoWeek");
    endDate = moment().subtract(1, "day");
  } else {
    // Standard Monday run: cover all of last week
    startDate = moment().subtract(1, "week").startOf("isoWeek");
    endDate = moment().subtract(1, "week").endOf("isoWeek");
  }
  return { startDate, endDate };
};

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
  try {
    const rows = await apiGet<EmployeeRow[]>(
      `/employees?select=id&email=eq.${encodeURIComponent(email)}`
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error(`Failed to look up employee id for ${email}:`, err);
    return null;
  }
}

async function fetchTimeEntries(
  employeeId: number,
  startDate: string,
  endDate: string
): Promise<TimeEntryRow[]> {
  try {
    return await apiGet<TimeEntryRow[]>(
      `/time_entry?select=id,project,minutes,date&employee=eq.${employeeId}&date=gte.${startDate}&date=lte.${endDate}`
    );
  } catch (err) {
    console.error(
      `Failed to fetch time entries for employee ${employeeId}:`,
      err
    );
    return [];
  }
}

async function fetchHolidays(
  startDate: string,
  endDate: string
): Promise<HolidayRow[]> {
  try {
    return await apiGet<HolidayRow[]>(
      `/holidays?date=gte.${startDate}&date=lte.${endDate}`
    );
  } catch (err) {
    console.error("Failed to fetch holidays:", err);
    return [];
  }
}

async function fetchProjectNameMap(): Promise<Map<string, string>> {
  try {
    const projects = await apiGet<ProjectRow[]>(
      "/projects?select=id,name"
    );
    return new Map(projects.map((p) => [p.id, p.name]));
  } catch (err) {
    console.error("Failed to fetch projects:", err);
    return new Map();
  }
}

// === Per-day breakdown ===

// Standard work day length. Part-timers may see slight noise here; we'll fix
// that when we surface stillingsprosent properly.
const STANDARD_WORKDAY_HOURS = 7.5;

function buildPerDayBreakdown(
  startDate: moment.Moment,
  endDate: moment.Moment,
  entries: TimeEntryRow[],
  holidays: HolidayRow[],
  projectNames: Map<string, string>
): DayBreakdown[] {
  // Aggregate per date: we treat absence entries and work entries as both
  // counting toward "registered time" so e.g. a 6 t Permisjon u/lønn day
  // surfaces as a 🟡 partial (since 6 < 7,5) rather than being hidden as
  // ⚪ Permisjon (which would mask a missing 1,5 t).
  type DayAgg = {
    totalMinutes: number;
    workMinutes: number;
    absenceMinutes: number;
    projectCodes: string[]; // ordered, deduped
  };
  const byDate = new Map<string, DayAgg>();
  for (const e of entries) {
    let cur = byDate.get(e.date);
    if (!cur) {
      cur = {
        totalMinutes: 0,
        workMinutes: 0,
        absenceMinutes: 0,
        projectCodes: [],
      };
      byDate.set(e.date, cur);
    }
    cur.totalMinutes += e.minutes;
    if (e.project in ABSENCE_LABEL) {
      cur.absenceMinutes += e.minutes;
    } else {
      cur.workMinutes += e.minutes;
    }
    // Ignore entries with 0 minutes (UI markers without an actual entry —
    // these are what cause "Ferie shown but not registered" cases).
    if (e.minutes > 0 && !cur.projectCodes.includes(e.project)) {
      cur.projectCodes.push(e.project);
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
    const totalHours = (agg?.totalMinutes ?? 0) / 60;
    const workHours = (agg?.workMinutes ?? 0) / 60;
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
      ? agg.projectCodes.map(
          (code) => ABSENCE_LABEL[code] ?? projectNames.get(code) ?? code
        )
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
    return [
      textCell(dayDateLabel),
      textCell(""), // no Timer for holidays
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
    return `${day.holidayName ?? "Helligdag"} 🗓️`;
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
  const { startDate, endDate } = getStartAndEndDate();
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
  const [holidays, projectNames, slackUsersResp] = await Promise.all([
    fetchHolidays(startStr, endStr),
    fetchProjectNameMap(),
    slack.users.list(),
  ]);

  const slackUsers = slackUsersResp.members;
  if (!slackUsers) {
    console.error("No slack users in response:", slackUsersResp);
    return;
  }

  for (const row of targets) {
    const employeeId = await fetchEmployeeIdByEmail(row.email);
    if (!employeeId) {
      console.warn(`No employee_id for ${row.email}, skipping`);
      continue;
    }
    const entries = await fetchTimeEntries(employeeId, startStr, endStr);
    const days = buildPerDayBreakdown(
      startDate,
      endDate,
      entries,
      holidays,
      projectNames
    );

    // Headline totals are computed from the per-day breakdown so the number
    // and the table are internally consistent. Absence days are included in
    // "actual" since e.g. a fully-registered Sykmelding day shouldn't make
    // the user look short.
    const shownWorkdays = days.filter(
      (d) =>
        d.status === "complete" ||
        d.status === "partial" ||
        d.status === "empty" ||
        d.status === "absence"
    );
    const totalActual = shownWorkdays.reduce((s, d) => s + d.hoursActual, 0);
    const totalExpected = shownWorkdays.reduce(
      (s, d) => s + d.hoursExpected,
      0
    );

    // Issues-variant only when there's an actual shortfall worth flagging.
    // A 🟡 partial day on its own doesn't qualify if the week's total is
    // already over target (someone may have logged 7 t Fri because they
    // left early after working 8 t Mon–Wed — they're fine).
    const hasEmpty = days.some((d) => d.status === "empty");
    const missing = Math.max(0, totalExpected - totalActual);
    const hasIssues = hasEmpty || missing > REPORT_TOLERANCE_HOURS;

    const targetUser = slackUsers.find((u) => u.profile?.email === row.email);
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

  let channels;
  try {
    const resp = await slack.conversations.list({ types: "public_channel" });
    channels = resp.channels;
  } catch (err) {
    console.error("conversations.list failed:", err);
    return;
  }
  if (!channels) {
    console.error("No channels in response");
    return;
  }

  const channel = channels.find((c) => c.name === channelName);
  if (!channel) {
    console.error(`No channel named #${channelName}`);
    return;
  }

  const message =
    "Det ser ut som noen har ført overtid som ikke er utbetalt 💰\n\n" +
    "Overtid: https://inni.blank.no/overtime";

  console.info(`Overtime entries: ${entries.length}`);
  console.info(message);

  if (DRY_RUN) {
    console.info("DRY_RUN — not posting overtime notification");
    return;
  }

  try {
    await slack.chat.postMessage({
      channel: channel.id!,
      text: message,
      as_user: true,
    });
    console.info(`Sent to #${channelName}`);
  } catch (err) {
    console.error(`Failed to post to #${channelName}:`, err);
  }
};

const main = async () => {
  const results = await Promise.allSettled([
    notifySlackers(),
    notifyAdminAboutOvertime(),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.error("Top-level error:", r.reason);
  }
};

main();
