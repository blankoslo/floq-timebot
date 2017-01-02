// @flow

const request = require('request-promise-native');
const WebClient = require('@slack/client').WebClient;
const jwt = require('jsonwebtoken');
const format = require('date-fns/format');
const subDays = require('date-fns/sub_days');

const slack = new WebClient(process.env.SLACK_API_TOKEN || '');

const startDate = format(subDays(new Date(), 7), 'YYYY-MM-DD');
const endDate = format(subDays(new Date(), 1), 'YYYY-MM-DD');

async function notifySlakcers() {
  const notifiees = await request({
    uri: 'https://api-blank-test.floq.no/rpc/time_tracking_status',
    method: 'POST',
    json: true,
    headers: {
      authorization: `Bearer ${jwt.sign({role: 'root'}, process.env.API_TOKEN || 'dev-secret-shhh')}`
    },
    body: {
      start_date: startDate,
      end_date: endDate
    }
  })
  .then(employees => employees.filter(({unregistered_days}) => unregistered_days > 0));

  const {members: slackUsers} = await slack.users.list();

  for (let {email, unregistered_days} of notifiees) {
    const targetUser = slackUsers.find(u => u.profile.email === email);

    if (targetUser === undefined) {
      console.error(`Slack user for email ${email} not found.`);
    } else {
      console.log(`Notifying user @${targetUser.name} that s/he is missing ${unregistered_days} day(s).`);

      // if (targetUser.name === 'eh') {
      //   slack.chat.postMessage('@eh', 'Hello there')
      //     .then(_ => console.log('Message sent: ', res));
      // }
    }
  }
}

notifySlakcers();
