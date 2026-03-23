# YouTube API Services — Implementation, Access, Integration, and Use

## Document Purpose

This document describes how Station ("the API Client") implements, accesses, integrates, and uses YouTube API Services. It is prepared for Google's YouTube API Services compliance review as required by the [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service).

Station is an open-source, self-hosted personal TV station that transforms a user's YouTube subscriptions into a calm, intentional viewing experience. All source code, data schemas, ingestion pipelines, and front-end pages are publicly available at [github.com/japer-technology/gmi-youtube](https://github.com/japer-technology/gmi-youtube).

---

## 1. Application Overview

### What Station Does

Station reads a user's own YouTube subscription data through the YouTube Data API v3 and presents it as a personal TV station with the following screens:

| Screen | Purpose |
|---|---|
| **TV Guide** | Time-based editorial schedule of upcoming and recent videos organised into viewing blocks (morning, midday, afternoon, evening, late) |
| **Channel Wall** | Configurable grid of subscribed channels showing each channel's most recent upload |
| **Search** | Keyword search across video titles, descriptions, tags, and transcripts with timestamp deep-linking |
| **Viewing Receipts** | Daily and weekly summaries of what was scheduled, watched, and skipped |
| **Curator Chat** | Conversational interface to an AI curator that builds guides, recommends content, and learns from viewing patterns |
| **About** | Static information page describing how Station works |

### How Station Is Accessed

Station is deployed as a **static website** served by GitHub Pages. It has no server-side runtime, no user accounts, and no database. All data is stored as versioned JSON files in the GitHub repository.

A single user (the repository owner) configures their own YouTube API credentials. The site renders that user's own data. There is no multi-tenant access and no public-facing API.

---

## 2. YouTube API Services Used

Station uses the **YouTube Data API v3** exclusively. No other YouTube API Services (YouTube Analytics API, YouTube Reporting API, YouTube Live Streaming API, etc.) are used.

### API Endpoints Called

| Endpoint | HTTP Method | Part(s) Requested | Purpose | Quota Cost |
|---|---|---|---|---|
| `channels.list` | GET | snippet, statistics, contentDetails | Fetch channel metadata (title, description, thumbnail, subscriber count, upload playlist ID) | 1 unit |
| `videos.list` | GET | snippet, statistics, contentDetails, liveStreamingDetails | Fetch video details (title, description, duration, view/like counts, live broadcast status, scheduled premiere times) | 1 unit |
| `playlistItems.list` | GET | snippet, contentDetails | Paginate through a playlist to discover video IDs | 1 unit |
| `playlists.list` | GET | snippet, contentDetails | Fetch playlist metadata (title, description, item count) | 1 unit |
| `subscriptions.list` | GET | snippet | Fetch the authenticated user's subscription list (OAuth only) | 1 unit |
| `captions.list` | GET | snippet | Fetch caption track metadata for a video (language, track kind) | 50 units |
| `captions/{id}` | GET | — | Download transcript content for a specific caption track (OAuth only) | 200 units |
| `search.list` | GET | snippet | Search YouTube for videos by keyword (used sparingly by the curator's optional API search) | 100 units |

### OAuth Scopes Requested

Station requests a single read-only OAuth scope:

```
https://www.googleapis.com/auth/youtube.readonly
```

This scope provides read access to the authenticated user's YouTube account data, including their subscription list, which is the core signal for personalisation. Station never writes to YouTube — it does not upload videos, post comments, modify playlists, or change any user data on YouTube.

---

## 3. Authentication and Authorisation

Station supports two authentication modes, with graceful degradation between them.

### Mode 1: API Key Only

When only `YOUTUBE_API_KEY` is configured:

- All public endpoints (`channels.list`, `videos.list`, `playlists.list`, `playlistItems.list`) work normally.
- `subscriptions.list` is **not available** — the system falls back to an existing subscription index file if present.
- `captions.list` uses the API key (may fail for some videos; errors are handled per-video without crashing).
- Transcript downloads (`captions/{id}`) are **skipped** and the user is clearly informed.
- The system logs a capability summary showing which features are available and which are degraded.

### Mode 2: Full OAuth

When OAuth credentials (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`) are configured in addition to the API key:

- `subscriptions.list` fetches the user's own subscription list.
- `captions.list` uses OAuth for preferred access.
- Transcript downloads (`captions/{id}`) are enabled.
- All API-key endpoints continue to use the API key (lower privilege where sufficient).

### Token Handling

- The refresh token is stored as a GitHub repository secret and never committed to source code.
- At runtime, the ingestion script exchanges the refresh token for a short-lived access token via `https://oauth2.googleapis.com/token`.
- The access token is cached in memory for the duration of a single ingestion run and is never persisted to disk or logged.
- Each GitHub Actions workflow run starts with a fresh environment — no tokens persist between runs.

### Credential Security

- All credentials are stored exclusively in GitHub repository encrypted secrets.
- The source code contains zero hardcoded keys, tokens, or secrets.
- Credentials are never written to log output.
- The ingestion script validates credential presence at startup and exits cleanly with an informative message if required credentials are missing.

---

## 4. Data Accessed and Stored

### What Data Is Retrieved from YouTube

Station retrieves the following categories of data through the YouTube Data API:

**Channel data:**
- Channel ID, title, description, custom URL
- Thumbnail URL
- Subscriber count, video count
- Uploads playlist ID (from `contentDetails`)

**Video data:**
- Video ID, channel ID, title, description
- Published date, thumbnail URL
- Duration, view count, like count
- Live broadcast content status (none, upcoming, live)
- Scheduled premiere and live stream timestamps
- Caption availability flag

**Playlist data:**
- Playlist ID, channel ID, title, description
- Thumbnail URL, item count
- Ordered list of video IDs

**Subscription data (OAuth only):**
- List of channels the authenticated user is subscribed to
- Per-channel: channel ID, title, description, thumbnail URL, subscribed-at date

**Caption/transcript data:**
- Caption track metadata: track ID, language, track kind (standard, ASR, forced)
- Transcript text content: timestamped segments with start time, duration, and text (OAuth only)

**Search results (optional, curator only):**
- Video IDs and snippet data from `search.list` (used sparingly and only when explicitly requested)

### How Data Is Stored

All YouTube data is normalised into JSON files following strict JSON Schema definitions and stored in the repository's `resources/` directory:

| Resource Path | Schema | Content |
|---|---|---|
| `resources/channels/{id}.json` | `schemas/channel.json` | One file per subscribed channel |
| `resources/videos/{id}.json` | `schemas/video.json` | One file per tracked video |
| `resources/playlists/{id}.json` | `schemas/playlist.json` | One file per tracked playlist |
| `resources/subscriptions.json` | `schemas/subscriptions.json` | Master index of user's subscriptions |
| `resources/transcripts/{videoId}.json` | `schemas/transcript.json` | Timestamped transcript per video |
| `resources/guide/{date}.json` | `schemas/guide-entry.json` | Daily TV guide entries |
| `resources/receipts/receipt-{date}.json` | `schemas/viewing-receipt.json` | Viewing activity summaries |
| `resources/curator-state.json` | `schemas/curator-state.json` | Curator learning state |
| `resources/guide-config.json` | `schemas/guide-config.json` | Editorial block configuration |
| `resources/wall-layouts.json` | `schemas/wall-layout.json` | Channel wall grid layouts |

Every schema is a JSON Schema (draft-07) file that defines required fields, types, and constraints. A validation script (`bun run check`) verifies all resources conform to their schemas.

### Data Retention and Portability

- All data is version-controlled in Git. The user can inspect the full history of every data change.
- Data is stored as plain JSON — no proprietary formats, no encryption at rest, no external databases.
- The user owns their data completely and can export, modify, or delete it at any time.
- Deleting the repository removes all stored YouTube data.

---

## 5. How YouTube Data Is Displayed

Station displays YouTube data through a static website served by GitHub Pages. The site loads JSON resource files and renders them client-side using vanilla JavaScript (no frameworks).

### TV Guide Screen (`guide.html`)

Displays a time-based schedule of videos organised into editorial blocks:

- **What is shown:** Video title, channel name, scheduled time, duration, and live/upcoming status indicators.
- **How videos are accessed:** Each video title links to the YouTube watch page (`https://www.youtube.com/watch?v={videoId}`). Station does not embed or host video content.
- **Thumbnail usage:** Video thumbnails from YouTube are displayed as visual identifiers alongside guide entries.
- **Navigation:** Users can browse guides by date (previous/next day navigation).

### Channel Wall Screen (`wall.html`)

Displays a configurable grid of subscribed channels:

- **What is shown:** Channel thumbnail, channel name, and the most recent upload per channel.
- **Video access:** Clicking a video card opens the YouTube watch page. An optional embed toggle can display the YouTube embedded player using YouTube's standard iframe embed.
- **Layout:** Configurable NxM grid (1–10 rows and columns). Users can switch between saved layouts.

### Search Screen (`search.html`)

Provides keyword search across all ingested content:

- **What is searchable:** Video titles (weighted highest), channel names, tags, descriptions, and transcript text.
- **Results display:** Video title, channel name, view count, and matching context.
- **Transcript deep-linking:** When a search matches transcript text, the result shows the matching segment with its timestamp. Clicking the timestamp links to the YouTube video at that specific time (`https://www.youtube.com/watch?v={videoId}&t={seconds}`).
- **Search index:** Built at build time as a static inverted index from ingested resources. No YouTube API calls are made during search.

### Viewing Receipts Screen (`receipt.html`)

Displays daily and weekly viewing summaries:

- **What is shown:** Lists of videos that were scheduled (arrived), watched, and skipped. Channel distribution statistics. Curator notes.
- **No YouTube API calls:** Receipts are generated from local guide and video resource data.

### Curator Chat Screen (`curator.html`)

Provides a conversational interface to the AI curator:

- **What is shown:** Curator responses including video recommendations (title, channel, duration), channel summaries, and search results.
- **YouTube data usage:** The curator reads from local resource files. Optional API search (`search.list`) is used only when explicitly requested and when quota budget permits.

### About Screen (`about.html`)

Static page describing how Station works. No YouTube data is displayed.

### Embedding and Playback

- Station does **not** host, cache, or re-serve any YouTube video content.
- Video playback always occurs on YouTube (via direct links to `youtube.com/watch?v=...`).
- The optional embed feature on the Channel Wall uses YouTube's standard iframe embed (`https://www.youtube.com/embed/{videoId}`), which is YouTube's officially supported embedding mechanism.
- Thumbnails are loaded directly from YouTube's CDN (`i.ytimg.com`) — they are not downloaded, cached, or re-hosted.

---

## 6. Data Processing Pipeline

### Ingestion Workflow

Data flows from YouTube to Station through automated GitHub Actions workflows:

```
YouTube Data API v3
        │
        ▼
GitHub Actions (scheduled-ingest.yml)
  ├─ bun run ingest         → resources/channels/, resources/videos/, resources/subscriptions.json
  ├─ bun run generate-guide → resources/guide/{date}.json
  ├─ bun run generate-receipt → resources/receipts/receipt-{date}.json
  └─ bun run curator (learnFromReceipts) → resources/curator-state.json
        │
        ▼
Git commit to repository
        │
        ▼
GitHub Pages deployment (publish.yml)
  └─ bun run build → dist/ (static site)
        │
        ▼
Static site served to user
```

### Scheduling

- **Daily ingestion:** Runs at 06:00 UTC via cron (`scheduled-ingest.yml`).
- **Manual ingestion:** Available via `workflow_dispatch` for on-demand runs (`ingest.yml`).
- **Validation:** Runs on every push to main (`validate.yml`). Read-only, no API calls.
- **Publishing:** Deploys the static site on every push to main (`publish.yml`). No API calls.

### Quota Management

Station treats the YouTube API daily quota (10,000 units) as a finite editorial budget:

- **Prioritisation:** Subscription and channel intelligence (1 unit each) are prioritised over expensive operations.
- **Budget reservation:** 2,000+ units are reserved for interactive user requests (curator search).
- **Expensive operations controlled:** `search.list` (100 units), `captions.list` (50 units), and `captions.download` (200 units) are used selectively and only when explicitly enabled.
- **Quota tracking:** Every API call is tracked with its quota cost. The total is logged at the end of each ingestion run and recorded in the Git commit message.
- **Graceful degradation:** When quota is constrained, the system degrades gracefully — skipping expensive operations rather than failing entirely.

### Error Handling

- **Per-channel resilience:** If one channel fails during subscription ingestion, the error is logged and the remaining channels continue processing.
- **Per-video resilience:** Caption and transcript errors for individual videos do not crash the batch.
- **Troubleshooting guidance:** The main error handler provides specific troubleshooting steps for common YouTube API and network errors.
- **Continue-on-error:** Downstream workflow steps (guide generation, receipt generation, curator learning) use `continue-on-error: true` so that a failure in one step does not block others.

---

## 7. Compliance with YouTube API Services Terms of Service

### Terms of Service Acknowledgement

Station is designed and operated in compliance with the [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service) and the [Developer Policies](https://developers.google.com/youtube/terms/developer-policies).

### Key Compliance Points

**Read-only access:**
Station only reads data from YouTube. It never writes, modifies, or deletes any YouTube data. The only OAuth scope requested is `youtube.readonly`.

**No data sale or commercial exploitation:**
Station is a personal tool for the repository owner's own use. YouTube data is not sold, licensed, or shared with third parties.

**Attribution:**
All video content links point to YouTube. Thumbnails are loaded from YouTube's CDN. Station does not re-host or claim ownership of any YouTube content.

**No circumvention of YouTube features:**
Station does not block ads, bypass age restrictions, circumvent geographic restrictions, or interfere with any YouTube platform features. All video playback occurs on YouTube itself.

**User consent and transparency:**
The single user of Station is also the developer and operator. There is no distinction between the data controller and data subject. All data storage is transparent (plain JSON in a Git repository) and fully under the user's control.

**Minimal data collection:**
Station collects only the data necessary for its stated purpose (presenting subscriptions as a TV guide). It does not collect user analytics, behavioural telemetry, or data from other YouTube users.

**Data deletion:**
All YouTube data can be deleted by removing the corresponding JSON files from the repository or by deleting the repository entirely. No data is stored outside the repository.

**API key security:**
All credentials are stored in GitHub's encrypted secrets system. They are never hardcoded, logged, or exposed in repository contents.

**Quota respect:**
Station is designed around quota discipline, tracking usage and degrading gracefully rather than consuming quota aggressively.

### Google Privacy Policy Link

In accordance with YouTube API Services Terms of Service, users of Station should refer to the [Google Privacy Policy](https://policies.google.com/privacy).

---

## 8. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      User's Browser                         │
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ TV Guide │ │  Channel │ │  Search  │ │ Receipts │ ...   │
│  │          │ │   Wall   │ │          │ │          │      │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘      │
│       │             │            │             │             │
│       └─────────────┴────────────┴─────────────┘             │
│                         │                                    │
│              Reads JSON from GitHub Pages                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Pages (Static)                      │
│                                                             │
│   dist/                                                      │
│   ├── index.html, guide.html, wall.html, ...                │
│   ├── station.js                                             │
│   └── resources/ (JSON data)                                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
                    Built from repo                            
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                  GitHub Repository                            │
│                                                             │
│   resources/                   schemas/                      │
│   ├── channels/                ├── channel.json              │
│   ├── videos/                  ├── video.json                │
│   ├── playlists/               ├── playlist.json             │
│   ├── transcripts/             ├── transcript.json           │
│   ├── guide/                   ├── guide-entry.json          │
│   ├── receipts/                ├── viewing-receipt.json       │
│   ├── subscriptions.json       ├── subscriptions.json        │
│   ├── curator-state.json       └── ...                       │
│   └── ...                                                    │
└─────────────────────────┬───────────────────────────────────┘
                          │
              Written by GitHub Actions
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                  GitHub Actions Workflows                     │
│                                                             │
│   scheduled-ingest.yml (daily 06:00 UTC)                     │
│   ├── bun run ingest          ─── YouTube Data API v3 ──┐   │
│   ├── bun run generate-guide  (offline)                  │   │
│   ├── bun run generate-receipt (offline)                 │   │
│   └── bun run curator         (offline)                  │   │
│                                                          │   │
│   ingest.yml (manual dispatch)                           │   │
│   └── bun run ingest          ─── YouTube Data API v3 ──┤   │
│                                                          │   │
│   validate.yml (push to main)                            │   │
│   └── bun run check           (no API calls)             │   │
│                                                          │   │
│   publish.yml (push to main)                             │   │
│   └── bun run build           (no API calls)             │   │
└──────────────────────────────────────────────────────────┘   │
                                                               │
                          ┌────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  YouTube Data API v3                          │
│                                                             │
│   Endpoints used:                                            │
│   • channels.list      (API key, 1 unit)                     │
│   • videos.list        (API key, 1 unit)                     │
│   • playlistItems.list (API key, 1 unit)                     │
│   • playlists.list     (API key, 1 unit)                     │
│   • subscriptions.list (OAuth, 1 unit)                       │
│   • captions.list      (API key/OAuth, 50 units)             │
│   • captions/{id}      (OAuth, 200 units)                    │
│   • search.list        (API key, 100 units)                  │
│                                                             │
│   OAuth scope: youtube.readonly                              │
│   Base URL: https://www.googleapis.com/youtube/v3            │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Screencast-Equivalent Walkthrough

Since Station is a publicly accessible open-source project, this section provides a detailed walkthrough of each screen and its YouTube data integration.

### 9.1 TV Guide

**URL:** `https://{user}.github.io/gmi-youtube/guide.html`

The TV Guide presents videos in a time-based schedule. Each row contains:
- **Time slot** — the scheduled viewing time (e.g., "09:00")
- **Video title** — the title as returned by `videos.list` snippet
- **Channel name** — the channel title as returned by `channels.list` snippet
- **Duration** — parsed from `contentDetails.duration` (ISO 8601 → human-readable)
- **Status indicators** — "LIVE" or "UPCOMING" badges derived from `liveStreamingDetails`

The guide is generated offline from stored video resources. No API calls are made when viewing the guide.

### 9.2 Channel Wall

**URL:** `https://{user}.github.io/gmi-youtube/wall.html`

The Channel Wall displays a grid of channels. Each cell contains:
- **Channel thumbnail** — loaded from `i.ytimg.com` (the URL stored in channel metadata)
- **Channel name** — from `channels.list` snippet
- **Latest video** — title and thumbnail of the most recent upload, discovered via `playlistItems.list`

Clicking a video opens `https://www.youtube.com/watch?v={videoId}`. The optional embed toggle loads YouTube's standard iframe embed.

### 9.3 Search

**URL:** `https://{user}.github.io/gmi-youtube/search.html`

The Search screen queries a static inverted index built at deploy time. The index contains tokens from:
- Video titles (weight 10)
- Channel names (weight 5)
- Video tags (weight 4)
- Video descriptions (weight 1)
- Transcript text (weight 1, capped at 50 terms per video)

Search results show:
- Video title, channel name, view count
- Transcript match context with timestamp (e.g., "3:42 — '...the algorithm then processes...'")
- Clicking a transcript match links to `https://www.youtube.com/watch?v={videoId}&t={seconds}`

No YouTube API calls are made during search. All data comes from the pre-built index.

### 9.4 Viewing Receipts

**URL:** `https://{user}.github.io/gmi-youtube/receipt.html`

Receipts summarise viewing activity for a period:
- **Watched** — videos the user engaged with
- **Arrived** — new videos that appeared in the guide
- **Skipped** — videos that were scheduled but not viewed
- **Stats** — total duration, channel distribution, format breakdown
- **Curator notes** — AI-generated observations about viewing patterns

All receipt data is generated from local resources. No API calls are made.

### 9.5 Curator Chat

**URL:** `https://{user}.github.io/gmi-youtube/curator.html`

The Curator provides 9 actions:

1. **buildGuide** — generates a daily TV guide from video resources
2. **updateWallLayout** — configures the channel wall grid
3. **recommendContent** — suggests videos based on learned preferences
4. **summarizeChannel** — produces a narrative summary of a channel
5. **generateReceipt** — creates viewing receipts
6. **flagContent** — adds editorial tags (must-watch, skip, save-for-later)
7. **answerQuestion** — answers questions from local data
8. **searchContent** — searches videos locally and optionally via `search.list`
9. **learnFromReceipts** — updates curator state from viewing receipts

The only action that may call the YouTube API is `searchContent` (with explicit `includeApi` parameter), which uses `search.list` at 100 units per call and only when the API key is available and quota budget allows.

---

## 10. Summary

Station is a personal, single-user, read-only YouTube API client that:

1. **Accesses** the YouTube Data API v3 using an API key for public data and OAuth (`youtube.readonly`) for the authenticated user's subscription list and transcripts.
2. **Retrieves** channel metadata, video details, playlist contents, subscription lists, caption tracks, and transcripts.
3. **Stores** all data as schema-validated JSON files in a version-controlled GitHub repository.
4. **Displays** the data as a static website with a TV guide, channel wall, search, viewing receipts, and curator chat — always linking back to YouTube for playback.
5. **Respects** YouTube API quotas through disciplined budgeting, graceful degradation, and transparent tracking.
6. **Complies** with YouTube API Services Terms of Service by operating read-only, not re-hosting content, attributing all content to YouTube, and keeping all credentials secure.

The complete source code is publicly available at [github.com/japer-technology/gmi-youtube](https://github.com/japer-technology/gmi-youtube).
