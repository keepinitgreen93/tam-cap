# Cloudflare Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver a team Loom replacement from the Cap fork with Cloudflare hosting and Resend email.

**Architecture:** Preserve Cap's application and desktop contracts while replacing its MySQL and hosted-processing assumptions with Cloudflare persistence and execution. Implement adapters independently, then wire and verify vertical user flows before production cutover.

**Tech Stack:** Upstream Cap, Node 24, Bun 1.4.4, TypeScript, Drizzle, Cloudflare Workers/D1/R2/Containers/Queues/Workers AI, Resend.

**Spec:** docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md

## Global Constraints

- No Railway or AWS hosting; Resend is approved for email.
- Target approximately $20/month; no unverified cost or feature-parity promises.
- Production hostname: videos.trulyauthenticmarketing.com; owner: hello@trulyauthenticmarketing.com.
- Preserve original recordings, upstream license notices, and desktop/API compatibility.
- Secrets stay out of Git, logs, and chat. Production signup must be invite-controlled.
- No public video bucket. Existing TAM services and email records must remain intact.
- Source baseline: 97c8d634430e8785efb824299938066ea4b17f72.

## Review Focus

- Cross-user media or metadata access: denied without an explicit valid share.
- Container restart during import/edit: durable retry without duplicates.
- Malformed/overlapping ASR timestamps: reject or safely skip, never corrupt a timeline.
- MySQL-specific transaction/JSON/date semantics: validate equivalent SQLite behavior before switching the app.
- Failed migration or unavailable Loom source: retained exception record, no silent loss.

## Task 1: Source and infrastructure foundation

Files: infra/cloudflare/*, docs/superpowers/*, .gitignore.

- [x] Create fork and feature branch; preserve upstream remote and revision.
- [x] Establish the supported project-local toolchain and install the frozen lockfile.
- [x] Create a dedicated D1 database and private R2 bucket; record non-secret identifiers.
- [x] Add a small infrastructure Worker with health verification, private resource bindings, and no media/admin API exposure. This is infrastructure readiness only, not the Cap UI.
- [x] Verify build, typecheck, isolated tests, and deployed binding health without changing the production hostname.

## Task 2: D1 schema and persistence port

Files: packages/database/cloudflare/schema.ts, packages/database/cloudflare/index.ts, packages/database/drizzle.cloudflare.config.ts, packages/database/cloudflare/migrations/*, relevant tests; later packages/database/index.ts and all database callers.

- [x] Map every table/column/index/foreign key into explicit SQLite types, preserving application value shapes. Remaining collation and validation differences are documented in the package README.
- [x] Generate migration artifacts with Drizzle; do not hand-edit generated migration SQL.
- [x] Test schema creation, uniqueness, foreign keys, dates, booleans, JSON, and identifiers using SQLite/D1.
- [x] Inventory MySQL-specific caller and transaction candidates in a reproducible audit.
- [ ] Migrate each caller group with equivalent concurrency and ownership assertions.
- [ ] Wire Cap to D1 only once the caller audit and affected integration tests pass.

## Task 3: Cloudflare transcription

Files: apps/web/lib/cloudflare-transcription.ts, apps/web/workflows/transcribe.ts, packages/env/server.ts, apps/web/__tests__/unit/cloudflare-transcription.test.ts.

- [x] Test conversion of Nova-3 words to Cap transcript artifacts, including fillers and invalid timings.
- [x] Add explicit provider selection and typed Cloudflare request/response validation.
- [x] Replace direct AssemblyAI calls through a provider boundary; preserve existing default behavior outside the Cloudflare deployment.
- [x] Test provider failures/retries and run scoped formatter/type checks.

## Task 4: Runtime and durable jobs

Files: apps/web/next.config.mjs, apps/web/instrumentation.node.ts, apps/media-server/src/lib/job-manager.ts, infra/cloudflare/* and workflow adapters.

- [ ] Move migrations and bucket provisioning out of request/runtime startup.
- [ ] Package the supported web runtime and FFmpeg execution; pin source/images.
- [ ] Persist job state and retry ownership; adapt workflow runtime without silent fallbacks to external hosting.
- [ ] Test interrupted upload, processing, edit, and Loom import recovery with no duplicate outputs.

## Task 5: AI generation, editing, and team access

Files: apps/web/lib/ai/provider.ts, edit transcript/timeline modules, authentication and organization policy modules.

- [ ] Configure Cloudflare generation without external fallback credentials.
- [ ] Preserve Resend login/invites and restrict new membership to owner invitations.
- [ ] Verify filler edits, add safe silence-cut planning and preview/undo as required.
- [ ] Test ownership, share visibility, long recordings, overlap/noise, and failed processing.

## Task 6: Production and migration

- [ ] Run the spec's complete vertical acceptance flow with an owner and a member.
- [ ] Measure storage, recording/rendering minutes, AI usage, and idle runtime; configure bounded concurrency and usage notifications.
- [ ] Verify backup/restore and rollback.
- [ ] Attach the production hostname only after application acceptance passes.
- [ ] Inventory Loom source ownership/URLs, import a sample, then batch with reconciliation and playback checks.
- [ ] Security review followed by quality review; resolve material findings before launch.

## Execution record

The user's latest instruction authorizes implementation of the reviewed direction. Work proceeds in the newly created project branch without another approval loop. The initial foundation and adapters are milestones toward the full replacement, not completion of the app.

2026-10-27: Task 1 infrastructure is deployed and verified; Task 3 passes 182 scoped tests and a live synthetic-audio inference. QA's missing-duration finding was fixed by propagating trusted probe or segment-manifest duration, with failing-then-passing regressions. Task 2 has an additive 49-table D1 schema and passing persistence tests; caller migration remains outstanding. Tasks 4–6 are not implemented. The existing Cap application still uses MySQL. No Loom videos were migrated, no production hostname was attached, and no desktop replacement was installed. Resend sender domain `updates.trulyauthenticmarketing.com` was verified read-only.

The generated initial schema was applied to the new, dedicated remote database after local verification. Remote inspection confirms 49 application tables. Platform URL: https://tam-cap-platform.ciglesia.workers.dev/health (infrastructure only, `applicationReady: false`). R2 public access remains disabled; CORS permits only the proposed video application origin. Optional cleanup of project-local Wrangler scratch state was blocked by automatic approval review; it was left intact. Miniflare tests use fresh disposable state, not this scratch cache.
