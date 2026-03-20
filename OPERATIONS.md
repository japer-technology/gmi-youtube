# Operations

This document describes the credentials, quota budget, and safety boundaries for station operations.

## Required Credentials

| Secret | Type | Purpose | Where to Set |
|---|---|---|---|
| `YOUTUBE_API_KEY` | API Key | Read-only access to public YouTube data | Repository Settings → Secrets → Actions |

### OAuth (Future)

Some operations (e.g. caption downloads, user activity) require OAuth 2.0 credentials. When needed:

| Secret | Type | Purpose |
|---|---|---|
| `YOUTUBE_CLIENT_ID` | OAuth | Application client ID |
| `YOUTUBE_CLIENT_SECRET` | OAuth | Application client secret |
| `YOUTUBE_REFRESH_TOKEN` | OAuth | Long-lived refresh token for user context |

OAuth credentials are not required for the initial scaffold. They will be added when the ingestion pipeline needs authenticated access.

## API Key vs OAuth

| Operation | Auth Required |
|---|---|
| `channels.list` (public) | API Key |
| `videos.list` (public) | API Key |
| `playlists.list` (public) | API Key |
| `playlistItems.list` (public) | API Key |
| `search.list` | API Key |
| `subscriptions.list` (own) | OAuth |
| `activities.list` (own) | OAuth |
| `captions.list` | API Key |
| `captions.download` | OAuth |
| `commentThreads.list` | API Key |

## Daily Quota Budget

The YouTube Data API v3 provides a default quota of **10,000 units per day**.

| Operation | Cost (units) | Budget Priority |
|---|---|---|
| `channels.list` | 1 | High — core metadata |
| `videos.list` | 1 | High — video detail |
| `playlists.list` | 1 | Medium |
| `playlistItems.list` | 1 | Medium |
| `subscriptions.list` | 1 | High — subscription intelligence |
| `activities.list` | 1 | Medium |
| `search.list` | 100 | Low — use intentionally |
| `commentThreads.list` | 1 | Low |
| `captions.list` | 50 | Low — selective use |
| `captions.download` | 200 | Low — selective use |

### Budget Strategy

- Prioritise subscription and channel intelligence (low cost, high value)
- Reserve 2,000+ units for interactive user requests
- Avoid search.list in scheduled workflows unless explicitly budgeted
- Track quota usage in workflow logs
- Degrade gracefully when quota is constrained

## Safe Local Commands

These commands are safe to run locally without side effects:

| Command | Effect |
|---|---|
| `bun run check` | Validates schemas and resources (read-only) |
| `bun run build` | Builds site to `dist/` (local output only) |
| `bun run publish` | Reports build status (no deployment locally) |

## Commands That Write State

| Command | Effect | Guard |
|---|---|---|
| `bun run ingest` | May update `resources/` if API key is set | Requires `YOUTUBE_API_KEY` |

## Workflows and Write Behaviour

| Workflow | Trigger | Writes to Repo | Uses Quota |
|---|---|---|---|
| `validate.yml` | Push to main, manual | No | No |
| `ingest.yml` | Manual dispatch | Yes — commits to `resources/` | Yes |
| `scheduled-ingest.yml` | Daily cron (06:00 UTC), manual | Yes — commits to `resources/` | Yes |
| `publish.yml` | Push to main, manual | No — deploys to Pages | No |

## Safety Principles

1. **No silent writes** — Any command or workflow that changes repository state is explicitly named and documented.
2. **No hidden quota spending** — Workflows that call the YouTube API are clearly labelled.
3. **Credentials never in code** — All secrets are stored as GitHub repository secrets, never in source files.
4. **Graceful degradation** — If `YOUTUBE_API_KEY` is missing, `ingest` reports the absence and exits cleanly.
5. **Manual before automatic** — Manual dispatch workflows are available before any scheduled automation runs.
