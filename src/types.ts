// Note: we used to hardcode an absence-code list here, but it was both
// incomplete (missed several codes Floq counts as unavailable) and wrong
// for PER1000 (Permisjon m/lønn — counted as non-billable, not absence).
// Categorization now reads `billable` from /projects instead, so the
// API is the single source of truth.

export type TimeTrackingStatusRow = {
  name: string;
  email: string;
  availableHours: number;
  billableHours: number;
  nonBillableHours: number;
  lastDate: string | null;
};

export type EmployeeRow = {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string | null;
  dateOfEmployment: string | null;
  terminationDate: string | null;
};
export type HolidayRow = { date: string; name: string | null };
export type AbsenceRow = {
  date: string;
  employeeId: number;
  reason: string;
  percentage: number;
};
export type InvoiceProjectRow = {
  id: string;
  name: string;
  // oppdragsansvarlig, an employees.id
  responsible: number;
};
export type BillingDegreePeriodRow = {
  employeeId: number;
  billableHours: number;
  capacityHours: number;
};
// One row per (employee, project, day) with hours; days without are no row.
export type ProjectHoursPerDayRow = {
  employeeId: number;
  projectId: string;
  projectName: string;
  // "billable" | "nonbillable" | "unavailable"
  status: string;
  date: string;
  hours: number;
};

export type DayStatus =
  | "complete" //  ≥ 7,5 t with at least some work time
  | "absence" //   ≥ 7,5 t purely absence
  | "partial" //   0 < total < 7,5 t
  | "empty" //     0 t
  | "holiday"
  | "off"; //      weekend or not employed, dropped unless work was logged

export type DayBreakdown = {
  date: string; // YYYY-MM-DD
  status: DayStatus;
  hoursActual: number; // work + absence total (both count toward "registered")
  hoursExpected: number; // 7,5 for workdays, 0 otherwise
  projects: string[]; // pretty labels — includes absence types like "Ferie"
  holidayName?: string;
};
