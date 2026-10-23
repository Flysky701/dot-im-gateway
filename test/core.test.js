import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,accept,now,qqRaw} from './helpers.js';
import {Store} from '../src/store.js';
import {Core} from '../src/core.js';
import {Fault,parseJson,hash,canonical} from '../src/util.js';
test('inbox and cursor commit atomically; duplicate packet survives restart once',async t=>{
  const f=fixture(t),raw=qqRaw();f.store.checkpoint('qq',[{key:'q1',raw}],'qq.seq','1');f.store.checkpoint('qq',[{key:'q1',raw}],'qq.seq','1');
  assert.equal(f.store.one('SELECT count(*) n FROM inbox').n,1);await f.core.tick();
  assert.equal(f.store.status().messages,1);f.store.close();const reopened=new Store(f.dir);assert.equal(reopened.status().messages,1);assert.equal(reopened.get('qq.seq'),'1');reopened.close();
});
test('transaction rollback cannot advance checkpoint',t=>{
  const f=fixture(t);assert.throws(()=>f.store.checkpoint('qq',[{key:'bad',raw:undefined}],'qq.seq','7'));assert.equal(f.store.get('qq.seq'),undefined);
});
test('stable owner binding rejects identity swap in existing state',t=>{
  const f=fixture(t);f.c.qq.ownerId='another';assert.throws(()=>new Core(f.store,f.c,f.media,f.adapters),/binding_changed/);
});
test('adding a platform keeps data; swapping a bound bot or owner does not',t=>{
  const f=fixture(t),c=structuredClone(f.c);
  f.store.run("DELETE FROM meta WHERE k LIKE 'binding%'");c.weixin.ownerId='';c.weixin.botId='';new Core(f.store,c,f.media,f.adapters);
  assert.ok(f.store.get('binding.qq'));assert.equal(f.store.get('binding.weixin'),undefined);
  c.weixin.ownerId='wx-owner-stable';c.weixin.botId='wx-bot';new Core(f.store,c,f.media,f.adapters);assert.ok(f.store.get('binding.weixin'));
  assert.throws(()=>new Core(f.store,{...c,weixin:{...c.weixin,botId:'other-bot'}},f.media,f.adapters),/binding_changed/);
  assert.throws(()=>new Core(f.store,{...c,qq:{...c.qq,appId:'other-app'}},f.media,f.adapters),/binding_changed/);
});
test('v0.1 combined binding migrates, including a platform added later',t=>{
  const f=fixture(t),c=f.c;
  const legacy=(q,w)=>hash(canonical([c.principal,...q,...w]));
  for(const [q,w,ok] of [[['qq-owner-stable','qq-app'],['wx-owner-stable','wx-bot'],true],[['qq-owner-stable','qq-app'],['',''],true],[['other','qq-app'],['',''],false]]){
    f.store.run("DELETE FROM meta WHERE k LIKE 'binding%'");f.store.set('binding',legacy(q,w));
    if(ok){new Core(f.store,c,f.media,f.adapters);assert.equal(f.store.get('binding'),undefined);assert.ok(f.store.get('binding.qq')&&f.store.get('binding.weixin'));}
    else assert.throws(()=>new Core(f.store,c,f.media,f.adapters),/binding_changed/);
  }
});
test('ack/final are immutable and idempotent with original route',async t=>{
  const f=fixture(t),m=await accept(f);
  const a=f.core.reply({message_id:m.id,phase:'ack',text:'received'});assert.deepEqual(f.core.reply({message_id:m.id,phase:'ack',text:'received'}),a);
  assert.throws(()=>f.core.reply({message_id:m.id,phase:'ack',text:'changed'}),/reply_conflict/);
  assert.throws(()=>f.core.reply({message_id:m.id,phase:'ack',text:'received',platform:'weixin'}));
  f.core.reply({message_id:m.id,phase:'final',text:'done'});const sends=[];f.adapters.qq.sendReply=async (message,r)=>{sends.push([message.platform,message.owner,r.phase]);return 'accepted-'+r.phase;};
  await f.core.tick();assert.deepEqual(sends,[['qq','qq-owner-stable','ack'],['qq','qq-owner-stable','final']]);assert.equal(f.store.pendingPage(undefined,now).messages.length,0);
});
test('unknown send result is not retried and blocks final',async t=>{
  const f=fixture(t),m=await accept(f);f.core.reply({message_id:m.id,phase:'ack',text:'received'});f.core.reply({message_id:m.id,phase:'final',text:'done'});
  let calls=0;f.adapters.qq.sendReply=async()=>{calls++;throw new Fault('lost_response','uncertain');};
  await f.core.tick();await f.core.tick();assert.equal(calls,1);assert.equal(f.store.publicMessage(m.id).replies[0].state,'uncertain');
});
test('recovery quarantines sending replies but requeues webhook sends',async t=>{
  const f=fixture(t),m=await accept(f);const r=f.core.reply({message_id:m.id,phase:'ack',text:'x'});f.store.run("UPDATE replies SET state='sending' WHERE id=?",r.id);f.store.recover();assert.equal(f.store.publicMessage(m.id).replies[0].state,'uncertain');
  f.store.resolve(r.id,'accepted');assert.equal(f.store.publicMessage(m.id).replies[0].state,'accepted');assert.throws(()=>f.store.resolve(r.id,'pending'));
});
test('definitely not sent retries with bounded backoff',async t=>{
  const f=fixture(t),m=await accept(f);f.core.reply({message_id:m.id,phase:'ack',text:'x'});f.adapters.qq.sendReply=async()=>{throw new Fault('preconnect','retry');};
  await f.core.tick();const r=f.store.one('SELECT * FROM replies');assert.equal(r.state,'pending');assert.ok(r.due>now);await f.core.tick();assert.equal(f.store.one('SELECT attempts FROM replies').attempts,1);
});
test('expired or revoked route never sends',async t=>{
  const f=fixture(t),m=await accept(f);f.core.reply({message_id:m.id,phase:'ack',text:'x'});f.store.run('UPDATE messages SET expires=0');await f.core.tick();assert.equal(f.store.one('SELECT state FROM replies').state,'rejected');
  f.c.qq.enabled=false;assert.throws(()=>f.core.reply({message_id:m.id,phase:'ack',text:'x'}),/binding_revoked/);
});
test('simultaneous tick calls cannot double-send',async t=>{
  const f=fixture(t),m=await accept(f);f.core.reply({message_id:m.id,phase:'ack',text:'x'});let count=0;
  f.adapters.qq.sendReply=async()=>{count++;await new Promise(r=>setTimeout(r,20));return 'id';};await Promise.all([f.core.tick(),f.core.tick()]);assert.equal(count,1);
});
test('uint64 numeric IDs preserve exact wire value without touching text',()=>{
  const d=parseJson('{"message_id":18446744073709551615,"text":"message_id:18446744073709551615","small":7}');assert.equal(d.message_id,'18446744073709551615');assert.equal(d.small,7);
});
test('more than ten blocked finals cannot starve a healthy conversation',async t=>{
  const f=fixture(t),blocked=[];
  for(let i=0;i<36;i++){
    const m=await accept(f,'qq','blocked-'+i),a=f.core.reply({message_id:m.id,phase:'ack',text:'ack'});
    f.core.reply({message_id:m.id,phase:'final',text:'final'});
    const state=['rejected','cancelled','uncertain'][i%3];f.store.run('UPDATE replies SET state=? WHERE id=?',state,a.id);blocked.push({m,a,state});
  }
  const healthy=await accept(f,'qq','healthy');for(const phase of ['ack','final'])f.core.reply({message_id:healthy.id,phase,text:phase});
  const sent=[];f.adapters.qq.sendReply=async(m,r)=>{sent.push([m.id,r.phase]);return 'accepted';};
  await f.core.tick();assert.deepEqual(sent,[[healthy.id,'ack'],[healthy.id,'final']]);
  for(const {m,state} of blocked)assert.equal(f.store.one("SELECT state FROM replies WHERE message_id=? AND phase='final'",m.id).state,state==='uncertain'?'pending':'cancelled');
  const uncertain=blocked.find(b=>b.state==='uncertain');f.store.resolve(uncertain.a.id,'accepted');await f.core.tick();
  assert.deepEqual(sent.at(-1),[uncertain.m.id,'final']);assert.equal(sent.length,3);
  f.store.run('UPDATE messages SET expires=0');await f.core.tick();assert.equal(sent.length,3);
  assert.equal(f.store.one("SELECT count(*) n FROM replies WHERE state='pending'").n,0);
  assert.equal(f.store.one("SELECT count(*) n FROM replies WHERE state='uncertain'").n,11);
});
test('disabled and retrying inbox rows cannot starve later messages; retries persist backoff',async t=>{
  const f=fixture(t);let calls=0;
  for(let i=0;i<15;i++)f.store.checkpoint('weixin',[{key:'disabled-'+i,raw:{}}],'weixin.cursor',String(i));
  for(let i=0;i<12;i++)f.store.checkpoint('qq',[{key:'retry-'+i,raw:qqRaw('retry-'+i)}],'qq.seq',String(i));
  f.store.checkpoint('qq',[{key:'healthy',raw:qqRaw('healthy')}],'qq.seq','13');
  f.c.weixin.enabled=false;const normalize=f.adapters.qq.normalize.bind(f.adapters.qq);
  f.adapters.qq.normalize=raw=>{if(raw.d.id.startsWith('retry-')){calls++;throw new Fault('temporary','retry');}return normalize(raw);};
  await f.core.tick();await f.core.tick();assert.equal(f.store.status().messages,1);assert.equal(calls,12);
  await f.core.tick();assert.equal(calls,12);assert.ok(f.store.all("SELECT * FROM inbox WHERE platform='qq' AND state='pending'").every(r=>r.due===now+1000&&r.attempts===1));
  f.core.clock=()=>now+1000;await f.core.tick();assert.equal(calls,22);
  assert.equal(f.store.one("SELECT due FROM inbox WHERE attempts=2").due,now+3000);
});
test('pending pages skip terminal, expired and disabled messages without hiding later work',async t=>{
  const f=fixture(t);
  for(let i=0;i<55;i++){const m=await accept(f,'qq','old-'+i);f.store.run('UPDATE messages SET expires=0 WHERE id=?',m.id);}
  const terminal=await accept(f,'qq','terminal'),ack=f.core.reply({message_id:terminal.id,phase:'ack',text:'ack'});f.store.run("UPDATE replies SET state='rejected' WHERE id=?",ack.id);
  for(let i=0;i<55;i++)await accept(f,'qq','active-'+i);
  await accept(f,'weixin','disabled');const first=f.store.pendingPage(undefined,now,['qq']);
  assert.equal(first.messages.length,50);assert.ok(first.next_cursor);
  const second=f.store.pendingPage(first.next_cursor,now,['qq']);assert.equal(second.messages.length,5);assert.equal(second.next_cursor,null);
  assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,55);
  assert.throws(()=>f.store.pendingPage('bad',now),/invalid_cursor/);
});
