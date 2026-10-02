import moment from "moment";
import { FLOQ_INVOICE_URL, now, onlyTestUser } from "../config.js";
import { InvoiceProjectRow } from "../types.js";
import { SlackMessage, fetchSlackUsers, linkButton, sendDm } from "../slack.js";
import {
  fetchActiveBillableProjectsWithResponsible,
  fetchAllEmployees,
  fetchHolidays,
} from "../api.js";

// DM every project's oppdragsansvarlig (projects.responsible) to invoice the
// just-finished month. Send-day: the first day of the following month if it's a
// virkedag, else rolled forward to the next virkedag (past weekends and
// holidays). The reminder always covers the month before the send-day.

// Bypasses the send-day gate for testing (previous month).
const invoicingReminderForce = process.env.INVOICING_REMINDER_FORCE === "true";

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
): SlackMessage {
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
    linkButton("Åpne fakturering i Floq", FLOQ_INVOICE_URL),
  ];

  return { text, blocks };
}

export const notifyInvoicingResponsible = async () => {
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

  const [projects, allEmployees, slackUsers] = await Promise.all([
    fetchActiveBillableProjectsWithResponsible(),
    fetchAllEmployees(),
    fetchSlackUsers(),
  ]);
  if (!slackUsers) return;

  const emailById = new Map(allEmployees.map((e) => [e.id, e.email]));
  const targets = onlyTestUser(projects, (p) => emailById.get(p.responsible));

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
    ownedProjects.sort((a, b) => a.name.localeCompare(b.name, "nb"));
    console.info(
      `Invoicing reminder → ${email} — ${ownedProjects.length} prosjekt(er)`,
    );
    await sendDm(
      slackUsers,
      email,
      buildInvoicingReminderMessage(monthLabel, ownedProjects),
    );
  }
};
