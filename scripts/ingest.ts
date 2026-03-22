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
 *
 * Caption and transcript support:
 *   - Set INGEST_CAPTIONS=true to fetch caption track metadata (50 units per call)
 *   - Set INGEST_TRANSCRIPTS=true to download transcripts for captioned videos (200 units per call, requires OAuth)
 */

import { writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESOURCES_DIR = join(ROOT, "resources");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;
const INGEST_SCOPE = process.env.INGEST_SCOPE || "subscriptions";
const INGEST_CAPTIONS = process.env.INGEST_CAPTIONS === "true";
const INGEST_TRANSCRIPTS = process.env.INGEST_TRANSCRIPTS === "true";

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
    throw new Error(`YouTube API error on ${endpoint} (${res.status}): ${body}`);
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
    throw new Error(`YouTube API error on ${endpoint} (${res.status}): ${body}`);
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
  liveStreamingDetails?: {
    scheduledStartTime?: string;
    actualStartTime?: string;
    actualEndTime?: string;
    concurrentViewers?: string;
    activeLiveChatId?: string;
  };
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
    const lsd = item.liveStreamingDetails;
    // Determine live state from streaming details
    if (lsd.actualEndTime) {
      // Stream has ended — it was live but is now a VOD
      video.liveBroadcastContent = "none";
      video.liveStartedAt = lsd.actualStartTime;
      video.liveEndedAt = lsd.actualEndTime;
    } else if (lsd.actualStartTime) {
      // Stream has started but not ended — currently live
      video.liveBroadcastContent = "live";
      video.liveStartedAt = lsd.actualStartTime;
    } else if (lsd.scheduledStartTime) {
      // Has a scheduled start but hasn't started — upcoming premiere or live stream
      video.liveBroadcastContent = "upcoming";
      video.premiereAt = lsd.scheduledStartTime;
    } else {
      video.liveBroadcastContent = "live";
    }
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
    try {
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠ Error fetching channel batch: ${msg}`);
    }
  }
}

async function ingestSubscriptionUploads(index: SubscriptionsIndex): Promise<void> {
  console.log(`\nFetching recent uploads for ${index.channels.length} subscribed channels...`);

  let successCount = 0;
  let errorCount = 0;

  for (const sub of index.channels) {
    try {
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
      successCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠ Error fetching uploads for ${sub.title} (${sub.channelId}): ${msg}`);
      errorCount++;
    }
  }

  console.log(`\nSubscription uploads: ${successCount} succeeded, ${errorCount} failed out of ${index.channels.length} channels`);
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

// --- Caption and transcript ingestion ---

interface YouTubeCaptionItem {
  id: string;
  snippet: {
    videoId: string;
    language: string;
    name: string;
    trackKind: string;
    lastUpdated?: string;
  };
}

interface CaptionTrack {
  id: string;
  language: string;
  name: string;
  trackKind: string;
}

interface TranscriptSegment {
  start: number;
  duration?: number;
  text: string;
}

async function fetchCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  console.log(`  Fetching caption tracks for: ${videoId}`);
  // captions.list prefers OAuth; fall back to API key for public videos
  const fetcher = hasOAuthCredentials() ? youtubeGetAuth : youtubeGet;
  const data = (await fetcher("captions", {
    part: "snippet",
    videoId,
  }, 50)) as { items?: YouTubeCaptionItem[] };

  if (!data.items || data.items.length === 0) {
    return [];
  }

  return data.items.map((item) => ({
    id: item.id,
    language: item.snippet.language,
    name: item.snippet.name || "",
    trackKind: item.snippet.trackKind,
  }));
}

function selectBestCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null;
  // Prefer standard tracks over ASR, prefer English
  const standard = tracks.filter((t) => t.trackKind === "standard");
  const pool = standard.length > 0 ? standard : tracks;
  const english = pool.find((t) => t.language.startsWith("en"));
  return english || pool[0];
}

function parseTimedText(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  // Parse <text start="..." dur="...">content</text> elements
  const textRegex = /<text\s+start="([^"]*)"(?:\s+dur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = textRegex.exec(xml)) !== null) {
    const start = parseFloat(match[1]);
    const dur = match[2] ? parseFloat(match[2]) : undefined;
    // Decode HTML entities (decode &amp; last to avoid double-unescaping)
    let text = match[3]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\n/g, " ")
      .trim();
    if (text) {
      const seg: TranscriptSegment = { start, text };
      if (dur !== undefined) seg.duration = dur;
      segments.push(seg);
    }
  }
  return segments;
}

async function downloadTranscript(
  videoId: string,
  track: CaptionTrack
): Promise<{ segments: TranscriptSegment[]; fullText: string } | null> {
  console.log(`  Downloading transcript for ${videoId} (${track.language})...`);

  try {
    const accessToken = await getAccessToken();
    const url = `${YOUTUBE_API_BASE}/captions/${encodeURIComponent(track.id)}`;

    trackQuota("captions.download", 200);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const body = await res.text();
      console.log(`  ✗ Transcript download failed (${res.status}): ${body}`);
      return null;
    }

    const text = await res.text();
    const segments = parseTimedText(text);
    const fullText = segments.map((s) => s.text).join(" ");
    return { segments, fullText };
  } catch (err) {
    console.log(`  ✗ Transcript download error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function ingestCaptionsForVideos(): Promise<void> {
  console.log("\n--- Caption Ingestion ---\n");

  if (!hasOAuthCredentials()) {
    console.log("Note: Running without OAuth — caption track fetching uses API key (may be");
    console.log("limited for some videos). Transcript downloads require OAuth and will be skipped.\n");
  } else if (INGEST_TRANSCRIPTS) {
    console.log("OAuth credentials present — transcripts will be downloaded where available.\n");
  }

  const videosDir = join(RESOURCES_DIR, "videos");
  let videoFiles: string[];
  try {
    const entries = await readdir(videosDir);
    videoFiles = entries.filter((f) => f.endsWith(".json"));
  } catch {
    console.log("No video resources found.");
    return;
  }

  let captionCount = 0;
  let transcriptCount = 0;
  let skippedCount = 0;

  for (const file of videoFiles) {
    const videoPath = join(videosDir, file);
    const text = await readFile(videoPath, "utf-8");
    const video = JSON.parse(text) as Record<string, unknown>;
    const videoId = video.id as string;

    // Fetch caption tracks (per-video error handling so one failure doesn't stop the batch)
    let tracks: CaptionTrack[] = [];
    try {
      tracks = await fetchCaptionTracks(videoId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠ Caption tracks unavailable for ${videoId}: ${msg}`);
      skippedCount++;
      continue;
    }

    if (tracks.length > 0) {
      video.captionsAvailable = true;
      video.captionTracks = tracks.map((t) => ({
        id: t.id,
        language: t.language,
        name: t.name,
        trackKind: t.trackKind,
      }));
      captionCount++;
    } else {
      video.captionsAvailable = false;
    }
    video.updatedAt = nowISO();

    // Write updated video resource
    await writeFile(videoPath, JSON.stringify(video, null, 2) + "\n");
    console.log(`  ✓ ${videoId}: ${tracks.length} caption track${tracks.length === 1 ? "" : "s"}`);

    // Optionally download transcript
    if (INGEST_TRANSCRIPTS && tracks.length > 0 && hasOAuthCredentials()) {
      const bestTrack = selectBestCaptionTrack(tracks);
      if (bestTrack) {
        const result = await downloadTranscript(videoId, bestTrack);
        if (result) {
          const transcript = {
            videoId,
            language: bestTrack.language,
            trackKind: bestTrack.trackKind,
            segments: result.segments,
            fullText: result.fullText,
            source: "youtube",
            updatedAt: nowISO(),
          };
          await writeResource("transcripts", `${videoId}.json`, transcript);
          video.transcriptAvailable = true;
          await writeFile(videoPath, JSON.stringify(video, null, 2) + "\n");
          console.log(`  ✓ Transcript saved: ${videoId} (${bestTrack.language}, ${result.segments.length} segments)`);
          transcriptCount++;
        }
      }
    }
  }

  console.log(`\nCaption summary: ${captionCount} video${captionCount === 1 ? "" : "s"} with captions, ${transcriptCount} transcript${transcriptCount === 1 ? "" : "s"} downloaded`);
  if (skippedCount > 0) {
    console.log(`  ${skippedCount} video${skippedCount === 1 ? "" : "s"} skipped due to caption fetch errors`);
  }
  if (INGEST_TRANSCRIPTS && !hasOAuthCredentials() && captionCount > 0) {
    console.log(`  Transcripts skipped: OAuth credentials required for transcript downloads`);
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
  console.log(`Scope:   ${INGEST_SCOPE}`);

  if (!hasOAuthCredentials()) {
    console.log(`\nAPI-key-only mode — available capabilities:`);
    console.log(`  ✓ Channel metadata and recent uploads`);
    console.log(`  ✓ Playlist metadata and video items`);
    console.log(`  ✓ Video details, statistics, and live status`);
    console.log(`  ✓ Subscription uploads (when index exists)`);
    if (INGEST_CAPTIONS) {
      console.log(`  ~ Caption track listing (may require OAuth for some videos)`);
    }
    if (INGEST_TRANSCRIPTS) {
      console.log(`  ✗ Transcript downloads (requires OAuth)`);
    }
    if (INGEST_SCOPE === "subscriptions") {
      console.log(`  ✗ Subscription list sync (requires OAuth, using existing index)`);
    }
  }

  console.log("");

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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ Ingestion failed: ${msg}`);
    if (msg.includes("YouTube API error")) {
      console.error("");
      console.error("Troubleshooting:");
      console.error("  1. Verify YouTube Data API v3 is enabled in your Google Cloud project");
      console.error("  2. Check that YOUTUBE_API_KEY has no IP/referrer restrictions blocking GitHub Actions");
      console.error("  3. Confirm the API key belongs to a project with YouTube Data API v3 access");
    } else if (msg.includes("connect") || msg.includes("fetch") || msg.includes("network")) {
      console.error("");
      console.error("Troubleshooting:");
      console.error("  1. Check network connectivity to googleapis.com");
      console.error("  2. Ensure the runner has outbound internet access");
    }
    process.exit(1);
  }

  // Caption and transcript ingestion (runs after main ingestion if enabled)
  if (INGEST_CAPTIONS) {
    try {
      await ingestCaptionsForVideos();
    } catch (err) {
      console.error(`\n✗ Caption ingestion failed: ${err instanceof Error ? err.message : err}`);
    }
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
