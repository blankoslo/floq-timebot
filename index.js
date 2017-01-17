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
  '¡Buenos diaz!',
  'Buongiorno.',
  '¡Hola!',
  'Hej!',
  'Selamat pagi!',
  'Guten tag.',
  'Tjena!'
];

const notifySlakcers = async () => {
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
  .then(employees => employees.filter(({unregistered_days}) => unregistered_days > 0));

  const {members: slackUsers} = await slack.users.list();

  for (const {email, unregistered_days: days} of notifiees) {
    const targetUser = slackUsers.find(u => u.profile.email === email);

    if (targetUser === undefined) {
      console.error(`Slack user for email ${email} not found.`);
    } else {
      const firstDate = format(startDate, 'Do MMMM', {locale: nbLocale});
      const lastDate = format(endDate, 'Do MMMM', {locale: nbLocale});
      const greeting = greetings[Math.floor(Math.random() * greetings.length)];

      const message = `${greeting} Det ser ut som De har glemt å føre ${nbDays[days]} `
            + `sist uke (mellom ${firstDate} og ${lastDate}).`;

      console.log(`Notifying user @${targetUser.name} that s/he is missing ${days} day(s).`);
      console.log(message);

      slack.chat.postMessage(`@${targetUser.name}`, message, {as_user: true})
        .then(console.log(`Message sent to ${targetUser.name}`));
    }
  }
};

notifySlakcers();
