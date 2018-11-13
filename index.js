// @flow

const request = require('request-promise-native');
const WebClient = require('@slack/client').WebClient;
const jwt = require('jsonwebtoken');
const format = require('date-fns/format');
const subDays = require('date-fns/sub_days');
const subWeeks = require('date-fns/sub_weeks');
const nbLocale = require('date-fns/locale/nb');

const slack = new WebClient(process.env.SLACK_API_TOKEN || '');

const startDate = subWeeks(new Date(), 1);
const endDate = subDays(new Date(), 1);

const nbDays = {
  '1': 'én dag',
  '2': 'to dager',
  '3': 'tre dager',
  '4': 'fire dager',
  '5': 'fem dager'
};

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

const notifySlackers = async () => {
  const apiToken = jwt.sign({role: 'root'}, process.env.API_JWT_SECRET || 'dev-secret-shhh');

  const notifiees = await request({
    uri: 'http://floq-api/rpc/time_tracking_status',
    method: 'POST',
    json: true,
    headers: {
      authorization: `Bearer ${apiToken}`
    },
    body: {
      start_date: format(startDate, 'YYYY-MM-DD'),
      end_date: format(endDate, 'YYYY-MM-DD')
    }
  })
    .then(employees => employees.filter(({ unregistered_days }) => unregistered_days > 0));

  const { members: slackUsers } = await slack.users.list();

  console.info('notifiees', notifiees);
  for (const { email, unregistered_days: days } of notifiees) {
    const targetUser = slackUsers.find(u => u.profile.email === email);

    if (targetUser === undefined) {
      console.error(`Slack user for email ${email} not found.`);
    } else {
      const firstDate = format(startDate, 'Do MMMM', { locale: nbLocale });
      const lastDate = format(endDate, 'Do MMMM', { locale: nbLocale });
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];

      const message = `${greeting} Det ser ut som De har glemt å føre ${nbDays[days]} sist uke`
        + ` (mellom ${firstDate} og ${lastDate}). Hvis du avspaserte: ignorer meg. 😳\n\n`
        + 'Timeføring: https://inni.blank.no/timestamp/\n\n'
        + 'P.S: Hvis jeg er veldig teit nå, kontakt @eh. 😇';

      console.log(`Notifying user @${targetUser.name} that s/he is missing ${days} day(s).`);
      console.log(message);

      slack.chat.postMessage(`@${targetUser.name}`, message, { as_user: true })
        .then(console.log(`Message sent to ${targetUser.name}`));
    }
  }
};

const notifyAdminAboutOvertime = async () => {
  const apiToken = jwt.sign({ role: 'root' }, process.env.API_JWT_SECRET || 'dev-secret-shhh');

  const channel = 'administrasjonen';

  const entries = await request({
    uri: 'http://floq-api/paid_overtime?paid_date=is.null',
    method: 'GET',
    json: true,
    headers: {
      authorization: `Bearer ${apiToken}`
    }
  });
  if (entries.length > 0) {
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    const message = `${greeting} Det ser ut som noen har ført overtid som ikke er utbetalt💰\n\n`
      + 'Overtid: https://inni.blank.no/overtime\n\n'
      + 'P.S: Hvis jeg er veldig teit nå, kontakt @kristiane. 😇';

    console.log(message);

    slack.chat.postMessage(`#${channel}`, message, { as_user: true })
      .then(console.log(`Message sent to ${channel}`));
  }
};

notifySlackers();
notifyAdminAboutOvertime();
