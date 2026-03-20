/**
 * publish.ts — Publish the station site
 *
 * Runs the build and reports what would be deployed.
 * In CI, the actual deployment is handled by the publish workflow.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST_DIR = join(ROOT, "dist");

async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countFiles(join(dir, entry.name));
      } else {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  console.log("=== Station Publish ===\n");

  // Check if dist exists
  try {
    await stat(DIST_DIR);
  } catch {
    console.log("dist/ directory not found. Run 'bun run build' first.");
    process.exit(1);
  }

  const fileCount = await countFiles(DIST_DIR);
  console.log(`dist/ contains ${fileCount} files ready for deployment.`);
  console.log("");
  console.log("In CI, the publish workflow deploys dist/ to GitHub Pages.");
  console.log("Locally, you can preview with: cd dist && python3 -m http.server 8000");
}

main();
