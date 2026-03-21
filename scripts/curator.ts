/**
 * curator.ts — Intelligent Curator for the Station
 *
 * The curator is the conversational layer that transforms a structured data
 * system into a personally operated media environment. It supports 8 actions:
 *
 *   1. buildGuide     — Generate an editorial guide with curator preferences
 *   2. updateWallLayout — Update wall layout configuration
 *   3. recommendContent — Recommend videos by topic, mood, duration
 *   4. summarizeChannel — Produce a narrative channel summary
 *   5. generateReceipt  — Generate a viewing receipt with curator notes
 *   6. flagContent      — Add editorial tags to a video resource
 *   7. answerQuestion   — Answer questions from repository state
 *   8. searchContent    — Search videos across repository and optionally YouTube API
 *
 * Environment variables:
 *   CURATOR_ACTION — One of the 8 actions listed above (required)
 *   CURATOR_PARAMS — JSON-encoded parameters for the action (default: "{}")
 *   YOUTUBE_API_KEY — Required for searchContent with API fallback
 */

import { readdir, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, basename } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESOURCES_DIR = join(ROOT, "resources");
const VIDEOS_DIR = join(RESOURCES_DIR, "videos");
const CHANNELS_DIR = join(RESOURCES_DIR, "channels");
const GUIDE_DIR = join(RESOURCES_DIR, "guide");
const RECEIPTS_DIR = join(RESOURCES_DIR, "receipts");
const TRANSCRIPTS_DIR = join(RESOURCES_DIR, "transcripts");
const GUIDE_CONFIG_PATH = join(RESOURCES_DIR, "guide-config.json");
const WALL_LAYOUTS_PATH = join(RESOURCES_DIR, "wall-layouts.json");
const SUBSCRIPTIONS_PATH = join(RESOURCES_DIR, "subscriptions.json");
const CURATOR_STATE_PATH = join(RESOURCES_DIR, "curator-state.json");

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const CURATOR_QUOTA_BUDGET = 2000;

// --- Types ---

interface VideoResource {
  id: string;
  channelId: string;
  title: string;
  publishedAt: string;
  duration?: string;
  description?: string;
  liveBroadcastContent?: string;
  premiereAt?: string;
  tags?: string[];
  thumbnailUrl?: string;
  transcriptAvailable?: boolean;
}

interface ChannelResource {
  id: string;
  title: string;
  description?: string;
  subscriberCount?: number;
  videoCount?: number;
}

interface GuideEntry {
  videoId: string;
  channelId: string;
  title: string;
  channelTitle?: string;
  scheduledAt: string;
  duration?: string;
  liveBroadcastContent?: string;
  premiereAt?: string;
  block: string;
  updatedAt: string;
}

interface EditorialBlock {
  name: string;
  startHour: number;
  endHour: number;
  character?: string;
  maxDurationMinutes?: number;
  preferredTags?: string[];
}

interface GuideConfig {
  blocks: EditorialBlock[];
  bufferMinutes?: number;
  defaultDurationMinutes?: number;
  updatedAt?: string;
}

interface WallLayout {
  name: string;
  rows: number;
  cols: number;
  channels: string[];
}

interface ReceiptVideo {
  videoId: string;
  title: string;
  channelTitle?: string;
}

interface ReceiptStats {
  totalWatched: number;
  totalArrived: number;
  totalSkipped: number;
  totalDurationMinutes: number;
  channelDistribution: Record<string, number>;
}

interface ViewingReceipt {
  id: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  watched: ReceiptVideo[];
  arrived: ReceiptVideo[];
  skipped: ReceiptVideo[];
  curatorNotes: string;
  stats: ReceiptStats;
}

interface TranscriptResource {
  videoId: string;
  language: string;
  fullText?: string;
  segments: { start: number; text: string }[];
}

interface ChannelAffinity {
  featuredCount: number;
  skippedCount: number;
  score: number;
}

interface TopicPreference {
  featuredCount: number;
  score: number;
}

interface CuratorDecision {
  date: string;
  action: string;
  summary: string;
}

interface CuratorState {
  version: string;
  updatedAt: string;
  channelAffinities: Record<string, ChannelAffinity>;
  topicPreferences: Record<string, TopicPreference>;
  formatPreferences: Record<string, TopicPreference>;
  recentDecisions: CuratorDecision[];
}

interface RecommendResult {
  videoId: string;
  title: string;
  channelTitle?: string;
  score: number;
  reason: string;
  source: "repository" | "api";
}

interface SearchResult {
  videoId: string;
  title: string;
  channelTitle?: string;
  score: number;
  source: "repository" | "api";
  transcriptMatch?: { start: number; text: string };
}

// --- Quota Tracking ---

interface QuotaTracker {
  total: number;
  operations: { name: string; cost: number }[];
}

const quota: QuotaTracker = { total: 0, operations: [] };

function trackQuota(name: string, cost: number): void {
  quota.total += cost;
  quota.operations.push({ name, cost });
  console.log(`CURATOR_QUOTA_TOTAL=${quota.total}`);
}

function quotaRemaining(): number {
  return CURATOR_QUOTA_BUDGET - quota.total;
}

// --- Data Access Layer ---

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadJsonFiles<T>(dir: string): Promise<T[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: T[] = [];
    for (const entry of entries) {
      if (entry.name.endsWith(".json")) {
        const text = await readFile(join(dir, entry.name), "utf-8");
        results.push(JSON.parse(text) as T);
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function loadVideos(): Promise<VideoResource[]> {
  return loadJsonFiles<VideoResource>(VIDEOS_DIR);
}

async function loadChannels(): Promise<ChannelResource[]> {
  return loadJsonFiles<ChannelResource>(CHANNELS_DIR);
}

async function loadTranscripts(): Promise<TranscriptResource[]> {
  return loadJsonFiles<TranscriptResource>(TRANSCRIPTS_DIR);
}

async function loadReceipts(): Promise<ViewingReceipt[]> {
  return loadJsonFiles<ViewingReceipt>(RECEIPTS_DIR);
}

async function loadGuideConfig(): Promise<GuideConfig> {
  const config = await loadJson<GuideConfig>(GUIDE_CONFIG_PATH);
  if (config && config.blocks && config.blocks.length > 0) {
    return config;
  }
  return {
    blocks: [
      { name: "morning", startHour: 6, endHour: 10, character: "Short-form, news, briefings", maxDurationMinutes: 30 },
      { name: "midday", startHour: 10, endHour: 14, character: "Medium-form, tutorials, talks", maxDurationMinutes: 60 },
      { name: "afternoon", startHour: 14, endHour: 18, character: "Long-form, documentaries, deep dives", maxDurationMinutes: 180 },
      { name: "evening", startHour: 18, endHour: 22, character: "Flagship content, curated highlights", maxDurationMinutes: 120 },
      { name: "late", startHour: 22, endHour: 26, character: "Calm, ambient, rewatchable", maxDurationMinutes: 240 },
    ],
  };
}

async function loadCuratorState(): Promise<CuratorState> {
  const state = await loadJson<CuratorState>(CURATOR_STATE_PATH);
  if (state && state.version) {
    return state;
  }
  return {
    version: "1.0",
    updatedAt: new Date().toISOString(),
    channelAffinities: {},
    topicPreferences: {},
    formatPreferences: {},
    recentDecisions: [],
  };
}

async function saveCuratorState(state: CuratorState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  // Keep recent decisions manageable (last 50)
  if (state.recentDecisions.length > 50) {
    state.recentDecisions = state.recentDecisions.slice(-50);
  }
  await writeFile(CURATOR_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function logDecision(state: CuratorState, action: string, summary: string): void {
  state.recentDecisions.push({
    date: new Date().toISOString(),
    action,
    summary,
  });
}

// --- Utility Functions ---

function parseDurationMinutes(isoDuration?: string): number {
  if (!isoDuration) return 0;
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 60 + minutes + Math.ceil(seconds / 60);
}

function classifyFormat(durationMin: number): string {
  if (durationMin <= 5) return "clip";
  if (durationMin <= 20) return "short-form";
  if (durationMin <= 45) return "medium-form";
  if (durationMin <= 90) return "long-form";
  return "extended";
}

function classifyTopics(video: VideoResource): string[] {
  const topics: string[] = [];
  const text = `${video.title} ${video.description || ""} ${(video.tags || []).join(" ")}`.toLowerCase();

  const topicKeywords: Record<string, string[]> = {
    technology: ["tech", "software", "programming", "code", "developer", "ai", "machine learning", "computer"],
    science: ["science", "physics", "biology", "chemistry", "research", "experiment", "discovery"],
    education: ["tutorial", "learn", "course", "lesson", "how to", "guide", "explained", "education"],
    news: ["news", "breaking", "update", "report", "coverage", "headline"],
    entertainment: ["funny", "comedy", "entertainment", "vlog", "reaction", "challenge"],
    music: ["music", "song", "album", "concert", "remix", "playlist", "cover"],
    gaming: ["game", "gaming", "gameplay", "playthrough", "stream", "esports"],
    documentary: ["documentary", "investigation", "deep dive", "history", "explore"],
  };

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some((kw) => text.includes(kw))) {
      topics.push(topic);
    }
  }

  if (topics.length === 0) topics.push("general");
  return topics;
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// --- Action 1: Build Guide ---

async function buildGuide(params: Record<string, unknown>): Promise<void> {
  const date = (params.date as string) || todayDateString();
  const preferences = (params.preferences as Record<string, unknown>) || {};
  console.log(`\n=== Curator: Build Guide for ${date} ===\n`);

  const config = await loadGuideConfig();
  const blocks = config.blocks;
  const bufferMinutes = config.bufferMinutes ?? 15;
  const defaultDuration = config.defaultDurationMinutes ?? 30;

  const videos = await loadVideos();
  if (videos.length === 0) {
    console.log("No video resources found. Run ingestion first.");
    return;
  }

  const channels = await loadChannels();
  const channelTitleMap = new Map<string, string>();
  for (const ch of channels) channelTitleMap.set(ch.id, ch.title);

  const state = await loadCuratorState();

  // Score each video for each block, incorporating curator preferences
  videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const blockAssignments = new Map<string, VideoResource[]>();
  for (const block of blocks) blockAssignments.set(block.name, []);

  const assigned = new Set<string>();

  // Separate by broadcast status
  const liveVideos = videos.filter((v) => v.liveBroadcastContent === "live");
  const upcomingVideos = videos.filter((v) => v.liveBroadcastContent === "upcoming");
  const normalVideos = videos.filter((v) => !v.liveBroadcastContent || v.liveBroadcastContent === "none");

  // Assign live videos first
  for (const video of liveVideos) {
    const bestBlock = blocks.reduce((best, block) =>
      scoreVideoForBlock(video, block, defaultDuration, state, preferences) >
      scoreVideoForBlock(video, best, defaultDuration, state, preferences)
        ? block : best
    );
    blockAssignments.get(bestBlock.name)!.push(video);
    assigned.add(video.id);
  }

  // Assign upcoming videos
  for (const video of upcomingVideos) {
    const bestBlock = blocks.reduce((best, block) =>
      scoreVideoForBlock(video, block, defaultDuration, state, preferences) >
      scoreVideoForBlock(video, best, defaultDuration, state, preferences)
        ? block : best
    );
    blockAssignments.get(bestBlock.name)!.push(video);
    assigned.add(video.id);
  }

  // Assign normal videos with curator scoring
  for (const video of normalVideos) {
    if (assigned.has(video.id)) continue;
    const bestBlock = blocks.reduce((best, block) =>
      scoreVideoForBlock(video, block, defaultDuration, state, preferences) >
      scoreVideoForBlock(video, best, defaultDuration, state, preferences)
        ? block : best
    );
    blockAssignments.get(bestBlock.name)!.push(video);
    assigned.add(video.id);
  }

  // Build guide entries
  const now = new Date().toISOString();
  const guideEntries: GuideEntry[] = [];

  for (const block of blocks) {
    const blockVideos = blockAssignments.get(block.name) || [];
    if (blockVideos.length === 0) continue;

    const startDate = new Date(`${date}T00:00:00Z`);
    const startHour = block.startHour >= 24 ? block.startHour - 24 : block.startHour;
    startDate.setUTCHours(startHour, 0, 0, 0);
    if (block.startHour >= 24) startDate.setUTCDate(startDate.getUTCDate() + 1);

    const endDate = new Date(`${date}T00:00:00Z`);
    const endHour = block.endHour >= 24 ? block.endHour - 24 : block.endHour;
    endDate.setUTCHours(endHour, 0, 0, 0);
    if (block.endHour >= 24) endDate.setUTCDate(endDate.getUTCDate() + 1);

    let currentTime = startDate.getTime();

    for (const video of blockVideos) {
      if (currentTime >= endDate.getTime()) break;

      const entry: GuideEntry = {
        videoId: video.id,
        channelId: video.channelId,
        title: video.title,
        scheduledAt: new Date(currentTime).toISOString(),
        block: block.name,
        updatedAt: now,
      };

      const channelTitle = channelTitleMap.get(video.channelId);
      if (channelTitle) entry.channelTitle = channelTitle;
      if (video.duration) entry.duration = video.duration;
      if (video.liveBroadcastContent) entry.liveBroadcastContent = video.liveBroadcastContent;
      if (video.premiereAt) entry.premiereAt = video.premiereAt;

      guideEntries.push(entry);

      const durationMin = parseDurationMinutes(video.duration) || defaultDuration;
      currentTime += Math.max(durationMin + bufferMinutes, defaultDuration) * 60 * 1000;
    }
  }

  // Write guide
  await mkdir(GUIDE_DIR, { recursive: true });
  const guidePath = join(GUIDE_DIR, `${date}.json`);
  await writeFile(guidePath, JSON.stringify(guideEntries, null, 2) + "\n");

  // Log decision
  logDecision(state, "buildGuide", `Generated guide for ${date} with ${guideEntries.length} entries across ${blocks.length} blocks`);
  await saveCuratorState(state);

  console.log(`Generated ${guideEntries.length} guide entries`);
  for (const entry of guideEntries) {
    const time = entry.scheduledAt.slice(11, 16);
    const liveTag = entry.liveBroadcastContent === "live" ? " [LIVE]" :
                    entry.liveBroadcastContent === "upcoming" ? " [UPCOMING]" : "";
    console.log(`  ${time} [${entry.block}] ${entry.title}${liveTag}`);
  }
  console.log(`\nWritten to resources/guide/${date}.json`);
}

function scoreVideoForBlock(
  video: VideoResource,
  block: EditorialBlock,
  defaultDuration: number,
  state: CuratorState,
  preferences: Record<string, unknown>
): number {
  let score = 0;
  const durationMin = parseDurationMinutes(video.duration) || defaultDuration;

  // Duration fit
  if (block.maxDurationMinutes) {
    if (durationMin <= block.maxDurationMinutes) {
      score += 10;
    } else {
      score -= Math.min(20, (durationMin - block.maxDurationMinutes) / 10);
    }
  }

  // Tag match
  if (block.preferredTags && video.tags) {
    const videoTags = new Set(video.tags.map((t) => t.toLowerCase()));
    for (const preferred of block.preferredTags) {
      if (videoTags.has(preferred.toLowerCase())) score += 5;
    }
  }

  // Live/premiere bonus
  if (video.liveBroadcastContent === "live") score += 20;
  else if (video.liveBroadcastContent === "upcoming") score += 15;

  // Recency bonus
  const ageHours = (Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60);
  if (ageHours < 24) score += 5;
  else if (ageHours < 72) score += 2;

  // Curator affinity bonus — prefer channels the viewer engages with
  const affinity = state.channelAffinities[video.channelId];
  if (affinity) {
    score += affinity.score * 8;
  }

  // Topic preference bonus
  const topics = classifyTopics(video);
  for (const topic of topics) {
    const pref = state.topicPreferences[topic];
    if (pref) score += pref.score * 5;
  }

  // Format preference bonus
  const format = classifyFormat(durationMin);
  const formatPref = state.formatPreferences[format];
  if (formatPref) score += formatPref.score * 3;

  // User-specified topic preferences
  const favored = preferences.topicsFavored as string[] | undefined;
  const avoided = preferences.topicsAvoided as string[] | undefined;
  if (favored) {
    for (const topic of topics) {
      if (favored.includes(topic)) score += 10;
    }
  }
  if (avoided) {
    for (const topic of topics) {
      if (avoided.includes(topic)) score -= 15;
    }
  }

  return score;
}

// --- Action 2: Update Wall Layout ---

async function updateWallLayout(params: Record<string, unknown>): Promise<void> {
  const layoutName = params.name as string;
  const channelList = params.channels as string[];
  const rows = (params.rows as number) || undefined;
  const cols = (params.cols as number) || undefined;

  if (!layoutName) {
    console.error("Error: 'name' parameter is required for updateWallLayout");
    process.exit(1);
  }
  if (!channelList || !Array.isArray(channelList)) {
    console.error("Error: 'channels' parameter (array) is required for updateWallLayout");
    process.exit(1);
  }

  console.log(`\n=== Curator: Update Wall Layout "${layoutName}" ===\n`);

  let layouts: WallLayout[] = [];
  try {
    const text = await readFile(WALL_LAYOUTS_PATH, "utf-8");
    layouts = JSON.parse(text) as WallLayout[];
  } catch {
    layouts = [];
  }

  // Find existing layout or create new
  const existingIndex = layouts.findIndex((l) => l.name === layoutName);
  const computedCols = cols || Math.ceil(Math.sqrt(channelList.length));
  const computedRows = rows || Math.ceil(channelList.length / computedCols);

  const layout: WallLayout = {
    name: layoutName,
    rows: Math.min(Math.max(computedRows, 1), 10),
    cols: Math.min(Math.max(computedCols, 1), 10),
    channels: channelList,
  };

  if (existingIndex >= 0) {
    layouts[existingIndex] = layout;
    console.log(`Updated existing layout "${layoutName}"`);
  } else {
    layouts.push(layout);
    console.log(`Created new layout "${layoutName}"`);
  }

  await writeFile(WALL_LAYOUTS_PATH, JSON.stringify(layouts, null, 2) + "\n");

  const state = await loadCuratorState();
  logDecision(state, "updateWallLayout", `Updated wall layout "${layoutName}" with ${channelList.length} channels (${layout.rows}×${layout.cols})`);
  await saveCuratorState(state);

  console.log(`Layout: ${layout.rows}×${layout.cols} grid, ${channelList.length} channels`);
  console.log(`Written to resources/wall-layouts.json`);
}

// --- Action 3: Recommend Content ---

async function recommendContent(params: Record<string, unknown>): Promise<void> {
  const topic = (params.topic as string) || "";
  const mood = (params.mood as string) || "";
  const maxDuration = params.duration as number | undefined;
  const limit = (params.limit as number) || 10;

  console.log(`\n=== Curator: Recommend Content ===\n`);
  if (topic) console.log(`Topic: ${topic}`);
  if (mood) console.log(`Mood: ${mood}`);
  if (maxDuration) console.log(`Max duration: ${maxDuration} minutes`);

  const videos = await loadVideos();
  const channels = await loadChannels();
  const channelTitleMap = new Map<string, string>();
  for (const ch of channels) channelTitleMap.set(ch.id, ch.title);

  const state = await loadCuratorState();
  const results: RecommendResult[] = [];

  const queryTerms = tokenize(`${topic} ${mood}`);

  for (const video of videos) {
    let score = 0;
    const reasons: string[] = [];

    // Text match against title, description, tags
    const videoText = `${video.title} ${video.description || ""} ${(video.tags || []).join(" ")}`.toLowerCase();
    for (const term of queryTerms) {
      if (videoText.includes(term)) {
        score += 10;
        reasons.push(`matches "${term}"`);
      }
    }

    // Duration filter
    if (maxDuration) {
      const durationMin = parseDurationMinutes(video.duration);
      if (durationMin > 0 && durationMin <= maxDuration) {
        score += 3;
      } else if (durationMin > maxDuration) {
        score -= 10;
      }
    }

    // Channel affinity
    const affinity = state.channelAffinities[video.channelId];
    if (affinity && affinity.score > 0.5) {
      score += affinity.score * 5;
      reasons.push("preferred channel");
    }

    // Topic match from curator state
    const videoTopics = classifyTopics(video);
    for (const vt of videoTopics) {
      const pref = state.topicPreferences[vt];
      if (pref && pref.score > 0.5) {
        score += pref.score * 3;
        reasons.push(`preferred topic: ${vt}`);
      }
    }

    // Recency bonus
    const ageHours = (Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < 48) {
      score += 3;
      reasons.push("recent");
    }

    if (score > 0) {
      results.push({
        videoId: video.id,
        title: video.title,
        channelTitle: channelTitleMap.get(video.channelId),
        score,
        reason: reasons.join(", "),
        source: "repository",
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, limit);

  const state2 = await loadCuratorState();
  logDecision(state2, "recommendContent", `Recommended ${topResults.length} videos for topic="${topic}" mood="${mood}"`);
  await saveCuratorState(state2);

  console.log(`\nFound ${topResults.length} recommendation(s):\n`);
  for (let i = 0; i < topResults.length; i++) {
    const r = topResults[i];
    console.log(`  ${i + 1}. [${r.score}] ${r.title}`);
    if (r.channelTitle) console.log(`     Channel: ${r.channelTitle}`);
    console.log(`     Reason: ${r.reason}`);
    console.log(`     https://youtube.com/watch?v=${r.videoId}`);
  }

  // Output as JSON for programmatic use
  console.log(`\nCURATOR_RESULT=${JSON.stringify(topResults)}`);
}

// --- Action 4: Summarize Channel ---

async function summarizeChannel(params: Record<string, unknown>): Promise<void> {
  const channelId = params.channelId as string;
  if (!channelId) {
    console.error("Error: 'channelId' parameter is required for summarizeChannel");
    process.exit(1);
  }

  console.log(`\n=== Curator: Summarize Channel ${channelId} ===\n`);

  const channels = await loadChannels();
  const channel = channels.find((c) => c.id === channelId);
  if (!channel) {
    console.log(`Channel ${channelId} not found in repository resources.`);
    return;
  }

  const videos = await loadVideos();
  const channelVideos = videos
    .filter((v) => v.channelId === channelId)
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  const state = await loadCuratorState();
  const affinity = state.channelAffinities[channelId];

  // Build narrative summary
  const parts: string[] = [];
  parts.push(`Channel: ${channel.title}`);
  if (channel.description) parts.push(`Description: ${channel.description.slice(0, 200)}`);
  if (channel.subscriberCount) parts.push(`Subscribers: ${channel.subscriberCount.toLocaleString()}`);
  parts.push(`Videos in repository: ${channelVideos.length}`);

  if (channelVideos.length > 0) {
    const latest = channelVideos[0];
    const ageHours = (Date.now() - new Date(latest.publishedAt).getTime()) / (1000 * 60 * 60);
    const ageDays = Math.floor(ageHours / 24);
    parts.push(`Most recent: "${latest.title}" (${ageDays} days ago)`);

    // Calculate average duration
    const durations = channelVideos
      .map((v) => parseDurationMinutes(v.duration))
      .filter((d) => d > 0);
    if (durations.length > 0) {
      const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
      parts.push(`Average duration: ${avg} minutes`);
    }

    // Topic analysis
    const topicCounts: Record<string, number> = {};
    for (const v of channelVideos) {
      for (const topic of classifyTopics(v)) {
        topicCounts[topic] = (topicCounts[topic] || 0) + 1;
      }
    }
    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);
    if (topTopics.length > 0) {
      parts.push(`Primary topics: ${topTopics.join(", ")}`);
    }

    // Live content
    const liveCount = channelVideos.filter((v) => v.liveBroadcastContent === "live" || v.liveBroadcastContent === "upcoming").length;
    if (liveCount > 0) {
      parts.push(`Live/upcoming content: ${liveCount} video(s)`);
    }
  }

  if (affinity) {
    parts.push(`Curator affinity score: ${(affinity.score * 100).toFixed(0)}%`);
    parts.push(`Featured: ${affinity.featuredCount}, Skipped: ${affinity.skippedCount}`);
  }

  const summary = parts.join("\n");
  console.log(summary);

  logDecision(state, "summarizeChannel", `Summarized channel "${channel.title}" (${channelId})`);
  await saveCuratorState(state);

  console.log(`\nCURATOR_RESULT=${JSON.stringify({ channelId, title: channel.title, summary })}`);
}

// --- Action 5: Generate Receipt ---

async function generateReceipt(params: Record<string, unknown>): Promise<void> {
  const period = (params.period as string) || "day";
  const dateStr = (params.date as string) || shiftDate(todayDateString(), -1);

  console.log(`\n=== Curator: Generate Receipt (${period}) for ${dateStr} ===\n`);

  const receiptId = period === "week" ? `receipt-${dateStr}-week` : `receipt-${dateStr}`;
  const receiptPath = join(RECEIPTS_DIR, `${receiptId}.json`);

  const periodStart = period === "week"
    ? shiftDate(dateStr, -6) + "T00:00:00Z"
    : dateStr + "T00:00:00Z";
  const periodEnd = dateStr + "T23:59:59Z";

  // Collect guide dates
  const guideDates: string[] = [];
  if (period === "week") {
    for (let i = -6; i <= 0; i++) guideDates.push(shiftDate(dateStr, i));
  } else {
    guideDates.push(dateStr);
  }

  // Load guide entries
  const allGuideEntries: GuideEntry[] = [];
  for (const d of guideDates) {
    const guide = await loadJson<GuideEntry[]>(join(GUIDE_DIR, `${d}.json`));
    if (guide && Array.isArray(guide)) allGuideEntries.push(...guide);
  }

  // Load videos and channels
  const videos = await loadVideos();
  const videoMap = new Map<string, VideoResource>();
  for (const v of videos) videoMap.set(v.id, v);

  const channels = await loadChannels();
  const channelTitleMap = new Map<string, string>();
  for (const ch of channels) channelTitleMap.set(ch.id, ch.title);

  // Identify arrived videos
  const periodStartTime = new Date(periodStart).getTime();
  const periodEndTime = new Date(periodEnd).getTime();
  const arrivedVideos = videos.filter((v) => {
    const pub = new Date(v.publishedAt).getTime();
    return pub >= periodStartTime && pub <= periodEndTime;
  });

  const arrived: ReceiptVideo[] = arrivedVideos.map((v) => ({
    videoId: v.id,
    title: v.title,
    channelTitle: channelTitleMap.get(v.channelId),
  }));

  const featuredVideoIds = new Set(allGuideEntries.map((e) => e.videoId));
  const skipped: ReceiptVideo[] = arrivedVideos
    .filter((v) => !featuredVideoIds.has(v.id))
    .map((v) => ({
      videoId: v.id,
      title: v.title,
      channelTitle: channelTitleMap.get(v.channelId),
    }));

  const watched: ReceiptVideo[] = [];

  // Compute stats
  const channelDistribution: Record<string, number> = {};
  let totalDurationMinutes = 0;
  for (const entry of allGuideEntries) {
    const chName = entry.channelTitle || channelTitleMap.get(entry.channelId) || entry.channelId;
    channelDistribution[chName] = (channelDistribution[chName] || 0) + 1;
    totalDurationMinutes += parseDurationMinutes(entry.duration);
  }

  // Build curator notes with learning context
  const state = await loadCuratorState();
  const notesParts: string[] = [];
  if (period === "week") {
    notesParts.push(`Weekly summary for the week ending ${dateStr}.`);
  } else {
    notesParts.push(`Daily summary for ${dateStr}.`);
  }

  if (arrived.length === 0) {
    notesParts.push("No new content arrived during this period.");
  } else {
    notesParts.push(`${arrived.length} video${arrived.length > 1 ? "s" : ""} arrived and ${arrived.length > 1 ? "were" : "was"} featured in the guide.`);
  }

  if (totalDurationMinutes > 0) {
    const hours = Math.floor(totalDurationMinutes / 60);
    const mins = totalDurationMinutes % 60;
    notesParts.push(hours > 0 ? `Total scheduled duration: ${hours}h ${mins}m.` : `Total scheduled duration: ${mins}m.`);
  }

  const channelCount = Object.keys(channelDistribution).length;
  if (channelCount > 0) {
    notesParts.push(`Content spanned ${channelCount} channel${channelCount > 1 ? "s" : ""}.`);
  }

  if (skipped.length > 0) {
    notesParts.push(`${skipped.length} available video${skipped.length > 1 ? "s were" : " was"} not featured in the guide.`);
  }

  // Curator observations from learning state
  const topChannels = Object.entries(state.channelAffinities)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3);
  if (topChannels.length > 0) {
    const names = topChannels.map(([id]) => channelTitleMap.get(id) || id).join(", ");
    notesParts.push(`Top preferred channels: ${names}.`);
  }

  const receipt: ViewingReceipt = {
    id: receiptId,
    periodStart,
    periodEnd,
    generatedAt: new Date().toISOString(),
    watched,
    arrived,
    skipped,
    curatorNotes: notesParts.join(" "),
    stats: {
      totalWatched: watched.length,
      totalArrived: arrived.length,
      totalSkipped: skipped.length,
      totalDurationMinutes,
      channelDistribution,
    },
  };

  await mkdir(RECEIPTS_DIR, { recursive: true });
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

  logDecision(state, "generateReceipt", `Generated ${period} receipt for ${dateStr}: ${arrived.length} arrived, ${skipped.length} skipped`);
  await saveCuratorState(state);

  console.log(`Receipt: ${receiptId}`);
  console.log(`Period: ${periodStart} → ${periodEnd}`);
  console.log(`Arrived: ${arrived.length}, Skipped: ${skipped.length}`);
  console.log(`Written to resources/receipts/${receiptId}.json`);
}

// --- Action 6: Flag Content ---

async function flagContent(params: Record<string, unknown>): Promise<void> {
  const videoId = params.videoId as string;
  const reason = params.reason as string;

  if (!videoId) {
    console.error("Error: 'videoId' parameter is required for flagContent");
    process.exit(1);
  }
  if (!reason) {
    console.error("Error: 'reason' parameter is required for flagContent");
    process.exit(1);
  }

  console.log(`\n=== Curator: Flag Content ${videoId} ===\n`);

  const videoPath = join(VIDEOS_DIR, `${videoId}.json`);
  if (!(await fileExists(videoPath))) {
    console.log(`Video ${videoId} not found in repository resources.`);
    return;
  }

  const text = await readFile(videoPath, "utf-8");
  const video = JSON.parse(text) as VideoResource;

  // Add tag
  if (!video.tags) video.tags = [];
  const tag = `curator:${reason.toLowerCase().replace(/\s+/g, "-")}`;
  if (!video.tags.includes(tag)) {
    video.tags.push(tag);
    await writeFile(videoPath, JSON.stringify(video, null, 2) + "\n");
    console.log(`Added tag "${tag}" to video "${video.title}"`);
  } else {
    console.log(`Tag "${tag}" already exists on video "${video.title}"`);
  }

  const state = await loadCuratorState();
  logDecision(state, "flagContent", `Flagged video "${video.title}" (${videoId}) with reason: ${reason}`);
  await saveCuratorState(state);

  console.log(`Written to resources/videos/${videoId}.json`);
}

// --- Action 7: Answer Question ---

async function answerQuestion(params: Record<string, unknown>): Promise<void> {
  const query = params.query as string;
  if (!query) {
    console.error("Error: 'query' parameter is required for answerQuestion");
    process.exit(1);
  }

  console.log(`\n=== Curator: Answer Question ===\n`);
  console.log(`Query: ${query}\n`);

  const videos = await loadVideos();
  const channels = await loadChannels();
  const receipts = await loadReceipts();
  const state = await loadCuratorState();

  const channelTitleMap = new Map<string, string>();
  for (const ch of channels) channelTitleMap.set(ch.id, ch.title);

  const queryLower = query.toLowerCase();
  const parts: string[] = [];

  // Answer based on query patterns
  if (queryLower.includes("how many") && queryLower.includes("video")) {
    parts.push(`There are ${videos.length} videos in the repository.`);
  }

  if (queryLower.includes("how many") && queryLower.includes("channel")) {
    parts.push(`There are ${channels.length} channels tracked.`);
  }

  if (queryLower.includes("latest") || queryLower.includes("recent") || queryLower.includes("newest")) {
    const sorted = [...videos].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    const recent = sorted.slice(0, 5);
    parts.push("Most recent videos:");
    for (const v of recent) {
      const ch = channelTitleMap.get(v.channelId) || v.channelId;
      parts.push(`  - "${v.title}" by ${ch} (${v.publishedAt.slice(0, 10)})`);
    }
  }

  if (queryLower.includes("live") || queryLower.includes("streaming")) {
    const live = videos.filter((v) => v.liveBroadcastContent === "live");
    const upcoming = videos.filter((v) => v.liveBroadcastContent === "upcoming");
    parts.push(`Live streams: ${live.length} active, ${upcoming.length} upcoming.`);
  }

  if (queryLower.includes("receipt") || queryLower.includes("viewing")) {
    parts.push(`There are ${receipts.length} viewing receipts in the repository.`);
    if (receipts.length > 0) {
      const latest = receipts.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())[0];
      parts.push(`Latest receipt: ${latest.id} (${latest.periodStart.slice(0, 10)} to ${latest.periodEnd.slice(0, 10)})`);
    }
  }

  if (queryLower.includes("prefer") || queryLower.includes("affinity") || queryLower.includes("favorite")) {
    const topChannels = Object.entries(state.channelAffinities)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 5);
    if (topChannels.length > 0) {
      parts.push("Top channel affinities:");
      for (const [id, aff] of topChannels) {
        const name = channelTitleMap.get(id) || id;
        parts.push(`  - ${name}: ${(aff.score * 100).toFixed(0)}% (featured: ${aff.featuredCount}, skipped: ${aff.skippedCount})`);
      }
    } else {
      parts.push("No viewing preferences have been learned yet. Generate receipts to build up preference data.");
    }

    const topTopics = Object.entries(state.topicPreferences)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 5);
    if (topTopics.length > 0) {
      parts.push("Top topic preferences:");
      for (const [topic, pref] of topTopics) {
        parts.push(`  - ${topic}: ${(pref.score * 100).toFixed(0)}% (${pref.featuredCount} featured)`);
      }
    }
  }

  // General search fallback — find videos matching query terms
  if (parts.length === 0) {
    const queryTerms = tokenize(query);
    const matches: { video: VideoResource; score: number }[] = [];

    for (const video of videos) {
      const videoText = `${video.title} ${video.description || ""} ${(video.tags || []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        if (videoText.includes(term)) score += 1;
      }
      if (score > 0) matches.push({ video, score });
    }

    matches.sort((a, b) => b.score - a.score);
    const top = matches.slice(0, 5);

    if (top.length > 0) {
      parts.push(`Found ${matches.length} relevant video(s). Top results:`);
      for (const m of top) {
        const ch = channelTitleMap.get(m.video.channelId) || m.video.channelId;
        parts.push(`  - "${m.video.title}" by ${ch}`);
      }
    } else {
      parts.push("No matching content found in the repository for that query.");
    }
  }

  const answer = parts.join("\n");
  console.log(answer);

  logDecision(state, "answerQuestion", `Answered question: "${query.slice(0, 80)}"`);
  await saveCuratorState(state);

  console.log(`\nCURATOR_RESULT=${JSON.stringify({ query, answer })}`);
}

// --- Action 8: Search Content ---

async function searchContent(params: Record<string, unknown>): Promise<void> {
  const query = params.query as string;
  const limit = (params.limit as number) || 10;
  const includeApi = (params.includeApi as boolean) || false;

  if (!query) {
    console.error("Error: 'query' parameter is required for searchContent");
    process.exit(1);
  }

  console.log(`\n=== Curator: Search Content ===\n`);
  console.log(`Query: ${query}`);

  const queryTerms = tokenize(query);
  const results: SearchResult[] = [];

  // Repository search (offline, fast)
  const videos = await loadVideos();
  const channels = await loadChannels();
  const channelTitleMap = new Map<string, string>();
  for (const ch of channels) channelTitleMap.set(ch.id, ch.title);

  // Search transcripts too
  const transcripts = await loadTranscripts();
  const transcriptMap = new Map<string, TranscriptResource>();
  for (const t of transcripts) transcriptMap.set(t.videoId, t);

  for (const video of videos) {
    let score = 0;

    // Title match (high weight)
    const titleLower = video.title.toLowerCase();
    for (const term of queryTerms) {
      if (titleLower.includes(term)) score += 10;
    }

    // Description match
    if (video.description) {
      const descLower = video.description.toLowerCase();
      for (const term of queryTerms) {
        if (descLower.includes(term)) score += 2;
      }
    }

    // Tag match
    if (video.tags) {
      const tagText = video.tags.join(" ").toLowerCase();
      for (const term of queryTerms) {
        if (tagText.includes(term)) score += 4;
      }
    }

    // Transcript match
    const transcript = transcriptMap.get(video.id);
    let transcriptMatch: { start: number; text: string } | undefined;
    if (transcript) {
      for (const seg of transcript.segments) {
        const segLower = seg.text.toLowerCase();
        if (queryTerms.some((term) => segLower.includes(term))) {
          score += 3;
          if (!transcriptMatch) transcriptMatch = seg;
        }
      }
    }

    if (score > 0) {
      results.push({
        videoId: video.id,
        title: video.title,
        channelTitle: channelTitleMap.get(video.channelId),
        score,
        source: "repository",
        transcriptMatch,
      });
    }
  }

  // YouTube API search (quota-aware, only when requested)
  if (includeApi && YOUTUBE_API_KEY && quotaRemaining() >= 100) {
    console.log("\nSearching YouTube API...");
    try {
      const searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=5&key=${YOUTUBE_API_KEY}`;
      const res = await fetch(searchUrl);
      trackQuota("search.list", 100);

      if (res.ok) {
        const data = (await res.json()) as {
          items: { id: { videoId: string }; snippet: { title: string; channelTitle: string } }[];
        };
        const existingIds = new Set(videos.map((v) => v.id));
        for (const item of data.items || []) {
          if (!existingIds.has(item.id.videoId)) {
            results.push({
              videoId: item.id.videoId,
              title: item.snippet.title,
              channelTitle: item.snippet.channelTitle,
              score: 5,
              source: "api",
            });
          }
        }
      }
    } catch (e) {
      console.log(`YouTube API search failed: ${e}`);
    }
  } else if (includeApi && !YOUTUBE_API_KEY) {
    console.log("YouTube API search skipped: YOUTUBE_API_KEY not set");
  } else if (includeApi && quotaRemaining() < 100) {
    console.log("YouTube API search skipped: insufficient quota budget");
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, limit);

  const state = await loadCuratorState();
  logDecision(state, "searchContent", `Searched for "${query}": ${topResults.length} results (${results.length} total)`);
  await saveCuratorState(state);

  console.log(`\nFound ${topResults.length} result(s):\n`);
  for (let i = 0; i < topResults.length; i++) {
    const r = topResults[i];
    const sourceTag = r.source === "api" ? " [API]" : "";
    console.log(`  ${i + 1}. [${r.score}] ${r.title}${sourceTag}`);
    if (r.channelTitle) console.log(`     Channel: ${r.channelTitle}`);
    if (r.transcriptMatch) {
      const mins = Math.floor(r.transcriptMatch.start / 60);
      const secs = Math.floor(r.transcriptMatch.start % 60);
      console.log(`     Transcript: "${r.transcriptMatch.text}" (${mins}:${secs.toString().padStart(2, "0")})`);
    }
    console.log(`     https://youtube.com/watch?v=${r.videoId}`);
  }

  console.log(`\nCURATOR_RESULT=${JSON.stringify(topResults)}`);
}

// --- Action: Learn from Receipts (Feedback Loop - Step 7.5) ---

async function learnFromReceipts(): Promise<void> {
  console.log(`\n=== Curator: Learn from Receipts ===\n`);

  const receipts = await loadReceipts();
  if (receipts.length === 0) {
    console.log("No receipts found. Generate receipts first to enable learning.");
    return;
  }

  const videos = await loadVideos();
  const videoMap = new Map<string, VideoResource>();
  for (const v of videos) videoMap.set(v.id, v);

  const state = await loadCuratorState();

  // Analyze all receipts
  const channelFeatured: Record<string, number> = {};
  const channelSkipped: Record<string, number> = {};
  const topicFeatured: Record<string, number> = {};
  const formatFeatured: Record<string, number> = {};

  for (const receipt of receipts) {
    // Featured = arrived (content in the guide)
    for (const item of receipt.arrived) {
      const video = videoMap.get(item.videoId);
      if (video) {
        channelFeatured[video.channelId] = (channelFeatured[video.channelId] || 0) + 1;
        for (const topic of classifyTopics(video)) {
          topicFeatured[topic] = (topicFeatured[topic] || 0) + 1;
        }
        const durationMin = parseDurationMinutes(video.duration);
        const format = classifyFormat(durationMin);
        formatFeatured[format] = (formatFeatured[format] || 0) + 1;
      }
    }

    // Skipped = available but not in guide
    for (const item of receipt.skipped) {
      const video = videoMap.get(item.videoId);
      if (video) {
        channelSkipped[video.channelId] = (channelSkipped[video.channelId] || 0) + 1;
      }
    }
  }

  // Update channel affinities
  const allChannelIds = new Set([...Object.keys(channelFeatured), ...Object.keys(channelSkipped)]);
  for (const channelId of allChannelIds) {
    const featured = channelFeatured[channelId] || 0;
    const skipped = channelSkipped[channelId] || 0;
    const total = featured + skipped;
    const score = total > 0 ? featured / total : 0.5;
    state.channelAffinities[channelId] = { featuredCount: featured, skippedCount: skipped, score };
  }

  // Update topic preferences
  const totalTopicCount = Object.values(topicFeatured).reduce((a, b) => a + b, 0);
  for (const [topic, count] of Object.entries(topicFeatured)) {
    state.topicPreferences[topic] = {
      featuredCount: count,
      score: totalTopicCount > 0 ? count / totalTopicCount : 0.5,
    };
  }

  // Update format preferences
  const totalFormatCount = Object.values(formatFeatured).reduce((a, b) => a + b, 0);
  for (const [format, count] of Object.entries(formatFeatured)) {
    state.formatPreferences[format] = {
      featuredCount: count,
      score: totalFormatCount > 0 ? count / totalFormatCount : 0.5,
    };
  }

  logDecision(state, "learnFromReceipts", `Analyzed ${receipts.length} receipt(s): ${allChannelIds.size} channels, ${Object.keys(topicFeatured).length} topics, ${Object.keys(formatFeatured).length} formats`);
  await saveCuratorState(state);

  console.log(`Analyzed ${receipts.length} receipt(s)`);
  console.log(`Channel affinities: ${allChannelIds.size}`);
  console.log(`Topic preferences: ${Object.keys(state.topicPreferences).length}`);
  console.log(`Format preferences: ${Object.keys(state.formatPreferences).length}`);

  // Report top preferences
  const topChannels = Object.entries(state.channelAffinities)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5);
  if (topChannels.length > 0) {
    console.log("\nTop channel affinities:");
    for (const [id, aff] of topChannels) {
      console.log(`  ${id}: ${(aff.score * 100).toFixed(0)}% (featured: ${aff.featuredCount}, skipped: ${aff.skippedCount})`);
    }
  }

  console.log(`\nCurator state updated → resources/curator-state.json`);
}

// --- Main Dispatcher ---

const VALID_ACTIONS = [
  "buildGuide",
  "updateWallLayout",
  "recommendContent",
  "summarizeChannel",
  "generateReceipt",
  "flagContent",
  "answerQuestion",
  "searchContent",
  "learnFromReceipts",
] as const;

type CuratorAction = (typeof VALID_ACTIONS)[number];

async function main(): Promise<void> {
  const action = process.env.CURATOR_ACTION as CuratorAction | undefined;
  const paramsStr = process.env.CURATOR_PARAMS || "{}";

  if (!action) {
    console.log("=== Intelligent Curator ===\n");
    console.log("Available actions:");
    for (const a of VALID_ACTIONS) {
      console.log(`  - ${a}`);
    }
    console.log("\nUsage: CURATOR_ACTION=<action> CURATOR_PARAMS='{...}' bun run curator");
    console.log("\nExamples:");
    console.log('  CURATOR_ACTION=buildGuide CURATOR_PARAMS=\'{"date":"2026-03-21"}\' bun run curator');
    console.log('  CURATOR_ACTION=recommendContent CURATOR_PARAMS=\'{"topic":"technology","mood":"informative"}\' bun run curator');
    console.log('  CURATOR_ACTION=searchContent CURATOR_PARAMS=\'{"query":"machine learning"}\' bun run curator');
    console.log('  CURATOR_ACTION=learnFromReceipts bun run curator');
    return;
  }

  if (!VALID_ACTIONS.includes(action)) {
    console.error(`Error: Unknown action "${action}"`);
    console.error(`Valid actions: ${VALID_ACTIONS.join(", ")}`);
    process.exit(1);
  }

  let params: Record<string, unknown>;
  try {
    params = JSON.parse(paramsStr) as Record<string, unknown>;
  } catch {
    console.error(`Error: Invalid JSON in CURATOR_PARAMS: ${paramsStr}`);
    process.exit(1);
  }

  switch (action) {
    case "buildGuide":
      await buildGuide(params);
      break;
    case "updateWallLayout":
      await updateWallLayout(params);
      break;
    case "recommendContent":
      await recommendContent(params);
      break;
    case "summarizeChannel":
      await summarizeChannel(params);
      break;
    case "generateReceipt":
      await generateReceipt(params);
      break;
    case "flagContent":
      await flagContent(params);
      break;
    case "answerQuestion":
      await answerQuestion(params);
      break;
    case "searchContent":
      await searchContent(params);
      break;
    case "learnFromReceipts":
      await learnFromReceipts();
      break;
  }

  // Report quota usage
  if (quota.total > 0) {
    console.log(`\nQuota used: ${quota.total} / ${CURATOR_QUOTA_BUDGET} budget`);
    for (const op of quota.operations) {
      console.log(`  ${op.name}: ${op.cost} units`);
    }
  }
}

main();
