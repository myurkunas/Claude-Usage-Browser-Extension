(() => {
  const PANEL_ID = "claude-usage-panel";
  if (document.getElementById(PANEL_ID)) return;

  let cachedOrgId = null;

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.title = "Click to refresh";
  panel.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    load();
  });

  const chips = document.createElement("div");
  chips.className = "cu-chips";
  panel.appendChild(chips);

  function setStatus(cls, text) {
    chips.replaceChildren();
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    chips.appendChild(el);
  }

  setStatus("cu-loading", "Loading…");

  function findMountPoint() {
    const container = document.querySelector("[data-chat-input-container]");
    if (!container) return null;
    const editable = container.querySelector('[contenteditable="true"]');
    if (!editable) return null;
    let el = editable.parentElement;
    while (el && el !== container) {
      if (el.classList && el.classList.contains("cursor-text")) {
        return { parent: el, before: el.firstElementChild };
      }
      el = el.parentElement;
    }
    return null;
  }

  function applyTheme(host) {
    const bg = getComputedStyle(host).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    let isDark = false;
    if (m) {
      const lum = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
      isDark = lum < 0.5;
    }
    panel.classList.toggle("cu-dark", isDark);
    panel.classList.toggle("cu-light", !isDark);
  }

  function ensureMounted() {
    const point = findMountPoint();
    if (point) {
      if (panel.parentElement !== point.parent || panel.nextElementSibling !== point.before) {
        point.parent.insertBefore(panel, point.before);
      }
      applyTheme(point.parent);
    } else if (panel.parentElement) {
      panel.remove();
    }
  }

  let mountScheduled = false;
  new MutationObserver(() => {
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(() => {
      mountScheduled = false;
      ensureMounted();
    });
  }).observe(document.body, { childList: true, subtree: true });

  async function getOrgs() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch("/api/organizations", { credentials: "include", cache: "no-store" });
      if (res.ok) {
        const orgs = await res.json();
        if (!Array.isArray(orgs) || orgs.length === 0) throw new Error("no orgs found");
        return orgs;
      }
      if (res.status !== 403 || attempt === 2) {
        throw new Error(`organizations: HTTP ${res.status}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  async function fetchUsage(orgId) {
    const res = await fetch(`/api/organizations/${orgId}/usage`, { credentials: "include", cache: "no-store" });
    if (!res.ok) {
      const err = new Error(`usage: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function getUsage() {
    if (cachedOrgId) {
      try {
        return await fetchUsage(cachedOrgId);
      } catch (e) {
        if (e.status !== 403) throw e;
        cachedOrgId = null;
      }
    }
    const orgs = await getOrgs();
    let lastErr;
    for (const org of orgs) {
      try {
        const usage = await fetchUsage(org.uuid);
        cachedOrgId = org.uuid;
        return usage;
      } catch (e) {
        lastErr = e;
        if (e.status !== 403) throw e;
      }
    }
    throw new Error(`usage: 403 on all ${orgs.length} orgs`);
  }

  function fmtResetIn(iso) {
    if (!iso) return "";
    const diffMs = new Date(iso) - new Date();
    if (diffMs <= 0) return "resets soon";
    const mins = Math.round(diffMs / 60000);
    if (mins < 60) return `resets in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rMin = mins % 60;
    if (hrs < 24) return `resets in ${hrs}h ${rMin}m`;
    const days = Math.floor(hrs / 24);
    return `resets in ${days}d ${hrs % 24}h`;
  }

  function makeChip(label, pct, sub) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    const chip = document.createElement("span");
    chip.className = "cu-chip";

    const labelEl = document.createElement("span");
    labelEl.className = "cu-label";
    labelEl.textContent = label;
    chip.appendChild(labelEl);

    const bar = document.createElement("span");
    bar.className = "cu-bar";
    const fill = document.createElement("span");
    fill.className = "cu-fill";
    fill.style.width = clamped + "%";
    bar.appendChild(fill);
    chip.appendChild(bar);

    const value = document.createElement("span");
    value.className = "cu-value";
    value.textContent = clamped.toFixed(1) + "%";
    chip.appendChild(value);

    if (sub) {
      const subEl = document.createElement("span");
      subEl.className = "cu-sub";
      subEl.textContent = "· " + sub;
      chip.appendChild(subEl);
    }

    return chip;
  }

  function render(usage) {
    chips.replaceChildren();
    let any = false;
    const add = (label, pct, sub) => {
      chips.appendChild(makeChip(label, pct, sub));
      any = true;
    };
    if (usage.five_hour) {
      add("5-hour", usage.five_hour.utilization, fmtResetIn(usage.five_hour.resets_at));
    }
    if (usage.seven_day) {
      add("Weekly", usage.seven_day.utilization, fmtResetIn(usage.seven_day.resets_at));
    }
    if (usage.seven_day_opus) {
      add("Opus weekly", usage.seven_day_opus.utilization, fmtResetIn(usage.seven_day_opus.resets_at));
    }
    if (usage.seven_day_sonnet) {
      add("Sonnet weekly", usage.seven_day_sonnet.utilization, fmtResetIn(usage.seven_day_sonnet.resets_at));
    }
    if (usage.extra_usage && usage.extra_usage.is_enabled) {
      const eu = usage.extra_usage;
      add("Credits", eu.utilization, `$${(Number(eu.used_credits) / 100).toFixed(2)} spent`);
    }
    if (!any) setStatus("cu-empty", "No usage data");
  }

  async function load() {
    setStatus("cu-loading", "Loading…");
    try {
      const usage = await getUsage();
      render(usage);
    } catch (err) {
      setStatus("cu-error", err.message);
    }
  }

  ensureMounted();
  load();
  setInterval(load, 60_000);
})();
