# TAM Cap operating costs

Checked 2026-10-27. Target: roughly $20/month. This is a usage estimate, not a spending cap. Cloudflare allowances are shared with other applications in the account. Resend uses the existing account.

## Runtime envelope

The deployed web and media containers each use standard-1 (4 GiB RAM, 0.5 vCPU, 8 GB disk), with one primary instance per service. Web sleeps after two idle minutes. Media sleeps after five idle minutes and retains active jobs. CPU is charged for actual use; RAM and disk for provisioned running time.

[Cloudflare container pricing](https://developers.cloudflare.com/containers/platform/pricing/) includes 25 GiB-hours RAM, 375 vCPU-minutes and 200 GB-hours disk in Workers Paid ($5/month). Overage rates are $0.0000025/GiB-second, $0.000020/vCPU-second and $0.00000007/GB-second respectively. Workers, Durable Objects, queues, AI and storage have separate meters.

Illustrative combined container running time, assuming the account allowances remain available and CPU is saturated throughout:

| Combined running hours/month | RAM | CPU upper estimate | Disk | Container subtotal |
| --- | ---: | ---: | ---: | ---: |
| 50 | $1.58 | $1.35 | $0.05 | $2.98 |
| 150 | $5.18 | $4.95 | $0.25 | $10.38 |
| 720 | $25.70 | $25.47 | $1.40 | $52.57 |

Add the account's $5 Workers plan and other meters. Keeping both containers awake all month doubles the 720-hour running quantity. A fifteen-minute maintenance schedule alone can wake web for roughly96 hours in a30-day month, before overlap with real traffic; include that in estimates. Maintenance is disabled during private acceptance.

## Media and AI

[R2 Standard](https://developers.cloudflare.com/r2/pricing/) includes10 GB-month,1 million Class A and10 million Class B operations monthly; then storage is $0.015/GB-month, writes $4.50/million and reads $0.36/million. Direct R2 Internet egress is free. Retained originals, edit outputs, previews and backups all consume storage. A100 GB retained library costs about $1.35/month in storage after the10 GB allowance, before operation rounding.

[Cloudflare Whisper turbo](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/) lists $0.000513/audio minute. One canonical pass over100 hours is about $3.08 before available AI allowances. Reprocessing/backfills add passes; text titles, summaries and chapters use a separate AI model/meter. Nova3 diagnostic probes are development usage and are not a production transcription cost forecast.

## Measured acceptance inputs

- Imported synthetic clip:17.133 seconds,11,911,996-byte original.
- Browser MediaRecorder capture:19 seconds in the UI,792,162-byte WebM original; real processed MP4 is19.255814 seconds and311,916 bytes. Inputs were synthetic canvas/speech, not a team member's screen.
- Distributed clients total about249 MB: Windows133,799,920 bytes; Apple Silicon Mac114,574,144 bytes; Chrome502,935 bytes. Download checksums are in distribution/checksums.txt.
- A real guest session produced a persisted analytics event in the separate D1 analytics database.

These measurements establish functional test sizes, not monthly team demand or an invoice. Container CPU seconds and running time must be checked in Cloudflare's account usage dashboard after representative team use. Do not infer a paid-usage total from successful requests or a storage sample.

## Controls and review

One media job runs at a time; containers scale to zero. Private storage and immutable job outputs prevent retries from overwriting source material. Avoid frequent external uptime checks against application pages, which wake the web container. Keep old originals until edited exports and backups are verified.

Review actual container running hours/CPU, R2 retained bytes/operations, AI minutes/tokens, D1 reads/writes/storage and Resend sends before importing the Loom library. If combined runtime approaches150 hours/month, assess reducing idle wakeups or container size using measured memory rather than assuming the $20 target still holds. No automatic billing emails or paid-plan upgrades were enabled by this document.
