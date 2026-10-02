import { FLOQ_TIMESTAMP_URL } from "../config.js";
import {
  SlackMessage,
  fetchSlackUsers,
  sendDm,
  timestampButton,
} from "../slack.js";
import { ReportPeriod } from "../periods.js";
import { formatHours } from "../format.js";
import {
  Shortfall,
  hasShortfall,
  loadPeriodTargets,
  shortfallSentence,
} from "../shortfall.js";

function buildLateRegisterMessage(
  periodLabel: string,
  shortfall: Shortfall,
): SlackMessage {
  const message = shortfallSentence(shortfall, periodLabel);
  return {
    text:
      message.replace(/\*/g, "") + `\n\nÅpne timeføring: ${FLOQ_TIMESTAMP_URL}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: message } },
      timestampButton(),
    ],
  };
}

export const notifyLateRegisterers = async (period: ReportPeriod) => {
  console.info(`Shortfall nudge for ${period.label}`);

  const targets = (
    await loadPeriodTargets(period, { testUserOnly: true })
  ).filter((t) => hasShortfall(t.shortfall));
  console.info(`${targets.length} still with a shortfall`);
  if (targets.length === 0) return;
  const slackUsers = await fetchSlackUsers();
  if (!slackUsers) return;

  for (const { status, shortfall } of targets) {
    console.info(
      `Nudging ${status.email} — still missing ${formatHours(shortfall.missingHours)} t, ${shortfall.emptyDates.length} empty day(s)`,
    );
    await sendDm(
      slackUsers,
      status.email,
      buildLateRegisterMessage(period.label, shortfall),
    );
  }
};
