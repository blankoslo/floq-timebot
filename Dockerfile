FROM mhart/alpine-node:8

# Required ENV variables:
# - API_JWT_SECRET (secret shared with floq-api)
# - API_URI
# - SLACK_API_TOKEN

RUN mkdir -p /timebot
WORKDIR /timebot
COPY package.json /timebot/package.json
RUN npm install
COPY index.js /timebot/index.js

CMD [ "node", "index.js" ]
