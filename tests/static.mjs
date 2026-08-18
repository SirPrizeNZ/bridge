import fs from 'node:fs';
const code=fs.readFileSync('plugin/code.js','utf8');const ui=fs.readFileSync('plugin/ui.html','utf8');
const stable=JSON.parse(fs.readFileSync('plugin/manifest.json','utf8'));const max=JSON.parse(fs.readFileSync('plugin/manifest.max.json','utf8'));
function ok(v,m){if(!v)throw new Error(m)}
ok(!code.includes("figma.on('documentchange'"),'global documentchange listener should not be used under dynamic-page');
ok(code.includes("on('nodechange'"),'page-local nodechange listener missing');
ok(code.includes('writerWaiting'),'writer-priority scheduler missing');
ok(code.includes('Direct characters assignment is blocked'),'rich text reset guard missing');
ok(code.includes('Batch invoke requires unsafe=true'),'nested batch invoke safety gate missing');
ok(!code.includes("'commitUndo','triggerUndo','saveVersionHistoryAsync'"),'history operations must not be callable inside batch Figma op');
ok(code.includes('await page.loadAsync()'),'lazy page loading missing');
ok(code.includes('cmdComponents')&&code.includes('cmdMotion')&&code.includes('cmdAnalyse'),'advanced named tools missing');
ok(!stable.networkAccess.allowedDomains.includes('*'),'stable manifest must not allow wildcard networking');
ok(stable.networkAccess.allowedDomains.includes('http://localhost:3874'),'stable manifest must allow the documented localhost bridge URL');
ok(!JSON.stringify(stable.networkAccess).includes('127.0.0.1'),'manifest network access must not use 127.0.0.1 because Figma manifest validation rejects it');
ok(typeof stable.networkAccess.reasoning === 'string' && stable.networkAccess.reasoning.length > 10,'localhost allowedDomains requires reasoning');
ok(max.enableProposedApi===true,'Max manifest proposed APIs missing');
ok(ui.includes('Write access')&&ui.includes('Unsafe API invoke'),'paid-grade safety UI missing');
console.log('OK: static architecture/security/performance invariants');
