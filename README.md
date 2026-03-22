### [GitHub Minimum Intelligence plus YouTube](.github-minimum-intelligence/README.md)

#### READ THIS [.github-minimum-intelligence/README.md](.github-minimum-intelligence/README.md)

## How To...

This repository turns YouTube data into a personal TV station that is built, curated, and published from GitHub.

### How to set it up

1. Install [Bun](https://bun.sh/).
2. Add `YOUTUBE_API_KEY` when you want to ingest live YouTube data.
3. Add `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REFRESH_TOKEN` when you want subscription syncing or transcript downloads.
4. Review [OPERATIONS.md](OPERATIONS.md) before running commands that write to `resources/`.

### How to validate and build

```bash
bun run check
bun run build
```

- `bun run check` validates schemas, resources, fixtures, and site pages.
- `bun run build` copies the static site into `dist/` and generates the search index.

### How to ingest fresh YouTube data

```bash
export YOUTUBE_API_KEY=your-api-key
bun run ingest
```

Optional ingestion flags:

- `INGEST_CAPTIONS=true` fetches caption track metadata.
- `INGEST_TRANSCRIPTS=true` downloads transcripts and requires OAuth credentials.

### How to generate station outputs

```bash
bun run generate-guide
bun run generate-receipt
```

- Set `GUIDE_DATE=YYYY-MM-DD` to build a guide for a specific date.
- Set `RECEIPT_DATE=YYYY-MM-DD`, `RECEIPT_PERIOD=day|week`, and `RECEIPT_FORCE=true` when generating receipts.

### How to use the curator

```bash
CURATOR_ACTION=buildGuide CURATOR_PARAMS='{}' bun run curator
```

Common actions include `buildGuide`, `updateWallLayout`, `recommendContent`, `summarizeChannel`, `generateReceipt`, `flagContent`, `answerQuestion`, `searchContent`, and `learnFromReceipts`.

### How to publish

```bash
bun run publish
```

For the full AI-agent framework, read [.github-minimum-intelligence/README.md](.github-minimum-intelligence/README.md). For credentials, quota, and write-safety details, read [OPERATIONS.md](OPERATIONS.md).

<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/japer-technology/gmi-youtube/main/GitHub-YouTube.png" alt="Minimum Intelligence with YouTube" width="500">
  </picture>
</p>
