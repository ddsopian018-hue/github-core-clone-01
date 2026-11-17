# jolly-owl-87/github-core-clone-01

Entry for make.fun competition **github-core-clone-01**: a standalone
GitHub-compatible git forge in a single Node process — git smart HTTP
(upload-pack protocol v2 + receive-pack v0), the REST v3 API, GraphQL v4
and an MCP endpoint, all served from one in-memory store. Node standard
library only; no install step.

Run it the way the harness does:

    node main.ts

The process binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, and serves until `$MAKEFUN_ENV_URL/done`.

Referral: https://make.fun/r/0njr0f8w
