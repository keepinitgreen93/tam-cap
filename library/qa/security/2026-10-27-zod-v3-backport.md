# Zod 3 constrained-collection security backport

Date: 2026-10-27. Scope: GHSA-mrhx-c7xc-m3w5 in the Cloudflare Cap fork only. This is not an application security clearance or a complete dependency audit. The security-stinger's Hivemind-specific catalog does not describe Cap; only its evidence, minimal-remediation, and verification principles apply here.

## Finding and upstream evidence

The [GitHub advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) lists Zod versions below 4.6.6 as affected. The [upstream fix](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd) changes only v4 code: oversized arrays, sets, and maps with existing upper bounds fail before their elements are parsed. It does not introduce a global issue budget or protect unbounded schemas. It does not backport that behavior to the v3 compatibility implementation.

Application and media dependencies still resolve Zod 3.25.76 (`bun.lock:5878`, `apps/media-server/bun.lock:206`) to preserve existing APIs. The root override of Zod 4 alone does not patch those copies. Before remediation, the three-element fixture `z.array(element).max(2)` visited all three elements and produced the size issue plus three element errors. This confirms the same bounded-collection failure pattern without attempting a resource-exhaustion attack.

The signed-upload batch schema at `apps/web/app/api/upload/[...route]/signed.ts:48` has `.max(50)` at line 60 but was still traversing oversized input. Its authentication middleware at line 39 limits access to authenticated callers; it does not prevent an authenticated availability attack. The desktop recording manifest at `apps/web/lib/desktop-recording-source.ts:77` permits 100,002 objects, so replacing existing contracts with a small universal request limit would break supported recording inputs.

Severity: High advisory; constrained-collection traversal locally remediated. The installed package version remains in the advisory's affected range and must be recorded as locally patched, never version-cleared.

## Remediation

The Bun-generated `patches/zod@3.25.76.patch` backports early rejection for existing array `.max()` and `.length()` bounds and set `.max()` and `.size()` bounds. It changes nine logic lines across the package's TypeScript source, ESM runtime, and CommonJS runtime. Zod 3 maps have no equivalent size-bound API to backport. Oversized collections retain a `too_big` issue and fail before any element parser or outer refinement executes. Valid collections, transformations, existing limits, and lower-bound error accumulation retain their previous behavior.

The root patch is registered at `package.json:80` and in the generated `bun.lock:712`. The identical standalone media patch is registered at `apps/media-server/package.json:12` and in its generated `bun.lock:22`. The separate metadata is necessary because the media Docker build installs the package outside the monorepo. `Dockerfile.cloudflare:37` copies its patch directory before the frozen production install. The web stage already copies the repository before installing dependencies. No application schemas or ingress behavior were changed.

## Verification

- Regression: `scripts/verify/zod-collection-bounds.test.mjs`. Before patching: 15 failing resource-bound cases and three passing compatibility cases. After patching: 18/18 passed against the actual root installation under Node 24.19.0.
- Fixtures use only three elements. They prove zero element-parser invocations and one size issue for oversized array/set inputs, including nested paths, sync/async parsing, the default ESM entry point, `zod/v3`, and CommonJS. They also verify valid transformations and lower-bound behavior.
- Bun 1.4.4 root `install --frozen-lockfile --ignore-scripts` passed. The expected warning about a workspace package's `patchedDependencies` is harmless: the root entry supplies the workspace patch, while the media entry applies when built independently.
- An isolated copy of the actual standalone media package, generated lockfile, and patch completed `install --frozen-lockfile --production --ignore-scripts`. Its own dependency installation passed all 18 cases under both Node 24.19.0 and Bun 1.4.4. Native install scripts were intentionally skipped for this dependency-level verification.
- Scoped Biome checks passed for the touched package manifests and regression. Biome does not process this Markdown report; its text and whitespace were reviewed directly. The patch copies are identical. The security diff was reviewed independently of other agents' concurrent application edits.

## Remaining limits and release checks

This is the exact constrained-collection mitigation, not a universal resource policy. Unbounded public application schemas remain visible at `apps/web/app/api/upload/[...route]/multipart.ts:431`, `apps/web/app/api/upload/[...route]/comment-media.ts:269`, `apps/web/app/api/developer/sdk/v1/[...route]/upload.ts:157`, and `apps/web/app/api/video/metadata/route.ts:48`. The upload routes use authentication; metadata validates a current user before its Zod parse. These paths need a separate route-aware body/collection budget review if the release criterion includes broader authenticated denial-of-service resistance. Upgrading to 4.6.6 alone would not supply missing bounds either.

Media has additional unbounded schemas at `apps/media-server/src/routes/video.ts:239` and line 2473. Its routes authenticate a shared secret before JSON/Zod parsing, and the current Cloudflare design exposes media only through private container egress. That reduces public reachability but does not make unlimited trusted inputs safe.

The current private staging image predates this patch. A new image must be built from the final reviewed source before production release. The complete web build, Linux container image contents, and application acceptance suites were not rerun by this bounded task; the coordinating release process owns those checks. Keep the version-based advisory finding documented with this patch and regression evidence. No secrets, deployments, commits, external messages, or emails were created by this task.
