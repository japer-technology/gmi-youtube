/**
 * generate-guide.ts — Generate a TV guide from ingested video resources
 *
 * Reads all video resources, sorts by publishedAt, assigns scheduledAt
 * timestamps across editorial blocks, and writes a guide for the target date.
 *
 * Reads GUIDE_DATE environment variable (default: today in YYYY-MM-DD format).
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESOURCES_DIR = join(ROOT, "resources");
const VIDEOS_DIR = join(RESOURCES_DIR, "videos");
const CHANNELS_DIR = join(RESOURCES_DIR, "channels");
const GUIDE_DIR = join(RESOURCES_DIR, "guide");

interface VideoResource {
  id: string;
  channelId: string;
  title: string;
  publishedAt: string;
  duration?: string;
  liveBroadcastContent?: string;
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
  block: string;
  updatedAt: string;
}

interface EditorialBlock {
  name: string;
  startHour: number;
  endHour: number;
}

const EDITORIAL_BLOCKS: EditorialBlock[] = [
  { name: "morning", startHour: 6, endHour: 10 },
  { name: "midday", startHour: 10, endHour: 14 },
  { name: "afternoon", startHour: 14, endHour: 18 },
  { name: "evening", startHour: 18, endHour: 22 },
  { name: "late", startHour: 22, endHour: 26 }, // 26 = 02:00 next day
];

function blockForHour(hour: number): string {
  // Normalize hour past midnight (e.g., 1 → 25 for comparison)
  const h = hour < 6 ? hour + 24 : hour;
  for (const block of EDITORIAL_BLOCKS) {
    if (h >= block.startHour && h < block.endHour) {
      return block.name;
    }
  }
  return "late";
}

function parseDurationMinutes(isoDuration?: string): number {
  if (!isoDuration) return 30; // default to 30 min if unknown
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 30;
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

async function main(): Promise<void> {
  const guideDate = process.env.GUIDE_DATE || todayDateString();
  console.log(`=== Generate Guide ===\n`);
  console.log(`Date: ${guideDate}\n`);

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

  // Assign scheduledAt timestamps across the day
  // Start at 06:00 and space by video duration plus a 15-minute buffer
  const baseDate = new Date(`${guideDate}T06:00:00Z`);
  const endOfDay = new Date(`${guideDate}T23:59:59Z`);
  let currentTime = baseDate.getTime();
  const now = new Date().toISOString();

  const guideEntries: GuideEntry[] = [];

  for (const video of videos) {
    if (currentTime > endOfDay.getTime()) break;

    const scheduledAt = new Date(currentTime);
    const hour = scheduledAt.getUTCHours();

    const entry: GuideEntry = {
      videoId: video.id,
      channelId: video.channelId,
      title: video.title,
      scheduledAt: scheduledAt.toISOString(),
      block: blockForHour(hour),
      updatedAt: now,
    };

    const channelTitle = channelTitleMap.get(video.channelId);
    if (channelTitle) entry.channelTitle = channelTitle;
    if (video.duration) entry.duration = video.duration;
    if (video.liveBroadcastContent) entry.liveBroadcastContent = video.liveBroadcastContent;

    guideEntries.push(entry);

    // Advance by video duration + 15-minute buffer (minimum 30 minutes)
    const durationMin = parseDurationMinutes(video.duration);
    const slotMinutes = Math.max(durationMin + 15, 30);
    currentTime += slotMinutes * 60 * 1000;
  }

  // Write guide file
  await mkdir(GUIDE_DIR, { recursive: true });
  const guidePath = join(GUIDE_DIR, `${guideDate}.json`);
  await writeFile(guidePath, JSON.stringify(guideEntries, null, 2) + "\n");

  console.log(`\nGenerated ${guideEntries.length} guide entries`);
  for (const entry of guideEntries) {
    const time = entry.scheduledAt.slice(11, 16);
    console.log(`  ${time} [${entry.block}] ${entry.title}`);
  }
  console.log(`\nWritten to resources/guide/${guideDate}.json`);
}

main();
