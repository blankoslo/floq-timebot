import moment from "moment";
import { CAPACITY_CHANNEL, REPORT_TOLERANCE_HOURS } from "../config.js";
import { SlackMessage, headerCell, postMessage, textCell } from "../slack.js";
import { ReportPeriod } from "../periods.js";
import { formatHours, formatHoursShort } from "../format.js";
import { loadPeriodTargets } from "../shortfall.js";

// A single table posted to the bemanning/salg channel listing who still has a
// shortfall for the period, after confirmed avspasering, on the same terms as
// the personal nudge. Rides along with the Monday/Tuesday/first-of-month
// triggers as an admin's-eye companion to the personal DMs.

type MissingTimeRow = {
  name: string;
  lastDate: string | null;
  missingHours: number;
};

function buildAdminMissingMessage(
  periodLabel: string,
  rows: MissingTimeRow[],
): SlackMessage {
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

export const notifyAdminMissingTime = async (period: ReportPeriod) => {
  console.info(`Admin missing-time overview for ${period.label}`);

  const targets = await loadPeriodTargets(period, { testUserOnly: false });
  const missingRows: MissingTimeRow[] = targets
    .filter((t) => t.shortfall.missingHours > REPORT_TOLERANCE_HOURS)
    .map((t) => ({
      name: t.status.name,
      lastDate: t.status.lastDate,
      missingHours: t.shortfall.missingHours,
    }))
    // Biggest gaps first; ties by name.
    .sort(
      (a, b) =>
        b.missingHours - a.missingHours || a.name.localeCompare(b.name, "nb"),
    );

  console.info(
    `Admin missing-time: ${missingRows.length} with a real shortfall for ${period.label}`,
  );
  await postMessage(
    `#${CAPACITY_CHANNEL}`,
    `#${CAPACITY_CHANNEL}`,
    buildAdminMissingMessage(period.label, missingRows),
  );
};
