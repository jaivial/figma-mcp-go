// Serializer

const isMixed = (value) => typeof value === "symbol";

const round2 = (value) => {
  if (typeof value === "number") return Math.round(value * 100) / 100;
  return isMixed(value) ? "mixed" : value;
};

const toRect = (rect) =>
  rect ? { x: round2(rect.x), y: round2(rect.y), width: round2(rect.width), height: round2(rect.height) } : null;

const toLineHeight = (value) => {
  if (isMixed(value)) return "mixed";
  if (typeof value === "number") return round2(value);
  if (value && typeof value === "object") {
    const out = { unit: value.unit };
    if (typeof value.value === "number") out.value = round2(value.value);
    return out;
  }
  return undefined;
};

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
    return { x: round2(node.x), y: round2(node.y), width: round2(node.width), height: round2(node.height) };
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

// Layout model of a node: auto-layout settings, constraints, absolute geometry.
// Keys that do not apply to the node type are omitted.
const serializeLayout = (node) => {
  const layout = {};
  const set = (key, value) => {
    if (value !== undefined) layout[key] = value;
  };

  if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
    set("layoutMode", node.layoutMode);
    set("itemSpacing", round2(node.itemSpacing));
    set("layoutWrap", node.layoutWrap);
    set("paddingTop", round2(node.paddingTop));
    set("paddingRight", round2(node.paddingRight));
    set("paddingBottom", round2(node.paddingBottom));
    set("paddingLeft", round2(node.paddingLeft));
    set("primaryAxisAlignItems", node.primaryAxisAlignItems);
    set("counterAxisAlignItems", node.counterAxisAlignItems);
    set("primaryAxisSizingMode", node.primaryAxisSizingMode);
    set("counterAxisSizingMode", node.counterAxisSizingMode);
    set("clipsContent", node.clipsContent);
  }

  if ("constraints" in node && node.constraints) {
    set("constraints", { horizontal: node.constraints.horizontal, vertical: node.constraints.vertical });
  }

  if (node.type === "TEXT") {
    set("textAutoResize", node.textAutoResize);
    set("lineHeight", toLineHeight(node.lineHeight));
    set("letterSpacing", round2(node.letterSpacing));
  }

  if (typeof node.rotation === "number" && node.rotation !== 0) {
    set("rotation", round2(node.rotation));
  }

  set("absoluteBoundingBox", toRect(node.absoluteBoundingBox));
  set("absoluteRenderBounds", toRect(node.absoluteRenderBounds));
  set("parentId", node.parent ? node.parent.id : undefined);
  set("childCount", node.children ? node.children.length : undefined);
  // True when x/y writes on this node are ignored because the parent runs auto-layout.
  if (node.parent && node.parent.layoutMode && node.parent.layoutMode !== "NONE") {
    layout.parentAutoLayout = true;
  }
  if (node.type === "INSTANCE" && node.mainComponent) {
    layout.mainComponent = { id: node.mainComponent.id, name: node.mainComponent.name };
  }
  return layout;
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
  };
  const styles = serializeStyles(node);
  if (Object.keys(styles).length > 0) base.styles = styles;
  const layout = serializeLayout(node);
  if (Object.keys(layout).length > 0) base.layout = layout;
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

      case "get_layout_context": {
        const nodeId = request.params && request.params.nodeId;
        if (!nodeId) throw new Error("nodeId is required for get_layout_context");
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        if (node.type === "PAGE" || node.type === "DOCUMENT") {
          throw new Error(`nodeId must be a scene node, not ${node.type}: ${nodeId}`);
        }
        const parent = node.parent;
        const autoLayout = (n) => n.layoutMode === "VERTICAL" || n.layoutMode === "HORIZONTAL";
        const nodeBounds = getBounds(node);
        const parentBounds = parent ? getBounds(parent) : undefined;

        // Sibling geometry in reading order along the parent's main axis.
        const siblings = parent && parent.children
          ? parent.children
              .filter((child) => child.id !== node.id)
              .map((child) => ({
                id: child.id,
                name: child.name,
                type: child.type,
                x: round2(child.x),
                y: round2(child.y),
                width: round2(child.width),
                height: round2(child.height),
              }))
          : [];
        if (parent && parent.layoutMode === "HORIZONTAL") {
          siblings.sort((a, b) => a.x - b.x);
        } else if (parent && parent.layoutMode === "VERTICAL") {
          siblings.sort((a, b) => a.y - b.y);
        } else {
          siblings.sort((a, b) => (a.y - b.y) || (a.x - b.x));
        }

        // Gap from the node box to the parent content box (bounds minus padding),
        // only meaningful when the parent positions children absolutely.
        let free = null;
        if (parent && !autoLayout(parent) && parentBounds && nodeBounds) {
          free = {
            left: round2(nodeBounds.x - (parentBounds.x + (parent.paddingLeft || 0))),
            top: round2(nodeBounds.y - (parentBounds.y + (parent.paddingTop || 0))),
            right: round2(parentBounds.x + parentBounds.width - (parent.paddingRight || 0) - (nodeBounds.x + nodeBounds.width)),
            bottom: round2(parentBounds.y + parentBounds.height - (parent.paddingBottom || 0) - (nodeBounds.y + nodeBounds.height)),
          };
        }

        const summarizeGrid = (grid) => {
          const summary = { pattern: grid.pattern };
          if ("patternType" in grid) summary.patternType = grid.patternType;
          if ("sectionSize" in grid) summary.sectionSize = round2(grid.sectionSize);
          if (grid.pattern !== "GRID") {
            if ("alignment" in grid) summary.alignment = grid.alignment;
            if ("gutterSize" in grid) summary.gutterSize = round2(grid.gutterSize);
            if ("count" in grid) {
              if (grid.pattern === "ROWS") summary.rowCount = grid.count;
              else summary.columnCount = grid.count;
            }
          }
          return summary;
        };
        const grids = Array.isArray(figma.currentPage.layoutGrids)
          ? figma.currentPage.layoutGrids.map(summarizeGrid)
          : [];

        const hints = [];
        if (parent && autoLayout(parent)) {
          hints.push("parent uses auto-layout: control position via order+padding+itemSpacing; child x/y are silently ignored");
        }
        if (grids.length > 0) hints.push("page uses a layout grid: snap coordinates to it");
        if (node.type === "TEXT" && node.textAutoResize && node.textAutoResize !== "NONE") {
          hints.push("textAutoResize differs from NONE: resize() semantics differ");
        }
        if (parent && parent.clipsContent === true) hints.push("parent clips overflow");

        return {
          type: request.type,
          requestId: request.requestId,
          data: {
            nodeId: node.id,
            name: node.name,
            type: node.type,
            bounds: nodeBounds,
            absoluteBoundingBox: toRect(node.absoluteBoundingBox),
            absoluteRenderBounds: toRect(node.absoluteRenderBounds),
            layout: serializeLayout(node),
            parent: parent
              ? {
                  id: parent.id,
                  name: parent.name,
                  type: parent.type,
                  bounds: parentBounds,
                  layout: serializeLayout(parent),
                  childCount: parent.children ? parent.children.length : 0,
                }
              : null,
            siblings,
            free,
            grid: grids,
            hints,
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

      case "set_text": {
        const nodeId = (request.nodeIds && request.nodeIds[0]) || (request.params && request.params.nodeId);
        if (!nodeId) throw new Error("nodeId is required for set_text");
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        if (node.type !== "TEXT") throw new Error(`Node ${nodeId} is ${node.type}, not TEXT`);
        const params = request.params || {};
        // Load every font the text currently uses (plus the override) before writing anything.
        const fonts = [];
        if (isMixed(node.fontName)) {
          fonts.push(...node.getRangeAllFontNames(0, node.characters.length));
        } else if (node.fontName) {
          fonts.push(node.fontName);
        }
        const overrideFont = params.fontName && typeof params.fontName === "object" ? params.fontName : null;
        if (overrideFont) {
          if (!overrideFont.family || !overrideFont.style) throw new Error("fontName requires {family, style}");
          fonts.push({ family: overrideFont.family, style: overrideFont.style });
        }
        const seenFonts = new Set();
        const uniqueFonts = fonts.filter((font) => {
          const key = `${font.family}:${font.style}`;
          if (seenFonts.has(key)) return false;
          seenFonts.add(key);
          return true;
        });
        await Promise.all(uniqueFonts.map((font) => figma.loadFontAsync(font)));
        // Safe order: font and style before characters.
        if (overrideFont) node.fontName = { family: overrideFont.family, style: overrideFont.style };
        if (params.fontSize != null) {
          if (typeof params.fontSize !== "number") throw new Error("fontSize must be a number");
          node.fontSize = params.fontSize;
        }
        if (params.characters != null) node.characters = params.characters;
        if (params.textAlignHorizontal) node.textAlignHorizontal = params.textAlignHorizontal;
        if (params.textAutoResize) node.textAutoResize = params.textAutoResize;
        return {
          type: request.type,
          requestId: request.requestId,
          data: {
            id: node.id,
            name: node.name,
            characters: node.characters,
            fontSize: isMixed(node.fontSize) ? "mixed" : round2(node.fontSize),
            fontName: isMixed(node.fontName) ? "mixed" : node.fontName,
            textAutoResize: node.textAutoResize,
            bounds: {
              x: round2(node.x),
              y: round2(node.y),
              width: round2(node.width),
              height: round2(node.height),
            },
          },
        };
      }

      case "place_node": {
        const nodeId = (request.nodeIds && request.nodeIds[0]) || (request.params && request.params.nodeId);
        if (!nodeId) throw new Error("nodeId is required for place_node");
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        const params = request.params || {};
        const parent = params.parentId ? await figma.getNodeByIdAsync(params.parentId) : node.parent;
        if (!parent || parent.type === "DOCUMENT") {
          throw new Error(`Parent not found: ${params.parentId || "(node has no parent)"}`);
        }
        if (!("appendChild" in parent)) throw new Error(`Parent ${parent.id} (${parent.type}) cannot have children`);
        // Never write inside an instance: edit the main component instead.
        const nodeInstanceError = instanceChainError(node, false);
        if (nodeInstanceError) throw nodeInstanceError;
        const parentInstanceError = instanceChainError(parent, true);
        if (parentInstanceError) throw parentInstanceError;

        if ("layoutMode" in parent && parent.layoutMode !== "NONE") {
          // Auto-layout parent: setting x/y is silently ignored, so only order and parent alignment apply.
          const otherChildren = parent.children.filter((child) => child.id !== node.id);
          if (params.align && otherChildren.length > 0) {
            throw new Error("per-child alignment inside auto-layout needs a nested frame (parent has other children)");
          }
          let afterIndex = -1;
          if (params.after) {
            const afterNode = await figma.getNodeByIdAsync(params.after);
            if (!afterNode) throw new Error(`after node not found: ${params.after}`);
            afterIndex = parent.children.findIndex((child) => child.id === afterNode.id);
            if (afterIndex === -1) throw new Error(`after node ${params.after} is not a child of ${parent.id}`);
          }
          const alreadyChild = node.parent && node.parent.id === parent.id;
          if (!alreadyChild) parent.appendChild(node);
          // Only reorder on an explicit `after`: a no-op position call inside an
          // auto-layout parent must not silently move the child to the end.
          if (afterIndex >= 0) parent.insertChild(afterIndex + 1, node);
          let mode = "auto-layout";
          if (params.align) {
            const counterAxis = ALIGN_TO_COUNTER_AXIS[params.align];
            if (!counterAxis) throw new Error(`Invalid align mode: ${params.align}`);
            parent.counterAxisAlignItems = counterAxis;
            mode = "parent-align";
          }
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              id: node.id,
              parentId: parent.id,
              mode,
              index: parent.children.findIndex((child) => child.id === node.id),
              note: "auto-layout parent: x/y are ignored; position comes from child order, spacing and padding",
            },
          };
        }

        // Absolute parent: x/y work, so convert the requested placement to parent-local.
        if (params.align && !("width" in parent)) {
          throw new Error(`align needs a frame parent with bounds, not a ${parent.type}`);
        }
        const snap = params.snap != null ? params.snap : 8;
        let target = null;
        if (params.position && typeof params.position === "object") {
          target = absToParentLocal(parent, Number(params.position.x), Number(params.position.y));
        } else if (params.relative && typeof params.relative === "object") {
          target = { x: Number(params.relative.x), y: Number(params.relative.y) };
        } else if (params.align) {
          target = alignWithinParent(parent, node, params.align);
        }
        if (target && (!isFinite(target.x) || !isFinite(target.y))) {
          throw new Error("position/relative must be finite {x, y} numbers");
        }
        if (params.parentId && node.parent && node.parent.id !== parent.id) parent.appendChild(node);
        if (target) {
          const snapped = { x: snapValue(target.x, snap), y: snapValue(target.y, snap) };
          node.x = snapped.x;
          node.y = snapped.y;
          return {
            type: request.type,
            requestId: request.requestId,
            data: {
              id: node.id,
              parentId: parent.id,
              mode: "absolute",
              x: round2(snapped.x),
              y: round2(snapped.y),
              snappedFrom: { x: round2(target.x), y: round2(target.y) },
              snap,
            },
          };
        }
        return {
          type: request.type,
          requestId: request.requestId,
          data: {
            id: node.id,
            parentId: parent.id,
            mode: "absolute",
            x: round2(node.x),
            y: round2(node.y),
            snappedFrom: { x: round2(node.x), y: round2(node.y) },
            snap,
          },
        };
      }

      case "align_nodes": {
        const params = request.params || {};
        if (!ALIGN_MODES.includes(params.mode)) {
          throw new Error(`mode is required for align_nodes (${ALIGN_MODES.join("|")})`);
        }
        const nodes = await resolveNodes(requestNodeIds(request));
        const boxes = nodes.map((node) => absBox(node));
        let reference;
        if (params.relativeTo && params.relativeTo !== "selection") {
          const refNode = await figma.getNodeByIdAsync(params.relativeTo);
          if (!refNode) throw new Error(`relativeTo node not found: ${params.relativeTo}`);
          reference = absBox(refNode);
        } else {
          reference = unionBoxes(boxes);
        }
        const results = nodes.map((node, i) => {
          const target = alignTarget(boxes[i], reference, params.mode);
          return applyGuardedDelta(node, target.x - boxes[i].x, target.y - boxes[i].y);
        });
        return {
          type: request.type,
          requestId: request.requestId,
          data: {
            results,
            reference: {
              x: round2(reference.x),
              y: round2(reference.y),
              width: round2(reference.width),
              height: round2(reference.height),
            },
          },
        };
      }

      case "distribute_nodes": {
        const params = request.params || {};
        if (params.axis !== "horizontal" && params.axis !== "vertical") {
          throw new Error('axis is required for distribute_nodes ("horizontal"|"vertical")');
        }
        const nodes = await resolveNodes(requestNodeIds(request));
        if (nodes.length < 2) throw new Error("distribute_nodes needs at least 2 nodes");
        const horizontal = params.axis === "horizontal";
        const entries = nodes
          .map((node) => ({ node, box: absBox(node) }))
          .sort((a, b) => (horizontal ? a.box.x - b.box.x : a.box.y - b.box.y));
        const lead = (box) => (horizontal ? box.x : box.y);
        const size = (box) => (horizontal ? box.width : box.height);
        const spanStart = lead(entries[0].box);
        const last = entries[entries.length - 1].box;
        const spanEnd = lead(last) + size(last);
        let gap;
        if (params.spacing != null) {
          gap = Number(params.spacing);
        } else {
          const totalSize = entries.reduce((sum, entry) => sum + size(entry.box), 0);
          gap = (spanEnd - spanStart - totalSize) / (entries.length - 1);
        }
        let cursor = spanStart;
        const results = entries.map((entry) => {
          const targetLead = cursor;
          cursor = targetLead + size(entry.box) + gap;
          const dx = horizontal ? targetLead - entry.box.x : 0;
          const dy = horizontal ? 0 : targetLead - entry.box.y;
          const move = applyGuardedDelta(entry.node, dx, dy);
          return Object.assign(move, {
            x: round2(horizontal ? targetLead : entry.box.x),
            y: round2(horizontal ? entry.box.y : targetLead),
          });
        });
        return {
          type: request.type,
          requestId: request.requestId,
          data: {
            axis: params.axis,
            spacing: params.spacing != null ? Number(params.spacing) : "even",
            gap: round2(gap),
            results,
          },
        };
      }

      case "auto_layout": {
        const params = request.params || {};
        if (params.direction !== "horizontal" && params.direction !== "vertical") {
          throw new Error('direction is required for auto_layout ("horizontal"|"vertical")');
        }
        const hug = params.hug || "none";
        if (!HUG_MODES.includes(hug)) throw new Error(`Invalid hug: ${params.hug} (${HUG_MODES.join("|")})`);
        let frame = null;
        if (params.frameId) {
          frame = await figma.getNodeByIdAsync(params.frameId);
          if (!frame) throw new Error(`Frame not found: ${params.frameId}`);
          if (!("layoutMode" in frame)) throw new Error(`frameId ${frame.id} is a ${frame.type}, not a frame`);
          const frameInstanceError = instanceChainError(frame, true);
          if (frameInstanceError) throw frameInstanceError;
        }
        const ids = requestNodeIds(request);
        const nodes = ids.length > 0 ? await resolveNodes(ids) : [];
        if (nodes.length === 0 && (!frame || frame.children.length === 0)) {
          throw new Error("No nodes to lay out: pass nodeIds or frameId");
        }
        const sourceNodes = nodes.length > 0 ? nodes : frame.children.slice();
        // Never pull nodes out of an instance: edit the main component instead.
        for (const sourceNode of sourceNodes) {
          if (frame && sourceNode.id === frame.id) throw new Error(`Cannot place frame ${frame.id} inside itself`);
          const instanceError = instanceChainError(sourceNode, false);
          if (instanceError) throw instanceError;
        }
        // Visual order: vertical stacks read top-to-bottom, horizontal left-to-right.
        const ordered = sourceNodes
          .map((node) => ({ node, box: absBox(node) }))
          .sort((a, b) =>
            params.direction === "vertical"
              ? (a.box.y - b.box.y) || (a.box.x - b.box.x)
              : (a.box.x - b.box.x) || (a.box.y - b.box.y)
          )
          .map((entry) => entry.node);
        const union = unionBoxes(ordered.map((node) => absBox(node)));
        if (!frame) {
          frame = figma.createFrame();
          frame.fills = [];
          frame.x = union.x;
          frame.y = union.y;
          frame.resize(Math.max(union.width, 0.01), Math.max(union.height, 0.01));
        }
        for (const node of ordered) {
          const box = absBox(node);
          frame.appendChild(node);
          // Keep each node at its absolute position while reparenting.
          node.x = box.x - frame.x;
          node.y = box.y - frame.y;
        }
        frame.layoutMode = params.direction === "vertical" ? "VERTICAL" : "HORIZONTAL";
        frame.itemSpacing = params.spacing != null ? params.spacing : 24;
        const padding = params.padding != null ? params.padding : 24;
        if (typeof padding === "number") {
          frame.paddingTop = padding;
          frame.paddingRight = padding;
          frame.paddingBottom = padding;
          frame.paddingLeft = padding;
        } else if (padding && typeof padding === "object") {
          frame.paddingTop = paddingNumber(padding.top);
          frame.paddingRight = paddingNumber(padding.right);
          frame.paddingBottom = paddingNumber(padding.bottom);
          frame.paddingLeft = paddingNumber(padding.left);
        }
        const hugPrimary =
          params.direction === "vertical"
            ? hug === "vertical" || hug === "both"
            : hug === "horizontal" || hug === "both";
        const hugCounter =
          params.direction === "vertical"
            ? hug === "horizontal" || hug === "both"
            : hug === "vertical" || hug === "both";
        frame.primaryAxisSizingMode = hugPrimary ? "AUTO" : "FIXED";
        frame.counterAxisSizingMode = hugCounter ? "AUTO" : "FIXED";
        if (!hugPrimary || !hugCounter) {
          // "none" keeps the current size: re-assert it after switching off hug.
          frame.resize(Math.max(frame.width, 0.01), Math.max(frame.height, 0.01));
        }
        return {
          type: request.type,
          requestId: request.requestId,
          data: {
            frameId: frame.id,
            name: frame.name,
            childOrder: frame.children.map((child) => child.id),
            layout: {
              mode: frame.layoutMode,
              spacing: frame.itemSpacing,
              padding: {
                top: frame.paddingTop,
                right: frame.paddingRight,
                bottom: frame.paddingBottom,
                left: frame.paddingLeft,
              },
              primarySizing: frame.primaryAxisSizingMode,
              counterSizing: frame.counterAxisSizingMode,
            },
            bounds: {
              x: round2(frame.x),
              y: round2(frame.y),
              width: round2(frame.width),
              height: round2(frame.height),
            },
          },
        };
      }

      case "export_code": {
        const params = request.params || {};
        const nodeId = (request.nodeIds && request.nodeIds[0]) || params.nodeId;
        if (!nodeId) throw new Error("nodeId is required for export_code");
        const flavor = params.flavor || "html-tailwind";
        if (!EXPORT_FLAVORS.includes(flavor)) {
          throw new Error(`Invalid flavor: ${flavor} (${EXPORT_FLAVORS.join("|")})`);
        }
        const classCase = params.classCase || "tailwind";
        if (classCase !== "tailwind") throw new Error(`Invalid classCase: ${classCase} (tailwind)`);
        const maxNodes =
          typeof params.maxNodes === "number" && params.maxNodes > 0 ? Math.floor(params.maxNodes) : 2000;
        const root = await figma.getNodeByIdAsync(nodeId);
        if (!root || root.type === "DOCUMENT") throw new Error(`Node not found: ${nodeId}`);
        return {
          type: request.type,
          requestId: request.requestId,
          data: buildExportCode(root, { flavor: flavor, maxNodes: maxNodes }),
        };
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

// ── Write helpers ─────────────────────────────────────────────────────

const ALIGN_MODES = ["left", "hcenter", "right", "top", "vcenter", "bottom"];
const HUG_MODES = ["none", "horizontal", "vertical", "both"];
const ALIGN_TO_COUNTER_AXIS = {
  left: "MIN",
  hcenter: "CENTER",
  right: "MAX",
  top: "MIN",
  vcenter: "CENTER",
  bottom: "MAX",
};


const requestNodeIds = (request) => {
  if (request.nodeIds && request.nodeIds.length > 0) return request.nodeIds;
  const fromParams = request.params && request.params.nodeIds;
  return Array.isArray(fromParams) ? fromParams : [];
};

// Returns the INSTANCE the given node lives in, or null. includeSelf lets a
// target parent be rejected when it is the instance itself.
const instanceAncestor = (node, includeSelf) => {
  let current = includeSelf ? node : node.parent;
  while (current && current.type !== "DOCUMENT") {
    if (current.type === "INSTANCE") return current;
    current = current.parent;
  }
  return null;
};

const instanceChainError = (node, includeSelf) => {
  const instance = instanceAncestor(node, includeSelf);
  if (!instance) return null;
  const mainComponent = instance.mainComponent ? instance.mainComponent.id : "unknown";
  return new Error(
    `Node ${node.id} is inside instance ${instance.id} (main component ${mainComponent}): edit the main component instead`
  );
};

const findRotatedAncestor = (node) => {
  let current = node.parent;
  while (current && current.type !== "DOCUMENT") {
    if ("rotation" in current && typeof current.rotation === "number" && Math.abs(current.rotation) > 1e-9) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

// Absolute page coordinates → parent-local, via the parent's absoluteTransform
// inverse (never naive subtraction: rotated/translated parents break it).
const absToParentLocal = (parent, x, y) => {
  const t =
    "absoluteTransform" in parent && parent.absoluteTransform
      ? parent.absoluteTransform
      : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const det = t.a * t.d - t.b * t.c;
  if (det === 0) throw new Error(`Parent ${parent.id} has a degenerate transform (det = 0)`);
  return {
    x: (t.d * (x - t.e) - t.c * (y - t.f)) / det,
    y: (-t.b * (x - t.e) + t.a * (y - t.f)) / det,
  };
};

const snapValue = (value, snap) => (typeof snap === "number" && snap > 0 ? Math.round(value / snap) * snap : value);

const absBox = (node) => {
  const box = node.absoluteBoundingBox;
  if (!box) throw new Error(`Node ${node.id} (${node.type}) has no absolute bounding box`);
  return box;
};

const unionBoxes = (boxes) => {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

// Align one box edge/center to a reference box; only the relevant axis moves.
const alignTarget = (box, reference, mode) => {
  switch (mode) {
    case "left": return { x: reference.x, y: box.y };
    case "hcenter": return { x: reference.x + reference.width / 2 - box.width / 2, y: box.y };
    case "right": return { x: reference.x + reference.width - box.width, y: box.y };
    case "top": return { x: box.x, y: reference.y };
    case "vcenter": return { x: box.x, y: reference.y + reference.height / 2 - box.height / 2 };
    case "bottom": return { x: box.x, y: reference.y + reference.height - box.height };
    default: throw new Error(`Invalid align mode: ${mode}`);
  }
};

// Align inside a plain parent's content box (bounds minus paddings), parent-local.
const alignWithinParent = (parent, node, align) => {
  const paddingLeft = "paddingLeft" in parent ? parent.paddingLeft : 0;
  const paddingTop = "paddingTop" in parent ? parent.paddingTop : 0;
  const paddingRight = "paddingRight" in parent ? parent.paddingRight : 0;
  const paddingBottom = "paddingBottom" in parent ? parent.paddingBottom : 0;
  const contentWidth = parent.width - paddingLeft - paddingRight;
  const contentHeight = parent.height - paddingTop - paddingBottom;
  switch (align) {
    case "left": return { x: paddingLeft, y: node.y };
    case "hcenter": return { x: paddingLeft + (contentWidth - node.width) / 2, y: node.y };
    case "right": return { x: parent.width - paddingRight - node.width, y: node.y };
    case "top": return { x: node.x, y: paddingTop };
    case "vcenter": return { x: node.x, y: paddingTop + (contentHeight - node.height) / 2 };
    case "bottom": return { x: node.x, y: parent.height - paddingBottom - node.height };
    default: throw new Error(`Invalid align mode: ${align}`);
  }
};

const resolveNodes = async (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("nodeIds is required");
  const nodes = await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)));
  nodes.forEach((node, i) => {
    if (!node) throw new Error(`Node not found: ${ids[i]}`);
  });
  return nodes;
};

// Apply an absolute (dx, dy) as a local delta, with the write guardrails:
// auto-layout parents, instance descendants and rotated ancestors are refused
// per node instead of silently misplacing (or ignoring) the move.
const applyGuardedDelta = (node, dx, dy) => {
  const failure = (error) => ({ id: node.id, applied: false, dx: round2(dx), dy: round2(dy), error });
  if (!node.parent) return failure("node has no parent");
  if ("layoutMode" in node.parent && node.parent.layoutMode !== "NONE") {
    return failure("inside auto-layout parent: use order/padding");
  }
  const instanceError = instanceChainError(node, false);
  if (instanceError) return failure(instanceError.message);
  if (findRotatedAncestor(node)) return failure("rotated ancestor — manual handling needed");
  node.x += dx;
  node.y += dy;
  return { id: node.id, applied: true, dx: round2(dx), dy: round2(dy) };
};

const paddingNumber = (value) => (typeof value === "number" && isFinite(value) ? value : 0);

// ── execute_code rails + validate_layout helpers ──

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
    // Reject lines outside the user code: compile errors surface the new Function
    // call site inside this plugin file instead of a user line.
    if (userLine >= 1 && userLine <= code.split("\n").length) line = userLine;
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

// ── export_code helpers ──────────────────────────────────────────────────────

const EXPORT_FLAVORS = ["html-tailwind", "react-tailwind", "json"];
// primaryAxisAlignItems → justify-*, counterAxisAlignItems → items-*.
const EXPORT_JUSTIFY = { MIN: "justify-start", CENTER: "justify-center", MAX: "justify-end", SPACE_BETWEEN: "justify-between" };
const EXPORT_ITEMS = { MIN: "items-start", CENTER: "items-center", MAX: "items-end" };
const EXPORT_TEXT_ALIGN = { CENTER: "text-center", RIGHT: "text-right", JUSTIFIED: "text-justify" };

const escapeHtmlText = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Characters inside a JSX {"..."} string literal.
const escapeJsxText = (text) =>
  String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n");

// Layer names travel inside comments: keep them from closing the comment early.
const exportCommentName = (name, jsx) => {
  const clean = String(name).replace(/[\r\n]+/g, " ");
  return jsx ? clean.replace(/\*\//g, "* /") : clean.replace(/--+/g, "-");
};

// "hero card v2" → "HeroCardV2"; anything unparsable → "ExportedNode".
const exportPascalCase = (name) => {
  const parts = String(name || "").split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const joined = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  if (!joined) return "ExportedNode";
  return /^[0-9]/.test(joined) ? `Figma${joined}` : joined;
};

const dedupeClasses = (classes) => Array.from(new Set(classes.filter(Boolean)));

// First visible, non-transparent SOLID paint as "#hex" (null when absent).
const exportPaintHex = (paints) => {
  if (!Array.isArray(paints)) return null;
  const paint = paints.find((p) => p && p.type === "SOLID" && p.visible !== false && p.opacity !== 0 && p.color);
  return paint ? toHex(paint.color) : null;
};

const exportFillClass = (node) => {
  if (!("fills" in node) || isMixed(node.fills)) return null;
  const hex = exportPaintHex(node.fills);
  return hex ? `bg-[${hex}]` : null;
};

// Uniform strokeWeight, or the largest per-side weight when it is mixed.
const exportStrokeWeight = (node) => {
  if (typeof node.strokeWeight === "number") return node.strokeWeight;
  const sides = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"]
    .map((key) => node[key])
    .filter((v) => typeof v === "number");
  return sides.length > 0 ? Math.max(...sides) : null;
};

const exportBorderClasses = (node) => {
  if (!("strokes" in node) || isMixed(node.strokes)) return [];
  const hex = exportPaintHex(node.strokes);
  if (!hex) return [];
  const weight = exportStrokeWeight(node);
  if (typeof weight !== "number" || weight <= 0) return [];
  return [`border-[${round2(weight)}px]`, `border-[${hex}]`];
};

// "rounded-[Npx]", a four-corner arbitrary value when mixed, or null.
const exportRadiusClass = (node) => {
  if (!("cornerRadius" in node)) return null;
  if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
    return `rounded-[${round2(node.cornerRadius)}px]`;
  }
  if (isMixed(node.cornerRadius)) {
    const corners = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
    if (corners.every((v) => typeof v === "number")) {
      return `rounded-[${corners.map((c) => round2(c)).join("_")}px]`;
    }
  }
  return null;
};

// Fixed w/h classes from whatever geometry the node actually has.
const exportSizeClasses = (node, roundToInt) => {
  const classes = [];
  const fmt = (v) => (roundToInt ? Math.round(v) : round2(v)) + "px";
  if (typeof node.width === "number") classes.push(`w-[${fmt(node.width)}]`);
  if (typeof node.height === "number") classes.push(`h-[${fmt(node.height)}]`);
  return classes;
};

// Absolute children of a plain frame: parent-local, rounded to integers.
const exportAbsoluteClasses = (node) => {
  if (typeof node.x !== "number" || typeof node.y !== "number") return [];
  return ["absolute", `left-[${Math.round(node.x)}px]`, `top-[${Math.round(node.y)}px]`, ...exportSizeClasses(node, true)];
};

// fontName.style → weight class (SemiBold must be checked before Bold).
const exportWeightClass = (style) => {
  if (typeof style !== "string") return null;
  if (/semibold/i.test(style)) return "font-semibold";
  if (/bold/i.test(style)) return "font-bold";
  if (/medium/i.test(style)) return "font-medium";
  return null;
};

// Flex utilities for an auto-layout frame, in spec order.
const exportAutoLayoutClasses = (node) => {
  const classes = ["flex", node.layoutMode === "VERTICAL" ? "flex-col" : "flex-row"];
  if (typeof node.itemSpacing === "number" && node.itemSpacing !== 0) {
    classes.push(`gap-[${round2(node.itemSpacing)}px]`);
  }
  const padding = {
    top: node.paddingTop,
    right: node.paddingRight,
    bottom: node.paddingBottom,
    left: node.paddingLeft,
  };
  const sides = Object.values(padding);
  if (sides.every((v) => typeof v === "number") && sides.every((v) => v === sides[0]) && sides[0] > 0) {
    classes.push(`p-[${round2(sides[0])}px]`);
  } else {
    const prefix = { top: "pt", right: "pr", bottom: "pb", left: "pl" };
    for (const side of ["top", "right", "bottom", "left"]) {
      if (typeof padding[side] === "number" && padding[side] > 0) {
        classes.push(`${prefix[side]}-[${round2(padding[side])}px]`);
      }
    }
  }
  const justify = EXPORT_JUSTIFY[node.primaryAxisAlignItems];
  if (justify) classes.push(justify);
  const items = EXPORT_ITEMS[node.counterAxisAlignItems];
  if (items) classes.push(items);
  // Fixed sizes: the primary axis sizes the main dimension, the counter axis the other; hug omits.
  const horizontal = node.layoutMode === "HORIZONTAL";
  if (node.primaryAxisSizingMode === "FIXED" && typeof (horizontal ? node.width : node.height) === "number") {
    classes.push(`${horizontal ? "w" : "h"}-[${round2(horizontal ? node.width : node.height)}px]`);
  }
  if (node.counterAxisSizingMode === "FIXED" && typeof (horizontal ? node.height : node.width) === "number") {
    classes.push(`${horizontal ? "h" : "w"}-[${round2(horizontal ? node.height : node.width)}px]`);
  }
  if (node.clipsContent === true) classes.push("overflow-hidden");
  const fill = exportFillClass(node);
  if (fill) classes.push(fill);
  const radius = exportRadiusClass(node);
  if (radius) classes.push(radius);
  classes.push(...exportBorderClasses(node));
  return classes;
};

// Typography utilities for a TEXT node, in spec order.
const exportTextClasses = (node) => {
  const classes = [];
  if (typeof node.fontSize === "number") classes.push(`text-[${round2(node.fontSize)}px]`);
  const style = node.fontName && !isMixed(node.fontName) ? node.fontName.style : null;
  const weight = exportWeightClass(style);
  if (weight) classes.push(weight);
  // Text fills are the text color, not a background.
  if ("fills" in node && !isMixed(node.fills)) {
    const hex = exportPaintHex(node.fills);
    if (hex) classes.push(`text-[${hex}]`);
  }
  const align = EXPORT_TEXT_ALIGN[node.textAlignHorizontal];
  if (align) classes.push(align);
  const lineHeight = !isMixed(node.lineHeight) && node.lineHeight && typeof node.lineHeight === "object" ? node.lineHeight : null;
  if (lineHeight && lineHeight.unit === "PIXELS" && typeof lineHeight.value === "number") {
    classes.push(`leading-[${round2(lineHeight.value)}px]`);
  }
  if (typeof node.letterSpacing === "number" && node.letterSpacing > 0) {
    classes.push(`tracking-[${round2(node.letterSpacing)}px]`);
  }
  if (node.textAutoResize === "NONE" && typeof node.width === "number") {
    classes.push(`w-[${round2(node.width)}px]`);
  }
  return classes;
};

// Capped JSON tree built on the standard serializer.
const exportJsonTree = (node, ctx, depth) => {
  if ("visible" in node && !node.visible) return null;
  if (ctx.nodes >= ctx.maxNodes) {
    ctx.truncated = true;
    return null;
  }
  ctx.nodes++;
  ctx.maxDepth = Math.max(ctx.maxDepth, depth + 1);
  const serialized = serializeNode(node);
  if (serialized.children) {
    const children = [];
    for (const child of node.children) {
      const childTree = exportJsonTree(child, ctx, depth + 1);
      if (childTree) children.push(childTree);
    }
    serialized.children = children;
  }
  return serialized;
};

// Emit one node as indented markup lines into ctx.lines (html + react flavors).
const exportMarkupNode = (node, ctx, depth, absoluteParent) => {
  if ("visible" in node && !node.visible) return;
  if (ctx.nodes >= ctx.maxNodes) {
    ctx.truncated = true;
    return;
  }
  ctx.nodes++;
  ctx.maxDepth = Math.max(ctx.maxDepth, depth + 1);
  const indent = "  ".repeat(depth);
  const attrName = ctx.react ? "className" : "class";
  // At depth 0 a JSX child comment would sit outside any element, so use a JS comment.
  const comment = (text) => {
    const body = exportCommentName(text, ctx.react);
    if (ctx.react && depth === 0) ctx.lines.push(`// ${body}`);
    else if (ctx.react) ctx.lines.push(`${indent}{/* ${body} */}`);
    else ctx.lines.push(`${indent}<!-- ${body} -->`);
  };
  const leaf = (classes) => {
    const attr = `${attrName}="${dedupeClasses(classes).join(" ")}"`;
    ctx.lines.push(ctx.react ? `${indent}<div ${attr} />` : `${indent}<div ${attr}></div>`);
  };
  const container = (classes, children, absoluteChildren) => {
    const attr = `${attrName}="${dedupeClasses(classes).join(" ")}"`;
    const open = `${indent}<div ${attr}>`;
    ctx.lines.push(open);
    const before = ctx.lines.length;
    for (const child of children) exportMarkupNode(child, ctx, depth + 1, absoluteChildren);
    if (ctx.lines.length === before) {
      // Nothing was emitted (empty or capped children): self-close in JSX, collapse in HTML.
      if (ctx.react) ctx.lines[before - 1] = `${open.slice(0, -1)} />`;
      else ctx.lines[before - 1] = `${open}</div>`;
      return;
    }
    ctx.lines.push(`${indent}</div>`);
  };

  if (node.type === "COMPONENT" || node.type === "INSTANCE") {
    comment(`component: ${node.name} (${node.id})`);
  }
  const positionClasses = absoluteParent ? exportAbsoluteClasses(node) : [];

  if (node.layoutMode === "VERTICAL" || node.layoutMode === "HORIZONTAL") {
    container([...positionClasses, ...exportAutoLayoutClasses(node)], node.children || [], false);
    return;
  }

  if (node.type === "TEXT") {
    const classes = [...positionClasses, ...exportTextClasses(node)];
    if (!node.characters) {
      leaf(classes);
      return;
    }
    const attr = `${attrName}="${dedupeClasses(classes).join(" ")}"`;
    if (ctx.react) {
      ctx.lines.push(`${indent}<div ${attr}>{"${escapeJsxText(node.characters)}"}</div>`);
    } else {
      ctx.lines.push(`${indent}<div ${attr}>${escapeHtmlText(node.characters)}</div>`);
    }
    return;
  }

  if (node.type === "RECTANGLE" || node.type === "ELLIPSE") {
    const classes = positionClasses.length > 0 ? positionClasses.slice() : exportSizeClasses(node, false);
    if (node.type === "ELLIPSE") classes.push("rounded-full");
    else {
      const radius = exportRadiusClass(node);
      if (radius) classes.push(radius);
    }
    const fill = exportFillClass(node);
    if (fill) classes.push(fill);
    classes.push(...exportBorderClasses(node));
    leaf(classes);
    return;
  }

  if ("children" in node && node.children && node.children.length > 0 && node.type !== "BOOLEAN_OPERATION") {
    // Plain frame / group / section: fixed-size box, children positioned absolutely.
    const classes = positionClasses.length > 0 ? positionClasses.slice() : exportSizeClasses(node, false);
    classes.push("relative");
    const fill = exportFillClass(node);
    if (fill) classes.push(fill);
    const radius = exportRadiusClass(node);
    if (radius) classes.push(radius);
    classes.push(...exportBorderClasses(node));
    if (node.clipsContent === true) classes.push("overflow-hidden");
    container(classes, node.children, true);
    return;
  }

  // Unsupported leaf (VECTOR, LINE, POLYGON, …): geometry placeholder with a comment marker.
  const classes = positionClasses.length > 0 ? positionClasses.slice() : exportSizeClasses(node, false);
  const fill = exportFillClass(node);
  if (fill) classes.push(fill);
  classes.push(...exportBorderClasses(node));
  comment(`${node.type}: ${node.name} (${node.id})`);
  leaf(classes);
};

// Build the export payload shared by every flavor.
const buildExportCode = (root, options) => {
  const ctx = {
    react: options.flavor === "react-tailwind",
    maxNodes: options.maxNodes,
    nodes: 0,
    maxDepth: 0,
    truncated: false,
    lines: [],
  };
  let code;
  if (options.flavor === "json") {
    code = JSON.stringify(exportJsonTree(root, ctx, 0), null, 2);
  } else {
    if (ctx.react) {
      ctx.lines.push(`// Suggested component: ${exportPascalCase(root.name)} (from "${exportCommentName(root.name, true)}")`);
    }
    exportMarkupNode(root, ctx, 0, false);
    code = ctx.lines.join("\n");
  }
  const data = {
    code: code,
    stats: { nodes: ctx.nodes, lines: code.split("\n").length, depth: ctx.maxDepth },
  };
  if (ctx.truncated) {
    data.truncated = true;
    data.note = `subtree capped at maxNodes (${options.maxNodes}): output truncated`;
  }
  return data;
};
