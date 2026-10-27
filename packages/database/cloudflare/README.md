# Cloudflare persistence staging

This is an additive D1 adapter. The application still uses `@cap/database` and its MySQL tables. Importing `@cap/database/cloudflare` does not switch existing callers. Do not switch the application until the remaining semantics below and affected user flows have been verified.

## Implemented and verified

The generated initial migration contains all 49 upstream tables, 502 columns, 128 indexes (including unique indexes), 12 foreign keys, and nine nonnegative checks for upstream unsigned counters. The schema retains relation exports, branded identifier types, JSON shapes, enum types, defaults, generated creation dates, and foreign-key actions.

- Dates are stored as Unix milliseconds and returned as `Date` values. Database-generated current timestamps use seconds multiplied by 1,000; explicit application dates retain milliseconds.
- JSON is stored as text and decoded by Drizzle. Booleans use Drizzle integer/boolean mapping. Integer byte counters retain values above 32 bits; callers still must stay within JavaScript's safe integer range.
- Index names have table prefixes because SQLite's index namespace is database-wide.
- The MySQL storage-object prefix index is non-unique. The SQLite equivalent indexes the complete `objectKey`, which supports exact and prefix-range lookups without MySQL's text-index prefix restriction. No unique prefix index exists in this upstream schema. Drizzle Kit 0.31 generated invalid SQL for the attempted expression index, so the source uses a normal full-key index; generated SQL was not manually edited.
- Email fields use `COLLATE NOCASE`. Tests verify ASCII case-insensitive account lookup and uniqueness, including viewer grants.
- `createCloudflareDb(binding)` uses the supplied D1 binding without a process-global cache. Interactive `transaction()` calls fail before invoking their callback; ported callers must use D1 atomic `batch()` operations or conditional statements.

The Node 24 test suite runs generated migrations in an isolated Miniflare D1 database and disposes it afterward. It checks every upstream table/column shape and index, nullable uniqueness, composite keys, date/JSON/boolean round trips, generated dates, foreign-key rejection and cascade, large counters, and atomic rollback when a batch fails. It does not use production data or credentials.

## Remaining cutover blockers

1. SQLite `NOCASE` handles ASCII case only. It is not MySQL `utf8mb4_unicode_ci`: Unicode case, accent equivalence, trailing spaces, and other string ordering/equality rules still differ. Before auth cutover, define a canonical email/identity strategy shared by registration, login, invitations, viewer grants, and import; reconcile collisions against existing records. Other text columns currently use SQLite's binary collation. The additive adapter must not be represented as Unicode-compatible authentication yet.
2. SQLite text does not enforce upstream `varchar(n)` limits. SQLite integer affinity also differs from MySQL integer ranges. Validate lengths/ranges at every write boundary or add explicit checks before accepting untrusted writes. JSON text written through raw SQL is not automatically validated as MySQL JSON would be; Drizzle JSON serialization and normal application validation remain necessary.
3. MySQL `ON UPDATE CURRENT_TIMESTAMP` becomes Drizzle `$onUpdate`. Updates through this adapter receive the timestamp, but raw SQL updates must explicitly set it. SQLite has no matching automatic column clause. Audit all raw writes and imports.
4. D1 does not support the existing interactive transaction and `SELECT ... FOR UPDATE` model. Do not replace transactions with unrelated statements. Redesign conditional claims, counters, quotas, idempotency, ownership transfers, and read-dependent writes with equivalent atomicity and concurrency tests.
5. Replace MySQL upserts, result-array/`affectedRows` assumptions, MySQL date/JSON/string functions, auth adapters, and Effect MySQL services. Native MySQL drivers must not enter the Worker runtime. D1 parameter, query-size, transaction, and result limits need workload-specific checks.
6. Generated custom creation dates are verified for ISO dates with or without milliseconds and invalid/missing-date fallback. Reconcile legacy metadata formats and timezone assumptions during import; SQLite's date parser is not a full emulation of MySQL `STR_TO_DATE`.
7. No application callers, existing MySQL migrations, runtime provisioning, or production authentication have been switched by this package. Remote deployment, data migration, backup/restore, and end-to-end desktop flows belong to later rollout gates.

## Caller inventory

`caller-audit.json` records source locations from the non-test JavaScript/TypeScript files under `apps` and `packages`. These are line-based review candidates, not proof that every match requires a change. Categories overlap and must not be summed as unique call sites.

| Candidate | Matching lines | Files |
| --- | ---: | ---: |
| Database imports | 781 | 298 |
| MySQL driver/type imports | 12 | 11 |
| Interactive transactions | 123 | 62 |
| MySQL upserts | 25 | 16 |
| MySQL mutation-result assumptions | 117 | 40 |
| Row locks | 140 | 42 |
| SQL dialect candidates | 179 | 48 |

Regenerate from repository root:

```powershell
node scripts/cloudflare/database-audit.mjs > packages/database/cloudflare/caller-audit.json
```

Important groups include organization and user onboarding in `packages/web-backend`, video deletion and storage updates in `packages/web-backend/src/Videos` and `Storage`, authentication and OAuth under `packages/database/auth` and web API routes, media-job leases and budgets, developer credit accounting, and Loom migration claims. Each group needs its own concurrency and ownership assertions before switching persistence.

## Verification commands

Use Node 24 and Bun 1.4.4. From `packages/database`:

```powershell
bun run db:generate:cloudflare
bun run test:cloudflare
```

From the repository root:

```powershell
bun run biome check packages/database/cloudflare/schema.ts packages/database/cloudflare/index.ts packages/database/cloudflare/database.test.ts packages/database/cloudflare/caller-audit.json packages/database/drizzle.cloudflare.config.ts packages/database/package.json scripts/cloudflare/database-audit.mjs
bun run tsc --noEmit --skipLibCheck --strict --target ESNext --module ESNext --moduleResolution bundler --allowImportingTsExtensions packages/database/cloudflare/index.ts packages/database/cloudflare/schema.ts packages/database/cloudflare/database.test.ts packages/database/drizzle.cloudflare.config.ts
```

Migration generation requires no database credentials. Apply through Wrangler's D1 migration commands only to the explicitly selected deployment database after reviewing the generated artifacts. This package never automatically migrates a database at request startup.
