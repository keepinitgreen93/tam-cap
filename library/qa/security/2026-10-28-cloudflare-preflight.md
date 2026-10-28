# Cloudflare Cap security preflight

Date: 2026-10-28 UTC. Reviewed branch: codex/cloudflare-self-host, working source based on 72ff6f5 plus the coordinated application changes. This is a bounded pre-release preflight, not final AC14 security signoff or production acceptance.

The security-stinger catalog targets Hivemind, not Cap. Its evidence, severity, minimal-remediation and verification rules were applied to the actual Next.js/Effect/D1/R2/Container/extension surfaces. Its Hivemind-only scan script and Deep Lake checks do not constitute relevant Cap coverage and were not represented as such. No final QA report was found in library/qa; final security then QA remain required after E2E and the final image. Hindsight tools were unavailable; no recall was fabricated.

## Outcome

One confirmed High application finding was reproduced and fixed locally with coordinating-agent authorization. No additional exploitable Medium-or-higher finding was confirmed in the inspected boundaries. The known High Zod advisory remains version-flagged with an independently rechecked local mitigation. Neither status is a deployed-image or full-dependency-tree clearance.

| Finding | Severity | Current status |
| --- | --- | --- |
| SEC-01: viewers could retrieve retained pre-edit originals and segments | High | Source fixed, scoped regressions pass; rebuilt image and live unauthorized denial pending |
| DEP-01: GHSA-mrhx-c7xc-m3w5, affected Zod version retained with backport | High advisory | Locally mitigated for constrained collections; not version-cleared; final-image confirmation pending |

## SEC-01: retained originals bypassed the published edit

Baseline evidence: 72ff6f5:apps/web/app/api/storage/object/route.ts:202 accepted any key under owner/video. Its restriction at line206 applied only when isInternalRecordingKey returned true, which packages/web-backend/src/Storage/recording-output.ts:16 limits to third segments .recording and .transcripts. Therefore source/original.mp4 and raw-upload.mp4/webm passed ordinary canView authorization even after an edit; a viewer knowing the owner/video prefix could request removed content without an owner or original-download capability. Unreferenced legacy transcription.vtt and deleted comment-object keys had the same ambient prefix grant.

Baseline playlist evidence: apps/web/app/api/playlist/route.ts:96 authorized canView, then line189 allowed raw-preview and line198 allowed legacy segment modes independently of the currently published source. Thus a caller viewing the edited MP4 could request the original raw upload or retained segments. This is distinct from downloading the already viewable published media and is not solved by allowDownload settings.

Reproduction used synthetic data and the actual production route handlers. tmp/security-original-red-sol.log records ten failing denial assertions before remediation. tmp/security-legacy-source-red-sol.log separately records three expected failures for absent-marker legacy edit data and concurrent source/edit publication. No live private original was exposed to an unauthorized caller during this audit.

The coordinated fix changes only the object and playlist routes plus their tests:

- apps/web/app/api/storage/object/route.ts:196 verifies an exact object capability, retains the owner/video prefix check, and at lines206-229 distinguishes the authenticated owner from viewers. An unsigned viewer receives only the current published MP4/audio derivative/thumbnail/preview or a canonical alias that resolves to that current asset. Other retained objects require the owner or an exact server-signed object capability. Private word-transcript objects remain denied before token processing.
- apps/web/app/api/playlist/route.ts:184-249 makes raw-preview owner-only, rejects old segments when an immutable MP4 is published, and prevents unbound legacy enhanced-audio access by viewers. Current desktopSegments playback is retained.
- The legacy desktopMP4-without-output early-view contract is preserved. Lines200-232 use the actual D1 atomic snapshot to reload the active video and edit row, compare owner/organization/storage/source, reject editing-base/completed-edit markers or an existing edit row, and commit an empty-business-plan revision guard before issuing capabilities. If a source or edit is published between planning and the guard batch, the planner retries and refuses the old segment capability. No interactive transaction, fake atomic wrapper or external network operation was inserted in the planner.
- Owner legacy-segment/raw-preview access and exact scoped signed-object reads remain tested. Header tests explicitly use scoped object capabilities for non-published objects; denial assertions live separately and do not grant such capabilities.

This closes ambient access to retained originals. Existing owner-issued signed capabilities still have their bounded expiration lifetime; this work does not claim immediate revocation of URLs issued before a privacy or source change.

## DEP-01: Zod backport assessment

The current [GitHub advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) lists versions below 4.6.6 as affected. The [upstream commit](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd) adds early bounds checks to the v4 array/set/map parser paths. The actual change is constrained-collection rejection before element traversal; it is not a universal error budget for unbounded schemas.

The application and standalone media package intentionally retain 3.25.76. Root package.json:80 and apps/media-server/package.json:12 register the generated backport. Both patch files have identical SHA-256 728fe9f70b29b793cfde9c87acb649613f8b76b204facd317a25a618e2f8356f. The patch covers v3 array max/length and set max/size in ESM, CommonJS and source, preserving the supported API. Dockerfile.cloudflare copies the standalone media patches before its install.

Fresh root regression 18/18 and the existing isolated standalone-media installation 18/18 passed. The small fixtures verify zero element-parser calls for oversized bounded collections, exact size issues, nested/sync/async/ESM/v3/CommonJS paths and valid/lower-bound compatibility. This independently verifies the local mitigation; it does not remove the version-based advisory or certify every transitive Zod copy. See library/qa/security/2026-10-27-zod-v3-backport.md for the original red/green and frozen-install evidence.

Unbounded application/media schemas are outside that patch's protection. Their existing authenticated/private ingress and the Cloudflare request boundary reduce reachability; this preflight did not run a memory-exhaustion attack, establish a universal safe request size, or rerun a full production dependency audit. The final image must contain the registered patches and pass the same regressions before release clearance.

## Inspected boundaries and evidence

| Boundary | Evidence and bounded conclusion |
| --- | --- |
| Public Worker versus D1/workflow/cron controls | infra/cloudflare/runtime-worker.ts:180-224 uses private container host mappings, blocks normalized control paths, gates staging and strips the preview key. Fresh runtime/download/header tests 13/13 cover normalized paths, readiness, spoofed geography, artifact allowlists and cache behavior. No public D1/RPC bridge path was found in this routing boundary. |
| Session, invitation and cookie-write authentication | packages/database/auth/identity.ts:30 fails closed for non-invite Cloudflare policy; auth-options.ts:55-65 checks the live session version; auth/request-site.ts:40 and app/api/utils.ts:106 keep cookie-write checks separate from successful bearer auth. Fresh auth-options 47 and email-route 13 tests passed. Trusted-proxy login remains a separately configured secret capability, not an identity inferred from a client-supplied email alone. |
| View/read versus owner mutation | VideosPolicy.ts:65-149 separates owner, explicit membership/grant, password and public/domain access. Object/playlist original reads were the confirmed exception and are remediated above. Fresh D1 privacy 7 tests passed; original download action still separately invokes canUserDownloadVideo at actions/videos/download.ts:94. |
| Upload and job capabilities | lib/media-multipart-context.ts:38-143 checks live owner/organization/storage/job generation/attempt/lease and exact immutable output keys in the D1 snapshot. Fresh native D1 six-case suite passed, including concurrent lease/organization/owner/deletion changes. Webhook routes authenticate the media secret before parsing payloads; media has private container ingress. |
| Media source and identity handling | silence-analysis route authenticates before JSON parsing. apps/media-server/src/lib/silence-source.ts:25-58 requires signed HTTPS R2 URLs, owned prefix, no credentials/traversal, exact object identity and length, and redirect:error. Ordinary verification/proxy tests retain byte ranges, HEAD, cancellation and fail-closed identity behavior. Other trusted media operations support broader sources by design; no claim of a global SSRF proof is made. |
| Transcription/AI scope | cloudflare/transcription-state.ts:95-120 checks owner, run and media revision; shared transcript publication retains immutable paired pointers. AI provider.ts:136-161 requires the configured Cloudflare account endpoint and @cf models under CAP_RUNTIME=cloudflare. Actual runtime transcription provider/model configuration is being changed and verified by the API agent; its alignment work and live E2E are outside this report's clearance. |
| Extension/distribution | Chrome auth creates random state and uses chrome.identity at shared/api.ts:108-153; instance.ts rejects non-HTTPS non-loopback origins and credentials. Inspected message plumbing has no website window.postMessage token bridge or externally_connectable declaration. downloads.ts:1-44 permits only GET/HEAD allowlisted versioned artifacts from the separate downloads binding and retains the readiness gate. The manifest records hashes and a distinct extension ID. Native unsigned/ad-hoc signing and manual updates are disclosed in distribution/README.md; native installation/capture and public Chrome login/upload remain acceptance tasks. |
| Secrets and hosted providers | A filename-only scan of selected production source found no exact AWS/live-Stripe/Resend/private-key patterns, and git tracked-file inspection found no .secrets or environment credential files. No credential values were printed. Source uses D1/R2/Cloudflare container/workflow bindings plus the configured Resend mail boundary. Actual provider token permissions, private bucket policy, restored secrets and final hostname configuration were not re-provisioned or re-attested by this audit. |

## Verification record

- tmp/security-original-final-sol.log:95/95 across object route 2, object verification 31, object content headers 23 and playlist 39. The playlist suite now uses real D1 for raw lookup and the three legacy publication races.
- tmp/security-preflight-tests-sol.log:165/165 in the earlier combined route/auth/privacy/multipart run. This overlaps the route count above; do not sum them. Later legacy changes were rerun in the final route wave.
- tmp/security-legacy-source-final-sol.log: fresh final playlist rerun after hook/format normalization, 39/39 passed after hook/format normalization.
- tmp/security-edge-tests-sol.log:13/13.
- tmp/security-zod-root-sol.log and tmp/security-zod-media-sol.log:18/18 each.
- tmp/security-preflight-types-sol.log: selected changed production/test files, zero TypeScript diagnostics, exit0. Scoped Biome for five files clean; git diff --check clean apart from ordinary CRLF notices.

## Release boundary

The coordinating agent owns the rebuilt staging image, live owner/member/unauthorized requests, recording/edit/export/original preservation, client flows, interruption/restore/cost checks and production cutover. This source fix and preflight can be checkpointed now; final security and QA must inspect the exact deployed candidate after those flows pass. No deployment, email, invite, remote application mutation, new agent, new server, secret provisioning or paid inference was performed by this worker.
