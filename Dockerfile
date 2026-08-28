# Two stages so the shipped image only carries production dependencies —
# tsup's build tooling (typescript, tsup, esbuild) never ends up in the final
# image. tsup externalizes package.json dependencies rather than bundling
# them, so the runtime stage still needs its own `npm ci --omit=dev`.
FROM node:22-alpine AS build

WORKDIR /timebot

COPY package.json package-lock.json tsconfig.json /timebot/
RUN npm ci

COPY index.ts /timebot/index.ts
RUN npm run build

FROM node:22-alpine

# Required ENV variables:
# - API_JWT_SECRET (secret shared with floq-api)
# - API_URI
# - SLACK_API_TOKEN

WORKDIR /timebot

COPY package.json package-lock.json /timebot/
RUN npm ci --omit=dev

COPY --from=build /timebot/dist/index.js /timebot/index.js

CMD [ "node", "index.js" ]
