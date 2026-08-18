#!/usr/bin/env node
// Transport benchmark: exercises HTTP poll/result throughput without requiring Figma Desktop.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fab-bench-'));
const env = { ...process.env, HOME: tmp, USERPROFILE: tmp };
const server = spawn(process.execPath, [path.join(root, 'bridge', 'server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr=''; server.stderr.on('data', d=>stderr+=d);

async function waitHealth(){
  for(let i=0;i<80;i++){
    try { const r=await fetch('http://127.0.0.1:3874/health'); if(r.ok) return await r.json(); } catch {}
    await sleep(50);
  }
  throw new Error('bridge did not start: '+stderr);
}

function mcp(msg){ server.stdin.write(JSON.stringify(msg)+'\n'); }
const replies=new Map();
let buf='';
server.stdout.on('data', d=>{
  buf+=d;
  while(true){ const i=buf.indexOf('\n'); if(i<0) break; const line=buf.slice(0,i); buf=buf.slice(i+1); if(!line.trim()) continue;
    try { const obj=JSON.parse(line); if(obj.id!=null){ const waiter=replies.get(obj.id); if(waiter){ replies.delete(obj.id); waiter(obj); } } } catch {}
  }
});
function request(id, method, params={}){ return new Promise((resolve,reject)=>{ const t=setTimeout(()=>{replies.delete(id);reject(new Error('MCP timeout'));},10000); replies.set(id,o=>{clearTimeout(t);resolve(o)}); mcp({jsonrpc:'2.0',id,method,params}); }); }

try{
  const health=await waitHealth();
  const init=await request(1,'initialize',{protocolVersion:'2026-07-28',capabilities:{},clientInfo:{name:'bench',version:'1'}});
  if(init.error) throw new Error(JSON.stringify(init.error));

  // Obtain pairing code through bridge_status.
  const status=await request(2,'tools/call',{name:'bridge_status',arguments:{}});
  const text=status.result?.content?.find(x=>x.type==='text')?.text || '{}';
  const parsed=JSON.parse(text);
  const code=parsed.pairingCode;
  if(!code) throw new Error('no pairing code');

  const installId='bench-'+crypto.randomBytes(8).toString('hex');
  const pair=await fetch('http://127.0.0.1:3874/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,installId,clientId:'bench-runtime',plugin:{fileName:'Benchmark.fig',bridgeVersion:'0.2.7'}})});
  if(!pair.ok) throw new Error('pair failed '+await pair.text());
  const {token}=await pair.json();
  const headers={'content-type':'application/json'};
  const authQuery=`token=${encodeURIComponent(token)}&clientId=bench-runtime&installId=${encodeURIComponent(installId)}`;
  const hello=await fetch('http://127.0.0.1:3874/hello',{method:'POST',headers,body:JSON.stringify({token,clientId:'bench-runtime',installId,plugin:{fileName:'Benchmark.fig',bridgeVersion:'0.2.7'}})});
  if(!hello.ok) throw new Error('hello failed '+await hello.text());

  const N=100;
  let completed=0;
  let pluginStop=false;
  const pollAbort=new AbortController();
  const pluginLoop=(async()=>{
    while(!pluginStop || completed<N){
      let r;
      try { r=await fetch(`http://127.0.0.1:3874/poll?${authQuery}&max=8`,{signal:pollAbort.signal}); }
      catch (e) { if (pluginStop || e?.name==='AbortError') break; throw e; }
      if(r.status===204){ await sleep(1); continue; }
      if(!r.ok){ await sleep(5); continue; }
      const j=await r.json();
      for(const cmd of j.commands||[]){
        await fetch('http://127.0.0.1:3874/result',{method:'POST',headers,body:JSON.stringify({token,clientId:'bench-runtime',installId,id:cmd.id,ok:true,result:{benchmark:true}})});
        completed++;
      }
      if(!(j.commands||[]).length) await sleep(1);
    }
  })();

  const start=performance.now();
  const calls=[];
  for(let i=0;i<N;i++) calls.push(request(1000+i,'tools/call',{name:'figma_context',arguments:{clientId:'bench-runtime'}}));
  const results=await Promise.all(calls);
  const ms=performance.now()-start;
  pluginStop=true;
  pollAbort.abort();
  await pluginLoop;
  const errors=results.filter(r=>r.error || r.result?.isError).length;
  if(errors) throw new Error(`${errors} benchmark calls failed`);

  const perSec=N/(ms/1000);
  console.log(`OK: ${N} MCP -> bridge -> batched poll -> result round trips in ${ms.toFixed(1)}ms (${perSec.toFixed(1)} ops/s)`);
  console.log(`Bridge: ${health.name} ${health.version || ''}`.trim());
} finally {
  server.kill('SIGTERM');
  fs.rmSync(tmp,{recursive:true,force:true});
}
