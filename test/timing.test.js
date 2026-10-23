import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture,accept,qqRaw,wxRaw,now,response,signingSecret} from './helpers.js';
import {Store} from '../src/store.js';
import {RPC} from '../src/server.js';
import {Events} from '../src/events.js';
import {Fault} from '../src/util.js';

test('persisted receipt, subscription delay, event request, dot reads and ack/final timings stay distinct',async t=>{
  const f=fixture(t);let clock=now;f.core.clock=f.adapters.qq.clock=()=>clock;
  let posting=false;
  const events=new Events(f.store,f.c,async(_u,o)=>{
    const body=JSON.parse(o.body);clock+=posting?300:200;
    return response(posting?{}:{challenge:body.challenge});
  },()=>clock),rpc=new RPC(f.core,events);
  const raw=qqRaw();raw.d.timestamp=new Date(now-1000).toISOString();
  f.adapters.qq.receive(raw);clock+=250;await f.core.tick();
  const m=f.store.one('SELECT id FROM messages');
  clock=now+60000;
  await events.subscribe({name:'message.created',arguments:{platform:'qq'},delivery:{mode:'webhook',url:'https://callback.example.com/private',secret:signingSecret}});
  posting=true;clock+=1000;await events.tick();
  clock+=500;await rpc.dispatch('tools/call',{name:'read_message',arguments:{message_id:m.id}});
  clock+=500;await rpc.dispatch('tools/call',{name:'read_message',arguments:{message_id:m.id}});
  f.core.reply({message_id:m.id,phase:'ack',text:'private-ack'});
  f.adapters.qq.sendReply=async(_m,r)=>{clock+=r.phase==='ack'?400:600;return 'private-provider-id';};
  clock+=100;await f.core.tick();clock+=5000;
  f.core.reply({message_id:m.id,phase:'final',text:'private-final'});clock+=100;await f.core.tick();
  const d=(await rpc.dispatch('tools/call',{name:'message_timing',arguments:{message_id:m.id}})).structuredContent;
  assert.equal(d.source_created_at,now-1000);assert.equal(d.received_at,now);
  assert.equal(d.dot_read_at,now+62000);assert.equal(d.events[0].queued_at,now+60200);
  assert.equal(d.events[0].started_at,now+61200);assert.equal(d.events[0].accepted_at,now+61500);
  assert.equal(d.events[0].durations_ms.last_send_to_accept,300);
  assert.equal(d.replies[0].queued_at,now+62500);assert.equal(d.replies[0].accepted_at,now+63000);
  assert.equal(d.replies[1].queued_at,now+68000);assert.equal(d.replies[1].accepted_at,now+68700);
  assert.equal(d.durations_ms.dot_read_to_final_queue,6000);assert.equal(d.replies[1].durations_ms.last_send_to_accept,600);
  assert.equal(d.phone_delivery_at,null);
  const text=JSON.stringify(d);for(const secret of ['hello','private-ack','private-final','private-provider-id','qq-owner-stable',signingSecret,'callback.example.com'])assert.equal(text.includes(secret),false);
  f.store.close();const reopened=new Store(f.dir);
  try{assert.deepEqual(reopened.timing(m.id),d);}finally{reopened.close();}
});

test('Weixin receipt uses gateway clock, duplicates preserve first receipt and diagnostic reads do not count as dot reads',async t=>{
  const f=fixture(t);let clock=now;f.adapters.weixin.clock=f.core.clock=()=>clock;
  f.adapters.weixin.api=async()=>({msgs:[wxRaw()],get_updates_buf:'opaque-cursor'});
  await f.adapters.weixin.poll();clock+=200;await f.adapters.weixin.poll();clock+=100;await f.core.tick();
  const m=f.store.one('SELECT id FROM messages'),rpc=new RPC(f.core,null);
  const d=(await rpc.dispatch('tools/call',{name:'message_timing',arguments:{message_id:m.id}})).structuredContent;
  assert.equal(d.received_at,now);assert.equal(d.dot_read_at,null);
  await rpc.dispatch('tools/call',{name:'list_pending',arguments:{}});
  assert.equal(f.store.timing(m.id).dot_read_at,now+300);
  assert.equal(JSON.stringify(d).includes('synthetic-context'),false);
});

test('retry timestamps retain first attempt and expose last-attempt duration, without inferring delivery',async t=>{
  const f=fixture(t),m=await accept(f);let clock=now,calls=0;f.core.clock=()=>clock;
  f.core.reply({message_id:m.id,phase:'ack',text:'ack'});
  f.adapters.qq.sendReply=async()=>{clock+=200;if(++calls===1)throw new Fault('network_before_connect','retry');return 'ok';};
  await f.core.tick();clock+=1000;await f.core.tick();
  const r=f.store.timing(m.id).replies[0];
  assert.equal(r.started_at,now);assert.equal(r.last_started_at,now+1200);assert.equal(r.accepted_at,now+1400);
  assert.equal(r.retries,1);assert.equal(r.durations_ms.last_send_to_accept,200);assert.equal(r.durations_ms.first_send_to_accept,1400);
  // Backward wall-clock steps are unknown durations, never negative latency.
  f.store.run('UPDATE replies SET accepted_at=? WHERE message_id=?',now-1,m.id);
  assert.equal(f.store.timing(m.id).replies[0].durations_ms.last_send_to_accept,null);
});

test('legacy schema migrates additively without inventing history or breaking old message inserts',t=>{
  const f=fixture(t),dir=path.join(f.dir,'legacy');fs.mkdirSync(dir,{mode:0o700});
  const db=new DatabaseSync(path.join(dir,'gateway.sqlite'));
  db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,platform TEXT,source_id TEXT,owner TEXT,conversation TEXT,text TEXT,media TEXT,context TEXT,created INTEGER,expires INTEGER);
    CREATE TABLE replies(id TEXT PRIMARY KEY,message_id TEXT,phase TEXT,payload TEXT,state TEXT,attempts INTEGER,due INTEGER,provider_id TEXT,error TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,sub_id TEXT,message_id TEXT,body TEXT,state TEXT,attempts INTEGER,due INTEGER,error TEXT);
    CREATE TABLE inbox(id TEXT PRIMARY KEY,platform TEXT,raw TEXT,state TEXT,error TEXT);
    INSERT INTO messages VALUES('old','qq','source','owner','owner','private','[]','',1,2);
    INSERT INTO replies VALUES('reply','old','ack','{}','accepted',1,99,'private-id',NULL);`);db.close();
  const store=new Store(dir);
  try{
    const d=store.timing('old');assert.equal(d.received_at,null);assert.equal(d.dot_read_at,null);assert.equal(d.replies[0].accepted_at,null);
    assert.equal(d.replies[0].durations_ms.last_send_to_accept,null);
    store.run("INSERT INTO messages VALUES('old-code-insert','qq','source2','owner','owner','private','[]','',3,4)");
    store.markRead('old',10);assert.equal(store.timing('old').dot_read_at,10);assert.equal(store.timing('old').received_at,null);
  }finally{store.close();}
});
