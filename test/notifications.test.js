import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fixture,accept,now,response} from './helpers.js';
import {RPC} from '../src/server.js';
import {Store,NOTIFICATION_LIMITS} from '../src/store.js';
import {Core} from '../src/core.js';
import {backupData,restoreData} from '../src/operations.js';
import {Fault} from '../src/util.js';

function setup(t){
  const f=fixture(t);f.c.mode='live';let clock=now;
  f.core.clock=f.adapters.qq.clock=f.adapters.weixin.clock=()=>clock;
  f.adapters.qq.token='synthetic-access-token';f.adapters.qq.tokenExpires=now+3600000;
  process.env.DOT_WEIXIN_TOKEN='synthetic-test-weixin-token';t.after(()=>delete process.env.DOT_WEIXIN_TOKEN);
  return {...f,rpc:new RPC(f.core,null),advance:ms=>{clock+=ms;}};
}
const notice=(platform='qq',key='reminder-1',context_mode='none')=>({platform,idempotency_key:key,text:'synthetic reminder',context_mode});

test('QQ owner notification uses active C2C adapter without inbound ID or ack/final',async t=>{
  const f=setup(t),sent=[];
  f.adapters.qq.send=async(url,o)=>{sent.push({url,body:JSON.parse(o.body)});return response({id:'platform-notice'});};
  const result=await f.rpc.dispatch('tools/call',{name:'notify_owner',arguments:notice()});
  assert.equal(result.isError,false);const n=result.structuredContent;assert.equal(n.state,'queued');
  assert.equal(f.store.one('SELECT count(*) n FROM messages').n,0);
  assert.deepEqual(f.core.notify(notice()),n);
  await f.core.tick();await f.core.tick();
  assert.equal(sent.length,1);assert.ok(sent[0].url.endsWith('/v2/users/qq-owner-stable/messages'));
  assert.deepEqual(sent[0].body,{content:'synthetic reminder',msg_type:0});
  const state=(await f.rpc.dispatch('tools/call',{name:'notification_status',arguments:{notification_id:n.id}})).structuredContent;
  assert.equal(state.state,'accepted');assert.equal(state.attempts,1);assert.equal(state.phone_delivery,'unknown');
  assert.equal(f.core.notify(notice()).state,'accepted');assert.equal(f.store.one('SELECT count(*) n FROM replies').n,0);
  assert.throws(()=>f.core.notify({...notice(),text:'changed'}),/notification_conflict/);
});

test('Weixin explicit none really omits context even with a saved context and expired reply',async t=>{
  const f=setup(t),m=await accept(f,'weixin'),sent=[];
  f.store.run('UPDATE messages SET expires=0 WHERE id=?',m.id);
  f.adapters.weixin.send=async(url,o)=>{sent.push({url,body:JSON.parse(o.body)});return response({ret:0});};
  const n=f.core.notify(notice('weixin'));await f.core.tick();
  assert.equal(sent.length,1);assert.ok(sent[0].url.endsWith('/ilink/bot/sendmessage'));
  const msg=sent[0].body.msg;
  assert.equal(msg.to_user_id,'wx-owner-stable');assert.equal(msg.client_id,n.id);
  assert.equal('context_token' in msg,false);assert.equal('message_id' in msg,false);
  assert.equal(f.core.notificationStatus(n.id).state,'accepted');
  assert.throws(()=>f.core.notify({platform:'weixin',idempotency_key:'no-mode',text:'hi'}),/context_mode_required/);
  // The passive path still enforces the old local reply window.
  f.core.reply({message_id:m.id,phase:'ack',text:'reply'});await f.core.tick();
  assert.equal(f.store.one('SELECT state FROM replies').state,'rejected');assert.equal(sent.length,1);
});

test('Weixin none works with no inbound rows; latest fails missing/expired context without falling back',async t=>{
  const f=setup(t),sent=[];f.adapters.weixin.send=async(_u,o)=>{sent.push(JSON.parse(o.body).msg);return response({ret:0});};
  const noContext=f.core.notify(notice('weixin','none'));await f.core.tick();
  assert.equal(f.core.notificationStatus(noContext.id).state,'accepted');assert.equal('context_token' in sent[0],false);
  f.advance(30000);const missing=f.core.notify(notice('weixin','missing','latest'));await f.core.tick();
  assert.equal(f.core.notificationStatus(missing.id).error,'weixin_context_unavailable');assert.equal(sent.length,1);
  const m=await accept(f,'weixin');f.advance(30000);
  const latest=f.core.notify(notice('weixin','latest','latest'));await f.core.tick();
  assert.equal(sent[1].context_token,'synthetic-context');assert.equal(f.core.notificationStatus(latest.id).state,'accepted');
  f.store.run('UPDATE messages SET expires=0 WHERE id=?',m.id);f.advance(30000);
  const expired=f.core.notify(notice('weixin','expired','latest'));await f.core.tick();
  assert.equal(f.core.notificationStatus(expired.id).error,'weixin_context_unavailable');assert.equal(sent.length,2);
});

test('notifications reject recipients, groups, media, missing binding, offline mode and owner changes',async t=>{
  const f=setup(t);
  for(const extra of [{receiver:'other'},{ownerId:'other'},{group:'x'},{media_id:'x'},{message_id:'x'},{context_token:'forged'}])assert.throws(()=>f.core.notify({...notice(),...extra}));
  assert.throws(()=>f.core.notify({...notice(),idempotency_key:'x\nsecret'}));
  assert.throws(()=>f.core.notify({...notice(),text:'  '}),/notification_text_required/);
  assert.throws(()=>f.core.notify(notice('qq','latest','latest')),/qq_context_mode_unsupported/);
  f.c.mode='offline';assert.throws(()=>f.core.notify(notice()),/notification_live_mode_required/);f.c.mode='live';
  const n=f.core.notify(notice());f.c.qq.ownerId='someone-else';
  assert.throws(()=>f.core.notify(notice('qq','another')),/binding_required/);
  await f.core.tick();assert.equal(f.store.notification(n.id).state,'cancelled');
  assert.throws(()=>f.core.notificationStatus(n.id),/binding_revoked/);
  f.c.weixin.enabled=false;assert.throws(()=>f.core.notify(notice('weixin')),/binding_required/);
});

test('QQ owner cannot change while fetching access token',async t=>{
  const f=setup(t);f.adapters.qq.accessToken=async()=>{f.c.qq.ownerId='other';return 'synthetic';};
  const n=f.core.notify(notice());await f.core.tick();
  assert.equal(f.store.notification(n.id).state,'rejected');assert.equal(f.store.notification(n.id).error,'binding_revoked');
});

test('QQ token preparation cannot send after the notification deadline',async t=>{
  const f=setup(t);f.adapters.qq.accessToken=async()=>{f.advance(NOTIFICATION_LIMITS.ttlMs+1);return 'synthetic';};
  const n=f.core.notify(notice());await f.core.tick();
  assert.equal(f.core.notificationStatus(n.id).state,'rejected');assert.equal(f.core.notificationStatus(n.id).error,'notification_expired');
});

test('durable rate limits cover retries and restart; another platform is not blocked',async t=>{
  const f=setup(t),calls=[];f.adapters.qq.sendNotification=async()=>{calls.push('qq');throw new Fault('qq_rate_limit','retry');};
  f.adapters.weixin.sendNotification=async()=>{calls.push('weixin');return 'ok';};
  const first=f.core.notify(notice());f.core.notify(notice('qq','second'));f.core.notify(notice('weixin'));
  await f.core.tick();assert.deepEqual(calls,['qq']);
  await f.core.tick();assert.deepEqual(calls,['qq','weixin']);
  f.store.recover();const restarted=new Core(f.store,f.c,f.media,f.adapters,f.core.clock);
  await restarted.tick();assert.equal(calls.length,2);f.advance(30000);await restarted.tick();
  assert.equal(f.store.notification(first.id).attempts,2);
  assert.equal(f.store.notification(first.id).retries,1);
  for(let i=0;i<18;i++)f.core.notify(notice('qq','limit-'+i));
  assert.throws(()=>f.core.notify(notice('qq','over-limit')),/notification_rate_limit/);
  assert.equal(f.core.notify(notice()).id,first.id);
});

test('both adapters preserve rejected versus uncertain and never blindly resend unknown outcomes',async t=>{
  for(const platform of ['qq','weixin']){
    const f=setup(t);let calls=0;
    f.adapters[platform].send=async()=>{calls++;return response({},503);};
    const n=f.core.notify(notice(platform));await f.core.tick();f.advance(30000);await f.core.tick();
    assert.equal(f.core.notificationStatus(n.id).state,'uncertain');assert.equal(calls,1);
    assert.equal(f.core.notify(notice(platform)).state,'uncertain');
    f.store.resolve(n.id,'cancelled');await f.core.tick();assert.equal(calls,1);
    f.adapters[platform].send=async()=>{calls++;return response({},403);};
    const denied=f.core.notify(notice(platform,'denied'));await f.core.tick();
    assert.equal(f.core.notificationStatus(denied.id).state,'rejected');
    const crash=f.core.notify(notice(platform,'crash'));f.store.run("UPDATE notifications SET state='sending' WHERE id=?",crash.id);
    f.store.recover();assert.equal(f.core.notificationStatus(crash.id).state,'uncertain');
    f.store.resolve(crash.id,'accepted');assert.equal(f.core.notificationStatus(crash.id).accepted_at,null);
  }
});

test('known retry budget and queue expiry are bounded',async t=>{
  const f=setup(t);let calls=0;f.adapters.qq.sendNotification=async()=>{calls++;throw new Fault('before_connect','retry');};
  const n=f.core.notify(notice());
  for(let i=0;i<NOTIFICATION_LIMITS.maxAttempts+2;i++){await f.core.tick();f.advance(300000);}
  assert.equal(calls,8);assert.equal(f.core.notificationStatus(n.id).state,'rejected');
  const expired=f.core.notify(notice('qq','expiry'));f.advance(NOTIFICATION_LIMITS.ttlMs);await f.core.tick();
  assert.equal(f.core.notificationStatus(expired.id).error,'notification_expired');assert.equal(calls,8);
});

test('restore quarantines pending proactive sends and diagnostics never return content or identity',async t=>{
  const f=setup(t);const n=f.core.notify(notice('weixin'));
  const backup=path.join(f.dir,'backup'),dest=path.join(f.dir,'restored');
  await backupData(f.dir,backup);await restoreData(backup,dest);
  const restored=new Store(dest);
  try{assert.equal(restored.notification(n.id).state,'uncertain');}finally{restored.close();}
  const status=await f.rpc.dispatch('tools/call',{name:'gateway_status',arguments:{}});
  const text=JSON.stringify([status.structuredContent,f.core.notificationStatus(n.id)]);
  for(const value of ['synthetic reminder','wx-owner-stable','wx-bot','synthetic-test-weixin-token','synthetic-context'])assert.equal(text.includes(value),false);
  assert.equal(status.structuredContent.notification_capabilities.weixin.experimental,true);
});
