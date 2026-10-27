# Cloudflare cost envelope

The $20/month target is an operating target, not a billing cap or a measured forecast. Prices checked on 2026-10-27. The account already has Workers Paid; no plan upgrade was purchased. Other applications share the account's included allowances.

The web and media containers each use standard-1 (0.5vCPU, 4GiB memory, 8GB disk). Each has one named instance. Web sleeps after two idle minutes; media checks for active work before sleeping after five minutes. These bounds limit concurrency but do not cap monthly usage. Requests throughout the day can keep the web container awake.

[Container pricing](https://developers.cloudflare.com/containers/platform/pricing/): memory is $0.009/GiB-hour and disk $0.000252/GB-hour after included25GiB-hours/200GB-hours. One standard-1 therefore consumes $0.038016 per awake hour in memory and disk before allowances. CPU is billed on actual use at $0.072/vCPU-hour after6.25included vCPU-hours. The existing Workers plan is $5/month; Worker, Durable Object, network, log and queue overages are separate.

| Illustrative total awake hours across both containers | Memory and disk before account allowances |
| --- | ---: |
| 50 | $1.90 |
| 180 | $6.84 |
| 360 | $13.69 |
| 720 | $27.37 |

[R2 Standard](https://developers.cloudflare.com/r2/pricing/) is $0.015/GB-month after10GB, with free egress.100GB stored is about$1.35/month before request charges. Originals, edits, derived assets and backup copies all count toward storage.

[Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) Nova-3 batch transcription is $0.0052/audio minute;1,000processed minutes are $5.20 before daily included neurons. Provisional transcription plus a canonical full pass can process the same audio twice. The configured Llama3.1 8B FP8 text model costs $0.152/million input tokens and $0.287/million output tokens. These rates do not establish actual quality or token usage; both need live application verification.

For example,180combined awake hours,18actual vCPU-hours,100GB stored,1,000transcription minutes and small text generations can approach $20 including the $5base before other overages. Continuous web uptime alone can exceed the target. This example is arithmetic, not a forecast; measure real recording/edit workflows and inspect account usage before making a monthly promise.

Launch measurement must record media input/output bytes, processed audio duration (including retries/provisional passes), model token usage where supplied, and container awake/CPU consumption. Check Cloudflare billing and usage after the first representative team week. Do not disable recording or delete videos merely to hit a speculative budget.

Scheduled recovery runs every15minutes once maintenance is enabled. Even with no users, each invocation can wake the web container for its two-minute idle window: roughly96awake hours in a30day month, plus startup/processing time. Include this baseline in forecasts. Daily cleanup shares the03:00UTC recovery wakeup. Failed jobs retry through the durable queue and may add awake time.
