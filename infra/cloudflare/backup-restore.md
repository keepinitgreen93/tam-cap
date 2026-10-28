# Metadata and media restore drill

Run from the repository root on Windows with Node 24, PowerShell 7.4+, and an already authenticated Wrangler profile. The script reads the current user's Wrangler OAuth credential in memory. It does not publish credentials, SQL, signed transfer URLs, record contents, or request headers. No local SQL plaintext file is created.

```powershell
node --disable-warning=ExperimentalWarning --test scripts/cloudflare/backup-restore-drill.test.mjs
node --disable-warning=ExperimentalWarning scripts/cloudflare/backup-restore-drill.mjs t809aq1ds07sh6z
```

The video argument must identify a specifically authorized synthetic clip. The current drill targets the project's metadata D1 database and private video R2 bucket only; their public resource identifiers are fixed in the script. No application database is created, replaced, imported into, or deleted. D1's export API briefly locks its source database while exporting; run this bounded operation at a suitable point in recording/edit acceptance.

The drill:

1. Exports metadata through D1's polling API, fetching its temporary signed SQL URL without forwarding the Cloudflare authorization header.
2. Protects the export with Windows DPAPI CurrentUser under `.secrets/backups/<run-UUID>/metadata.sql.dpapi`. It decrypts that protected file back into memory and verifies byte identity before proceeding.
3. Executes the exported snapshot in an in-memory SQLite reference and checks its integrity. The reference is the export, so later application mutations do not change the expected result.
4. Creates a new database named `tam-cap-restore-drill-<run-UUID-without-hyphens>`. Imports the SQL through D1's signed upload/import API, never into the application database.
5. Compares schema definitions and every table's row count and canonical SHA-256 against the snapshot reference, then runs `PRAGMA quick_check` and `PRAGMA foreign_key_check`. Counts include the exported migration table. The existing small team dataset is the verified scale; this in-memory implementation is not a large-database capacity claim.
6. Selects the authorized clip's raw key and active output key from the exported metadata. Copies each full object into `.restore-test/<run-UUID>/` in the existing private bucket, reads it back, and verifies its length and full SHA-256.
7. Writes the verified private receipt before deleting anything. Deletes only the two exact sample keys created by this run and the newly created database after checking its ID and name. Confirms each resource returns 404 after deletion. Source media, application metadata, bucket settings, Worker configuration and public gates remain untouched.

The normal console output contains only counts, a private receipt path, and verification/cleanup booleans. Detailed counts, table hashes, sample hashes and resource identities are in `report.json` beside the protected snapshot. Failed verification retains its temporary resources and writes their identities in that receipt; investigate those exact resources before any cleanup. There is no wildcard cleanup command or option to import into an existing database.

To rehearse recovery from a previously saved protected snapshot, use:

```powershell
node --disable-warning=ExperimentalWarning scripts/cloudflare/backup-restore-drill.mjs t809aq1ds07sh6z --snapshot ".secrets/backups/<previous-run-UUID>/metadata.sql.dpapi"
```

This still creates a fresh isolated restore database and fresh private sample prefix, then verifies against that saved export. Its media references must still exist. Repeat the normal command after final editing acceptance to capture the final transcript/edit metadata and sample the edited active output, rather than an older render.

DPAPI protection is bound to this Windows user and its DPAPI recovery material. Preserve the protected runtime backup and its protected key separately: encrypted application fields also require their application encryption key. A copied DPAPI file alone has not been demonstrated recoverable on a different machine or user account. Do not add protected snapshots, browser profiles, credentials or private receipts to Git.

## Proof limits

This verifies metadata restore and two complete private media samples. It does not back up the full R2 bucket, analytics D1 database, Worker secrets, registry images, deployment configuration, DNS, or active processing state. The workflow Durable Object is separate persistence and is not contained in a D1 SQL export. A D1 restore must not be represented as recovery of workflow leases, queue deliveries, timers or in-flight media jobs. Those need a separately tested drain/recovery procedure. D1 snapshot time and the later R2 copy are not a single atomic cross-service backup. This drill is not a full disaster-recovery claim.

Cloudflare documents the [export](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/) and [import](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/) APIs used here. Signed transfer URLs are restricted in the script to Cloudflare's HTTPS R2 storage domain.
