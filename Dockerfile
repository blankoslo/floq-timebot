FROM node:16-alpine

# Required ENV variables:
# - API_JWT_SECRET (secret shared with floq-api)
# - API_URI
# - SLACK_API_TOKEN

RUN mkdir -p /timebot
WORKDIR /timebot

COPY index.ts /timebot/index.ts
COPY package.json /timebot/package.json
COPY tsconfig.json /timebot/tsconfig.json

RUN npm install
RUN npm run build
RUN cp dist/index.js /timebot/index.js

RUN rm index.ts
RUN rm package.json
RUN rm tsconfig.json

CMD [ "node", "index.js" ]
