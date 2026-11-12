#!/usr/bin/env node
// DOM → Figma migration bridge (the code → design half).
//
// Connects to the fork's CDP browser, opens a fresh tab, waits until the page
// is rendered (CSS/Tailwind resolved by the browser itself), walks the DOM and
// emits a build_from_spec spec. With --dry the spec is printed; otherwise it
// is POSTed to the leader /rpc endpoint. The reverse direction is export_code.

const PLAYWRIGHT_PATH = "/home/jaime/projects/grweb-kraken/frontend/node_modules/playwright/index.mjs";

const USAGE = `usage: dom2figma.mjs <url> [options]

Snapshot a rendered page and rebuild it in Figma via build_from_spec.

options:
  --cdp <url>        CDP endpoint of the browser  (default http://127.0.0.1:9395)
  --rpc <url>        figma-mcp-go leader base URL (default http://127.0.0.1:1996)
  --sel <css>        root selector to migrate     (default document.body)
  --max-nodes <n>    stop after n emitted nodes   (default 300)
  --max-depth <n>    stop recursing past depth n  (default 8)
  --wait <ms>        extra settle time for fonts/animations (default 4000)
  --snap <px>        snap coordinates to a grid, 0 disables (default 0)
  --position <x,y>   where build_from_spec places the root frame
                     (default: the root element's page position)
  --name <name>      root node name               (default: document.title)
  --dry              print the spec JSON instead of posting it
`;

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const parseArgs = (argv) => {
  const opts = {
    cdp: "http://127.0.0.1:9395",
    rpc: "http://127.0.0.1:1996",
    sel: null,
    maxNodes: 300,
    maxDepth: 8,
    wait: 4000,
    snap: 0,
    position: null,
    name: null,
    dry: false,
    url: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case "--cdp":
        opts.cdp = next();
        break;
      case "--rpc":
        opts.rpc = next();
        break;
      case "--sel":
        opts.sel = next();
        break;
      case "--max-nodes":
        opts.maxNodes = parseInt(next(), 10);
        break;
      case "--max-depth":
        opts.maxDepth = parseInt(next(), 10);
        break;
      case "--wait":
        opts.wait = parseInt(next(), 10);
        break;
      case "--snap":
        opts.snap = parseInt(next(), 10);
        break;
      case "--position": {
        const parts = next().split(",").map((v) => parseFloat(v.trim()));
        if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v))) fail("--position expects <x,y>");
        opts.position = { x: parts[0], y: parts[1] };
        break;
      }
      case "--name":
        opts.name = next();
        break;
      case "--dry":
        opts.dry = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) fail(`unknown option ${arg}`);
        if (opts.url) fail("unexpected extra argument");
        opts.url = arg;
    }
  }
  if (!opts.url) fail(`no url given\n\n${USAGE}`);
  if ([opts.maxNodes, opts.maxDepth, opts.wait, opts.snap].some((v) => !Number.isFinite(v) || v < 0)) {
    fail("numeric options must be >= 0");
  }
  return opts;
};

// Runs inside the page. Everything it needs is passed in or defined locally.
const walkPage = ({ selector, maxNodes, maxDepth, snap }) => {
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };
  const counts = { nodes: 0, auto: 0, frame: 0, text: 0, image: 0, icon: 0, nodeCapped: 0, depthCapped: 0 };

  const r1 = (v) => Math.round(v * 10) / 10;
  const rv = (v) => {
    let n = r1(v);
    if (snap > 0) n = Math.round(n / snap) * snap;
    return r1(n);
  };
  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  const clean = (s) => String(s).replace(/\s+/g, " ").trim();

  // Computed colors can be oklch()/lab()/color-mix() — canvas normalizes any
  // CSS color to a hex/rgba string, so parse that instead of the raw value.
  const ctx2d = document.createElement("canvas").getContext("2d");
  const toHex = (css) => {
    if (!css || typeof css !== "string") return null;
    ctx2d.fillStyle = "#000000";
    ctx2d.fillStyle = css;
    const value = String(ctx2d.fillStyle);
    let r = null;
    let g = null;
    let b = null;
    let a = 1;
    if (value.startsWith("#")) {
      r = parseInt(value.slice(1, 3), 16);
      g = parseInt(value.slice(3, 5), 16);
      b = parseInt(value.slice(5, 7), 16);
    } else {
      const m = value.match(/^(rgba?|color)\(([^)]+)\)$/);
      if (!m) return null;
      const parts = m[2].split(/[\s,/]+/).filter(Boolean).map(Number);
      if (m[1] === "color") {
        if (parts.length < 3) return null;
        r = parts[0] * 255;
        g = parts[1] * 255;
        b = parts[2] * 255;
        a = parts.length > 3 ? parts[3] : 1;
      } else {
        if (parts.length < 3) return null;
        r = parts[0];
        g = parts[1];
        b = parts[2];
        a = parts.length > 3 ? parts[3] : 1;
      }
    }
    if ([r, g, b, a].some((v) => !Number.isFinite(v))) return null;
    if (a <= 0.02) return null;
    const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  };

  const weightOf = (value) => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return "regular";
    if (n >= 700) return "bold";
    if (n >= 600) return "semibold";
    if (n >= 500) return "medium";
    return "regular";
  };

  const ALIGN_MAIN = {
    "flex-start": "start",
    "flex-end": "end",
    center: "center",
    "space-between": "space-between",
    "space-around": "space-around",
    "space-evenly": "space-evenly",
    start: "start",
    end: "end",
    left: "start",
    right: "end",
  };
  const ALIGN_COUNTER = {
    "flex-start": "start",
    "flex-end": "end",
    center: "center",
    baseline: "start",
    stretch: "start",
    normal: "start",
  };

  const nameOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? "#" + el.id : "";
    const cls = clean(el.getAttribute("class") || "").split(" ")[0];
    return (tag + (id || (cls ? "." + cls : ""))).slice(0, 60);
  };

  const padOf = (cs) => {
    const pad = { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
    if (!(pad.t > 0 || pad.r > 0 || pad.b > 0 || pad.l > 0)) return undefined;
    return { t: rv(pad.t), r: rv(pad.r), b: rv(pad.b), l: rv(pad.l) };
  };

  const radiusOf = (cs, w, h) => {
    const conv = (v) => {
      const n = parseFloat(v);
      if (!Number.isFinite(n)) return 0;
      return String(v).endsWith("%") ? (n / 100) * Math.min(w, h) : n;
    };
    const parts = cs.borderRadius.trim().split(/\s+/);
    let corners;
    if (parts.length <= 1) corners = [conv(parts[0]), conv(parts[0]), conv(parts[0]), conv(parts[0])];
    else if (parts.length === 2) {
      const [a, b] = parts.map(conv);
      corners = [a, b, a, b];
    } else if (parts.length === 3) {
      const [a, b, c] = parts.map(conv);
      corners = [a, b, c, b];
    } else corners = parts.slice(0, 4).map(conv);
    const allEqual = corners.every((c) => Math.abs(c - corners[0]) < 0.5);
    const value = Math.min(allEqual ? corners[0] : Math.max(...corners), Math.min(w, h) / 2);
    return value > 0 ? rv(value) : undefined;
  };

  const alignOf = (cs) => {
    const align = {};
    if (ALIGN_MAIN[cs.justifyContent]) align.main = ALIGN_MAIN[cs.justifyContent];
    if (ALIGN_COUNTER[cs.alignItems]) align.counter = ALIGN_COUNTER[cs.alignItems];
    return Object.keys(align).length ? align : undefined;
  };

  let rootEl;
  try {
    rootEl = (selector && document.querySelector(selector)) || document.body;
  } catch (e) {
    return { spec: null, counts: counts, rootPage: null, error: "invalid selector: " + e.message };
  }
  const rootRect = rootEl.getBoundingClientRect();
  const rootPage = { x: rootRect.left + window.scrollX, y: rootRect.top + window.scrollY };

  const budget = () => {
    if (counts.nodes >= maxNodes) {
      counts.nodeCapped++;
      return false;
    }
    return true;
  };

  const pageXY = (rect) => ({
    x: rv(rect.left + window.scrollX - rootPage.x),
    y: rv(rect.top + window.scrollY - rootPage.y),
  });

  // Direct text-node children become their own text specs, measured with a Range.
  const textChildSpec = (textNode, cs, inAuto) => {
    const chars = clean(textNode.textContent);
    if (!chars) return null;
    const range = document.createRange();
    range.selectNode(textNode);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (!budget()) return null;
    counts.nodes++;
    counts.text++;
    const spec = {
      type: "text",
      name: chars.slice(0, 40),
      text: { chars: chars, size: Math.round(px(cs.fontSize)), weight: weightOf(cs.fontWeight), color: toHex(cs.color) || "#000000" },
      w: rv(rect.width),
      h: rv(rect.height),
    };
    if (!inAuto) {
      const pos = pageXY(rect);
      spec.x = pos.x;
      spec.y = pos.y;
    }
    return spec;
  };

  const walk = (el, depth, inAuto) => {
    // SVG is replaced by a vector placeholder, never walked.
    if (el.namespaceURI === "http://www.w3.org/2000/svg") {
      const rect = el.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 12) return null;
      if (!budget()) return null;
      counts.nodes++;
      counts.icon++;
      const label = clean(el.getAttribute("aria-label") || el.getAttribute("class") || "svg").split(" ")[0].slice(0, 40);
      const spec = { type: "ellipse", name: "icon:" + label, w: rv(rect.width), h: rv(rect.height) };
      if (!inAuto) {
        const pos = pageXY(rect);
        spec.x = pos.x;
        spec.y = pos.y;
      }
      return spec;
    }
    if (SKIP_TAGS[el.tagName]) return null;

    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (el.getClientRects().length === 0) return null;
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return null;
    if (el.getAttribute("aria-hidden") === "true") return null;
    if (rect.width <= 0 || rect.height <= 0) return null;
    if (depth > maxDepth) {
      counts.depthCapped++;
      return null;
    }
    if (!budget()) return null;

    const place = (spec) => {
      if (!inAuto) {
        const pos = pageXY(rect);
        spec.x = pos.x;
        spec.y = pos.y;
      }
      return spec;
    };

    // Images become gray placeholders; unloaded ones are skipped.
    if (el.tagName === "IMG") {
      if (!el.complete || el.naturalWidth <= 0) return null;
      counts.nodes++;
      counts.image++;
      const src = clean(el.getAttribute("src") || "");
      const file = clean(src.split("?")[0].split("/").pop()) || "image";
      const label = clean(el.getAttribute("alt") || "").slice(0, 60) || file.slice(0, 60);
      return place({ type: "rectangle", name: "img:" + label, fill: "#e5e7eb", w: rv(rect.width), h: rv(rect.height) });
    }

    const fill = toHex(cs.backgroundColor);
    const radius = radiusOf(cs, rect.width, rect.height);
    const note = cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.overflowY === "hidden" ? "overflow hidden" : undefined;
    const hasElementChildren = el.children.length > 0;

    // Flex containers become auto-layout frames; children positions come from
    // the layout itself, so no x/y is written for them.
    if (cs.display === "flex" || cs.display === "inline-flex") {
      counts.nodes++;
      counts.auto++;
      // No `hug` key: omitted = FIXED axes (measured w/h), which is what a
      // fidelity migration wants. The grammar only accepts {w,h} booleans.
      const spec = { type: "auto", dir: cs.flexDirection.startsWith("column") ? "v" : "h", name: nameOf(el) };
      const gap = px(cs.flexDirection.startsWith("column") ? cs.columnGap : cs.rowGap);
      if (gap > 0) spec.gap = rv(gap);
      const pad = padOf(cs);
      if (pad) spec.pad = pad;
      const align = alignOf(cs);
      if (align) spec.align = align;
      if (fill) spec.fill = fill;
      if (radius) spec.radius = radius;
      if (note) spec.note = note;
      spec.w = rv(rect.width);
      spec.h = rv(rect.height);
      const children = [];
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const spec2 = textChildSpec(child, cs, true);
          if (spec2) children.push(spec2);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const spec2 = walk(child, depth + 1, true);
          if (spec2) children.push(spec2);
        }
      }
      if (children.length) spec.children = children;
      return place(spec);
    }

    // Text-bearing leaves carry the element's own text metrics.
    if (!hasElementChildren) {
      const chars = clean(el.textContent);
      if (!chars) {
        if (!fill && !radius && !note) return null; // invisible spacer
        counts.nodes++;
        counts.frame++;
        const spec = { type: "frame", name: nameOf(el), w: rv(rect.width), h: rv(rect.height) };
        if (fill) spec.fill = fill;
        if (radius) spec.radius = radius;
        if (note) spec.note = note;
        return place(spec);
      }
      counts.nodes++;
      counts.text++;
      const spec = {
        type: "text",
        name: chars.slice(0, 40),
        text: { chars: chars, size: Math.round(px(cs.fontSize)), weight: weightOf(cs.fontWeight), color: toHex(cs.color) || "#000000" },
        w: rv(rect.width),
        h: rv(rect.height),
      };
      if (fill) spec.fill = fill;
      if (radius) spec.radius = radius;
      return place(spec);
    }

    // Plain block containers become frames; children keep their absolute page
    // coordinates minus the root origin, so positions survive the migration.
    counts.nodes++;
    counts.frame++;
    const spec = { type: "frame", name: nameOf(el), w: rv(rect.width), h: rv(rect.height) };
    if (fill) spec.fill = fill;
    if (radius) spec.radius = radius;
    if (note) spec.note = note;
    const children = [];
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const spec2 = textChildSpec(child, cs, false);
        if (spec2) children.push(spec2);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const spec2 = walk(child, depth + 1, false);
        if (spec2) children.push(spec2);
      }
    }
    if (children.length) spec.children = children;
    return place(spec);
  };

  const spec = walk(rootEl, 0, false);
  if (spec) {
    delete spec.x;
    delete spec.y;
  }
  return { spec: spec, counts: counts, rootPage: rootPage, title: document.title };
};

// For --dry: keep two levels of children, replace deeper ones with counts.
const summarize = (node, depth = 0) => {
  if (!Array.isArray(node.children) || node.children.length === 0) return { ...node };
  if (depth >= 2) return { ...node, children: `<${node.children.length} children omitted>` };
  return { ...node, children: node.children.map((child) => summarize(child, depth + 1)) };
};

const lineOf = (counts) =>
  `nodes ${counts.nodes} (auto ${counts.auto}, frame ${counts.frame}, text ${counts.text}, image ${counts.image}, icon ${counts.icon})` +
  (counts.nodeCapped ? ` — node cap hit ${counts.nodeCapped}x` : "") +
  (counts.depthCapped ? ` — depth cap hit ${counts.depthCapped}x` : "");

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let chromium;
  try {
    ({ chromium } = await import(PLAYWRIGHT_PATH));
  } catch {
    ({ chromium } = await import("playwright"));
  }

  const browser = await chromium.connectOverCDP(opts.cdp);
  const context = browser.contexts()[0];
  const page = context ? await context.newPage() : await browser.newPage();
  try {
    if (context) {
      try {
        await context.grantPermissions(["local-network-access"]);
      } catch (e) {
        console.warn(`grantPermissions skipped: ${e.message}`);
      }
    }

    await page.goto(opts.url, { waitUntil: "load", timeout: 45000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: Math.min(10000, opts.wait || 10000) });
    } catch {
      // Pages with keepalive connections never go idle; --wait covers them.
    }
    try {
      await page.evaluate(() => document.fonts.ready);
    } catch {
      // Font loading is best-effort.
    }
    if (opts.wait > 0) await page.waitForTimeout(opts.wait);

    const result = await page.evaluate(walkPage, {
      selector: opts.sel,
      maxNodes: opts.maxNodes,
      maxDepth: opts.maxDepth,
      snap: opts.snap,
    });
    if (!result || !result.spec) {
      console.error(`nothing captured: ${(result && result.error) || "root element empty or hidden"}`);
      process.exitCode = 1;
      return;
    }

    const name = opts.name || (result.title || "").trim() || "page";
    result.spec.name = name;
    const r1 = (v) => Math.round(v * 10) / 10;
    const position = opts.position || { x: r1(result.rootPage.x), y: r1(result.rootPage.y) };

    if (opts.dry) {
      console.log(`[dry] ${opts.url} → spec "${name}" at (${position.x}, ${position.y})`);
      console.log(JSON.stringify(summarize(result.spec), null, 2));
      console.log(`[dry] ${lineOf(result.counts)}`);
      return;
    }

    const headers = { "content-type": "application/json" };
    if (process.env.FIGMA_MCP_TOKEN) headers["x-figma-mcp-token"] = process.env.FIGMA_MCP_TOKEN;
    const rpcUrl = opts.rpc.replace(/\/+$/, "") + "/rpc";
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ tool: "build_from_spec", params: { spec: result.spec, position: position, name: name } }),
    });
    const body = await res.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      // Non-JSON error bodies are reported raw below.
    }
    if (!res.ok || !json || json.error) {
      console.error(`rpc failed (${res.status}): ${(json && json.error) || body.slice(0, 500)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`build_from_spec "${name}" → ${rpcUrl} ok — ${lineOf(result.counts)}`);
    console.log(JSON.stringify(json.data).slice(0, 2000));
  } finally {
    // Only the tab this script opened is closed, never the browser.
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
