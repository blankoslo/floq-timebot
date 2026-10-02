import { now } from "./config.js";
import { lastMonthPeriod, lastWeekPeriod } from "./periods.js";
import { notifySlackers } from "./flows/weeklyDigest.js";
import { notifyAdminAboutOvertime } from "./flows/overtime.js";
import { notifyInvoicingResponsible } from "./flows/invoicing.js";
import { notifyAvailableConsultants } from "./flows/availability.js";
import { notifyLateRegisterers } from "./flows/shortfallNudge.js";
import { notifyAdminMissingTime } from "./flows/adminMissing.js";
import { notifyMonthlyRecap } from "./flows/monthlyRecap.js";

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
const isInvoicingReminder = process.env.IS_INVOICING_REMINDER === "true";
// The monthly recap rides along with the Monday run, but only on the first
// Monday of the month (date 1–7) — by then every "majority-of-days-in-
// previous-month" week has finished, so bonus + FG are stable. No separate
// cron needed. IS_MONTHLY_RECAP=true forces it for local testing.
const isMonthlyRecap =
  process.env.IS_MONTHLY_RECAP === "true" || (isMonday && now().date() <= 7);

const main = async () => {
  const tasks: Promise<unknown>[] = [];
  if (isMonday) {
    tasks.push(notifySlackers({ withShortfall: !isMonthlyRecap }));
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
      adminMissingPeriod === "month" ? lastMonthPeriod() : lastWeekPeriod();
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
      tasks.push(notifyLateRegisterers(lastWeekPeriod()));
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
      tasks.push(notifyLateRegisterers(lastMonthPeriod()));
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
