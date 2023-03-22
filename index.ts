import fetch from 'node-fetch';
import { WebClient } from '@slack/web-api';
import * as jwt from 'jsonwebtoken';
import { format, subDays, subWeeks } from 'date-fns';
import nbLocale from 'date-fns/locale/nb';

type Employee = {
  email: string;
  unregistered_days: number;
};

const apiUri = process.env.API_URI || 'https://api-test.floq.no';
const slack = new WebClient(process.env.SLACK_API_TOKEN || '');

const startDate = subWeeks(new Date(), 1);
const endDate = subDays(new Date(), 1);

const greetings = [
  'God dag.',
  'Insjill.',
  '¡Buenos días!',
  'Buongiorno.',
  '¡Hola!',
  'Hej!',
  'Selamat pagi!',
  'Guten tag.',
  'Tjena!'
];

function toDaysString(days: number) : String {
  switch (days) {
    case 1: 
      return 'én dag';
    case 2:
      return 'to dager';
    case 3:
      return 'tre dager';
    case 4:
      return 'fire dager';
    case 5:
      return 'fem dager';
    default:
      return 'et ukjent antall dager'
  }
}

const notifySlackers = async () => {
  const apiToken = jwt.sign({role: 'root'}, process.env.API_JWT_SECRET || 'dev-secret-shhh');

  const employeeResponse = await fetch(
    `${apiUri}/rpc/time_tracking_status`, 
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        start_date: format(startDate, 'yyyy-MM-dd'),
        end_date: format(endDate, 'yyyy-MM-dd')
      })
    }
  );
  const employees = await employeeResponse.json() as Employee[];
  console.info('time_tracking_status response', employees);

  const notifiees = employees.filter(({ unregistered_days }) => unregistered_days > 0);

  const { members: slackUsers } = await slack.users.list();
  if (!slackUsers) {
    console.error("Found no slack users");
    return;
  }

  console.info('notifiees', notifiees);
  for (const { email, unregistered_days: days } of notifiees) {
    const targetUser = slackUsers.find(u => u.profile!.email === email);

    if (targetUser === undefined) {
      console.error(`Slack user for email ${email} not found.`);
    } else {
      const firstDate = format(startDate, 'Do MMMM', { locale: nbLocale });
      const lastDate = format(endDate, 'Do MMMM', { locale: nbLocale });
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];

      const message = `${greeting} Det ser ut som De har glemt å føre ${toDaysString(days)} sist uke`
        + ` (mellom ${firstDate} og ${lastDate}). Hvis du avspaserte: ignorer meg. 😳\n\n`
        + 'Timeføring: https://inni.blank.no/timestamp/\n\n'
        + 'P.S: Hvis jeg er veldig teit nå, kontakt @jahnarne. 😇';

      console.log(`Notifying user @${targetUser.name} (id ${targetUser.id}) that s/he is missing ${days} day(s).`);
      console.log(message);

      slack.chat.postMessage({ channel: targetUser.id, text: message, as_user: true })
        .then(() => console.log(`Message sent to ${targetUser.name}`));
    }
  }
};

const notifyAdminAboutOvertime = async () => {
  const apiToken = jwt.sign({ role: 'root' }, process.env.API_JWT_SECRET || 'dev-secret-shhh');

  const channel = 'overtid';

  const overtimeResponse = await fetch(
    `${apiUri}/paid_overtime?paid_date=is.null`, 
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json'
      }
    }
  );
  const entries = await overtimeResponse.json() as any[];

  if (entries.length > 0) {
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    const message = `${greeting} Det ser ut som noen har ført overtid som ikke er utbetalt💰\n\n`
      + 'Overtid: https://inni.blank.no/overtime\n\n'
      + 'P.S: Hvis jeg er veldig teit nå, kontakt @jahnarne. 😇';

    console.log(message);

    slack.chat.postMessage({ channel: `#${channel}`, text: message, as_user: true })
      .then(() => console.log(`Message sent to ${channel}`));
  }
};

notifySlackers();
notifyAdminAboutOvertime();
