import { spawn } from 'node:child_process';
import http from 'node:http';

const child=spawn(process.execPath,['bridge/server.mjs'],{stdio:['pipe','pipe','pipe']});
let out=''; child.stdout.setEncoding('utf8'); child.stdout.on('data',d=>out+=d);
let err=''; child.stderr.setEncoding('utf8'); child.stderr.on('data',d=>err+=d);
function rpc(id,method,params={}){child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')}
function lines(){return out.trim().split('\n').filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean)}
function waitLine(test,timeout=4500){return new Promise((resolve,reject)=>{const start=Date.now();const t=setInterval(()=>{const v=lines().find(test);if(v){clearInterval(t);resolve(v)}else if(Date.now()-start>timeout){clearInterval(t);reject(new Error('timeout\n'+err+'\n'+out))}},20)})}
function request(method,path,body){return new Promise((resolve,reject)=>{const payload=body===undefined?null:JSON.stringify(body);const req=http.request({host:'127.0.0.1',port:3874,path,method,headers:payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{let j=null;try{j=d?JSON.parse(d):null}catch{}resolve({status:r.statusCode,body:j,text:d})})});req.on('error',reject);if(payload)req.write(payload);req.end()})}

try{
  // Wait for the transport to actually bind rather than guessing a fixed delay.
  for(let i=0;i<100;i++){try{await request('GET','/health');break}catch(_){await new Promise(r=>setTimeout(r,50))}}
  const h=await request('GET','/health'); if(!h.body?.ok||h.body.version!=='0.2.7')throw new Error('health/version failed');
  rpc(1,'initialize',{protocolVersion:'2026-07-28'});const init=await waitLine(x=>x.id===1);if(init.result?.serverInfo?.version!=='0.2.7')throw new Error('initialize failed');
  rpc(2,'tools/list');const tools=await waitLine(x=>x.id===2);const names=(tools.result?.tools||[]).map(x=>x.name);for(const n of ['bridge_doctor','figma_text','figma_components','figma_motion','figma_analyse'])if(!names.includes(n))throw new Error('missing '+n);
  rpc(3,'tools/call',{name:'bridge_status',arguments:{}});const status=await waitLine(x=>x.id===3);const st=JSON.parse(status.result.content[0].text);if(!st.pairingCode)throw new Error('pairing code missing');
  const clientId='smoke-runtime',installId='smoke-installation';
  const paired=await request('POST','/pair',{code:st.pairingCode,clientId,installId,plugin:{fileName:'Smoke.fig',bridgeVersion:'0.2.7'}});if(paired.status!==200||!paired.body?.token)throw new Error('pair failed '+paired.text);const token=paired.body.token;
  // Pairing code is one-use: old code must no longer work.
  const replay=await request('POST','/pair',{code:st.pairingCode,clientId:'evil',installId:'evil',plugin:{}});if(replay.status===200)throw new Error('pairing code replay unexpectedly accepted');
  const hello=await request('POST','/hello',{token,clientId,installId,plugin:{fileName:'Smoke.fig',bridgeVersion:'0.2.7'}});if(hello.status!==200)throw new Error('hello failed '+hello.text);
  const bad=await request('POST','/hello',{token,clientId:'other',installId:'wrong-install',plugin:{}});if(bad.status===200)throw new Error('per-install token accepted for wrong install');

  const pollPromise=request('GET',`/poll?token=${encodeURIComponent(token)}&clientId=${clientId}&installId=${installId}&max=8`);
  rpc(4,'tools/call',{name:'figma_context',arguments:{clientId}});rpc(5,'tools/call',{name:'figma_search',arguments:{clientId,name:'Card'}});
  const polled=await pollPromise;const commands=polled.body?.commands||[];if(!commands.length)throw new Error('no commands polled');
  for(const command of commands){const result=command.method==='context'?{fileName:'Smoke.fig',selection:[]}:{results:[],timingMs:1};const d=await request('POST','/result',{token,clientId,installId,id:command.id,ok:true,result});if(d.status!==200)throw new Error('result failed')}
  // If the second command missed the first poll, fetch it now.
  if(commands.length<2){const p=await request('GET',`/poll?token=${encodeURIComponent(token)}&clientId=${clientId}&installId=${installId}&max=8`);for(const command of p.body?.commands||[]){await request('POST','/result',{token,clientId,installId,id:command.id,ok:true,result:{results:[]}})}}
  const c=await waitLine(x=>x.id===4);if(!(c.result?.content?.[0]?.text||'').includes('Smoke.fig'))throw new Error('MCP result missing');
  await waitLine(x=>x.id===5);
  rpc(6,'tools/call',{name:'bridge_doctor',arguments:{}});const doctor=await waitLine(x=>x.id===6);if(!doctor.result?.content?.[0]?.text?.includes('0.2.7'))throw new Error('doctor failed');
  console.log(`OK: v0.2 transport + one-time pairing + per-install auth + ${names.length} tools + batched poll round-trip`);
}finally{child.kill('SIGTERM')}
