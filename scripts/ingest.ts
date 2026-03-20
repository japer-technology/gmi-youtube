/**
 * ingest.ts — Ingest data from YouTube into repository resources
 *
 * Supports narrow ingestion scopes:
 *   - channel:<id>   Fetch channel metadata and recent uploads
 *   - playlist:<id>  Fetch playlist metadata and its video items
 *   - subscriptions  Fetch user subscriptions (OAuth) or ingest uploads from subscription index (API key fallback)
 *
 * Requires YOUTUBE_API_KEY environment variable.
 * OAuth credentials (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN)
 * are required for subscription list fetching but optional — the system falls back
 * to API-key-only mode using an existing subscription index when OAuth is unavailable.
 *
 * Reads INGEST_SCOPE environment variable (default: "subscriptions").
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESOURCES_DIR = join(ROOT, "resources");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;
const INGEST_SCOPE = process.env.INGEST_SCOPE || "subscriptions";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

interface QuotaTracker {
  total: number;
  operations: { name: string; cost: number }[];
}

const quota: QuotaTracker = { total: 0, operations: [] };

function trackQuota(name: string, cost: number): void {
  quota.total += cost;
  quota.operations.push({ name, cost });
}

// --- OAuth token management ---

let cachedAccessToken: string | null = null;

function hasOAuthCredentials(): boolean {
  return !!(YOUTUBE_CLIENT_ID && YOUTUBE_CLIENT_SECRET && YOUTUBE_REFRESH_TOKEN);
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken) return cachedAccessToken;

  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    throw new Error(
      "OAuth credentials not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN."
    );
  }

  const body = new URLSearchParams({
    client_id: YOUTUBE_CLIENT_ID,
    client_secret: YOUTUBE_CLIENT_SECRET,
    refresh_token: YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string };
  cachedAccessToken = data.access_token;
  return cachedAccessToken;
}

// --- YouTube API helpers ---

async function youtubeGet(
  endpoint: string,
  params: Record<string, string>,
  quotaCost: number
): Promise<unknown> {
  const url = new URL(`${YOUTUBE_API_BASE}/${endpoint}`);
  url.searchParams.set("key", YOUTUBE_API_KEY!);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  trackQuota(`${endpoint}`, quotaCost);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error (${res.status}): ${body}`);
  }
  return res.json();
}

async function youtubeGetAuth(
  endpoint: string,
  params: Record<string, string>,
  quotaCost: number
): Promise<unknown> {
  const accessToken = await getAccessToken();
  const url = new URL(`${YOUTUBE_API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  trackQuota(`${endpoint}`, quotaCost);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube API error (${res.status}): ${body}`);
  }
  return res.json();
}

function nowISO(): string {
  return new Date().toISOString();
}

// --- Channel ingestion ---

interface YouTubeChannelItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    customUrl?: string;
    thumbnails?: { default?: { url: string } };
  };
  statistics?: {
    subscriberCount?: string;
    videoCount?: string;
  };
  contentDetails?: {
    relatedPlaylists?: { uploads?: string };
  };
}

interface YouTubeVideoItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    channelId: string;
    publishedAt: string;
    thumbnails?: { maxresdefault?: { url: string }; high?: { url: string }; default?: { url: string } };
  };
  contentDetails?: {
    duration?: string;
    caption?: string;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
  };
  liveStreamingDetails?: Record<string, unknown>;
  status?: {
    uploadStatus?: string;
  };
}

interface YouTubeSubscriptionItem {
  snippet: {
    title: string;
    description: string;
    resourceId: {
      channelId: string;
    };
    thumbnails?: { default?: { url: string }; high?: { url: string } };
    publishedAt?: string;
  };
}

interface SubscriptionEntry {
  channelId: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  subscribedAt?: string;
}

interface SubscriptionsIndex {
  channels: SubscriptionEntry[];
  totalCount: number;
  updatedAt: string;
}

interface YouTubePlaylistItemEntry {
  snippet: {
    resourceId: { videoId: string };
  };
}

interface YouTubePlaylistItem {
  id: string;
  snippet: {
    title: string;
    description: string;
    channelId: string;
    thumbnails?: { maxresdefault?: { url: string }; high?: { url: string }; default?: { url: string } };
  };
  contentDetails?: {
    itemCount?: number;
  };
}

function bestThumbnail(
  thumbnails?: { maxresdefault?: { url: string }; high?: { url: string }; default?: { url: string } }
): string | undefined {
  if (!thumbnails) return undefined;
  return thumbnails.maxresdefault?.url || thumbnails.high?.url || thumbnails.default?.url;
}

function normalizeChannel(item: YouTubeChannelItem): Record<string, unknown> {
  const channel: Record<string, unknown> = {
    id: item.id,
    title: item.snippet.title,
    description: item.snippet.description || undefined,
    customUrl: item.snippet.customUrl || undefined,
    thumbnailUrl: item.snippet.thumbnails?.default?.url || undefined,
    source: "youtube",
    updatedAt: nowISO(),
  };
  if (item.statistics?.subscriberCount) {
    channel.subscriberCount = parseInt(item.statistics.subscriberCount, 10);
  }
  if (item.statistics?.videoCount) {
    channel.videoCount = parseInt(item.statistics.videoCount, 10);
  }
  // Remove undefined values for clean JSON
  return Object.fromEntries(
    Object.entries(channel).filter(([, v]) => v !== undefined)
  );
}

function normalizeVideo(item: YouTubeVideoItem): Record<string, unknown> {
  const video: Record<string, unknown> = {
    id: item.id,
    channelId: item.snippet.channelId,
    title: item.snippet.title,
    description: item.snippet.description || undefined,
    publishedAt: item.snippet.publishedAt,
    thumbnailUrl: bestThumbnail(item.snippet.thumbnails) || undefined,
    duration: item.contentDetails?.duration || undefined,
    source: "youtube",
    updatedAt: nowISO(),
  };
  if (item.statistics?.viewCount) {
    video.viewCount = parseInt(item.statistics.viewCount, 10);
  }
  if (item.statistics?.likeCount) {
    video.likeCount = parseInt(item.statistics.likeCount, 10);
  }
  if (item.liveStreamingDetails) {
    video.liveBroadcastContent = "live";
  } else {
    video.liveBroadcastContent = "none";
  }
  if (item.contentDetails?.caption !== undefined) {
    video.captionsAvailable = item.contentDetails.caption === "true";
  }
  return Object.fromEntries(
    Object.entries(video).filter(([, v]) => v !== undefined)
  );
}

async function writeResource(
  subdir: string,
  filename: string,
  data: unknown
): Promise<string> {
  const dir = join(RESOURCES_DIR, subdir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
  return `resources/${subdir}/${filename}`;
}

async function ingestChannel(channelId: string): Promise<void> {
  console.log(`Fetching channel: ${channelId}`);

  // Fetch channel metadata (1 unit)
  const channelData = (await youtubeGet("channels", {
    part: "snippet,statistics,contentDetails",
    id: channelId,
  }, 1)) as { items?: YouTubeChannelItem[] };

  if (!channelData.items || channelData.items.length === 0) {
    console.log(`  ✗ Channel not found: ${channelId}`);
    return;
  }

  const channelItem = channelData.items[0];
  const channel = normalizeChannel(channelItem);
  const channelPath = await writeResource(
    "channels",
    `${channelId}.json`,
    channel
  );
  console.log(`  ✓ ${channelPath}`);

  // Fetch recent uploads via the uploads playlist
  const uploadsPlaylistId =
    channelItem.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    console.log("  No uploads playlist found.");
    return;
  }

  console.log(`Fetching recent uploads from playlist: ${uploadsPlaylistId}`);

  // Fetch playlist items to get video IDs (1 unit)
  const playlistItemsData = (await youtubeGet("playlistItems", {
    part: "snippet",
    playlistId: uploadsPlaylistId,
    maxResults: "10",
  }, 1)) as { items?: YouTubePlaylistItemEntry[] };

  if (!playlistItemsData.items || playlistItemsData.items.length === 0) {
    console.log("  No recent uploads found.");
    return;
  }

  const videoIds = playlistItemsData.items.map(
    (item) => item.snippet.resourceId.videoId
  );

  // Fetch video details in batch (1 unit)
  const videosData = (await youtubeGet("videos", {
    part: "snippet,contentDetails,statistics,liveStreamingDetails",
    id: videoIds.join(","),
  }, 1)) as { items?: YouTubeVideoItem[] };

  if (!videosData.items) {
    console.log("  No video details returned.");
    return;
  }

  for (const videoItem of videosData.items) {
    const video = normalizeVideo(videoItem);
    const videoPath = await writeResource(
      "videos",
      `${videoItem.id}.json`,
      video
    );
    console.log(`  ✓ ${videoPath}`);
  }
}

// --- Playlist ingestion ---

async function ingestPlaylist(playlistId: string): Promise<void> {
  console.log(`Fetching playlist: ${playlistId}`);

  // Fetch playlist metadata (1 unit)
  const playlistData = (await youtubeGet("playlists", {
    part: "snippet,contentDetails",
    id: playlistId,
  }, 1)) as { items?: YouTubePlaylistItem[] };

  if (!playlistData.items || playlistData.items.length === 0) {
    console.log(`  ✗ Playlist not found: ${playlistId}`);
    return;
  }

  const playlistItem = playlistData.items[0];

  // Fetch all playlist items, paginating through results (1 unit per page)
  const videoIds: string[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const params: Record<string, string> = {
      part: "snippet",
      playlistId,
      maxResults: "50",
    };
    if (pageToken) params.pageToken = pageToken;

    const playlistItemsData = (await youtubeGet("playlistItems", params, 1)) as {
      items?: YouTubePlaylistItemEntry[];
      nextPageToken?: string;
    };

    const pageVideoIds = (playlistItemsData.items || []).map(
      (item) => item.snippet.resourceId.videoId
    );
    videoIds.push(...pageVideoIds);

    pageToken = playlistItemsData.nextPageToken;
  } while (pageToken);

  console.log(`  Found ${videoIds.length} videos in playlist`);

  const playlist: Record<string, unknown> = {
    id: playlistItem.id,
    channelId: playlistItem.snippet.channelId,
    title: playlistItem.snippet.title,
    description: playlistItem.snippet.description || undefined,
    thumbnailUrl: bestThumbnail(playlistItem.snippet.thumbnails) || undefined,
    itemCount: playlistItem.contentDetails?.itemCount ?? videoIds.length,
    videoIds: videoIds,
    source: "youtube",
    updatedAt: nowISO(),
  };
  const cleanPlaylist = Object.fromEntries(
    Object.entries(playlist).filter(([, v]) => v !== undefined)
  );

  const playlistPath = await writeResource(
    "playlists",
    `${playlistId}.json`,
    cleanPlaylist
  );
  console.log(`  ✓ ${playlistPath}`);

  // Fetch video details if we have video IDs
  if (videoIds.length > 0) {
    // Batch video IDs in groups of 50 (API limit)
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const videosData = (await youtubeGet("videos", {
        part: "snippet,contentDetails,statistics,liveStreamingDetails",
        id: batch.join(","),
      }, 1)) as { items?: YouTubeVideoItem[] };

      if (videosData.items) {
        for (const videoItem of videosData.items) {
          const video = normalizeVideo(videoItem);
          const videoPath = await writeResource(
            "videos",
            `${videoItem.id}.json`,
            video
          );
          console.log(`  ✓ ${videoPath}`);
        }
      }
    }
  }
}

// --- Subscription ingestion ---

async function loadSubscriptionsIndex(): Promise<SubscriptionsIndex | null> {
  try {
    const text = await readFile(join(RESOURCES_DIR, "subscriptions.json"), "utf-8");
    return JSON.parse(text) as SubscriptionsIndex;
  } catch {
    return null;
  }
}

async function fetchSubscriptionList(): Promise<SubscriptionEntry[]> {
  console.log("Fetching subscriptions (OAuth)...");
  const entries: SubscriptionEntry[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const params: Record<string, string> = {
      part: "snippet",
      mine: "true",
      maxResults: "50",
    };
    if (pageToken) params.pageToken = pageToken;

    const data = (await youtubeGetAuth("subscriptions", params, 1)) as {
      items?: YouTubeSubscriptionItem[];
      nextPageToken?: string;
      pageInfo?: { totalResults?: number };
    };

    if (data.items) {
      for (const item of data.items) {
        const entry: SubscriptionEntry = {
          channelId: item.snippet.resourceId.channelId,
          title: item.snippet.title,
        };
        if (item.snippet.description) entry.description = item.snippet.description;
        if (item.snippet.thumbnails?.default?.url) {
          entry.thumbnailUrl = item.snippet.thumbnails.default.url;
        }
        if (item.snippet.publishedAt) entry.subscribedAt = item.snippet.publishedAt;
        entries.push(entry);
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  console.log(`  Found ${entries.length} subscriptions`);
  return entries;
}

async function writeSubscriptionsIndex(entries: SubscriptionEntry[]): Promise<void> {
  const index: SubscriptionsIndex = {
    channels: entries,
    totalCount: entries.length,
    updatedAt: nowISO(),
  };
  const path = join(RESOURCES_DIR, "subscriptions.json");
  await writeFile(path, JSON.stringify(index, null, 2) + "\n");
  console.log(`  ✓ resources/subscriptions.json (${entries.length} channels)`);
}

async function ingestSubscriptionChannels(entries: SubscriptionEntry[]): Promise<void> {
  // Batch channel IDs in groups of 50 to fetch full metadata
  const channelIds = entries.map((e) => e.channelId);
  console.log(`\nFetching channel details for ${channelIds.length} subscribed channels...`);

  for (let i = 0; i < channelIds.length; i += 50) {
    const batch = channelIds.slice(i, i + 50);
    const channelData = (await youtubeGet("channels", {
      part: "snippet,statistics,contentDetails",
      id: batch.join(","),
    }, 1)) as { items?: YouTubeChannelItem[] };

    if (channelData.items) {
      for (const channelItem of channelData.items) {
        const channel = normalizeChannel(channelItem);
        const channelPath = await writeResource(
          "channels",
          `${channelItem.id}.json`,
          channel
        );
        console.log(`  ✓ ${channelPath}`);
      }
    }
  }
}

async function ingestSubscriptionUploads(index: SubscriptionsIndex): Promise<void> {
  console.log(`\nFetching recent uploads for ${index.channels.length} subscribed channels...`);

  for (const sub of index.channels) {
    // Fetch channel metadata to get uploads playlist ID (1 unit per batch of up to 50)
    const channelData = (await youtubeGet("channels", {
      part: "contentDetails",
      id: sub.channelId,
    }, 1)) as { items?: YouTubeChannelItem[] };

    if (!channelData.items || channelData.items.length === 0) {
      console.log(`  ✗ Channel not found: ${sub.channelId} (${sub.title})`);
      continue;
    }

    const uploadsPlaylistId =
      channelData.items[0].contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      console.log(`  ✗ No uploads playlist for ${sub.title}`);
      continue;
    }

    // Fetch recent playlist items (just first page = 10 most recent, 1 unit)
    const playlistItemsData = (await youtubeGet("playlistItems", {
      part: "snippet",
      playlistId: uploadsPlaylistId,
      maxResults: "10",
    }, 1)) as { items?: YouTubePlaylistItemEntry[] };

    if (!playlistItemsData.items || playlistItemsData.items.length === 0) {
      console.log(`  – No recent uploads for ${sub.title}`);
      continue;
    }

    const videoIds = playlistItemsData.items.map(
      (item) => item.snippet.resourceId.videoId
    );

    // Fetch video details (1 unit for up to 50 videos)
    const videosData = (await youtubeGet("videos", {
      part: "snippet,contentDetails,statistics,liveStreamingDetails",
      id: videoIds.join(","),
    }, 1)) as { items?: YouTubeVideoItem[] };

    if (videosData.items) {
      for (const videoItem of videosData.items) {
        const video = normalizeVideo(videoItem);
        const videoPath = await writeResource(
          "videos",
          `${videoItem.id}.json`,
          video
        );
        console.log(`  ✓ ${videoPath}`);
      }
    }

    console.log(`  ✓ ${sub.title}: ${videosData.items?.length ?? 0} videos`);
  }
}

async function ingestSubscriptions(): Promise<void> {
  if (hasOAuthCredentials()) {
    // Full subscription sync: fetch subscription list via OAuth, then recent uploads
    console.log("OAuth credentials detected — performing full subscription sync.\n");

    const entries = await fetchSubscriptionList();
    if (entries.length === 0) {
      console.log("No subscriptions found.");
      return;
    }

    await writeSubscriptionsIndex(entries);
    await ingestSubscriptionChannels(entries);
    await ingestSubscriptionUploads({ channels: entries, totalCount: entries.length, updatedAt: nowISO() });
  } else {
    // Fallback: use existing subscription index with API key only
    console.log("No OAuth credentials — falling back to subscription index.\n");
    const index = await loadSubscriptionsIndex();

    if (!index || index.channels.length === 0) {
      console.log("No subscription index found at resources/subscriptions.json.");
      console.log("");
      console.log("To build the subscription index, set OAuth credentials:");
      console.log("  YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN");
      console.log("");
      console.log("Or to ingest specific channels/playlists with an API key:");
      console.log("  INGEST_SCOPE=channel:<id> bun run ingest");
      console.log("  INGEST_SCOPE=playlist:<id> bun run ingest");
      console.log("");
      console.log("No resources were modified.");
      return;
    }

    console.log(`Subscription index found: ${index.channels.length} channels (updated ${index.updatedAt})`);
    await ingestSubscriptionUploads(index);
  }
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Station Ingest ===\n");

  if (!YOUTUBE_API_KEY) {
    console.log("YOUTUBE_API_KEY is not set.");
    console.log("");
    console.log("To run ingestion, set the YOUTUBE_API_KEY environment variable:");
    console.log("  export YOUTUBE_API_KEY=your-api-key-here");
    console.log("");
    console.log("For workflow use, add it as a repository secret.");
    console.log("");
    console.log("Skipping ingestion (no credentials).");
    return;
  }

  const CHANNEL_PREFIX = "channel:";
  const PLAYLIST_PREFIX = "playlist:";

  console.log(`API key: present`);
  console.log(`OAuth:   ${hasOAuthCredentials() ? "present" : "not configured (API-key-only mode)"}`);
  console.log(`Scope:   ${INGEST_SCOPE}\n`);

  try {
    if (INGEST_SCOPE.startsWith(CHANNEL_PREFIX)) {
      const channelId = INGEST_SCOPE.slice(CHANNEL_PREFIX.length).trim();
      if (!channelId) {
        console.log(`✗ ${CHANNEL_PREFIX} scope requires a channel ID (e.g. channel:UCxxxxxx)`);
        process.exit(1);
      }
      await ingestChannel(channelId);
    } else if (INGEST_SCOPE.startsWith(PLAYLIST_PREFIX)) {
      const playlistId = INGEST_SCOPE.slice(PLAYLIST_PREFIX.length).trim();
      if (!playlistId) {
        console.log(`✗ ${PLAYLIST_PREFIX} scope requires a playlist ID (e.g. playlist:PLxxxxxx)`);
        process.exit(1);
      }
      await ingestPlaylist(playlistId);
    } else if (INGEST_SCOPE === "subscriptions") {
      await ingestSubscriptions();
    } else {
      console.log(`✗ Unknown scope: ${INGEST_SCOPE}`);
      console.log("");
      console.log("Supported scopes:");
      console.log("  subscriptions        fetch user subscriptions (OAuth) or uploads from index (API key)");
      console.log("  channel:<id>         fetch channel metadata and recent uploads");
      console.log("  playlist:<id>        fetch playlist metadata and video items");
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n✗ Ingestion failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Report quota usage
  console.log("\n--- Quota Usage ---");
  for (const op of quota.operations) {
    console.log(`  ${op.name}: ${op.cost} unit${op.cost === 1 ? "" : "s"}`);
  }
  console.log(`  Total: ${quota.total} unit${quota.total === 1 ? "" : "s"}`);

  // Machine-readable summary for workflow capture
  console.log(`\nINGEST_QUOTA_TOTAL=${quota.total}`);
  console.log(`INGEST_SCOPE_USED=${INGEST_SCOPE}`);
}

main();
