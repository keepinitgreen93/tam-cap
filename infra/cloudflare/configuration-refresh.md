# Runtime configuration refresh and session rotation

Worker secret publication and a running Node container are separate lifecycle events. Cloudflare documents that [`wrangler secret put` immediately deploys a Worker version](https://developers.cloudflare.com/workers/configuration/secrets/), while a [running container keeps its startup environment](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/). A new Worker can temporarily call an older Durable Object during [eventually consistent code rollout](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).

`runtime-env.ts` computes one SHA-256 fingerprint from sorted effective web environment values, the configured web image revision and deployment ID. Neither the fingerprint's persisted value nor its request header contains plaintext secrets. `CAP_WEB_IMAGE_REVISION` must identify the full pinned web image digest. `CapWeb` compares its persisted fingerprint at construction; on change it signals the existing web process to stop and waits for confirmed exit before accepting that configuration. It then starts the pinned image with the current effective environment on demand.

Every web request forwarded by the Worker receives the current fingerprint in a private internal header. The caller's copy is overwritten. `CapWeb` compares this value with its constructor's fingerprint and returns a non-cacheable 503 on mismatch or a missing header, before starting or forwarding to Node. It strips the header before the Node application sees the request. Public HTTP requests, workflow deliveries, scheduled maintenance and private media callbacks all use the same forwarding helper. Callback payloads and their existing media authentication header are preserved.

This prevents a new Worker with changed bindings from forwarding authentication requests into an older configuration once both versions implement this fence. The first deployment of the fence still has to converge away from older code that does not perform the comparison. Requests already in flight, or an older Worker reaching an older matching DO during rollout, are not retroactively blocked. Keep authentication unavailable to users during a planned secret rotation, drain active processing, and validate convergence before opening the application or requesting another login email.

## Operator sequence

1. Keep the public application gate closed and finish or drain active workflows and media processing before publishing application secrets or changing a pinned image. Media containers intentionally do not receive an automatic configuration restart, so publishing a new media image is not proof that a running media VM has changed.
2. Publish the intended secrets through protected input, then deploy the coherent Worker configuration with the correct `CAP_WEB_IMAGE_REVISION` and deployment ID. Prefer a single coordinated secret publication over unrelated individual updates. Do not print secret payloads or place them in command arguments or public files.
3. Allow the updated DO code to propagate. A 503 configuration-update response is an expected temporary failure during an old/new configuration mismatch. Do not clear persistent fingerprints, create another DO namespace, or weaken the comparison to bypass this state.
4. Warm the guarded application using an isolated request and verify behavior unique to the intended web image. On this release, the Windows and macOS download links are present only in the newer application image. A successful Worker deploy or Worker-owned download HEAD alone does not identify the running web image.
5. Before sending another login email, verify the current Node process uses the intended NextAuth secret. The existing `GET /api/auth/csrf` endpoint can prove this without signing in: NextAuth creates a CSRF cookie containing a random token and SHA-256 of `token + secret`. A private diagnostic compares that hash against the protected backup entirely in memory and reports only a match boolean and status. Do not print or retain the CSRF token/cookie, request headers or secret. Check several independent requests; investigate a mismatch or mixed results instead of retrying emails.
6. Sign in only after the configuration and image checks pass, then verify the session remains valid across fresh requests and a container idle/restart cycle. Rotating `NEXTAUTH_SECRET` intentionally invalidates previously issued JWTs, so validate a newly issued session rather than expecting an older session to survive.
7. Reopen the public application only after web and media image/configuration acceptance is complete. Resume scheduled maintenance and actual client acceptance separately.

Cloudflare describes old/new code overlap as typically seconds to minutes; it does not provide a hard rollout deadline on that page. Its [DO lifecycle documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) also explains that open I/O, timers and container monitoring can delay idle eviction. The configured two-minute web-container inactivity timeout is not a bound on DO reconstruction or deployment propagation. Judge readiness by the image and secret checks, not an elapsed sleep.

## Validation

The runtime contract tests cover new Worker to old DO rejection, forged caller-header replacement, missing-header rejection, successful refresh into a new DO, removal of the internal header before Node, preservation of pending callback bodies/authentication, and both workflow and maintenance delivery. Existing tests still cover actual process-exit acknowledgement, concurrent first-start coalescence and failure-closed refresh behavior.

```powershell
node --test infra/cloudflare/runtime.test.mjs infra/cloudflare/worker.test.mjs infra/cloudflare/workflow-store.test.mjs infra/cloudflare/maintenance.test.mjs infra/cloudflare/downloads.test.mjs
node node_modules/typescript/bin/tsc -p infra/cloudflare/tsconfig.runtime.json
```
