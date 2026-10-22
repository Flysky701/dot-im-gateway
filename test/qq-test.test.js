import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {OwnerChallenge,QQTestRPC,runQQTest,validateTestInput} from '../src/qq-private-session.js';
import {VERSION} from '../src/server.js';
import {request} from '../src/network.js';
import {QQGateway} from '../src/adapters/qq-gateway.js';
import {fixture,qqRaw,accept,now,response} from './helpers.js';

function packet(challenge,owner='qq-owner-stable',id='bind'){
  const p=qqRaw(id);p.d.author.user_openid=owner;p.d.content=challenge;return p;
}
test('WSS diagnostics retain safe close code and opcode, answer server heartbeat, omit payload',async()=>{
  const socket=new EventEmitter(),written=[],events=[],values=new Map();
  socket.writable=true;socket.writableLength=0;socket.write=b=>written.push(b);socket.destroy=()=>{};
  const frame=p=>{const b=Buffer.from(JSON.stringify(p));return Buffer.concat([Buffer.from([0x81,b.length]),b]);};
  socket.resume=()=>{
    socket.emit('data',frame({op:10,d:{heartbeat_interval:1000}}));
    socket.emit('data',frame({op:1,d:'DO-NOT-LOG'}));
    socket.emit('data',Buffer.from([0x88,2,0x0f,0xa1])); // 4001
  };
  const store={get:k=>values.get(k),set:(k,v)=>values.set(k,v),audit:()=>{}};
  const gateway=new QQGateway({gateway:async()=>({url:'wss://api.bot.qq.com',token:'SECRET'}),receive:()=>{}},store,[],async()=>({socket,head:Buffer.alloc(0)}),()=>{},e=>events.push(e));
  await assert.rejects(gateway.session(),/qq_websocket_closed/);
  assert.equal(gateway.stopped,true);assert.equal(written.length,2);
  assert.ok(events.some(e=>e.close_code===4001));assert.ok(events.some(e=>e.op===1));
  assert.ok(!JSON.stringify(events).includes('SECRET'));assert.ok(!JSON.stringify(events).includes('DO-NOT-LOG'));
});
test('binding requires unpredictable challenge plus independent terminal confirmation, never first message',()=>{
  const b=new OwnerChallenge('app',{wall:()=>now});
  assert.match(b.challenge,/^DOT-BIND-[a-f0-9]{48}$/);
  assert.notEqual(b.challenge,new OwnerChallenge('app').challenge);
  assert.equal(b.observe(qqRaw()),null);assert.equal(b.owner,null);
  assert.throws(()=>b.confirm('CONFIRM app qq-owner-stable'),/binding_no_candidate/);
  assert.equal(b.observe(packet(b.challenge)),'qq-owner-stable');assert.equal(b.owner,null);
  assert.equal(b.observe(packet(b.challenge)),null);
  assert.equal(b.confirm('CONFIRM app qq-owner-stable'),'qq-owner-stable');
  assert.throws(()=>b.confirm('CONFIRM app qq-owner-stable'),/binding_closed/);
});
test('wrong, ambiguous, group, attachment, self, claimed-name and expired binding cannot authorize',()=>{
  for(const patch of [{group_openid:'g'},{attachments:[{}]},{author:{user_openid:'claimed',bot:true}},{message_type:3}]){
    const b=new OwnerChallenge('app',{wall:()=>now}),p=packet(b.challenge);Object.assign(p.d,patch);assert.equal(b.observe(p),null);
  }
  let time=0;const expired=new OwnerChallenge('app',{clock:()=>time,wall:()=>now});time=120000;
  assert.throws(()=>expired.observe(packet(expired.challenge)),/binding_closed/);
  const known=new OwnerChallenge('app',{expectedOwner:'expected',wall:()=>now});
  assert.throws(()=>known.observe(packet(known.challenge,'imposter')),/binding_wrong_owner/);
  assert.throws(()=>known.confirm('CONFIRM app imposter'),/binding_closed/);
  const ambiguous=new OwnerChallenge('app',{wall:()=>now});ambiguous.observe(packet(ambiguous.challenge));
  assert.throws(()=>ambiguous.observe(packet(ambiguous.challenge,'second')),/binding_ambiguous/);
  const wrong=new OwnerChallenge('app',{wall:()=>now});wrong.observe(packet(wrong.challenge));
  assert.throws(()=>wrong.confirm('CONFIRM other-app qq-owner-stable'),/binding_confirmation_mismatch/);
});
test('QQ test exposes only four tools and rejects media, event, resources and receiver overrides',async t=>{
  const f=fixture(t);f.c.weixin.enabled=false;let active=true;const rpc=new QQTestRPC(f.core,()=>active);
  const discovered=await rpc.dispatch('server/discover',{});assert.deepEqual(discovered.capabilities,{tools:{}});
  const list=await rpc.dispatch('tools/list',{});assert.deepEqual(list.tools.map(t=>t.name),['gateway_status','list_pending','read_message','reply']);
  assert.equal(list.tools[3].inputSchema.properties.media_id,undefined);
  for(const method of ['events/list','events/subscribe','resources/read','resources/list','execute'])await assert.rejects(rpc.dispatch(method,{}));
  for(const name of ['put_media','read_media','shell'])await assert.rejects(rpc.dispatch('tools/call',{name,arguments:{}}));
  const m=await accept(f);for(const extra of [{media_id:'file'},{receiver:'other'},{platform:'weixin'},{path:'/etc/passwd'}])await assert.rejects(rpc.dispatch('tools/call',{name:'reply',arguments:{message_id:m.id,phase:'ack',text:'ok',...extra}}));
  const first=await rpc.dispatch('tools/call',{name:'reply',arguments:{message_id:m.id,phase:'ack',text:'ok'}});
  const duplicate=await rpc.dispatch('tools/call',{name:'reply',arguments:{message_id:m.id,phase:'ack',text:'ok'}});assert.deepEqual(first,duplicate);
  const wx=await accept(f,'weixin');await assert.rejects(rpc.dispatch('tools/call',{name:'read_message',arguments:{message_id:wx.id}}),/qq_only/);
  f.store.run('UPDATE messages SET owner=? WHERE id=?','other',m.id);assert.equal((await rpc.dispatch('tools/call',{name:'read_message',arguments:{message_id:m.id}})).isError,true);
  active=false;await assert.rejects(rpc.dispatch('tools/list',{}),/test_session_expired/);
});
test('input bounds reject arbitrary destinations, secrets in extra fields and extended durations',()=>{
  const good={appId:'app',expectedOwner:'',secret:'s'.repeat(32),bearer:'b'.repeat(40),dataDir:'unused',gatewayHosts:['api.bot.qq.com'],maximumSeconds:1800};
  assert.equal(validateTestInput(good),good);
  for(const patch of [{maximumSeconds:1801},{maximumSeconds:0},{gatewayHosts:['127.0.0.1']},{gatewayHosts:['qq.com.evil.example']},{command:'sh'},{secret:'bad\nsecret'}])assert.throws(()=>validateTestInput({...good,...patch}));
});
const meta={'io.modelcontextprotocol/protocolVersion':VERSION,'io.modelcontextprotocol/clientInfo':{name:'qq-offline-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
function call(url,bearer,method,params={}){
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':VERSION,'Mcp-Method':method,...(params.name?{'Mcp-Name':params.name}:{})}},res=>{
      let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));
    });req.setTimeout(2000,()=>req.destroy(new Error('test_request_timeout')));req.on('error',reject);req.end(JSON.stringify({jsonrpc:'2.0',id:1,method,params:{_meta:meta,...params}}));
  });
}
test('isolated session binds, receives once, sends ack/final via mock QQ, and closes on EOF',async t=>{
  const f=fixture(t),dir=path.join(f.dir,'qq-session'),commands=new EventEmitter(),events=[];let adapter,finishGateway,challenge;
  let readyResolve;const ready=new Promise(r=>{readyResolve=r;});
  class FakeGateway{
    constructor(a){adapter=a;}
    run(){adapter.receive({op:0,t:'READY',s:1,d:{}});return new Promise(r=>{finishGateway=r;});}
    stop(){finishGateway?.();}
  }
  const token='synthetic-qq-test-bearer-0000000000000000',secret='synthetic-qq-app-secret-00000000000000',sent=[];
  const input={appId:'app',expectedOwner:'qq-owner-stable',secret,bearer:token,dataDir:dir,gatewayHosts:['api.bot.qq.com'],maximumSeconds:10};
  const abort=new AbortController();t.after(()=>abort.abort());
  const running=runQQTest(input,{commands,signal:abort.signal,Gateway:FakeGateway,wall:()=>now,emit:e=>{events.push(e);if(e.stage==='binding_challenge')challenge=e.challenge;if(e.stage==='gateway_ready')readyResolve(e.url);},send:async(url,o)=>{
    if(url.endsWith('getAppAccessToken')){assert.equal(JSON.parse(o.body).clientSecret,secret);return response({access_token:'synthetic-access',expires_in:7200});}
    sent.push(JSON.parse(o.body));return response({id:'sent-'+sent.length});
  }});
  adapter.receive(qqRaw('first-stranger'));assert.equal(fs.existsSync(dir),false);
  adapter.receive(packet(challenge));assert.equal(fs.existsSync(dir),false);
  commands.emit('line','CONFIRM app qq-owner-stable');const url=await ready;
  assert.equal((await call(url,'wrong','tools/list')).status,401);
  const list=await call(url,token,'tools/list');assert.equal(list.body.result.tools.length,4);
  adapter.receive(packet(challenge));adapter.receive(packet('not-the-challenge','other','other'));
  const p=qqRaw('task');adapter.receive(p);adapter.receive(p);
  let pending;
  for(let i=0;i<30;i++){
    pending=await call(url,token,'tools/call',{name:'list_pending',arguments:{}});
    if(pending.body.result.structuredContent.messages.length)break;
    await new Promise(r=>setTimeout(r,20));
  }
  const messages=pending.body.result.structuredContent.messages;assert.equal(messages.length,1);assert.equal(messages[0].text,'hello');
  for(const phase of ['ack','final'])await call(url,token,'tools/call',{name:'reply',arguments:{message_id:messages[0].id,phase,text:phase}});
  for(let i=0;i<30&&sent.length<2;i++)await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(sent.map(x=>x.msg_seq),[1,2]);assert.ok(sent.every(x=>x.msg_id==='task'));
  commands.emit('close');await running;
  assert.equal(input.secret,'');assert.equal(input.bearer,'');
  await assert.rejects(call(url,token,'tools/list'));
  assert.ok(!JSON.stringify(events).includes(secret));
  const bytes=Buffer.concat(fs.readdirSync(dir).map(name=>fs.readFileSync(path.join(dir,name))));
  assert.ok(!bytes.includes(Buffer.from(secret)));assert.ok(!bytes.includes(Buffer.from(token)));assert.ok(!bytes.includes(Buffer.from(challenge)));
});
test('unconfirmed session times out, never creates database or listener, abort cancels outbound before DNS',async t=>{
  const f=fixture(t),dir=path.join(f.dir,'expired'),commands=new EventEmitter(),events=[];let closed=false,resolveGateway;
  class FakeGateway{run(){return new Promise(r=>{resolveGateway=r;});}stop(){closed=true;resolveGateway?.();}}
  await runQQTest({appId:'app',expectedOwner:'',secret:'s'.repeat(32),bearer:'b'.repeat(40),dataDir:dir,gatewayHosts:['api.bot.qq.com'],maximumSeconds:1},{commands,Gateway:FakeGateway,emit:e=>events.push(e),send:()=>assert.fail('network forbidden')});
  assert.equal(closed,true);assert.equal(fs.existsSync(dir),false);assert.ok(!events.some(e=>e.stage==='gateway_ready'));
  const abort=new AbortController();abort.abort();await assert.rejects(request('https://never.invalid',{hosts:['never.invalid'],signal:abort.signal}),/request_cancelled/);
});
test('bound session also expires without a stop command and closes its listener',{timeout:10000},async t=>{
  const f=fixture(t),commands=new EventEmitter(),events=[];let adapter,resolveGateway,readyResolve;
  const ready=new Promise(r=>{readyResolve=r;});
  class FakeGateway{constructor(a){adapter=a;}run(){adapter.receive({op:0,t:'READY',s:1,d:{}});return new Promise(r=>{resolveGateway=r;});}stop(){resolveGateway?.();}}
  // CI scheduling and synchronous SQLite setup can consume the original one-second
  // window before listen's callback. Bound both the setup wait and whole test so
  // an early session end fails explicitly instead of waiting forever for READY.
  const abort=new AbortController();t.after(()=>abort.abort());
  const token='b'.repeat(40),input={appId:'app',expectedOwner:'',secret:'s'.repeat(32),bearer:token,dataDir:path.join(f.dir,'bounded'),gatewayHosts:['api.bot.qq.com'],maximumSeconds:5};
  const running=runQQTest(input,{commands,signal:abort.signal,Gateway:FakeGateway,wall:()=>now,send:()=>assert.fail('network forbidden'),emit:e=>{events.push(e);if(e.stage==='gateway_ready')readyResolve(e.url);}});
  adapter.receive(packet(events.find(e=>e.stage==='binding_challenge').challenge));commands.emit('line','CONFIRM app qq-owner-stable');
  const url=await Promise.race([ready,running.then(()=>{throw new Error('session_ended_before_test_ready');})]);assert.equal((await call(url,token,'tools/list')).status,200);
  await running;await assert.rejects(call(url,token,'tools/list'));assert.equal(input.secret,'');
});
test('real gateway loop reports synthetic auth status and stops on first failure without leaking body',async t=>{
  const f=fixture(t),events=[],commands=new EventEmitter(),dir=path.join(f.dir,'auth-failed');let calls=0;
  await runQQTest({appId:'app',expectedOwner:'',secret:'s'.repeat(32),bearer:'b'.repeat(40),dataDir:dir,gatewayHosts:['api.bot.qq.com'],maximumSeconds:5},{commands,emit:e=>events.push(e),send:async()=>{calls++;return response({message:'DO-NOT-LOG-RAW-SECRET-BODY'},401);}});
  assert.equal(calls,1);assert.ok(events.some(e=>e.phase==='qq_auth_response'&&e.http_status===401));
  assert.ok(events.some(e=>e.stage==='failed'&&e.code==='qq_token_rejected'));
  assert.equal(fs.existsSync(dir),false);assert.ok(!JSON.stringify(events).includes('DO-NOT-LOG'));
});
