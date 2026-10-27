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
