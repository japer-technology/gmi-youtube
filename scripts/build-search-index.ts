/**
 * build-search-index.ts — Build a static search index from video metadata and transcripts
 *
 * Reads all video resources and available transcripts to produce a lightweight
 * JSON search index. The index is written to dist/search-index.json and loaded
 * by the search page at runtime for client-side keyword search.
 *
 * The index structure:
 * - documents: array of searchable entries (videoId, title, channelTitle, etc.)
 * - terms: inverted index mapping lowercased terms to document indices with scores
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RESOURCES_DIR = join(ROOT, "resources");
const DIST_DIR = join(ROOT, "dist");

interface SearchDocument {
  videoId: string;
  channelId: string;
  title: string;
  channelTitle?: string;
  description?: string;
  publishedAt?: string;
  duration?: string;
  thumbnailUrl?: string;
  tags?: string[];
  hasTranscript: boolean;
  /** Transcript snippet for display (first ~200 chars of full text) */
  transcriptSnippet?: string;
  /** Transcript segments with timestamps for deep linking */
  transcriptSegments?: { start: number; text: string }[];
}

interface SearchIndex {
  documents: SearchDocument[];
  terms: Record<string, { doc: number; score: number }[]>;
  generatedAt: string;
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Stop words to exclude from the index to keep it compact */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "this", "that", "was", "are",
  "be", "has", "have", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "not", "no", "so",
  "if", "as", "its", "he", "she", "they", "we", "you", "my", "your",
  "his", "her", "our", "their", "am", "been", "being", "were", "what",
  "which", "who", "whom", "how", "when", "where", "why", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "than",
  "too", "very", "just", "about", "also", "into", "over", "after",
]);

async function main(): Promise<void> {
  console.log("=== Building Search Index ===\n");

  // Load all video resources
  const videoFiles = await listJsonFiles(join(RESOURCES_DIR, "videos"));
  console.log(`Found ${videoFiles.length} video resource${videoFiles.length === 1 ? "" : "s"}`);

  // Load all channel resources for title lookup
  const channelFiles = await listJsonFiles(join(RESOURCES_DIR, "channels"));
  const channelMap: Record<string, string> = {};
  for (const file of channelFiles) {
    try {
      const data = JSON.parse(await readFile(file, "utf-8"));
      if (data.id && data.title) channelMap[data.id] = data.title;
    } catch { /* skip invalid */ }
  }

  // Load all transcripts
  const transcriptFiles = await listJsonFiles(join(RESOURCES_DIR, "transcripts"));
  const transcriptMap: Record<string, { fullText: string; segments: { start: number; text: string }[] }> = {};
  for (const file of transcriptFiles) {
    try {
      const data = JSON.parse(await readFile(file, "utf-8"));
      if (data.videoId) {
        transcriptMap[data.videoId] = {
          fullText: data.fullText || "",
          segments: (data.segments || []).map((s: { start: number; text: string }) => ({
            start: s.start,
            text: s.text,
          })),
        };
      }
    } catch { /* skip invalid */ }
  }
  console.log(`Found ${Object.keys(transcriptMap).length} transcript${Object.keys(transcriptMap).length === 1 ? "" : "s"}`);

  // Build search documents
  const documents: SearchDocument[] = [];
  for (const file of videoFiles) {
    try {
      const video = JSON.parse(await readFile(file, "utf-8"));
      const videoId = video.id as string;
      const transcript = transcriptMap[videoId];

      const doc: SearchDocument = {
        videoId,
        channelId: video.channelId || "",
        title: video.title || "",
        channelTitle: channelMap[video.channelId] || undefined,
        description: video.description || undefined,
        publishedAt: video.publishedAt || undefined,
        duration: video.duration || undefined,
        thumbnailUrl: video.thumbnailUrl || undefined,
        tags: video.tags || undefined,
        hasTranscript: !!transcript,
      };

      if (transcript) {
        doc.transcriptSnippet = transcript.fullText.slice(0, 200);
        // Store segments for timestamp linking (limit to keep index compact)
        doc.transcriptSegments = transcript.segments.slice(0, 500);
      }

      documents.push(doc);
    } catch { /* skip invalid */ }
  }

  console.log(`Indexed ${documents.length} document${documents.length === 1 ? "" : "s"}`);

  // Build inverted index
  const terms: Record<string, { doc: number; score: number }[]> = {};

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const termScores: Record<string, number> = {};

    // Title terms: high weight (score 10)
    for (const term of tokenize(doc.title)) {
      if (!STOP_WORDS.has(term)) {
        termScores[term] = (termScores[term] || 0) + 10;
      }
    }

    // Channel title: medium-high weight (score 5)
    if (doc.channelTitle) {
      for (const term of tokenize(doc.channelTitle)) {
        if (!STOP_WORDS.has(term)) {
          termScores[term] = (termScores[term] || 0) + 5;
        }
      }
    }

    // Tags: medium weight (score 4)
    if (doc.tags) {
      for (const tag of doc.tags) {
        for (const term of tokenize(tag)) {
          if (!STOP_WORDS.has(term)) {
            termScores[term] = (termScores[term] || 0) + 4;
          }
        }
      }
    }

    // Description: low weight (score 1)
    if (doc.description) {
      for (const term of tokenize(doc.description)) {
        if (!STOP_WORDS.has(term)) {
          termScores[term] = (termScores[term] || 0) + 1;
        }
      }
    }

    // Transcript: low weight (score 1 per occurrence, capped)
    if (doc.transcriptSegments) {
      for (const seg of doc.transcriptSegments) {
        for (const term of tokenize(seg.text)) {
          if (!STOP_WORDS.has(term)) {
            termScores[term] = Math.min((termScores[term] || 0) + 1, 50);
          }
        }
      }
    }

    // Add to inverted index
    for (const [term, score] of Object.entries(termScores)) {
      if (!terms[term]) terms[term] = [];
      terms[term].push({ doc: i, score });
    }
  }

  console.log(`Index contains ${Object.keys(terms).length} unique terms`);

  // Write index
  const index: SearchIndex = {
    documents,
    terms,
    generatedAt: new Date().toISOString(),
  };

  await mkdir(DIST_DIR, { recursive: true });
  const indexPath = join(DIST_DIR, "search-index.json");
  await writeFile(indexPath, JSON.stringify(index));
  const sizeKB = Math.round(JSON.stringify(index).length / 1024);
  console.log(`\nSearch index written → dist/search-index.json (${sizeKB} KB)`);
}

main();
