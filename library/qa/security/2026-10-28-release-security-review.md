# Independent Cloudflare release security review

Reviewed 2026-10-28 UTC from commit27591c20cf048243420796e6cd195aa77dbbfdc2 plus the coordinated runtime and security working changes. This is a bounded, independent source review before final deployment acceptance. It is not a claim that the public application, desktop hardware capture, browser extension flow, every dependency, or disaster recovery has passed.

The security-stinger catalog targets Hivemind. Its evidence, severity and minimal-remediation principles were applied to Cap's actual Next.js, Effect, D1, R2, container and Chrome extension boundaries. Hivemind-specific Deep Lake scans would not establish coverage here and were not run. No newer QA report was found. Hindsight was unavailable in this worker; no memory result was fabricated.

## Outcome

Two additional Medium resource-abuse findings and a related High download-capability issuer bypass were confirmed and fixed with coordinating-agent authorization. The earlier retained-originals High finding was independently traced and its95 focused route regressions rerun successfully. No additional exploitable Medium-or-higher application finding remains confirmed in the inspected source after these fixes. The existing High Zod advisory remains version-flagged with a bounded backport, not a full dependency clearance.

| ID | Severity | Finding | Source status |
| --- | --- | --- | --- |
| SEC-01, earlier preflight | High | Public viewers could bypass published edits using retained originals/segments | Independently reviewed;95 route tests pass; live final-image denial remains coordinator-owned |
| SEC-01B, related issuer | High | A shared reader could request an original-download capability; current download eligibility bypassed video-password validation | Fixed; owner-only original, runtime variant validation and fresh view/password policy before member signing |
| SEC-02 | Medium | Public docs AI incurred paid inference; spoofable forwarding prefixes bypassed its local budget | Fixed; Cloudflare workspace gate, trusted-IP normalization and bounded input verified |
| SEC-03 | Medium | Public Loom downloader could invoke media conversion without a workspace account | Fixed; gate precedes source fetch/conversion and rejects forced cross-site GETs |
| DEP-01, existing advisory | High advisory | Zod3.25.76 falls within the advisory's affected versions | Locally mitigated for constrained collections;18 fresh root regressions pass; no version-cleared claim |

## SEC-02: public paid docs AI and spoofable request budget

Baseline apps/web/app/api/docs/ask/route.ts:62 exposed its configured streaming model without authentication. It read the entire JSON request at line73, transformed every supplied history entry before retaining the last12, and selected the first x-forwarded-for value at line103 for its local ten-request/minute limiter. infra/cloudflare/request-headers.ts:2 preserved that caller-provided forwarding prefix. The additional Vercel Firewall helper is explicitly best-effort and fails open without its corresponding Vercel rule; it cannot be treated as an effective Cloudflare control.

Cloudflare documents that it [appends to an already supplied X-Forwarded-For chain](https://developers.cloudflare.com/fundamentals/reference/http-headers/#x-forwarded-for). Consequently the first element is not an authoritative client identity. A client could vary that prefix while retaining the same actual Cloudflare client IP.

An offline reproduction executed the exact baseline handler and header helper with mocked model output. Eleven requests using one prefix produced ten model calls and then429; eleven requests using different prefixes but the same cf-connecting-ip produced eleven model calls and all200. The two reproduction assertions passed. The evidence is tmp/release-security-docs-repro.log. No paid inference, external request, or production traffic was used. Temporary baseline source and tests were archived under ignored tmp after the run rather than shipping tests that assert vulnerable behavior.

The coordinated fix is:

- apps/web/lib/cloudflare-compute-access.ts:10 requires a session and a live requireWorkspaceAccount snapshot when CAP_RUNTIME=cloudflare. Viewer-only accounts, revoked workspace access and cross-site cookie initiators are refused before paid work. Hosted public docs behavior is retained outside that runtime.
- apps/web/app/api/docs/ask/route.ts:98 invokes the gate before provider work. Its reader at line59 stops/cancels above65,536 streamed bytes, regardless of Content-Length, before JSON decoding. Invalid UTF-8/JSON is rejected. At most the recent12 history entries are processed and each retained content is capped at4,000 characters; the question's existing500-character cap remains.
- infra/cloudflare/request-headers.ts:3 derives forwarding identity from Cloudflare's cf-connecting-ip header and replaces x-forwarded-for/x-real-ip. Other IP forwarding aliases are stripped. Missing or malformed Cloudflare identity never preserves caller-supplied aliases. This changes the outer Cloudflare boundary, not the OTP authentication policy.

The combined final route/header regression uses a valid workspace member and varies eleven forwarding prefixes for one actual IP. It permits ten model calls and returns429 for the eleventh. Separate cases verify anonymous401, viewer/revoked403, cross-site401, workspace200, streamed-body cancellation, malformed UTF-8, history limits and preserved hosted output.

## SEC-03: anonymous Loom conversion

Baseline apps/web/app/api/tools/loom-download/route.ts:162 accepted a public Loom ID without authentication or a local request budget. Its streaming fallback at line257 called the authenticated media-server converter, and line308 could invoke local FFmpeg conversion. A public caller could therefore consume conversion/runtime resources paid for by this deployment. This consumes bounded direct-conversion capacity; this report does not claim it exclusively locks every recording-job category.

An offline regression against the exact baseline route expected anonymous401 but received307 after its stubbed Loom lookup, confirming the lookup path was publicly reachable. Evidence: tmp/release-security-loom-repro.log. Final tests also execute the streaming conversion branch with a mocked successful media response. Neither reproduction contacted Loom or ran an external conversion.

apps/web/app/api/tools/loom-download/route.ts:164 now invokes the shared Cloudflare workspace gate before reading the ID or fetching Loom. The shared gate applies the cookie-origin check as for a write even on this GET endpoint: conversion spends resources, so an external page must not trigger it using an owner's browser session. Owner/team direct downloads and streaming conversion remain available; the hosted public marketing behavior remains outside Cloudflare. The separately protected deferred Loom importer was not changed.

The sibling inventory found only loom-download under app/api/tools. Searching direct streamText/generateText and remote/local FFmpeg conversion calls under app/api identified docs/ask and this downloader as the direct public compute sinks. Backend services, workflow processing and the private media server have separate authentication/publication boundaries; this inventory is not an assertion that every possible indirect application operation was exhaustively audited.

## Independently reviewed boundaries

### SEC-01B: retained-original issuer and current-download password checks

The coordinator identified the original-download issuer as a related boundary to inspect. Baseline actions/videos/download.ts:94 invoked canUserDownloadVideo, which permits an explicit organization/space share plus membership, then its original branch selected the retained editing base/edit source without requiring the owner. The nonowner ShareHeader branch rendered VideoDownloadMenu with hasEdits, which exposed that original choice. Furthermore, membership-only download eligibility did not run the existing VideosPolicy password validation. A server-action caller could bypass the share-page password gate for the current download too. There is no allowDownload/disableDownload setting in the current ViewerSettingKey contract; this review does not invent such a flag or claim it was ignored.

The exact baseline action was executed with a shared-reader permission fixture and a synthetic retained source. The denial regression failed because the action successfully returned an original URL, not because of a schema/setup failure. Evidence: tmp/release-security-original-issuer-red.log. Only synthetic signing/storage effects were used.

The coordinated fix validates the current/original enum at runtime before authentication/storage, limits original requests to the current owner, and requires nonowner current downloads to pass the actual fresh VideosPolicy.getViewableById policy with the caller identity and verified password-cookie attachment. The newly authorized owner, organization, storage and source pointers must match the initial download metadata before any object head/signing; a changed publication fails closed. ShareHeader sets allowOriginal=false for its reader menu; the owner's editor keeps both choices. Existing published current downloads remain available to authorized shared members.

Fresh native D1 cases verify owner original, member current, denied member original, viewer-grant-only denial, missing/verified video password, roster revocation between initial download eligibility and view authorization, and a source publication winning that same race. Denied cases do not access or sign storage. Invalid runtime variants are separately checked before storage. These checks do not retroactively revoke previously issued bounded-lived URLs or promise instantaneous revocation after authorization completes.

### Other reviewed surfaces

| Surface | Evidence and conclusion |
| --- | --- |
| Published versus retained media | Object route lines196-229 distinguishes exact signed capabilities, owner access and current published assets. Playlist lines187-239 restricts raw preview/old segments and fences legacy early-view data with actual D1 source/edit reads. Fresh95/95 tests include canonical playback, retained-original denial and source/edit publication races. |
| Owner, viewer and workspace authority | VideosPolicy.ts:65-149 retains owner/public/grant/password distinctions. D1 access.ts:116-177 distinguishes viewer/invited/workspace accounts. The new native-D1 compute case proves viewer denial, explicit membership acceptance and immediate denial after membership deletion, using a still-existing viewer session/grant. |
| Upload/publication | media-multipart-context.ts:38-175 checks writable video, current storage, exact immutable output, generation/attempt and active lease. Signed uploads are owner-bound. Comment-media capabilities are user/video/key/expiry scoped; they do not grant comment creation after an access-policy denial. No cross-owner publication bypass was confirmed in the inspected paths. |
| Extension consent | Extension/Http.ts:24 validates the configured Chrome ID; approveAuth at line260 checks same-origin browser initiation before minting. State is generated randomly and checked on return. The extension pins authenticated requests to the stored instance origin. No website token bridge or externally_connectable grant was found in the inspected message plumbing. Public native launchWebAuthFlow still needs live acceptance. |
| Runtime configuration fence | Reviewed the API agent's shared fingerprint helper and Worker/DO comparison: caller fingerprints are overwritten, missing/stale fingerprints fail503 before Node forwarding, and the internal header is removed before Node. Private callbacks, workflow and maintenance use the same helper. Fresh combined runtime/header18/18 tests passed. Older matching Worker/DO pairs during eventual rollout are a documented convergence limitation, not a promise of instantaneous global secret rotation. |
| AI/transcript data | Cloudflare model/account endpoint restrictions and immutable transcript publication claims were traced. The new Whisper parser validates finite source-bounded timings and does not invent speakers/offsets. Inspected share rendering uses text/React rather than executing transcript content. Live edit/audio alignment remains functional acceptance, not established by this security review. |
| Secret and object handling | New tests use synthetic model output and private-source-free fixtures. The new header normalization does not log client IP or credentials. No new external messages, keys, app secrets, public bucket changes or production mutations were made by this reviewer. A speculative dot-segment key hypothesis did not demonstrate an authenticated cross-owner read and was not classified as a vulnerability. |

## Dependency boundary

The [GitHub advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) still lists Zod versions below4.6.6 as affected. Root and standalone media patch registrations were checked, and the root constrained-collection regression passed18/18. The earlier preflight documents the standalone installation checks and Docker patch copy. This review did not rerun the entire production dependency audit or a memory-exhaustion attack. Unbounded schemas are outside this constrained-collection backport; authenticated ingress and request-specific limits must not be represented as a universal parser budget.

## Verification and handoff

- tmp/release-security-compute-tests.log:30/30 across docs route13, docs helper5, Loom route6 and actual D1 workspace6.
- tmp/release-security-originals-tests.log:95/95 across object route2, object verification31, response headers23 and playlist39.
- tmp/release-security-runtime-tests.log:18/18 across runtime configuration/boundary14 and request headers4, including the concurrent API agent's completed fence.
- tmp/release-security-zod-tests.log:18/18 root constrained-collection checks.
- tmp/release-security-download-tests.log:94 pass/one optional benchmark skipped across the actual download action/native D1, existing download permissions, desktop replacement and share-page regressions. This overlaps the separate share-page run below; do not sum it as independent coverage.
- tmp/release-security-download-ui-perf-tests.log:6/6 with the optional22-load share-page benchmark enabled, plus owner/reader menu rendering. Query frontier remains20 queries per representative load.
- tmp/release-security-types.log: scoped changed production and test graph, zero TypeScript diagnostics and exit0. Scoped Biome for eight touched files passes; scoped diff check passes. Native D1 scratch was directed to E: to avoid the coordinator's full-suite resource pressure.

Files owned by this review are the two compute routes, the new shared compute-access helper, docs route tests, the new Loom route tests, the native workspace test, request-headers.ts and request-headers.test.mjs, the download action, ShareHeader and VideoDownloadMenu, download key/native D1/menu tests, plus this report. No schema/migration/native-app file was changed. The coordinator owns all other working changes and the full-suite source-window accounting.

SEC-01B/02/03 are closed in coherent source. Final release must contain these changes in both the web image and Worker, then verify anonymous denial, legitimate workspace requests and owner/member download boundaries on the intended image. The coordinator still owns final source/image identity, end-to-end recording/edit/export, member and extension sign-in, final security/QA sequencing and public cutover. No deployed-image or complete-release signoff is implied here.

## Completed-processing receipt follow-up

Independently reviewed commit04f7c07's save-edits.ts receipt-admission change after the coordinator requested a final bounded pass. No new Medium-or-higher issue or retained-original publication bypass was confirmed in that change. Owner authentication and the editing capability check still precede receipt admission. A completed generic receipt requires an exact owned, currently published immutable output, completed run identity, matching upload/raw/storage/organization identity and coherent completion timestamps. It does not generally waive complete/error or legacy edit rows.

At markEditProcessing the actual D1 snapshot reloads the video and upload. A matching full captured run/upload tuple is consumed with the new edit reservation and edit metadata in one guarded batch. Base/source and previous edit-spec checks remain. Old generic completion replay returns before touching the edit reservation because its run remains complete. Legacy recovery still requires its explicit runtime flag and quiescence check. The new path does not delete raw/source objects or publish the original as the current output before an edit workflow commits.

Fresh independent target run tmp/release-security-completed-receipt-tests.log passed15/15 actual D1 cases;40 unrelated cases were intentionally filtered out. The selected cases include Save, Restore after reprocessing, original-input classification, nine invalid receipts, concurrent upload/run mutations at the guard boundary and whole-batch rollback when reservation insertion fails. This is independent of the implementer's75-case evidence and does not establish live FFmpeg/export/Restore acceptance.

One non-blocking proof qualification was reported to and accepted by the coordinator: if a previously captured completed receipt's upload row disappears entirely before markEditProcessing, the current code can proceed through the ordinary no-upload path if the captured owner/source/base checks still pass and no active edit marker exists. No completed receipt is consumed in that path. Therefore the narrower claim is that mismatched still-present completed reservations are rejected; the code does not promise that every disappearance of a historical receipt rejects an otherwise ready owner edit. No unauthorized access, source-object deletion or incorrect publication was demonstrated from that case. No product source or test was changed by this follow-up review.
