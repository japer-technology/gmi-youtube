/**
 * station.js — Lightweight resource loader for the Station static site
 *
 * Loads JSON resources from the resources/ directory and renders them
 * into the appropriate page sections.
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

  function renderGuidePreview(entries, container) {
    if (!entries || entries.length === 0) {
      container.innerHTML = '<p class="placeholder">No guide entries available.</p>';
      return;
    }
    var html = entries.map(function (e) {
      return '<div class="card guide-entry">' +
        '<span class="time">' + formatTime(e.scheduledAt) + '</span>' +
        '<div>' +
        '<h3><a href="https://www.youtube.com/watch?v=' + encodeURIComponent(e.videoId) + '" target="_blank" rel="noopener">' +
        e.title + '</a>' + liveBadge(e.liveBroadcastContent) + '</h3>' +
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

  function renderGuideGrid(entries, container) {
    renderGuidePreview(entries, container);
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
      // Fall back to known resource paths
      return {
        channels: ["channels/UCBcRF18a7Qf58cCRy5xuWwQ.json"],
        guide: ["guide/2026-03-20.json"],
      };
    }
    return manifest;
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

    // Load guide entries
    var guideEntries = [];
    if (manifest.guide) {
      for (var j = 0; j < manifest.guide.length; j++) {
        var entries = await fetchJson(manifest.guide[j]);
        if (entries && Array.isArray(entries)) {
          guideEntries = guideEntries.concat(entries);
        }
      }
    }

    // Render into page sections if they exist
    var guidePreview = document.getElementById("guide-preview");
    if (guidePreview) renderGuidePreview(guideEntries, guidePreview);

    var channelList = document.getElementById("channel-list");
    if (channelList) renderChannelList(channels, channelList);

    var guideGrid = document.getElementById("guide-grid");
    if (guideGrid) renderGuideGrid(guideEntries, guideGrid);

    var channelWall = document.getElementById("channel-wall");
    if (channelWall) renderChannelWall(channels, channelWall);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
