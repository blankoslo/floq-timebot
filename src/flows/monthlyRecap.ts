import { FLOQ_TIMESTAMP_URL } from "../config.js";
import { ProjectHoursPerDayRow } from "../types.js";
import {
  SlackMessage,
  fetchSlackUsers,
  headerCell,
  sendDm,
  textCell,
  timestampButton,
} from "../slack.js";
import { fetchAllFGForRange, fetchMonthlyBonus } from "../api.js";
import { lastMonthPeriod } from "../periods.js";
import { formatHours, formatSignedHours } from "../format.js";
import {
  Shortfall,
  hasShortfall,
  loadPeriodTargets,
  shortfallSentence,
} from "../shortfall.js";

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

function buildMonthlyRecapMessage(params: {
  monthLabel: string;
  shortfall: Shortfall;
  fgPct: number | null;
  billableHours: number;
  availableHours: number;
  bonusKr: number;
  projects: ProjectHours[];
}): SlackMessage {
  const {
    monthLabel,
    shortfall,
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

  const shortfallLine = hasShortfall(shortfall)
    ? shortfallSentence(shortfall, monthLabel)
    : null;

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
  blocks.push(timestampButton());
  blocks.push(buildProjectTableBlock(projects, availableHours));

  return { text, blocks };
}

export const notifyMonthlyRecap = async () => {
  const period = lastMonthPeriod();
  const startStr = period.startDate.format("YYYY-MM-DD");
  const endStr = period.endDate.format("YYYY-MM-DD");
  const month = period.startDate.format("YYYY-MM");
  console.info(`Monthly recap for ${period.label}`);

  const targets = await loadPeriodTargets(period, { testUserOnly: true });
  if (targets.length === 0) return;
  const [fgByEmployee, slackUsers] = await Promise.all([
    fetchAllFGForRange(startStr, endStr),
    fetchSlackUsers(),
  ]);
  if (!slackUsers) return;

  for (const { status, employee, rows, shortfall } of targets) {
    // Per-employee fetch wrapped: a single failure skips just this person.
    let bonusKr: number;
    try {
      bonusKr = await fetchMonthlyBonus(employee.id, month);
    } catch (err) {
      console.error(`Skipping ${status.email} — fetch failed:`, err);
      continue;
    }
    const fgRange = fgByEmployee.get(employee.id) ?? {
      billable: 0,
      available: 0,
    };
    const fgPct =
      fgRange.available > 0
        ? (fgRange.billable / fgRange.available) * 100
        : null;

    const projects = aggregateProjectHours(rows);

    // Defensive: if FG indicates the employee did register hours but our
    // project query came back empty, something went wrong (404, parse
    // error, etc.). Skip rather than sending a misleading empty table.
    if (
      projects.length === 0 &&
      (fgRange.billable > 0 || fgRange.available > 0)
    ) {
      console.warn(
        `Skipping ${status.email}: empty project breakdown despite FG data (${fgRange.billable}/${fgRange.available} t) — likely a fetch failure.`,
      );
      continue;
    }

    console.info(
      `Monthly recap → ${status.email} — FG ${fgPct?.toFixed(1) ?? "n/a"} %, bonus ${bonusKr} kr, ${projects.length} prosjekt(er), missing ${formatHours(shortfall.missingHours)} t, ${shortfall.emptyDates.length} empty day(s)`,
    );
    await sendDm(
      slackUsers,
      status.email,
      buildMonthlyRecapMessage({
        monthLabel: period.label,
        shortfall,
        fgPct,
        billableHours: fgRange.billable,
        availableHours: fgRange.available,
        bonusKr,
        projects,
      }),
    );
  }
};
