# @spleed/integrations

Third-party provider clients for Spleed agents (Apollo, Apify, Sendblue, Slack, Stripe Issuing, Composio, etc). Each provider lives in its own subdirectory with a uniform `client.ts` + `mock.ts` + `types.ts` shape so agents can stub in tests and swap to live calls in production via env flags.

Sprint 5a ships only the Apollo client (with mock-default behavior; set `APOLLO_LIVE=true` to opt into live calls). Apify, Sendblue, Slack and others land in their respective sprints.
