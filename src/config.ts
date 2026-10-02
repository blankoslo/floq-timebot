import moment from "moment";

export const platformUri =
  process.env.PLATFORM_URI || "https://api-test.platform.floq.no";
export const floqAuthBaseUrl =
  process.env.FLOQ_AUTH_BASE_URL || "https://test.floq.no";
export const floqServiceTokenAudience =
  process.env.FLOQ_SERVICE_TOKEN_AUDIENCE || floqAuthBaseUrl;
export const DRY_RUN = process.env.DRY_RUN === "true";
export const FLOQ_TIMESTAMP_URL =
  process.env.FLOQ_TIMESTAMP_URL || "https://inni.blank.no/timestamp/";
export const FLOQ_INVOICE_URL =
  process.env.FLOQ_INVOICE_URL || "https://inni.blank.no/invoice";
// When set, only this employee's data is processed (filters the target
// list) — useful for previewing how a real Slack render looks without
// spamming everyone.
const TEST_USER_EMAIL = process.env.TEST_USER_EMAIL?.toLowerCase().trim();
// When set, all Slack DMs are routed to this address instead of the
// employee's own. Lets you impersonate someone (combined with
// TEST_USER_EMAIL) to see their exact message rendered in your own DM.
export const TEST_USER_SLACK_EMAIL =
  process.env.TEST_USER_SLACK_EMAIL?.toLowerCase().trim();
// Ignore small deltas so a 7 t vs 7,5 t day doesn't trigger a notification.
export const REPORT_TOLERANCE_HOURS = 0.5;

// Channel that receives the "free capacity next N weeks" overview. Posted by
// name (chat.postMessage accepts "#name") — the bot just needs to be a member.
export const CAPACITY_CHANNEL =
  process.env.CAPACITY_CHANNEL || "admin-bemanningogsalg-diskusjon";
// How many ISO weeks ahead (including the current week) the overview covers.
export const CAPACITY_WEEKS_AHEAD = Number(
  process.env.CAPACITY_WEEKS_AHEAD || "6",
);

moment.locale("nb");

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
export const now = (): moment.Moment =>
  MOCK_TODAY ? moment(MOCK_TODAY, "YYYY-MM-DD", true) : moment();
export function onlyTestUser<T>(
  items: T[],
  emailOf: (item: T) => string | undefined,
): T[] {
  if (!TEST_USER_EMAIL) return items;
  const kept = items.filter(
    (i) => emailOf(i)?.toLowerCase() === TEST_USER_EMAIL,
  );
  console.info(
    `TEST_USER_EMAIL=${TEST_USER_EMAIL} — filtered ${items.length} → ${kept.length} target(s)`,
  );
  return kept;
}
