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
 *
 * The wall page renders a configurable channel matrix with:
 * - Named layout configurations (NxM grids)
 * - Most recent or live video per channel
 * - Live, upcoming, and stale-state indicators
 * - Embedded YouTube players with thumbnail fallback
 * - Layout switching and playback preference controls
 *
 * The receipt page renders viewing receipts with:
 * - List of all available receipts
 * - Detail view with stats, arrived/skipped content, channel distribution
 * - Curator notes
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

  // --- Wall layout support ---

  function loadWallLayouts() {
    return fetchJson("wall-layouts.json").then(function (data) {
      if (data && Array.isArray(data) && data.length > 0) return data;
      return null;
    });
  }

  /**
   * Parse ISO 8601 duration to milliseconds
   */
  function parseDurationMs(iso) {
    if (!iso) return 0;
    var match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    var h = parseInt(match[1] || "0", 10);
    var m = parseInt(match[2] || "0", 10);
    var s = parseInt(match[3] || "0", 10);
    return (h * 3600 + m * 60 + s) * 1000;
  }

  /**
   * Determine the state of a video for wall display.
   * Returns "live", "upcoming", "stale", or "recent".
   * Stale = published more than 7 days ago with no live status.
   */
  function videoWallState(video) {
    if (video.liveBroadcastContent === "live") return "live";
    if (video.liveBroadcastContent === "upcoming") return "upcoming";
    var now = Date.now();
    var published = new Date(video.publishedAt).getTime();
    if (isNaN(published)) return "stale";
    var sevenDays = 7 * 24 * 60 * 60 * 1000;
    return (now - published < sevenDays) ? "recent" : "stale";
  }

  /**
   * Find the most relevant video for a channel:
   * 1. Currently live video (highest priority)
   * 2. Upcoming video
   * 3. Most recently published video
   */
  function findBestVideoForChannel(channelId, videos) {
    var channelVideos = [];
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].channelId === channelId) {
        channelVideos.push(videos[i]);
      }
    }
    if (channelVideos.length === 0) return null;

    // Priority: live > upcoming > most recent
    for (var j = 0; j < channelVideos.length; j++) {
      if (channelVideos[j].liveBroadcastContent === "live") return channelVideos[j];
    }
    for (var k = 0; k < channelVideos.length; k++) {
      if (channelVideos[k].liveBroadcastContent === "upcoming") return channelVideos[k];
    }

    // Sort by publishedAt descending and return the most recent
    channelVideos.sort(function (a, b) {
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    });
    return channelVideos[0];
  }

  /**
   * Build the YouTube embed URL for a video
   */
  function buildEmbedUrl(videoId, autoplay) {
    var url = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(videoId);
    var params = [];
    if (autoplay) params.push("autoplay=1");
    params.push("rel=0");
    if (params.length > 0) url += "?" + params.join("&");
    return url;
  }

  /**
   * Render a single wall tile for a channel
   */
  function renderWallTile(channel, video, embedEnabled, autoplay) {
    var state = video ? videoWallState(video) : "stale";
    var tileClass = "wall-tile wall-state-" + state;

    var html = '<div class="' + tileClass + '">';

    // Tile header: channel name + state badge
    html += '<div class="wall-tile-header">';
    html += '<span class="wall-tile-channel">' + channel.title + '</span>';
    if (state === "live") html += '<span class="badge live">LIVE</span>';
    if (state === "upcoming") html += '<span class="badge upcoming">UPCOMING</span>';
    if (state === "stale") html += '<span class="badge stale">STALE</span>';
    html += '</div>';

    if (video) {
      // Video content area
      html += '<div class="wall-tile-content">';

      if (embedEnabled) {
        // Embedded YouTube player
        html += '<div class="wall-tile-embed">';
        html += '<iframe src="' + buildEmbedUrl(video.id, autoplay && state === "live") + '"';
        html += ' style="border:0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen';
        html += ' loading="lazy" title="' + video.title.replace(/"/g, '&quot;') + '"></iframe>';
        html += '</div>';
      } else {
        // Thumbnail + link fallback
        var thumbUrl = video.thumbnailUrl || "https://i.ytimg.com/vi/" + encodeURIComponent(video.id) + "/hqdefault.jpg";
        html += '<a class="wall-tile-thumb" href="https://www.youtube.com/watch?v=' + encodeURIComponent(video.id) + '" target="_blank" rel="noopener">';
        html += '<img src="' + thumbUrl + '" alt="' + video.title.replace(/"/g, '&quot;') + '" loading="lazy">';
        if (video.duration) {
          html += '<span class="wall-tile-duration">' + formatDuration(video.duration) + '</span>';
        }
        html += '</a>';
      }

      // Video info
      html += '<div class="wall-tile-info">';
      html += '<a class="wall-tile-title" href="https://www.youtube.com/watch?v=' + encodeURIComponent(video.id) + '" target="_blank" rel="noopener">';
      html += video.title + '</a>';
      html += '<span class="wall-tile-meta">';
      if (video.publishedAt) html += formatTime(video.publishedAt);
      if (video.duration) html += ' · ' + formatDuration(video.duration);
      html += '</span>';
      html += '</div>';

      html += '</div>';
    } else {
      html += '<div class="wall-tile-content">';
      html += '<p class="placeholder wall-tile-empty">No recent videos</p>';
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  /**
   * Render the full wall grid from a layout configuration
   */
  function renderWallGrid(layout, channelMap, videos, container, embedEnabled, autoplay) {
    if (!layout || !layout.channels || layout.channels.length === 0) {
      container.innerHTML = '<p class="placeholder">No channels assigned to this layout.</p>';
      return;
    }

    var cols = layout.cols || 1;
    var html = '<div class="channel-wall" style="grid-template-columns: repeat(' + cols + ', 1fr)">';

    for (var i = 0; i < layout.channels.length; i++) {
      var channelId = layout.channels[i];
      var channel = channelMap[channelId] || { title: channelId, id: channelId };
      var video = findBestVideoForChannel(channelId, videos);
      html += renderWallTile(channel, video, embedEnabled, autoplay);
    }

    html += '</div>';
    container.innerHTML = html;
  }

  /**
   * Get localStorage preference with a default
   */
  function getWallPref(key, defaultValue) {
    try {
      var val = localStorage.getItem(key);
      if (val === null) return defaultValue;
      return val === "true";
    } catch (_e) {
      return defaultValue;
    }
  }

  /**
   * Save a wall preference to localStorage
   */
  function setWallPref(key, value) {
    try {
      localStorage.setItem(key, value ? "true" : "false");
    } catch (_e) {
      // localStorage unavailable — preference not persisted
    }
  }

  /**
   * Initialize the wall page with layout switching and preference controls
   */
  function initWall(layouts, channelMap, videos) {
    var container = document.getElementById("channel-wall");
    var layoutSelect = document.getElementById("wall-layout-select");
    var embedToggle = document.getElementById("wall-embed-toggle");
    var autoplayToggle = document.getElementById("wall-autoplay-toggle");

    if (!container || !layoutSelect) return;

    // Load preferences
    var embedEnabled = getWallPref("wall-embed", false);
    var autoplay = getWallPref("wall-autoplay", false);

    if (embedToggle) embedToggle.checked = embedEnabled;
    if (autoplayToggle) autoplayToggle.checked = autoplay;

    // Populate layout selector
    var selectedIndex = 0;
    var savedLayout = "";
    try { savedLayout = localStorage.getItem("wall-layout") || ""; } catch (_e) { /* no-op */ }

    for (var i = 0; i < layouts.length; i++) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = capitalize(layouts[i].name) + " (" + layouts[i].rows + "×" + layouts[i].cols + ")";
      layoutSelect.appendChild(opt);
      if (layouts[i].name === savedLayout) selectedIndex = i;
    }
    layoutSelect.value = String(selectedIndex);

    function renderCurrent() {
      var idx = parseInt(layoutSelect.value, 10) || 0;
      var layout = layouts[idx];
      try { localStorage.setItem("wall-layout", layout.name); } catch (_e) { /* no-op */ }
      renderWallGrid(layout, channelMap, videos, container, embedEnabled, autoplay);
    }

    layoutSelect.addEventListener("change", renderCurrent);

    if (embedToggle) {
      embedToggle.addEventListener("change", function () {
        embedEnabled = embedToggle.checked;
        setWallPref("wall-embed", embedEnabled);
        renderCurrent();
      });
    }

    if (autoplayToggle) {
      autoplayToggle.addEventListener("change", function () {
        autoplay = autoplayToggle.checked;
        setWallPref("wall-autoplay", autoplay);
        renderCurrent();
      });
    }

    renderCurrent();
  }

  // --- Receipt support ---

  function formatDate(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch (_e) {
      return iso;
    }
  }

  function formatMinutes(minutes) {
    if (!minutes || minutes <= 0) return "0m";
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }

  function renderReceiptCard(receipt) {
    var periodLabel = formatDate(receipt.periodStart) + " – " + formatDate(receipt.periodEnd);
    var stats = receipt.stats || {};
    var html = '<div class="receipt-card" data-receipt-id="' + receipt.id + '">';
    html += '<div class="receipt-card-header">';
    html += '<span class="receipt-card-id">' + receipt.id + '</span>';
    html += '<span class="receipt-card-period">' + periodLabel + '</span>';
    html += '</div>';
    html += '<div class="receipt-card-stats">';
    html += '<span>Arrived: ' + (stats.totalArrived || 0) + '</span>';
    html += '<span>Skipped: ' + (stats.totalSkipped || 0) + '</span>';
    if (stats.totalDurationMinutes) {
      html += '<span>Duration: ' + formatMinutes(stats.totalDurationMinutes) + '</span>';
    }
    html += '</div>';
    if (receipt.curatorNotes) {
      html += '<div class="receipt-card-notes">' + receipt.curatorNotes + '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderReceiptDetail(receipt) {
    var stats = receipt.stats || {};
    var html = '';

    // Header
    html += '<div class="receipt-header">';
    html += '<h3>' + receipt.id + '</h3>';
    html += '<div class="receipt-period">' + formatDate(receipt.periodStart) + ' – ' + formatDate(receipt.periodEnd) + '</div>';
    html += '</div>';

    // Stats grid
    html += '<div class="receipt-stats-grid">';
    html += '<div class="receipt-stat"><span class="receipt-stat-value">' + (stats.totalArrived || 0) + '</span><span class="receipt-stat-label">Arrived</span></div>';
    html += '<div class="receipt-stat"><span class="receipt-stat-value">' + (stats.totalWatched || 0) + '</span><span class="receipt-stat-label">Watched</span></div>';
    html += '<div class="receipt-stat"><span class="receipt-stat-value">' + (stats.totalSkipped || 0) + '</span><span class="receipt-stat-label">Skipped</span></div>';
    if (stats.totalDurationMinutes) {
      html += '<div class="receipt-stat"><span class="receipt-stat-value">' + formatMinutes(stats.totalDurationMinutes) + '</span><span class="receipt-stat-label">Duration</span></div>';
    }
    html += '</div>';

    // Curator notes
    if (receipt.curatorNotes) {
      html += '<div class="receipt-notes">' + receipt.curatorNotes + '</div>';
    }

    // Channel distribution
    if (stats.channelDistribution && Object.keys(stats.channelDistribution).length > 0) {
      html += '<div class="receipt-section">';
      html += '<h4>Channel Distribution</h4>';
      html += '<div class="receipt-channel-dist">';
      var channels = Object.keys(stats.channelDistribution);
      for (var i = 0; i < channels.length; i++) {
        html += '<span class="receipt-channel-tag">' + channels[i];
        html += ' <span class="receipt-channel-count">' + stats.channelDistribution[channels[i]] + '</span>';
        html += '</span>';
      }
      html += '</div></div>';
    }

    // Arrived videos
    if (receipt.arrived && receipt.arrived.length > 0) {
      html += '<div class="receipt-section">';
      html += '<h4>Arrived (' + receipt.arrived.length + ')</h4>';
      html += '<div class="receipt-video-list">';
      for (var a = 0; a < receipt.arrived.length; a++) {
        var av = receipt.arrived[a];
        html += '<div class="receipt-video">';
        html += '<a class="receipt-video-title" href="https://www.youtube.com/watch?v=' + encodeURIComponent(av.videoId) + '" target="_blank" rel="noopener">' + av.title + '</a>';
        if (av.channelTitle) {
          html += '<div class="receipt-video-channel">' + av.channelTitle + '</div>';
        }
        html += '</div>';
      }
      html += '</div></div>';
    }

    // Watched videos
    if (receipt.watched && receipt.watched.length > 0) {
      html += '<div class="receipt-section">';
      html += '<h4>Watched (' + receipt.watched.length + ')</h4>';
      html += '<div class="receipt-video-list">';
      for (var w = 0; w < receipt.watched.length; w++) {
        var wv = receipt.watched[w];
        html += '<div class="receipt-video">';
        html += '<a class="receipt-video-title" href="https://www.youtube.com/watch?v=' + encodeURIComponent(wv.videoId) + '" target="_blank" rel="noopener">' + wv.title + '</a>';
        if (wv.channelTitle) {
          html += '<div class="receipt-video-channel">' + wv.channelTitle + '</div>';
        }
        html += '</div>';
      }
      html += '</div></div>';
    }

    // Skipped videos
    if (receipt.skipped && receipt.skipped.length > 0) {
      html += '<div class="receipt-section">';
      html += '<h4>Skipped (' + receipt.skipped.length + ')</h4>';
      html += '<div class="receipt-video-list">';
      for (var s = 0; s < receipt.skipped.length; s++) {
        var sv = receipt.skipped[s];
        html += '<div class="receipt-video">';
        html += '<a class="receipt-video-title" href="https://www.youtube.com/watch?v=' + encodeURIComponent(sv.videoId) + '" target="_blank" rel="noopener">' + sv.title + '</a>';
        if (sv.channelTitle) {
          html += '<div class="receipt-video-channel">' + sv.channelTitle + '</div>';
        }
        html += '</div>';
      }
      html += '</div></div>';
    }

    return html;
  }

  function initReceipts(receipts) {
    var listContainer = document.getElementById("receipt-list");
    var detailContainer = document.getElementById("receipt-detail");
    var contentContainer = document.getElementById("receipt-content");
    var backBtn = document.getElementById("receipt-back");

    if (!listContainer || !detailContainer || !contentContainer) return;

    // Sort receipts by periodEnd descending (most recent first)
    receipts.sort(function (a, b) {
      return new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime();
    });

    function showList() {
      detailContainer.style.display = "none";
      listContainer.style.display = "";
      window.location.hash = "";

      if (receipts.length === 0) {
        listContainer.innerHTML = '<p class="placeholder">No viewing receipts available yet.</p>';
        return;
      }

      var html = '<div class="receipt-list-grid">';
      for (var i = 0; i < receipts.length; i++) {
        html += renderReceiptCard(receipts[i]);
      }
      html += '</div>';
      listContainer.innerHTML = html;

      // Attach click handlers
      var cards = listContainer.querySelectorAll(".receipt-card");
      for (var j = 0; j < cards.length; j++) {
        cards[j].addEventListener("click", (function (idx) {
          return function () { showDetail(receipts[idx]); };
        })(j));
      }
    }

    function showDetail(receipt) {
      listContainer.style.display = "none";
      detailContainer.style.display = "";
      window.location.hash = receipt.id;
      contentContainer.innerHTML = renderReceiptDetail(receipt);
    }

    if (backBtn) {
      backBtn.addEventListener("click", showList);
    }

    // Check URL hash for a receipt ID
    if (window.location.hash) {
      var hashId = window.location.hash.slice(1);
      for (var r = 0; r < receipts.length; r++) {
        if (receipts[r].id === hashId) {
          showDetail(receipts[r]);
          return;
        }
      }
    }

    showList();
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

    // Wall page: configurable layout grid
    var channelWall = document.getElementById("channel-wall");
    var layoutSelect = document.getElementById("wall-layout-select");
    if (channelWall && layoutSelect) {
      var layouts = await loadWallLayouts();
      if (layouts) {
        // Build channel lookup map
        var channelMap = {};
        for (var ci = 0; ci < channels.length; ci++) {
          channelMap[channels[ci].id] = channels[ci];
        }

        // Load all videos for wall tiles
        var videos = [];
        if (manifest.videos) {
          for (var vi = 0; vi < manifest.videos.length; vi++) {
            var v = await fetchJson(manifest.videos[vi]);
            if (v) videos.push(v);
          }
        }

        initWall(layouts, channelMap, videos);
      } else {
        // No wall layouts available — render simple channel list
        renderChannelWall(channels, channelWall);
      }
    } else if (channelWall) {
      renderChannelWall(channels, channelWall);
    }

    // Receipt page: viewing receipt list and detail view
    var receiptList = document.getElementById("receipt-list");
    if (receiptList) {
      var receipts = [];
      if (manifest.receipts) {
        for (var ri = 0; ri < manifest.receipts.length; ri++) {
          var receipt = await fetchJson(manifest.receipts[ri]);
          if (receipt) receipts.push(receipt);
        }
      }
      initReceipts(receipts);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
