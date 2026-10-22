import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,accept,now,qqRaw} from './helpers.js';
import {Store} from '../src/store.js';
import {Core} from '../src/core.js';
import {Fault,parseJson} from '../src/util.js';
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
test('ack/final are immutable and idempotent with original route',async t=>{
  const f=fixture(t),m=await accept(f);assert.throws(()=>f.core.reply({message_id:m.id,phase:'final',text:'done'}),/ack_required/);
  const a=f.core.reply({message_id:m.id,phase:'ack',text:'received'});assert.deepEqual(f.core.reply({message_id:m.id,phase:'ack',text:'received'}),a);
  assert.throws(()=>f.core.reply({message_id:m.id,phase:'ack',text:'changed'}),/reply_conflict/);
  assert.throws(()=>f.core.reply({message_id:m.id,phase:'ack',text:'received',platform:'weixin'}));
  f.core.reply({message_id:m.id,phase:'final',text:'done'});const sends=[];f.adapters.qq.sendReply=async (message,r)=>{sends.push([message.platform,message.owner,r.phase]);return 'accepted-'+r.phase;};
  await f.core.tick();assert.deepEqual(sends,[['qq','qq-owner-stable','ack'],['qq','qq-owner-stable','final']]);assert.equal(f.store.pending().length,0);
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
