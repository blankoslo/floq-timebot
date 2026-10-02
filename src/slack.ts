import { WebClient } from "@slack/web-api";
import {
  DRY_RUN,
  FLOQ_TIMESTAMP_URL,
  TEST_USER_SLACK_EMAIL,
} from "./config.js";

const slack = new WebClient(process.env.SLACK_API_TOKEN || "");
type SlackUser = {
  id?: string;
  name?: string;
  profile?: { email?: string };
};
export type SlackMessage = {
  text: string;
  blocks?: Array<Record<string, unknown>>;
};

// Pick which Slack user to DM. Honors TEST_USER_SLACK_EMAIL override so we
// can impersonate someone else's data while having the message land in our
// own inbox.
function pickSlackRecipient(
  slackUsers: SlackUser[],
  originalEmail: string,
): SlackUser | undefined {
  const targetEmail = (TEST_USER_SLACK_EMAIL ?? originalEmail).toLowerCase();
  return slackUsers.find(
    (u) => u.profile?.email?.toLowerCase() === targetEmail,
  );
}

export async function fetchSlackUsers(): Promise<SlackUser[] | null> {
  const resp = await slack.users.list();
  if (!resp.members) {
    console.error("No slack users in response:", resp);
    return null;
  }
  return resp.members;
}

// `channel` is a user id or "#name". Posting by channel name needs no
// channel listing, which would have needed groups:read for private channels;
// the bot just has to be a member.
export async function postMessage(
  channel: string,
  recipient: string,
  { text, blocks }: SlackMessage,
): Promise<void> {
  if (DRY_RUN) {
    console.info(`DRY_RUN — preview for ${recipient}:\n${text}`);
    return;
  }
  try {
    await slack.chat.postMessage({
      channel,
      text,
      // Slack's KnownBlock union is overly restrictive for our plain objects.
      blocks: blocks as any,
      as_user: true,
    });
    console.info(`Sent to ${recipient}`);
  } catch (err) {
    console.error(`Failed to send to ${recipient}:`, err);
  }
}

export async function sendDm(
  slackUsers: SlackUser[],
  email: string,
  message: SlackMessage,
): Promise<void> {
  const user = pickSlackRecipient(slackUsers, email);
  if (!user) {
    console.error(`No Slack user found for ${email}`);
    return;
  }
  await postMessage(user.id!, `@${user.name} (${email})`, message);
}

export function linkButton(text: string, url: string): Record<string, unknown> {
  return {
    type: "actions",
    elements: [{ type: "button", text: { type: "plain_text", text }, url }],
  };
}

// Header / footer cells get bold text; data cells use plain raw_text.
export function headerCell(text: string): Record<string, unknown> {
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

export function textCell(text: string): Record<string, unknown> {
  // Slack rejects raw_text cells with empty text ("must be more than 0
  // characters"). Use a non-breaking space as a visually-empty placeholder
  // so the table layout stays intact for holiday/absence/totalt rows.
  return { type: "raw_text", text: text.length > 0 ? text : " " };
}
export const timestampButton = () =>
  linkButton("Åpne timeføring i Floq", FLOQ_TIMESTAMP_URL);
