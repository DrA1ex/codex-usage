// Optional integration check against a disposable Chrome DevTools endpoint.
// node tests/browser_smoke.mjs ws://127.0.0.1:PORT/devtools/browser/ID report.html preview.png
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const [endpoint, report, screenshot] = process.argv.slice(2);
if (!endpoint || !report) throw new Error('Expected a disposable browser endpoint and an HTML path');
const ws = new WebSocket(endpoint);
await new Promise((resolve, reject) => {ws.addEventListener('open', resolve, {once:true});ws.addEventListener('error', reject, {once:true});});
let nextId=0;
const waiting=new Map(),exceptions=[];
ws.addEventListener('message', event => {
  const message=JSON.parse(event.data);
  if(message.method==='Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
  if(message.id&&waiting.has(message.id)) {
    const {resolve,reject,timer}=waiting.get(message.id);clearTimeout(timer);waiting.delete(message.id);
    message.error?reject(new Error(JSON.stringify(message.error))):resolve(message.result);
  }
});
function send(method,params={},sessionId){return new Promise((resolve,reject)=>{
  const id=++nextId,timer=setTimeout(()=>{waiting.delete(id);reject(new Error('Timeout: '+method));},15000);
  waiting.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
});}
const {targetId}=await send('Target.createTarget',{url:'about:blank'});
const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
try {
  await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1400,deviceScaleFactor:1,mobile:false},sessionId);
  await send('Page.navigate',{url:pathToFileURL(path.resolve(report)).href},sessionId);
  let ready=false;
  for(let i=0;i<50;i++){ready=await evaluate("document.readyState==='complete' && document.getElementById('card2')?.textContent.length>0");if(ready)break;await new Promise(r=>setTimeout(r,100));}
  assert(ready,'Report did not render');
  const initial=await evaluate(`({observations:Number(document.getElementById('card2').textContent),expectedObservations:D.period_rows.reduce((n,r)=>n+r.observations,0),rows:document.querySelectorAll('#periodTable tbody tr').length,svg:document.querySelectorAll('#chart svg').length,models:D.models.length,card1:document.getElementById('card1').textContent})`);
  assert.equal(initial.observations,initial.expectedObservations);assert.equal(initial.svg,1);assert(initial.models>0);
  await evaluate("document.getElementById('mode').value='capacity';document.getElementById('threshold').value=100; document.getElementById('threshold').dispatchEvent(new Event('change'))");
  const full=await evaluate(`({actual:Number(document.getElementById('card2').textContent),expected:D.windows.filter(w=>w.limit_id===O.limit_id&&w.minutes===O.quota_minutes&&!w.exclusion&&w.full).length})`);
  assert.equal(full.actual,full.expected);
  await evaluate("document.getElementById('threshold').value=98; document.getElementById('mode').value='usage';document.getElementById('metric').value='output_tokens';document.getElementById('period').value=172800;document.getElementById('mode').dispatchEvent(new Event('change'))");
  const usage=await evaluate(`(()=>{const s=settings(),r=aggregate(s),i=D.metric_keys.indexOf('output_tokens'),expected=D.events.filter(e=>!e[2]).reduce((n,e)=>n+e[3][i],0);return {actual:r.reduce((n,r)=>n+r.value,0),expected,rows:r.length}})()`);
  assert.equal(usage.actual,usage.expected);assert(usage.rows>0);
  await evaluate("document.getElementById('mode').value='capacity';document.getElementById('metric').value='total_tokens';document.getElementById('quota').value=D.available_quota_minutes.at(-1);document.getElementById('mode').dispatchEvent(new Event('change'))");
  const largest=await evaluate(`({actual:Number(document.getElementById('card2').textContent),expected:D.windows.filter(w=>w.limit_id===O.limit_id&&w.minutes===D.available_quota_minutes.at(-1)&&!w.exclusion&&w.max_used>=98).length})`);
  assert.equal(largest.actual,largest.expected);
  const workingModel=await evaluate("D.models.find(m=>D.windows.some(w=>w.classification===m&&!w.exclusion&&w.max_used>=98&&w.minutes===O.quota_minutes))");
  if(workingModel) {
    await evaluate(`document.getElementById('quota').value=O.quota_minutes;document.getElementById('model').value=${JSON.stringify(workingModel)};document.getElementById('model').dispatchEvent(new Event('change'))`);
    const filtered=await evaluate("({actual:Number(document.getElementById('card2').textContent),expected:eligibleWindows(settings()).length,models:aggregate(settings()).map(r=>r.model)})");
    assert.equal(filtered.actual,filtered.expected);assert(filtered.models.every(m=>m===workingModel));
  }
  await evaluate("document.getElementById('start').value='';document.getElementById('start').dispatchEvent(new Event('change'))");
  assert((await evaluate("document.getElementById('notice').textContent")).includes('Start'));
  await evaluate("document.getElementById('start').value=isoDay(O.start_ts);document.getElementById('end').value=isoDay(O.end_ts-.001);document.getElementById('model').value='__all__';document.getElementById('mode').value=O.mode;document.getElementById('metric').value=O.metric;document.getElementById('period').value=O.period_seconds;document.getElementById('quota').value=O.quota_minutes;document.getElementById('threshold').value=O.min_used;document.getElementById('start').dispatchEvent(new Event('change'))");
  assert.deepEqual(exceptions,[],'JavaScript runtime exception');
  if(screenshot){const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);await fs.writeFile(screenshot,Buffer.from(image.data,'base64'));}
  console.log(JSON.stringify({initial,usage,exceptions,screenshot},null,2));
} finally {
  await send('Target.closeTarget',{targetId});ws.close();
}
