FROM mhart/alpine-node

# Required ENV variables:
# - API_JWT_SECRET (secret shared with floq-api)
# - SLACK_API_TOKEN

RUN mkdir -p /timebot
WORKDIR /timebot
COPY package.json /timebot/package.json
RUN npm install
COPY index.js /timebot/index.js

# CMD [ "node", "--harmony-async-await", "index.js" ]

COPY cronjob /var/spool/cron/crontabs/root
CMD crond -l 2 -f
