# Pinned application releases

Prepare releases from the repository root with Node 24, the repository dependencies installed from the lockfile, and Wrangler 4.152 or later. Keep the CI manifest and generated config with the release record. They contain public resource identifiers and immutable image references; secrets belong in the protected runtime backup and Worker secret bindings.

The generator writes a local config. Authentication, secret publication, deployment, acceptance and cutover are separate operator actions.

## Select the CI artifact

Download `image-manifest.json` from a successful **TAM Cap Cloudflare images** workflow run for the intended full source revision and target. Establish that CI provenance before generation. The generator validates identity and shape; it does not authenticate to GitHub or inspect registry image contents.

| Target | Required compiled origin | Worker routing |
| --- | --- | --- |
| `staging` | `https://tam-cap-app.ciglesia.workers.dev` | `workers_dev=true`, no custom routes |
| `production` | `https://videos.trulyauthenticmarketing.com` | `workers_dev=false`, only that custom domain |

The four manifest fields are `webImage`, `mediaImage`, `origin` and `sourceRevision`. Images must be exact `registry.cloudflare.com/c1e96a4b36c73f3cf4ddf50a90082d94/tam-cap-web@sha256:<64 lowercase hex>` and the matching `tam-cap-media` repository. The source revision must have 40 lowercase hexadecimal characters. Tags, other accounts/repositories, extra fields and a target/origin mismatch are rejected. A staging web build cannot become a production web build by changing runtime origins.

## Generate and review

Run the local checks:

```powershell
node --test scripts/cloudflare/write-release-config.test.mjs
bun run biome check scripts/cloudflare/write-release-config.mjs scripts/cloudflare/write-release-config.test.mjs
```

For private staging:

```powershell
$releaseManifest = "artifacts/staging/image-manifest.json"
node scripts/cloudflare/write-release-config.mjs --manifest $releaseManifest --target staging
$releaseArtifact = Get-Content -LiteralPath $releaseManifest -Raw | ConvertFrom-Json
$releaseConfig = "infra/cloudflare/releases/staging-$($releaseArtifact.sourceRevision).json"
```

For production, select the production artifact explicitly:

```powershell
$releaseManifest = "artifacts/production/image-manifest.json"
node scripts/cloudflare/write-release-config.mjs --manifest $releaseManifest --target production
$releaseArtifact = Get-Content -LiteralPath $releaseManifest -Raw | ConvertFrom-Json
$releaseConfig = "infra/cloudflare/releases/production-$($releaseArtifact.sourceRevision).json"
```

The default output is `infra/cloudflare/releases/<target>-<full-source-revision>.json`. `--output` accepts another `.json` path beneath that directory, including nested directories. Path segments use letters, digits, dots, underscores and hyphens. Absolute paths, traversal, encoded path tricks, Windows device names, symlinks/junctions and output hard links are refused.

Generation clones `wrangler.runtime.jsonc`, preserving account/application identity, D1/R2 bindings, Durable Objects, queues, cron triggers, migration history and native `durable_object` scheduling policy. Only each container's `images.base` becomes its immutable reference. Worker `main` and D1 `migrations_dir` paths are rebased relative to the destination config, so generated files remain portable within the checkout. `CAP_DEPLOYMENT_ID` becomes the full source SHA and `CAP_WEB_IMAGE_REVISION` the full pinned web image reference used by the configuration fingerprint.

Both `CAP_RUNTIME_READY` and `CAP_MAINTENANCE_ENABLED` default to the string `false`, regardless of the template or an existing file. Only explicit `--ready` and `--maintenance` enable them for that invocation. Review the generated file and its diff before deployment. It contains no runtime secret payloads.

Existing files are preserved unless `--force` is present. Force requires the existing file to match a generator-produced configuration for the same application, account, target and current checked-in template. Unknown files, hand edits, changed bindings and a different target are rejected. Use a new output path when the template itself changes; retain the older config as a release record. There is no implicit preservation of enabled gates when forcing an update.

Both targets retain the existing application/resource IDs. Deploying a staging config after production routing would replace that routing; use the intended target's artifact and config throughout the operation.

## Deploy closed, then prove propagation

1. Preserve the previous manifest/config, the protected runtime backup and a tested metadata/media recovery record. Follow [backup and restore](backup-restore.md); workflow Durable Object storage and queue deliveries are separate from a D1 export. Drain or reconcile active processing before changing application configuration.
2. Publish matching runtime origins and other intended settings through protected input. Keep authentication secrets stable unless an intentional rotation is part of the operation. `runtime-secrets.ps1 -Operation Verify` checks the existing protected backup. Its explicit `-Operation Publish -RestartWeb` option publishes a nonsecret environment nonce to request a web refresh without rotating the auth secret; apply it only as a deliberate operator action, then repeat propagation checks.
3. With readiness and maintenance still false, validate and deploy the reviewed config using the operator's existing authenticated profile:

   ```powershell
   wrangler deploy --config $releaseConfig --dry-run --containers-rollout none
   wrangler deploy --config $releaseConfig --containers-rollout none
   ```

4. Keep the application closed while old/new Worker, Durable Object and container state converge. The runtime compares a fingerprint of effective environment, image revision and deployment ID. A new Worker reaching an old configuration receives a temporary non-cacheable 503. Preserve the fingerprint, DO bindings and migration history. A successful Worker deployment or an elapsed idle timeout does not identify the running Node/media images.
5. Use the exact target origin and protected preview access to verify behavior unique to the intended web image and the selected media image. Keep the preview key confined to that origin. Media may finish existing work before adopting an image; verify its actual processing behavior rather than assuming the Worker deployment replaced a running VM.
6. **Before another login email or new JWT/session is issued**, verify several independent `GET /api/auth/csrf` results against the intended protected auth secret in memory. Compare the cookie hash with SHA-256 of token plus secret and report only status/match booleans. Preserve neither tokens, cookies, signed media URLs nor secrets in logs. Require both consistent CSRF matches and new-image proof. Investigate mixed results or configuration 503s before continuing. [Configuration refresh and session rotation](configuration-refresh.md) defines this propagation fence in detail.
7. Complete the owner recording, playback, fractional-fps completion, transcription/edit, sharing, recovery and client acceptance gates on the coherent target. This runbook and config generation do not establish final QA or launch approval.

After those gates pass, regenerate the same target/config with the explicit desired public and maintenance state:

```powershell
node scripts/cloudflare/write-release-config.mjs --manifest $releaseManifest --target production --output $releaseConfig --ready --force
wrangler deploy --config $releaseConfig --containers-rollout none
```

For staging use `--target staging`. Enable scheduled maintenance only when its acceptance is complete by adding `--maintenance` to the generation command. Every later forced generation must state both desired flags explicitly. Confirm private workspace rules and fresh requests after opening the public gate.

## Recovery and rollback

Close readiness and maintenance by regenerating the current target/config with `--force` and neither enabling switch, then deploy that closed config. Reconcile in-flight callbacks and workflow deliveries before selecting a previous manifest. Reuse the previous immutable images only after checking their compatibility with the current metadata schema and durable workflow state, and repeat image/CSRF propagation checks.

Keep D1/R2 resources, the workflow DO namespace, SQLite class migration history, pending queues and failed deliveries intact. Do not delete fingerprints, purge queues, recreate bindings or destructively reverse metadata migrations to make an old image start. Apply reviewed forward-compatible migrations separately from image deployment. Restore data only through a separately verified recovery procedure; a config or image rollback does not roll back stored data.
