import moment from "moment";
import { now } from "./config.js";

export type ReportPeriod = {
  startDate: moment.Moment;
  endDate: moment.Moment;
  label: string; // user-facing, e.g. "uke 20 (11.–15. mai)" or "april 2026"
};

// The calendar week (Mon–Sun) before today, labelled by its work week.
export function lastWeekPeriod(): ReportPeriod {
  const startDate = now().subtract(1, "week").startOf("isoWeek");
  const endDate = startDate.clone().endOf("isoWeek");
  const friday = startDate.clone().add(4, "days");
  const first =
    startDate.month() === friday.month()
      ? startDate.format("D.")
      : startDate.format("D. MMMM");
  return {
    startDate,
    endDate,
    label: `uke ${startDate.isoWeek()} (${first}–${friday.format("D. MMMM")})`,
  };
}

export function lastMonthPeriod(): ReportPeriod {
  const startDate = now().subtract(1, "month").startOf("month");
  return {
    startDate,
    endDate: startDate.clone().endOf("month"),
    label: startDate.format("MMMM YYYY"),
  };
}
