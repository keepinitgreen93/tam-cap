# TAM Cap operating costs

Checked 2026-10-28. Target: roughly $20/month. This is a usage estimate, not a spending cap. Cloudflare allowances are shared with other applications in the account. Resend uses the existing account.

## Runtime envelope

The deployed web and media containers each use standard-1 (4 GiB RAM, 0.5 vCPU, 8 GB disk), with one primary instance per service. Web sleeps after two idle minutes. Media sleeps after five idle minutes and retains active jobs. CPU is charged for actual use; RAM and disk for provisioned running time.

[Cloudflare container pricing](https://developers.cloudflare.com/containers/platform/pricing/) includes 25 GiB-hours RAM, 375 vCPU-minutes and 200 GB-hours disk in Workers Paid ($5/month). Overage rates are $0.0000025/GiB-second, $0.000020/vCPU-second and $0.00000007/GB-second respectively. Workers, Durable Objects, queues, AI and storage have separate meters.

Illustrative combined container running time, assuming the account allowances remain available and CPU is saturated throughout:

| Combined running hours/month | RAM | CPU upper estimate | Disk | Container subtotal |
| --- | ---: | ---: | ---: | ---: |
| 50 | $1.58 | $1.35 | $0.05 | $2.98 |
| 150 | $5.18 | $4.95 | $0.25 | $10.38 |
| 720 | $25.70 | $25.47 | $1.40 | $52.57 |

Add the account's $5 Workers plan and other meters. Keeping both containers awake all month doubles the 720-hour running quantity. A fifteen-minute maintenance schedule alone can wake web for roughly96 hours in a30-day month, before overlap with real traffic; include that in estimates. Maintenance was disabled during private acceptance and is enabled on the public production release.

## Media and AI

[R2 Standard](https://developers.cloudflare.com/r2/pricing/) includes10 GB-month,1 million Class A and10 million Class B operations monthly; then storage is $0.015/GB-month, writes $4.50/million and reads $0.36/million. Direct R2 Internet egress is free. Retained originals, edit outputs, previews and backups all consume storage. A100 GB retained library costs about $1.35/month in storage after the10 GB allowance, before operation rounding.

[Cloudflare Whisper turbo](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/) lists $0.000513/audio minute. One canonical pass over100 hours is about $3.08 before available AI allowances. Reprocessing/backfills add passes; text titles, summaries and chapters use a separate AI model/meter. Nova3 diagnostic probes are development usage and are not a production transcription cost forecast.

## Measured acceptance inputs

- Imported synthetic clip:17.133 seconds,11,911,996-byte original.
- Browser MediaRecorder capture:19 seconds in the UI,792,162-byte WebM original; real processed MP4 is19.255814 seconds and311,916 bytes. Inputs were synthetic canvas/speech, not a team member's screen.
- Distributed clients total about249 MB: Windows133,799,920 bytes; Apple Silicon Mac114,574,144 bytes; Chrome502,935 bytes. Download checksums are in distribution/checksums.txt.
- A real guest session produced a persisted analytics event in the separate D1 analytics database.

These functional measurements do not establish monthly team demand.

### Actual container usage

Read-only Cloudflare GraphQL queries covered **2026-10-21 00:00 UTC through 2026-10-28 00:40 UTC**, filtered exclusively to CapWeb and CapMedia. Returned usage falls on October 27 and 28. The [billing-usage dataset](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/) includes the micro-VM overhead; workload metrics are separate. The connected Cloudflare account supplied analytics access without another key. GraphQL needs the application IDs in dashed UUID format; the undashed IDs returned empty arrays rather than a permission error.

| Service | Billable CPU seconds | Running-hour equivalent at 4 GiB | Peak workload RAM |
| --- | ---: | ---: | ---: |
| CapWeb | 537.27 | 2.561 | 1.097 GiB |
| CapMedia | 74.80 | 0.515 | 0.391 GiB |
| Combined | 612.07 | 3.076 | — |

Allocated RAM totals **44,295.85 GiB-seconds** and allocated disk **88,591.70 GB-seconds**. Before included allowances, those meters correspond to about **$0.129** in container CPU/RAM/disk usage. They fit within the stated monthly container allowances if those allowances remain available; other account applications may consume them. This is a metered usage estimate, not a posted invoice or a claim of zero account cost. Cap-only aggregates and calculations are saved in [the usage evidence](evidence/2026-10-28-cap-container-usage.json).

The observed CPU ratio is 198.98 CPU seconds per combined running hour. Holding that ratio and the current instance sizes constant gives this conditional forecast:

| Combined running hours/month | RAM overage | CPU overage at observed ratio | Disk overage | Container subtotal |
| --- | ---: | ---: | ---: | ---: |
| 50 | $1.58 | $0.00 | $0.05 | $1.63 |
| 150 | $5.18 | $0.15 | $0.25 | $5.57 |
| 720 | $25.70 | $2.42 | $1.40 | $29.51 |

These are demand scenarios, not a projection of the seven-day query window. The small synthetic acceptance workload includes setup, idle time and retries; longer or higher-resolution media can change CPU demand. The first table remains the saturated-CPU upper scenario. For illustration, 150 combined running hours plus 100 audio hours and 100 GB of retained R2 data comes to about **$15.00** including the $5 plan, these container overages, Whisper and storage, before Workers/DO/queue requests, text AI, storage operations, container egress, shared-allowance contention or email charges. The roughly $20 target remains conditional. Keeping even one 4 GiB container awake continuously would exceed it on RAM and base-plan charges alone.

The web process already peaked above 1 GiB in these tests, so the 1 GiB basic instance is not established as a safe replacement. The media sample also does not establish memory needs for long/high-resolution jobs. No instance settings changed. AI inference totals cannot be attributed to Cap from application-filtered container metrics; no account-wide invoice or other customer financial data was queried.

## Controls and review

One media job runs at a time; containers scale to zero. Private storage and immutable job outputs prevent retries from overwriting source material. Avoid frequent external uptime checks against application pages, which wake the web container. Keep old originals until edited exports and backups are verified.

Review actual container running hours/CPU, R2 retained bytes/operations, AI minutes/tokens, D1 reads/writes/storage and Resend sends before importing the Loom library. If combined runtime approaches150 hours/month, assess reducing idle wakeups or container size using measured memory rather than assuming the $20 target still holds.

### Existing native budget notification

Read-only Cloudflare checks on2026-10-28 confirmed the account's existing **Default budget alert (auto-created)** is enabled with a **$10 account-wide usage-charge threshold**. Policy `5c7966bdba544c469d04f7dc98b88123` was created before this Cap setup and has one configured email destination. The existing policy and recipient were retained unchanged; the Cap owner mailbox is not a recipient. No new notification policy, verification message or test email was created, and delivery was not tested.

This is a shared-account control: other applications contribute to the threshold. It is not a Cap-specific $20 limit and does not pause or cap usage. Cloudflare's [budget-alert documentation](https://developers.cloudflare.com/billing/manage/budget-alerts/) defines its account-wide scope and informational behavior. Review or change the existing policy in the [account Notifications dashboard](https://dash.cloudflare.com/c1e96a4b36c73f3cf4ddf50a90082d94/notifications), or under Manage Account > Billing > Billable Usage > Budget alerts. No paid-plan upgrade was made.
