# TAM Cap: Cloudflare fork

## Accepted direction

Chris authorized the full Cap fork on 2026-10-27 after reviewing the compatibility and maintenance tradeoffs. Keep all application hosting, durable metadata, media storage, processing, and AI on Cloudflare. Resend is an explicitly approved exception for transactional email. Do not use Railway or AWS hosting. Target approximately $20/month, measuring actual usage rather than promising an untested cap. No per-user hosted Cap subscription is planned; distributed desktop binaries have separate licensing terms.

The application target is https://videos.trulyauthenticmarketing.com and the owner is hello@trulyauthenticmarketing.com. The team needs recording, editing, sharing, organization membership, transcripts, titles/summaries/chapters, filler-word removal, silence removal, and migration of its existing Loom library. Recorder count, video hours, and library size have not been supplied; these do not block implementation but prevent a firm operating-cost estimate.

## Preserve the application

Fork upstream Cap, retain copyright/license notices and its desktop/API contracts. Do not substitute a basic upload portal or advertise a full replacement before the end-to-end recording flow works. Pin the imported source commit. Keep Cloudflare changes modular where practical so upstream security fixes remain mergeable.

## Target architecture

- Cap web runs on Cloudflare, with Workers routing and Containers only where native Node/process support is necessary. Prefer sleeping workers over always-on large containers.
- D1 stores relational metadata. Port MySQL schema, query semantics, transaction boundaries, and callers deliberately. Do not run production MySQL on ephemeral container storage or assume R2 FUSE gives database durability.
- A dedicated private R2 bucket stores video originals and derived assets. Only authorized or intentionally shared requests can obtain media. Uploads should go directly to R2 through scoped authorization.
- Cloudflare Queues/Workflows and durable state coordinate media jobs; FFmpeg executes in a bounded container. Restarts must not lose accepted jobs or duplicate imports.
- Workers AI Nova-3 is the initial transcription candidate because it preserves fillers and exposes word times. Adapt its output into Cap's edit transcript. Keep AI generation on a Cloudflare-hosted model, without external provider fallbacks.
- Resend remains the transactional email provider. Use verified sender settings and protected secrets. No credentials enter Git or chat.
- Filler and silence cleanup preserve original media, produce editable cuts, and maintain audio/video synchronization. Silence cleanup is additional work until proven present upstream.

## Rollout

Establish the source fork and isolated Cloudflare resources, then independently test database and transcription adapters. Wire the application only when its persistence and job runtime are compatible. The initial deployed infrastructure is not the application and must not be presented as launch readiness. Do not put an incomplete landing page on the production hostname.

Before production: owner/member login, the built-in browser recording/upload flow, desktop API contract checks, browser playback, unauthorized-access denial, filler/silence edit preview and export, restart recovery, backups/restore, and measured usage must pass. Automated hardware inputs may be synthetic and must be labeled. Native desktop installation is optional for this site's launch. The user subsequently deferred the existing Loom library migration until after the site is live; retain importer capability and migrate in reconciled batches when directed, preserving source URLs and reporting unavailable source videos. Keep the old library available until that migration is reconciled.
