# QA Report: Cloudflare Cap replacement

**Plan document:** `docs/superpowers/plans/2026-10-27-cloudflare-cap.md`, with its accepted design and `EXECUTION_LEDGER.md`
**Audit date:** 2026-10-28 UTC
**Base:** `97c8d634430e8785efb824299938066ea4b17f72`
**Application sources:** web `da9168de55d5e9138d6448569af5c56621854848`, media `b117f8d0b96fb1fa04793f7e8fa26c93a76a28e7`
**Head:** `codex/cloudflare-self-host`, including final release evidence and Chrome harness working changes
**Auditor:** independent release QA, applying `quality-stinger`
**State:** live release verified with explicit human-member and device acceptance qualifications

## Summary

The Cloudflare Cap site is live on the required hostname, and the supplied production owner flows verify recording, processing, transcription, AI chapters, filler/silence editing, export, original preservation and sharing. The generator and runtime recovery findings are closed; this auditor also checked the saved Chrome capture receipt and the post-edit restore receipt. No unresolved material application defect is confirmed by this bounded review; the invited human member has not accepted or recorded yet, so that part of the original vertical acceptance remains qualified rather than represented as tested.

Security ran before this review. `library/qa/security/2026-10-28-release-security-review.md` records the closed source findings and the qualified Zod backport; the advisory remains version-flagged. Hindsight is unavailable in this agent's tools, so no shared-memory result was fabricated.

## Scorecard

| Category | Status | Notes |
| --- | --- | --- |
| Completeness | ✅ | Application, Cloudflare services and client distribution are implemented; old-library migration is explicitly deferred. |
| Correctness | ✅ | Recorded production owner flows, recovery, saved Chrome capture/playback and isolated restore support the tested behavior. |
| Alignment | ✅ | Cloudflare plus Resend, private storage, controlled registration and user migration deferral match the approved scope. |
| Gaps | ⚠️ | Human member acceptance/use remains unobserved; native hardware and a destructive rollback are not claimed. |
| Detrimental | ✅ | Confirmed generator/recovery defects are closed; no further material application defect was confirmed in this bounded review. |

## Critical Issues (must fix)

None remain confirmed in the inspected application source and supplied release evidence.

Resolved findings retained for traceability:

- **Supported native-container image object**, `scripts/cloudflare/write-release-config.mjs:148-151`: the initial scalar image reference failed actual Wrangler4.152 validation. The corrected `{ image: reference }` representation passed47 generator contracts and independent actual Wrangler dry-run validation. Baseline/fixed logs: `tmp/qa-generator-shape-validation.log` and `tmp/qa-generator-shape-validation-fixed.log`.
- **Public production/client evidence**, `infra/cloudflare/releases/production-b117f8d0b96fb1fa04793f7e8fa26c93a76a28e7.json:20-25`: readiness and maintenance are enabled, `workers_dev=false`, and the exact public hostname serves the real Cap application. Native Chrome identity and completed capture/upload/playback are verified below; the human member qualification remains explicit.
- **Binding-only recovery**, `infra/cloudflare/runtime-worker.ts:141-172`: the coordinator observed503 to200 with the latest expected Worker version in approximately12 seconds without diagnostic tail, then successful new media callback/processing. Ordered configuration fencing retains durable state and prevents an older callback from resetting newer accepted configuration.

## Warnings (should fix)

- [ ] **Complete human member acceptance before describing that user's login and recording as tested**, `docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md:27`, `EXECUTION_LEDGER.md:17-19`.

  ```text
  Before production: owner/member login, the built-in browser recording/upload flow,
  desktop API contract checks, browser playback, unauthorized-access denial ... must pass.
  ```

  Owner login, member/invitation authorization contracts, delivered ordinary-Member invitation and production owner recording pass. The intended invitee's acceptance, personal sign-in and recording have not been observed. This is an outstanding human acceptance observation, not a confirmed application failure; do not impersonate the invitee or silently promote contract coverage to that live claim.

The prior documentation warning is closed: the ledger records current release status and the D1 README now labels the initial checklist as porting history with current cutover evidence.

## Suggestions (consider improving)

None. Broader proprietary Loom parity and optional product improvements are outside this audit.

## Plan Item Traceability

Statuses below distinguish implemented/tested source from outstanding live acceptance. A pending release gate is not represented as a missing implementation. The user explicitly deferred migration of the existing Loom library; no new Loom connection is required for launch.

| ID | Plan requirement | Status | Implementation location | Evidence and qualification |
| --- | --- | --- | --- | --- |
| G-01 | Cloudflare application hosting; Resend mail exception; no Railway/AWS hosting | ✅ | `infra/cloudflare/wrangler.runtime.jsonc:1`, `infra/cloudflare/runtime-env.ts:1`, `Dockerfile.cloudflare:1` | Private D1/analytics/workflow/media bindings and R2; AWS SDK naming does not establish AWS hosting. |
| G-02 | Approximately $20 target with measured usage, no unverified cap | ✅ | `infra/cloudflare/COSTS.md:1` | Cap-filtered billing metrics and conditional forecasts are documented; not an invoice or hard spending cap. |
| G-03 | Exact production hostname and owner | ✅ | `scripts/cloudflare/write-release-config.mjs:167`, `packages/database/cloudflare/team.ts:25` | Public HTTPS login/downloads and owner real OTP/session pass at the exact required hostname; owner is hello@trulyauthenticmarketing.com. |
| G-04 | Preserve originals, notices and desktop contracts | ✅ | `apps/web/actions/videos/save-edits.ts:121`, `apps/web/actions/videos/download.ts:87`, `infra/cloudflare/distribution/README.md:1` | Coordinator downloaded the pre-edit base with its unchanged SHA-256 after editing. Raw originals remain separate private objects. |
| G-05 | Protected secrets and invite-controlled signup | ✅ | `scripts/cloudflare/runtime-secrets.ps1:1`, `packages/database/cloudflare/team.ts:27`, `packages/database/cloudflare/access.ts:145` | Protected secrets and invite-controlled registration pass source/native contracts; owner production OTP/login and delivered ordinary-Member invitation are live verified. Human acceptance remains qualified. |
| G-06 | Private bucket and existing TAM resources preserved | ✅ | `infra/cloudflare/wrangler.runtime.jsonc:107`, `infra/cloudflare/downloads.ts:1` | Dedicated buckets and allowlisted downloads; no whole-bucket publicity is required. |
| G-07 | Imported source baseline retained | ✅ | `docs/superpowers/plans/2026-10-27-cloudflare-cap.md:21` | Git inventory is anchored to the specified upstream revision. |
| RF-01 | Cross-user media/metadata denied absent explicit share | ✅ | `apps/web/app/api/storage/object/route.ts:196`, `apps/web/app/api/playlist/route.ts:184`, `apps/web/actions/videos/download.ts:87` | Independent security/native D1 boundaries pass; coordinator observed anonymous private playlist/editor denial and no summary in private HTML. |
| RF-02 | Restart recovery with no duplicate import/edit publication | ✅ | `packages/workflow-cloudflare/index.mjs:49`, `infra/cloudflare/workflow-store.mjs:96`, `apps/web/workflows/edit-video.ts:110` | Native persistence/lease/replay tests, Restore across interruption, and no-tail ordered binding restart followed by successful media callback pass. Private-library live import remains deferred. |
| RF-03 | Invalid/overlapping ASR timing cannot corrupt a timeline | ✅ | `apps/web/lib/cloudflare-transcription.ts:55`, `apps/web/lib/edit-transcript.ts:531`, `apps/web/lib/silence-cuts.ts:82` | Typed bounded timings, overlap rejection and protected quiet subranges. Live export re-transcription preserved 23 intended non-filler words. |
| RF-04 | Deliberate MySQL-to-D1 semantic port | ✅ | `packages/database/cloudflare/atomic.ts:60`, `packages/database/cloudflare/index.ts:1`, `packages/database/cloudflare/schema.ts:1` | Native D1 race, rollback and caller tests; no interactive transaction emulation or SQL text rewriting. |
| RF-05 | Failed migration/source exceptions retained | ✅ | `apps/web/lib/loom-import-start.ts:1`, `apps/web/workflows/import-loom-video.ts:1` | Source/import replay cases are covered by specialist evidence; private-library live migration is deferred. |
| T1.1 | Fork/branch/upstream revision and license foundation | ✅ | `docs/superpowers/plans/2026-10-27-cloudflare-cap.md:21`, `infra/cloudflare/distribution/README.md:11` | Fork and source-offer branch exist; native packages retain upstream notices. |
| T1.2 | Supported toolchain and frozen lockfile | ✅ | `package.json:74`, `Dockerfile.cloudflare:1`, `.github/workflows/tam-web-images.yml:30` | Node24/Bun1.4.4; pinned web build and media-only workflow40619936877 succeed. Web paths are unchanged between da9168d and b117f8d. |
| T1.3 | Dedicated D1 and private R2 identifiers | ✅ | `infra/cloudflare/wrangler.runtime.jsonc:85` | Metadata, analytics and media/download resources are separated. |
| T1.4 | Infrastructure health is distinct from Cap readiness | ✅ | `infra/cloudflare/worker.ts:1`, `infra/cloudflare/runtime-worker.ts:1` | Infrastructure health is separate from actual public Cap UI, owner recording/editing and client acceptance. |
| T1.5 | Build/type/isolated/deployed checks without early hostname change | ✅ | `Dockerfile.cloudflare:16`, `scripts/cloudflare/verify-workflows.mjs:1` | Full web suite and image builds pass; public routing was enabled after core application acceptance. Client/human qualifications are explicit. |
| T2.1 | Explicit SQLite tables/types/indexes/FKs | ✅ | `packages/database/cloudflare/schema.ts:1`, `packages/database/cloudflare/README.md:1` | Encoding/collation limitations are documented; no claim of MySQL accent-insensitive collation equivalence. |
| T2.2 | Generated migrations with reproducible artifacts | ✅ | `packages/database/drizzle.cloudflare.config.ts:1`, `packages/database/cloudflare/generate-concurrency-migration.ts:1`, `packages/database/cloudflare/generate-validation-migration.ts:1` | Controlled migration path; application startup does not run it. |
| T2.3 | Schema/value/constraint and rollback tests | ✅ | `packages/database/cloudflare/database.test.ts:1` | Actual SQLite/D1 tests plus remote application behavior; package tests are distinct from the web-suite count. |
| T2.4 | Reproducible caller/transaction inventory | ✅ | `scripts/cloudflare/database-audit.mjs:1` | Audit outputs are candidates, not a claim that every match is a live MySQL use. |
| T2.5 | Equivalent ownership/concurrency across caller groups | ✅ | `packages/database/cloudflare/atomic.ts:60`, `packages/web-backend/src/Videos/persistence.ts:1` | Native D1 reservation, roster/source/lease races and publication rollback evidence across the ported groups. |
| T2.6 | Canonical D1 cutover after affected tests | ✅ | `packages/database/index.ts:1`, `packages/database/schema.ts:1`, `packages/database/cloudflare/application.ts:6` | Canonical accessor fails closed without the Cloudflare/D1 runtime. |
| T3.1 | Preserve filler words and valid timing in Cap transcript artifacts | ✅ | `apps/web/lib/cloudflare-transcription.ts:1`, `apps/web/__tests__/fixtures/cloudflare-whisper-response.ts:1` | Measured Nova drift led to Cloudflare Whisper turbo with VAD enabled;25-word filler and200-second410-token fixtures pass without guessed offsets. |
| T3.2 | Explicit typed provider boundary | ✅ | `apps/web/lib/transcription-provider.ts:13`, `apps/web/lib/cloudflare-transcription.ts:129` | Typed Cloudflare provider/parser/editor boundaries; final provider/VAD suite65 cases passes. |
| T3.3 | Preserve non-Cloudflare transcription default | ✅ | `apps/web/lib/transcription-provider.ts:42` | AssemblyAI default branch remains outside this deployment's configured Cloudflare provider. |
| T3.4 | Provider failure/retry and scoped checks | ✅ | `apps/web/lib/cloudflare-transcription.ts:175`, `apps/web/__tests__/unit/cloudflare-transcription.test.ts:1` | Invalid source/timings fail, transient HTTP failures retain retry classification. |
| T4.1 | No request-startup migrations/provisioning | ✅ | `apps/web/instrumentation.node.ts:18` | Cloudflare validation/readiness returns before the legacy migration/bucket-publication path. |
| T4.2 | Supported web/media packages and immutable pins | ✅ | `Dockerfile.cloudflare:1`, `scripts/cloudflare/write-release-config.mjs:133` | Pinned composed production release uses unchanged da9168d web and b117f8d media; generated image objects independently pass Wrangler validation. |
| T4.3 | Durable job ownership/retry state on Cloudflare | ✅ | `packages/workflow-cloudflare/index.mjs:49`, `infra/cloudflare/workflow-store.mjs:96` | Persisted outbox/lease/replay logic; media work is bounded rather than running MySQL/queues on ephemeral disks. |
| T4.4 | Interrupted uploads/processing/edits/imports do not duplicate publication | ✅ | `infra/cloudflare/workflow-store.test.mjs:1`, `apps/web/__tests__/unit/desktop-recording-output-replacement.test.ts:1` | Native interrupted-upload/processing/edit/import contracts pass; live Restore and ordered binding recovery pass. Private-library import E2E is user-deferred. |
| T5.1 | Cloudflare generation without outside fallback | ✅ | `apps/web/lib/ai/provider.ts:136` | Cloudflare-only account/model endpoint restrictions; real title/summary and200-second recording with three chapters verified. |
| T5.2 | Resend login/invites with restricted membership | ✅ | `packages/database/cloudflare/team.ts:27`, `packages/database/auth/auth-options.ts:79` | Production owner delivered OTP/login, native member/invitation policies and real delivered ordinary-Member invitation pass. Human invitee sign-in has not been observed. |
| T5.3 | Filler/silence edits with preview/undo/original preservation | ✅ | `apps/web/lib/edit-transcript.ts:585`, `apps/web/lib/silence-cuts.ts:82`, `apps/web/actions/videos/save-edits.ts:337` | Actual UI cut selection/Undo/Redo, 10.8667-second export, semantic re-transcription and original hash preservation are recorded by root. |
| T5.4 | Ownership, sharing, overlap/noise, failed processing and large media | ✅ | `apps/web/__tests__/unit/cloudflare-video-privacy.test.ts:1`, `apps/media-server/src/__tests__/lib/media-routes-real-world.integration.test.ts:1` | Native ownership/overlap/noise/recovery tests plus live short browser recordings and200-second complete transcription/AI pass; no universal acoustic/hardware workload claim. |
| T6.1 | Owner/member complete vertical flow | ⚠️ | `EXECUTION_LEDGER.md:16-18`, `apps/web/app/(org)/dashboard/caps/record/RecordVideoPage.tsx:1` | Owner production capture/upload/playback/edit completion passes; native member contracts and invitation delivery pass. Invitee acceptance/login/recording remains an explicit human observation gap. |
| T6.2 | Measured usage, concurrency and notifications | ✅ | `infra/cloudflare/COSTS.md:35`, `infra/cloudflare/COSTS.md:64`, `infra/cloudflare/runtime-worker.ts:1` | Existing enabled native $10 account-wide budget alert was verified read-only and retained; not a new Cap-specific alert or delivery test. |
| T6.3 | Backup/restore and rollback | ✅ | `scripts/cloudflare/backup-restore-drill.mjs:312`, `scripts/cloudflare/snapshot-import.mjs:15`, `infra/cloudflare/releasing.md:80` | Actual post-edit restore52 tables/16 rows, schema/row/media hashes, integrity/FK and cleanup pass. Current pins establish first production rollback baseline; no destructive downgrade or full-bucket DR claim. |
| T6.4 | Hostname only after acceptance | ✅ | `scripts/cloudflare/write-release-config.mjs:167` | Public required hostname/root/login/download/owner application flows pass; workers.dev disabled. Human member observation remains qualified separately. |
| T6.5 | Loom sample/batch migration and reconciliation | 🟦 | `EXECUTION_LEDGER.md:21`, `docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md:27` | Explicitly deferred by the user; preserve the old library and importer capability. |
| T6.6 | Security before QA, resolve material findings | ✅ | `library/qa/security/2026-10-28-release-security-review.md:1`, this report | Independent security preceded QA; material confirmed source findings and generator/recovery defects closed. Dependency/human/device proof limits remain explicit. |
| AC01 | Preserve upstream features, licenses and client contracts | ✅ | `infra/cloudflare/distribution/README.md:1`, `apps/desktop-gpui/src/distribution.rs:1` | Self-built client configuration and source/license offers are documented; no whole-Loom-parity claim. |
| AC02 | Equivalent D1 ownership/concurrency persistence | ✅ | `packages/database/cloudflare/atomic.ts:60`, `packages/database/cloudflare/application.ts:6` | Native D1 caller/race/rollback evidence and actual owner flows support the cutover. |
| AC03 | Private originals/derived assets and intentional sharing | ✅ | `apps/web/app/api/storage/object/route.ts:196`, `apps/web/actions/videos/download.ts:87` | Retained-original read/issuer fixes are independently reviewed; owner original hash and anonymous private-share denial are live verified by root. |
| AC04 | Actual Cap application on Cloudflare, controlled migrations | ✅ | `apps/web/instrumentation.node.ts:18`, `infra/cloudflare/runtime-worker.ts:82` | Actual Cap UI, owner upload/edit/transcription and processing run on the public Cloudflare deployment; controlled migrations are separate. |
| AC05 | Durable processing/edit/import recovery without duplicate publication | ✅ | `infra/cloudflare/workflow-store.mjs:96`, `apps/web/workflows/edit-video.ts:110` | Native lease/replay contracts, recovered Restore, and no-tail binding restart with subsequent media callback pass. Existing-library importer E2E is deferred. |
| AC06 | Words, fillers, timestamps and media alignment | ✅ | `apps/web/lib/cloudflare-transcription.ts:55`, `apps/web/lib/edit-transcript.ts:129` | 25-word filler fixture and23-word edited export retain intended speech;200-second VAD fixture410 spoken tokens passes. Production browser capture is COMPLETE after output-duration publication fix. |
| AC07 | Titles, summaries and chapters on Cloudflare | ✅ | `apps/web/workflows/generate-ai.ts:277` | Actual200-second clip3ard5ydjze241cs has COMPLETE transcript/AI and three chapters; clips below120 seconds intentionally omit chapters. |
| AC08 | Owner/member mail, invitations and controlled registration | ✅ | `packages/database/cloudflare/team.ts:27`, `packages/database/auth/auth-options.ts:79` | Owner production OTP delivered and actual login passed; native member/registration contracts and delivered ordinary-Member production invitation pass. Human acceptance remains pending, not impersonated. |
| AC09 | Filler/silence cleanup, preview, Undo, export and original | ✅ | `apps/web/actions/videos/save-edits.ts:337`, `apps/web/lib/silence-cuts.ts:82` | 17.133-second base to10.8667-second downloaded edit, all23 intended non-filler words, Undo/Redo/Listen/quiet cuts/original checksum/Restore pass. Production three-filler edit also completed. |
| AC10 | Owner/member recording, playback, sharing and denial | ⚠️ | `apps/web/app/(org)/dashboard/caps/record/RecordVideoPage.tsx:1`, `apps/web/actions/video/retry-processing.ts:50` | Actual owner MediaRecorder upload/pause/resume/playback and automatic raw-to-published transition pass; sharing/denial/native member contracts pass. Human member recording is not yet observed. |
| AC11 | Backup/restore, rollback, measured usage and bounded concurrency | ✅ | `scripts/cloudflare/backup-restore-drill.mjs:312`, `infra/cloudflare/COSTS.md:35`, `infra/cloudflare/releasing.md:80` | Post-edit52-table/16-row isolated restore with raw/edited hashes and cleanup; bounded runtime and Cap-only cost metrics verified. Existing account-wide alert retained; rollback baseline is pinned, not a destructive-downgrade test. |
| AC12 | Application works on the required public hostname | ✅ | `scripts/cloudflare/write-release-config.mjs:167` | Public HTTPS root/dashboard redirect to login; login/download200, RPC404; owner session/record/process/transcribe/edit pass on the requested hostname. |
| AC13 | Existing Loom inventory/import reconciliation | 🟦 | `EXECUTION_LEDGER.md:21` | Explicitly deferred by the user; not a launch blocker. |
| AC14 | Security then QA with no unresolved material issue | ✅ | `library/qa/security/2026-10-28-release-security-review.md:1`, this report | Security before QA; confirmed source/generator/recovery findings closed; late focused tests and production/client receipts reviewed. Human-member and dependency qualifications are retained. |
| AC15 | Cloudflare views and engagement analytics | ✅ | `packages/database/cloudflare/analytics/schema.ts:1`, `apps/web/app/s/[videoId]/Share.tsx:103` | Real guest view persisted and displayed by country/browser; owner created a comment and reaction through UI. Separate D1 analytics and metadata engagement operate without Tinybird. |
| AC16 | Desktop downloads and Chrome self-hosted connection | ✅ | `apps/web/data/self-hosted-downloads.ts:3`, `.github/workflows/tam-desktop-artifacts.yml:41`, `apps/chrome-extension/scripts/live-production-harness.mjs:126` | Public Windows x64/Mac ARM installers and manual Chrome ZIP pass package/configuration checks. Unmodified native Chrome identity plus synthetic tab capture/upload/processing/share playback pass. Native hardware remains device-side setup. |
| NG-01 | No substitute upload portal or premature full-parity promise | ✅ | `docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md:9` | Actual Cap fork/UI is preserved. This QA does not equate it with every proprietary Loom feature. |
| NG-02 | No public video bucket or destructive stored-state rollback | ✅ | `infra/cloudflare/downloads.ts:1`, `infra/cloudflare/releasing.md:80` | Allowlisted distribution is separate; runbooks preserve D1/R2/DO/queue state. |
| NG-03 | No old-library migration during this launch | ✅ | `EXECUTION_LEDGER.md:21` | User deferral is honored; no private Loom connection is requested. |

### Verification scope

Final public Worker version: `1ff9ac47-6fe5-413d-8f32-5458606d23e3`. Component provenance is recorded in `infra/cloudflare/releases/b117f8d-component-provenance.json`: web digest `0a73f2e8dd8871b217995e350f5ff36259e73d801e3655b96e95449793798541`, media digest `e5a10f85f72b7fb7a0b6b7ff08807733e87dc6222836024e39628102faeaddee`. This auditor independently confirmed unchanged web source paths between the two pinned revisions and read the generated readiness/maintenance flags as true.

The coordinator's unkeyed public checks report login/download200, root/dashboard307, RPC404; private playlist401, raw preview/editor/workflow/cron404, and all three installer HEADs200 with expected lengths. Production recording `jnyqnjkxtb1bb8t` automatically switched from raw playback to optimized19.255814-second MP4 without reload, completed transcription, then saved three filler removals to16.8185416667 seconds with no pending edit. Long clip `3ard5ydjze241cs` completed transcription/AI with three chapters.

This auditor read `.secrets/extension-production-live/capture-attempt-4-verified.json`: unmodified native action on the synthetic tab, `actualCaptureCompleted=true`, processing complete, raw440,537B and processed168,369B both200, share200, playback readyState4 at1920x1080, duration5.074333 seconds, advancing currentTime0.649551 and no media error. Video `9vhr6hd37sdtts5` contains synthetic tone/canvas only; `NO_AUDIO` transcription classification is expected for the absence of speech, not proof of speech transcription. Native identity had already passed without a shim. The harness's page-context network observer missed offscreen traffic; the existing saved clip and playback receipt resolved that observation gap without a new capture or client ZIP change.

Focused late checks reported by their owners: runtime49, generator47, transcription/VAD65, playback transition41, media route3 tests/31 assertions, and media workflow18. The media scoped typecheck retains three proven pre-existing diagnostics and introduced zero; it is not claimed as a wholly green media typecheck. No broad suite was repeated for this report.

This auditor inspected the plan, complete changed-file inventory, persistence/runtime entrypoints, provider/timeline boundaries, distribution/package configuration, operational controls and independent security/test handoffs. It did not re-audit all changed files line by line or rerun the long unit suite. The coordinator owns the live browser/media evidence; the independent fullunit4 receipt records 386 files, 5,101 pass, zero fail and five intentional skips, with late security additions explicitly covered separately rather than silently added to that count.

No new paid inference, server, external write, email or deployment was made by this final auditor. Earlier independent native alert checks used three read-only Cloudflare endpoints and found the existing enabled $10 policy; no policy or recipient changed and no delivery was tested. Markdown is ignored by this repository's Biome configuration, so report/Markdown validation uses scoped diff/structure/link checks rather than claiming Biome formatted Markdown.

The corrected release generator was checked independently against actual Wrangler4.152 with the actual production manifest and both readiness gates false. The private post-edit recovery receipt `.secrets/backups/1f2919d2-d815-4cbc-aa68-aaa31f5edcc4/report.json` reports `verified=true`, `schemaMatches=true`, `integrityOk=true`, zero FK violations,52 tables/16 rows, two matching full media samples, and confirmed database/sample deletion. No SQL, credential, request header or signed transfer URL was printed during this review. The authoritative SQLite projection preserves values rather than rewriting SQL-looking text in user content.

The native Windows installer is unsigned; the Mac ARM package is ad hoc signed and not notarized. The Chrome ZIP uses manual Load unpacked installation and is not a store publication. These are disclosed distribution characteristics, not evidence of native hardware recording, and are not silently promoted to such proof.

## Files Changed

Inventory snapshot: 2026-10-28T02:48:05+00:00; 731 unique implementation/operations paths from the baseline diff and current working tree. Change-domain summaries below are an inventory, not a claim of independent line-by-line semantic review of every file. The audit report itself is excluded.

- `.dockerignore` (M), Fork configuration or build-input integration.
- `.github/workflows/tam-desktop-artifacts.yml` (A), Fork-owned native/application image build workflow.
- `.github/workflows/tam-media-image.yml` (A), Final production release, bounded regression coverage or operational evidence.
- `.github/workflows/tam-web-images.yml` (A), Fork-owned native/application image build workflow.
- `.gitignore` (M), Fork configuration or build-input integration.
- `Dockerfile.cloudflare` (A), Native Node/Bun media application packaging and image build boundaries.
- `Dockerfile.cloudflare.dockerignore` (A), Native Node/Bun media application packaging and image build boundaries.
- `EXECUTION_LEDGER.md` (M), Approved plan, execution record, architecture or independent review evidence.
- `apps/chrome-extension/e2e/overlay-ui.spec.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/e2e/recording-upload.spec.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/e2e/self-hosted-instance.spec.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/e2e/webcam-start.spec.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/package.json` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/public/manifest.json` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/scripts/build-self-hosted.mjs` (A), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/scripts/live-production-harness.mjs` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/scripts/live-production-harness.test.mjs` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/scripts/live-staging-harness.mjs` (A), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/scripts/live-staging-harness.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/scripts/package-self-hosted.ps1` (A), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/self-hosted.json` (A), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/background/service-worker.ts` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/chrome.d.ts` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/content/bootstrap.ts` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/content/overlay.tsx` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/offscreen/recorder.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/src/offscreen/recorder.ts` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/options/main.tsx` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/shared/api.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/src/shared/api.ts` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/shared/instance.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/src/shared/instance.ts` (A), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/shared/page-nav.ts` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/shared/storage.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/src/shared/storage.ts` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/src/shared/types.ts` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/desktop-gpui/src/auth.rs` (M), Native fork server identity, distribution, profile or managed-update integration.
- `apps/desktop-gpui/src/diagnostics.rs` (M), Native fork server identity, distribution, profile or managed-update integration.
- `apps/desktop-gpui/src/distribution.rs` (A), Native fork server identity, distribution, profile or managed-update integration.
- `apps/desktop-gpui/src/installer.rs` (M), Native fork server identity, distribution, profile or managed-update integration.
- `apps/desktop-gpui/src/main.rs` (M), Native fork server identity, distribution, profile or managed-update integration.
- `apps/desktop-gpui/src/menus.rs` (M), Native fork server identity, distribution, profile or managed-update integration.
- `apps/desktop-gpui/src/settings_window.rs` (M), Native fork server identity, distribution, profile or managed-update integration.
- `apps/desktop-gpui/src/store.rs` (M), Native fork server identity, distribution, profile or managed-update integration.
- `apps/desktop-gpui/src/updates.rs` (M), Native fork server identity, distribution, profile or managed-update integration.
- `apps/desktop-gpui/tauri.tam.conf.json` (A), Native fork server identity, distribution, profile or managed-update integration.
- `apps/media-server/bun.lock` (M), Bounded media processing, immutable outputs, callback or silence-analysis integration.
- `apps/media-server/package.json` (M), Bounded media processing, immutable outputs, callback or silence-analysis integration.
- `apps/media-server/patches/zod@3.25.76.patch` (A), Bounded media processing, immutable outputs, callback or silence-analysis integration.
- `apps/media-server/src/__tests__/fixtures/browser-capture-duration.webm` (A), Final production release, bounded regression coverage or operational evidence.
- `apps/media-server/src/__tests__/index.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/media-server/src/__tests__/lib/media-routes-real-world.integration.test.ts` (M), Final production release, bounded regression coverage or operational evidence.
- `apps/media-server/src/__tests__/routes/process-idempotency.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/media-server/src/__tests__/silence-analysis.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/media-server/src/app.ts` (M), Bounded media processing, immutable outputs, callback or silence-analysis integration.
- `apps/media-server/src/lib/silence-analysis.ts` (A), Bounded media processing, immutable outputs, callback or silence-analysis integration.
- `apps/media-server/src/lib/silence-disk.ts` (A), Bounded media processing, immutable outputs, callback or silence-analysis integration.
- `apps/media-server/src/lib/silence-source.ts` (A), Bounded media processing, immutable outputs, callback or silence-analysis integration.
- `apps/media-server/src/routes/silence-analysis.ts` (A), Bounded media processing, immutable outputs, callback or silence-analysis integration.
- `apps/media-server/src/routes/video.ts` (M), Bounded media processing, immutable outputs, callback or silence-analysis integration.
- `apps/web/__tests__/e2e/agent-local-e2e.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/e2e/ai-provider-live-e2e.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/fixtures/cloudflare-whisper-long-response.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/fixtures/cloudflare-whisper-response.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/helpers/cloudflare-team.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/helpers/recording-d1-model.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/ai-generation-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/live-transcription-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/loom-concierge-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/loom-state-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/loom-workflow-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/transcribe-early-segments.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/transcribe-workflow.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/transcribe.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/transcript-reset-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/transcription-state-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/integration/translation-publication-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/account-deletion-request.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/add-folder-videos.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/admin-retry-blocked-recordings.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/agent-api-contract.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/agent-api-handler.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/agent-cap-operation-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/agent-management.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/agent-s3-endpoint-policy.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/agent-token-contract.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/agent-upload-entitlement.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/agent-write-contract.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/ai-provider.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/ai-run.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/analytics-track-route.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/api-cleanup-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/audio-level-publication.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/auth-options.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/caps-analytics-round-trips.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-analytics-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-comment-persistence.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-edit-publication.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-legacy-webhook-boundary.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-marketing-disabled.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-recording-persistence.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-runtime.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-sharing-persistence.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-transcription.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cloudflare-video-privacy.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/collection-settings-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/comment-delete-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/comment-reply-parent.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/content-transfer-actions-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/content-transfer-payload.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/content-transfer-workflow-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/content-transfer.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/cookie-write-site.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/dashboard-analytics-cap-access.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/dashboard-analytics-space-access.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/dashboard-video-count.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/delete-space.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/desktop-manifest-rebuild.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/desktop-recording-health.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/desktop-recording-jobs.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/desktop-recording-output-replacement.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/desktop-recording-publication.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/desktop-segments-finalization.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/desktop-segments-recovery.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/desktop-self-hosted-session.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/desktop-video-create.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/dev-reset-transcript.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/developer-actions.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/developer-api-auth.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/developer-credits-checkout.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/developer-credits-webhook.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/developer-cron-storage.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/developer-persistence-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/developer-upload-usage-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/docs-ask-route.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/edit-ai-content.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/edit-transcript.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/email-delivery-ui.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/embed-playback-speed.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/finalize-desktop-recording.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/folder-count.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/folder-parent-location.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/folder-videos.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/generate-ai-start.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/generic-processing-webhook-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/get-edit-transcript.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/get-space-video-ids.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/google-drive-storage.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/homepage-seo.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/hosted-operations-cloudflare.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/integration-installations-repository.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/invite-decline-pro-seat.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/invite-decline.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-download-route.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-file-cleanup.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-import-backfill.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-import-start.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-import-upload.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-import.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-importer-redrive.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-migration-inventory.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-operator-tools.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-preview-gif.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/loom-retry-processing.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/mcp-auth.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/mcp-data.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/media-multipart-context-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/media-processing-budget.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/media-processing-workflows.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/media-server-multipart.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/media-server-progress.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/messenger-actions-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/messenger-agent.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/messenger-support-email.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/mobile-cap-password-handler.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/mobile-caps-list.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/mobile-comment-parent.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/mobile-email-session.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/move-owned-videos.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/multipart-presign.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/new-media-comment-thumbnail.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/notification-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/notification-read-state.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/oauth-sign-in-errors.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/onboarding-organization-authorization.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/organization-invite-delivery.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/organization-settings-d1.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/organization-storage-s3-endpoint.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/pro-entitlement-grace.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/queue-video-transcription.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/recording-complete.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/recording-prepare.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/recording-storage-lifecycle.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/remove-organization-domain.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/remove-organization-member.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/reply-notification.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/save-video-edits-original-source.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/save-video-edits.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/segment-playlist-route.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/self-hosted-entitlements.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/share-cap-authorization.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/share-dashboard-destination.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/share-page-loading.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/share-page-round-trips.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/share-player-server-source-real.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/signed-baa-webhook.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/signed-baa.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/signed-upload-metadata.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/silence-analysis-actions.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/silence-analysis-contract.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/silence-analysis-workflow.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/silence-audio.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/silence-cuts.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/slack-app-manifest.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/space-page-round-trips.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/sso-auth.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/sso-billing.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/sso-login-pages.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/sso-self-hosted-boundary.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/sso-settings.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/storage-object-response-headers.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/storage-object-verification.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/toggle-pro-seat.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/transcript-publication.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/transcript-sidebar-search.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/transcription-provider.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/update-seat-quantity.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/upload-progress-tracker.test.ts` (M), Final production release, bounded regression coverage or operational evidence.
- `apps/web/__tests__/unit/verification-token.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-analytics-access.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-analytics-bulk.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-call-to-action-action.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-create-atomicity.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-download-key.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-download-menu.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-download-permissions.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-download-security.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-edit-actions.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-edit-operation.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-edit-processing.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-editing-base.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-metadata.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-pipeline-recovery.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-processing-recovery.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-processing-state.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-processing-status.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-processing.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-settings-action.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-sharing-default.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-status.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-storage-key.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-storage-names.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/video-viewer-invites.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/videos-policy.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/workflow-runtime-boundary.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/__tests__/unit/workspace-account.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/web/actions/admin/replace-video.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/admin/reprocess-video.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/analytics/track-user-signed-up.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/caps/share.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/collections/logo.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/collections/visibility.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/developers/add-domain.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/developers/create-app.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/developers/delete-app.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/developers/delete-video.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/developers/regenerate-keys.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/developers/remove-domain.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/developers/update-app.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/developers/update-auto-topup.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/folders/add-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/folders/get-folder-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/folders/move-items.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/folders/remove-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/folders/require-personal-folder.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/loom-concierge.tsx` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/loom.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/messenger.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/notifications/mark-as-read.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/notifications/update-preferences.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/authorization.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/check-domain.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/content-transfer.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/create-space.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/default-video-visibility.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/delete-space.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/domain-utils.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/get-organization-sso-data.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/get-subscription-details.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/manage-billing.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/remove-domain.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/remove-invite.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/remove-member.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/send-invites.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/settings.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/shareable-link-icon.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/signed-baa.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/space-authorization.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/sso.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/storage.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/toggle-pro-seat.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/update-details.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/update-domain.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/update-member-role.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/update-seat-quantity.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/update-space.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organization/upload-space-icon.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organizations/add-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organizations/get-organization-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/organizations/remove-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/spaces/add-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/spaces/get-space-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/spaces/get-user-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/spaces/remove-videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/video/create-for-processing.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/video/retry-processing.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/video/trigger-instant-recording-processing.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/video/trigger-processing.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/video/upload.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/call-to-action.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/delete-comment.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/download.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/edit-ai-content.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/edit-date.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/edit-title.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/edit-transcript.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/get-analytics.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/get-available-translations.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/get-edit-transcript.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/get-live-transcript.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/get-og-image.tsx` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/get-status.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/get-transcript.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/new-comment.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/new-media-comment.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/password.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/save-edits.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/settings.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/silence-analysis.ts` (A), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/translate-transcript.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/actions/videos/viewer-invites.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/(org)/dashboard/_components/Navbar/search.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/_components/Navbar/server.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/analytics/data.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/caps/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/dashboard-data.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/developers/apps/[appId]/videos/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/developers/credits/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/developers/developer-data.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/layout.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/settings/account/server.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/spaces/[spaceId]/actions.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/dashboard/spaces/[spaceId]/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/invite/[inviteId]/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/login/form.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/signup/form.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(org)/verify-otp/form.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(site)/download/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/(site)/layout.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/Layout/devtoolsServer.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/admin/replace-video/ReplaceVideoPanel.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/api/analytics/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/analytics/track/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/cron/analytics-cleanup/route.ts` (A), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/cron/developer-storage/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/desktop/[...route]/organizationStorage.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/desktop/[...route]/root.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/desktop/[...route]/s3Config.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/desktop/[...route]/session.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/desktop/[...route]/storage.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/desktop/[...route]/video.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/dev-reset-transcript/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/developer/credits/checkout/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/developer/sdk/v1/[...route]/upload.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/developer/sdk/v1/[...route]/video-create.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/developer/v1/[...route]/usage.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/developer/v1/[...route]/videos.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/docs/ask/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/internal/loom-imports/backfill/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/internal/loom-imports/csv/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/internal/loom-imports/reassign/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/invite/accept/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/invite/decline/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/mobile/[...route]/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/notifications/preferences/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/notifications/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/playlist/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/recording/prepare/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/settings/billing/baa/download/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/settings/billing/manage/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/settings/billing/subscribe/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/settings/user/name/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/storage/object/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/thumbnail/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/tools/loom-download/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/upload/[...route]/comment-media.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/upload/[...route]/multipart.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/upload/[...route]/recording-complete.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/upload/[...route]/signed.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/utils.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/v1/[...route]/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/video/ai/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/video/comment/delete/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/video/domain-info/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/video/metadata/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/video/transcribe/status/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/videos/[videoId]/retry-ai/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/videos/[videoId]/retry-transcription/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/webhooks/media-server/multipart/[action]/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/webhooks/media-server/progress/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/api/webhooks/stripe/route.ts` (M), Application action/API persistence, authorization or publication integration.
- `apps/web/app/cli/authorize/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/embed/[videoId]/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/_components/CapVideoPlayer.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/_components/ProgressCircle.tsx` (M), Final production release, bounded regression coverage or operational evidence.
- `apps/web/app/s/[videoId]/_components/ShareHeader.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/_components/VideoDownloadMenu.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/edit/EditVideoClient.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/edit/TranscriptSidebar.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/edit/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/components/forms/server.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/components/pages/SelfHostedDownloadPage.tsx` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/data/self-hosted-downloads.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/instrumentation.node.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/Notification.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/account-deletion-request.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/admin-access.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/admin-reprocess-state.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/agent-api-cleanup.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/agent-management.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/agent-token.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/agent-write.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/ai-content-metadata.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/ai-generation-entitlement.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/ai/provider.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/ai/run.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/audio-level-publication.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/baa/billing.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/cap-analytics-access.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/chrome-extension.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/cloudflare-compute-access.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/cloudflare-runtime.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/cloudflare-transcription.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/comment-persistence.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/comment-reply-parent.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/content-transfer-payload.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/content-transfer.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/create-recording-upload.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-manifest-rebuild.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-recording-health.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-recording-jobs.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-recording-organization.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-recording-publication.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-recording-source.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-recording-upload-status.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-reupload.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-segments-finalization.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/desktop-segments-recovery.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/developer-credits.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/developer-persistence.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/developer-usage.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/edit-transcript-storage.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/edit-transcript.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/folder.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/generate-ai.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/google-drive-storage-quota-cache.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/google-drive-storage-quota.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/instance-admin.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/integrations/installations.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/live-transcribe-core.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/live-transcribe.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-concierge.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-csv-import.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-deferred-processing.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-file-cleanup.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-import-artifacts.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-import-backfill.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-import-reassign.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-import-redrive.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-import-start.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-import-state.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-import-upload.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-media-dispatch.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-migration-inventory.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/loom-preview-gif.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/mcp-auth.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/mcp-cleanup.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/mcp-data.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/media-multipart-context.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/media-processing-budget.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/messenger/agent.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/messenger/data.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/messenger/self-hosted-prompt.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/messenger/supermemory.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/messenger/support-email.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/org-pro.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/organization-invite-read.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/organization-provisioning.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/organization-settings-persistence.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/public-collections.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/public-share-video.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/queue-video-transcription.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/recording-upload-state.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/server.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/share-dashboard-destination.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/share-web-url.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/shareable-link-quota.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/sharing-persistence.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/silence-analysis-contract.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/silence-analysis-storage.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/silence-audio.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/silence-cuts.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/sso/billing.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/sso/workos.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/storage-transcript-store.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/sync-video-storage-names.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/transcribe.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/transcript-publication.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/transcription-config.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/transcription-dispatch.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/transcription-provider.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/translation-cache.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-download-permissions.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-edit-comment-remap.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-edit-operation.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-edit-processing.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-edit-progress.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-editing-base.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-metadata.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-ownership-transfer.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-pipeline-recovery.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-processing-recovery.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-processing-state.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-processing.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-storage.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/lib/video-view-count.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/next.config.mjs` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/package.json` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/proxy.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/tsconfig.cloudflare.json` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/utils/sql.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/workflows/admin-reprocess-video.ts` (D), Cloudflare durable application job and publication integration.
- `apps/web/workflows/agent-cap-operation.ts` (M), Cloudflare durable application job and publication integration.
- `apps/web/workflows/edit-video.ts` (M), Cloudflare durable application job and publication integration.
- `apps/web/workflows/finalize-desktop-recording.ts` (M), Cloudflare durable application job and publication integration.
- `apps/web/workflows/generate-ai.ts` (M), Cloudflare durable application job and publication integration.
- `apps/web/workflows/import-loom-video.ts` (M), Cloudflare durable application job and publication integration.
- `apps/web/workflows/live-transcribe.ts` (M), Cloudflare durable application job and publication integration.
- `apps/web/workflows/process-video.ts` (M), Cloudflare durable application job and publication integration.
- `apps/web/workflows/silence-analysis.ts` (A), Cloudflare durable application job and publication integration.
- `apps/web/workflows/transcribe.ts` (M), Cloudflare durable application job and publication integration.
- `apps/web/workflows/transfer-organization-content.ts` (M), Cloudflare durable application job and publication integration.
- `apps/web/workflows/video-processing-status.ts` (M), Cloudflare durable application job and publication integration.
- `bun.lock` (M), Pinned dependency/toolchain or package contract changes.
- `docs/superpowers/plans/2026-10-27-cloudflare-cap.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/reports/2026-10-27-cost-envelope.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/reports/2026-10-27-foundation-qa.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/reports/2026-10-27-runtime-recovery.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/reports/2026-10-27-security-review.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `infra/cloudflare/COSTS.md` (M), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/README.md` (M), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/backup-restore.md` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/cap.env.example` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/configuration-refresh.md` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/distribution/README.md` (M), Client artifact manifest, checksums or managed-distribution instructions.
- `infra/cloudflare/distribution/checksums.txt` (A), Client artifact manifest, checksums or managed-distribution instructions.
- `infra/cloudflare/distribution/manifest.json` (A), Client artifact manifest, checksums or managed-distribution instructions.
- `infra/cloudflare/downloads.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `infra/cloudflare/downloads.ts` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/evidence/2026-10-28-cap-container-usage.json` (A), Cap-filtered non-secret operational usage/restart evidence.
- `infra/cloudflare/evidence/2026-10-28-cap-media-placement.json` (A), Cap-filtered non-secret operational usage/restart evidence.
- `infra/cloudflare/maintenance.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `infra/cloudflare/maintenance.ts` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/package-lock.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/package.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/r2-cors.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/releases/b117f8d-component-provenance.json` (A), Final production release, bounded regression coverage or operational evidence.
- `infra/cloudflare/releases/production-04f7c07b02bd2742ff5183c53875e9647698a7e5-wrangler4152.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/releases/production-b117f8d0b96fb1fa04793f7e8fa26c93a76a28e7.json` (A), Final production release, bounded regression coverage or operational evidence.
- `infra/cloudflare/releases/production-da9168de55d5e9138d6448569af5c56621854848.json` (A), Final production release, bounded regression coverage or operational evidence.
- `infra/cloudflare/releases/staging-da9168de55d5e9138d6448569af5c56621854848.json` (A), Final production release, bounded regression coverage or operational evidence.
- `infra/cloudflare/releasing.md` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/request-headers.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `infra/cloudflare/request-headers.ts` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/runtime-env.ts` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/runtime-worker.ts` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/runtime.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `infra/cloudflare/tsconfig.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/tsconfig.runtime.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/worker.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `infra/cloudflare/worker.ts` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/workflow-store.mjs` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/workflow-store.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `infra/cloudflare/wrangler.jsonc` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/wrangler.runtime.jsonc` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `library/qa/security/2026-10-27-zod-v3-backport.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `library/qa/security/2026-10-28-cloudflare-preflight.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `library/qa/security/2026-10-28-release-security-review.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `package.json` (M), Pinned dependency/toolchain or package contract changes.
- `packages/database/auth/auth-options.ts` (M), Cloudflare-compatible authentication and membership behavior.
- `packages/database/auth/drizzle-adapter.ts` (M), Cloudflare-compatible authentication and membership behavior.
- `packages/database/auth/identity.ts` (A), Cloudflare-compatible authentication and membership behavior.
- `packages/database/auth/session.ts` (M), Cloudflare-compatible authentication and membership behavior.
- `packages/database/auth/sso.ts` (M), Cloudflare-compatible authentication and membership behavior.
- `packages/database/auth/stripe-customer.ts` (M), Cloudflare-compatible authentication and membership behavior.
- `packages/database/cloudflare/README.md` (M), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/access.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/ai-generation.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/application.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/index.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/migrations/0000_analytics_initial.sql` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/migrations/meta/0000_snapshot.json` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/migrations/meta/_journal.json` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/repository.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/schema.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/test-runtime.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/application.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/atomic.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `packages/database/cloudflare/atomic.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/bridge.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/caller-audit.json` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/concurrency-schema.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/database.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `packages/database/cloudflare/editing-base.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/generate-concurrency-migration.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/generate-validation-migration.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/index.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/loops.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/migrations/0000_rare_robbie_robertson.sql` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/migrations/0001_d1_concurrency.sql` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/migrations/0002_d1_validation.sql` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/migrations/meta/0000_snapshot.json` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/migrations/meta/0001_snapshot.json` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/migrations/meta/0002_snapshot.json` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/migrations/meta/_journal.json` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/mutation-counts.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/organization-delete.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/pro-seat.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/schema.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/team.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/test-runtime.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/transcript-publication.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/transcription-state.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/validation-contract.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/validation-preflight.sql` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/validation.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `packages/database/drizzle.analytics.config.ts` (A), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/drizzle.cloudflare.config.ts` (A), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/drizzle.config.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/index.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/legacy/index.ts` (A), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/legacy/schema.ts` (A), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/loops/health.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/loops/jobs.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/loops/profile.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/loops/queue.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/loops/worker.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/migrate.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/migrations/orgid_backfill.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/migrations/space_member_role_backfill.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/package.json` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/pro-seat-subscription.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/schema.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/transcript-encryption.ts` (A), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/types/metadata.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/database/video-sharing-default.ts` (M), Shared database/provider contract and Cloudflare cutover integration.
- `packages/env/server.ts` (M), Shared package/type/provider integration for the Cloudflare fork.
- `packages/utils/src/constants/plans.ts` (M), Shared package/type/provider integration for the Cloudflare fork.
- `packages/web-backend/src/AgentAuth.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/AgentManagement.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Analytics/index.ts` (A), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Auth.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/CloudflareDatabase.ts` (A), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Extension/Extensions.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Folders/FoldersPolicy.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Folders/FoldersRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Folders/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Folders/persistence.ts` (A), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/ImageUploads/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Organisations/OrganisationsPolicy.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Organisations/OrganisationsRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Organisations/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Rpcs.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/S3Buckets/S3BucketAccess.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/S3Buckets/S3BucketsRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/S3Buckets/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Spaces/SpacesPolicy.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Spaces/SpacesRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Spaces/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/GoogleDrive.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/StorageRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/persistence.ts` (A), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/recording-output.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Users/UsersOnboarding.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Users/UsersRpcs.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Users/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/VideosPolicy.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/VideosRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/persistence.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `packages/web-backend/src/Videos/persistence.ts` (A), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/snapshot-view-policy.ts` (A), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-domain/src/Storage.ts` (M), Shared package/type/provider integration for the Cloudflare fork.
- `packages/workflow-cloudflare/index.d.ts` (A), Durable Cloudflare workflow transport and runtime adapter.
- `packages/workflow-cloudflare/index.mjs` (A), Durable Cloudflare workflow transport and runtime adapter.
- `packages/workflow-cloudflare/package.json` (A), Durable Cloudflare workflow transport and runtime adapter.
- `packages/workflow-cloudflare/transport.mjs` (A), Durable Cloudflare workflow transport and runtime adapter.
- `patches/zod@3.25.76.patch` (A), Bounded dependency-advisory mitigation patch.
- `scripts/bundle-gpui.mjs` (M), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/backup-restore-drill.mjs` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/backup-restore-drill.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `scripts/cloudflare/database-audit.mjs` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/media-image-workflow.test.mjs` (A), Final production release, bounded regression coverage or operational evidence.
- `scripts/cloudflare/metadata-snapshot.ps1` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/publish-build-credentials.ps1` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/runtime-secrets.ps1` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/snapshot-import.mjs` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/snapshot-import.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `scripts/cloudflare/validation-preflight.mjs` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/verify-desktop-artifact.mjs` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/verify-workflows.mjs` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/web-image-workflow.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `scripts/cloudflare/write-release-config.mjs` (A), Reproducible build, audit, release, recovery or validation tooling.
- `scripts/cloudflare/write-release-config.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `scripts/loops/database.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `scripts/tam-desktop-config.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `scripts/verify/zod-collection-bounds.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
