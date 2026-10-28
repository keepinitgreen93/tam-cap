# QA Report: Cloudflare Cap replacement

**Plan document:** `docs/superpowers/plans/2026-10-27-cloudflare-cap.md`, with its accepted design and `EXECUTION_LEDGER.md`
**Audit date:** 2026-10-28 UTC
**Base:** `97c8d634430e8785efb824299938066ea4b17f72`
**Application image source:** `04f7c07b02bd2742ff5183c53875e9647698a7e5`
**Head:** `codex/cloudflare-self-host`, with coordinated runtime/restore-tool working changes
**Auditor:** independent release QA, applying `quality-stinger`
**State:** provisional source/evidence review; final production acceptance pending

## Summary

The implemented Cloudflare application and the coordinator's recorded live owner flows satisfy the core recording, transcription, editing, export, original-preservation and sharing behavior reviewed here. The independently reproduced release-generator defect is now fixed and passes actual Wrangler validation; the edited-snapshot restore receipt also verifies successfully. Release completion remains gated on the binding-update proof, longer chapter-producing recording, production hostname, member acceptance and native Chrome identity/capture; this report does not declare the application live or every criterion verified.

Security ran before this review. `library/qa/security/2026-10-28-release-security-review.md` records the closed source findings and the qualified Zod backport; newer runtime/tool changes require their own focused validation and final deployment evidence. Hindsight is unavailable in this agent's tools, so no shared-memory result was fabricated.

## Scorecard

| Category | Status | Notes |
| --- | --- | --- |
| Completeness | ⚠️ | Core application and distribution paths are implemented; production, member/client acceptance and final operational gates remain open. |
| Correctness | ⚠️ | Recorded live Save/export/Restore and the edited-snapshot recovery pass support the behavior; revised rollout and longer transcription checks remain open. |
| Alignment | ✅ | Infrastructure/provider scope and migration deferral match; corrected generated configs now pass the installed Wrangler contract. |
| Gaps | ⚠️ | Final deployment identity, real member/native Chrome flows and remaining rollout/chapter evidence must be supplied before complete-release signoff. |
| Detrimental | ✅ | The confirmed generated-config defect is corrected; no additional application access or data-integrity issue was confirmed. Security and coverage qualifications remain explicit. |

## Critical Issues (must fix)

- [x] **Resolved: emit the supported native-container image object**, `scripts/cloudflare/write-release-config.mjs:148-151`

  The generator emits a digest string directly at `containers[].images.base`. Installed Wrangler 4.152 requires an object containing either `dockerfile` or `image` (`config-schema.json`, `DurableObjectContainerImage`, line6613). The exact generator output from the actual production manifest was rejected twice, once for each class, by `wrangler deploy --dry-run --containers-rollout none`; the previous working temporary configs used `{ "image": "...@sha256:..." }`. Emit that supported object and validate against Wrangler rather than only tests that mirror the generated string shape.

  ```javascript
  container.images = {
  	...record(container.images, "container images"),
  	base: reference,
  };
  ```

  Baseline evidence: `tmp/qa-generator-shape-validation.log`. The owner changed `base` to `{ image: reference }`, added complete installed-schema AJV coverage and a negative scalar control, and reported47 passing contract tests. This auditor regenerated from the same actual production manifest and reran actual Wrangler dry-run validation: exit0, both native classes recognized, default readiness/maintenance false, no deployment. Evidence: `tmp/qa-generator-shape-validation-fixed.log`. The baseline CLI subsequently hit a Windows cleanup assertion; the explicit image-shape rejection was the finding, not that secondary exit behavior.

- [ ] **Complete the known production and client launch gates before claiming a live replacement**, `EXECUTION_LEDGER.md:16-24`, `infra/cloudflare/wrangler.runtime.jsonc:12-17`, `apps/chrome-extension/scripts/live-production-harness.mjs:126`

  The application remains deliberately gated, and the coordinator has not yet supplied final public-host, member, or unmodified Chrome identity/capture evidence. This is an outstanding release requirement, not a defect in keeping an incomplete rollout private. Complete the approved vertical checks on the intended production image and record the resulting deployment and client receipts.

  ```json
  "CAP_RUNTIME_READY": "false",
  "CAP_MAINTENANCE_ENABLED": "false"
  ```

- [ ] **Close the binding-update recovery gate without a diagnostic-tail workaround**, `docs/superpowers/plans/2026-10-27-cloudflare-cap.md:63-66`, `infra/cloudflare/runtime-worker.ts:141`

  A binding-only restart exposed a stale-Durable-Object transition. Coordinated runtime code adds version-ordered actor refresh and must be validated on the live service, including a media callback after the update. The separate post-edit restore failure is resolved: this auditor read the final private receipt and verified52 tables/16 rows, matching schema, integrity/FK checks, two matching media samples and confirmed cleanup.

  ```typescript
  async fetch(request: Request): Promise<Response> {
  	await this.configurationReady;
  	const expected = request.headers.get(WEB_CONFIGURATION_HEADER);
  	const fingerprint = await webConfigurationFingerprint(this.env);
  ```

## Warnings (should fix)

- [ ] **Reconcile the final execution status with the final evidence**, `EXECUTION_LEDGER.md:10-24`, `packages/database/cloudflare/README.md:77`

  The ledger's current-status table still describes initial integration work while later progress notes record completed source ports and live flows. The database README also retains historical cutover-blocker language. Update current status cells and qualify historical notes at closure; preserve the history, and do not mark pending production/client checks verified prematurely.

  ```markdown
  | AC02 | Cloudflare metadata persistence replaces MySQL with equivalent ownership/concurrency behavior | IN PROGRESS | Database implementation wave |
  | AC12 | Live application works at videos.trulyauthenticmarketing.com | OPEN | Production cutover after acceptance |
  ```

## Suggestions (consider improving)

None. Optional product improvements and broader Loom feature-parity work are outside this release audit.

## Plan Item Traceability

Statuses below distinguish implemented/tested source from outstanding live acceptance. A pending release gate is not represented as a missing implementation. The user explicitly deferred migration of the existing Loom library; no new Loom connection is required for launch.

| ID | Plan requirement | Status | Implementation location | Evidence and qualification |
| --- | --- | --- | --- | --- |
| G-01 | Cloudflare application hosting; Resend mail exception; no Railway/AWS hosting | ✅ | `infra/cloudflare/wrangler.runtime.jsonc:1`, `infra/cloudflare/runtime-env.ts:1`, `Dockerfile.cloudflare:1` | Private D1/analytics/workflow/media bindings and R2; AWS SDK naming does not establish AWS hosting. |
| G-02 | Approximately $20 target with measured usage, no unverified cap | ✅ | `infra/cloudflare/COSTS.md:1` | Cap-filtered billing metrics and conditional forecasts are documented; not an invoice or hard spending cap. |
| G-03 | Exact production hostname and owner | ⚠️ | `scripts/cloudflare/write-release-config.mjs:167`, `packages/database/cloudflare/team.ts:25` | Generator pins the required host; final public deployment is pending. |
| G-04 | Preserve originals, notices and desktop contracts | ✅ | `apps/web/actions/videos/save-edits.ts:121`, `apps/web/actions/videos/download.ts:87`, `infra/cloudflare/distribution/README.md:1` | Coordinator downloaded the pre-edit base with its unchanged SHA-256 after editing. Raw originals remain separate private objects. |
| G-05 | Protected secrets and invite-controlled signup | ✅ | `scripts/cloudflare/runtime-secrets.ps1:1`, `packages/database/cloudflare/team.ts:27`, `packages/database/cloudflare/access.ts:145` | Real owner OTP/session is coordinator verified; live member completion remains below. |
| G-06 | Private bucket and existing TAM resources preserved | ✅ | `infra/cloudflare/wrangler.runtime.jsonc:107`, `infra/cloudflare/downloads.ts:1` | Dedicated buckets and allowlisted downloads; no whole-bucket publicity is required. |
| G-07 | Imported source baseline retained | ✅ | `docs/superpowers/plans/2026-10-27-cloudflare-cap.md:21` | Git inventory is anchored to the specified upstream revision. |
| RF-01 | Cross-user media/metadata denied absent explicit share | ✅ | `apps/web/app/api/storage/object/route.ts:196`, `apps/web/app/api/playlist/route.ts:184`, `apps/web/actions/videos/download.ts:87` | Independent security/native D1 boundaries pass; coordinator observed anonymous private playlist/editor denial and no summary in private HTML. |
| RF-02 | Restart recovery with no duplicate import/edit publication | ⚠️ | `packages/workflow-cloudflare/index.mjs:49`, `infra/cloudflare/workflow-store.mjs:96`, `apps/web/workflows/edit-video.ts:110` | Native persistence/lease/replay tests exist; coordinator observed Restore complete after interruption. Final binding-only recovery proof remains in progress. |
| RF-03 | Invalid/overlapping ASR timing cannot corrupt a timeline | ✅ | `apps/web/lib/cloudflare-transcription.ts:55`, `apps/web/lib/edit-transcript.ts:531`, `apps/web/lib/silence-cuts.ts:82` | Typed bounded timings, overlap rejection and protected quiet subranges. Live export re-transcription preserved 23 intended non-filler words. |
| RF-04 | Deliberate MySQL-to-D1 semantic port | ✅ | `packages/database/cloudflare/atomic.ts:60`, `packages/database/cloudflare/index.ts:1`, `packages/database/cloudflare/schema.ts:1` | Native D1 race, rollback and caller tests; no interactive transaction emulation or SQL text rewriting. |
| RF-05 | Failed migration/source exceptions retained | ✅ | `apps/web/lib/loom-import-start.ts:1`, `apps/web/workflows/import-loom-video.ts:1` | Source/import replay cases are covered by specialist evidence; private-library live migration is deferred. |
| T1.1 | Fork/branch/upstream revision and license foundation | ✅ | `docs/superpowers/plans/2026-10-27-cloudflare-cap.md:21`, `infra/cloudflare/distribution/README.md:11` | Fork and source-offer branch exist; native packages retain upstream notices. |
| T1.2 | Supported toolchain and frozen lockfile | ✅ | `package.json:74`, `Dockerfile.cloudflare:1`, `.github/workflows/tam-web-images.yml:30` | Node 24/Bun 1.4.4; both final application image jobs succeeded for the specified source. |
| T1.3 | Dedicated D1 and private R2 identifiers | ✅ | `infra/cloudflare/wrangler.runtime.jsonc:85` | Metadata, analytics and media/download resources are separated. |
| T1.4 | Infrastructure health is distinct from Cap readiness | ✅ | `infra/cloudflare/worker.ts:1`, `infra/cloudflare/runtime-worker.ts:1` | Infrastructure health is not counted as launch; the actual Cap UI has separate private acceptance. |
| T1.5 | Build/type/isolated/deployed checks without early hostname change | ✅ | `Dockerfile.cloudflare:16`, `scripts/cloudflare/verify-workflows.mjs:1` | Full web suite and image builds pass; hostname remains gated until application checks. |
| T2.1 | Explicit SQLite tables/types/indexes/FKs | ✅ | `packages/database/cloudflare/schema.ts:1`, `packages/database/cloudflare/README.md:1` | Encoding/collation limitations are documented; no claim of MySQL accent-insensitive collation equivalence. |
| T2.2 | Generated migrations with reproducible artifacts | ✅ | `packages/database/drizzle.cloudflare.config.ts:1`, `packages/database/cloudflare/generate-concurrency-migration.ts:1`, `packages/database/cloudflare/generate-validation-migration.ts:1` | Controlled migration path; application startup does not run it. |
| T2.3 | Schema/value/constraint and rollback tests | ✅ | `packages/database/cloudflare/database.test.ts:1` | Actual SQLite/D1 tests plus remote application behavior; package tests are distinct from the web-suite count. |
| T2.4 | Reproducible caller/transaction inventory | ✅ | `scripts/cloudflare/database-audit.mjs:1` | Audit outputs are candidates, not a claim that every match is a live MySQL use. |
| T2.5 | Equivalent ownership/concurrency across caller groups | ✅ | `packages/database/cloudflare/atomic.ts:60`, `packages/web-backend/src/Videos/persistence.ts:1` | Native D1 reservation, roster/source/lease races and publication rollback evidence across the ported groups. |
| T2.6 | Canonical D1 cutover after affected tests | ✅ | `packages/database/index.ts:1`, `packages/database/schema.ts:1`, `packages/database/cloudflare/application.ts:6` | Canonical accessor fails closed without the Cloudflare/D1 runtime. |
| T3.1 | Preserve filler words and valid timing in Cap transcript artifacts | ✅ | `apps/web/lib/cloudflare-transcription.ts:1`, `apps/web/__tests__/fixtures/cloudflare-whisper-response.ts:1` | Nova-3 was the initial candidate, not a fixed-model requirement. Measured drift led to Cloudflare-hosted Whisper; no guessed offset is applied. |
| T3.2 | Explicit typed provider boundary | ✅ | `apps/web/lib/transcription-provider.ts:13`, `apps/web/lib/cloudflare-transcription.ts:129` | Cloudflare parser/provider/editor focused suite passed 64 cases. |
| T3.3 | Preserve non-Cloudflare transcription default | ✅ | `apps/web/lib/transcription-provider.ts:42` | AssemblyAI default branch remains outside this deployment's configured Cloudflare provider. |
| T3.4 | Provider failure/retry and scoped checks | ✅ | `apps/web/lib/cloudflare-transcription.ts:175`, `apps/web/__tests__/unit/cloudflare-transcription.test.ts:1` | Invalid source/timings fail, transient HTTP failures retain retry classification. |
| T4.1 | No request-startup migrations/provisioning | ✅ | `apps/web/instrumentation.node.ts:18` | Cloudflare validation/readiness returns before the legacy migration/bucket-publication path. |
| T4.2 | Supported web/media packages and immutable pins | ✅ | `Dockerfile.cloudflare:1`, `scripts/cloudflare/write-release-config.mjs:133` | Image builds/pins pass; corrected generator output independently passes actual Wrangler dry-run validation. |
| T4.3 | Durable job ownership/retry state on Cloudflare | ✅ | `packages/workflow-cloudflare/index.mjs:49`, `infra/cloudflare/workflow-store.mjs:96` | Persisted outbox/lease/replay logic; media work is bounded rather than running MySQL/queues on ephemeral disks. |
| T4.4 | Interrupted uploads/processing/edits/imports do not duplicate publication | ⚠️ | `infra/cloudflare/workflow-store.test.mjs:1`, `apps/web/__tests__/unit/desktop-recording-output-replacement.test.ts:1` | Native tests cover the paths; final operational binding-update checks remain open, and private Loom library migration is deferred. |
| T5.1 | Cloudflare generation without outside fallback | ✅ | `apps/web/lib/ai/provider.ts:136` | Endpoint/account/model restrictions are present; real title/summary generation is coordinator verified. |
| T5.2 | Resend login/invites with restricted membership | ⚠️ | `packages/database/cloudflare/team.ts:27`, `packages/database/auth/auth-options.ts:79` | Real owner delivered mail/login works; final member invitation/sign-in remains a launch gate. |
| T5.3 | Filler/silence edits with preview/undo/original preservation | ✅ | `apps/web/lib/edit-transcript.ts:585`, `apps/web/lib/silence-cuts.ts:82`, `apps/web/actions/videos/save-edits.ts:337` | Actual UI cut selection/Undo/Redo, 10.8667-second export, semantic re-transcription and original hash preservation are recorded by root. |
| T5.4 | Ownership, sharing, overlap/noise, failed processing and large media | ⚠️ | `apps/web/__tests__/unit/cloudflare-video-privacy.test.ts:1`, `apps/media-server/src/__tests__/lib/media-routes-real-world.integration.test.ts:1` | Native/scoped cases and short live synthetic recordings are meaningful coverage; they do not establish every long-duration/high-resolution hardware workload. |
| T6.1 | Owner/member complete vertical flow | ⚠️ | `EXECUTION_LEDGER.md:16-18`, `apps/web/app/(org)/dashboard/caps/record/RecordVideoPage.tsx:1` | Owner and synthetic browser capture paths verified; member acceptance and final browser-processing closure remain coordinator owned. |
| T6.2 | Measured usage, concurrency and notifications | ✅ | `infra/cloudflare/COSTS.md:35`, `infra/cloudflare/COSTS.md:64`, `infra/cloudflare/runtime-worker.ts:1` | Existing enabled native $10 account-wide budget alert was verified read-only and retained; not a new Cap-specific alert or delivery test. |
| T6.3 | Backup/restore and rollback | ⚠️ | `scripts/cloudflare/backup-restore-drill.mjs:312`, `scripts/cloudflare/snapshot-import.mjs:15`, `infra/cloudflare/releasing.md:80` | Edited snapshot52 tables/16 rows, complete schema/row/media hashes and cleanup now pass. Pinned rollback/runbook safeguards do not prove an unreported live image rollback. |
| T6.4 | Hostname only after acceptance | ⚠️ | `scripts/cloudflare/write-release-config.mjs:167` | Correct target and default closed gates; final routing/HTTPS/public checks pending. |
| T6.5 | Loom sample/batch migration and reconciliation | 🟦 | `EXECUTION_LEDGER.md:21`, `docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md:27` | Explicitly deferred by the user; preserve the old library and importer capability. |
| T6.6 | Security before QA, resolve material findings | ⚠️ | `library/qa/security/2026-10-28-release-security-review.md:1`, this report | Ordering satisfied for reviewed application source; final deployment and operational deltas still need closure. |
| AC01 | Preserve upstream features, licenses and client contracts | ✅ | `infra/cloudflare/distribution/README.md:1`, `apps/desktop-gpui/src/distribution.rs:1` | Self-built client configuration and source/license offers are documented; no whole-Loom-parity claim. |
| AC02 | Equivalent D1 ownership/concurrency persistence | ✅ | `packages/database/cloudflare/atomic.ts:60`, `packages/database/cloudflare/application.ts:6` | Native D1 caller/race/rollback evidence and actual owner flows support the cutover. |
| AC03 | Private originals/derived assets and intentional sharing | ✅ | `apps/web/app/api/storage/object/route.ts:196`, `apps/web/actions/videos/download.ts:87` | Retained-original read/issuer fixes are independently reviewed; owner original hash and anonymous private-share denial are live verified by root. |
| AC04 | Actual Cap application on Cloudflare, controlled migrations | ✅ | `apps/web/instrumentation.node.ts:18`, `infra/cloudflare/runtime-worker.ts:82` | Actual Cap UI/processing flows exist on the private runtime; infrastructure health is not substituted for them. |
| AC05 | Durable processing/edit/import recovery without duplicate publication | ⚠️ | `infra/cloudflare/workflow-store.mjs:96`, `apps/web/workflows/edit-video.ts:110` | Native lease/replay coverage and recovered Restore are recorded; final no-tail binding-update proof pending. |
| AC06 | Words, fillers, timestamps and media alignment | ✅ | `apps/web/lib/cloudflare-transcription.ts:55`, `apps/web/lib/edit-transcript.ts:129` | Live25-word source and23-word edited export preserve intended speech; no inferred time offset is applied. This is a synthetic fixture, not every acoustic condition. |
| AC07 | Titles, summaries and chapters on Cloudflare | ⚠️ | `apps/web/workflows/generate-ai.ts:277` | Empty chapters are intentional for clips under 120 seconds. A longer live chapter check is being prepared by root; title/summary are already verified. |
| AC08 | Owner/member mail, invitations and controlled registration | ⚠️ | `packages/database/cloudflare/team.ts:27`, `packages/database/auth/auth-options.ts:79` | Actual owner mail/session works; real first-member invitation/sign-in remains coordinator owned. |
| AC09 | Filler/silence cleanup, preview, Undo, export and original | ✅ | `apps/web/actions/videos/save-edits.ts:337`, `apps/web/lib/silence-cuts.ts:82` | Live editor/export/original/Restore evidence is recorded; native D1 receipt race/rollback follow-up passes. |
| AC10 | Owner/member recording, playback, sharing and denial | ⚠️ | `apps/web/app/(org)/dashboard/caps/record/RecordVideoPage.tsx:1`, `apps/web/actions/video/retry-processing.ts:50` | Synthetic browser recording/capture/upload/playback is demonstrated. Its final processing closure and the member path need final evidence. |
| AC11 | Backup/restore, rollback, measured usage and bounded concurrency | ⚠️ | `scripts/cloudflare/backup-restore-drill.mjs:312`, `infra/cloudflare/COSTS.md:35`, `infra/cloudflare/releasing.md:80` | Edited snapshot and existing budget notification verified. Final rollout/rollback mechanism proof remains qualified. |
| AC12 | Application works on the required public hostname | ⚠️ | `scripts/cloudflare/write-release-config.mjs:167` | Correct production image/config path exists; public routing/HTTPS acceptance pending. |
| AC13 | Existing Loom inventory/import reconciliation | 🟦 | `EXECUTION_LEDGER.md:21` | Explicitly deferred by the user; not a launch blocker. |
| AC14 | Security then QA with no unresolved material issue | ⚠️ | `library/qa/security/2026-10-28-release-security-review.md:1`, this report | Generator finding corrected; final operational/client/public gates still prevent complete-release signoff. |
| AC15 | Cloudflare views and engagement analytics | ⚠️ | `packages/database/cloudflare/analytics/schema.ts:1`, `apps/web/app/s/[videoId]/Share.tsx:103` | Real guest view persisted and appeared in the dashboard; no claim of a live nonzero comment/reaction test from the supplied evidence. |
| AC16 | Desktop downloads and Chrome self-hosted connection | ⚠️ | `apps/web/data/self-hosted-downloads.ts:3`, `.github/workflows/tam-desktop-artifacts.yml:41`, `apps/chrome-extension/scripts/live-production-harness.mjs:126` | Windows x64/Mac ARM packages and native load/configuration probes pass. Native hardware capture is optional per the accepted design; public native Chrome identity/capture remains required and pending. |
| NG-01 | No substitute upload portal or premature full-parity promise | ✅ | `docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md:9` | Actual Cap fork/UI is preserved. This QA does not equate it with every proprietary Loom feature. |
| NG-02 | No public video bucket or destructive stored-state rollback | ✅ | `infra/cloudflare/downloads.ts:1`, `infra/cloudflare/releasing.md:80` | Allowlisted distribution is separate; runbooks preserve D1/R2/DO/queue state. |
| NG-03 | No old-library migration during this launch | ✅ | `EXECUTION_LEDGER.md:21` | User deferral is honored; no private Loom connection is requested. |

### Verification scope

This auditor inspected the plan, complete changed-file inventory, persistence/runtime entrypoints, provider/timeline boundaries, distribution/package configuration, operational controls and independent security/test handoffs. It did not re-audit all 712 changed files line by line or rerun the long unit suite. The coordinator owns the live browser/media evidence; the independent fullunit4 receipt records 386 files, 5,101 pass, zero fail and five intentional skips, with late security additions explicitly covered separately rather than silently added to that count.

No new paid inference, server, external write, email or deployment was made by this auditor. Native alert checks used three read-only Cloudflare endpoints and found the existing enabled $10 policy; no policy or recipient changed and no delivery was tested. Markdown is ignored by this repository's Biome configuration, so report/Markdown validation uses scoped diff/structure/link checks rather than claiming Biome formatted Markdown.

The corrected release generator was checked independently against actual Wrangler4.152 with the actual production manifest and both readiness gates false. The private post-edit recovery receipt `.secrets/backups/1f2919d2-d815-4cbc-aa68-aaa31f5edcc4/report.json` reports `verified=true`, `schemaMatches=true`, `integrityOk=true`, zero FK violations,52 tables/16 rows, two matching full media samples, and confirmed database/sample deletion. No SQL, credential, request header or signed transfer URL was printed during this review. The authoritative SQLite projection preserves values rather than rewriting SQL-looking text in user content.

The native Windows installer is unsigned; the Mac ARM package is ad hoc signed and not notarized. The Chrome ZIP uses manual Load unpacked installation and is not a store publication. These are disclosed distribution characteristics, not evidence of native hardware recording, and are not silently promoted to such proof.

## Files Changed

Inventory snapshot: 2026-10-28T01:42:32.518Z; 721 unique implementation/operations paths from the baseline diff and current working tree. Change-domain summaries below are an inventory, not a claim of independent line-by-line semantic review of every file. The audit report itself is excluded.

- `.dockerignore` (M), Fork configuration or build-input integration.
- `.github/workflows/tam-desktop-artifacts.yml` (A), Fork-owned native/application image build workflow.
- `.github/workflows/tam-web-images.yml` (A), Fork-owned native/application image build workflow.
- `.gitignore` (M), Fork configuration or build-input integration.
- `apps/chrome-extension/e2e/overlay-ui.spec.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/e2e/recording-upload.spec.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/e2e/self-hosted-instance.spec.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/e2e/webcam-start.spec.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `apps/chrome-extension/package.json` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/public/manifest.json` (M), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/scripts/build-self-hosted.mjs` (A), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/scripts/live-production-harness.mjs` (A), Self-hosted extension instance, recording, distribution or acceptance tooling.
- `apps/chrome-extension/scripts/live-production-harness.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
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
- `apps/media-server/src/__tests__/index.test.ts` (M), Regression or integration coverage for the Cloudflare port/client lifecycle.
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
- `apps/web/app/Layout/devtoolsServer.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/_components/CapVideoPlayer.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/_components/ShareHeader.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/_components/VideoDownloadMenu.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/edit/EditVideoClient.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/edit/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/edit/TranscriptSidebar.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/app/s/[videoId]/page.tsx` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/components/forms/server.ts` (M), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/components/pages/SelfHostedDownloadPage.tsx` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/data/self-hosted-downloads.ts` (A), Web application UI, data, provider or runtime integration for the fork.
- `apps/web/instrumentation.node.ts` (M), Web application UI, data, provider or runtime integration for the fork.
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
- `apps/web/lib/Notification.ts` (M), Web application UI, data, provider or runtime integration for the fork.
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
- `Dockerfile.cloudflare` (A), Native Node/Bun media application packaging and image build boundaries.
- `Dockerfile.cloudflare.dockerignore` (A), Native Node/Bun media application packaging and image build boundaries.
- `docs/superpowers/plans/2026-10-27-cloudflare-cap.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/reports/2026-10-27-cost-envelope.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/reports/2026-10-27-foundation-qa.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/reports/2026-10-27-runtime-recovery.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/reports/2026-10-27-security-review.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `docs/superpowers/specs/2026-10-27-cloudflare-cap-design.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `EXECUTION_LEDGER.md` (A), Approved plan, execution record, architecture or independent review evidence.
- `infra/cloudflare/backup-restore.md` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/cap.env.example` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/configuration-refresh.md` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/COSTS.md` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/distribution/checksums.txt` (A), Client artifact manifest, checksums or managed-distribution instructions.
- `infra/cloudflare/distribution/manifest.json` (A), Client artifact manifest, checksums or managed-distribution instructions.
- `infra/cloudflare/distribution/README.md` (A), Client artifact manifest, checksums or managed-distribution instructions.
- `infra/cloudflare/downloads.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `infra/cloudflare/downloads.ts` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/evidence/2026-10-28-cap-container-usage.json` (A), Cap-filtered non-secret operational usage/restart evidence.
- `infra/cloudflare/evidence/2026-10-28-cap-media-placement.json` (A), Cap-filtered non-secret operational usage/restart evidence.
- `infra/cloudflare/maintenance.test.mjs` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `infra/cloudflare/maintenance.ts` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/package-lock.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/package.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/r2-cors.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/README.md` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
- `infra/cloudflare/releases/production-04f7c07b02bd2742ff5183c53875e9647698a7e5-wrangler4152.json` (A), Cloudflare bindings, runtime controls, durable state, maintenance or operations guidance.
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
- `packages/database/cloudflare/access.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/ai-generation.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/application.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/index.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/migrations/0000_analytics_initial.sql` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/migrations/meta/_journal.json` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/analytics/migrations/meta/0000_snapshot.json` (A), D1 persistence, validation, authorization or atomic transport implementation.
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
- `packages/database/cloudflare/migrations/meta/_journal.json` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/migrations/meta/0000_snapshot.json` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/migrations/meta/0001_snapshot.json` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/migrations/meta/0002_snapshot.json` (A), Generated Cloudflare schema, constraints or migration snapshot artifact.
- `packages/database/cloudflare/mutation-counts.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/organization-delete.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/pro-seat.ts` (A), D1 persistence, validation, authorization or atomic transport implementation.
- `packages/database/cloudflare/README.md` (A), D1 persistence, validation, authorization or atomic transport implementation.
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
- `packages/web-backend/src/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Organisations/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Organisations/OrganisationsPolicy.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Organisations/OrganisationsRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Rpcs.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/S3Buckets/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/S3Buckets/S3BucketAccess.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/S3Buckets/S3BucketsRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Spaces/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Spaces/SpacesPolicy.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Spaces/SpacesRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/GoogleDrive.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/persistence.ts` (A), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/recording-output.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Storage/StorageRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Users/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Users/UsersOnboarding.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Users/UsersRpcs.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/index.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/persistence.test.ts` (A), Regression or integration coverage for the Cloudflare port/client lifecycle.
- `packages/web-backend/src/Videos/persistence.ts` (A), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/snapshot-view-policy.ts` (A), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/VideosPolicy.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
- `packages/web-backend/src/Videos/VideosRepo.ts` (M), Backend service persistence/capability port for the Cloudflare runtime.
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
