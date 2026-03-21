/**
 * generate-receipt.ts — Generate a viewing receipt from guide and video data
 *
 * Reads the guide for a given period (day or week), compares guide entries
 * against video resources, and produces a receipt summarising what arrived,
 * what was featured, and what was skipped.
 *
 * Environment variables:
 *   RECEIPT_DATE   — Target date in YYYY-MM-DD format (default: yesterday)
 *   RECEIPT_PERIOD — "day" or "week" (default: "day")
 *   RECEIPT_FORCE  — Set to "true" to overwrite existing receipts
 */

import { readdir, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESOURCES_DIR = join(ROOT, "resources");
const VIDEOS_DIR = join(RESOURCES_DIR, "videos");
const CHANNELS_DIR = join(RESOURCES_DIR, "channels");
const GUIDE_DIR = join(RESOURCES_DIR, "guide");
const RECEIPTS_DIR = join(RESOURCES_DIR, "receipts");

interface VideoResource {
  id: string;
  channelId: string;
  title: string;
  publishedAt: string;
  duration?: string;
  liveBroadcastContent?: string;
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
  block?: string;
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

function yesterdayDateString(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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

async function loadGuide(dateStr: string): Promise<GuideEntry[]> {
  const guidePath = join(GUIDE_DIR, `${dateStr}.json`);
  try {
    const text = await readFile(guidePath, "utf-8");
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data as GuideEntry[];
  } catch {
    // Guide not available for this date
  }
  return [];
}

function parseDurationMinutes(isoDuration?: string): number {
  if (!isoDuration) return 0;
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 60 + minutes + Math.ceil(seconds / 60);
}

function buildCuratorNotes(
  arrived: ReceiptVideo[],
  skipped: ReceiptVideo[],
  channelDist: Record<string, number>,
  totalDuration: number,
  period: string,
  dateStr: string
): string {
  const parts: string[] = [];

  if (period === "week") {
    parts.push(`Weekly summary for the week ending ${dateStr}.`);
  } else {
    parts.push(`Daily summary for ${dateStr}.`);
  }

  if (arrived.length === 0) {
    parts.push("No new content arrived during this period.");
  } else if (arrived.length === 1) {
    parts.push(`One new video arrived and was featured in the guide.`);
  } else {
    parts.push(`${arrived.length} videos arrived and were featured in the guide.`);
  }

  if (totalDuration > 0) {
    const hours = Math.floor(totalDuration / 60);
    const mins = totalDuration % 60;
    if (hours > 0) {
      parts.push(`Total scheduled duration: ${hours}h ${mins}m.`);
    } else {
      parts.push(`Total scheduled duration: ${mins}m.`);
    }
  }

  const channelCount = Object.keys(channelDist).length;
  if (channelCount > 0) {
    parts.push(`Content spanned ${channelCount} channel${channelCount > 1 ? "s" : ""}.`);
  }

  if (skipped.length > 0) {
    parts.push(`${skipped.length} available video${skipped.length > 1 ? "s were" : " was"} not featured in the guide.`);
  }

  return parts.join(" ");
}

async function main(): Promise<void> {
  const receiptDate = process.env.RECEIPT_DATE || yesterdayDateString();
  const period = process.env.RECEIPT_PERIOD || "day";
  const forceOverwrite = process.env.RECEIPT_FORCE === "true";

  console.log("=== Generate Receipt ===\n");
  console.log(`Date:   ${receiptDate}`);
  console.log(`Period: ${period}\n`);

  // Determine receipt ID and date range
  const receiptId = period === "week"
    ? `receipt-${receiptDate}-week`
    : `receipt-${receiptDate}`;

  const receiptPath = join(RECEIPTS_DIR, `${receiptId}.json`);

  // Don't overwrite existing receipts unless forced
  if (!forceOverwrite && await fileExists(receiptPath)) {
    console.log(`Receipt ${receiptId} already exists.`);
    console.log("Set RECEIPT_FORCE=true to overwrite.");
    return;
  }

  // Determine period boundaries
  const periodStart = period === "week"
    ? shiftDate(receiptDate, -6) + "T00:00:00Z"
    : receiptDate + "T00:00:00Z";
  const periodEnd = receiptDate + "T23:59:59Z";

  // Collect guide dates for the period
  const guideDates: string[] = [];
  if (period === "week") {
    for (let i = -6; i <= 0; i++) {
      guideDates.push(shiftDate(receiptDate, i));
    }
  } else {
    guideDates.push(receiptDate);
  }

  // Load all guide entries for the period
  const allGuideEntries: GuideEntry[] = [];
  for (const dateStr of guideDates) {
    const entries = await loadGuide(dateStr);
    allGuideEntries.push(...entries);
  }

  console.log(`Found ${allGuideEntries.length} guide entries across ${guideDates.length} day(s)`);

  // Load all video resources
  const videos = await loadJsonFiles<VideoResource>(VIDEOS_DIR);
  const videoMap = new Map<string, VideoResource>();
  for (const v of videos) {
    videoMap.set(v.id, v);
  }

  // Load channel titles
  const channels = await loadJsonFiles<ChannelResource>(CHANNELS_DIR);
  const channelTitleMap = new Map<string, string>();
  for (const ch of channels) {
    channelTitleMap.set(ch.id, ch.title);
  }

  // Identify videos that arrived during the period (published within the date range)
  const periodStartTime = new Date(periodStart).getTime();
  const periodEndTime = new Date(periodEnd).getTime();

  const arrivedVideos: VideoResource[] = videos.filter((v) => {
    const pub = new Date(v.publishedAt).getTime();
    return pub >= periodStartTime && pub <= periodEndTime;
  });

  // Build the "arrived" list — videos published during the period
  const arrived: ReceiptVideo[] = arrivedVideos.map((v) => ({
    videoId: v.id,
    title: v.title,
    channelTitle: channelTitleMap.get(v.channelId),
  }));

  // Build the "featured" set — videos that appeared in the guide
  const featuredVideoIds = new Set(allGuideEntries.map((e) => e.videoId));

  // "skipped" = arrived but not featured in the guide
  const skipped: ReceiptVideo[] = arrivedVideos
    .filter((v) => !featuredVideoIds.has(v.id))
    .map((v) => ({
      videoId: v.id,
      title: v.title,
      channelTitle: channelTitleMap.get(v.channelId),
    }));

  // Watch signals are not yet available from the API.
  // For now, featured guide entries count as the curated set.
  // The watched array starts empty until watch tracking is implemented.
  const watched: ReceiptVideo[] = [];

  // Compute stats
  const channelDistribution: Record<string, number> = {};
  let totalDurationMinutes = 0;

  for (const entry of allGuideEntries) {
    const channelName = entry.channelTitle || channelTitleMap.get(entry.channelId) || entry.channelId;
    channelDistribution[channelName] = (channelDistribution[channelName] || 0) + 1;
    totalDurationMinutes += parseDurationMinutes(entry.duration);
  }

  const stats: ReceiptStats = {
    totalWatched: watched.length,
    totalArrived: arrived.length,
    totalSkipped: skipped.length,
    totalDurationMinutes,
    channelDistribution,
  };

  // Generate curator notes
  const curatorNotes = buildCuratorNotes(
    arrived,
    skipped,
    channelDistribution,
    totalDurationMinutes,
    period,
    receiptDate
  );

  // Build the receipt
  const receipt: ViewingReceipt = {
    id: receiptId,
    periodStart,
    periodEnd,
    generatedAt: new Date().toISOString(),
    watched,
    arrived,
    skipped,
    curatorNotes,
    stats,
  };

  // Write receipt
  await mkdir(RECEIPTS_DIR, { recursive: true });
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

  console.log(`\nReceipt: ${receiptId}`);
  console.log(`Period:  ${periodStart} → ${periodEnd}`);
  console.log(`Arrived: ${arrived.length} video(s)`);
  console.log(`Skipped: ${skipped.length} video(s)`);
  console.log(`Featured in guide: ${allGuideEntries.length} entries`);
  console.log(`Total duration: ${totalDurationMinutes} minutes`);
  console.log(`Channels: ${Object.keys(channelDistribution).length}`);
  console.log(`\nWritten to resources/receipts/${receiptId}.json`);
}

main();
