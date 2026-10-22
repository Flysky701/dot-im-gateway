import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {fixture,accept,now,signingSecret,response} from './helpers.js';
import {Events,signature,signingKey} from '../src/events.js';
const params=()=>({name:'message.created',arguments:{platform:'qq'},delivery:{mode:'webhook',url:'https://callback.example.com/event',secret:signingSecret}});
const verify=async(_url,o)=>response({challenge:JSON.parse(o.body).challenge});
test('Standard Webhooks signature matches independent expected construction',()=>{
  const body=Buffer.from('{"a":1}'),timestamp='1792640000',id='evt-test';const expected='v1,'+createHmac('sha256',Buffer.alloc(32,7)).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`),body])).digest('base64');assert.equal(signature(signingSecret,id,timestamp,body),expected);
  for(const key of ['x','whsec_a','whsec_'+Buffer.alloc(10).toString('base64')])assert.throws(()=>signingKey(key));
});
test('challenge must be echoed and no subscription survives failure',async t=>{
  const f=fixture(t),e=new Events(f.store,f.c,async()=>response({challenge:'wrong'}),()=>now);
  await assert.rejects(e.subscribe(params()),/challenge_failed/);assert.equal(f.store.all('SELECT * FROM subscriptions').length,0);
});
test('idempotent refresh, secret rotation, expiry, unsubscribe and persisted event identity',async t=>{
  const f=fixture(t);let clock=now;const calls=[];const send=async(u,o)=>{calls.push(o);return verify(u,o);};const e=new Events(f.store,f.c,send,()=>clock);
  const p=params(),a=await e.subscribe(p);assert.equal((await e.subscribe(p)).id,a.id);
  const m=await accept(f);assert.equal(f.store.all('SELECT * FROM events').length,1);
  p.delivery.secret='whsec_'+Buffer.alloc(32,8).toString('base64');await e.subscribe(p);e.send=async(u,o)=>{calls.push(o);return response({});};await e.tick();
  const sent=calls.at(-1);assert.equal(sent.headers['webhook-signature'].split(' ').length,2);assert.equal(sent.headers['webhook-id'],JSON.parse(sent.body).eventId);assert.equal(JSON.parse(sent.body).data.message_id,m.id);
  clock+=4000000;const later=f.adapters.qq.normalize((await import('./helpers.js')).qqRaw('q2'));f.store.accept(later,clock);assert.equal(f.store.all('SELECT * FROM events').length,1);
  e.send=verify;await e.subscribe({...p,ttlMs:1000});clock+=2000;await e.tick();assert.equal(f.store.one("SELECT state FROM events WHERE message_id<>?",m.id).state,'expired');
  e.unsubscribe(p);e.unsubscribe(p);assert.equal(f.store.one('SELECT active FROM subscriptions').active,0);
});
test('filter isolation and catch-up use persisted unfinished messages',async t=>{
  const f=fixture(t);await accept(f,'qq');await accept(f,'weixin');const e=new Events(f.store,f.c,verify,()=>now);await e.subscribe(params());assert.equal(f.store.all('SELECT * FROM events').length,1);
  const first=f.store.one('SELECT id FROM events').id;await e.subscribe(params());assert.equal(f.store.one('SELECT id FROM events').id,first);
});
test('webhook retries preserve ID but use fresh timestamp; 410 revokes',async t=>{
  const f=fixture(t);let clock=now;const e=new Events(f.store,f.c,verify,()=>clock);await e.subscribe(params());await accept(f);const ids=[];
  e.send=async(u,o)=>{ids.push(o.headers);return response({},500);};await e.tick();clock+=2000;await e.tick();assert.equal(ids[0]['webhook-id'],ids[1]['webhook-id']);assert.notEqual(ids[0]['webhook-timestamp'],ids[1]['webhook-timestamp']);
  clock+=4000;e.send=async()=>response({},410);await e.tick();assert.equal(f.store.one('SELECT active FROM subscriptions').active,0);assert.equal(f.store.one('SELECT state FROM events').state,'dead');
});
test('subscription gate and invalid filters fail before verification',async t=>{
  const f=fixture(t),e=new Events(f.store,f.c,()=>{throw new Error('must not call');},()=>now);f.c.allowSubscriptions=false;await assert.rejects(e.subscribe(params()),/gate_closed/);f.c.allowSubscriptions=true;await assert.rejects(e.subscribe({...params(),arguments:{platform:'all'}}));await assert.rejects(e.subscribe({...params(),ttlMs:-1}));
});
test('unsubscribe during verification cannot reactivate late subscription',async t=>{
  const f=fixture(t);let finish;const e=new Events(f.store,f.c,async(u,o)=>new Promise(resolve=>{finish=()=>resolve(response({challenge:JSON.parse(o.body).challenge}));}),()=>now);
  const pending=e.subscribe(params());e.unsubscribe(params());finish();await assert.rejects(pending,/superseded/);assert.equal(f.store.all('SELECT * FROM subscriptions').length,0);
});
test('revoked subscription renews without retaining revoked secret; cache is bounded',async t=>{
  const f=fixture(t);let calls=0;const e=new Events(f.store,f.c,async(u,o)=>{calls++;return verify(u,o);},()=>now);
  await e.subscribe(params());await e.subscribe(params());assert.equal(calls,1);e.unsubscribe(params());await e.subscribe(params());assert.equal(calls,2);assert.equal(f.store.one('SELECT old_secret FROM subscriptions').old_secret,null);
});
