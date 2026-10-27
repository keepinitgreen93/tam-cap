# Protected runtime configuration recovery

The application secrets are stored in Cloudflare Worker `tam-cap-app`. A recovery copy is encrypted in the project-local `.secrets/runtime.json`; its RSA key is protected by Windows DPAPI for the current Windows user in `.secrets/runtime-key.dpapi`. Both paths are excluded from Git and Docker build contexts. Do not publish them or include them in support logs.

Use PowerShell 7.4 or later from the repository root:

```powershell
./scripts/cloudflare/runtime-secrets.ps1 -Operation Verify
```

This verifies decryption, deployment identity, and required credential presence without printing secret values. Recovery is bound to this Windows user/profile; these two files alone are not a portable cross-machine key backup.

To restore the existing protected values to the staging Worker:

```powershell
wrangler whoami
./scripts/cloudflare/runtime-secrets.ps1 -Operation Publish -Origin https://tam-cap-app.ciglesia.workers.dev
```

To switch application URL settings during the authorized production cutover, use the same command with `https://videos.trulyauthenticmarketing.com`. It accepts only these two origins, publishes credentials over the authenticated Wrangler CLI's stdin, and reseals the backup. It does not create DNS records, build an image, or turn on application readiness. The public build-time URL must match the selected origin too.

The preview gate uses a separate temporary credential, not a user authentication bypass. The Node application still validates ordinary NextAuth sessions.

Database validation preflight uses `node scripts/cloudflare/validation-preflight.mjs` with Node 24 and authenticated Wrangler. It emits table counts only; nonzero invalid-row counts stop the script before migration. D1 schema migration and backup/restore remain separate operations.

## Database restore drill

On 2026-10-27 at 19:25 UTC, the staging metadata database was exported and imported into a newly created, isolated Cloudflare D1 database. Comparison confirmed identical schema, all 51 application/concurrency tables, all four current records, zero mismatched tables, `PRAGMA quick_check` returning `ok`, and zero foreign-key violations. The temporary restore database was deleted after verification. No production database was overwritten.

The export is protected with Windows DPAPI (CurrentUser) at `.secrets/metadata-20261027.sql.dpapi`, with entropy `tam-cap-d1-export-v1`. Decryption was round-trip verified before removing the temporary plaintext SQL. This is a staging restore drill, not proof that future production media have been backed up. Repeat the drill after representative videos and edits exist.

Use Node24 with Wrangler4.152 or later for this deployment; the older global4.123 failed export authentication while the newer authenticated CLI succeeded. Capture export output privately: Wrangler prints a temporary signed download URL. Never paste it into tickets, logs, or chat. The SQL includes private account/session records.

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) is automatic and supports point-in-time recovery for 30days on the paid plan. Recover the database and matching media state together; a metadata-only restore cannot recover deleted R2 objects. D1 supports [`quick_check` and `foreign_key_check`](https://developers.cloudflare.com/d1/sql-api/sql-statements/); full SQLite `integrity_check` is not permitted through D1.
