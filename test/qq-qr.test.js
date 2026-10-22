import test from 'node:test';
import assert from 'node:assert/strict';
import {qqQrCredentials} from '../src/qq-qr.js';
import {qqWorkerStart,verifyQQWorker} from '../src/qq-qr-worker.js';
import {Connector} from '../src/connector.js';
const qr='https://q.qq.com/qqbot/openclaw/connect.html?task_id=synthetic&source=';
const credential=owner=>({appId:'app',appSecret:'synthetic-secret-0000000000',...(owner?{userOpenid:owner}:{})});
const next=()=>new Promise(r=>setImmediate(r));
test('official QR callback disables console branding override, clears source credentials and stops SDK',async()=>{
  let stopped=0,raw;const events=[];
  const result=await qqQrCredentials((c,o)=>{assert.equal(o.source,'');assert.equal(o.displayQrCodeToConsole,false);raw=[credential('owner')];c.onQrDisplayed(qr);c.onSuccess(raw);return async()=>{stopped++;};},{emit:e=>events.push(e),expectedAppId:'app'});
  assert.equal(result.userOpenid,'owner');assert.equal(result.appId,'app');assert.equal(raw[0].appSecret,'');assert.equal(stopped,1);
  assert.equal(JSON.stringify(events).includes('synthetic-secret'),false);assert.deepEqual(events,[{stage:'qq_qr',content:qr}]);
});
test('QR rejects wrong app, multi-bot, malformed owner, unsafe URL and raw errors without disclosing details',async()=>{
  for(const invoke of [c=>c.onSuccess([credential()]),c=>c.onSuccess([credential(),credential()]),c=>c.onSuccess([{...credential(),userOpenid:'bad/owner'}]),c=>c.onQrDisplayed('https://q.qq.com.evil.invalid/qr'),c=>c.onFailure(Error('RAW-SECRET'))]){
    await assert.rejects(qqQrCredentials(c=>{invoke(c);return ()=>{};},{emit:()=>{},expectedAppId:'different'}),e=>!e.message.includes('RAW-SECRET'));
  }
});
test('QR timeout, cancellation, expiry and late success stop once and never retain credentials',async()=>{
  for(const mode of ['timeout','cancel','expired']){
    const abort=new AbortController();let callbacks,stops=0;
    const result=qqQrCredentials(c=>{callbacks=c;return ()=>{stops++;};},{signal:abort.signal,emit:()=>{},timeoutMs:15});
    if(mode==='cancel')abort.abort();if(mode==='expired')callbacks.onQrExpired();
    await assert.rejects(result,new RegExp('qq_qr_'+(mode==='cancel'?'cancelled':mode)));
    const late=[credential()];callbacks.onSuccess(late);await next();assert.equal(late[0].appSecret,'');assert.equal(stops,1);
  }
});
test('SDK worker cancellation terminates pending work and does not inherit parent environment',async()=>{
  const code="const {parentPort}=require('node:worker_threads'); if(Object.keys(process.env).length)throw Error('unexpected_env'); parentPort.postMessage({kind:'qr',url:'"+qr+"'}); setInterval(()=>{},1000);";
  const abort=new AbortController();let shown;const ready=new Promise(r=>{shown=r;});
  const result=qqQrCredentials(qqWorkerStart(code),{signal:abort.signal,emit:()=>shown(),timeoutMs:2000});
  await ready;abort.abort();await assert.rejects(result,/qq_qr_cancelled/);
  await verifyQQWorker("const {parentPort}=require('node:worker_threads');parentPort.postMessage({kind:'offline_check',publicApi:true});");
});
const input=()=>({platform:'qq',qqAuth:'qr',appId:'app',secret:'',tunnelId:'tunnel_synthetic',organizationId:'org-synthetic',runtimeKey:'synthetic-runtime-key',confirmed:true});
test('QR connector confirms selected app before runner; only official owner is trusted, missing owner uses challenge',async()=>{
  for(const owner of ['owner','']){
    let calls=0,observed;const connector=new Connector({dataDir:'synthetic',startTunnel:async()=>{},startQrConnect:c=>{c.onSuccess([credential(owner)]);return ()=>{};},qq:async(i,o)=>{calls++;observed={owner:o.verifiedOwner,expected:i.expectedOwner};o.emit({stage:'binding_challenge',challenge:'synthetic'});await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));}});
    connector.start(input());await next();assert.equal(connector.snapshot().stage,'qq_app_confirm');assert.equal(calls,0);assert.ok(!JSON.stringify(connector.snapshot()).includes('secret'));
    assert.throws(()=>connector.command({value:'CONNECT other'}));connector.command({value:'CONNECT app'});await next();assert.equal(calls,1);assert.deepEqual(observed,{owner,expected:owner});await connector.stop();
  }
});
test('stopping at selected-app confirmation clears secrets and never starts QQ or Tunnel',async()=>{
  const raw=input();const connector=new Connector({dataDir:'synthetic',startTunnel:()=>assert.fail('unexpected tunnel'),startQrConnect:c=>{c.onSuccess([credential()]);return ()=>{};},qq:()=>assert.fail('unexpected QQ')});
  connector.start(raw);await next();await connector.stop();assert.equal(raw.runtimeKey,'');assert.equal(raw.secret,'');
});
