# Two stages so the shipped image only carries production dependencies —
# typescript never ends up in the final image. tsc doesn't bundle
# package.json dependencies into its output, so the runtime stage still
# needs its own `npm ci --omit=dev`.
FROM node:22-alpine AS build

WORKDIR /timebot

COPY package.json package-lock.json tsconfig.json /timebot/
RUN npm ci

COPY src /timebot/src
RUN npm run build

FROM node:22-alpine

# Required ENV variables:
# - API_URI (Floq's PostgREST API)
# - FLOQ_AUTH_BASE_URL (Floq's own app — exchanges this job's service-account
#   identity for a short-lived API_URI access token)
# - FLOQ_SERVICE_TOKEN_AUDIENCE (defaults to FLOQ_AUTH_BASE_URL)
# - SLACK_API_TOKEN

WORKDIR /timebot

COPY package.json package-lock.json /timebot/
RUN npm ci --omit=dev

COPY --from=build /timebot/dist/index.js /timebot/index.js

CMD [ "node", "index.js" ]
