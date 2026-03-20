/**
 * build.ts — Build the static site from repository resources
 *
 * Copies site/ shell and injects resource data so GitHub Pages can serve it.
 * Output goes to dist/ which is the publishable artifact.
 */

import { readdir, readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SITE_DIR = join(ROOT, "site");
const RESOURCES_DIR = join(ROOT, "resources");
const DIST_DIR = join(ROOT, "dist");

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

async function main(): Promise<void> {
  console.log("=== Building Station ===\n");

  // Create dist directory
  await mkdir(DIST_DIR, { recursive: true });

  // Copy site shell to dist
  console.log("Copying site shell...");
  await cp(SITE_DIR, DIST_DIR, { recursive: true });

  // Copy resources into dist so the site can load them
  const distResources = join(DIST_DIR, "resources");
  await mkdir(distResources, { recursive: true });
  console.log("Copying resources...");
  await cp(RESOURCES_DIR, distResources, { recursive: true });

  // Generate a resource manifest for the site
  const manifest: Record<string, string[]> = {};
  const resourceDirs = await readdir(RESOURCES_DIR, { withFileTypes: true });
  for (const dir of resourceDirs) {
    if (dir.isDirectory()) {
      const files = await listJsonFiles(join(RESOURCES_DIR, dir.name));
      manifest[dir.name] = files.map((f) =>
        f.replace(RESOURCES_DIR + "/", "")
      );
    }
  }

  const manifestPath = join(distResources, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Generated manifest: ${Object.keys(manifest).length} resource types`);

  console.log("\nBuild complete → dist/");
}

main();
