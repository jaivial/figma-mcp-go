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
        if (typeof code !== "string" || !code.trim()) throw new Error("code is required");
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const run = new AsyncFunction("figma", code);
        const result = await run(figma);
        // Only JSON-safe data travels back (a node would not serialise).
        let data;
        try {
          data = result === undefined ? null : JSON.parse(JSON.stringify(result));
        } catch (e) {
          data = String(result);
        }
        return { type: request.type, requestId: request.requestId, data: data };
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
