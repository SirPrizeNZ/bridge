/* Figma Agent Bridge — main plugin thread.
 * Intentionally dependency-free so the development plugin can be imported directly.
 */

const BRIDGE_VERSION = '0.2.7';
const DEFAULT_SERVER = 'http://localhost:3874';
const STORAGE_KEY = 'figma-agent-bridge.config.v2';
const LEGACY_STORAGE_KEY = 'figma-agent-bridge.config.v1';
const MAX_SAFE_ARRAY = 5000;
const MAX_SAFE_OBJECT_KEYS = 1000;
const MAX_SAFE_STRING = 500000;
const MAX_EVENT_CHANGES = 500;
const TEXT_SEGMENT_FIELDS = new Set([
  'fontSize','fontName','fontWeight','fontStyle','textDecoration','textDecorationStyle',
  'textDecorationSkipInk','textDecorationOffset','textDecorationThickness','textDecorationColor',
  'textCase','lineHeight','letterSpacing','fills','textStyleId','fillStyleId','listOptions',
  'indentation','hyperlink','openTypeFeatures','boundVariables','textStyleOverrides',
  'paragraphSpacing','listSpacing','paragraphIndent','textWrapStyle'
]);
const DEFAULT_TEXT_SEGMENT_FIELDS = [
  'fontName','fontSize','fontWeight','textStyleId','fills','fillStyleId',
  'textDecoration','textCase','lineHeight','letterSpacing','hyperlink'
];

function textSegmentFields(fields) {
  const requested = Array.isArray(fields) ? fields.filter(field => TEXT_SEGMENT_FIELDS.has(field)) : [];
  return requested.length ? requested : DEFAULT_TEXT_SEGMENT_FIELDS;
}

figma.showUI(__html__, {
  width: 360,
  height: 480,
  themeColors: true,
  title: 'Figma Agent Bridge'
});

function errObj(error) {
  return {
    name: error && error.name ? String(error.name) : 'Error',
    message: error && error.message ? String(error.message) : String(error),
    stack: error && error.stack ? String(error.stack) : undefined
  };
}

function isMixed(v) {
  try { return v === figma.mixed; } catch (_) { return false; }
}

function isNodeLike(v) {
  return !!v && typeof v === 'object' && typeof v.id === 'string' && typeof v.type === 'string';
}

function safeValue(value, depth = 0, seen = new Set()) {
  if (depth > 10) return '[MaxDepth]';
  if (value == null) return value;
  if (isMixed(value)) return '__MIXED__';
  const t = typeof value;
  if (t === 'string') {
    if (value.length <= MAX_SAFE_STRING) return value;
    return value.slice(0, MAX_SAFE_STRING) + `…[truncated ${value.length - MAX_SAFE_STRING} chars]`;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'symbol') return String(value);
  if (t === 'function') return undefined;
  if (value instanceof Uint8Array) return { __uint8array__: bytesToBase64(value), byteLength: value.byteLength };
  if (Array.isArray(value)) {
    const n = Math.min(value.length, MAX_SAFE_ARRAY);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = safeValue(value[i], depth + 1, seen);
    if (value.length > n) out.push({ __truncatedItems__: value.length - n });
    return out;
  }
  if (isNodeLike(value)) return { id: value.id, type: value.type, name: value.name || '' };
  if (t === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = {};
    const keys = Object.keys(value);
    const n = Math.min(keys.length, MAX_SAFE_OBJECT_KEYS);
    for (let i = 0; i < n; i++) {
      const key = keys[i];
      try {
        const sv = safeValue(value[key], depth + 1, seen);
        if (sv !== undefined) out[key] = sv;
      } catch (_) {}
    }
    if (keys.length > n) out.__truncatedKeys__ = keys.length - n;
    seen.delete(value);
    return out;
  }
  return String(value);
}

function bytesToBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] +
      (i + 1 < bytes.length ? chars[(n >> 6) & 63] : '=') +
      (i + 2 < bytes.length ? chars[n & 63] : '=');
  }
  return out;
}

function base64ToBytes(input) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(input || '').replace(/\s+/g, '').replace(/=+$/, '');
  const out = [];
  let buffer = 0, bits = 0;
  for (const ch of clean) {
    const v = chars.indexOf(ch);
    if (v < 0) throw new Error('Invalid base64');
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

function tryRead(obj, key) {
  try {
    const v = obj[key];
    if (typeof v === 'function') return undefined;
    return safeValue(v);
  } catch (_) {
    return undefined;
  }
}

function stableValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function fnv1a(input) {
  let h = 0x811c9dc5;
  const str = String(input);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const FINGERPRINT_PROPS = [
  'name','visible','locked','opacity','blendMode','isMask','maskType','rotation','x','y','width','height',
  'constraints','fills','strokes','effects','cornerRadius','clipsContent','layoutMode','layoutWrap',
  'paddingLeft','paddingRight','paddingTop','paddingBottom','itemSpacing','layoutAlign','layoutGrow','layoutPositioning',
  'layoutSizingHorizontal','layoutSizingVertical','characters','fontName','fontSize','lineHeight','letterSpacing','textStyleId',
  'componentProperties','variantProperties','boundVariables','explicitVariableModes'
];

function nodeFingerprint(node, includeChildren = true) {
  const data = { id: node.id, type: node.type, parentId: node.parent && node.parent.id ? node.parent.id : null };
  for (const key of FINGERPRINT_PROPS) {
    const v = tryRead(node, key);
    if (v !== undefined) data[key] = v;
  }
  if (includeChildren && 'children' in node && Array.isArray(node.children)) {
    data.children = node.children.map(c => ({ id:c.id, type:c.type, name:c.name || '' }));
  }
  return 'fnv1a:' + fnv1a(JSON.stringify(stableValue(data)));
}

// Figma mask semantics: a node with isMask=true masks its *following* siblings
// within the same parent, until the next mask restarts the group. The Plugin API
// exposes isMask but never the resulting relationship, so we resolve it here.
let maskGroupCache = new WeakMap();
function resetMaskGroupCache() { maskGroupCache = new WeakMap(); }

function resolveMaskGroups(parent) {
  if (!parent || !('children' in parent) || !Array.isArray(parent.children)) return null;
  if (maskGroupCache.has(parent)) return maskGroupCache.get(parent);
  const children = parent.children;
  const groups = [];
  let current = null;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (tryRead(child, 'isMask') === true) {
      current = {
        maskId: child.id,
        maskName: child.name || '',
        maskType: tryRead(child, 'maskType') || 'ALPHA',
        maskNodeType: child.type,
        maskIndex: i,
        maskedIds: []
      };
      groups.push(current);
    } else if (current) {
      current.maskedIds.push(child.id);
    }
  }
  const result = groups.length ? groups : null;
  maskGroupCache.set(parent, result);
  return result;
}

function maskInfoFor(node) {
  const parent = node.parent;
  const groups = resolveMaskGroups(parent);
  if (!groups) return null;
  const out = {};
  const own = groups.find(g => g.maskId === node.id);
  if (own) {
    out.masks = { maskType: own.maskType, maskedIds: own.maskedIds, maskedCount: own.maskedIds.length };
  }
  const covering = groups.find(g => g.maskedIds.includes(node.id));
  if (covering) {
    out.maskedBy = { id: covering.maskId, name: covering.maskName, maskType: covering.maskType, nodeType: covering.maskNodeType };
  }
  return Object.keys(out).length ? out : null;
}

async function maybeLoadPageForNode(node) {
  if (!node) return;
  let cur = node;
  while (cur && cur.type !== 'PAGE') cur = cur.parent;
  if (cur && cur.type === 'PAGE' && cur !== figma.currentPage && typeof cur.loadAsync === 'function') {
    try { await cur.loadAsync(); } catch (_) {}
  }
}

const NODE_PROPS = [
  'id','type','name','visible','locked','opacity','blendMode','isMask','maskType','rotation','removed',
  'x','y','width','height','minWidth','maxWidth','minHeight','maxHeight','relativeTransform','absoluteTransform',
  'absoluteBoundingBox','absoluteRenderBounds','constraints','constrainProportions','targetAspectRatio',
  'fills','strokes','strokeWeight','strokeAlign','strokeCap','strokeJoin','strokeMiterLimit','dashPattern','strokeTopWeight','strokeRightWeight','strokeBottomWeight','strokeLeftWeight',
  'fillGeometry','strokeGeometry','complexStrokeProperties','variableWidthStrokeProperties',
  'effects','effectStyleId','fillStyleId','strokeStyleId','gridStyleId','exportSettings',
  'cornerRadius','topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius','cornerSmoothing',
  'clipsContent','layoutMode','layoutWrap','primaryAxisSizingMode','counterAxisSizingMode','primaryAxisAlignItems','counterAxisAlignItems','counterAxisAlignContent',
  'paddingLeft','paddingRight','paddingTop','paddingBottom','itemSpacing','counterAxisSpacing','layoutAlign','layoutGrow','layoutPositioning','layoutSizingHorizontal','layoutSizingVertical',
  'itemReverseZIndex','strokesIncludedInLayout','overflowDirection','numberOfFixedChildren','inferredAutoLayout','layoutGrids','guides',
  'gridAutoTracks','gridColumnCount','gridRowCount','gridColumnGap','gridRowGap','gridColumnSizes','gridRowSizes','gridColumnSpan','gridRowSpan','gridColumnAnchorIndex','gridRowAnchorIndex','gridChildHorizontalAlign','gridChildVerticalAlign','gridItemsPositioning',
  'characters','fontName','fontSize','fontWeight','hasMissingFont','textAlignHorizontal','textAlignVertical','textAutoResize','textCase','textDecoration','textTruncation','maxLines',
  'lineHeight','letterSpacing','leadingTrim','paragraphIndent','paragraphSpacing','listSpacing','hangingPunctuation','hangingList','hyperlink','textStyleId','openTypeFeatures',
  'arcData','pointCount','innerRadius','vectorNetwork','vectorPaths','handleMirroring','windingRule',
  'booleanOperation','componentPropertyDefinitions','componentPropertyReferences','componentProperties','variantProperties','detachedInfo','overrides','scaleFactor','exposedInstances','isExposedInstance','key','description','descriptionMarkdown','remote',
  'boundVariables','inferredVariables','resolvedVariableModes','explicitVariableModes','annotations','reactions','overlayPositionType','overlayBackground','overlayBackgroundInteraction','prototypeStartNode',
  'scrollBehavior','isAsset','devStatus','sectionContentsHidden','documentationLinks','animationStyles','animations','manualKeyframeTracks','timelines'
]

const HEAVY_NODE_PROPS = new Set(['vectorNetwork','vectorPaths','fillGeometry','strokeGeometry','animations','manualKeyframeTracks']);

const WRITABLE_BLOCKLIST = new Set([
  'id','type','parent','children','removed','absoluteTransform','absoluteBoundingBox','absoluteRenderBounds','mainComponent','key','remote'
]);

function nodeSummary(node, opts = {}) {
  const out = {
    id: node.id,
    type: node.type,
    name: node.name || '',
    parentId: node.parent && node.parent.id ? node.parent.id : null
  };
  if (opts.fingerprint !== false) out.fingerprint = nodeFingerprint(node, true);
  for (const k of ['visible','locked','opacity','x','y','width','height','isMask','maskType','layoutMode','layoutSizingHorizontal','layoutSizingVertical','clipsContent']) {
    const v = tryRead(node, k);
    if (v !== undefined) out[k] = v;
  }
  if (opts.maskInfo !== false) {
    const mask = maskInfoFor(node);
    if (mask) Object.assign(out, mask);
  }
  return out;
}

async function serializeNode(node, opts = {}, state) {
  const depth = Math.max(0, Math.min(Number(opts.depth || 0), 12));
  const childOffset = Math.max(0, Number(opts.childOffset || 0));
  const childLimit = Math.max(1, Math.min(Number(opts.childLimit || 100), 1000));
  const mode = opts.mode || 'full';

  state.count++;
  if (state.count > state.maxNodes) {
    state.truncated = true;
    return { id: node.id, type: node.type, name: node.name || '', truncated: true };
  }

  const out = nodeSummary(node);
  if (node.type === 'TEXT') {
    const characters = tryRead(node, 'characters');
    if (characters !== undefined) out.characters = characters;
  }
  if (mode !== 'summary') {
    for (const key of NODE_PROPS) {
      if (key in out) continue;
      if (HEAVY_NODE_PROPS.has(key) && !opts.includeGeometry) continue;
      const v = tryRead(node, key);
      if (v !== undefined) out[key] = v;
    }
  }

  if (node.type === 'TEXT' && opts.includeTextSegments && typeof node.getStyledTextSegments === 'function') {
    try {
      const fields = textSegmentFields(opts.textSegmentFields);
      out.textSegments = safeValue(node.getStyledTextSegments(fields));
    } catch (e) {
      out.textSegmentsError = errObj(e);
    }
  }

  if (opts.includeReactions && typeof node.getReactionsAsync === 'function') {
    try { out.reactions = safeValue(await node.getReactionsAsync()); } catch (e) { out.reactionsError = errObj(e); }
  }

  if (opts.includeComponentDetails && node.type === 'INSTANCE' && typeof node.getMainComponentAsync === 'function') {
    try {
      const main = await node.getMainComponentAsync();
      out.mainComponentResolved = main ? nodeSummary(main) : null;
      out.overrides = tryRead(node, 'overrides');
    } catch (e) { out.componentDetailsError = errObj(e); }
  }

  if (opts.includeStyles) {
    const styleFields = ['fillStyleId','strokeStyleId','effectStyleId','gridStyleId','textStyleId'];
    out.resolvedStyles = {};
    for (const field of styleFields) {
      const id = tryRead(node, field);
      if (!id || id === '__MIXED__') continue;
      try {
        const style = await figma.getStyleByIdAsync(String(id));
        out.resolvedStyles[field] = style ? { id:style.id, name:style.name, type:style.type, remote:!!style.remote, key:style.key || null } : null;
      } catch (e) { out.resolvedStyles[field] = { error:errObj(e) }; }
    }
  }

  if (opts.includeDevResources && typeof node.getDevResourcesAsync === 'function') {
    try { out.devResources = safeValue(await node.getDevResourcesAsync({ includeChildren: !!opts.includeDevResourcesChildren })); }
    catch (e) { out.devResourcesError = errObj(e); }
  }

  if (opts.includeCSS && typeof node.getCSSAsync === 'function') {
    try { out.css = safeValue(await node.getCSSAsync()); } catch (e) { out.cssError = errObj(e); }
  }

  if (opts.includeMeasurements && node.type === 'PAGE' && typeof node.getMeasurements === 'function') {
    try { out.measurements = safeValue(node.getMeasurements()); } catch (e) { out.measurementsError = errObj(e); }
  }

  if (opts.includePluginData) {
    try {
      const keys = typeof node.getPluginDataKeys === 'function' ? node.getPluginDataKeys() : [];
      out.pluginData = {};
      for (const k of keys) out.pluginData[k] = node.getPluginData(k);
    } catch (_) {}
  }

  if (depth > 0 && 'children' in node && Array.isArray(node.children)) {
    const children = node.children;
    const slice = children.slice(childOffset, childOffset + childLimit);
    out.childCount = children.length;
    out.childOffset = childOffset;
    out.childLimit = childLimit;
    out.children = [];
    for (const child of slice) {
      out.children.push(await serializeNode(child, { ...opts, depth: depth - 1, childOffset: 0 }, state));
      if (state.truncated) break;
    }
    out.hasMoreChildren = childOffset + slice.length < children.length;
  }
  return out;
}

async function getNode(id) {
  if (!id) throw new Error('node id is required');
  const node = await figma.getNodeByIdAsync(String(id));
  if (!node) throw new Error(`Node not found: ${id}`);
  await maybeLoadPageForNode(node);
  return node;
}

async function getStyle(id) {
  if (!id) throw new Error('style id is required');
  const style = await figma.getStyleByIdAsync(String(id));
  if (!style) throw new Error(`Style not found: ${id}`);
  return style;
}

async function getVariable(id) {
  if (!id) throw new Error('variable id is required');
  const variable = await figma.variables.getVariableByIdAsync(String(id));
  if (!variable) throw new Error(`Variable not found: ${id}`);
  return variable;
}

async function getVariableCollection(id) {
  if (!id) throw new Error('variable collection id is required');
  const collection = await figma.variables.getVariableCollectionByIdAsync(String(id));
  if (!collection) throw new Error(`Variable collection not found: ${id}`);
  return collection;
}

async function resolveArg(v) {
  if (Array.isArray(v)) return Promise.all(v.map(resolveArg));
  if (!v || typeof v !== 'object') return v;
  if ('$node' in v) return getNode(v.$node);
  if ('$style' in v) return getStyle(v.$style);
  if ('$variableAlias' in v) {
    const variable = await getVariable(v.$variableAlias);
    if (!figma.variables || typeof figma.variables.createVariableAlias !== 'function') throw new Error('Variable aliases are unavailable in this Figma API version');
    return figma.variables.createVariableAlias(variable);
  }
  if ('$variable' in v) return getVariable(v.$variable);
  if ('$collection' in v) return getVariableCollection(v.$collection);
  if ('$bytes' in v) return base64ToBytes(v.$bytes);
  const out = {};
  for (const [k, value] of Object.entries(v)) out[k] = await resolveArg(value);
  return out;
}

const loadedFontKeys = new Set();

async function ensureTextFonts(node) {
  if (!node || node.type !== 'TEXT') return;
  const names = [];
  try {
    if (node.characters.length === 0) {
      const f = node.fontName;
      if (!isMixed(f)) names.push(f);
    } else if (typeof node.getRangeAllFontNames === 'function') {
      names.push(...node.getRangeAllFontNames(0, node.characters.length));
    }
  } catch (_) {
    const f = tryRead(node, 'fontName');
    if (f && f !== '__MIXED__') names.push(f);
  }
  const seen = new Set();
  for (const f of names) {
    if (!f || !f.family || !f.style) continue;
    const key = `${f.family}\u0000${f.style}`;
    if (seen.has(key) || loadedFontKeys.has(key)) continue;
    seen.add(key);
    await figma.loadFontAsync(f);
    loadedFontKeys.add(key);
  }
}

const ASYNC_PROP_SETTERS = {
  fillStyleId: 'setFillStyleIdAsync',
  strokeStyleId: 'setStrokeStyleIdAsync',
  effectStyleId: 'setEffectStyleIdAsync',
  gridStyleId: 'setGridStyleIdAsync',
  textStyleId: 'setTextStyleIdAsync',
  reactions: 'setReactionsAsync',
  fills: 'setFillsAsync',
  strokes: 'setStrokesAsync',
  vectorNetwork: 'setVectorNetworkAsync'
};

async function setProps(target, props, opts = {}) {
  if (!props || typeof props !== 'object') throw new Error('props must be an object');
  const results = {};
  if (target && target.type === 'TEXT' && opts.loadFonts) await ensureTextFonts(target);

  for (const [key, raw] of Object.entries(props)) {
    if (WRITABLE_BLOCKLIST.has(key)) {
      results[key] = { ok: false, error: 'blocked read-only/core property' };
      if (opts.strict) throw new Error(`Failed setting ${key}: blocked read-only/core property`);
      continue;
    }
    if (target && target.type === 'TEXT' && key === 'characters' && !opts.allowTextReset) {
      const message = 'Direct characters assignment is blocked because Figma resets styled text ranges. Use figma_text or a text batch operation; set allowTextReset only when a style reset is intentional.';
      results[key] = { ok: false, error: message };
      if (opts.strict) throw new Error(message);
      continue;
    }
    try {
      const value = await resolveArg(raw);
      if (target && target.type === 'TEXT') {
        if (key === 'fontName' && value && value.family && value.style) await figma.loadFontAsync(value);
        else if (['fontSize','textAlignHorizontal','textAlignVertical','textAutoResize','textCase','textDecoration','lineHeight','letterSpacing','paragraphIndent','paragraphSpacing','leadingTrim'].includes(key)) await ensureTextFonts(target);
      }
      const setter = ASYNC_PROP_SETTERS[key];
      if (setter && typeof target[setter] === 'function') await target[setter](value);
      else target[key] = value;
      results[key] = { ok: true, value: tryRead(target, key) };
    } catch (e) {
      results[key] = { ok: false, error: errObj(e) };
      if (opts.strict) throw new Error(`Failed setting ${key}: ${errObj(e).message}`);
    }
  }
  return results;
}

function createNodeByType(type) {
  const t = String(type || '').toUpperCase();
  switch (t) {
    case 'RECTANGLE': return figma.createRectangle();
    case 'LINE': return figma.createLine();
    case 'ELLIPSE': return figma.createEllipse();
    case 'POLYGON': return figma.createPolygon();
    case 'STAR': return figma.createStar();
    case 'VECTOR': return figma.createVector();
    case 'TEXT': return figma.createText();
    case 'FRAME': return figma.createFrame();
    case 'COMPONENT': return figma.createComponent();
    case 'SLICE': return figma.createSlice();
    case 'SECTION': if (typeof figma.createSection === 'function') return figma.createSection(); break;
    case 'PAGE': return figma.createPage();
    default: break;
  }
  throw new Error(`Unsupported create type: ${t}. Use figma_invoke for newer editor-specific node factories.`);
}

async function appendToParent(node, parentId, index) {
  if (!parentId) return;
  const parent = await getNode(parentId);
  if (!('appendChild' in parent)) throw new Error(`Parent ${parentId} cannot contain children`);
  if (Number.isInteger(index) && typeof parent.insertChild === 'function') parent.insertChild(index, node);
  else parent.appendChild(node);
}

async function opCreate(op) {
  let node;
  if (op.svg != null) node = figma.createNodeFromSvg(String(op.svg));
  else node = createNodeByType(op.nodeType || op.type);
  if (op.parentId) await appendToParent(node, op.parentId, op.index);
  if (op.props) await setProps(node, op.props, { strict: !!op.strict, loadFonts: true, allowTextReset: true });
  if (op.name != null) node.name = String(op.name);
  return nodeSummary(node);
}

async function opPatch(op) {
  const node = await getNode(op.nodeId);
  return { node: nodeSummary(node), properties: await setProps(node, op.props || {}, { strict: !!op.strict, loadFonts: true, allowTextReset: !!op.allowTextReset }) };
}

async function opResize(op) {
  const node = await getNode(op.nodeId);
  if (!('resize' in node)) throw new Error('Node does not support resize');
  const w = Number(op.width), h = Number(op.height);
  if (op.withoutConstraints && typeof node.resizeWithoutConstraints === 'function') node.resizeWithoutConstraints(w, h);
  else node.resize(w, h);
  return nodeSummary(node);
}

async function opReparent(op) {
  const node = await getNode(op.nodeId);
  const parent = await getNode(op.parentId);
  if (!('appendChild' in parent)) throw new Error('Target parent cannot contain children');
  if (Number.isInteger(op.index) && typeof parent.insertChild === 'function') parent.insertChild(op.index, node);
  else parent.appendChild(node);
  return nodeSummary(node);
}

async function opReorder(op) {
  const node = await getNode(op.nodeId);
  const parent = node.parent;
  if (!parent || !('insertChild' in parent)) throw new Error('Node parent cannot reorder children');
  parent.insertChild(Number(op.index), node);
  return nodeSummary(node);
}

async function opRemove(op) {
  const node = await getNode(op.nodeId);
  const summary = nodeSummary(node);
  if (!('remove' in node)) throw new Error('Node cannot be removed');
  node.remove();
  return summary;
}

async function opClone(op) {
  const node = await getNode(op.nodeId);
  if (typeof node.clone !== 'function') throw new Error('Node cannot be cloned');
  const clone = node.clone();
  if (op.parentId) await appendToParent(clone, op.parentId, op.index);
  if (op.props) await setProps(clone, op.props, { strict: !!op.strict, loadFonts: true });
  return nodeSummary(clone);
}

async function setTextRangeProps(node, start, end, props) {
  for (const [key, raw] of Object.entries(props || {})) {
    let method = 'setRange' + key.charAt(0).toUpperCase() + key.slice(1);
    const value = await resolveArg(raw);
    if (key === 'fontName' && value) await figma.loadFontAsync(value);
    if (key === 'textStyleId' && typeof node.setRangeTextStyleIdAsync === 'function') method = 'setRangeTextStyleIdAsync';
    if (key === 'fillStyleId' && typeof node.setRangeFillStyleIdAsync === 'function') method = 'setRangeFillStyleIdAsync';
    if (typeof node[method] !== 'function') throw new Error(`Unsupported text range property: ${key}`);
    await node[method](start, end, value);
  }
}

function clampTextRange(node, start, end) {
  const len = node.characters.length;
  const s = Math.max(0, Math.min(Number(start), len));
  const e = Math.max(s, Math.min(Number(end), len));
  return [s, e];
}

function replaceTextRangePreserveStyle(node, start, end, replacement, useStyle) {
  const [s, e] = clampTextRange(node, start, end);
  const text = String(replacement == null ? '' : replacement);
  if (text) {
    const style = useStyle || (s < node.characters.length ? 'AFTER' : 'BEFORE');
    node.insertCharacters(s, text, style);
  }
  if (e > s) node.deleteCharacters(s + text.length, e + text.length);
  return { start:s, oldEnd:e, newEnd:s + text.length };
}

async function opText(op) {
  const node = await getNode(op.nodeId);
  if (node.type !== 'TEXT') throw new Error('text operation requires a TEXT node');
  await ensureTextFonts(node);
  const beforeFingerprint = nodeFingerprint(node, true);

  if (op.characters != null) {
    if (op.allowStyleReset) node.characters = String(op.characters);
    else replaceTextRangePreserveStyle(node, 0, node.characters.length, String(op.characters), 'AFTER');
  }
  if (op.insert != null) {
    const at = Math.max(0, Math.min(Number(op.at || 0), node.characters.length));
    node.insertCharacters(at, String(op.insert), op.useStyle || (at < node.characters.length ? 'AFTER' : 'BEFORE'));
  }
  if (op.deleteRange) {
    const [s,e] = clampTextRange(node, op.deleteRange.start, op.deleteRange.end);
    node.deleteCharacters(s,e);
  }
  if (op.replaceRange) {
    replaceTextRangePreserveStyle(node, op.replaceRange.start, op.replaceRange.end, op.replaceRange.text || '', op.replaceRange.useStyle);
  }
  if (Array.isArray(op.ranges)) {
    for (const r of op.ranges) {
      const [start,end] = clampTextRange(node, r.start, r.end);
      if (r.props) await setTextRangeProps(node, start, end, r.props);
    }
  }
  return { ...nodeSummary(node), beforeFingerprint, characters: node.characters };
}

async function opSelection(op) {
  const nodes = [];
  for (const id of op.nodeIds || []) {
    const n = await getNode(id);
    if ('visible' in n) nodes.push(n);
  }
  figma.currentPage.selection = nodes;
  if (op.zoom !== false && nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
  return nodes.map(nodeSummary);
}

async function opFigma(op) {
  const method = String(op.method || '');
  const allowed = new Set([
    'group','ungroup','flatten','union','subtract','intersect','exclude','combineAsVariants','createComponentFromNode','transformGroup',
    'setCurrentPageAsync','createNodeFromJSXAsync','moveNodesToCoord'
  ]);
  if (!allowed.has(method)) throw new Error(`figma method not allowed in standard invoke: ${method}`);
  if (typeof figma[method] !== 'function') throw new Error(`figma.${method} is unavailable in this editor/API version`);
  const args = await resolveArg(op.args || []);
  const result = await figma[method](...args);
  return safeValue(result);
}

async function opInvoke(op) {
  const targetKind = op.target || 'node';
  let target;
  if (targetKind === 'figma') target = figma;
  else if (targetKind === 'node') target = await getNode(op.id || op.nodeId);
  else if (targetKind === 'style') target = await getStyle(op.id);
  else if (targetKind === 'variable') target = await getVariable(op.id);
  else if (targetKind === 'variables') target = figma.variables;
  else if (targetKind === 'teamLibrary') target = figma.teamLibrary;
  else if (targetKind === 'annotations') target = figma.annotations;
  else if (targetKind === 'motion') target = figma.motion;
  else if (targetKind === 'util') target = figma.util;
  else if (targetKind === 'viewport') target = figma.viewport;
  else if (targetKind === 'constants') target = figma.constants;
  else throw new Error(`Unknown invoke target: ${targetKind}`);

  const method = String(op.method || '');
  if (!method || method.startsWith('_') || ['closePlugin','showUI','openExternal'].includes(method)) throw new Error('Method is blocked');
  const fn = target[method];
  if (typeof fn !== 'function') throw new Error(`Method unavailable: ${targetKind}.${method}`);
  const args = await resolveArg(op.args || []);
  const result = await fn.apply(target, args);
  return safeValue(result);
}

async function opSetTargetProps(op) {
  const kind = op.target || 'node';
  let target;
  if (kind === 'node') target = await getNode(op.id || op.nodeId);
  else if (kind === 'style') target = await getStyle(op.id);
  else if (kind === 'variable') target = await getVariable(op.id);
  else if (kind === 'figma') target = figma;
  else throw new Error(`Unsupported property target: ${kind}`);
  return setProps(target, op.props || {}, { strict: !!op.strict, loadFonts: true, allowTextReset: !!op.allowTextReset });
}


function sameJson(a, b) {
  try { return JSON.stringify(safeValue(a)) === JSON.stringify(safeValue(b)); } catch (_) { return a === b; }
}

async function opAssert(op) {
  const node = await getNode(op.nodeId);
  if (op.type != null && node.type !== op.type) throw new Error(`Assertion failed: ${op.nodeId} type is ${node.type}, expected ${op.type}`);
  if (op.name != null && node.name !== op.name) throw new Error(`Assertion failed: ${op.nodeId} name is ${node.name}, expected ${op.name}`);
  if (op.parentId != null && (!node.parent || node.parent.id !== op.parentId)) throw new Error(`Assertion failed: ${op.nodeId} parent mismatch`);
  if (op.fingerprint != null) {
    const actualFingerprint = nodeFingerprint(node, true);
    if (actualFingerprint !== String(op.fingerprint)) throw new Error(`Assertion failed: ${op.nodeId} fingerprint is ${actualFingerprint}, expected ${op.fingerprint}`);
  }
  for (const [key, expected] of Object.entries(op.props || {})) {
    let actual;
    try { actual = node[key]; } catch (e) { throw new Error(`Assertion failed reading ${key}: ${errObj(e).message}`); }
    if (!sameJson(actual, expected)) throw new Error(`Assertion failed: ${op.nodeId}.${key} = ${JSON.stringify(safeValue(actual))}, expected ${JSON.stringify(expected)}`);
  }
  return { asserted: true, node: nodeSummary(node) };
}

function substituteRefs(value, refs) {
  if (typeof value === 'string' && value.startsWith('$ref:')) {
    const key = value.slice(5);
    if (!(key in refs)) throw new Error(`Unknown batch ref: ${key}`);
    return refs[key];
  }
  if (Array.isArray(value)) return value.map(v => substituteRefs(v, refs));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k,v] of Object.entries(value)) out[k] = substituteRefs(v, refs);
    return out;
  }
  return value;
}

function resultNodeId(result) {
  if (!result || typeof result !== 'object') return null;
  if (typeof result.id === 'string') return result.id;
  if (result.node && typeof result.node.id === 'string') return result.node.id;
  return null;
}

async function executeOperation(op) {
  const kind = String(op.op || op.kind || '').toLowerCase();
  switch (kind) {
    case 'create': return opCreate(op);
    case 'patch': return opPatch(op);
    case 'resize': return opResize(op);
    case 'reparent': return opReparent(op);
    case 'reorder': return opReorder(op);
    case 'remove': return opRemove(op);
    case 'clone': return opClone(op);
    case 'text': return opText(op);
    case 'selection': return opSelection(op);
    case 'figma': return opFigma(op);
    case 'invoke':
      if (op.unsafe !== true) throw new Error('Batch invoke requires unsafe=true');
      return opInvoke(op);
    case 'set_target_props': return opSetTargetProps(op);
    case 'assert': return opAssert(op);
    default: throw new Error(`Unknown operation: ${kind}`);
  }
}

async function cmdContext(params = {}) {
  const pages = figma.root.children.map(p => ({ id: p.id, name: p.name, type: p.type }));
  return {
    bridgeVersion: BRIDGE_VERSION,
    apiVersion: figma.apiVersion,
    editorType: figma.editorType,
    mode: figma.mode,
    fileName: figma.root.name,
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    pages,
    selection: figma.currentPage.selection.map(nodeSummary),
    viewport: {
      center: safeValue(figma.viewport.center),
      zoom: figma.viewport.zoom,
      bounds: safeValue(figma.viewport.bounds)
    },
    skipInvisibleInstanceChildren: figma.skipInvisibleInstanceChildren
  };
}

async function cmdInspect(params = {}) {
  const ids = params.ids && params.ids.length ? params.ids : figma.currentPage.selection.map(n => n.id);
  if (!ids.length) throw new Error('No ids supplied and selection is empty');
  const state = { count: 0, maxNodes: Math.max(1, Math.min(Number(params.maxNodes || 500), 5000)), truncated: false };
  const nodes = [];
  for (const id of ids) {
    const n = await getNode(id);
    nodes.push(await serializeNode(n, params, state));
    if (state.truncated) break;
  }
  return { nodes, count: state.count, truncated: state.truncated };
}

function matchesQuery(node, q) {
  if (q.types && q.types.length && !q.types.includes(node.type)) return false;
  if (q.visible != null && 'visible' in node && node.visible !== !!q.visible) return false;
  if (q.isMask != null && 'isMask' in node && node.isMask !== !!q.isMask) return false;
  if (q.parentId != null && String((node.parent && node.parent.id) || '') !== String(q.parentId)) return false;
  if (q.topLevelOnly === true) {
    const p = node.parent;
    if (!p || p.type !== 'PAGE') return false;
  }
  if (q.isMasked != null) {
    const info = maskInfoFor(node);
    const isMasked = !!(info && info.maskedBy);
    if (isMasked !== !!q.isMasked) return false;
  }
  if (q.hasEffects != null) {
    const fx = tryRead(node, 'effects');
    if ((Array.isArray(fx) && fx.length > 0) !== !!q.hasEffects) return false;
  }
  if (q.name) {
    const n = String(node.name || '');
    const needle = String(q.name);
    if (q.nameMode === 'exact') { if (n !== needle) return false; }
    else if (q.nameMode === 'regex') {
      try { if (!(new RegExp(needle, q.caseSensitive ? '' : 'i')).test(n)) return false; } catch (_) { return false; }
    } else {
      if (!(q.caseSensitive ? n : n.toLowerCase()).includes(q.caseSensitive ? needle : needle.toLowerCase())) return false;
    }
  }
  return true;
}

async function cmdSearch(params = {}) {
  const startedAt = Date.now();
  const limit = Math.max(1, Math.min(Number(params.limit || 200), 2000));
  const offset = Math.max(0, Number(params.offset || 0));
  const scope = params.scope || 'currentPage';
  const found = [];
  let matched = 0;
  let visited = 0;
  let pagesLoaded = 0;
  // Default to *not* skipping hidden instance children: skipping them silently
  // hides real nodes from search and contradicts what figma_context reports.
  // Callers opt into the faster traversal explicitly.
  const previousSkipInvisible = figma.skipInvisibleInstanceChildren;
  figma.skipInvisibleInstanceChildren = params.skipInvisibleInstanceChildren === true;

  const collect = (node) => {
    visited++;
    if (node !== figma.root && node.type !== 'PAGE' && matchesQuery(node, params)) {
      if (matched++ >= offset && found.length < limit) found.push(nodeSummary(node,{fingerprint:!!params.includeFingerprint}));
    }
    // Stop only once we have seen one match beyond the requested window, so
    // hasMore can distinguish "exactly full" from "truncated".
    if (matched > offset + limit) return true;
    if ('children' in node && Array.isArray(node.children)) {
      for (const c of node.children) if (collect(c)) return true;
    }
    return false;
  };

  try {
    if (scope === 'selection') {
      for (const root of figma.currentPage.selection) if (collect(root)) break;
    } else if (scope === 'within') {
      const root = await getNode(params.withinId);
      collect(root);
    } else if (scope === 'pages' || scope === 'allPages') {
      const wanted = scope === 'pages' && Array.isArray(params.pageIds) && params.pageIds.length
        ? new Set(params.pageIds.map(String)) : null;
      for (const page of figma.root.children) {
        if (wanted && !wanted.has(page.id)) continue;
        if (page !== figma.currentPage && typeof page.loadAsync === 'function') {
          await page.loadAsync();
          pagesLoaded++;
        }
        if (collect(page)) break;
      }
    } else {
      collect(figma.currentPage);
    }
  } finally {
    figma.skipInvisibleInstanceChildren = previousSkipInvisible;
  }
  return {
    results: found,
    offset,
    limit,
    hasMore: matched > offset + found.length,
    matchedThrough: matched,
    visited,
    pagesLoaded,
    timingMs: Date.now() - startedAt
  };
}


async function cmdSnapshot(params = {}) {
  const id = params.id || (figma.currentPage.selection[0] && figma.currentPage.selection[0].id);
  if (!id) throw new Error('No node id supplied and selection is empty');
  const node = await getNode(id);
  const state = { count:0, maxNodes:Math.max(1,Math.min(Number(params.maxNodes||750),2500)), truncated:false };
  const structure = await serializeNode(node, {
    mode:params.mode || 'full',
    depth:Math.max(0,Math.min(Number(params.depth||1),6)),
    childLimit:Math.max(1,Math.min(Number(params.childLimit||100),500)),
    includeGeometry:!!params.includeGeometry,
    includeTextSegments:!!params.includeTextSegments,
    includeComponentDetails:params.includeComponentDetails !== false,
    includeStyles:!!params.includeStyles,
    includeCSS:!!params.includeCSS,
    includeDevResources:!!params.includeDevResources
  }, state);
  let render = null;
  if (params.render !== false && typeof node.exportAsync === 'function') {
    const settings={format:'PNG',contentsOnly:params.contentsOnly!==false,useAbsoluteBounds:!!params.useAbsoluteBounds};
    if (params.scale) settings.constraint={type:'SCALE',value:Math.max(.05,Math.min(Number(params.scale),4))};
    const bytes=await node.exportAsync(settings);
    render={format:'PNG',base64:bytesToBase64(bytes),byteLength:bytes.byteLength};
  }
  return { id, structure, nodeCount:state.count, truncated:state.truncated, render };
}

async function cmdRender(params = {}) {
  const id = params.id || (figma.currentPage.selection[0] && figma.currentPage.selection[0].id);
  if (!id) throw new Error('No node id supplied and selection is empty');
  const node = await getNode(id);
  if (typeof node.exportAsync !== 'function') throw new Error('Node cannot be exported');
  const format = String(params.format || 'PNG').toUpperCase();
  let settings;
  if (format === 'PNG' || format === 'JPG') {
    settings = { format, contentsOnly: params.contentsOnly !== false, useAbsoluteBounds: !!params.useAbsoluteBounds };
    if (params.scale) settings.constraint = { type: 'SCALE', value: Math.max(0.01, Math.min(Number(params.scale), 8)) };
  } else if (format === 'SVG_STRING') {
    settings = { format: 'SVG_STRING', contentsOnly: params.contentsOnly !== false, useAbsoluteBounds: !!params.useAbsoluteBounds };
  } else if (format === 'JSON_REST_V1') {
    settings = { format: 'JSON_REST_V1' };
  } else if (format === 'PDF') {
    settings = { format: 'PDF', contentsOnly: params.contentsOnly !== false };
  } else throw new Error(`Unsupported render format: ${format}`);

  const data = await node.exportAsync(settings);
  if (typeof data === 'string') return { id, format, text: data };
  if (data instanceof Uint8Array) return { id, format, base64: bytesToBase64(data), byteLength: data.byteLength };
  return { id, format, data: safeValue(data) };
}

async function cmdBatch(params = {}) {
  const ops = Array.isArray(params.operations) ? params.operations : [];
  if (!ops.length) throw new Error('operations must be a non-empty array');
  if (ops.length > 250) throw new Error('Maximum 250 operations per batch');
  const commitBefore = params.commitBefore !== false;
  const rollbackOnError = params.rollbackOnError !== false;
  if (commitBefore) figma.commitUndo();
  const results = [];
  const refs = {};
  try {
    for (let i = 0; i < ops.length; i++) {
      const original = ops[i];
      const resolved = substituteRefs(original, refs);
      const result = await executeOperation(resolved);
      if (original.as) {
        const id = resultNodeId(result);
        if (!id) throw new Error(`Operation ${i} requested ref '${original.as}' but did not return a node id`);
        refs[String(original.as)] = id;
      }
      results.push({ index: i, ok: true, ...(original.as ? { as:String(original.as), nodeId:refs[String(original.as)] } : {}), result });
    }
    if (params.commitAfter !== false) figma.commitUndo();
    return { ok: true, refs, results };
  } catch (e) {
    const failure = errObj(e);
    if (rollbackOnError) {
      try { figma.triggerUndo(); } catch (_) {}
    }
    results.push({ index: results.length, ok: false, error: failure });
    return { ok: false, rolledBack: rollbackOnError, error: failure, results };
  }
}


async function cmdText(params = {}) {
  const action = params.action || 'inspect';
  const node = await getNode(params.nodeId || (figma.currentPage.selection[0] && figma.currentPage.selection[0].id));
  if (node.type !== 'TEXT') throw new Error('figma_text requires a TEXT node');

  if (action === 'inspect') {
    const fields = textSegmentFields(params.fields);
    const out = { node: nodeSummary(node), characters: node.characters, hasMissingFont: tryRead(node,'hasMissingFont') };
    if (params.includeRuns !== false && typeof node.getStyledTextSegments === 'function') {
      out.runs = safeValue(node.getStyledTextSegments(fields));
    }
    return out;
  }

  if (action === 'replaceAll') {
    const needle = String(params.find == null ? '' : params.find);
    if (!needle) throw new Error('find must be non-empty');
    const replacement = String(params.replace == null ? '' : params.replace);
    const caseSensitive = !!params.caseSensitive;
    let haystack = node.characters;
    let search = caseSensitive ? haystack : haystack.toLowerCase();
    const target = caseSensitive ? needle : needle.toLowerCase();
    let at = 0, count = 0;
    const ranges = [];
    while ((at = search.indexOf(target, at)) >= 0) {
      ranges.push([at, at + needle.length]);
      at += Math.max(needle.length, 1);
      if (ranges.length >= Math.min(Number(params.maxReplacements || 500), 5000)) break;
    }
    await ensureTextFonts(node);
    for (let i = ranges.length - 1; i >= 0; i--) {
      replaceTextRangePreserveStyle(node, ranges[i][0], ranges[i][1], replacement);
      count++;
    }
    return { node: nodeSummary(node), replacements: count, characters: params.returnText === false ? undefined : node.characters };
  }

  return opText({
    nodeId: node.id,
    ...(params.characters != null ? {characters:params.characters} : {}),
    ...(params.allowStyleReset ? {allowStyleReset:true} : {}),
    ...(params.insert != null ? {insert:params.insert, at:params.at, useStyle:params.useStyle} : {}),
    ...(params.deleteRange ? {deleteRange:params.deleteRange} : {}),
    ...(params.replaceRange ? {replaceRange:params.replaceRange} : {}),
    ...(params.ranges ? {ranges:params.ranges} : {})
  });
}

async function cmdComponents(params = {}) {
  const action = params.action || 'inspect';
  const nodeId = params.nodeId || (figma.currentPage.selection[0] && figma.currentPage.selection[0].id);
  const node = nodeId ? await getNode(nodeId) : null;

  if (action === 'inspect') {
    if (!node) throw new Error('nodeId required');
    const out = { node: nodeSummary(node), componentProperties: tryRead(node,'componentProperties'), variantProperties: tryRead(node,'variantProperties') };
    if (node.type === 'INSTANCE') {
      out.mainComponent = typeof node.getMainComponentAsync === 'function' ? safeValue(await node.getMainComponentAsync()) : tryRead(node,'mainComponent');
      out.overrides = tryRead(node,'overrides');
    }
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      out.componentPropertyDefinitions = tryRead(node,'componentPropertyDefinitions');
      out.exposedInstances = tryRead(node,'exposedInstances');
    }
    return out;
  }
  if (action === 'createInstance') {
    if (!node || node.type !== 'COMPONENT') throw new Error('createInstance requires nodeId of a COMPONENT');
    const instance = node.createInstance();
    if (params.parentId) await appendToParent(instance, params.parentId, params.index);
    return nodeSummary(instance);
  }
  if (action === 'swap') {
    if (!node || node.type !== 'INSTANCE') throw new Error('swap requires nodeId of an INSTANCE');
    const component = await getNode(params.componentId);
    if (component.type !== 'COMPONENT') throw new Error('componentId must be a COMPONENT');
    node.swapComponent(component);
    return nodeSummary(node);
  }
  if (action === 'setProperties') {
    if (!node || node.type !== 'INSTANCE' || typeof node.setProperties !== 'function') throw new Error('setProperties requires an INSTANCE');
    node.setProperties(await resolveArg(params.properties || {}));
    return { node:nodeSummary(node), componentProperties:tryRead(node,'componentProperties') };
  }
  if (action === 'removeOverrides') {
    if (!node || node.type !== 'INSTANCE' || typeof node.removeOverrides !== 'function') throw new Error('removeOverrides unavailable');
    node.removeOverrides();
    return nodeSummary(node);
  }
  if (action === 'detach') {
    if (!node || node.type !== 'INSTANCE') throw new Error('detach requires an INSTANCE');
    const detached = node.detachInstance();
    return nodeSummary(detached);
  }
  if (action === 'createComponentFromNode') {
    if (!node || typeof figma.createComponentFromNode !== 'function') throw new Error('createComponentFromNode unavailable');
    return nodeSummary(figma.createComponentFromNode(node));
  }
  if (action === 'combineAsVariants') {
    const ids = Array.isArray(params.nodeIds) ? params.nodeIds : [];
    const components = [];
    for (const id of ids) {
      const c = await getNode(id);
      if (c.type !== 'COMPONENT') throw new Error(`${id} is not a COMPONENT`);
      components.push(c);
    }
    if (!components.length) throw new Error('nodeIds required');
    const parent = params.parentId ? await getNode(params.parentId) : figma.currentPage;
    const set = figma.combineAsVariants(components, parent, params.index);
    return nodeSummary(set);
  }
  throw new Error(`Unknown components action: ${action}`);
}

async function cmdPrototype(params = {}) {
  const action = params.action || 'get';
  const node = await getNode(params.nodeId || (figma.currentPage.selection[0] && figma.currentPage.selection[0].id));
  if (action === 'get') {
    let reactions = tryRead(node,'reactions');
    if (typeof node.getReactionsAsync === 'function') {
      try { reactions = safeValue(await node.getReactionsAsync()); } catch (_) {}
    }
    return {
      node: nodeSummary(node),
      reactions,
      overflowDirection: tryRead(node,'overflowDirection'),
      overlayPositionType: tryRead(node,'overlayPositionType'),
      overlayBackground: tryRead(node,'overlayBackground'),
      overlayBackgroundInteraction: tryRead(node,'overlayBackgroundInteraction'),
      prototypeStartNode: tryRead(node,'prototypeStartNode')
    };
  }
  if (action === 'setReactions') {
    const reactions = await resolveArg(params.reactions || []);
    if (typeof node.setReactionsAsync === 'function') await node.setReactionsAsync(reactions);
    else node.reactions = reactions;
    return { node:nodeSummary(node), reactions:tryRead(node,'reactions') };
  }
  throw new Error(`Unknown prototype action: ${action}`);
}

async function cmdDev(params = {}) {
  const action = params.action || 'css';
  const node = await getNode(params.nodeId || (figma.currentPage.selection[0] && figma.currentPage.selection[0].id));
  if (action === 'css') {
    if (typeof node.getCSSAsync !== 'function') throw new Error('getCSSAsync unavailable on this node/editor');
    return { node:nodeSummary(node), css:safeValue(await node.getCSSAsync()) };
  }
  if (action === 'resources') {
    if (typeof node.getDevResourcesAsync !== 'function') throw new Error('Dev resources unavailable');
    return { node:nodeSummary(node), resources:safeValue(await node.getDevResourcesAsync({includeChildren:!!params.includeChildren})) };
  }
  if (action === 'addResource') {
    if (typeof node.addDevResourceAsync !== 'function') throw new Error('addDevResourceAsync unavailable');
    await node.addDevResourceAsync(String(params.url||''), params.name != null ? String(params.name) : undefined);
    return {ok:true};
  }
  if (action === 'editResource') {
    if (typeof node.editDevResourceAsync !== 'function') throw new Error('editDevResourceAsync unavailable');
    await node.editDevResourceAsync(String(params.currentUrl||''), params.newValue || {});
    return {ok:true};
  }
  if (action === 'deleteResource') {
    if (typeof node.deleteDevResourceAsync !== 'function') throw new Error('deleteDevResourceAsync unavailable');
    await node.deleteDevResourceAsync(String(params.url||''));
    return {ok:true};
  }
  if (action === 'measurements') {
    const page = node.type === 'PAGE' ? node : figma.currentPage;
    if (typeof page.getMeasurements !== 'function') throw new Error('Measurements unavailable');
    return { page:{id:page.id,name:page.name}, measurements:safeValue(page.getMeasurements()) };
  }
  throw new Error(`Unknown dev action: ${action}`);
}

async function cmdMotion(params = {}) {
  const action = params.action || 'inspect';
  const node = await getNode(params.nodeId || (figma.currentPage.selection[0] && figma.currentPage.selection[0].id));
  if (action === 'inspect') {
    return { node:nodeSummary(node), animationStyles:tryRead(node,'animationStyles'), animations:tryRead(node,'animations'), manualKeyframeTracks:tryRead(node,'manualKeyframeTracks'), timelines:tryRead(node,'timelines') };
  }
  const methodMap = {
    applyStyle:'applyAnimationStyle',
    removeStyle:'removeAnimationStyle',
    applyTrack:'applyManualKeyframeTrack',
    removeTrack:'removeManualKeyframeTrack',
    setTimelineDuration:'setTimelineDuration'
  };
  const method = methodMap[action];
  if (!method || typeof node[method] !== 'function') throw new Error(`Motion action unavailable: ${action}`);
  const args = await resolveArg(params.args || []);
  const result = await node[method](...args);
  return { node:nodeSummary(node), result:safeValue(result) };
}

function countTree(root, stats, maxNodes) {
  if (stats.total >= maxNodes) { stats.truncated = true; return true; }
  stats.total++;
  stats.byType[root.type] = (stats.byType[root.type] || 0) + 1;
  if (root.type === 'TEXT') stats.textNodes++;
  if (tryRead(root,'isMask') === true) {
    stats.masks++;
    const info = maskInfoFor(root);
    if (info && info.masks) {
      stats.maskedNodes += info.masks.maskedCount;
      const t = info.masks.maskType || 'ALPHA';
      stats.masksByType[t] = (stats.masksByType[t] || 0) + 1;
      if (info.masks.maskedCount === 0) stats.emptyMasks++;
    }
  }
  const effects = tryRead(root,'effects');
  if (Array.isArray(effects) && effects.length) stats.nodesWithEffects++;
  if ('children' in root && Array.isArray(root.children)) for (const c of root.children) if (countTree(c,stats,maxNodes)) return true;
  return false;
}

async function cmdAnalyse(params = {}) {
  const action = params.action || 'stats';
  const roots = [];
  if (Array.isArray(params.ids) && params.ids.length) {
    for (const id of params.ids) roots.push(await getNode(id));
  } else roots.push(...(figma.currentPage.selection.length ? figma.currentPage.selection : [figma.currentPage]));

  if (action === 'stats') {
    const stats = {total:0,byType:{},textNodes:0,masks:0,maskedNodes:0,masksByType:{},emptyMasks:0,nodesWithEffects:0,truncated:false};
    const maxNodes = Math.max(1, Math.min(Number(params.maxNodes||10000), 50000));
    for (const r of roots) if (countTree(r,stats,maxNodes)) break;
    return stats;
  }
  if (action === 'compare') {
    if (roots.length !== 2) throw new Error('compare requires exactly two ids');
    const props = Array.isArray(params.props) && params.props.length ? params.props : FINGERPRINT_PROPS;
    const diff = {};
    for (const key of props) {
      const a = tryRead(roots[0],key), b = tryRead(roots[1],key);
      if (!sameJson(a,b)) diff[key] = {a,b};
    }
    return { a:nodeSummary(roots[0]), b:nodeSummary(roots[1]), sameFingerprint:nodeFingerprint(roots[0])===nodeFingerprint(roots[1]), diff };
  }
  if (action === 'lint') {
    const issues = [];
    const maxIssues = Math.max(1,Math.min(Number(params.maxIssues||300),2000));
    const inspect = (node) => {
      if (issues.length >= maxIssues) return true;
      const effects = tryRead(node,'effects');
      if (params.flagEffects && Array.isArray(effects) && effects.length) issues.push({kind:'effects',node:nodeSummary(node),effects});
      if (node.type === 'TEXT' && tryRead(node,'hasMissingFont') === true) issues.push({kind:'missing-font',node:nodeSummary(node)});
      if (tryRead(node,'visible') === false && params.flagHidden) issues.push({kind:'hidden',node:nodeSummary(node)});
      if ('children' in node && Array.isArray(node.children)) for (const c of node.children) if (inspect(c)) return true;
      return false;
    };
    for (const r of roots) if (inspect(r)) break;
    return { issues, truncated:issues.length>=maxIssues };
  }
  throw new Error(`Unknown analyse action: ${action}`);
}

async function cmdVariables(params = {}) {
  const action = params.action || 'list';
  if (action === 'list') {
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync(params.resolvedType);
    return { collections: safeValue(collections), variables: safeValue(variables) };
  }
  if (action === 'createCollection') {
    const c = figma.variables.createVariableCollection(String(params.name || 'Collection'));
    return safeValue(c);
  }
  if (action === 'createVariable') {
    let collection = params.collectionId ? await figma.variables.getVariableCollectionByIdAsync(params.collectionId) : null;
    if (!collection) throw new Error('collectionId is required and must exist');
    const v = figma.variables.createVariable(String(params.name || 'Variable'), collection, params.resolvedType || 'FLOAT');
    if (params.description != null) v.description = String(params.description);
    return safeValue(v);
  }
  if (action === 'setValue') {
    const v = await getVariable(params.variableId);
    v.setValueForMode(String(params.modeId), await resolveArg(params.value));
    return safeValue(v);
  }
  if (action === 'addMode') {
    const c = await getVariableCollection(params.collectionId);
    return { modeId:c.addMode(String(params.name || 'Mode')), collection:safeValue(c) };
  }
  if (action === 'renameMode') {
    const c = await getVariableCollection(params.collectionId);
    c.renameMode(String(params.modeId), String(params.name || 'Mode'));
    return safeValue(c);
  }
  if (action === 'removeMode') {
    const c = await getVariableCollection(params.collectionId);
    c.removeMode(String(params.modeId));
    return safeValue(c);
  }
  if (action === 'setExplicitMode') {
    const node = await getNode(params.nodeId);
    const c = await getVariableCollection(params.collectionId);
    if (typeof node.setExplicitVariableModeForCollection !== 'function') throw new Error('Explicit variable modes unavailable on this node');
    node.setExplicitVariableModeForCollection(c, String(params.modeId));
    return nodeSummary(node);
  }
  if (action === 'clearExplicitMode') {
    const node = await getNode(params.nodeId);
    const c = await getVariableCollection(params.collectionId);
    if (typeof node.clearExplicitVariableModeForCollection !== 'function') throw new Error('Explicit variable modes unavailable on this node');
    node.clearExplicitVariableModeForCollection(c);
    return nodeSummary(node);
  }
  if (action === 'bind') {
    const node = await getNode(params.nodeId);
    const v = params.variableId ? await getVariable(params.variableId) : null;
    if (typeof node.setBoundVariable !== 'function') throw new Error('Node does not support variable binding');
    node.setBoundVariable(String(params.field), v);
    return nodeSummary(node);
  }
  if (action === 'removeVariable') {
    const v = await getVariable(params.variableId); v.remove(); return { removed: params.variableId };
  }
  if (action === 'removeCollection') {
    const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
    if (!c) throw new Error('Collection not found'); c.remove(); return { removed: params.collectionId };
  }
  throw new Error(`Unknown variables action: ${action}`);
}

async function cmdStyles(params = {}) {
  const action = params.action || 'list';
  if (action === 'list') {
    const [paint, text, effect, grid] = await Promise.all([
      figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync()
    ]);
    return { paint: safeValue(paint), text: safeValue(text), effect: safeValue(effect), grid: safeValue(grid) };
  }
  if (action === 'create') {
    const kind = String(params.kind || '').toLowerCase();
    let style;
    if (kind === 'paint') style = figma.createPaintStyle();
    else if (kind === 'text') style = figma.createTextStyle();
    else if (kind === 'effect') style = figma.createEffectStyle();
    else if (kind === 'grid') style = figma.createGridStyle();
    else throw new Error('kind must be paint, text, effect, or grid');
    await setProps(style, params.props || {}, { strict: !!params.strict });
    return safeValue(style);
  }
  if (action === 'patch') {
    const style = await getStyle(params.styleId);
    return setProps(style, params.props || {}, { strict: !!params.strict });
  }
  if (action === 'remove') {
    const style = await getStyle(params.styleId); style.remove(); return { removed: params.styleId };
  }
  throw new Error(`Unknown styles action: ${action}`);
}

async function cmdAssets(params = {}) {
  const action = params.action || 'getImage';
  if (action === 'getImage') {
    const img = figma.getImageByHash(String(params.hash || ''));
    if (!img) throw new Error('Image not found');
    const size = await img.getSizeAsync();
    if (!params.includeBytes) return { hash: img.hash, size };
    const bytes = await img.getBytesAsync();
    const maxBytes = Math.max(1, Math.min(Number(params.maxBytes || 25000000), 80000000));
    if (bytes.byteLength > maxBytes) throw new Error(`Image is ${bytes.byteLength} bytes, above maxBytes=${maxBytes}`);
    return { hash: img.hash, size, base64: bytesToBase64(bytes), byteLength: bytes.byteLength };
  }
  if (action === 'createImage') {
    const bytes = base64ToBytes(String(params.base64 || ''));
    const img = figma.createImage(bytes);
    return { hash: img.hash, size: await img.getSizeAsync() };
  }
  if (action === 'createImageFromUrl') {
    const img = await figma.createImageAsync(String(params.url || ''));
    return { hash: img.hash, size: await img.getSizeAsync() };
  }
  throw new Error(`Unknown assets action: ${action}`);
}


async function cmdLibrary(params = {}) {
  const action = params.action || 'variableCollections';
  if (action === 'variableCollections') {
    if (!figma.teamLibrary || typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync !== 'function') throw new Error('Team Library API unavailable');
    return { collections:safeValue(await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()) };
  }
  if (action === 'variables') {
    if (!params.collectionKey) throw new Error('collectionKey required');
    return { variables:safeValue(await figma.teamLibrary.getVariablesInLibraryCollectionAsync(String(params.collectionKey))) };
  }
  if (action === 'importVariable') {
    const fn = typeof figma.importVariableByKeyAsync === 'function' ? figma.importVariableByKeyAsync.bind(figma) :
      figma.variables && typeof figma.variables.importVariableByKeyAsync === 'function' ? figma.variables.importVariableByKeyAsync.bind(figma.variables) : null;
    if (!fn) throw new Error('Variable import unavailable');
    return safeValue(await fn(String(params.key||'')));
  }
  if (action === 'importComponent') {
    if (typeof figma.importComponentByKeyAsync !== 'function') throw new Error('Component import unavailable');
    return nodeSummary(await figma.importComponentByKeyAsync(String(params.key||'')));
  }
  if (action === 'importComponentSet') {
    if (typeof figma.importComponentSetByKeyAsync !== 'function') throw new Error('Component-set import unavailable');
    return nodeSummary(await figma.importComponentSetByKeyAsync(String(params.key||'')));
  }
  if (action === 'importStyle') {
    if (typeof figma.importStyleByKeyAsync !== 'function') throw new Error('Style import unavailable');
    return safeValue(await figma.importStyleByKeyAsync(String(params.key||'')));
  }
  throw new Error(`Unknown library action: ${action}`);
}

async function cmdFonts(params = {}) {
  const action = params.action || 'list';
  if (action === 'list') {
    const fonts = await figma.listAvailableFontsAsync();
    const q = String(params.query||'').toLowerCase();
    const filtered = q ? fonts.filter(f => `${f.fontName.family} ${f.fontName.style}`.toLowerCase().includes(q)) : fonts;
    const offset = Math.max(0,Number(params.offset||0)), limit=Math.max(1,Math.min(Number(params.limit||500),5000));
    return { total:filtered.length, offset, limit, fonts:safeValue(filtered.slice(offset,offset+limit)), hasMore:offset+limit<filtered.length };
  }
  if (action === 'load') {
    if (!params.family || !params.style) throw new Error('family and style required');
    const font={family:String(params.family),style:String(params.style)};
    await figma.loadFontAsync(font);
    loadedFontKeys.add(`${font.family}\u0000${font.style}`);
    return {loaded:true,font};
  }
  throw new Error(`Unknown fonts action: ${action}`);
}

async function cmdHistory(params = {}) {
  const action = params.action || 'commit';
  if (action === 'commit') { figma.commitUndo(); return { committed: true }; }
  if (action === 'undo') { figma.triggerUndo(); return { undone: true }; }
  if (action === 'version') {
    const r = await figma.saveVersionHistoryAsync(String(params.title || 'Agent checkpoint'), params.description ? String(params.description) : undefined);
    return safeValue(r);
  }
  throw new Error(`Unknown history action: ${action}`);
}

async function cmdInvoke(params = {}) {
  if (!params.unsafe) throw new Error('Generic invoke requires unsafe=true. It can call arbitrary exposed Plugin API methods.');
  return opInvoke(params);
}


function apiSurface(target) {
  const seen = new Set();
  const entries = [];
  let obj = target;
  let level = 0;
  while (obj && level < 8) {
    let names = [];
    try { names = Object.getOwnPropertyNames(obj); } catch (_) {}
    for (const name of names) {
      if (seen.has(name) || name === 'constructor') continue;
      seen.add(name);
      let descriptor;
      try { descriptor = Object.getOwnPropertyDescriptor(obj, name); } catch (_) {}
      let kind = 'property';
      if (descriptor && typeof descriptor.value === 'function') kind = 'method';
      else if (descriptor && (descriptor.get || descriptor.set)) kind = 'accessor';
      entries.push({
        name,
        kind,
        prototypeLevel: level,
        writable: !!(descriptor && (descriptor.writable || descriptor.set)),
        readable: !(descriptor && descriptor.set && !descriptor.get),
        enumerable: !!(descriptor && descriptor.enumerable)
      });
    }
    try { obj = Object.getPrototypeOf(obj); } catch (_) { obj = null; }
    level++;
  }
  entries.sort((a,b) => a.name.localeCompare(b.name));
  return entries;
}

async function cmdCapabilities(params = {}) {
  const targetKind = params.target || 'figma';
  let target;
  if (targetKind === 'figma') target = figma;
  else if (targetKind === 'node') target = await getNode(params.id || params.nodeId);
  else if (targetKind === 'style') target = await getStyle(params.id);
  else if (targetKind === 'variable') target = await getVariable(params.id);
  else if (targetKind === 'variables') target = figma.variables;
  else if (targetKind === 'teamLibrary') target = figma.teamLibrary;
  else if (targetKind === 'annotations') target = figma.annotations;
  else if (targetKind === 'motion') target = figma.motion;
  else if (targetKind === 'util') target = figma.util;
  else if (targetKind === 'viewport') target = figma.viewport;
  else if (targetKind === 'constants') target = figma.constants;
  else throw new Error(`Unknown capabilities target: ${targetKind}`);
  const api = apiSurface(target);
  if (params.includeValues) {
    for (const entry of api) {
      if (entry.kind === 'method') continue;
      const value = tryRead(target, entry.name);
      if (value !== undefined) entry.value = value;
    }
  }
  return { target: targetKind, id: params.id || params.nodeId || null, api };
}

const COMMANDS = {
  context: cmdContext,
  inspect: cmdInspect,
  search: cmdSearch,
  snapshot: cmdSnapshot,
  render: cmdRender,
  batch: cmdBatch,
  text: cmdText,
  components: cmdComponents,
  prototype: cmdPrototype,
  dev: cmdDev,
  motion: cmdMotion,
  analyse: cmdAnalyse,
  variables: cmdVariables,
  styles: cmdStyles,
  assets: cmdAssets,
  library: cmdLibrary,
  fonts: cmdFonts,
  history: cmdHistory,
  invoke: cmdInvoke,
  capabilities: cmdCapabilities
};

async function sendInit() {
  let config = await figma.clientStorage.getAsync(STORAGE_KEY);
  if (!config) {
    const legacy = await figma.clientStorage.getAsync(LEGACY_STORAGE_KEY);
    config = legacy ? { server:legacy.server || DEFAULT_SERVER, token:legacy.token || '', installId:legacy.installId || '' } : { server: DEFAULT_SERVER, token: '', installId:'' };
  }
  figma.ui.postMessage({
    type: 'plugin-init',
    config,
    plugin: {
      bridgeVersion: BRIDGE_VERSION,
      apiVersion: figma.apiVersion,
      editorType: figma.editorType,
      fileName: figma.root.name,
      pageId: figma.currentPage.id,
      pageName: figma.currentPage.name
    }
  });
}

const schedulerState = { activeReads:0, writerActive:false, writerWaiting:0, queue:[], maxReads:4, writeEnabled:true, unsafeInvokeEnabled:false };

function isReadCommand(command) {
  const method = command.method;
  const p = command.params || {};
  if (['context','inspect','search','snapshot','render','capabilities','analyse'].includes(method)) return true;
  if (method === 'text') return (p.action || 'inspect') === 'inspect';
  if (method === 'components') return (p.action || 'inspect') === 'inspect';
  if (method === 'prototype') return (p.action || 'get') === 'get';
  if (method === 'dev') return ['css','resources','measurements'].includes(p.action || 'css');
  if (method === 'motion') return (p.action || 'inspect') === 'inspect';
  if (method === 'variables') return (p.action || 'list') === 'list';
  if (method === 'styles') return (p.action || 'list') === 'list';
  if (method === 'assets') return (p.action || 'getImage') === 'getImage';
  if (method === 'library') return ['variableCollections','variables'].includes(p.action || 'variableCollections');
  if (method === 'fonts') return (p.action || 'list') === 'list';
  return false;
}

function scheduleCommand(command) {
  return new Promise((resolve,reject) => {
    const read = isReadCommand(command);
    const item = { command, read, resolve, reject };
    if (!read) schedulerState.writerWaiting++;
    schedulerState.queue.push(item);
    drainScheduler();
  });
}

function drainScheduler() {
  if (schedulerState.writerActive) return;
  const q = schedulerState.queue;
  if (!q.length) return;

  const firstWriter = q.findIndex(x => !x.read);
  if (firstWriter === 0) {
    if (schedulerState.activeReads > 0) return;
    const item = q.shift();
    schedulerState.writerWaiting = Math.max(0,schedulerState.writerWaiting-1);
    schedulerState.writerActive = true;
    runScheduled(item).finally(() => { schedulerState.writerActive=false; drainScheduler(); });
    return;
  }

  if (schedulerState.writerWaiting > 0 && firstWriter >= 0) {
    while (schedulerState.activeReads < schedulerState.maxReads && q.length && q[0].read) {
      const item = q.shift();
      schedulerState.activeReads++;
      runScheduled(item).finally(() => { schedulerState.activeReads--; drainScheduler(); });
    }
    return;
  }

  while (schedulerState.activeReads < schedulerState.maxReads && q.length && q[0].read) {
    const item = q.shift();
    schedulerState.activeReads++;
    runScheduled(item).finally(() => { schedulerState.activeReads--; drainScheduler(); });
  }
}

async function runScheduled(item) {
  const command = item.command;
  try {
    if (!item.read && !schedulerState.writeEnabled) throw new Error('Write access is paused by the user. Ask them to open the plugin\'s settings (gear icon) and turn "Write access" back on. Reads still work; do not retry this edit until they confirm.');
    const hasUnsafeBatchInvoke = command.method === 'batch' && Array.isArray(command.params && command.params.operations) &&
      command.params.operations.some(op => String(op && (op.op || op.kind) || '').toLowerCase() === 'invoke');
    if ((command.method === 'invoke' || hasUnsafeBatchInvoke) && !schedulerState.unsafeInvokeEnabled) {
      throw new Error('figma_invoke is disabled. Prefer a named tool — it almost always covers this. If it genuinely cannot, ask the user to enable "Unsafe API invoke" in the plugin settings (gear icon) and explain what you need it for.');
    }
    const fn = COMMANDS[command.method];
    if (!fn) throw new Error(`Unknown bridge command: ${command.method}`);
    resetMaskGroupCache(); // derived mask relationships must not outlive a command
    const result = await fn(command.params || {});
    item.resolve(result);
  } catch (e) { item.reject(e); }
}

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ui-ready') {
    await sendInit();
    return;
  }
  if (msg.type === 'save-config') {
    const config = {
      server: String(msg.config && msg.config.server || DEFAULT_SERVER),
      token: String(msg.config && msg.config.token || ''),
      installId: String(msg.config && msg.config.installId || '')
    };
    await figma.clientStorage.setAsync(STORAGE_KEY, config);
    figma.ui.postMessage({ type: 'config-saved', config });
    return;
  }
  if (msg.type === 'bridge-settings') {
    schedulerState.writeEnabled = msg.writeEnabled !== false;
    schedulerState.unsafeInvokeEnabled = !!msg.unsafeInvokeEnabled;
    schedulerState.maxReads = Math.max(1,Math.min(Number(msg.maxReads || 4),8));
    return;
  }
  if (msg.type === 'bridge-command') {
    const command = msg.command || {};
    const id = command.id;
    const started = Date.now();
    try {
      const result = await scheduleCommand(command);
      figma.ui.postMessage({ type: 'bridge-result', id, method: command.method, ok: true, result, timingMs:Date.now()-started });
    } catch (e) {
      figma.ui.postMessage({ type: 'bridge-result', id, method: command.method, ok: false, error: errObj(e), timingMs:Date.now()-started });
    }
  }
};

function emitEvent(event, payload) {
  try { figma.ui.postMessage({ type: 'figma-event', event, payload }); } catch (_) {}
}

figma.on('selectionchange', () => emitEvent('selectionchange', figma.currentPage.selection.map(nodeSummary)));

let listenedPage = null;
let pageNodeChangeCallback = null;
let pageEventBuffer = [];
let pageEventTimer = null;

function flushPageEvents() {
  if (!pageEventBuffer.length) return;
  const changes = pageEventBuffer.splice(0, pageEventBuffer.length);
  pageEventTimer = null;
  emitEvent('nodechange', { pageId:figma.currentPage.id, changes, coalesced:true });
}

function attachCurrentPageChangeListener() {
  try {
    if (listenedPage && pageNodeChangeCallback && typeof listenedPage.off === 'function') listenedPage.off('nodechange',pageNodeChangeCallback);
  } catch (_) {}
  listenedPage = figma.currentPage;
  pageNodeChangeCallback = (event) => {
    try {
      const raw = Array.isArray(event.nodeChanges) ? event.nodeChanges.slice(0,MAX_EVENT_CHANGES) : [];
      pageEventBuffer.push(...safeValue(raw));
    } catch (_) {}
    if (pageEventBuffer.length > MAX_EVENT_CHANGES) pageEventBuffer = pageEventBuffer.slice(-MAX_EVENT_CHANGES);
    if (!pageEventTimer) pageEventTimer = setTimeout(flushPageEvents, 180);
  };
  try { listenedPage.on('nodechange', pageNodeChangeCallback); } catch (_) {}
}

figma.on('currentpagechange', () => {
  if (pageEventTimer) { clearTimeout(pageEventTimer); pageEventTimer=null; }
  pageEventBuffer.length=0;
  attachCurrentPageChangeListener();
  emitEvent('currentpagechange', { id: figma.currentPage.id, name: figma.currentPage.name });
});
attachCurrentPageChangeListener();
try {
  figma.on('stylechange', (event) => emitEvent('stylechange', safeValue(event.styleChanges || [])));
} catch (_) {}

sendInit().catch(() => {});
