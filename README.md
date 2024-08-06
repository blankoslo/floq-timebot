# Floq Timebot

Slack bot that notifies people on Slack when time entries for the previous week
are missing.

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

There is no separate testing environment. In order to test:

1. Deploy a new version to production.
2. Execute the [Cloud Run Job](https://console.cloud.google.com/run/jobs/details/europe-north1/floq-prod-timebot/executions?authuser=1&project=marine-cycle-97212&supportedpurview=project) with overrides and add the env variable `DRY_RUN=true`. Execute with overrides is available through the drop-down next to the execute button.

When testing there are some environment variables available for easier testing:

| Environment Variable | Description                               | Default Value |
| -------------------- | ----------------------------------------- | ------------- |
| `DRY_RUN`            | If set to true, no notifications are sent | `false`       |
| `IS_FIRST_OF_MONTH`  | Simulate running on the 1st of the month  | `false`       |
| `IS_MONDAY`          | Simulate running on a Monday              | `false`       |

For reverting back to previous versions after testing, delete the latest image from the [Container Registry](https://console.cloud.google.com/gcr/images/marine-cycle-97212/global/github.com/blankoslo/floq-timebot?authuser=1&tab=info) or change the latest tag.
