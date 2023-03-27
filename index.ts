import fetch from 'node-fetch';
import { WebClient } from '@slack/web-api';
import * as jwt from 'jsonwebtoken';
import moment from 'moment';

type Employee = {
  email: string;
  unregistered_days: number;
};

const apiUri = process.env.API_URI || 'https://api-test.floq.no';
const slack = new WebClient(process.env.SLACK_API_TOKEN || '');

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

function toDaysString(days: number): String {
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
  const apiToken = jwt.sign({ role: 'root' }, process.env.API_JWT_SECRET || 'dev-secret-shhh');

  const firstDateOfLastWeek = moment().add(-1, 'week').startOf('isoWeek').locale('nb');
  const lastDateOfLastWeek = moment().add(-1, 'week').endOf('isoWeek').locale('nb');

  const body = JSON.stringify({
    start_date: firstDateOfLastWeek.format('YYYY-MM-DD'),
    end_date: lastDateOfLastWeek.format('YYYY-MM-DD')
  });
  console.info(`${apiUri}/rpc/time_tracking_status body`, body);


  const employeeResponse = await fetch(
    `${apiUri}/rpc/time_tracking_status`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: body,
    }
  );
  const employees = await employeeResponse.json() as Employee[];
  console.info('time_tracking_status response', employees);

  const notifiees = employees.filter(({ unregistered_days }) => unregistered_days > 0);
  console.info('notifiees', notifiees);

  const { members: slackUsers, error: getUsersError } = await slack.users.list();
  if (getUsersError) {
    console.error("Got an error response when trying to get slack users ", getUsersError);
    return;
  }
  if (!slackUsers) {
    console.error("Found no slack users");
    return;
  }

  const firstDate = firstDateOfLastWeek.format('Do MMMM');
  const lastDate = lastDateOfLastWeek.format('Do MMMM');

  for (const { email, unregistered_days: days } of notifiees) {
    const targetUser = slackUsers.find(u => u.profile!.email === email);

    if (targetUser === undefined) {
      console.error(`Slack user for email ${email} not found.`);
    } else {
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];

      const message = `${greeting} Det ser ut som De har glemt å føre ${toDaysString(days)} sist uke`
        + ` (mellom ${firstDate} og ${lastDate}). Hvis du avspaserte: ignorer meg. 😳\n\n`
        + 'Timeføring: https://inni.blank.no/timestamp/\n\n'
        + 'P.S: Hvis jeg er veldig teit nå, kontakt @jahnarne. 😇';

      console.info(`Notifying user @${targetUser.name} (id ${targetUser.id}) that s/he is missing ${days} day(s).`);
      console.info(message);

      const { ok, postMessageError } = await slack.chat.postMessage({ channel: targetUser.id, text: message, as_user: true });
      if (postMessageError) {
        console.error(`Got an error response when trying to post message to ${targetUser.name}`, postMessageError);
        return;
      }
      if (!ok) {
        console.error(`Message was not sent to ${targetUser.name} and response contained no error`);
        return;
      }
      console.info('Message sent to', targetUser.name);
    }
  }
};

const notifyAdminAboutOvertime = async () => {
  const apiToken = jwt.sign({ role: 'root' }, process.env.API_JWT_SECRET || 'dev-secret-shhh');

  const channelName = 'overtid';

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
    const { channels, error: getChannelsError } = await slack.conversations.list({types: "public_channel,private_channel"});
    if (getChannelsError) {
      console.error('Got an error response when trying to get slack channels', getChannelsError);
      return;
    }
    if (!channels) {
      console.error('Found no slack channels');
      return;
    }

    const channel = channels.find((c) => c.name === channelName);
    if (!channel) {
      console.error(`Could not find any channel with a name matching "${channelName}"`);
      return;
    }

    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    const message = `${greeting} Det ser ut som noen har ført overtid som ikke er utbetalt💰\n\n`
      + 'Overtid: https://inni.blank.no/overtime\n\n'
      + 'P.S: Hvis jeg er veldig teit nå, kontakt @jahnarne. 😇';

    console.info(message);

    const { ok, postMessageError } = await slack.chat.postMessage({ channel: channel.id, text: message, as_user: true });
    if (postMessageError) {
      console.error('Got an error response when trying to post message about overtime', postMessageError);
      return;
    }
    if (!ok) {
      console.error(`Message was not sent to ${channelName} and response contained no error`);
      return;
    }
    console.info('Message sent to', channelName);
  }
};

notifySlackers();
notifyAdminAboutOvertime();
