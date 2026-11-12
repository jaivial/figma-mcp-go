// Serializer

const isMixed = (value) => typeof value === "symbol";

const toHex = (color) => {
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v * 255)));
  const [r, g, b] = [clamp(color.r), clamp(color.g), clamp(color.b)];
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

const serializePaints = (paints) => {
  if (isMixed(paints) || !paints || !Array.isArray(paints)) {
    return isMixed(paints) ? "mixed" : [];
  }
  return paints
    .filter((paint) => paint.type === "SOLID" && "color" in paint)
    .map((paint) => ({
      type: paint.type,
      color: paint.type === "SOLID" ? toHex(paint.color) : undefined,
      opacity: paint.opacity,
    }));
};

const getBounds = (node) => {
  if ("x" in node && "y" in node && "width" in node && "height" in node) {
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  }
  return undefined;
};

const serializeStyles = (node) => {
  const styles = {};
  if ("fills" in node) styles.fills = serializePaints(node.fills);
  if ("strokes" in node) styles.strokes = serializePaints(node.strokes);
  if ("cornerRadius" in node) {
    styles.cornerRadius = isMixed(node.cornerRadius) ? "mixed" : node.cornerRadius;
  }
  if ("paddingLeft" in node) {
    styles.padding = {
      top: node.paddingTop,
      right: node.paddingRight,
      bottom: node.paddingBottom,
      left: node.paddingLeft,
    };
  }
  return styles;
};

const serializeText = (node, base) => {
  let font;
  if (typeof node.fontName === "symbol") {
    font = "mixed";
  } else if (node.fontName) {
    font = node.fontName.family;
  }
  return Object.assign({}, base, {
    characters: node.characters,
    styles: Object.assign({}, base.styles, {
      fontSize: isMixed(node.fontSize) ? "mixed" : node.fontSize,
      fontFamily: font,
      textAlignHorizontal: isMixed(node.textAlignHorizontal) ? "mixed" : node.textAlignHorizontal,
    }),
  });
};

const serializeNode = (node) => {
  const base = {
    id: node.id,
    name: node.name,
    type: node.type,
    bounds: getBounds(node),
    styles: serializeStyles(node),
  };
  if (node.type === "TEXT") return serializeText(node, base);
  if ("children" in node) {
    return Object.assign({}, base, { children: node.children.map((child) => serializeNode(child)) });
  }
  return base;
};

// Plugin core

const sendStatus = () => {
  figma.ui.postMessage({
    type: "plugin-status",
    payload: {
      fileName: figma.root.name,
      selectionCount: figma.currentPage.selection.length,
    },
  });
};

const serializeVariableValue = (value) => {
  if (typeof value === "object" && value !== null) {
    if ("type" in value && value.type === "VARIABLE_ALIAS") {
      return { type: "VARIABLE_ALIAS", id: value.id };
    }
    if ("r" in value && "g" in value && "b" in value) {
      return { type: "COLOR", r: value.r, g: value.g, b: value.b, a: "a" in value ? value.a : 1 };
    }
  }
  return value;
};

const handleRequest = async (request) => {
  try {
    switch (request.type) {
      case "get_document":
        return { type: request.type, requestId: request.requestId, data: serializeNode(figma.currentPage) };

      case "get_selection":
        return {
          type: request.type,
          requestId: request.requestId,
          data: figma.currentPage.selection.map((node) => serializeNode(node)),
        };

      case "get_node": {
        const nodeId = request.nodeIds && request.nodeIds[0];
        if (!nodeId) throw new Error("nodeIds is required for get_node");
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node || node.type === "DOCUMENT") throw new Error(`Node not found: ${nodeId}`);
        return { type: request.type, requestId: request.requestId, data: serializeNode(node) };
      }

      case "get_styles": {
        const [paintStyles, textStyles, effectStyles, gridStyles] = await Promise.all([
          figma.getLocalPaintStylesAsync(),
          figma.getLocalTextStylesAsync(),
          figma.getLocalEffectStylesAsync(),
          figma.getLocalGridStylesAsync(),
        ]);
        return {
          type: request.type,
          requestId: request.requestId,
          data: {
            paints: paintStyles.map((s) => ({ id: s.id, name: s.name, paints: s.paints })),
            text: textStyles.map((s) => ({ id: s.id, name: s.name, fontSize: s.fontSize, fontName: s.fontName })),
            effects: effectStyles.map((s) => ({ id: s.id, name: s.name, effects: s.effects })),
            grids: gridStyles.map((s) => ({ id: s.id, name: s.name, layoutGrids: s.layoutGrids })),
          },
        };
      }

      case "get_metadata":
        return {
          type: request.type,
          requestId: request.requestId,
          data: {
            fileName: figma.root.name,
            currentPageId: figma.currentPage.id,
            currentPageName: figma.currentPage.name,
            pageCount: figma.root.children.length,
            pages: figma.root.children.map((page) => ({ id: page.id, name: page.name })),
          },
        };

      case "get_design_context": {
        const depth = (request.params && request.params.depth != null) ? request.params.depth : 2;
        const serializeWithDepth = async (node, currentDepth) => {
          const serialized = serializeNode(node);
          if (currentDepth >= depth && serialized.children) {
            return Object.assign({}, serialized, { children: undefined, childCount: node.children ? node.children.length : 0 });
          }
          if (serialized.children) {
            const childNodes = await Promise.all(
              serialized.children.map((child) => figma.getNodeByIdAsync(child.id))
            );
            const serializedChildren = await Promise.all(
              childNodes
                .filter((n) => n !== null && n.type !== "DOCUMENT")
                .map((n) => serializeWithDepth(n, currentDepth + 1))
            );
            return Object.assign({}, serialized, { children: serializedChildren });
          }
          return serialized;
        };
        const selection = figma.currentPage.selection;
        const contextNodes =
          selection.length > 0
            ? await Promise.all(selection.map((node) => serializeWithDepth(node, 0)))
            : [await serializeWithDepth(figma.currentPage, 0)];
        return {
          type: request.type,
          requestId: request.requestId,
          data: {
            fileName: figma.root.name,
            currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
            selectionCount: selection.length,
            context: contextNodes,
          },
        };
      }

      case "get_variable_defs": {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const variableData = await Promise.all(
          collections.map(async (collection) => {
            const variables = await Promise.all(
              collection.variableIds.map((id) => figma.variables.getVariableByIdAsync(id))
            );
            return {
              id: collection.id,
              name: collection.name,
              modes: collection.modes.map((mode) => ({ modeId: mode.modeId, name: mode.name })),
              variables: variables
                .filter((v) => v !== null)
                .map((variable) => ({
                  id: variable.id,
                  name: variable.name,
                  resolvedType: variable.resolvedType,
                  valuesByMode: Object.fromEntries(
                    Object.entries(variable.valuesByMode).map(([modeId, value]) => [
                      modeId,
                      serializeVariableValue(value),
                    ])
                  ),
                })),
            };
          })
        );
        return { type: request.type, requestId: request.requestId, data: { collections: variableData } };
      }

      case "get_screenshot": {
        const format = (request.params && request.params.format) ? request.params.format : "PNG";
        const scale = (request.params && request.params.scale != null) ? request.params.scale : 2;
        let targetNodes;
        if (request.nodeIds && request.nodeIds.length > 0) {
          const nodes = await Promise.all(request.nodeIds.map((id) => figma.getNodeByIdAsync(id)));
          targetNodes = nodes.filter((n) => n !== null && n.type !== "DOCUMENT" && n.type !== "PAGE");
        } else {
          targetNodes = figma.currentPage.selection.slice();
        }
        if (targetNodes.length === 0) throw new Error("No nodes to export. Select nodes or provide nodeIds.");
        const exports = await Promise.all(
          targetNodes.map(async (node) => {
            const settings =
              format === "SVG" ? { format: "SVG" }
              : format === "PDF" ? { format: "PDF" }
              : format === "JPG" ? { format: "JPG", constraint: { type: "SCALE", value: scale } }
              : { format: "PNG", constraint: { type: "SCALE", value: scale } };
            const bytes = await node.exportAsync(settings);
            const base64 = figma.base64Encode(bytes);
            return { nodeId: node.id, nodeName: node.name, format, base64, width: node.width, height: node.height };
          })
        );
        return { type: request.type, requestId: request.requestId, data: { exports } };
      }

      case "get_nodes_info": {
        if (!request.nodeIds || request.nodeIds.length === 0) throw new Error("nodeIds is required for get_nodes_info");
        const nodes = await Promise.all(request.nodeIds.map((id) => figma.getNodeByIdAsync(id)));
        return {
          type: request.type,
          requestId: request.requestId,
          data: nodes.filter((n) => n !== null && n.type !== "DOCUMENT").map((n) => serializeNode(n)),
        };
      }

      case "get_local_components": {
        const pages = figma.root.children;
        const allComponents = [];
        for (let i = 0; i < pages.length; i++) {
          const page = pages[i];
          await page.loadAsync();
          const pageComponents = page.findAllWithCriteria({ types: ["COMPONENT"] });
          for (const component of pageComponents) {
            allComponents.push({
              id: component.id,
              name: component.name,
              key: "key" in component ? component.key : null,
            });
          }
          figma.ui.postMessage({
            type: "progress_update",
            requestId: request.requestId,
            progress: Math.round(((i + 1) / pages.length) * 90) + 1,
            message: `Scanned ${page.name}: ${allComponents.length} components so far`,
          });
          await new Promise((r) => setTimeout(r, 0));
        }
        return { type: request.type, requestId: request.requestId, data: { count: allComponents.length, components: allComponents } };
      }

      case "get_annotations": {
        const nodeId = request.params && request.params.nodeId;
        const nodeAnnotations = (n) => {
          const anns = n.annotations;
          return Array.isArray(anns) ? anns : null;
        };
        if (nodeId) {
          const node = await figma.getNodeByIdAsync(nodeId);
          if (!node) throw new Error(`Node not found: ${nodeId}`);
          const mergedAnnotations = [];
          const collect = async (n) => {
            const anns = nodeAnnotations(n);
            if (anns) for (const a of anns) mergedAnnotations.push({ nodeId: n.id, annotation: a });
            if ("children" in n) for (const child of n.children) await collect(child);
          };
          await collect(node);
          return { type: request.type, requestId: request.requestId, data: { nodeId: node.id, name: node.name, annotations: mergedAnnotations } };
        } else {
          const annotated = [];
          const processNode = async (n) => {
            const anns = nodeAnnotations(n);
            if (anns && anns.length > 0) annotated.push({ nodeId: n.id, name: n.name, annotations: anns });
            if ("children" in n) for (const child of n.children) await processNode(child);
          };
          await processNode(figma.currentPage);
          return { type: request.type, requestId: request.requestId, data: { annotatedNodes: annotated } };
        }
      }

      case "scan_text_nodes": {
        const nodeId = request.params && request.params.nodeId;
        if (!nodeId) throw new Error("nodeId is required for scan_text_nodes");
        const root = await figma.getNodeByIdAsync(nodeId);
        if (!root) throw new Error(`Node not found: ${nodeId}`);
        const textNodes = [];
        const findText = async (n) => {
          if (n.type === "TEXT") {
            textNodes.push({ id: n.id, name: n.name, characters: n.characters, fontSize: n.fontSize, fontName: n.fontName });
          }
          if ("children" in n) for (const child of n.children) await findText(child);
        };
        figma.ui.postMessage({ type: "progress_update", requestId: request.requestId, progress: 10, message: "Scanning text nodes..." });
        await new Promise((r) => setTimeout(r, 0));
        await findText(root);
        return { type: request.type, requestId: request.requestId, data: { count: textNodes.length, textNodes } };
      }

      case "scan_nodes_by_types": {
        const nodeId = request.params && request.params.nodeId;
        const types = (request.params && request.params.types) ? request.params.types : [];
        if (!nodeId) throw new Error("nodeId is required for scan_nodes_by_types");
        if (types.length === 0) throw new Error("types must be a non-empty array");
        const root = await figma.getNodeByIdAsync(nodeId);
        if (!root) throw new Error(`Node not found: ${nodeId}`);
        const matchingNodes = [];
        const findByTypes = async (n) => {
          if ("visible" in n && !n.visible) return;
          if (types.includes(n.type)) {
            matchingNodes.push({
              id: n.id,
              name: n.name,
              type: n.type,
              bbox: { x: "x" in n ? n.x : 0, y: "y" in n ? n.y : 0, width: "width" in n ? n.width : 0, height: "height" in n ? n.height : 0 },
            });
          }
          if ("children" in n) for (const child of n.children) await findByTypes(child);
        };
        figma.ui.postMessage({ type: "progress_update", requestId: request.requestId, progress: 10, message: `Scanning for types: ${types.join(", ")}...` });
        await new Promise((r) => setTimeout(r, 0));
        await findByTypes(root);
        return { type: request.type, requestId: request.requestId, data: { count: matchingNodes.length, matchingNodes, searchedTypes: types } };
      }

      case "execute_code": {
        const code = request.params && request.params.code;
        const rollback = !!(request.params && request.params.rollback);
        if (typeof code !== "string" || !code.trim()) throw new Error("code is required");
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const preludeLines = EXEC_PRELUDE.split("\n").length;
        const beforeIds = collectIds();
        let run;
        try {
          run = new AsyncFunction("figma", EXEC_PRELUDE + "\n" + code);
        } catch (error) {
          // Syntax errors never run user code, so nothing could have changed.
          return {
            type: request.type,
            requestId: request.requestId,
            data: Object.assign(
              { error: errorMessage(error), phase: "compile" },
              locateUserCodeError(error, code, preludeLines)
            ),
          };
        }
        let result;
        try {
          result = await run(figma);
        } catch (error) {
          const diff = diffIds(beforeIds, collectIds());
          const changed = diff ? await changeManifest(diff) : { skipped: "page too large" };
          if (rollback && diff) changed.rolledBack = await rollbackCreated(diff.createdIds);
          return {
            type: request.type,
            requestId: request.requestId,
            data: Object.assign(
              { error: errorMessage(error), phase: "run", changed: changed },
              locateUserCodeError(error, code, preludeLines)
            ),
          };
        }
        const diff = diffIds(beforeIds, collectIds());
        const changed = diff ? await changeManifest(diff) : { skipped: "page too large" };
        // Only JSON-safe data travels back (a node would not serialise).
        let data;
        try {
          data = result === undefined ? null : JSON.parse(JSON.stringify(result));
        } catch (e) {
          data = String(result);
        }
        return { type: request.type, requestId: request.requestId, data: { result: data, changed: changed } };
      }

      case "validate_layout": {
        const nodeId = request.params && request.params.nodeId;
        if (!nodeId) throw new Error("nodeId is required for validate_layout");
        const root = await figma.getNodeByIdAsync(nodeId);
        if (!root) throw new Error(`Node not found: ${nodeId}`);
        const gridParam = (request.params && request.params.grid) || 8;
        const grid = typeof gridParam === "number" && gridParam > 0 ? gridParam : 8;
        const checks = validateChecks(request.params && request.params.checks);
        return { type: request.type, requestId: request.requestId, data: validateLayout(root, grid, checks) };
      }

      default:
        throw new Error(`Unknown request type: ${request.type}`);
    }
  } catch (error) {
    return {
      type: request.type,
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

figma.showUI(__html__, { width: 320, height: 180 });
sendStatus();

figma.on("selectionchange", () => {
  sendStatus();
});

figma.ui.onmessage = async (message) => {
  if (message.type === "ui-ready") {
    sendStatus();
    return;
  }
  if (message.type === "server-request") {
    const response = await handleRequest(message.payload);
    try {
      figma.ui.postMessage(response);
    } catch (err) {
      figma.ui.postMessage({
        type: response.type,
        requestId: response.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

// ── execute_code helpers ─────────────────────────────────────────────────────

// Snippet prepended to every execute_code run: small helpers the user code can rely on.
const EXEC_PRELUDE = `const snap = (v, g = 8) => Math.round(v / g) * g;
const round2 = (v) => Math.round(v * 100) / 100;
const boundsOf = (n) => {
  const b = n && n.absoluteBoundingBox;
  return b
    ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
    : undefined;
};
const loadFonts = async (...nodes) => {
  const flat = nodes.flat(Infinity);
  const fonts = new Set();
  for (const n of flat) {
    if (!n || n.type !== "TEXT") continue;
    const font = n.fontName;
    if (typeof font === "symbol") {
      n.getRangeAllFontNames(0, n.characters.length).forEach((f) => fonts.add(f.family + "|" + f.style));
    } else {
      fonts.add(font.family + "|" + font.style);
    }
  }
  await Promise.all(
    Array.from(fonts).map((key) => {
      const [family, style] = key.split("|");
      return figma.loadFontAsync({ family: family, style: style });
    })
  );
  return flat;
};
const layoutInfo = (f) => {
  if (!f || !("layoutMode" in f) || !f.layoutMode || f.layoutMode === "NONE") return undefined;
  return {
    mode: f.layoutMode,
    spacing: f.itemSpacing,
    padding: { t: f.paddingTop, r: f.paddingRight, b: f.paddingBottom, l: f.paddingLeft },
    primarySizing: f.primaryAxisSizingMode,
    counterSizing: f.counterAxisSizingMode,
  };
};`;

// Walk the current page collecting every node id; null when the page is too large to diff.
const collectIds = (max = 20000) => {
  const ids = new Set();
  const stack = [figma.currentPage];
  while (stack.length > 0) {
    if (ids.size >= max) return null;
    const node = stack.pop();
    ids.add(node.id);
    if ("children" in node && node.children) for (const child of node.children) stack.push(child);
  }
  return ids;
};

// Diff two page snapshots; null when either snapshot was skipped.
const diffIds = (before, after) => {
  if (!before || !after) return null;
  return {
    createdIds: Array.from(after).filter((id) => !before.has(id)),
    removedIds: Array.from(before).filter((id) => !after.has(id)),
  };
};

// Manifest of what a run changed: capped lists plus the full counts.
const changeManifest = async (diff) => {
  const nodes = await Promise.all(diff.createdIds.slice(0, 50).map((id) => figma.getNodeByIdAsync(id)));
  return {
    createdCount: diff.createdIds.length,
    removedCount: diff.removedIds.length,
    created: nodes.filter((n) => n !== null).map((n) => ({ id: n.id, name: n.name, type: n.type })),
    removed: diff.removedIds.slice(0, 50),
  };
};

// Best-effort rollback: delete the nodes a failed run created.
const rollbackCreated = async (createdIds) => {
  let removed = 0;
  for (const id of createdIds) {
    try {
      const node = await figma.getNodeByIdAsync(id);
      if (node && typeof node.remove === "function") {
        node.remove();
        removed++;
      }
    } catch (e) {
      // Tolerated: the node may already be gone with a deleted parent.
    }
  }
  return removed;
};

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

// Locate an error in the user code: V8 frames read "at <anonymous>:L:C", where L counts
// 2 AsyncFunction preamble lines plus the prelude before the first user-code line.
const locateUserCodeError = (error, code, preludeLines) => {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const stackLines = stack ? stack.split("\n") : [];
  // A trailing bare "<anonymous>:L:C" is the user code; frames from this plugin file
  // carry a script name or a function name before the location and must not match.
  const frame = stackLines.find((l) => /(?:^|[\s(,])<anonymous>:\d+:\d+\)?\s*$/.test(l));
  let line = null;
  if (frame) {
    const userLine = parseInt(frame.match(/<anonymous>:(\d+):\d+\)?\s*$/)[1], 10) - 2 - preludeLines;
    if (userLine >= 1) line = userLine;
  }
  const codeLines = code.split("\n");
  let codeExcerpt = null;
  if (line !== null) {
    codeExcerpt = [];
    for (let i = Math.max(1, line - 2); i <= Math.min(codeLines.length, line + 2); i++) {
      codeExcerpt.push(`${i}${i === line ? ">" : ":"} ${codeLines[i - 1]}`);
    }
  }
  return { stackFirstLine: stackLines[0] || null, line: line, codeExcerpt: codeExcerpt };
};

// ── validate_layout helpers ──────────────────────────────────────────────────

const VALID_CHECKS = ["overlap", "outOfBounds", "spacing", "grid", "hug"];

// Normalise the checks argument: a subset of VALID_CHECKS, all of them when omitted.
const validateChecks = (checks) => {
  if (!Array.isArray(checks) || checks.length === 0) return VALID_CHECKS.slice();
  const unknown = checks.filter((c) => !VALID_CHECKS.includes(c));
  if (unknown.length > 0) {
    throw new Error(`Unknown checks: ${unknown.join(", ")} (valid: ${VALID_CHECKS.join(", ")})`);
  }
  return checks.slice();
};

const r2 = (v) => Math.round(v * 100) / 100;
const boundingBox = (node) => (node && node.absoluteBoundingBox) || null;
const renderBox = (node) => (node && node.absoluteRenderBounds) || null;

// Full containment (with a small tolerance) is legal layering, not an overlap.
const boxContains = (outer, inner) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

// Off-grid parent-local geometry of a node (auto-layout spacing/padding included).
const offGridValues = (node, grid) => {
  const values = {};
  const collect = (key, v) => {
    if (typeof v !== "number" || !isFinite(v)) return;
    const rounded = r2(v);
    if (rounded % grid !== 0) values[key] = rounded;
  };
  if ("x" in node) collect("x", node.x);
  if ("y" in node) collect("y", node.y);
  if ("width" in node) collect("width", node.width);
  if ("height" in node) collect("height", node.height);
  if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
    collect("itemSpacing", node.itemSpacing);
    collect("paddingTop", node.paddingTop);
    collect("paddingRight", node.paddingRight);
    collect("paddingBottom", node.paddingBottom);
    collect("paddingLeft", node.paddingLeft);
  }
  return values;
};

// Lint a subtree for the classic layout mistakes; see the validate_layout tool description.
const validateLayout = (root, grid, checks) => {
  const findings = [];
  let scanned = 0;
  let invisibleSkipped = 0;
  let truncated = false;
  const entries = [];
  const walk = (node, parent) => {
    if (scanned >= 3000) {
      truncated = true;
      return;
    }
    if ("visible" in node && !node.visible) {
      invisibleSkipped++;
      return;
    }
    scanned++;
    entries.push({ node: node, parent: parent, bb: boundingBox(node), rb: renderBox(node) });
    if ("children" in node && node.children) for (const child of node.children) walk(child, node);
  };
  walk(root, null);

  // Sibling groups drive the overlap, spacing and hug checks.
  const groups = new Map();
  for (const entry of entries) {
    if (!entry.parent) continue;
    if (!groups.has(entry.parent)) groups.set(entry.parent, []);
    groups.get(entry.parent).push(entry);
  }
  const isAutoLayout = (node) => "layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE";

  if (checks.includes("overlap")) {
    for (const children of groups.values()) {
      for (let i = 0; i < children.length; i++) {
        for (let j = i + 1; j < children.length; j++) {
          const a = children[i];
          const b = children[j];
          if (!a.rb || !b.rb) continue;
          const w = Math.min(a.rb.x + a.rb.width, b.rb.x + b.rb.width) - Math.max(a.rb.x, b.rb.x);
          const h = Math.min(a.rb.y + a.rb.height, b.rb.y + b.rb.height) - Math.max(a.rb.y, b.rb.y);
          if (w <= 0 || h <= 0 || w * h <= 1) continue;
          if (boxContains(a.rb, b.rb) || boxContains(b.rb, a.rb)) continue;
          findings.push({
            severity: "warn",
            nodeId: a.node.id,
            name: a.node.name,
            otherId: b.node.id,
            otherName: b.node.name,
            message: `partial overlap ${r2(w)}x${r2(h)} px`,
          });
        }
      }
    }
  }

  if (checks.includes("outOfBounds")) {
    for (const entry of entries) {
      if (!entry.parent || !entry.bb) continue;
      const pb = boundingBox(entry.parent);
      if (!pb) continue;
      const cb = entry.bb;
      const delta = {};
      if (pb.x - cb.x > 1) delta.left = r2(pb.x - cb.x);
      if (cb.x + cb.width - (pb.x + pb.width) > 1) delta.right = r2(cb.x + cb.width - (pb.x + pb.width));
      if (pb.y - cb.y > 1) delta.top = r2(pb.y - cb.y);
      if (cb.y + cb.height - (pb.y + pb.height) > 1) delta.bottom = r2(cb.y + cb.height - (pb.y + pb.height));
      if (Object.keys(delta).length === 0) continue;
      const sides = Object.entries(delta).map(([side, px]) => `${side}=${px}px`).join(", ");
      findings.push({
        severity: entry.parent.clipsContent ? "info" : "warn",
        nodeId: entry.node.id,
        name: entry.node.name,
        parentId: entry.parent.id,
        parentName: entry.parent.name,
        delta: delta,
        message: `child extends beyond parent by ${sides}`,
      });
    }
  }

  if (checks.includes("spacing")) {
    for (const [parent, children] of groups) {
      if (isAutoLayout(parent)) continue;
      const boxes = children.filter((c) => c.bb).map((c) => c.bb);
      if (boxes.length < 3) continue;
      const xs = boxes.map((b) => b.x);
      const ys = boxes.map((b) => b.y);
      const sameColumn = Math.max(...xs) - Math.min(...xs) < 2;
      const sameRow = Math.max(...ys) - Math.min(...ys) < 2;
      if (!sameColumn && !sameRow) continue;
      const axis = sameColumn ? "y" : "x";
      boxes.sort((a, b) => a[axis] - b[axis]);
      const gaps = [];
      for (let i = 0; i < boxes.length - 1; i++) {
        gaps.push(r2(axis === "y" ? boxes[i + 1].y - (boxes[i].y + boxes[i].height) : boxes[i + 1].x - (boxes[i].x + boxes[i].width)));
      }
      if (Math.max(...gaps) - Math.min(...gaps) > 1) {
        findings.push({
          severity: "warn",
          nodeId: parent.id,
          name: parent.name,
          message: `inconsistent gaps: [${gaps.join(", ")}]`,
          gaps: gaps,
        });
      }
    }
  }

  if (checks.includes("grid")) {
    let gridFindings = 0;
    for (const entry of entries) {
      if (gridFindings >= 30) break;
      const values = offGridValues(entry.node, grid);
      if (Object.keys(values).length === 0) continue;
      gridFindings++;
      findings.push({
        severity: "info",
        nodeId: entry.node.id,
        name: entry.node.name,
        message: `off grid: ${Object.entries(values).map(([key, v]) => `${key}=${v}`).join(", ")}`,
        values: values,
      });
    }
  }

  if (checks.includes("hug")) {
    for (const [parent, children] of groups) {
      if (!isAutoLayout(parent)) continue;
      const kids = children.filter((c) => "width" in c.node && "height" in c.node);
      if (kids.length === 0) continue;
      const horizontal = parent.layoutMode === "HORIZONTAL";
      const spacing = typeof parent.itemSpacing === "number" ? parent.itemSpacing : 0;
      const sizes = kids.map((c) => (horizontal ? c.node.width : c.node.height));
      const primaryTotal =
        sizes.reduce((a, b) => a + b, 0) +
        spacing * (kids.length - 1) +
        (horizontal ? parent.paddingLeft + parent.paddingRight : parent.paddingTop + parent.paddingBottom);
      if (parent.primaryAxisSizingMode === "FIXED") {
        const size = horizontal ? parent.width : parent.height;
        if (primaryTotal - size > 1) {
          findings.push({
            severity: "warn",
            nodeId: parent.id,
            name: parent.name,
            message: `auto-layout overflow: ${r2(primaryTotal - size)}px on ${horizontal ? "horizontal" : "vertical"} axis`,
            overflow: r2(primaryTotal - size),
          });
        }
      }
      if (parent.counterAxisSizingMode === "FIXED") {
        const counterSizes = kids.map((c) => (horizontal ? c.node.height : c.node.width));
        const counterTotal =
          Math.max(...counterSizes) +
          (horizontal ? parent.paddingTop + parent.paddingBottom : parent.paddingLeft + parent.paddingRight);
        const size = horizontal ? parent.height : parent.width;
        if (counterTotal - size > 1) {
          findings.push({
            severity: "warn",
            nodeId: parent.id,
            name: parent.name,
            message: `auto-layout overflow: ${r2(counterTotal - size)}px on ${horizontal ? "vertical" : "horizontal"} axis`,
            overflow: r2(counterTotal - size),
          });
        }
      }
    }
  }

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1));
  const summary = { warn: 0, info: 0 };
  for (const finding of findings) summary[finding.severity]++;
  const data = {
    nodeId: root.id,
    name: root.name,
    checksRun: checks,
    scanned: scanned,
    invisibleSkipped: invisibleSkipped,
    summary: summary,
    findings: findings.slice(0, 100),
  };
  if (truncated) data.truncated = true;
  return data;
};
