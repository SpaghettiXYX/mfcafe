/**
 * SelfOrderHistory — shared order memory + "Ordered" history panel for the
 * customer and Open Day self-order pages.
 *
 * Responsibilities:
 *  - Persist submitted orders in localStorage so a refresh keeps the ticket.
 *  - Poll the Apps Script backend for live production / payment status.
 *  - Inject an "Ordered" button into the header with a history modal.
 *  - Let the guest view or manually delete any remembered order.
 */
(function () {
  var ACTIVE_STATUSES = ["UNPAID", "PENDING", "ASSIGNED", "READY", "RESERVED"];
  var MAX_ORDERS = 30;
  var POLL_MS = 10000;
  var RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // keep remembered orders for 7 days

  function safeParse(raw) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalize(order) {
    order = order || {};
    var status = String(order.status || "UNPAID").trim().toUpperCase();
    var payment = String(order.paymentStatus || "").trim().toUpperCase();
    if (!payment) payment = (status === "UNPAID" || status === "RESERVED") ? "UNPAID" : "PAID";
    return {
      orderNum: String(order.orderNum || "").trim(),
      orderTime: order.orderTime || "",
      pickupTime: order.pickupTime || "",
      guestName: order.guestName || "Guest",
      productName: order.productName || "",
      temp: order.temp || "",
      customization: order.customization || "",
      price: Number(order.price) || 0,
      status: status,
      paymentStatus: payment,
      qrTile: order.qrTile || "",
      addedAt: Number(order.addedAt) || Date.now()
    };
  }

  function statusStyle(status) {
    switch (status) {
      case "READY": return { bg: "#059669", fg: "#ffffff", label: "READY" };
      case "PENDING":
      case "ASSIGNED": return { bg: "#f59e0b", fg: "#0b1120", label: "PREPARING" };
      case "RESERVED": return { bg: "#7c3aed", fg: "#ffffff", label: "RESERVED" };
      case "UNPAID": return { bg: "#e11d48", fg: "#ffffff", label: "UNPAID" };
      case "CLEARED": return { bg: "#64748b", fg: "#ffffff", label: "PICKED UP" };
      default: return { bg: "#64748b", fg: "#ffffff", label: status || "UNKNOWN" };
    }
  }

  function create(options) {
    var opts = options || {};
    var storageKey = opts.storageKey || "mfcafe_self_orders_v1";
    var apiUrl = opts.apiUrl || "";
    var orders = [];
    var currentNum = null;
    var pollTimer = null;
    var polling = false;
    var lastPaused = false;
    var lastReason = "";
    var panel = null;
    var button = null;

    // ---------- storage ----------
    function load() {
      try {
        var raw = localStorage.getItem(storageKey);
        var parsed = safeParse(raw);
        if (Array.isArray(parsed)) {
          var cutoff = Date.now() - RETENTION_MS;
          var kept = parsed.map(normalize)
            .filter(function (o) { return o.orderNum && o.addedAt >= cutoff; });
          if (kept.length !== parsed.length) {
            try { localStorage.setItem(storageKey, JSON.stringify(kept)); } catch (e) {}
            var cur = localStorage.getItem(storageKey + "_current");
            if (cur && !kept.some(function (o) { return o.orderNum === cur; })) {
              localStorage.removeItem(storageKey + "_current");
            }
          }
          return kept;
        }
      } catch (e) {}
      return [];
    }

    function save() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(orders.slice(-MAX_ORDERS)));
      } catch (e) {}
    }

    function saveCurrent(num) {
      try {
        if (num) localStorage.setItem(storageKey + "_current", String(num));
        else localStorage.removeItem(storageKey + "_current");
      } catch (e) {}
    }

    function loadCurrent() {
      try { return localStorage.getItem(storageKey + "_current"); } catch (e) { return null; }
    }

    function upsert(order) {
      var clean = normalize(order);
      if (!clean.orderNum) return clean;
      var idx = -1;
      for (var i = orders.length - 1; i >= 0; i--) {
        if (orders[i].orderNum === clean.orderNum) { idx = i; break; }
      }
      if (idx >= 0) orders[idx] = clean; else orders.push(clean);
      if (orders.length > MAX_ORDERS) orders = orders.slice(-MAX_ORDERS);
      save();
      renderButton();
      if (panel) renderPanel();
      return clean;
    }

    function findOrder(num) {
      var target = String(num || "").trim();
      for (var i = orders.length - 1; i >= 0; i--) {
        if (orders[i].orderNum === target) return orders[i];
      }
      return null;
    }

    function removeOrder(num) {
      var target = String(num || "").trim();
      orders = orders.filter(function (o) { return o.orderNum !== target; });
      save();
      renderButton();
      if (panel) renderPanel();
      if (currentNum === target) {
        currentNum = null;
        saveCurrent(null);
        showMenuView();
      }
    }

    function isActive(order) {
      return ACTIVE_STATUSES.indexOf(String(order.status || "").toUpperCase()) !== -1;
    }

    // ---------- injected UI ----------
    function ensureButton() {
      if (button && document.body.contains(button)) return button;
      var header = document.querySelector("header");
      if (!header) return null;
      var bar = document.createElement("div");
      bar.id = "sohTopBar";
      bar.style.cssText = "display:flex;justify-content:flex-end;padding:0 4px 6px;";
      button = document.createElement("button");
      button.type = "button";
      button.id = "sohOrderedBtn";
      button.style.cssText = [
        "display:inline-flex", "align-items:center", "gap:6px",
        "padding:6px 12px", "border-radius:9999px", "cursor:pointer",
        "font-size:11px", "font-weight:800", "line-height:1",
        "border:1px solid var(--border-2, #cbd5e1)",
        "background:var(--surface, #ffffff)", "color:var(--text-2, #334155)",
        "box-shadow:0 2px 8px rgba(15,23,42,0.08)"
      ].join(";");
      button.innerHTML = '<i class="fa-solid fa-receipt"></i><span>Ordered</span><span id="sohOrderedCount" style="background:#f59e0b;color:#0b1120;border-radius:9999px;padding:2px 6px;font-size:10px;">0</span>';
      button.onclick = function (e) { e.preventDefault(); openPanel(); };
      bar.appendChild(button);
      header.parentNode.insertBefore(bar, header);
      renderButton();
      return button;
    }

    function renderButton() {
      if (!button) return;
      var count = document.getElementById("sohOrderedCount");
      if (count) count.innerText = String(orders.length);
      button.style.display = "inline-flex";
    }

    function ensurePanel() {
      if (panel && document.body.contains(panel)) return panel;
      panel = document.createElement("div");
      panel.id = "orderedView";
      panel.style.cssText = [
        "position:fixed", "inset:0", "z-index:120", "display:none",
        "align-items:center", "justify-content:center", "padding:16px",
        "background:rgba(16,21,31,0.72)", "backdrop-filter:blur(4px)"
      ].join(";");
      panel.innerHTML = [
        '<div id="sohPanelCard" style="width:100%;max-width:26rem;max-height:88vh;overflow-y:auto;border-radius:20px;padding:16px;background:var(--surface, #ffffff);color:var(--text, #0f172a);border:1px solid var(--border, #e2e8f0);box-shadow:0 20px 50px rgba(0,0,0,0.35);">',
        '  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;">',
        '    <h3 style="font-size:16px;font-weight:900;margin:0;">My Orders</h3>',
        '    <button type="button" id="sohClosePanel" style="background:transparent;border:1px solid var(--border-2, #cbd5e1);color:inherit;border-radius:10px;padding:6px 10px;font-size:12px;font-weight:700;cursor:pointer;"><i class="fa-solid fa-xmark"></i></button>',
        '  </div>',
        '  <div id="sohOrderList"></div>',
        '  <p style="font-size:10px;opacity:0.6;margin:12px 0 0;">Orders are kept on this device for 7 days, or until you delete them.</p>',
        '</div>'
      ].join("");
      document.body.appendChild(panel);
      panel.onclick = function (e) { if (e.target === panel) closePanel(); };
      document.getElementById("sohClosePanel").onclick = closePanel;
      renderPanel();
      return panel;
    }

    function openPanel() {
      ensurePanel();
      renderPanel();
      panel.style.display = "flex";
    }

    function closePanel() {
      if (panel) panel.style.display = "none";
    }

    function renderPanel() {
      if (!panel) return;
      var list = document.getElementById("sohOrderList");
      if (!list) return;
      if (orders.length === 0) {
        list.innerHTML = '<p style="font-size:12px;font-weight:600;opacity:0.65;text-align:center;padding:18px 0;">No remembered orders yet.</p>';
        return;
      }
      var rows = orders.slice().reverse().map(function (o) {
        var st = statusStyle(o.status);
        var unpaid = o.paymentStatus === "UNPAID" && o.status !== "UNPAID" && o.status !== "RESERVED";
        var unpaidBadge = unpaid
          ? '<span style="background:#e11d48;color:#fff;border-radius:9999px;padding:2px 7px;font-size:9px;font-weight:900;">UNPAID</span>'
          : "";
        return [
          '<div style="border:1px solid var(--border, #e2e8f0);border-radius:14px;padding:10px;margin-bottom:8px;background:var(--surface-2, #f1f5f9);">',
          '  <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">',
          '    <span style="font-weight:900;font-size:14px;">#' + escapeHtml(o.orderNum) + '</span>',
          '    <div style="display:flex;gap:4px;flex-wrap:wrap;">',
          '      <span style="background:' + st.bg + ';color:' + st.fg + ';border-radius:9999px;padding:2px 7px;font-size:9px;font-weight:900;">' + escapeHtml(st.label) + '</span>',
          unpaidBadge,
          '    </div>',
          '  </div>',
          '  <p style="margin:6px 0 0;font-size:12px;font-weight:700;">' + escapeHtml(o.productName) + ' (' + escapeHtml(o.temp) + ')</p>',
          '  <p style="margin:2px 0 0;font-size:10px;opacity:0.7;">Pickup: ' + escapeHtml(o.pickupTime || "Scheduled") + ' · ' + escapeHtml(o.guestName) + '</p>',
          '  <div style="display:flex;gap:6px;margin-top:8px;">',
          '    <button type="button" data-action="view" data-num="' + escapeHtml(o.orderNum) + '" style="flex:1;background:#f59e0b;color:#0b1120;border:0;border-radius:10px;padding:7px 8px;font-size:11px;font-weight:900;cursor:pointer;">View ticket</button>',
          '    <button type="button" data-action="delete" data-num="' + escapeHtml(o.orderNum) + '" style="background:transparent;color:#e11d48;border:1px solid #e11d48;border-radius:10px;padding:7px 10px;font-size:11px;font-weight:800;cursor:pointer;">Delete</button>',
          '  </div>',
          '</div>'
        ].join("");
      }).join("");
      list.innerHTML = rows;

      Array.prototype.forEach.call(list.querySelectorAll("button[data-action]"), function (btn) {
        btn.onclick = function () {
          var num = btn.getAttribute("data-num");
          if (btn.getAttribute("data-action") === "delete") {
            removeOrder(num);
            if (opts.notify) opts.notify("Order #" + num + " removed from this device.", "info");
          } else {
            var order = findOrder(num);
            if (order) {
              closePanel();
              openTicketAndShow(order);
            }
          }
        };
      });
    }

    // ---------- ticket / view management ----------
    function showMenuView() {
      var ticketEl = document.getElementById("qrTicketView");
      if (ticketEl) ticketEl.classList.add("hidden");
      if (opts.closeReceipt) opts.closeReceipt();
      applyView(lastPaused, lastReason);
      try { window.scrollTo(0, 0); } catch (e) {}
    }

    function remember(order) {
      var clean = upsert(order);
      currentNum = clean.orderNum;
      saveCurrent(currentNum);
      return clean;
    }

    function openTicketAndShow(order) {
      var clean = remember(order);
      // Reset scroll so the ticket always starts at the top (fixes the jump
      // back to the menu that happened while the menu list was still tall).
      try { window.scrollTo(0, 0); } catch (e) {}
      if (opts.showTicket) opts.showTicket(clean);
    }

    function applyView(paused, reason) {
      lastPaused = !!paused;
      lastReason = String(reason || "");
      var ticketEl = document.getElementById("qrTicketView");
      var ticketVisible = ticketEl && !ticketEl.classList.contains("hidden");
      var overlay = document.getElementById("pausedOverlay");
      var orderView = document.getElementById("orderView");
      var footer = document.getElementById("orderFooter");

      if (ticketVisible) {
        // Never cover a live ticket with the paused screen.
        if (overlay) overlay.classList.add("hidden");
        return;
      }

      if (overlay) overlay.classList.toggle("hidden", !paused);
      if (orderView) orderView.classList.toggle("hidden", paused);
      if (footer) footer.classList.toggle("hidden", paused);

      var reasonEl = document.getElementById("pausedOverlayReason");
      if (reasonEl && lastReason) reasonEl.innerText = lastReason;
      if (!paused) {
        try { window.scrollTo(0, 0); } catch (e) {}
      }
    }

    // ---------- live status polling ----------
    function pollOnce() {
      var targets = orders.filter(isActive);
      if (targets.length === 0 || !apiUrl) return;
      // Cap the number of parallel requests on very busy devices
      targets.slice(-8).forEach(function (stored) {
        var url = apiUrl + "?action=lookupOrder&code=" + encodeURIComponent(stored.orderNum) + "&_t=" + Date.now();
        fetch(url, { cache: "no-cache" })
          .then(function (res) { return res.json(); })
          .then(function (res) {
            if (!res || !res.success || !res.order) return;
            var updated = normalize(res.order);
            var idx = -1;
            for (var i = orders.length - 1; i >= 0; i--) {
              if (orders[i].orderNum === updated.orderNum) { idx = i; break; }
            }
            if (idx === -1) return;
            // Keep the original remember date so live polling doesn't extend
            // the 7-day retention window indefinitely.
            updated.addedAt = orders[idx].addedAt || updated.addedAt;
            var changed = orders[idx].status !== updated.status || orders[idx].paymentStatus !== updated.paymentStatus;
            orders[idx] = updated;
            if (changed) {
              save();
              if (panel) renderPanel();
            }
            if (currentNum === updated.orderNum && opts.updateStatus) {
              opts.updateStatus(updated.status, updated.paymentStatus);
            }
          })
          .catch(function () {});
      });
    }

    function startPolling() {
      // Always refresh once so a freshly created order is picked up immediately
      pollOnce();
      if (polling) return;
      polling = true;
      pollTimer = setInterval(pollOnce, POLL_MS);
    }

    function stopPolling() {
      polling = false;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // ---------- lifecycle ----------
    function restore() {
      orders = load();
      ensureButton();
      var latest = null;
      // Re-open the ticket the guest last looked at, so a refresh keeps them on
      // the same order; otherwise fall back to the newest open order.
      var saved = loadCurrent();
      if (saved) {
        for (var j = orders.length - 1; j >= 0; j--) {
          if (orders[j].orderNum === saved && orders[j].status !== "CLEARED") { latest = orders[j]; break; }
        }
      }
      if (!latest) {
        for (var i = orders.length - 1; i >= 0; i--) {
          if (orders[i].status !== "CLEARED") { latest = orders[i]; break; }
        }
      }
      if (latest) {
        window.__sohRestoring = true;
        try {
          openTicketAndShow(latest);
        } finally {
          window.__sohRestoring = false;
        }
        startPolling();
      } else {
        renderButton();
      }
    }

    function newOrder() {
      currentNum = null;
      saveCurrent(null);
      closePanel();
      renderButton();
    }

    return {
      openTicket: remember,
      startPolling: startPolling,
      stopPolling: stopPolling,
      newOrder: newOrder,
      restore: restore,
      applyView: applyView,
      openPanel: openPanel,
      closePanel: closePanel
    };
  }

  window.SelfOrderHistory = { create: create };
})();
