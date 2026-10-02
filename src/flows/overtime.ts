import { postMessage } from "../slack.js";
import { apiGet } from "../api.js";

export const notifyAdminAboutOvertime = async () => {
  const channelName = "overtid";

  let entries: { paidDate: string | null }[];
  try {
    const all = await apiGet<{ paidDate: string | null }[]>(
      "/timesheet/overtime",
    );
    entries = all.filter((e) => e.paidDate === null);
  } catch (err) {
    console.error("Failed to fetch overtime:", err);
    return;
  }

  if (entries.length === 0) return;

  const message =
    "Det ser ut som noen har ført overtid som ikke er utbetalt 💰\n\n" +
    "Overtid: https://inni.blank.no/overtime";

  console.info(`Overtime entries: ${entries.length}`);
  await postMessage(`#${channelName}`, `#${channelName}`, { text: message });
};
