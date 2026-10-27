# QA Report: Cloudflare Cap foundation milestone

**Plan document:** `docs/superpowers/plans/2026-10-27-cloudflare-cap.md`
**Specification:** `docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md`
**Audit date:** 2026-10-27
**Base:** upstream `97c8d634430e8785efb824299938066ea4b17f72`
**Head:** `codex/cloudflare-self-host`, uncommitted working tree
**Auditor:** quality-worker-bee, after the bounded security review

## Summary

The isolated infrastructure, additive D1 adapter, and transcription milestone pass this bounded review after correction of the duration-propagation finding. This is not acceptance of the full Cap replacement: application persistence, runtime/jobs, team access, editing acceptance, production cutover, and Loom migration remain unfinished. Preserve the documented D1 integration gates and repeat security and quality review for the completed application.

## Scorecard

| Category | Status | Notes |
| --- | --- | --- |
| Completeness | ✅ | Assessed Task 1, additive Task 2 schema/adapter, and Task 3 only; later tasks remain pending. |
| Correctness | ✅ | Missing stored duration now falls back to validated probe or segment duration; independent regressions passed. |
| Alignment | ✅ | Private infrastructure, explicit provider selection, and additive persistence respect staged rollout. |
| Gaps | ⚠️ | Real desktop fragments, long recordings, and end-to-end application behavior remain rollout gates. |
| Detrimental | ✅ | No confirmed new security or data-integrity issue within the reviewed milestone; no application D1 switch. |

## Critical Issues (must fix)

None within the isolated milestone. Production readiness is not granted.

## Warnings (should fix)

None outstanding within the milestone.

Resolved during review: missing database duration previously failed Cloudflare transcription despite a valid extraction duration. The implementer changed `apps/web/workflows/transcribe.ts:84-93` and `apps/web/workflows/transcribe.ts:155-158` to carry and validate extraction duration; probe and normal segment fallback return it at lines 546 and 567, and backfill retains original-timeline duration at lines 231-238. Independent regressions now pass for null/zero database duration, saved/probed original-media duration, and a segment fallback whose 4,500 ms source exceeds its last spoken word at 1,000 ms. The provider still refuses inference when no valid duration is available. Unknown-duration local-FFmpeg sources remain outside the verified Cloudflare runtime; Task 4 must establish that runtime's media probe contract.
## Suggestions (consider improving)

None.

## Plan Item Traceability

Status: ✅ verified or evidenced within milestone; ⚠️ partial; 🟦 intentionally pending outside milestone.

| # | Plan requirement | Status | Implementation / evidence | Notes |
| --- | --- | --- | --- | --- |
| 1.1 | Fork, branch, upstream revision | ✅ | Current branch and HEAD; plan source baseline | Remote fork work reported by parent. |
| 1.2 | Supported tools and dependencies | ✅ | Node 24 executable used for independent tests; `bun.lock` | Installation evidence supplied by parent. |
| 1.3 | Dedicated D1/private R2 | ✅ | `infra/cloudflare/wrangler.jsonc` | Parent verified dedicated resources and disabled public access. |
| 1.4 | Health Worker only | ✅ | `infra/cloudflare/worker.ts` | Only GET /health; explicitly `applicationReady: false`. |
| 1.5 | Build/typecheck/tests/deployed binding health | ✅ | Worker tests and parent verification | No production hostname attached. |
| 2.1 | Tables, columns, indexes, foreign keys | ✅ | `packages/database/cloudflare/schema.ts`, `database.test.ts` | 49-table structural comparison; remaining semantic limits explicitly documented. |
| 2.2 | Generated migrations | ✅ | `packages/database/cloudflare/migrations`, Drizzle config | Generation provenance reported by implementer; no manual generated edits observed in audit. |
| 2.3 | D1 value/constraint tests | ✅ | `packages/database/cloudflare/database.test.ts` | Eight tests independently passed in Miniflare D1. |
| 2.4 | Inventory and migrate MySQL callers | ⚠️ | `caller-audit.json`, adapter README | Inventory exists; caller migration remains pending. |
| 2.5 | Wire D1 only after integration gates | 🟦 | Existing `packages/database/index.ts` unchanged | No premature switch; transactions explicitly reject before callbacks. |
| 3.1 | Fillers and malformed timestamps | ✅ | Cloudflare tests; existing edit-transcript safety checks | Overlap is preserved for existing safe-cut rejection. |
| 3.2 | Explicit provider and validation | ✅ | `transcription-config.ts`, `cloudflare-transcription.ts` | No external fallback when Cloudflare selected. |
| 3.3 | Shared boundary/default preservation | ✅ | `transcription-provider.ts`, workflow changes | Defaults preserved; extraction-duration regression repaired. |
| 3.4 | Failure/retry and scoped checks | ✅ | Provider tests; implementer check report | Retryable HTTP failures remain errors; permanent failures become FatalError. |
| 4.1 | Move runtime provisioning/migrations | 🟦 | Future runtime work | Additive package itself never migrates on requests. |
| 4.2 | Package web and FFmpeg runtime | 🟦 | Future runtime work | Health Worker is not the app. |
| 4.3 | Durable job state/retry ownership | 🟦 | Future runtime work | Existing workflow runtime not ported. |
| 4.4 | Interrupted operation recovery | 🟦 | Future integration tests | No restart-recovery acceptance claimed. |
| 5.1 | Cloudflare generation | 🟦 | Provisional `cap.env.example` | No real generation acceptance yet. |
| 5.2 | Resend/invite-controlled membership | 🟦 | Existing auth preserved; sender checked by parent | Application access flow not accepted. |
| 5.3 | Filler/silence preview/undo | 🟦 | Existing edit logic inspected for boundary compatibility | Silence feature and end-to-end editing remain pending. |
| 5.4 | Ownership/sharing/long/noisy/failed media | 🟦 | Future acceptance tests | Synthetic inference is insufficient for these gates. |
| 6.1 | Owner/member vertical acceptance | 🟦 | Future production gate | Not run. |
| 6.2 | Measured cost/concurrency/notifications | 🟦 | Future production gate | No monthly cost guarantee. |
| 6.3 | Backup/restore/rollback | 🟦 | Future production gate | Not accepted. |
| 6.4 | Production hostname | 🟦 | No route configured | Correctly deferred. |
| 6.5 | Loom sample/batches/reconciliation | 🟦 | Future migration work | No imported library claimed. |
| 6.6 | Security then quality before launch | ⚠️ | Security report and this report | Foundation reviews only; repeat for final application. |
| NG-1 | No premature full-replacement claim | ✅ | Worker response, infrastructure README, execution record | Explicit milestone distinction retained. |
| NG-2 | No public media/admin exposure or unrelated service changes | ✅ | Worker route inspection and parent privacy checks | No launch hostname in infrastructure configuration. |
| NG-3 | No AWS/Railway or external transcription fallback | ✅ | Cloudflare endpoint and explicit provider branch | Default AssemblyAI retained solely for existing deployments. |

Independent verification used Node 24: infrastructure 3/3; Miniflare D1 8/8; transcription unit/provider/workflow tests 35/35 across four files after the repair. The implementer separately reported 182 tests across eight suites and scoped type/format checks; the parent reported live health HTTP 200, private R2 settings, and a synthetic 8.389-second Nova-3 inference with 17 words including Um/Uh. Those live observations were not independently repeated by this reviewer. Parent applied the generated migration to the dedicated remote D1 during review; this report does not assert remote row/count verification. Full workspace checks, actual desktop fragmented-media transcription, long-recording inference, and complete application acceptance were not run in this bounded review.

## Files Changed

- `.gitignore` (M): allow milestone documents and ignore Wrangler/local secrets.
- `apps/web/__tests__/integration/transcribe-early-segments.test.ts` (M): normal segment-fallback duration regression.
- `apps/web/__tests__/integration/transcribe-workflow.test.ts` (M): Cloudflare artifact persistence and measured-duration regressions.
- `apps/web/__tests__/unit/cloudflare-transcription.test.ts` (A): conversion and request validation cases.
- `apps/web/__tests__/unit/transcription-provider.test.ts` (A): provider selection and no-fallback coverage.
- `apps/web/actions/videos/get-status.ts` (M): provider-aware availability.
- `apps/web/app/s/[videoId]/page.tsx` (M): provider-aware transcript availability.
- `apps/web/lib/cloudflare-transcription.ts` (A): Nova-3 request/response adapter.
- `apps/web/lib/live-transcribe.ts` (M): provider-aware live trigger.
- `apps/web/lib/transcribe.ts` (M): provider-aware canonical trigger.
- `apps/web/lib/transcription-config.ts` (A): credential/selection availability helper.
- `apps/web/lib/transcription-provider.ts` (A): shared provider boundary.
- `apps/web/workflows/finalize-desktop-recording.ts` (M): provider-aware finalization trigger.
- `apps/web/workflows/live-transcribe.ts` (M): shared provider and model provenance.
- `apps/web/workflows/transcribe.ts` (M): shared provider and duration/content-type forwarding.
- `bun.lock` (M): D1 test/type dependencies.
- `docs/superpowers/plans/2026-10-27-cloudflare-cap.md` (A): staged implementation and execution record.
- `docs/superpowers/reports/2026-10-27-foundation-qa.md` (A): this bounded audit.
- `docs/superpowers/reports/2026-10-27-security-review.md` (A): preceding security review.
- `docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md` (A): accepted architecture and acceptance gates.
- `infra/cloudflare/README.md` (A): resource and deployment limits.
- `infra/cloudflare/cap.env.example` (A): provisional deployment variables without secrets.
- `infra/cloudflare/package.json` (A): scoped infrastructure commands.
- `infra/cloudflare/r2-cors.json` (A): explicit browser origin policy.
- `infra/cloudflare/tsconfig.json` (A): scoped Worker typecheck.
- `infra/cloudflare/worker.test.mjs` (A): health/failure/route tests.
- `infra/cloudflare/worker.ts` (A): isolated health endpoint.
- `infra/cloudflare/wrangler.jsonc` (A): dedicated bindings, no production route.
- `packages/database/cloudflare/README.md` (A): semantics and mandatory cutover gates.
- `packages/database/cloudflare/caller-audit.json` (A): migration candidate inventory.
- `packages/database/cloudflare/database.test.ts` (A): actual D1 schema/adapter tests.
- `packages/database/cloudflare/index.ts` (A): additive adapter and transaction guard.
- `packages/database/cloudflare/migrations/0000_rare_robbie_robertson.sql` (A): generated initial schema.
- `packages/database/cloudflare/migrations/meta/0000_snapshot.json` (A): generated snapshot.
- `packages/database/cloudflare/migrations/meta/_journal.json` (A): generated migration journal.
- `packages/database/cloudflare/schema.ts` (A): SQLite schema port.
- `packages/database/drizzle.cloudflare.config.ts` (A): SQLite migration generation.
- `packages/database/package.json` (M): additive exports and test/generation commands.
- `packages/env/server.ts` (M): Cloudflare transcription variables.
- `scripts/cloudflare/database-audit.mjs` (A): repeatable caller inventory.

Report validation: Biome has no Markdown handler and reported zero matched files; structure and whitespace were checked directly. `git diff --check` passed for tracked changes.
