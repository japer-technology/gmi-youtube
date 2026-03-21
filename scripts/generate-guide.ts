/**
 * generate-guide.ts — Generate a TV guide from ingested video resources
 *
 * Reads all video resources, sorts by publishedAt, assigns scheduledAt
 * timestamps across editorial blocks, and writes a guide for the target date.
 *
 * Editorial blocks are loaded from resources/guide-config.json when available,
 * falling back to built-in defaults. Videos are assigned to blocks based on
 * duration, tags, and recency.
 *
 * Reads GUIDE_DATE environment variable (default: today in YYYY-MM-DD format).
 * Will not overwrite a guide for a past date unless GUIDE_FORCE=true is set.
 */

import { readdir, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESOURCES_DIR = join(ROOT, "resources");
const VIDEOS_DIR = join(RESOURCES_DIR, "videos");
const CHANNELS_DIR = join(RESOURCES_DIR, "channels");
const GUIDE_DIR = join(RESOURCES_DIR, "guide");
const GUIDE_CONFIG_PATH = join(RESOURCES_DIR, "guide-config.json");

interface VideoResource {
  id: string;
  channelId: string;
  title: string;
  publishedAt: string;
  duration?: string;
  liveBroadcastContent?: string;
  premiereAt?: string;
  tags?: string[];
}

interface ChannelResource {
  id: string;
  title: string;
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

const DEFAULT_BLOCKS: EditorialBlock[] = [
  { name: "morning", startHour: 6, endHour: 10, character: "Short-form, news, briefings", maxDurationMinutes: 30 },
  { name: "midday", startHour: 10, endHour: 14, character: "Medium-form, tutorials, talks", maxDurationMinutes: 60 },
  { name: "afternoon", startHour: 14, endHour: 18, character: "Long-form, documentaries, deep dives", maxDurationMinutes: 180 },
  { name: "evening", startHour: 18, endHour: 22, character: "Flagship content, curated highlights", maxDurationMinutes: 120 },
  { name: "late", startHour: 22, endHour: 26, character: "Calm, ambient, rewatchable", maxDurationMinutes: 240 },
];

const DEFAULT_BUFFER_MINUTES = 15;
const DEFAULT_DURATION_MINUTES = 30;

async function loadGuideConfig(): Promise<GuideConfig> {
  try {
    const text = await readFile(GUIDE_CONFIG_PATH, "utf-8");
    const config = JSON.parse(text) as GuideConfig;
    if (config.blocks && config.blocks.length > 0) {
      console.log(`Loaded guide config: ${config.blocks.length} editorial blocks`);
      return config;
    }
  } catch {
    // Fall back to defaults
  }
  console.log("Using default editorial blocks");
  return { blocks: DEFAULT_BLOCKS };
}

function blockForHour(hour: number, blocks: EditorialBlock[]): string {
  // Normalize hour past midnight (e.g., 1 → 25 for comparison)
  const h = hour < 6 ? hour + 24 : hour;
  for (const block of blocks) {
    if (h >= block.startHour && h < block.endHour) {
      return block.name;
    }
  }
  return blocks[blocks.length - 1]?.name || "late";
}

function parseDurationMinutes(isoDuration?: string): number {
  if (!isoDuration) return DEFAULT_DURATION_MINUTES;
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return DEFAULT_DURATION_MINUTES;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 60 + minutes + Math.ceil(seconds / 60);
}

function todayDateString(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
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

/**
 * Score a video's fit for a given editorial block.
 * Higher score = better fit. Based on duration, tags, and recency.
 */
function scoreVideoForBlock(
  video: VideoResource,
  block: EditorialBlock,
  defaultDuration: number
): number {
  let score = 0;
  const durationMin = parseDurationMinutes(video.duration) || defaultDuration;

  // Duration fit: prefer videos whose duration matches the block character
  if (block.maxDurationMinutes) {
    if (durationMin <= block.maxDurationMinutes) {
      // Within limit — closer to max is better for filling time
      score += 10;
    } else {
      // Over limit — penalise proportionally
      score -= Math.min(20, (durationMin - block.maxDurationMinutes) / 10);
    }
  }

  // Tag match: bonus for videos with tags matching block preferences
  if (block.preferredTags && video.tags) {
    const videoTags = new Set(video.tags.map((t) => t.toLowerCase()));
    for (const preferred of block.preferredTags) {
      if (videoTags.has(preferred.toLowerCase())) {
        score += 5;
      }
    }
  }

  // Live/premiere bonus: live content gets priority in evening, upcoming in any block
  if (video.liveBroadcastContent === "live") {
    score += 20;
  } else if (video.liveBroadcastContent === "upcoming") {
    score += 15;
  }

  // Recency: newer videos get a small bonus
  const ageHours = (Date.now() - new Date(video.publishedAt).getTime()) / (1000 * 60 * 60);
  if (ageHours < 24) {
    score += 5;
  } else if (ageHours < 72) {
    score += 2;
  }

  return score;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const guideDate = process.env.GUIDE_DATE || todayDateString();
  const forceOverwrite = process.env.GUIDE_FORCE === "true";
  console.log(`=== Generate Guide ===\n`);
  console.log(`Date: ${guideDate}\n`);

  // Step 3.4: Don't overwrite past guides unless forced
  const guidePath = join(GUIDE_DIR, `${guideDate}.json`);
  const today = todayDateString();
  if (guideDate < today && !forceOverwrite) {
    const exists = await fileExists(guidePath);
    if (exists) {
      console.log(`Guide for ${guideDate} already exists and is in the past.`);
      console.log("Past guides are preserved as historical records.");
      console.log("Set GUIDE_FORCE=true to overwrite.");
      return;
    }
  }

  // Load guide config
  const config = await loadGuideConfig();
  const blocks = config.blocks;
  const bufferMinutes = config.bufferMinutes ?? DEFAULT_BUFFER_MINUTES;
  const defaultDuration = config.defaultDurationMinutes ?? DEFAULT_DURATION_MINUTES;

  // Load all videos
  const videos = await loadJsonFiles<VideoResource>(VIDEOS_DIR);
  if (videos.length === 0) {
    console.log("No video resources found in resources/videos/");
    console.log("Run ingestion first: INGEST_SCOPE=channel:<id> bun run ingest");
    return;
  }

  console.log(`Found ${videos.length} video(s)`);

  // Load channels for title lookup
  const channels = await loadJsonFiles<ChannelResource>(CHANNELS_DIR);
  const channelTitleMap = new Map<string, string>();
  for (const ch of channels) {
    channelTitleMap.set(ch.id, ch.title);
  }

  // Sort videos by publishedAt descending (most recent first)
  videos.sort((a, b) => {
    const da = new Date(a.publishedAt).getTime();
    const db = new Date(b.publishedAt).getTime();
    return db - da;
  });

  // Assign videos to editorial blocks intelligently
  // First, score each video for each block
  const blockAssignments = new Map<string, VideoResource[]>();
  for (const block of blocks) {
    blockAssignments.set(block.name, []);
  }

  // Separate live/premiere videos — they get priority placement
  const liveVideos: VideoResource[] = [];
  const upcomingVideos: VideoResource[] = [];
  const normalVideos: VideoResource[] = [];

  for (const video of videos) {
    if (video.liveBroadcastContent === "live") {
      liveVideos.push(video);
    } else if (video.liveBroadcastContent === "upcoming") {
      upcomingVideos.push(video);
    } else {
      normalVideos.push(video);
    }
  }

  // Assign videos to their best-scoring block
  const assigned = new Set<string>();

  // Live videos get placed first — they go into the current or next block
  for (const video of liveVideos) {
    const bestBlock = blocks.reduce((best, block) =>
      scoreVideoForBlock(video, block, defaultDuration) >
      scoreVideoForBlock(video, best, defaultDuration)
        ? block
        : best
    );
    blockAssignments.get(bestBlock.name)!.push(video);
    assigned.add(video.id);
  }

  // Upcoming/premiere videos placed by their scheduled time or best block
  for (const video of upcomingVideos) {
    const bestBlock = blocks.reduce((best, block) =>
      scoreVideoForBlock(video, block, defaultDuration) >
      scoreVideoForBlock(video, best, defaultDuration)
        ? block
        : best
    );
    blockAssignments.get(bestBlock.name)!.push(video);
    assigned.add(video.id);
  }

  // Normal videos assigned by best score
  for (const video of normalVideos) {
    if (assigned.has(video.id)) continue;
    const bestBlock = blocks.reduce((best, block) =>
      scoreVideoForBlock(video, block, defaultDuration) >
      scoreVideoForBlock(video, best, defaultDuration)
        ? block
        : best
    );
    blockAssignments.get(bestBlock.name)!.push(video);
    assigned.add(video.id);
  }

  // Build guide entries by walking blocks in order and scheduling within each block
  const now = new Date().toISOString();
  const guideEntries: GuideEntry[] = [];

  for (const block of blocks) {
    const blockVideos = blockAssignments.get(block.name) || [];
    if (blockVideos.length === 0) continue;

    // Start time for this block
    const blockStartHour = block.startHour;
    const blockEndHour = block.endHour;
    // Handle next-day hours
    const startDate = new Date(`${guideDate}T00:00:00Z`);
    startDate.setUTCHours(blockStartHour >= 24 ? blockStartHour - 24 : blockStartHour, 0, 0, 0);
    if (blockStartHour >= 24) {
      startDate.setUTCDate(startDate.getUTCDate() + 1);
    }
    const endDate = new Date(`${guideDate}T00:00:00Z`);
    endDate.setUTCHours(blockEndHour >= 24 ? blockEndHour - 24 : blockEndHour, 0, 0, 0);
    if (blockEndHour >= 24) {
      endDate.setUTCDate(endDate.getUTCDate() + 1);
    }

    let currentTime = startDate.getTime();

    for (const video of blockVideos) {
      if (currentTime >= endDate.getTime()) break;

      const scheduledAt = new Date(currentTime);

      const entry: GuideEntry = {
        videoId: video.id,
        channelId: video.channelId,
        title: video.title,
        scheduledAt: scheduledAt.toISOString(),
        block: block.name,
        updatedAt: now,
      };

      const channelTitle = channelTitleMap.get(video.channelId);
      if (channelTitle) entry.channelTitle = channelTitle;
      if (video.duration) entry.duration = video.duration;
      if (video.liveBroadcastContent) entry.liveBroadcastContent = video.liveBroadcastContent;
      if (video.premiereAt) entry.premiereAt = video.premiereAt;

      guideEntries.push(entry);

      // Advance by video duration + buffer
      const durationMin = parseDurationMinutes(video.duration);
      const slotMinutes = Math.max(durationMin + bufferMinutes, defaultDuration);
      currentTime += slotMinutes * 60 * 1000;
    }
  }

  // Write guide file
  await mkdir(GUIDE_DIR, { recursive: true });
  await writeFile(guidePath, JSON.stringify(guideEntries, null, 2) + "\n");

  console.log(`\nGenerated ${guideEntries.length} guide entries`);
  for (const entry of guideEntries) {
    const time = entry.scheduledAt.slice(11, 16);
    const liveTag = entry.liveBroadcastContent === "live" ? " [LIVE]" :
                    entry.liveBroadcastContent === "upcoming" ? " [UPCOMING]" : "";
    console.log(`  ${time} [${entry.block}] ${entry.title}${liveTag}`);
  }
  console.log(`\nWritten to resources/guide/${guideDate}.json`);
}

main();
