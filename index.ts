import fetch from "node-fetch";
import { WebClient } from "@slack/web-api";
import * as jwt from "jsonwebtoken";
import moment from "moment";

type Employee = {
  email: string;
  unregistered_days: number;
  employee_id?: number;
};

type EmployeeWithMissingDays = {
  email: string;
  unregistered_days: number;
  employee_id: number;
  missing_days: string[];
};

const apiUri = process.env.API_URI || "https://api-test.floq.no";
const slack = new WebClient(process.env.SLACK_API_TOKEN || "");
const DRY_RUN = process.env.DRY_RUN === "true";

const greetings = [
  "God dag.",
  "Insjill.",
  "¡Buenos días!",
  "Buongiorno.",
  "¡Hola!",
  "Hej!",
  "Selamat pagi!",
  "Guten tag.",
  "Tjena!",
  "Xin chào.",
];

function toDaysString(days: number): String {
  switch (days) {
    case 1:
      return "én dag";
    case 2:
      return "to dager";
    case 3:
      return "tre dager";
    case 4:
      return "fire dager";
    case 5:
      return "fem dager";
    default:
      return "et ukjent antall dager";
  }
}

moment.locale("nb");
const isFirstOfMonth = process.env.IS_FIRST_OF_MONTH || moment().date() === 1;
const isMonday = process.env.IS_MONDAY || moment().day() === 1;

// Helper function to get employee ID from email using employees_roles function
const getEmployeeIdFromEmail = async (email: string): Promise<number | null> => {
  const apiToken = jwt.sign(
    { role: "root" },
    process.env.API_JWT_SECRET || "dev-secret-shhh"
  );

  const body = JSON.stringify({
    email_param: email
  });

  try {
    const response = await fetch(`${apiUri}/rpc/employees_roles`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body,
    });

    const result = await response.json();
    
    // The function returns an array, and we want the first result's employee.id
    if (Array.isArray(result) && result.length > 0 && result[0].employee) {
      return result[0].employee.id;
    }
    
    console.warn(`No employee found for email: ${email}`);
    return null;
  } catch (error) {
    console.error(`Error getting employee ID for ${email}:`, error);
    return null;
  }
};

// Helper function to get accumulated hours for an employee for a specific day
const getAccumulatedHoursForDay = async (
  employeeId: number,
  date: moment.Moment
): Promise<number> => {
  const apiToken = jwt.sign(
    { role: "root" },
    process.env.API_JWT_SECRET || "dev-secret-shhh"
  );

  const dateStr = date.format("YYYY-MM-DD");
  const body = JSON.stringify({
    employee_id: employeeId,
    start_date: dateStr,
    end_date: dateStr, // Same date for both start and end to get just that day
  });

  try {
    const response = await fetch(`${apiUri}/rpc/accumulated_hours_for_employee`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body,
    });

    const result = await response.json();
    return typeof result === 'number' ? result : 0;
  } catch (error) {
    console.error(`Error getting accumulated hours for employee ${employeeId} on ${dateStr}:`, error);
    return 0;
  }
};

// Helper function to get all weekdays with 0 hours for an employee
const getMissingDaysForEmployee = async (
  employeeId: number,
  startDate: moment.Moment,
  endDate: moment.Moment
): Promise<string[]> => {
  const missingDays: string[] = [];
  const current = startDate.clone();
  
  while (current.isSameOrBefore(endDate)) {
    // Only check weekdays (Monday = 1, Friday = 5)
    if (current.day() >= 1 && current.day() <= 5) {
      const hours = await getAccumulatedHoursForDay(employeeId, current);
      if (hours === 0) {
        missingDays.push(current.format("YYYY-MM-DD"));
      }
    }
    current.add(1, 'day');
  }
  
  return missingDays;
};

const getStartAndEndDate = () => {
  let startDate, endDate;

  if (isFirstOfMonth && !isMonday) {
    startDate = moment().startOf("isoWeek");
    endDate = moment().subtract(1, "day");
  } else {
    startDate = moment().subtract(1, "week").startOf("isoWeek");
    endDate = moment().subtract(1, "week").endOf("isoWeek");
  }

  return { startDate, endDate };
};

const getWeekString = () => {
  if (isFirstOfMonth && !isMonday) {
    return "denne uken";
  }
  return "sist uke";
};

const notifySlackers = async () => {
  const jwtPayload = { role: "root" };
  const apiToken = jwt.sign(
    jwtPayload,
    process.env.API_JWT_SECRET || "dev-secret-shhh"
  );
  
  console.info("JWT Payload:", jwtPayload);
  console.info("JWT Secret (first 10 chars):", (process.env.API_JWT_SECRET || "dev-secret-shhh").substring(0, 10) + "...");
  console.info("Generated JWT (first 50 chars):", apiToken.substring(0, 50) + "...");

  const { startDate, endDate } = getStartAndEndDate();

  const body = JSON.stringify({
    start_date: startDate.format("YYYY-MM-DD"),
    end_date: endDate.format("YYYY-MM-DD"),
  });
  console.info(`${apiUri}/rpc/time_tracking_status body`, body);

  const employeeResponse = await fetch(`${apiUri}/rpc/time_tracking_status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body,
  });
  const employeesData = await employeeResponse.json();
  console.info("time_tracking_status response", employeesData);

  // Check if the response is an error
  if (!Array.isArray(employeesData)) {
    console.error("\n=== API ERROR ===");
    console.error("Error from time_tracking_status API:", JSON.stringify(employeesData, null, 2));
    console.error("HTTP Status:", employeeResponse.status);
    console.error("Request URL:", `${apiUri}/rpc/time_tracking_status`);
    console.error("Request body:", body);
    console.error("\nThis might indicate:");
    console.error("- The time_tracking_status function doesn't exist");
    console.error("- Wrong parameter names or types");
    console.error("- Authorization issues");
    console.error("- Function exists but has different signature");
    console.error("================\n");
    return;
  }

  const employees = employeesData as Employee[];
  const notifiees = employees.filter(
    ({ unregistered_days }) => unregistered_days > 0
  );
  console.info("notifiees", notifiees);
  
  // Log all available fields for the first employee to see what we have
  if (employees.length > 0) {
    console.info("\n=== AVAILABLE FIELDS IN EMPLOYEE DATA ===");
    console.info("Sample employee object keys:", Object.keys(employees[0]));
    console.info("Sample employee object:", JSON.stringify(employees[0], null, 2));
    console.info("=========================================\n");
  }

  // Get missing days for each employee with unregistered days
  const employeesWithMissingDays: EmployeeWithMissingDays[] = [];
  for (const employee of notifiees) {
    console.info(`Getting employee ID for ${employee.email}...`);
    const employeeId = await getEmployeeIdFromEmail(employee.email);
    
    if (!employeeId) {
      console.warn(`Could not get employee_id for ${employee.email}, skipping detailed analysis`);
      continue;
    }

    console.info(`Getting missing days for ${employee.email} (ID: ${employeeId})`);
    const missingDays = await getMissingDaysForEmployee(employeeId, startDate, endDate);
    
    employeesWithMissingDays.push({
      email: employee.email,
      employee_id: employeeId,
      unregistered_days: employee.unregistered_days,
      missing_days: missingDays
    });
  }

  console.info("employees with missing days", employeesWithMissingDays);

  // If no employees have detailed missing days info (due to missing employee_id),
  // fall back to sending basic notifications
  let employeesToNotify = employeesWithMissingDays;
  if (employeesWithMissingDays.length === 0 && notifiees.length > 0) {
    console.info("\nFalling back to basic notifications without detailed day analysis");
    console.info("Reason: employee_id not available in time_tracking_status response\n");
    
    // Convert notifiees to basic notification format
    employeesToNotify = notifiees.map(employee => ({
      email: employee.email,
      employee_id: 0, // placeholder
      unregistered_days: employee.unregistered_days,
      missing_days: [] as string[] // will be empty, so we'll show basic message
    }));
  }

  const { members: slackUsers, error: getUsersError } =
    await slack.users.list();
  if (getUsersError) {
    console.error(
      "Got an error response when trying to get slack users ",
      getUsersError
    );
    return;
  }
  if (!slackUsers) {
    console.error("Found no slack users");
    return;
  }

  const firstDate = startDate.format("Do MMMM");
  const lastDate = endDate.format("Do MMMM");

  for (const employeeWithMissingDays of employeesToNotify) {
    const { email, unregistered_days: days, missing_days } = employeeWithMissingDays;
    const targetUser = slackUsers.find((u) => u.profile!.email === email);

    if (targetUser === undefined) {
      console.error(`Slack user for email ${email} not found.`);
    } else {
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];
      
      // Format missing days for display
      const missingDaysFormatted = missing_days.map(day => 
        moment(day).format("dddd Do MMMM")
      ).join(", ");

      let message = `${greeting} Det ser ut som De har glemt å føre ${toDaysString(days)} ${getWeekString()}`;
      
      message += ` ${
        firstDate === lastDate
          ? `(${firstDate})`
          : `(mellom ${firstDate} og ${lastDate})`
      }.\n\n`;
      
      // Add specific missing days if we found them
      if (missing_days.length > 0) {
        message += `📅 *Manglende dager:* ${missingDaysFormatted}\n\n`;
      }
      
      message += "Hvis du avspaserte: ignorer meg. 😳\n\n";
      message += "Timeføring: https://inni.blank.no/timestamp/\n\n";
      message += "P.S: Hvis jeg er veldig teit nå, kontakt @jahnarne. 😇";

      console.info(
        `Notifying user @${targetUser.name} (id ${targetUser.id}) that s/he is missing ${days} day(s). Missing days: ${missing_days.join(', ')}`
      );
      console.info(message);

      if (DRY_RUN) {
        console.info("Dry run, not actually sending any message");
        continue;
      }

      const { ok, postMessageError } = await slack.chat.postMessage({
        channel: targetUser.id,
        text: message,
        as_user: true,
      });
      if (postMessageError) {
        console.error(
          `Got an error response when trying to post message to ${targetUser.name}`,
          postMessageError
        );
        return;
      }
      if (!ok) {
        console.error(
          `Message was not sent to ${targetUser.name} and response contained no error`
        );
        return;
      }
      console.info("Message sent to", targetUser.name);
    }
  }
};

const notifyAdminAboutOvertime = async () => {
  const apiToken = jwt.sign(
    { role: "root" },
    process.env.API_JWT_SECRET || "dev-secret-shhh"
  );

  const channelName = "overtid";

  const overtimeResponse = await fetch(
    `${apiUri}/paid_overtime?paid_date=is.null`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json",
      },
    }
  );
  const entries = (await overtimeResponse.json()) as any[];

  if (entries.length > 0) {
    const { channels, error: getChannelsError } =
      await slack.conversations.list({
        types: "public_channel,private_channel",
      });
    if (getChannelsError) {
      console.error(
        "Got an error response when trying to get slack channels",
        getChannelsError
      );
      return;
    }
    if (!channels) {
      console.error("Found no slack channels");
      return;
    }

    const channel = channels.find((c) => c.name === channelName);
    if (!channel) {
      console.error(
        `Could not find any channel with a name matching "${channelName}"`
      );
      return;
    }

    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    const message =
      `${greeting} Det ser ut som noen har ført overtid som ikke er utbetalt💰\n\n` +
      "Overtid: https://inni.blank.no/overtime\n\n" +
      "P.S: Hvis jeg er veldig teit nå, kontakt @jahnarne. 😇";

    console.info(message);

    if (DRY_RUN) {
      console.info("Dry run, not actually sending any message");
      return;
    }

    const { ok, postMessageError } = await slack.chat.postMessage({
      channel: channel.id,
      text: message,
      as_user: true,
    });
    if (postMessageError) {
      console.error(
        "Got an error response when trying to post message about overtime",
        postMessageError
      );
      return;
    }
    if (!ok) {
      console.error(
        `Message was not sent to ${channelName} and response contained no error`
      );
      return;
    }
    console.info("Message sent to", channelName);
  }
};

notifySlackers();
notifyAdminAboutOvertime();
