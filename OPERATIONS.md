# Operations

This document describes the credentials, quota budget, and safety boundaries for station operations.

## Required Credentials

| Secret | Type | Purpose | Where to Set |
|---|---|---|---|
| `YOUTUBE_API_KEY` | API Key | Read-only access to public YouTube data | Repository Settings → Secrets → Actions |

### OAuth Credentials

OAuth credentials enable subscription intelligence — the highest-value signal for a personal station.

| Secret | Type | Purpose | Where to Set |
|---|---|---|---|
| `YOUTUBE_CLIENT_ID` | OAuth | Google Cloud application client ID | Repository Settings → Secrets → Actions |
| `YOUTUBE_CLIENT_SECRET` | OAuth | Google Cloud application client secret | Repository Settings → Secrets → Actions |
| `YOUTUBE_REFRESH_TOKEN` | OAuth | Long-lived refresh token for user context | Repository Settings → Secrets → Actions |

When OAuth credentials are not configured, the system falls back to API-key-only mode. It will read the existing `resources/subscriptions.json` index (if present) and fetch recent uploads for listed channels using the API key. The subscription list itself cannot be updated without OAuth.

### One-Time OAuth Setup

To obtain OAuth credentials:

1. **Create a Google Cloud project** at [console.cloud.google.com](https://console.cloud.google.com/)
2. **Enable the YouTube Data API v3** in the project's API library
3. **Create OAuth 2.0 credentials** (type: Web application)
   - Add `http://localhost:8080` as an authorized redirect URI
4. **Note the Client ID and Client Secret** — these are `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`
5. **Obtain a refresh token** using the OAuth consent flow:

   ```
   # Open this URL in a browser and grant consent:
   https://accounts.google.com/o/oauth2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:8080&response_type=code&scope=https://www.googleapis.com/auth/youtube.readonly&access_type=offline&prompt=consent

   # After consent, Google redirects to http://localhost:8080?code=AUTH_CODE
   # Exchange the code for tokens:
   curl -X POST https://oauth2.googleapis.com/token \
     -d code=AUTH_CODE \
     -d client_id=YOUR_CLIENT_ID \
     -d client_secret=YOUR_CLIENT_SECRET \
     -d redirect_uri=http://localhost:8080 \
     -d grant_type=authorization_code

   # The response contains a refresh_token — this is YOUTUBE_REFRESH_TOKEN
   ```

6. **Store all three values** as GitHub repository secrets

The refresh token is long-lived and does not expire unless revoked. The ingestion script automatically exchanges it for short-lived access tokens as needed.

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
| `bun run ingest` (subscriptions scope with OAuth) | Updates `resources/subscriptions.json`, `resources/channels/`, `resources/videos/` | Requires OAuth secrets |
| `bun run ingest` (subscriptions scope without OAuth) | Updates `resources/videos/` from existing subscription index | Requires `YOUTUBE_API_KEY` and `resources/subscriptions.json` |
| `bun run generate-guide` | Writes `resources/guide/<date>.json` from ingested videos | Requires ingested video resources; env `GUIDE_DATE` |
| `bun run generate-receipt` | Writes `resources/receipts/receipt-<date>.json` from guide and video data | Requires guide and video resources; env `RECEIPT_DATE`, `RECEIPT_PERIOD`, `RECEIPT_FORCE` |
| `bun run curator` | Executes curator actions; may write guides, receipts, wall layouts, video tags, and curator state | Requires `CURATOR_ACTION`; some actions need `YOUTUBE_API_KEY` |

## Workflows and Write Behaviour

| Workflow | Trigger | Writes to Repo | Uses Quota |
|---|---|---|---|
| `validate.yml` | Push to main, manual | No | No |
| `ingest.yml` | Manual dispatch | Yes — commits to `resources/` | Yes |
| `scheduled-ingest.yml` | Daily cron (06:00 UTC), manual | Yes — commits subscriptions, channels, videos, and guide to `resources/` | Yes |
| `publish.yml` | Push to main, manual | No — deploys to Pages | No |

## Safety Principles

1. **No silent writes** — Any command or workflow that changes repository state is explicitly named and documented.
2. **No hidden quota spending** — Workflows that call the YouTube API are clearly labelled.
3. **Credentials never in code** — All secrets are stored as GitHub repository secrets, never in source files.
4. **Graceful degradation** — If `YOUTUBE_API_KEY` is missing, `ingest` reports the absence and exits cleanly.
5. **Manual before automatic** — Manual dispatch workflows are available before any scheduled automation runs.
