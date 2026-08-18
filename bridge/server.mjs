#!/usr/bin/env node
/**
 * Figma Agent Bridge — dependency-free local MCP server.
 * - MCP stdio: newline-delimited JSON-RPC
 * - Figma plugin transport: authenticated loopback HTTP long-poll
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const VERSION = '0.2.7';
const MCP_VERSION = '2026-07-28';
const PORT = Number(process.env.FIGMA_AGENT_BRIDGE_PORT || 3874);
const HOST = '127.0.0.1';
const STATE_DIR = path.join(os.homedir(), '.figma-agent-bridge');
const SECRET_FILE = path.join(STATE_DIR, 'secret.json');
const REQUEST_TIMEOUT_MS = Number(process.env.FIGMA_AGENT_BRIDGE_TIMEOUT_MS || 60000);
const POLL_TIMEOUT_MS = 24000;
const LIVE_CLIENT_MS = 45000;
const MAX_QUEUE_PER_CLIENT = Number(process.env.FIGMA_AGENT_BRIDGE_MAX_QUEUE || 256);
const MAX_PENDING = Number(process.env.FIGMA_AGENT_BRIDGE_MAX_PENDING || 512);
const MAX_INLINE_RENDER_BYTES = Number(process.env.FIGMA_AGENT_BRIDGE_MAX_INLINE_RENDER_BYTES || 10*1024*1024);
const MAX_REMOTE_ASSET_BYTES = Number(process.env.FIGMA_AGENT_BRIDGE_MAX_REMOTE_ASSET_BYTES || 25*1024*1024);
const PAIRING_TTL_MS = 15*60*1000;
const EXPORT_DIR = path.join(STATE_DIR, 'exports');
fs.mkdirSync(EXPORT_DIR, { recursive: true, mode: 0o700 });

function stderr(...args) { console.error('[figma-agent-bridge]', ...args); }
function now() { return Date.now(); }
function uid() { return crypto.randomUUID(); }

function ensureSecret() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    const master = parsed.masterToken || parsed.token;
    if (master && typeof master === 'string') {
      const migrated = { masterToken:master, createdAt:parsed.createdAt || new Date().toISOString(), version:2 };
      if (!parsed.masterToken) fs.writeFileSync(SECRET_FILE, JSON.stringify(migrated,null,2), {mode:0o600});
      return migrated;
    }
  } catch (_) {}
  const data = { masterToken:crypto.randomBytes(32).toString('hex'), createdAt:new Date().toISOString(), version:2 };
  fs.writeFileSync(SECRET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  return data;
}

const secret = ensureSecret();
let pairing = { code:'', expiresAt:0, failures:0 };
function rotatePairingCode() {
  pairing = { code:String(crypto.randomInt(100000,1000000)), expiresAt:now()+PAIRING_TTL_MS, failures:0 };
  return pairing.code;
}
function currentPairingCode() {
  if (!pairing.code || pairing.expiresAt <= now() || pairing.failures >= 12) rotatePairingCode();
  return pairing.code;
}
function deriveInstallToken(installId) {
  if (!installId) return '';
  return crypto.createHmac('sha256', Buffer.from(secret.masterToken,'utf8')).update(`install:${installId}`).digest('hex');
}
function validToken(v, installId) {
  const expected = deriveInstallToken(String(installId||''));
  if (!v || !expected || typeof v !== 'string' || v.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)); } catch (_) { return false; }
}
rotatePairingCode();

const clients = new Map(); // clientId -> {plugin,lastSeen,queue,pollWaiter,events}
const pending = new Map(); // commandId -> {resolve,reject,timer,clientId,method}

function clientRecord(clientId, installId='') {
  let c = clients.get(clientId);
  if (!c) {
    c = {
      clientId, installId:String(installId||''), plugin:{}, lastSeen:0, queue:[], pollWaiter:null,
      events:[], pairedAt:null, connectedAt:null,
      metrics:{commands:0,successes:0,errors:0,totalLatencyMs:0,maxLatencyMs:0,lastLatencyMs:null,lastCommand:null}
    };
    clients.set(clientId, c);
  } else if (installId) c.installId = String(installId);
  return c;
}

// A plugin window mints a fresh clientId on every open, so reopening the plugin
// would otherwise leave the previous record alive and make two clients look
// connected for one install — which breaks "omit clientId when exactly one file
// is connected". Retire superseded siblings, keeping any with work in flight.
function retireSupersededClients(keepClientId, installId) {
  if (!installId) return 0;
  let retired = 0;
  for (const [id, c] of clients) {
    if (id === keepClientId || c.installId !== String(installId)) continue;
    if (c.queue.length || [...pending.values()].some(p => p.clientId === id)) continue;
    if (c.pollWaiter) {
      try { clearTimeout(c.pollWaiter.timer); c.pollWaiter.send([], true); } catch (_) {}
      c.pollWaiter = null;
    }
    clients.delete(id);
    retired++;
  }
  return retired;
}

function liveClients() {
  const cutoff = now() - LIVE_CLIENT_MS;
  return [...clients.values()].filter(c => c.lastSeen >= cutoff);
}

function pickClient(requested) {
  if (requested) {
    const c = clients.get(requested);
    if (!c || now() - c.lastSeen > LIVE_CLIENT_MS) {
      throw new Error(`Figma client not connected: ${requested}. This id is stale — call bridge_status for the live clientId, or omit clientId to use the only connected file.`);
    }
    return c;
  }
  const live = liveClients().sort((a,b) => b.lastSeen - a.lastSeen);
  if (!live.length) {
    throw new Error('No Figma plugin connected. Ask the user to open their file in Figma Desktop and run the "Figma Agent Bridge" plugin (Plugins → Development). Do not retry until they confirm — the bridge cannot open it for them.');
  }
  if (live.length > 1) {
    const fileName = live[0].plugin && live[0].plugin.fileName;
    const sameFile = fileName ? live.filter(c => c.plugin && c.plugin.fileName === fileName) : [];
    if (sameFile.length === 1) return sameFile[0];
    throw new Error(`Multiple Figma plugin windows are connected; pass clientId to choose one. Most recently active first: ${live.map(c=>`${c.clientId} (${(c.plugin && c.plugin.fileName)||'unknown file'})`).join(', ')}`);
  }
  return live[0];
}

function queueCommand(client, method, params) {
  return new Promise((resolve, reject) => {
    if (pending.size >= MAX_PENDING) return reject(new Error(`Bridge overloaded: ${pending.size} pending commands`));
    if (client.queue.length >= MAX_QUEUE_PER_CLIENT) return reject(new Error(`Client queue full: ${client.queue.length}/${MAX_QUEUE_PER_CLIENT}`));
    const id = uid();
    const createdAt = now();
    const command = { id, method, params: params || {}, sentAt: new Date(createdAt).toISOString() };
    const timer = setTimeout(() => {
      pending.delete(id);
      const qi=client.queue.findIndex(x=>x.id===id);
      if (qi>=0) client.queue.splice(qi,1);
      client.metrics.errors++;
      reject(new Error(`Timed out waiting for Figma plugin (${method}) after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, clientId: client.clientId, method, createdAt });
    client.metrics.commands++;
    client.metrics.lastCommand = method;
    if (client.pollWaiter) {
      const waiter = client.pollWaiter;
      client.pollWaiter = null;
      clearTimeout(waiter.timer);
      waiter.send([command]);
    } else {
      client.queue.push(command);
    }
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}
function empty(res, status=204) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end();
}
function text(res, status, body) {
  res.writeHead(status, { 'Content-Type':'text/plain; charset=utf-8', 'Access-Control-Allow-Origin':'*' });
  res.end(body);
}
function readBody(req, max=20*1024*1024) {
  return new Promise((resolve,reject) => {
    const chunks=[]; let size=0;
    req.on('data', chunk => { size += chunk.length; if (size>max) { reject(new Error('Request body too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
const cleanupTimer=setInterval(()=>{
  const staleBefore=now()-30*60*1000;
  for (const [id,c] of clients) {
    const hasPending=[...pending.values()].some(p=>p.clientId===id);
    if (!hasPending && !c.queue.length && c.lastSeen && c.lastSeen<staleBefore) {
      if (c.pollWaiter) { try{clearTimeout(c.pollWaiter.timer);c.pollWaiter.send([],true)}catch(_){} }
      clients.delete(id);
    }
  }
},5*60*1000);
cleanupTimer.unref();

const httpServer = http.createServer(async (req,res) => {
  try {
    if (req.method === 'OPTIONS') return empty(res, 204);
    const u = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (u.pathname === '/health') {
      return json(res,200,{
        ok:true,name:'figma-agent-bridge',version:VERSION,clients:liveClients().length,pending:pending.size,
        queueDepth:[...clients.values()].reduce((n,c)=>n+c.queue.length,0),pairingExpiresAt:new Date(pairing.expiresAt).toISOString()
      });
    }

    if (u.pathname === '/pair' && req.method === 'POST') {
      const body = await readBody(req);
      if (pairing.expiresAt <= now()) rotatePairingCode();
      if (pairing.failures >= 12) return json(res,429,{error:'Too many failed pairing attempts. Request bridge_status for a fresh code.'});
      if (String(body.code || '') !== pairing.code) {
        pairing.failures++;
        return json(res,401,{error:'Invalid pairing code'});
      }
      if (!body.clientId || !body.installId) return json(res,400,{error:'clientId and installId required'});
      const c = clientRecord(String(body.clientId), String(body.installId));
      c.plugin = body.plugin || {};
      c.lastSeen = now(); c.pairedAt = new Date().toISOString(); c.connectedAt ||= c.pairedAt;
      const token = deriveInstallToken(c.installId);
      retireSupersededClients(c.clientId, c.installId);
      rotatePairingCode(); // one-time pairing code
      return json(res,200,{ok:true,token,clientId:c.clientId,serverVersion:VERSION});
    }

    // Authenticated shutdown so the plugin's Disconnect can actually stop the
    // bridge process it is talking to, rather than just forgetting a key.
    if (u.pathname === '/shutdown' && req.method === 'POST') {
      const body = await readBody(req);
      if (!validToken(body.token, body.installId)) return json(res,401,{error:'Invalid token'});
      json(res,200,{ok:true,stopping:true});
      setTimeout(() => shutdown(), 150).unref();
      return;
    }

    if (u.pathname === '/hello' && req.method === 'POST') {
      const body = await readBody(req);
      if (!validToken(body.token, body.installId)) return json(res,401,{error:'Invalid token'});
      if (!body.clientId || !body.installId) return json(res,400,{error:'clientId and installId required'});
      const c = clientRecord(String(body.clientId), String(body.installId));
      c.plugin = body.plugin || c.plugin || {};
      c.lastSeen = now(); c.connectedAt ||= new Date().toISOString();
      const retired = retireSupersededClients(c.clientId, c.installId);
      return json(res,200,{ok:true,clientId:c.clientId,serverVersion:VERSION,writePolicy:'plugin-controlled',retiredClients:retired});
    }

    if (u.pathname === '/poll' && req.method === 'GET') {
      const token = u.searchParams.get('token');
      const clientId = u.searchParams.get('clientId');
      const installId = u.searchParams.get('installId');
      const max = Math.max(1,Math.min(Number(u.searchParams.get('max')||1),16));
      if (!validToken(token, installId)) return json(res,401,{error:'Invalid token'});
      if (!clientId || !installId) return json(res,400,{error:'clientId and installId required'});
      const c = clientRecord(clientId,installId); c.lastSeen = now();
      if (c.queue.length) return json(res,200,{commands:c.queue.splice(0,max)});
      if (c.pollWaiter) {
        clearTimeout(c.pollWaiter.timer);
        try { c.pollWaiter.send([], true); } catch (_) {}
      }
      let done = false;
      const send = (commands, noContent=false) => {
        if (done || res.writableEnded) return;
        done = true;
        if (noContent || !commands || !commands.length) empty(res,204); else json(res,200,{commands});
      };
      const timer = setTimeout(() => { c.pollWaiter = null; send([],true); }, POLL_TIMEOUT_MS);
      c.pollWaiter = { send, timer };
      req.on('close', () => { if (!done) { clearTimeout(timer); if (c.pollWaiter?.send === send) c.pollWaiter = null; done=true; } });
      return;
    }

    if (u.pathname === '/result' && req.method === 'POST') {
      const body = await readBody(req, 80*1024*1024);
      if (!validToken(body.token, body.installId)) return json(res,401,{error:'Invalid token'});
      const c = clientRecord(String(body.clientId || ''), String(body.installId||'')); c.lastSeen = now();
      const p = pending.get(body.id);
      if (!p) return json(res,404,{error:'Unknown/expired command id'});
      if (p.clientId !== c.clientId) return json(res,409,{error:'Command belongs to another client'});
      clearTimeout(p.timer); pending.delete(body.id);
      const latency = Math.max(0, now() - p.createdAt);
      c.metrics.lastLatencyMs=latency; c.metrics.totalLatencyMs+=latency; c.metrics.maxLatencyMs=Math.max(c.metrics.maxLatencyMs,latency);
      if (body.ok) { c.metrics.successes++; p.resolve(body.result); }
      else { c.metrics.errors++; p.reject(Object.assign(new Error(body.error?.message || 'Figma plugin command failed'), { remoteError: body.error })); }
      return json(res,200,{ok:true});
    }

    if (u.pathname === '/event' && req.method === 'POST') {
      const body = await readBody(req, 2*1024*1024);
      if (!validToken(body.token, body.installId)) return json(res,401,{error:'Invalid token'});
      const c = clientRecord(String(body.clientId || ''), String(body.installId||'')); c.lastSeen = now();
      c.events.push({ at:new Date().toISOString(), event:body.event, payload:body.payload });
      if (c.events.length > 200) c.events.splice(0, c.events.length - 200);
      return json(res,200,{ok:true});
    }

    return text(res,404,'Not found');
  } catch (e) {
    json(res,500,{error:e.message || String(e)});
  }
});
httpServer.listen(PORT, HOST, () => stderr(`plugin transport listening at http://${HOST}:${PORT}`));

const S = {
  string: (description='') => ({type:'string', description}),
  bool: (description='') => ({type:'boolean', description}),
  num: (description='') => ({type:'number', description}),
  obj: (properties={}, required=[], description='') => ({type:'object',properties,required,additionalProperties:false,description}),
  arr: (items, description='') => ({type:'array',items,description})
};

const commonClient = { clientId:S.string('Optional connected Figma client id. Omit when exactly one file is connected.') };

const TOOLS = [
  {
    name:'bridge_status',
    description:'Connection and runtime status for the local Figma Agent Bridge, including connected files, queue depth, latency metrics and the current short-lived pairing code.',
    inputSchema:S.obj({includeEvents:S.bool('Include recent canvas events.'),...commonClient})
  },
  {
    name:'bridge_doctor',
    description:'Diagnose the local bridge itself: runtime, permissions, state directories, queue pressure, stale clients and recommended fixes.',
    inputSchema:S.obj({...commonClient})
  },
  {
    name:'figma_context',
    description:'Cheap authoritative context for the live Figma file: pages, active page, selection, viewport, editor/API version.',
    inputSchema:S.obj({...commonClient})
  },
  {
    name:'figma_inspect',
    description:'Deep bounded inspection of live nodes. Returns real Plugin API structure rather than inferred screenshot structure; opt into geometry, styled text, components, CSS, styles and dev resources only when needed.',
    inputSchema:S.obj({
      ids:S.arr(S.string(),'Node ids; defaults to selection.'),depth:{type:'integer',minimum:0,maximum:12},mode:{type:'string',enum:['summary','full']},
      childOffset:{type:'integer',minimum:0},childLimit:{type:'integer',minimum:1,maximum:1000},maxNodes:{type:'integer',minimum:1,maximum:5000},
      includeGeometry:S.bool(),includeTextSegments:S.bool(),textSegmentFields:S.arr(S.string()),includeReactions:S.bool(),includePluginData:S.bool(),
      includeComponentDetails:S.bool(),includeStyles:S.bool(),includeDevResources:S.bool(),includeDevResourcesChildren:S.bool(),includeCSS:S.bool(),includeMeasurements:S.bool(),
      ...commonClient
    })
  },
  {
    name:'figma_search',
    description:'Fast bounded node search. Supports selection/current page/a subtree/specific pages/all pages; all-page traversal loads pages lazily and stops as soon as the requested window is full.',
    inputSchema:S.obj({
      scope:{type:'string',enum:['currentPage','selection','within','pages','allPages']},withinId:S.string(),pageIds:S.arr(S.string()),
      name:S.string(),nameMode:{type:'string',enum:['contains','exact','regex']},caseSensitive:S.bool(),types:S.arr(S.string()),visible:S.bool(),isMask:S.bool(),
      parentId:S.string('Only match direct children of this node id.'),
      topLevelOnly:S.bool('Only match nodes whose parent is the page itself — the screens/frames of a page.'),
      isMasked:S.bool('Match nodes clipped by a sibling mask (resolved relationship, not raw isMask).'),
      hasEffects:S.bool('Match nodes carrying at least one effect.'),
      offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:2000},skipInvisibleInstanceChildren:S.bool('Faster traversal that hides invisible instance children. Off by default so nothing is silently missed.'),includeFingerprint:S.bool('Include stale-state fingerprints in search results; off by default for speed.'),...commonClient
    })
  },
  {
    name:'figma_snapshot',
    description:'One-round-trip design understanding: deep bounded node structure plus an authoritative Figma PNG render. Prefer this when an agent needs both semantics and visual truth for the same node.',
    inputSchema:S.obj({
      id:S.string(),depth:{type:'integer',minimum:0,maximum:6},mode:{type:'string',enum:['summary','full']},childLimit:{type:'integer',minimum:1,maximum:500},maxNodes:{type:'integer',minimum:1,maximum:2500},
      includeGeometry:S.bool(),includeTextSegments:S.bool(),includeComponentDetails:S.bool(),includeStyles:S.bool(),includeCSS:S.bool(),includeDevResources:S.bool(),
      render:S.bool(),scale:{type:'number',minimum:0.05,maximum:4},contentsOnly:S.bool(),useAbsoluteBounds:S.bool(),delivery:{type:'string',enum:['auto','inline','file']},...commonClient
    })
  },
  {
    name:'figma_render',
    description:'Render/export a live node using Figma itself for visual verification. Large binary results are automatically spilled to a protected local export file instead of flooding model context.',
    inputSchema:S.obj({
      id:S.string(),format:{type:'string',enum:['PNG','JPG','SVG_STRING','JSON_REST_V1','PDF']},scale:{type:'number',minimum:0.01,maximum:8},
      contentsOnly:S.bool(),useAbsoluteBounds:S.bool(),delivery:{type:'string',enum:['auto','inline','file']},...commonClient
    })
  },
  {
    name:'figma_batch',
    description:'Atomic ordered edit transaction with undo boundaries, rollback on first failure, within-batch node references and stale-state assertions/fingerprints. Preferred mutation surface.',
    inputSchema:S.obj({
      operations:S.arr({type:'object',additionalProperties:true}),commitBefore:S.bool(),commitAfter:S.bool(),rollbackOnError:S.bool(),...commonClient
    },['operations'])
  },
  {
    name:'figma_text',
    description:'Rich-text-safe editing and inspection. Inspect styled runs, insert/delete/replace ranges, replace all matches, or style ranges without resetting unrelated Figma text styling.',
    inputSchema:S.obj({
      action:{type:'string',enum:['inspect','edit','replaceAll']},nodeId:S.string(),includeRuns:S.bool(),fields:S.arr(S.string()),
      characters:S.string(),allowStyleReset:S.bool(),insert:S.string(),at:{type:'integer',minimum:0},useStyle:{type:'string',enum:['BEFORE','AFTER']},
      deleteRange:{type:'object',additionalProperties:true},replaceRange:{type:'object',additionalProperties:true},ranges:S.arr({type:'object',additionalProperties:true}),
      find:S.string(),replace:S.string(),caseSensitive:S.bool(),maxReplacements:{type:'integer',minimum:1,maximum:5000},returnText:S.bool(),...commonClient
    })
  },
  {
    name:'figma_components',
    description:'Native component/instance control: inspect relationships and overrides, create instances, swap main components, set component properties, remove overrides, detach, convert nodes to components and combine variants.',
    inputSchema:S.obj({
      action:{type:'string',enum:['inspect','createInstance','swap','setProperties','removeOverrides','detach','createComponentFromNode','combineAsVariants']},
      nodeId:S.string(),componentId:S.string(),nodeIds:S.arr(S.string()),parentId:S.string(),index:{type:'integer',minimum:0},properties:{type:'object',additionalProperties:true},...commonClient
    })
  },
  {
    name:'figma_prototype',
    description:'Inspect or update prototype reactions and prototype-related node properties using the live file.',
    inputSchema:S.obj({action:{type:'string',enum:['get','setReactions']},nodeId:S.string(),reactions:S.arr({}),...commonClient})
  },
  {
    name:'figma_dev',
    description:'Design-to-code and developer metadata: get Figma-generated CSS, read/add/edit/delete dev resources, and inspect measurements where supported.',
    inputSchema:S.obj({
      action:{type:'string',enum:['css','resources','addResource','editResource','deleteResource','measurements']},nodeId:S.string(),includeChildren:S.bool(),
      url:S.string(),name:S.string(),currentUrl:S.string(),newValue:{type:'object',additionalProperties:true},...commonClient
    })
  },
  {
    name:'figma_motion',
    description:'Inspect or mutate current Figma motion/animation APIs when exposed by the runtime, including animation styles, manual keyframe tracks and timeline duration.',
    inputSchema:S.obj({
      action:{type:'string',enum:['inspect','applyStyle','removeStyle','applyTrack','removeTrack','setTimelineDuration']},nodeId:S.string(),args:S.arr({}),...commonClient
    })
  },
  {
    name:'figma_analyse',
    description:'Compact agent-side design intelligence without shipping the whole tree: subtree statistics, property comparison, or configurable structural linting.',
    inputSchema:S.obj({
      action:{type:'string',enum:['stats','compare','lint']},ids:S.arr(S.string()),props:S.arr(S.string()),maxNodes:{type:'integer',minimum:1,maximum:50000},
      maxIssues:{type:'integer',minimum:1,maximum:2000},flagEffects:S.bool(),flagHidden:S.bool(),...commonClient
    })
  },
  {
    name:'figma_variables',
    description:'Read and mutate local Figma variables/collections, modes, aliases/bindings and explicit node modes through the live Variables API.',
    inputSchema:S.obj({
      action:{type:'string',enum:['list','createCollection','createVariable','setValue','addMode','renameMode','removeMode','setExplicitMode','clearExplicitMode','bind','removeVariable','removeCollection']},
      resolvedType:{type:'string',enum:['BOOLEAN','COLOR','FLOAT','STRING']},name:S.string(),collectionId:S.string(),variableId:S.string(),modeId:S.string(),
      value:{},nodeId:S.string(),field:S.string(),description:S.string(),...commonClient
    })
  },
  {
    name:'figma_styles',
    description:'List, create, patch or remove local paint/text/effect/grid styles.',
    inputSchema:S.obj({action:{type:'string',enum:['list','create','patch','remove']},kind:{type:'string',enum:['paint','text','effect','grid']},styleId:S.string(),props:{type:'object',additionalProperties:true},strict:S.bool(),...commonClient})
  },
  {
    name:'figma_assets',
    description:'Read original embedded image bytes, create an image from bytes, or import an HTTP(S) image through the local bridge. URL imports are downloaded by the bridge so the stable plugin can remain loopback-only.',
    inputSchema:S.obj({
      action:{type:'string',enum:['getImage','createImage','createImageFromUrl']},hash:S.string(),includeBytes:S.bool(),maxBytes:{type:'integer',minimum:1,maximum:80000000},
      base64:S.string(),url:S.string(),allowPrivateNetwork:S.bool(),...commonClient
    })
  },
  {
    name:'figma_library',
    description:'Work with assets in team libraries enabled for the current file: enumerate library variable collections/variables and import variables, components, component sets or styles by published key.',
    inputSchema:S.obj({
      action:{type:'string',enum:['variableCollections','variables','importVariable','importComponent','importComponentSet','importStyle']},
      collectionKey:S.string(),key:S.string(),...commonClient
    })
  },
  {
    name:'figma_fonts',
    description:'List/search available Figma fonts or explicitly load a font. Font loads are cached by the bridge plugin to avoid repeated loadFontAsync overhead.',
    inputSchema:S.obj({
      action:{type:'string',enum:['list','load']},query:S.string(),offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:5000},
      family:S.string(),style:S.string(),...commonClient
    })
  },
  {
    name:'figma_history',
    description:'Create an undo checkpoint, undo the last plugin transaction, or request a named version-history checkpoint when Figma/account capabilities allow it.',
    inputSchema:S.obj({action:{type:'string',enum:['commit','undo','version']},title:S.string(),description:S.string(),...commonClient})
  },
  {
    name:'figma_invoke',
    description:'Advanced future-proof escape hatch. Calls an exposed Plugin API method without eval using object handles {$node}, {$style}, {$variable}, {$variableAlias}, {$collection}, {$bytes}. Requires unsafe=true AND the plugin UI Unsafe API switch.',
    inputSchema:S.obj({
      target:{type:'string',enum:['figma','node','style','variable','variables','teamLibrary','annotations','motion','util','viewport','constants']},id:S.string(),nodeId:S.string(),method:S.string(),args:S.arr({}),unsafe:S.bool(),...commonClient
    },['target','method','unsafe'])
  },
  {
    name:'figma_capabilities',
    description:'Introspect the actual current runtime surface on Figma objects, including methods not yet wrapped by named tools.',
    inputSchema:S.obj({
      target:{type:'string',enum:['figma','node','style','variable','variables','teamLibrary','annotations','motion','util','viewport','constants']},id:S.string(),nodeId:S.string(),includeValues:S.bool(),...commonClient
    },['target'])
  },
  {
    name:'figma_recent_events',
    description:'Read recent selection/page/node-change events observed by this plugin instance.',
    inputSchema:S.obj({limit:{type:'integer',minimum:1,maximum:200},clear:S.bool(),...commonClient})
  }
];
function toolByName(name) { return TOOLS.find(t => t.name === name); }

function isPrivateHostname(hostname) {
  const h=String(hostname||'').toLowerCase();
  if (h==='localhost' || h==='::1' || h.endsWith('.local')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m=h.match(/^172\.(\d+)\./); if (m && Number(m[1])>=16 && Number(m[1])<=31) return true;
  return false;
}

async function importRemoteAsset(client,args) {
  const raw=String(args.url||''); let u;
  try { u=new URL(raw); } catch (_) { throw new Error('Invalid image URL'); }
  if (!['http:','https:'].includes(u.protocol)) throw new Error('Only http/https image URLs are allowed');
  if (!args.allowPrivateNetwork && isPrivateHostname(u.hostname)) throw new Error('Private/loopback image URLs are blocked by default; pass allowPrivateNetwork=true only when intentional');
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),20000);
  try {
    const r=await fetch(u,{redirect:'follow',signal:ctrl.signal,headers:{'User-Agent':'Figma-Agent-Bridge/0.2.7'}});
    if (!r.ok) throw new Error(`Image fetch failed: HTTP ${r.status}`);
    const announced=Number(r.headers.get('content-length')||0);
    const cap=Math.max(1,Math.min(Number(args.maxBytes||MAX_REMOTE_ASSET_BYTES),80*1024*1024));
    if (announced && announced>cap) throw new Error(`Remote image is ${announced} bytes, above maxBytes=${cap}`);
    const buf=Buffer.from(await r.arrayBuffer());
    if (buf.length>cap) throw new Error(`Remote image is ${buf.length} bytes, above maxBytes=${cap}`);
    return queueCommand(client,'assets',{action:'createImage',base64:buf.toString('base64')});
  } finally { clearTimeout(timer); }
}

async function callPluginTool(name,args={}) {
  const client = pickClient(args.clientId);
  const p = {...args}; delete p.clientId; delete p.delivery;
  const map={
    figma_context:'context',figma_inspect:'inspect',figma_search:'search',figma_snapshot:'snapshot',figma_render:'render',figma_batch:'batch',
    figma_text:'text',figma_components:'components',figma_prototype:'prototype',figma_dev:'dev',figma_motion:'motion',figma_analyse:'analyse',
    figma_variables:'variables',figma_styles:'styles',figma_assets:'assets',figma_library:'library',figma_fonts:'fonts',figma_history:'history',figma_invoke:'invoke',figma_capabilities:'capabilities'
  };
  if (name==='figma_assets' && p.action==='createImageFromUrl') return importRemoteAsset(client,p);
  const method=map[name];
  if (!method) throw new Error(`No plugin mapping for ${name}`);
  return queueCommand(client,method,p);
}

// bridge_status is usually the first tool an agent calls, so `note` is written
// as the agent's next action rather than a description of state.
function nextStepNote(all) {
  const connected = all.filter(c => c.connected);
  if (connected.length === 1) {
    return 'Ready. Call figma_context next; omit clientId — exactly one file is connected.';
  }
  if (connected.length > 1) {
    return `Ready, but ${connected.length} plugin windows are connected. Pass clientId on every figma_* call, or ask the user to close the extra plugin window. Most recently active: ${connected[0].clientId}.`;
  }
  if (all.length) {
    return 'The plugin was connected but has gone quiet. Ask the user to reopen the "Figma Agent Bridge" plugin in Figma Desktop; it reconnects automatically without a new code. Do not retry until they confirm.';
  }
  return `Not connected yet. Ask the user to open their file in Figma Desktop, run Plugins → Development → "Figma Agent Bridge", and enter this code: ${currentPairingCode()}. It expires in 15 minutes; call bridge_status again for a fresh one. Do not retry other figma_* tools until they confirm.`;
}

function statusResult(args={}) {
  const all=[...clients.values()].sort((a,b)=>b.lastSeen-a.lastSeen).map(c=>{
    const avg=c.metrics.successes+c.metrics.errors ? Math.round(c.metrics.totalLatencyMs/Math.max(1,c.metrics.successes+c.metrics.errors)) : null;
    return {
      clientId:c.clientId,installId:c.installId?c.installId.slice(0,18)+'…':null,connected:now()-c.lastSeen<LIVE_CLIENT_MS,
      lastSeen:c.lastSeen?new Date(c.lastSeen).toISOString():null,pairedAt:c.pairedAt,plugin:c.plugin,
      queuedCommands:c.queue.length,pendingCommands:[...pending.values()].filter(p=>p.clientId===c.clientId).length,
      metrics:{...c.metrics,averageLatencyMs:avg},...(args.includeEvents?{recentEvents:c.events.slice(-20)}:{})
    };
  });
  return {
    name:'figma-agent-bridge',version:VERSION,transport:`http://${HOST}:${PORT}`,
    pairingCode:currentPairingCode(),pairingExpiresAt:new Date(pairing.expiresAt).toISOString(),
    connectedClients:all.filter(c=>c.connected).length,pendingCommands:pending.size,maxPending:MAX_PENDING,maxQueuePerClient:MAX_QUEUE_PER_CLIENT,
    exportDirectory:EXPORT_DIR,secretFile:SECRET_FILE,clients:all,
    note:nextStepNote(all)
  };
}

function doctorResult() {
  const issues=[];
  if (process.version.replace(/^v/,'').split('.')[0] < 20) issues.push('Node.js 20+ is recommended.');
  if (pending.size > MAX_PENDING*0.8) issues.push('Pending command pressure is high.');
  for (const c of clients.values()) if (c.queue.length > MAX_QUEUE_PER_CLIENT*0.8) issues.push(`Queue pressure high for ${c.plugin?.fileName||c.clientId}.`);
  let secretMode=null; try { secretMode=(fs.statSync(SECRET_FILE).mode & 0o777).toString(8); if(secretMode!=='600') issues.push(`Secret file permissions are ${secretMode}; expected 600.`); } catch(e){issues.push('Secret file cannot be stat()ed.');}
  return {
    ok:issues.length===0,version:VERSION,node:process.version,platform:process.platform,arch:process.arch,pid:process.pid,
    host:HOST,port:PORT,stateDirectory:STATE_DIR,exportDirectory:EXPORT_DIR,secretFile:SECRET_FILE,secretMode,
    connectedClients:liveClients().length,pending:pending.size,queued:[...clients.values()].reduce((n,c)=>n+c.queue.length,0),issues
  };
}

function textContent(value) {
  return [{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}];
}
function sniffExt(buf) {
  if (buf.length>=8 && buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (buf.length>=3 && buf[0]===0xff && buf[1]===0xd8 && buf[2]===0xff) return 'jpg';
  if (buf.length>=4 && buf.subarray(0,4).toString('ascii')==='%PDF') return 'pdf';
  if (buf.length>=4 && buf.subarray(0,4).toString('ascii')==='GIF8') return 'gif';
  if (buf.length>=12 && buf.subarray(0,4).toString('ascii')==='RIFF' && buf.subarray(8,12).toString('ascii')==='WEBP') return 'webp';
  return 'bin';
}
function saveExport(base64, prefix='figma-export', forcedExt=null) {
  const buf=Buffer.from(base64,'base64'); const ext=forcedExt||sniffExt(buf);
  const file=path.join(EXPORT_DIR,`${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
  fs.writeFileSync(file,buf,{mode:0o600}); return {path:file,byteLength:buf.length,extension:ext};
}
function mcpToolResult(name,result,args={}) {
  if (name === 'figma_snapshot' && result && result.render?.base64) {
    const render=result.render; const compact={...result,render:{format:render.format,byteLength:render.byteLength}};
    const delivery=args.delivery||'auto';
    if (delivery==='file' || (delivery==='auto' && render.byteLength>MAX_INLINE_RENDER_BYTES)) {
      compact.render.savedFile=saveExport(render.base64,'figma-snapshot','png');
      compact.render.delivery='file';
      return {content:textContent(compact),structuredContent:compact};
    }
    compact.render.delivery='inline';
    return {content:[{type:'image',data:render.base64,mimeType:'image/png'},{type:'text',text:JSON.stringify(compact,null,2)}],structuredContent:compact};
  }
  if (name === 'figma_render' && result && result.base64 && ['PNG','JPG'].includes(result.format)) {
    const delivery=args.delivery||'auto';
    if (delivery==='file' || (delivery==='auto' && result.byteLength>MAX_INLINE_RENDER_BYTES)) {
      const saved=saveExport(result.base64,'figma-render',result.format==='PNG'?'png':'jpg');
      const compact={id:result.id,format:result.format,...saved,delivery:'file'};
      return {content:textContent(compact),structuredContent:compact};
    }
    return { content:[{type:'image',data:result.base64,mimeType:result.format==='PNG'?'image/png':'image/jpeg'},{type:'text',text:JSON.stringify({id:result.id,format:result.format,byteLength:result.byteLength,delivery:'inline'})}] };
  }
  if (name === 'figma_render' && result && result.base64 && result.format === 'PDF') {
    const saved=saveExport(result.base64,'figma-render','pdf');
    const compact={id:result.id,format:result.format,...saved};
    return {content:textContent(compact),structuredContent:compact};
  }
  if (name === 'figma_assets' && result && result.base64) {
    const saved=saveExport(result.base64,'figma-image');
    const compact={...result}; delete compact.base64; compact.savedFile=saved;
    return {content:textContent(compact),structuredContent:compact};
  }
  return { content:textContent(result), structuredContent:result && typeof result==='object' ? result : undefined };
}

async function executeTool(name,args) {
  if (!toolByName(name)) throw new Error(`Unknown tool: ${name}`);
  if (name === 'bridge_status') return statusResult(args);
  if (name === 'bridge_doctor') return doctorResult();
  if (name === 'figma_recent_events') {
    const c = pickClient(args?.clientId); const limit=Math.max(1,Math.min(Number(args?.limit||30),200));
    const events=c.events.slice(-limit); if (args?.clear) c.events.length=0; return {clientId:c.clientId,events};
  }
  return callPluginTool(name,args || {});
}

function rpcResult(id,result) { return {jsonrpc:'2.0',id,result}; }
function rpcError(id,code,message,data) { return {jsonrpc:'2.0',id,error:{code,message,...(data?{data}: {})}}; }
function writeRpc(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handleRpc(msg) {
  const id = msg.id;
  try {
    switch (msg.method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion;
        return rpcResult(id,{
          protocolVersion: requested || MCP_VERSION,
          capabilities:{ tools:{listChanged:false}, resources:{subscribe:false,listChanged:false}, prompts:{listChanged:false} },
          serverInfo:{name:'figma-agent-bridge',version:VERSION},
          instructions:[
            'Live control plane for an open Figma file, via a plugin running in Figma Desktop.',
            '',
            'START HERE: call bridge_status. Its `note` field states your next action verbatim — follow it.',
            'If no plugin is connected, the bridge cannot connect it for you: ask the user to run the "Figma Agent Bridge" plugin (Plugins → Development) and relay the pairing code from bridge_status. Wait for their confirmation instead of retrying.',
            'Once connected, call figma_context for pages, active page and selection. Omit clientId whenever exactly one file is connected.',
            '',
            'READING: figma_search to locate nodes, figma_inspect for depth. Both are bounded — start narrow (small depth/childLimit) and widen, because full-fidelity dumps of a whole screen will exceed your context. Use topLevelOnly:true to list a page\'s screens. Mask relationships are resolved for you: a mask node reports `masks.maskedIds`, and each clipped node reports `maskedBy`.',
            'EDITING: prefer the narrowest named tool; use figma_batch for multi-step edits with assertions and rollbackOnError, then figma_render to verify visually. Rich text goes through figma_text.',
            'figma_invoke is a last resort and requires the user to enable "Unsafe API invoke" in the plugin UI.',
            'Writes fail while the user has Write access paused in the plugin — surface that to them rather than retrying.'
          ].join('\n')
        });
      }
      case 'ping': return rpcResult(id,{});
      case 'tools/list': return rpcResult(id,{tools:TOOLS});
      case 'tools/call': {
        const name = msg.params?.name; const args = msg.params?.arguments || {};
        try { const result=await executeTool(name,args); return rpcResult(id,mcpToolResult(name,result,args)); }
        catch (e) { return rpcResult(id,{isError:true,content:[{type:'text',text:e.remoteError?JSON.stringify(e.remoteError,null,2):(e.message||String(e))}]}); }
      }
      case 'resources/list': {
        const resources = liveClients().map(c => ({ uri:`figma://client/${encodeURIComponent(c.clientId)}/context`,name:`${c.plugin?.fileName||'Figma file'} context`,mimeType:'application/json',description:'Live Figma context exposed by Figma Agent Bridge.' }));
        return rpcResult(id,{resources});
      }
      case 'resources/read': {
        const uri=String(msg.params?.uri||'');
        const m=uri.match(/^figma:\/\/client\/([^/]+)\/context$/); if(!m) return rpcError(id,-32602,'Unknown resource URI');
        const clientId=decodeURIComponent(m[1]); const result=await callPluginTool('figma_context',{clientId});
        return rpcResult(id,{contents:[{uri,mimeType:'application/json',text:JSON.stringify(result,null,2)}]});
      }
      case 'prompts/list': return rpcResult(id,{prompts:[{
        name:'safe_design_edit',description:'Inspect, edit and visually verify a Figma design change with rollback protection.',arguments:[{name:'goal',description:'Desired design change',required:true}]
      }]});
      case 'prompts/get': {
        if(msg.params?.name!=='safe_design_edit') return rpcError(id,-32602,'Unknown prompt');
        const goal=msg.params?.arguments?.goal||'the requested change';
        return rpcResult(id,{description:'Safe Figma edit workflow',messages:[{role:'user',content:{type:'text',text:`Goal: ${goal}\n1. Call bridge_status if needed. 2. Call figma_context. 3. Inspect only the relevant nodes deeply. 4. Apply the smallest figma_batch with rollbackOnError=true. 5. Call figma_render and visually verify. 6. If wrong, undo or correct; never add effects/styles not present in the source without explicit instruction.`}}]});
      }
      default:
        if (msg.method?.startsWith('notifications/')) return null;
        return rpcError(id,-32601,`Method not found: ${msg.method}`);
    }
  } catch (e) { return rpcError(id,-32603,e.message||String(e)); }
}

let stdinBuffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  stdinBuffer += chunk;
  for (;;) {
    const i=stdinBuffer.indexOf('\n'); if(i<0) break;
    const line=stdinBuffer.slice(0,i).trim(); stdinBuffer=stdinBuffer.slice(i+1);
    if(!line) continue;
    let msg; try { msg=JSON.parse(line); } catch(e) { writeRpc(rpcError(null,-32700,'Parse error')); continue; }
    Promise.resolve(handleRpc(msg)).then(r => { if(r && msg.id!==undefined) writeRpc(r); }).catch(e => { if(msg.id!==undefined) writeRpc(rpcError(msg.id,-32603,e.message||String(e))); });
  }
});
process.stdin.on('end', () => shutdown());

function shutdown() {
  clearInterval(cleanupTimer);
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Bridge shutting down')); }
  pending.clear();
  httpServer.close(() => process.exit(0));
  setTimeout(()=>process.exit(0),500).unref();
}
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);

stderr(`MCP stdio server ${VERSION} ready; pairing code ${currentPairingCode()}`);
