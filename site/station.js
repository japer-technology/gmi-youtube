/**
 * station.js — Lightweight resource loader for the Station static site
 *
 * Loads JSON resources from the resources/ directory and renders them
 * into the appropriate page sections.
 *
 * The guide page renders a block-based time grid with:
 * - Rows representing editorial blocks (morning, midday, afternoon, evening, late)
 * - Time slots within each block
 * - Current time highlighting
 * - Live and upcoming visual indicators
 * - Date navigation for guide history
 */

(function () {
  "use strict";

  var BASE = "resources/";

  function fetchJson(path) {
    return fetch(BASE + path).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).catch(function () {
      return null;
    });
  }

  function formatTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (_e) {
      return "";
    }
  }

  function formatDuration(iso) {
    if (!iso) return "";
    var match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return iso;
    var parts = [];
    if (match[1]) parts.push(match[1] + "h");
    if (match[2]) parts.push(match[2] + "m");
    if (match[3]) parts.push(match[3] + "s");
    return parts.join(" ");
  }

  function liveBadge(state) {
    if (state === "live") return '<span class="badge live">LIVE</span>';
    if (state === "upcoming") return '<span class="badge upcoming">UPCOMING</span>';
    return "";
  }

  function todayDateString() {
    var d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function shiftDate(dateStr, days) {
    var d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function formatDateLabel(dateStr) {
    var today = todayDateString();
    var d = new Date(dateStr + "T12:00:00Z");
    var label = d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    if (dateStr === today) {
      label = "Today — " + label;
    } else if (dateStr === shiftDate(today, -1)) {
      label = "Yesterday — " + label;
    } else if (dateStr === shiftDate(today, 1)) {
      label = "Tomorrow — " + label;
    }
    return label;
  }

  /**
   * Check if a guide entry is currently airing based on scheduledAt and duration
   */
  function isCurrentlyAiring(entry) {
    var now = Date.now();
    var start = new Date(entry.scheduledAt).getTime();
    if (isNaN(start)) return false;

    // Parse duration or use 30 min default
    var durationMs = 30 * 60 * 1000;
    if (entry.duration) {
      var match = entry.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (match) {
        var h = parseInt(match[1] || "0", 10);
        var m = parseInt(match[2] || "0", 10);
        var s = parseInt(match[3] || "0", 10);
        durationMs = (h * 3600 + m * 60 + s) * 1000;
      }
    }

    return now >= start && now < start + durationMs;
  }

  /**
   * Check if a guide entry is in the past
   */
  function isInPast(entry) {
    var now = Date.now();
    var start = new Date(entry.scheduledAt).getTime();
    if (isNaN(start)) return false;

    var durationMs = 30 * 60 * 1000;
    if (entry.duration) {
      var match = entry.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (match) {
        var h = parseInt(match[1] || "0", 10);
        var m = parseInt(match[2] || "0", 10);
        var s = parseInt(match[3] || "0", 10);
        durationMs = (h * 3600 + m * 60 + s) * 1000;
      }
    }

    return now >= start + durationMs;
  }

  /**
   * Default editorial block definitions (used when guide-config.json is unavailable)
   */
  var DEFAULT_BLOCKS = [
    { name: "morning", startHour: 6, endHour: 10, character: "Short-form, news, briefings" },
    { name: "midday", startHour: 10, endHour: 14, character: "Medium-form, tutorials, talks" },
    { name: "afternoon", startHour: 14, endHour: 18, character: "Long-form, documentaries, deep dives" },
    { name: "evening", startHour: 18, endHour: 22, character: "Flagship content, curated highlights" },
    { name: "late", startHour: 22, endHour: 26, character: "Calm, ambient, rewatchable" }
  ];

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Render guide entries as a block-based time grid
   */
  function renderGuideTimeGrid(entries, blocks, container) {
    if (!entries || entries.length === 0) {
      container.innerHTML = '<p class="placeholder">No guide entries available for this date.</p>';
      return;
    }

    // Group entries by block
    var blockMap = {};
    for (var i = 0; i < blocks.length; i++) {
      blockMap[blocks[i].name] = [];
    }

    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      var blockName = entry.block || "late";
      if (!blockMap[blockName]) {
        blockMap[blockName] = [];
      }
      blockMap[blockName].push(entry);
    }

    var html = '<div class="guide-time-grid">';

    for (var k = 0; k < blocks.length; k++) {
      var block = blocks[k];
      var blockEntries = blockMap[block.name] || [];
      var startLabel = (block.startHour % 24).toString().padStart(2, "0") + ":00";
      var endHour = block.endHour >= 24 ? block.endHour - 24 : block.endHour;
      var endLabel = endHour.toString().padStart(2, "0") + ":00";

      html += '<div class="guide-block">';
      html += '<div class="guide-block-header">';
      html += '<h3 class="guide-block-name">' + capitalize(block.name) + '</h3>';
      html += '<span class="guide-block-time">' + startLabel + ' – ' + endLabel + '</span>';
      if (block.character) {
        html += '<span class="guide-block-character">' + block.character + '</span>';
      }
      html += '</div>';

      if (blockEntries.length === 0) {
        html += '<div class="guide-block-empty"><p class="placeholder">No content scheduled</p></div>';
      } else {
        html += '<div class="guide-block-entries">';
        for (var m = 0; m < blockEntries.length; m++) {
          var e = blockEntries[m];
          var airing = isCurrentlyAiring(e);
          var past = !airing && isInPast(e);
          var entryClass = "card guide-entry";
          if (airing) entryClass += " now-airing";
          if (past) entryClass += " past";
          if (e.liveBroadcastContent === "live") entryClass += " is-live";
          if (e.liveBroadcastContent === "upcoming") entryClass += " is-upcoming";

          html += '<div class="' + entryClass + '">';
          html += '<span class="time">' + formatTime(e.scheduledAt) + '</span>';
          html += '<div class="guide-entry-content">';
          html += '<h4><a href="https://www.youtube.com/watch?v=' + encodeURIComponent(e.videoId) + '" target="_blank" rel="noopener">';
          html += e.title + '</a>' + liveBadge(e.liveBroadcastContent);
          if (airing) html += '<span class="badge now">NOW</span>';
          html += '</h4>';
          html += '<span class="meta">';
          html += (e.channelTitle || "");
          if (e.duration) html += " · " + formatDuration(e.duration);
          if (e.premiereAt) {
            html += ' · Premiere: ' + formatTime(e.premiereAt);
          }
          html += '</span>';
          html += '</div></div>';
        }
        html += '</div>';
      }

      html += '</div>';
    }

    html += '</div>';
    container.innerHTML = html;
  }

  function renderGuidePreview(entries, container) {
    if (!entries || entries.length === 0) {
      container.innerHTML = '<p class="placeholder">No guide entries available.</p>';
      return;
    }
    var html = entries.slice(0, 5).map(function (e) {
      var airing = isCurrentlyAiring(e);
      var entryClass = "card guide-entry";
      if (airing) entryClass += " now-airing";

      return '<div class="' + entryClass + '">' +
        '<span class="time">' + formatTime(e.scheduledAt) + '</span>' +
        '<div>' +
        '<h3><a href="https://www.youtube.com/watch?v=' + encodeURIComponent(e.videoId) + '" target="_blank" rel="noopener">' +
        e.title + '</a>' + liveBadge(e.liveBroadcastContent) +
        (airing ? '<span class="badge now">NOW</span>' : '') +
        '</h3>' +
        '<span class="meta">' + (e.channelTitle || "") +
        (e.duration ? " · " + formatDuration(e.duration) : "") +
        (e.block ? " · " + e.block : "") +
        '</span>' +
        '</div></div>';
    });
    container.innerHTML = html.join("");
  }

  function renderChannelList(channels, container) {
    if (!channels || channels.length === 0) {
      container.innerHTML = '<p class="placeholder">No channels tracked yet.</p>';
      return;
    }
    var html = channels.map(function (c) {
      return '<div class="card">' +
        '<h3>' + c.title + '</h3>' +
        '<span class="meta">' +
        (c.customUrl || "") +
        (c.videoCount ? " · " + c.videoCount + " videos" : "") +
        '</span>' +
        (c.description ? '<p style="margin-top:0.5rem;font-size:0.9rem">' + c.description + '</p>' : '') +
        '</div>';
    });
    container.innerHTML = html.join("");
  }

  function renderChannelWall(channels, container) {
    if (!channels || channels.length === 0) {
      container.innerHTML = '<p class="placeholder">No channels available for the wall.</p>';
      return;
    }
    var cols = Math.min(channels.length, 3);
    var html = '<div class="channel-wall" style="grid-template-columns: repeat(' + cols + ', 1fr)">';
    html += channels.map(function (c) {
      return '<div class="card">' +
        '<h3>' + c.title + '</h3>' +
        '<span class="meta">' + (c.customUrl || "") + '</span>' +
        '</div>';
    }).join("");
    html += '</div>';
    container.innerHTML = html;
  }

  async function loadManifest() {
    var manifest = await fetchJson("manifest.json");
    if (!manifest) {
      return {
        channels: ["channels/UCBcRF18a7Qf58cCRy5xuWwQ.json"],
        guide: ["guide/2026-03-20.json"],
      };
    }
    return manifest;
  }

  async function loadGuideConfig() {
    var config = await fetchJson("guide-config.json");
    if (config && config.blocks && config.blocks.length > 0) {
      return config.blocks;
    }
    return DEFAULT_BLOCKS;
  }

  async function loadGuideForDate(dateStr) {
    var entries = await fetchJson("guide/" + dateStr + ".json");
    if (entries && Array.isArray(entries)) {
      return entries;
    }
    return [];
  }

  /**
   * Set up guide date navigation and render the time grid
   */
  async function initGuide(blocks) {
    var guideGrid = document.getElementById("guide-grid");
    var dateLabel = document.getElementById("guide-date-label");
    var prevBtn = document.getElementById("guide-prev");
    var nextBtn = document.getElementById("guide-next");

    if (!guideGrid || !dateLabel || !prevBtn || !nextBtn) return;

    var currentDate = todayDateString();

    // Check URL hash for a date parameter
    if (window.location.hash) {
      var hashDate = window.location.hash.slice(1);
      if (/^\d{4}-\d{2}-\d{2}$/.test(hashDate)) {
        currentDate = hashDate;
      }
    }

    async function renderForDate(dateStr) {
      currentDate = dateStr;
      window.location.hash = dateStr;
      dateLabel.textContent = formatDateLabel(dateStr);
      guideGrid.innerHTML = '<p class="placeholder">Loading guide for ' + dateStr + '…</p>';
      var entries = await loadGuideForDate(dateStr);
      renderGuideTimeGrid(entries, blocks, guideGrid);
    }

    prevBtn.addEventListener("click", function () {
      renderForDate(shiftDate(currentDate, -1));
    });
    nextBtn.addEventListener("click", function () {
      renderForDate(shiftDate(currentDate, 1));
    });

    await renderForDate(currentDate);
  }

  async function init() {
    var manifest = await loadManifest();

    // Load channels
    var channels = [];
    if (manifest.channels) {
      for (var i = 0; i < manifest.channels.length; i++) {
        var ch = await fetchJson(manifest.channels[i]);
        if (ch) channels.push(ch);
      }
    }

    // Load guide entries for index page preview
    var guideEntries = [];
    if (manifest.guide) {
      for (var j = 0; j < manifest.guide.length; j++) {
        var entries = await fetchJson(manifest.guide[j]);
        if (entries && Array.isArray(entries)) {
          guideEntries = guideEntries.concat(entries);
        }
      }
    }

    // Load guide config for time grid
    var blocks = await loadGuideConfig();

    // Render into page sections if they exist
    var guidePreview = document.getElementById("guide-preview");
    if (guidePreview) renderGuidePreview(guideEntries, guidePreview);

    var channelList = document.getElementById("channel-list");
    if (channelList) renderChannelList(channels, channelList);

    // Guide page: full time grid with date navigation
    var guideGrid = document.getElementById("guide-grid");
    if (guideGrid && document.getElementById("guide-date-nav")) {
      await initGuide(blocks);
    } else if (guideGrid) {
      renderGuideTimeGrid(guideEntries, blocks, guideGrid);
    }

    var channelWall = document.getElementById("channel-wall");
    if (channelWall) renderChannelWall(channels, channelWall);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
