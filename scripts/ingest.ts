/**
 * ingest.ts — Ingest data from YouTube into repository resources
 *
 * Supports narrow ingestion scopes:
 *   - channel:<id>   Fetch channel metadata and recent uploads
 *   - playlist:<id>  Fetch playlist metadata and its video items
 *   - subscriptions  (requires OAuth — not yet available)
 *
 * Requires YOUTUBE_API_KEY environment variable.
 * Reads INGEST_SCOPE environment variable (default: "subscriptions").
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESOURCES_DIR = join(ROOT, "resources");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const INGEST_SCOPE = process.env.INGEST_SCOPE || "subscriptions";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

interface QuotaTracker {
  total: number;
  operations: { name: string; cost: number }[];
}

const quota: QuotaTracker = { total: 0, operations: [] };

function trackQuota(name: string, cost: number): void {
  quota.total += cost;
  quota.operations.push({ name, cost });
}

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

  // Fetch playlist items for video IDs (1 unit)
  const playlistItemsData = (await youtubeGet("playlistItems", {
    part: "snippet",
    playlistId,
    maxResults: "50",
  }, 1)) as { items?: YouTubePlaylistItemEntry[] };

  const videoIds = (playlistItemsData.items || []).map(
    (item) => item.snippet.resourceId.videoId
  );

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
      console.log("Subscription ingestion requires OAuth credentials.");
      console.log("OAuth support is documented in OPERATIONS.md but not yet implemented.");
      console.log("");
      console.log("To ingest specific channels or playlists, use:");
      console.log("  INGEST_SCOPE=channel:<id> bun run ingest");
      console.log("  INGEST_SCOPE=playlist:<id> bun run ingest");
      console.log("");
      console.log("No resources were modified.");
      return;
    } else {
      console.log(`✗ Unknown scope: ${INGEST_SCOPE}`);
      console.log("");
      console.log("Supported scopes:");
      console.log("  subscriptions        (requires OAuth — not yet available)");
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
}

main();
