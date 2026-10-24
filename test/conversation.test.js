import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,qqRaw,wxRaw,now,accept,signingSecret,response} from './helpers.js';
import {Events} from '../src/events.js';
import {RPC} from '../src/server.js';
import {Store} from '../src/store.js';
import {validate,example} from '../src/config.js';

function conversation(t){
  const f=fixture(t);let clock=now;
  f.core.clock=f.adapters.qq.clock=f.adapters.weixin.clock=()=>clock;
  const posts=[];
  const events=new Events(f.store,f.c,async(url,o)=>{posts.push(JSON.parse(o.body));return response({});},()=>clock);
  f.store.run('INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,1)','sub-batch',f.c.principal,'qq','https://callback.example.com/event',signingSecret,null,0,now+60000);
  async function incoming(id,text,time,platform='qq'){
    clock=now+time;const raw=platform==='qq'?qqRaw(id):wxRaw(id);
    if(platform==='qq'){raw.d.content=text;raw.d.timestamp=new Date(clock).toISOString();}
    else {raw.create_time_ms=clock;raw.item_list=[{type:1,text_item:{text}}];}
    f.store.checkpoint(platform,[{key:id,raw}],platform+'.cursor',id,clock);await f.core.tick();
    return f.store.one('SELECT id FROM messages WHERE platform=? AND source_id=?',platform,id).id;
  }
  return {...f,events,posts,incoming,time:value=>{clock=now+value;}};
}

test('normal final is sent once without ack; later ack cannot appear after the answer',async t=>{
  const f=fixture(t),m=await accept(f),sent=[];
  f.adapters.qq.sendReply=async(m,r)=>{sent.push({phase:r.phase,seq:r.seq});return 'ok';};
  const rpc=new RPC(f.core,null),args={message_id:m.id,text:'你好，有什么想聊的？'};
  assert.equal((await rpc.dispatch('tools/call',{name:'reply',arguments:args})).isError,false);
  assert.throws(()=>f.core.reply({...args,phase:'ack',text:'late'}),/final_already_queued/);
  await f.core.tick();await f.core.tick();
  assert.deepEqual(sent,[{phase:'final',seq:1}]);
  assert.equal(f.core.reply(args).state,'accepted');
});

test('three short messages yield one wakeup, ordered content and one reply to the latest source',async t=>{
  const f=conversation(t),a=await f.incoming('a','帮我看一下',0);
  await f.events.tick();assert.equal(f.posts.length,0);
  const b=await f.incoming('b','这个方案',600),c=await f.incoming('c','哪里可以改',1200);
  f.time(3199);await f.events.tick();assert.equal(f.posts.length,0);
  assert.equal(f.store.pendingPage(undefined,now+3199).messages.length,0);
  const rpc=new RPC(f.core,null);
  assert.equal((await rpc.dispatch('tools/call',{name:'read_message',arguments:{message_id:a}})).isError,true);
  f.time(3200);await f.events.tick();assert.equal(f.posts.length,1);
  assert.equal(f.posts[0].data.message_id,a);
  const read=(await rpc.dispatch('tools/call',{name:'read_message',arguments:{message_id:b}})).structuredContent;
  assert.equal(read.id,a);assert.equal(read.text,'帮我看一下\n这个方案\n哪里可以改');assert.deepEqual(read.message_ids,[a,b,c]);
  const sends=[];f.adapters.qq.sendReply=async(m,r)=>{sends.push([m.source_id,r.seq]);return 'ok';};
  f.core.reply({message_id:c,text:'可以改这几个地方……'});await f.core.tick();
  assert.deepEqual(sends,[['c',1]]);assert.equal(f.store.pendingPage(undefined,now+3200).messages.length,0);
  assert.equal(f.store.publicMessage(b).replies[0].state,'accepted');
});

test('batch window is bounded, late input never changes a dispatched or read turn',async t=>{
  const f=conversation(t),a=await f.incoming('a','0',0);
  for(let i=1;i<=5;i++)await f.incoming('q'+i,String(i),i*1500);
  f.time(8000);await f.events.tick();assert.equal(f.posts.length,1);
  const b=await f.incoming('b','下一轮',8100);
  assert.equal(f.store.publicMessage(a).batch_count,6);assert.equal(f.store.publicMessage(b).batch_count,1);
  f.time(10100);f.store.markRead(b,now+10100);
  const c=await f.incoming('c','不改上一轮',10101);assert.equal(f.store.publicMessage(c).batch_count,1);
});

test('platforms, commands and long messages are separate; gaps and duplicate packets do not lose input',async t=>{
  const f=conversation(t),a=await f.incoming('a','短句',0);
  const w=await f.incoming('w','微信',400,'weixin');assert.equal(f.store.publicMessage(w).batch_count,1);
  const cmd=await f.incoming('command','/status',500),long=await f.incoming('long','长'.repeat(1001),700);
  assert.equal(f.store.publicMessage(cmd).batch_count,1);assert.equal(f.store.publicMessage(long).batch_count,1);
  await f.events.tick();assert.deepEqual(f.posts.map(p=>p.data.message_id),[a,cmd,long]);
  const b=await f.incoming('b','隔开',3000);assert.equal(f.store.publicMessage(a).batch_count,1);
  await f.incoming('b','隔开',3100);assert.equal(f.store.publicMessage(b).batch_count,1);
  assert.equal(f.store.status().messages,5);
});

test('collecting batch survives restart without inventing new IDs or duplicate events',async t=>{
  const f=conversation(t),a=await f.incoming('a','先说',0);await f.incoming('b','再说',500);
  f.store.close();const reopened=new Store(f.dir);
  try{assert.equal(reopened.publicMessage(a).text,'先说\n再说');assert.equal(reopened.all('SELECT * FROM events').length,1);assert.equal(reopened.pendingPage(undefined,now+2500).messages.length,1);}
  finally{reopened.close();}
});

test('existing configs inherit debounce defaults; zero disables waiting and invalid ranges fail',()=>{
  const old=structuredClone(example);delete old.conversation;assert.deepEqual(validate(old).conversation,{debounceMs:2000,maxWaitMs:8000});
  assert.equal(validate({...old,conversation:{debounceMs:0,maxWaitMs:0}}).conversation.debounceMs,0);
  assert.throws(()=>validate({...old,conversation:{debounceMs:2000,maxWaitMs:1000}}),/invalid_batch_wait/);
});
