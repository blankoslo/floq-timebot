# Floq Timebot

Slack bot for time tracking and capacity. It started as a nudge for missing
time entries, and now also posts aggregated overviews to an admin/sales channel.

The bot runs a set of independent flows, each gated by its own `IS_*` env flag.
A scheduler trigger sets exactly the flags it wants — there is no hidden
bundling, so every flow can be triggered and tested on its own.

| Flag | Flow | Recipient |
| ---- | ---- | --------- |
| `IS_MONDAY` | Weekly digest of last week's hours per person | DM to each employee |
| `IS_TUESDAY` | Follow-up nudge to people still missing hours for last week | DM to stragglers |
| `IS_FIRST_OF_MONTH` | Month nudge to people still missing hours for last month | DM to stragglers |
| `IS_MONTHLY_RECAP` | Monthly recap (FG, bonus, project hours). Derived: fires on the first Monday of the month | DM to each employee |
| `IS_OVERTIME` | Unpaid registered overtime exists | `#overtid` channel |
| `IS_INVOICING_REMINDER` | Month-end reminder to invoice. Internal date gate fires it on the last virkedag of the month (rolled forward past weekends/holidays) | DM to each project's oppdragsansvarlig |
| `IS_AVAILABILITY` | Free capacity (unstaffed days) the next N weeks, per person | capacity channel |
| `IS_ADMIN_MISSING` | Aggregated table of who is missing time entries | capacity channel |

The capacity channel defaults to `#admin-bemanningogsalg-diskusjon`.

To run:

    node index.js

# Production environment

Push to master is build automatically:
https://console.cloud.google.com/cloud-build/triggers;region=global/edit/6c94f2be-f12a-4339-904e-fb9d10a88314?project=marine-cycle-97212

Which produces images stored at:
https://console.cloud.google.com/gcr/images/marine-cycle-97212/global/github.com/blankoslo/floq-timebot

The job is executed every monday at 9 by:
https://console.cloud.google.com/run/jobs/details/europe-north1/floq-prod-timebot/executions?project=marine-cycle-97212

# Testing

The bot authenticates to Floq as the `floq-prod-timebot` service account. Anyone in
`alle@blank.no` can impersonate it locally, so you can run the bot against Floq's
test environment (`api-test.floq.no`) without deploying first:

    gcloud auth application-default login --impersonate-service-account=floq-prod-timebot@marine-cycle-97212.iam.gserviceaccount.com
    DRY_RUN=true IS_AVAILABILITY=true node dist/index.js

`API_URI` and `FLOQ_AUTH_BASE_URL` already default to the test environment, so no
further env vars are needed for a local run. `SLACK_API_TOKEN` still points at the
real Slack workspace — `DRY_RUN=true` logs the rendered preview instead of sending
it, so this is safe even without setting `TEST_USER_EMAIL`/`TEST_USER_SLACK_EMAIL`.

This impersonation changes your machine-wide Application Default Credentials —
every local tool that resolves ADC will act as `floq-prod-timebot` until you log
back in normally (`gcloud auth application-default login`) or revoke
(`gcloud auth application-default revoke`).

The same local setup also works against production data (still read-only) —
just point at prod:

    API_URI=https://api-prod.floq.no FLOQ_AUTH_BASE_URL=https://inni.blank.no \
    DRY_RUN=true IS_AVAILABILITY=true node dist/index.js

Deploying is only needed to verify the actual built container / Cloud Run Job
end-to-end:

1. Deploy a new version to production.
2. Execute the [Cloud Run Job](https://console.cloud.google.com/run/jobs/details/europe-north1/floq-prod-timebot/executions?authuser=1&project=marine-cycle-97212&supportedpurview=project) with overrides and add the env variable `DRY_RUN=true`. Execute with overrides is available through the drop-down next to the execute button.

When testing there are some environment variables available for easier testing:

| Environment Variable | Description                               | Default Value |
| -------------------- | ----------------------------------------- | ------------- |
| `DRY_RUN`            | If set to true, no notifications are sent (preview is logged instead) | `false` |
| `IS_MONDAY`          | Run the weekly digest                     | `false`       |
| `IS_TUESDAY`         | Run the Tuesday follow-up nudge           | `false`       |
| `IS_FIRST_OF_MONTH`  | Run the first-of-month nudge              | `false`       |
| `IS_MONTHLY_RECAP`   | Force the monthly recap                   | `false`       |
| `IS_OVERTIME`        | Run the unpaid-overtime check             | `false`       |
| `IS_INVOICING_REMINDER` | Run the month-end invoicing reminder (still self-gates to the send-day) | `false`  |
| `INVOICING_REMINDER_FORCE` | Bypass the invoicing send-day gate (targets the previous month) — for testing | `false` |
| `IS_AVAILABILITY`    | Run the free-capacity overview            | `false`       |
| `IS_ADMIN_MISSING`   | Run the aggregated missing-time table     | `false`       |

Flags are read from `process.env` only — the bot does not load a `.env` file.
To run locally, set them inline (`IS_AVAILABILITY=true DRY_RUN=true node
dist/index.js`) or export them into your shell.

Configuration knobs (all have sensible defaults):

| Environment Variable | Description | Default Value |
| -------------------- | ----------- | ------------- |
| `CAPACITY_CHANNEL` | Channel for the availability and admin-missing overviews | `admin-bemanningogsalg-diskusjon` |
| `CAPACITY_WEEKS_AHEAD` | How many ISO weeks ahead the availability overview covers | `6` |
| `ADMIN_MISSING_PERIOD` | Period for `IS_ADMIN_MISSING`: `week` (last week) or `month` (last month) | `week` |
| `FLOQ_INVOICE_URL` | Link in the invoicing reminder | `https://inni.blank.no/invoice` |

Scheduling note: `IS_ADMIN_MISSING` is independent of the personal-nudge flags.
To mirror the nudge cadence, set `IS_ADMIN_MISSING=true` on the Monday and
Tuesday triggers, and `IS_ADMIN_MISSING=true` + `ADMIN_MISSING_PERIOD=month` on
the first-of-month trigger.

Scheduling note for `IS_INVOICING_REMINDER`: schedule a trigger that fires it
**every weekday** with `IS_INVOICING_REMINDER=true`. The flow self-gates — it
only sends on the month's last virkedag, rolled forward past weekends and
holidays (so if the last day is a Saturday it lands the following Monday). Every
other weekday it exits after one cheap holidays lookup. Firing it monthly would
be wrong: the exact send date shifts month to month, so a fixed cron can't hit
it.

For reverting back to previous versions after testing, delete the latest image from the [Container Registry](https://console.cloud.google.com/gcr/images/marine-cycle-97212/global/github.com/blankoslo/floq-timebot?authuser=1&tab=info) or change the latest tag.
