import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setImmediate as next} from 'node:timers/promises';
import {Connector,connectionInput} from '../src/connector.js';
import {connectServer} from '../src/connect-http.js';
import {validateTestInput} from '../src/qq-private-session.js';

const input=()=>({platform:'qq',appId:'test-app',secret:'synthetic-qq-secret-only',tunnelId:'tunnel_synthetic',organizationId:'org-synthetic',runtimeKey:'synthetic-tunnel-key-only',confirmed:true});
test('one-shot connection rejects missing consent, arbitrary targets and credential arguments',()=>{
  for(const change of [{confirmed:false},{platform:'other'},{secret:'short'},{recipient:'other'},{runtimeKey:'unsafe\ncredential0000000'}])assert.throws(()=>connectionInput({...input(),...change}));
  assert.equal(connectionInput(input()).platform,'qq');
});
test('binding confirmation is independent, secrets do not enter state, one connection only',async()=>{
  let emitted,tunnelStarts=0,tunnelStops=0,ended=0;
  const raw=input();
  const connector=new Connector({dataDir:'synthetic',onEnd:()=>ended++,startTunnel:async args=>{tunnelStarts++;assert.equal(args.key,'synthetic-tunnel-key-only');return {stop:async()=>tunnelStops++};},qq:async(i,{emit,commands,signal,untilStopped})=>{
    emitted=emit;assert.equal(i.maximumSeconds,0);assert.equal(untilStopped,true);
    emit({stage:'binding_challenge',challenge:'synthetic-challenge',token:i.secret});
    await new Promise(r=>{signal.addEventListener('abort',r,{once:true});commands.once('line',v=>{assert.equal(v,'CONFIRM test-app owner-stable');emit({stage:'gateway_ready',url:'http://127.0.0.1:12345/mcp'});});});
  }});
  connector.start(raw);await next();assert.equal(connector.snapshot().stage,'qq_challenge');assert.equal(tunnelStarts,0);
  emitted({stage:'candidate',appId:'test-app',ownerId:'owner-stable'});assert.throws(()=>connector.command({value:'CONFIRM test-app attacker'}));
  connector.command({value:'CONFIRM test-app owner-stable'});await next();assert.equal(connector.snapshot().stage,'connected');
  assert.equal(JSON.stringify(connector.snapshot()).includes('secret'),false);assert.throws(()=>connector.start(input()));
  await connector.stop();assert.equal(tunnelStarts,1);assert.equal(tunnelStops,1);assert.equal(ended,1);assert.equal(raw.secret,'');assert.equal(raw.runtimeKey,'');
});
test('QR and phone digits stay in the explicit local interaction; stopping aborts login',async()=>{
  let emit,command;
  const connector=new Connector({dataDir:'synthetic',startTunnel:()=>{throw Error('must not start');},weixin:async(i,o)=>{
    emit=o.emit;o.commands.on('line',v=>command=v);o.emit({stage:'qr',content:'https://synthetic.invalid/qr',bot_token:'must-not-forward'});
    await new Promise(r=>o.signal.addEventListener('abort',r,{once:true}));
  }});
  connector.start({...input(),platform:'weixin'});await next();assert.equal(connector.snapshot().qr,'https://synthetic.invalid/qr');assert.equal(connector.snapshot().bot_token,undefined);
  emit({stage:'verify_code_required'});assert.throws(()=>connector.command({value:'not-digits'}));connector.command({value:'123456'});assert.equal(command,'123456');assert.equal(JSON.stringify(connector.snapshot()).includes('123456'),false);
  await connector.stop();assert.equal(connector.snapshot().stage,'stopped');
});
test('legacy test duration cannot silently become unlimited',()=>{
  const data={appId:'app',expectedOwner:'',secret:'x'.repeat(16),bearer:'x'.repeat(32),dataDir:'synthetic',gatewayHosts:['api.bot.qq.com'],maximumSeconds:0};
  assert.throws(()=>validateTestInput(data));assert.equal(validateTestInput(data,{untilStopped:true}).maximumSeconds,0);
});
test('connection page enforces capability, loopback host, origin, operation schema and no arbitrary endpoint',async t=>{
  const token='synthetic-local-capability-0000000000000',calls=[];
  const connector={snapshot:()=>({stage:'idle'}),start:x=>calls.push(x),stop:async()=>{},command:()=>{}};
  const server=connectServer({token,connector,assets:{'/':{type:'text/html',body:'<p>one-time</p>'}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const port=server.address().port;
  const call=(url,body,headers={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:url,method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,Origin:'http://127.0.0.1:'+port,'Content-Type':'application/json',...headers}},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve({status:res.statusCode,body:b,headers:res.headers}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  assert.equal((await call('/state',null,{Authorization:'wrong'})).status,401);
  assert.equal((await call('/state',null,{Host:'evil.invalid'})).status,403);
  assert.equal((await call('/connect',input(),{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await call('/exec',{command:'anything'})).status,404);
  assert.equal((await call('/finish',{})).status,400);
  const page=await call('/');assert.equal(page.status,200);assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.equal((await call('/connect',input())).status,200);assert.equal(calls.length,1);
});
