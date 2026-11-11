/**
 * SelfOrderHistory — shared order memory + "Ordered" history panel for the
 * customer and Open Day self-order pages.
 *
 * Responsibilities:
 *  - Persist submitted orders in localStorage so a refresh keeps the ticket.
 *  - Poll the Apps Script backend for live production / payment status.
 *  - Inject a page-level tab bar (Menu / My Orders) so saved orders live
 *    inline in the page instead of a floating modal.
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
      case "CANCELLED": return { bg: "#94a3b8", fg: "#ffffff", label: "CANCELLED" };
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
    var tabBar = null;
    var menuTab = null;
    var ordersTab = null;
    var ordersWrap = null;
    var currentTab = "menu"; // "menu" | "orders"

    // ---------- injected UI (page-level tab bar) ----------
    function ensureTabs() {
      if (tabBar && document.body.contains(tabBar)) return tabBar;
      var header = document.querySelector("header");
      if (!header) return null;

      // Tab bar sits inline under the header (before the category chips) so it
      // stays visible while scrolling the menu. We inject it once next to the
      // header's second child (the categories div) so ordering works.
      tabBar = document.createElement("div");
      tabBar.id = "sohTabBar";
      tabBar.style.cssText = [
        "display:flex", "gap:6px", "padding:0 16px 10px",
        "border-bottom:1px solid var(--border, rgba(15,23,42,0.08))"
      ].join(";");
      menuTab = document.createElement("button");
      menuTab.type = "button";
      menuTab.id = "sohMenuTab";
      menuTab.style.cssText = tabBtnStyle(true);
      menuTab.innerHTML = '<i class="fa-solid fa-mug-hot"></i><span>Menu</span>';
      menuTab.onclick = function () { switchTo("menu"); };
      ordersTab = document.createElement("button");
      ordersTab.type = "button";
      ordersTab.id = "sohOrdersTab";
      ordersTab.style.cssText = tabBtnStyle(false);
      ordersTab.innerHTML = '<i class="fa-solid fa-receipt"></i><span>My Orders</span><span id="sohOrderedCount" style="margin-left:4px;background:#f59e0b;color:#0b1120;border-radius:9999px;padding:1px 7px;font-size:10px;font-weight:900;">0</span>';
      ordersTab.onclick = function () { switchTo("orders"); };
      tabBar.appendChild(menuTab);
      tabBar.appendChild(ordersTab);

      // Insert the tab bar inside the header, between the title row and the
      // category chips. This keeps the pills sticky alongside the title so
      // they never scroll out of sight.
      var chipsEl = document.getElementById("customerCategoryTabs")
        || document.getElementById("opendayCategoryTabs")
        || document.querySelector("#chips");
      if (chipsEl && header.contains(chipsEl)) {
        header.insertBefore(tabBar, chipsEl);
      } else {
        header.appendChild(tabBar);
      }

      // Inline orders container — lives in the document flow, not as a modal.
      ordersWrap = document.createElement("div");
      ordersWrap.id = "sohOrdersWrap";
      ordersWrap.style.cssText = [
        "max-width:448px", "margin:0 auto", "padding:12px 16px 24px",
        "display:none"
      ].join(";");
      ordersWrap.innerHTML = [
        '<div id="sohOrderList"></div>',
        '<p style="font-size:10px;font-weight:600;opacity:0.55;text-align:center;margin:14px 0 0;">Orders are kept on this device for 7 days, or until you delete them.</p>'
      ].join("");
      ordersWrap.onclick = function (e) {
        var btn = e.target.closest ? e.target.closest("button[data-action]") : null;
        if (!btn) return;
        var num = btn.getAttribute("data-num");
        if (btn.getAttribute("data-action") === "delete") {
          removeOrder(num);
          if (opts.notify) opts.notify("Order #" + num + " removed from this device.", "info");
        } else if (btn.getAttribute("data-action") === "ticket") {
          var order = findOrder(num);
          if (order) {
            switchTo("menu");
            openTicketAndShow(order);
          }
        }
      };
      // Append ordersWrap as a sibling of the header, so it lives in the
      // normal document flow (under the sticky header + chips row).
      header.parentNode.insertBefore(ordersWrap, header.nextSibling);

      renderTabCount();
      return tabBar;
    }

    function tabBtnStyle(active) {
      var base = [
        "display:inline-flex", "align-items:center", "gap:6px",
        "padding:7px 13px", "border-radius:9999px", "cursor:pointer",
        "font-size:11px", "font-weight:900", "line-height:1",
        "border:1px solid var(--border-2, rgba(15,23,42,0.14))",
        "transition:all .18s ease"
      ];
      if (active) {
        base.push("background:var(--espresso-dark, #2E211A)");
        base.push("color:#FBF6EF");
        base.push("border-color:transparent");
        base.push("box-shadow:0 2px 8px rgba(46,33,26,0.25)");
      } else {
        base.push("background:transparent");
        base.push("color:var(--text-2, #334155)");
      }
      return base.join(";");
    }

    function renderTabCount() {
      if (!ordersTab) return;
      var count = document.getElementById("sohOrderedCount");
      if (count) count.innerText = String(orders.length);
    }

    function switchTo(tab) {
      ensureTabs();
      currentTab = tab;
      if (!menuTab || !ordersTab) return;

      // Tab pill visuals
      menuTab.style.cssText = tabBtnStyle(tab === "menu");
      ordersTab.style.cssText = tabBtnStyle(tab === "orders");

      // Hide category chips when viewing orders (they belong on Menu only).
      var chips = document.getElementById("customerCategoryTabs");
      if (chips) chips.style.display = tab === "menu" ? "" : "none";

      // Toggle visibility of ordersWrap vs menu view.
      if (tab === "orders") {
        if (ordersWrap) ordersWrap.style.display = "block";
        if (ordersWrap) renderInlineList();
        var orderView = document.getElementById("orderView");
        var footer = document.getElementById("orderFooter");
        if (orderView) orderView.style.display = "none";
        if (footer) footer.style.display = "none";
      } else {
        if (ordersWrap) ordersWrap.style.display = "none";
        var orderView2 = document.getElementById("orderView");
        var footer2 = document.getElementById("orderFooter");
        if (orderView2) orderView2.style.display = "";
        if (footer2) footer2.style.display = "";
      }
      try { window.scrollTo(0, 0); } catch (e) {}
    }

    function renderInlineList() {
      if (!ordersWrap) return;
      var list = document.getElementById("sohOrderList");
      if (!list) return;
      if (orders.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:32px 8px;"><div style="width:52px;height:52px;border-radius:50%;background:rgba(46,33,26,0.06);display:flex;align-items:center;justify-content:center;margin:0 auto 10px;"><i class="fa-solid fa-receipt" style="opacity:0.45;font-size:18px;"></i></div><p style="font-size:12px;font-weight:700;opacity:0.65;">No orders yet</p><p style="font-size:10px;font-weight:600;opacity:0.5;margin:4px 0 0;">Your orders will appear here.</p></div>';
        return;
      }
      var rows = orders.slice().reverse().map(function (o) {
        var st = statusStyle(o.status);
        var unpaid = o.paymentStatus === "UNPAID" && o.status !== "UNPAID" && o.status !== "RESERVED";
        var unpaidBadge = unpaid
          ? '<span style="background:#e11d48;color:#fff;border-radius:9999px;padding:2px 7px;font-size:9px;font-weight:900;">UNPAID</span>'
          : "";
        return [
          '<div style="border:1px solid var(--border, rgba(15,23,42,0.08));border-radius:14px;padding:12px 14px;margin-bottom:8px;background:var(--surface-2, #f7f9fc);">',
          '  <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">',
          '    <span style="font-weight:900;font-size:15px;">#' + escapeHtml(o.orderNum) + '</span>',
          '    <div style="display:flex;gap:4px;flex-wrap:wrap;">',
          '      <span style="background:' + st.bg + ';color:' + st.fg + ';border-radius:9999px;padding:2px 8px;font-size:9px;font-weight:900;">' + escapeHtml(st.label) + '</span>',
          unpaidBadge,
          '    </div>',
          '  </div>',
          '  <p style="margin:6px 0 0;font-size:12px;font-weight:700;">' + escapeHtml(o.productName) + (o.temp ? ' <span style="font-weight:500;opacity:0.7;">(' + escapeHtml(o.temp) + ')</span>' : '') + '</p>',
          '  <p style="margin:3px 0 0;font-size:10px;font-weight:600;opacity:0.65;">Pickup: ' + escapeHtml(o.pickupTime || "Scheduled") + '</p>',
          '  <p style="margin:1px 0 0;font-size:10px;font-weight:600;opacity:0.55;">Guest: ' + escapeHtml(o.guestName) + '</p>',
          '  <div style="display:flex;gap:6px;margin-top:10px;">',
          '    <button type="button" data-action="ticket" data-num="' + escapeHtml(o.orderNum) + '" style="flex:1;background:var(--espresso-dark,#2E211A);color:#FBF6EF;border:0;border-radius:10px;padding:8px 8px;font-size:11px;font-weight:900;cursor:pointer;">View ticket</button>',
          '    <button type="button" data-action="delete" data-num="' + escapeHtml(o.orderNum) + '" style="background:transparent;color:#e11d48;border:1px solid #e11d48;border-radius:10px;padding:8px 10px;font-size:11px;font-weight:800;cursor:pointer;">Delete</button>',
          '  </div>',
          '</div>'
        ].join("");
      }).join("");
      list.innerHTML = rows;
    }
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
      renderTabCount();
      if (currentTab === "orders") renderInlineList();
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
      renderTabCount();
      if (currentTab === "orders") renderInlineList();
      if (currentNum === target) {
        currentNum = null;
        saveCurrent(null);
        showMenuView();
      }
    }

    function isActive(order) {
      return ACTIVE_STATUSES.indexOf(String(order.status || "").toUpperCase()) !== -1;
    }

    // ---------- ticket / view management ----------
    function showMenuView() {
      switchTo("menu");
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
      var chips = document.getElementById("customerCategoryTabs");
      var tabBarEl = document.getElementById("sohTabBar");
      var wrapEl = document.getElementById("sohOrdersWrap");

      if (ticketVisible) {
        // Never cover a live ticket with the paused screen, and menus
        // (chips, tab bar, inline orders) don't belong on a ticket view.
        if (overlay) overlay.classList.add("hidden");
        if (chips) chips.style.display = "none";
        if (tabBarEl) tabBarEl.style.display = "none";
        if (wrapEl) wrapEl.style.display = "none";
        return;
      }

      // Show tab bar whenever a header exists.
      if (tabBarEl) tabBarEl.style.display = "";

      if (paused) {
        if (overlay) overlay.classList.remove("hidden");
        if (chips) chips.style.display = "none";
        if (wrapEl) wrapEl.style.display = "none";
        if (orderView) orderView.style.display = "none";
        if (footer) footer.style.display = "none";
        var reasonEl = document.getElementById("pausedOverlayReason");
        if (reasonEl && lastReason) reasonEl.innerText = lastReason;
      } else {
        if (overlay) overlay.classList.add("hidden");
        // Let switchTo() handle menu vs orders toggle — only restore menu
        // view if we haven't explicitly switched to orders.
        if (currentTab === "menu") {
          if (chips) chips.style.display = "";
          if (orderView) orderView.style.display = "";
          if (footer) footer.style.display = "";
          if (wrapEl) wrapEl.style.display = "none";
        }
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
              if (currentTab === "orders") renderInlineList();
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
      ensureTabs();
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
        renderTabCount();
      }
    }

    function newOrder() {
      currentNum = null;
      saveCurrent(null);
      switchTo("menu");
      renderTabCount();
    }

    return {
      openTicket: remember,
      startPolling: startPolling,
      stopPolling: stopPolling,
      newOrder: newOrder,
      restore: restore,
      applyView: applyView,
      openPanel: function () { ensureTabs(); switchTo("orders"); },
      closePanel: function () { switchTo("menu"); }
    };
  }

  window.SelfOrderHistory = { create: create };
})();
