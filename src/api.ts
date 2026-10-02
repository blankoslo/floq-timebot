import moment from "moment";
import { GoogleAuth } from "google-auth-library";
import {
  floqAuthBaseUrl,
  floqServiceTokenAudience,
  platformUri,
} from "./config.js";
import {
  AbsenceRow,
  BillingDegreePeriodRow,
  EmployeeRow,
  HolidayRow,
  InvoiceProjectRow,
  ProjectHoursPerDayRow,
  TimeTrackingStatusRow,
} from "./types.js";

const FLOQ_API_SCOPE = "role:read_only";
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;

const googleAuth = new GoogleAuth();
let cachedApiToken: { accessToken: string; expiresAt: number } | null = null;

async function apiToken(): Promise<string> {
  if (cachedApiToken && cachedApiToken.expiresAt > Date.now()) {
    return cachedApiToken.accessToken;
  }

  const idTokenClient = await googleAuth.getIdTokenClient(
    floqServiceTokenAudience,
  );
  const idToken = await idTokenClient.idTokenProvider.fetchIdToken(
    floqServiceTokenAudience,
  );

  const res = await fetch(`${floqAuthBaseUrl}/login/oauth/as/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      scope: FLOQ_API_SCOPE,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Floq token exchange failed: ${res.status} ${res.statusText} ${await res.text()}`,
    );
  }
  const { access_token, expires_in } = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedApiToken = {
    accessToken: access_token,
    expiresAt:
      Date.now() + Math.max(expires_in - TOKEN_EXPIRY_BUFFER_SECONDS, 0) * 1000,
  };
  return cachedApiToken.accessToken;
}
async function apiFetch(path: string, body?: unknown): Promise<Response> {
  const method = body === undefined ? "GET" : "POST";
  const res = await fetch(`${platformUri}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await apiToken()}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `${method} ${path} failed: ${res.status} ${res.statusText} ${await res.text()}`,
    );
  }
  return res;
}

export async function apiGet<T>(path: string): Promise<T> {
  return (await apiFetch(path)).json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return (await apiFetch(path, body)).json() as Promise<T>;
}

export async function fetchTimeTrackingStatus(
  startDate: moment.Moment,
  endDate: moment.Moment,
): Promise<TimeTrackingStatusRow[]> {
  return apiGet<TimeTrackingStatusRow[]>(
    `/reports/time-tracking-status?from=${startDate.format("YYYY-MM-DD")}&to=${endDate.format("YYYY-MM-DD")}`,
  );
}

// Bulk fetchers below intentionally do NOT catch — a failed shared fetch
// must abort the whole run (the error propagates to main's allSettled and
// no messages go out) rather than silently degrade every message.

export async function fetchHolidays(
  startDate: string,
  endDate: string,
): Promise<HolidayRow[]> {
  // The platform only serves the whole table.
  const holidays = await apiGet<HolidayRow[]>("/timesheet/holidays");
  return holidays.filter((h) => h.date >= startDate && h.date <= endDate);
}

export async function fetchAllAbsencesForWeek(
  startDate: string,
  endDate: string,
): Promise<AbsenceRow[]> {
  return apiGet<AbsenceRow[]>(
    `/timesheet/absence?from=${startDate}&to=${endDate}`,
  );
}

export async function fetchAllEmployees(): Promise<EmployeeRow[]> {
  return apiGet<EmployeeRow[]>("/employees");
}

// employee id → Mondays of the weeks whose «Bekreft avspasering» still holds.
// The platform only returns a week while its deficit is no larger than what
// was confirmed, so a returned week is covered in full.
export async function fetchConfirmedWeeks(
  employeeIds: number[],
  fromMonday: string,
  toDate: string,
): Promise<Map<number, Set<string>>> {
  const result = new Map<number, Set<string>>();
  // An empty employeeIds is an empty answer, not everyone's.
  if (employeeIds.length === 0) return result;

  const weeks = await apiGet<{ employeeId: number; weekStart: string }[]>(
    `/timesheet/confirmed-weeks?employeeIds=${employeeIds.join(",")}&from=${fromMonday}&to=${toDate}`,
  );
  for (const w of weeks) {
    const byEmployee = result.get(w.employeeId) ?? new Set<string>();
    byEmployee.add(w.weekStart);
    result.set(w.employeeId, byEmployee);
  }
  return result;
}

export async function fetchActiveBillableProjectsWithResponsible(): Promise<
  InvoiceProjectRow[]
> {
  const projects = await apiGet<
    { id: string; name: string; responsible: number | null }[]
  >("/projects?active=true&billable=true");
  return projects.filter((p): p is InvoiceProjectRow => p.responsible !== null);
}

export async function fetchHoursByEmployee(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<Map<number, ProjectHoursPerDayRow[]>> {
  const byEmployee = new Map<number, ProjectHoursPerDayRow[]>();
  // The route refuses an empty list rather than answering nobody.
  if (employeeIds.length === 0) return byEmployee;

  const rows = await apiPost<ProjectHoursPerDayRow[]>(
    "/reports/employee-hours",
    { employeeIds, from: startDate, to: endDate },
  );
  for (const r of rows) {
    const list = byEmployee.get(r.employeeId);
    if (list) list.push(r);
    else byEmployee.set(r.employeeId, [r]);
  }
  return byEmployee;
}

// FG over exactly start..end, as fg_employee_period gave it. The per-employee
// report's month bucket is not a substitute: it follows the majority-week rule
// the bonus uses, so its hours don't add up to the calendar month.
export async function fetchAllFGForRange(
  start: string,
  end: string,
): Promise<Map<number, { billable: number; available: number }>> {
  const { employees } = await apiGet<{ employees: BillingDegreePeriodRow[] }>(
    `/reports/billing-degree/achieved/period?from=${start}&to=${end}`,
  );
  return new Map(
    employees.map((e) => [
      e.employeeId,
      { billable: e.billableHours, available: e.capacityHours },
    ]),
  );
}

// Per-employee fetcher: throws on a real API error. Callers wrap the loop
// body so one employee's failure skips just them (loud), not the whole run.
// No route serves every employee's bonus at once.
// Bonus comes from floq-platform's billing-degree report, which owns
// per-week FG, the majority-week-in-month rule, the non-FG-code adjustment
// and the Fagleder bonus tiers — so the bot mirrors none of that logic.

export async function fetchMonthlyBonus(
  employeeId: number,
  month: string, // YYYY-MM
): Promise<number> {
  const { months } = await apiGet<{ months: { bonusAmount: number }[] }>(
    `/reports/billing-degree/achieved/employee?employeeId=${employeeId}&fromMonth=${month}&toMonth=${month}`,
  );
  return months[0]?.bonusAmount ?? 0;
}
