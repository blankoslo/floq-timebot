// @flow

const request = require('request-promise-native');
const WebClient = require('@slack/client').WebClient;
const jwt = require('jsonwebtoken');
const format = require('date-fns/format');
const subDays = require('date-fns/sub_days');

const slack = new WebClient(process.env.SLACK_API_TOKEN || '');

const startDate = format(subDays(new Date(), 7), 'YYYY-MM-DD');
const endDate = format(subDays(new Date(), 1), 'YYYY-MM-DD');

request({
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
  .catch(err => {
    console.error(`Error when fetching time tracking status: ${err}`);
    throw err;
  })
  .then(employees => employees.filter(({unregistered_days}) => unregistered_days > 0))
  .then(notifiees =>
    slack.users.list()
        .catch(err => console.error(`Error when fetching users from Slack: ${err}`))
        .then(({members}) =>
              notifiees.map(({email, unregistered_days}) => {
                const targetUser = members.find(u => u.profile.email === email);

                if (targetUser === undefined) {
                  console.error(`Slack user for email ${email} not found.`);
                } else {
                  console.log(`Notifying user @${targetUser.name} that s/he is missing ${unregistered_days} day(s).`);

                  if (targetUser.name === 'eh') {
                    slack.chat.postMessage('@eh', 'Hello there')
                      .then(_ => console.log('Message sent: ', res));
                  }
                }
              })))
  .catch(err => console.error('Error: ', err));
