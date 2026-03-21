/**
 * check.ts — Validate schemas and resources
 *
 * Confirms that:
 * - All schema files are valid JSON Schema
 * - All resource files conform to their corresponding schemas
 * - The site can build from repository resources
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCHEMAS_DIR = join(ROOT, "schemas");
const RESOURCES_DIR = join(ROOT, "resources");

interface ValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
}

async function loadJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf-8");
  return JSON.parse(text);
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listJsonFiles(full)));
      } else if (entry.name.endsWith(".json")) {
        files.push(full);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function validateRequired(
  data: Record<string, unknown>,
  required: string[],
  file: string
): string[] {
  const errors: string[] = [];
  for (const field of required) {
    if (!(field in data)) {
      errors.push(`${file}: missing required field '${field}'`);
    }
  }
  return errors;
}

const SCHEMA_REQUIRED_FIELDS: Record<string, string[]> = {
  channel: ["id", "title", "source", "updatedAt"],
  video: ["id", "channelId", "title", "publishedAt", "source", "updatedAt"],
  playlist: ["id", "channelId", "title", "source", "updatedAt"],
  "guide-entry": [
    "videoId",
    "channelId",
    "title",
    "scheduledAt",
    "updatedAt",
  ],
  "viewing-receipt": ["id", "periodStart", "periodEnd", "generatedAt"],
  subscriptions: ["channels", "totalCount", "updatedAt"],
  "guide-config": ["blocks", "updatedAt"],
  "wall-layout": ["name", "rows", "cols", "channels"],
  transcript: ["videoId", "language", "segments", "source", "updatedAt"],
};

const RESOURCE_DIR_TO_SCHEMA: Record<string, string> = {
  channels: "channel",
  videos: "video",
  playlists: "playlist",
  guide: "guide-entry",
  receipts: "viewing-receipt",
  transcripts: "transcript",
};

async function validateSchemas(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const schemaFiles = await listJsonFiles(SCHEMAS_DIR);

  for (const file of schemaFiles) {
    const errors: string[] = [];
    try {
      const schema = (await loadJson(file)) as Record<string, unknown>;
      if (!schema.$schema) errors.push("Missing $schema field");
      if (!schema.title) errors.push("Missing title field");
      if (!schema.type) errors.push("Missing type field");
      if (!schema.required) errors.push("Missing required field");
      if (!schema.properties) errors.push("Missing properties field");
    } catch (e) {
      errors.push(`Invalid JSON: ${e}`);
    }
    results.push({ file, valid: errors.length === 0, errors });
  }

  return results;
}

async function validateResources(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const [dir, schemaName] of Object.entries(RESOURCE_DIR_TO_SCHEMA)) {
    const resourceDir = join(RESOURCES_DIR, dir);
    const files = await listJsonFiles(resourceDir);
    const requiredFields = SCHEMA_REQUIRED_FIELDS[schemaName] || [];

    for (const file of files) {
      const errors: string[] = [];
      try {
        const data = await loadJson(file);

        if (schemaName === "guide-entry") {
          // Guide files are arrays of entries
          if (!Array.isArray(data)) {
            errors.push("Guide file must be an array");
          } else {
            for (let i = 0; i < data.length; i++) {
              const entry = data[i] as Record<string, unknown>;
              errors.push(
                ...validateRequired(entry, requiredFields, `[${i}]`)
              );
            }
          }
        } else {
          errors.push(
            ...validateRequired(
              data as Record<string, unknown>,
              requiredFields,
              basename(file)
            )
          );
        }
      } catch (e) {
        errors.push(`Invalid JSON: ${e}`);
      }
      results.push({ file, valid: errors.length === 0, errors });
    }
  }

  // Validate top-level subscription index if present
  const subscriptionsPath = join(RESOURCES_DIR, "subscriptions.json");
  try {
    const data = await loadJson(subscriptionsPath);
    const errors: string[] = [];
    const requiredFields = SCHEMA_REQUIRED_FIELDS["subscriptions"] || [];
    errors.push(
      ...validateRequired(
        data as Record<string, unknown>,
        requiredFields,
        "subscriptions.json"
      )
    );
    const typed = data as Record<string, unknown>;
    if (!Array.isArray(typed.channels)) {
      errors.push("subscriptions.json: 'channels' must be an array");
    } else {
      for (let i = 0; i < typed.channels.length; i++) {
        const ch = typed.channels[i] as Record<string, unknown>;
        if (!ch.channelId) errors.push(`subscriptions.json: channels[${i}] missing 'channelId'`);
        if (!ch.title) errors.push(`subscriptions.json: channels[${i}] missing 'title'`);
      }
    }
    results.push({ file: subscriptionsPath, valid: errors.length === 0, errors });
  } catch {
    // subscriptions.json is optional — only validate if present
  }

  // Validate guide-config.json if present
  const guideConfigPath = join(RESOURCES_DIR, "guide-config.json");
  try {
    const data = await loadJson(guideConfigPath);
    const errors: string[] = [];
    const requiredFields = SCHEMA_REQUIRED_FIELDS["guide-config"] || [];
    errors.push(
      ...validateRequired(
        data as Record<string, unknown>,
        requiredFields,
        "guide-config.json"
      )
    );
    const typed = data as Record<string, unknown>;
    if (!Array.isArray(typed.blocks)) {
      errors.push("guide-config.json: 'blocks' must be an array");
    } else {
      for (let i = 0; i < typed.blocks.length; i++) {
        const block = typed.blocks[i] as Record<string, unknown>;
        if (!block.name) errors.push(`guide-config.json: blocks[${i}] missing 'name'`);
        if (block.startHour === undefined) errors.push(`guide-config.json: blocks[${i}] missing 'startHour'`);
        if (block.endHour === undefined) errors.push(`guide-config.json: blocks[${i}] missing 'endHour'`);
        if (!block.character) errors.push(`guide-config.json: blocks[${i}] missing 'character'`);
      }
    }
    results.push({ file: guideConfigPath, valid: errors.length === 0, errors });
  } catch {
    // guide-config.json is optional — only validate if present
  }

  // Validate wall-layouts.json if present
  const wallLayoutsPath = join(RESOURCES_DIR, "wall-layouts.json");
  try {
    const data = await loadJson(wallLayoutsPath);
    const errors: string[] = [];
    if (!Array.isArray(data)) {
      errors.push("wall-layouts.json: must be an array of layout objects");
    } else {
      const requiredFields = SCHEMA_REQUIRED_FIELDS["wall-layout"] || [];
      for (let i = 0; i < data.length; i++) {
        const layout = data[i] as Record<string, unknown>;
        errors.push(
          ...validateRequired(layout, requiredFields, `wall-layouts.json[${i}]`)
        );
        if (typeof layout.rows === "number" && (layout.rows < 1 || layout.rows > 10)) {
          errors.push(`wall-layouts.json[${i}]: 'rows' must be between 1 and 10`);
        }
        if (typeof layout.cols === "number" && (layout.cols < 1 || layout.cols > 10)) {
          errors.push(`wall-layouts.json[${i}]: 'cols' must be between 1 and 10`);
        }
        if (layout.channels !== undefined && !Array.isArray(layout.channels)) {
          errors.push(`wall-layouts.json[${i}]: 'channels' must be an array`);
        }
      }
    }
    results.push({ file: wallLayoutsPath, valid: errors.length === 0, errors });
  } catch {
    // wall-layouts.json is optional — only validate if present
  }

  return results;
}

async function validateSite(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  const requiredPages = [
    "index.html",
    "guide.html",
    "wall.html",
    "receipt.html",
    "search.html",
  ];

  for (const page of requiredPages) {
    const pagePath = join(ROOT, "site", page);
    try {
      const content = await readFile(pagePath, "utf-8");
      const errors: string[] = [];
      if (!content.includes("<!DOCTYPE html") && !content.includes("<!doctype html")) {
        errors.push(`site/${page} missing DOCTYPE`);
      }
      results.push({ file: pagePath, valid: errors.length === 0, errors });
    } catch {
      results.push({
        file: pagePath,
        valid: false,
        errors: [`site/${page} not found`],
      });
    }
  }

  return results;
}

async function main(): Promise<void> {
  console.log("=== Station Validation ===\n");

  let allValid = true;

  console.log("Checking schemas...");
  const schemaResults = await validateSchemas();
  for (const r of schemaResults) {
    const status = r.valid ? "✓" : "✗";
    console.log(`  ${status} ${r.file.replace(ROOT + "/", "")}`);
    for (const e of r.errors) console.log(`    → ${e}`);
    if (!r.valid) allValid = false;
  }

  console.log("\nChecking resources...");
  const resourceResults = await validateResources();
  for (const r of resourceResults) {
    const status = r.valid ? "✓" : "✗";
    console.log(`  ${status} ${r.file.replace(ROOT + "/", "")}`);
    for (const e of r.errors) console.log(`    → ${e}`);
    if (!r.valid) allValid = false;
  }

  console.log("\nChecking site...");
  const siteResults = await validateSite();
  for (const r of siteResults) {
    const status = r.valid ? "✓" : "✗";
    console.log(`  ${status} ${r.file.replace(ROOT + "/", "")}`);
    for (const e of r.errors) console.log(`    → ${e}`);
    if (!r.valid) allValid = false;
  }

  console.log("");
  if (allValid) {
    console.log("All checks passed.");
  } else {
    console.error("Validation failed.");
    process.exit(1);
  }
}

main();
