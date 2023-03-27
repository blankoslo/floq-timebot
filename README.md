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
