import moment from "moment";
import { FLOQ_TIMESTAMP_URL } from "../config.js";
import { DayBreakdown } from "../types.js";
import {
  SlackMessage,
  fetchSlackUsers,
  headerCell,
  sendDm,
  textCell,
  timestampButton,
} from "../slack.js";
import { lastWeekPeriod } from "../periods.js";
import { formatHours, formatHoursShort } from "../format.js";
import {
  hasShortfall,
  loadPeriodTargets,
  shortfallSentence,
} from "../shortfall.js";

const FULL_WEEK_HOURS = 37.5;

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

function statusIcon(day: DayBreakdown, hidden: Set<string>): string {
  if (hidden.has(day.date)) return "";
  // Per design: only flag days that warrant attention. Complete days and
  // absence days don't need a visual marker — the row already conveys it.
  switch (day.status) {
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

function buildTableRow(
  day: DayBreakdown,
  hidden: Set<string>,
): Record<string, unknown>[] {
  const m = moment(day.date);
  const dayDateLabel = `${DAY_NAMES_NB[m.day()]} ${m.format("D. MMMM")}`;
  const icon = statusIcon(day, hidden);
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
  hidden: Set<string>,
): Record<string, unknown> {
  const headerRow = [
    headerCell("Dag"),
    headerCell("Timer"),
    headerCell("Prosjekt"),
    headerCell("Status"),
  ];
  const dataRows = days.map((d) => buildTableRow(d, hidden));
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

function formatPerDayLine(day: DayBreakdown, hidden: Set<string>): string {
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
    return `${hoursStr} t ${statusIcon(day, hidden)}`.trimEnd();
  }

  // complete or partial — show hours and project(s)
  const projectStr =
    day.projects.length > 0
      ? day.projects.slice(0, 3).join(" + ") +
        (day.projects.length > 3 ? " m.fl." : "")
      : "-";
  const base = `${hoursStr} t (${projectStr})`;
  const icon = statusIcon(day, hidden);
  return icon ? `${base} ${icon}` : base;
}

function buildSlackMessage(
  periodLabel: string,
  days: DayBreakdown[],
  totalActual: number,
  totalExpected: number,
  shortfallLine: string | null,
  hidden: Set<string>,
): SlackMessage {
  const perDayLines = days.map((d) => formatPerDayLine(d, hidden)).join("\n");

  const baseIntro = `Her er en oversikt over timene dine for *${periodLabel}*.`;
  const introLine = shortfallLine ? `${baseIntro} ${shortfallLine}` : baseIntro;

  // Plain-text fallback (no markdown asterisks)
  const textLines = [
    introLine.replace(/\*/g, ""),
    "",
    perDayLines,
    "",
    `Åpne timeføring: ${FLOQ_TIMESTAMP_URL}`,
  ];
  const text = textLines.join("\n");

  // Slack moves the table to the bottom of the message as an attachment
  // regardless of where it sits in the blocks array — so order here is
  // for the API, not for visual flow.
  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: introLine } },
    timestampButton(),
    buildTableBlock(days, totalActual, totalExpected, hidden),
  ];

  return { text, blocks };
}

// Everyone expected to work last week gets the overview, including those who
// are fully registered. `withShortfall` is off when the monthly recap goes
// out the same day, which reports the shortfall at month scope.
export const notifySlackers = async ({
  withShortfall,
}: {
  withShortfall: boolean;
}) => {
  const period = lastWeekPeriod();
  console.info(`Weekly digest for ${period.label}`);

  const targets = await loadPeriodTargets(period, { testUserOnly: true });
  if (targets.length === 0) return;
  const slackUsers = await fetchSlackUsers();
  if (!slackUsers) return;

  for (const { status, days, shortfall } of targets) {
    // Absence and holiday days have hoursExpected = 0, so they only count
    // toward the "actual" side.
    const totalActual = days.reduce((s, d) => s + d.hoursActual, 0);
    const totalExpected = days.reduce((s, d) => s + d.hoursExpected, 0);
    const confirmedCoversGap =
      shortfall.confirmedHours > 0 && !hasShortfall(shortfall);
    // ⛔️ marks exactly the days the shortfall sentence names, so the table
    // and the text can't disagree.
    const flaggedEmpty = new Set(shortfall.emptyDates);
    const hidePartial = confirmedCoversGap || totalActual >= FULL_WEEK_HOURS;
    const hidden = new Set(
      days
        .filter((d) =>
          d.status === "empty" ? !flaggedEmpty.has(d.date) : hidePartial,
        )
        .map((d) => d.date),
    );
    const shortfallLine =
      withShortfall && hasShortfall(shortfall)
        ? shortfallSentence(shortfall, period.label)
        : null;

    console.info(
      `Weekly digest → ${status.email} [${shortfallLine ? "issues" : "brief"}] — ${formatHours(totalActual)}/${formatHours(totalExpected)} t, missing ${formatHours(shortfall.missingHours)} t, ${shortfall.emptyDates.length} empty day(s)${confirmedCoversGap ? `, ${formatHours(shortfall.confirmedHours)} t bekreftet avspasering` : ""}`,
    );
    await sendDm(
      slackUsers,
      status.email,
      buildSlackMessage(
        period.label,
        days,
        totalActual,
        totalExpected,
        shortfallLine,
        hidden,
      ),
    );
  }
};
