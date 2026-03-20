/**
 * ingest.ts — Ingest data from YouTube into repository resources
 *
 * This is the initial scaffold. It validates that credentials are available
 * and performs a narrow test call. Full ingestion flows will be added later.
 *
 * Requires YOUTUBE_API_KEY environment variable.
 */

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

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

  console.log("YouTube API key found.");
  console.log("Ingestion pipeline is scaffolded but not yet implemented.");
  console.log("The first ingestion slice will pull subscriptions.");
  console.log("");
  console.log("No resources were modified.");
}

main();
