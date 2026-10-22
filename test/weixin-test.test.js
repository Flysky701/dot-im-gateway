import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {loginWeixin,weixinOrigin,WeixinTestRPC,runWeixinTest} from '../src/weixin-private-session.js';
import {fixture,response,wxRaw,now,accept} from './helpers.js';
import {VERSION} from '../src/server.js';

const confirmed={status:'confirmed',bot_token:'synthetic-only-token-00000000000000',ilink_bot_id:'wx-bot',ilink_user_id:'wx-owner-stable',baseurl:'https://ilinkai.weixin.qq.com'};
test('official QR POST, hidden verification, redirect, confirmed identity; never first message',async()=>{
  const calls=[],events=[],replies=[{qrcode:'qr-secret',qrcode_img_content:'https://weixin.qq.com/synthetic-only'},{status:'scaned_but_redirect',redirect_host:'ilinkai.weixin.qq.com'},{status:'need_verifycode'},{status:'scaned'},confirmed];
  const result=await loginWeixin({emit:e=>events.push(e),verification:async()=>'123456',delay:async()=>{},send:async(url,o)=>{calls.push({url,...o});return response(replies.shift());}});
  assert.equal(result.ownerId,confirmed.ilink_user_id);assert.equal(calls[0].method,'POST');assert.deepEqual(JSON.parse(calls[0].body),{local_token_list:[]});
  assert.ok(calls[0].url.endsWith('get_bot_qrcode?bot_type=3'));assert.equal(calls[1].headers.Authorization,undefined);assert.equal(calls[1].headers.AuthorizationType,undefined);
  assert.ok(calls.some(c=>c.url.includes('verify_code=123456')));assert.ok(!calls.at(-1).url.includes('verify_code'));
  assert.ok(!JSON.stringify(events).includes(confirmed.bot_token));assert.ok(!JSON.stringify(events).includes('123456'));assert.ok(!JSON.stringify(events).includes(confirmed.ilink_user_id));
});
test('login fails closed for missing identity, foreign redirect, expired QR, or missing credential',async()=>{
  for(const last of [{...confirmed,ilink_user_id:undefined},{...confirmed,bot_token:undefined},{...confirmed,baseurl:'https://localhost/'},{status:'scaned_but_redirect',redirect_host:'evil.example'},{status:'expired'},{status:'binded_redirect'}]){
    let n=0;await assert.rejects(loginWeixin({emit:()=>{},verification:()=>assert.fail(),delay:async()=>{},send:async()=>response(n++?last:{qrcode:'q',qrcode_img_content:'synthetic'})}));
  }
  for(const origin of ['http://ilinkai.weixin.qq.com','https://weixin.qq.com.evil.example','https://127.0.0.1','https://user@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com/private','https://ilinkai.weixin.qq.com?x=1'])assert.throws(()=>weixinOrigin(origin));
});
test('only four Weixin text tools; no QQ, media, recipient override or event tools',async t=>{
  const f=fixture(t),rpc=new WeixinTestRPC(f.core),m=await accept(f,'weixin');
  const list=await rpc.dispatch('tools/list',{});assert.equal(list.tools.length,4);assert.equal(list.tools.find(x=>x.name==='reply').inputSchema.properties.media_id,undefined);
  for(const args of [{receiver:'other'},{media_id:'x'},{path:'/etc/passwd'}])await assert.rejects(rpc.dispatch('tools/call',{name:'reply',arguments:{message_id:m.id,phase:'ack',text:'hello',...args}}));
  await assert.rejects(rpc.dispatch('events/subscribe',{}));const q=await accept(f);await assert.rejects(rpc.dispatch('tools/call',{name:'read_message',arguments:{message_id:q.id}}),/weixin_only/);
});
const meta={'io.modelcontextprotocol/protocolVersion':VERSION,'io.modelcontextprotocol/clientInfo':{name:'weixin-offline',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
async function call(url,token,name,args={}){
  const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':VERSION,'Mcp-Method':'tools/call','Mcp-Name':name},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{_meta:meta,name,arguments:args}})});return r.json();
}
test('synthetic confirmed owner receives once, rejects others/media, reply uses inbound context, EOF closes',async t=>{
  const f=fixture(t),commands=new EventEmitter(),events=[],sent=[],dir=path.join(f.dir,'wx-session');let readyResolve,polled=false;
  const ready=new Promise(r=>{readyResolve=r;}),abort=new AbortController();t.after(()=>abort.abort());
  const token='b'.repeat(40),credential={token:confirmed.bot_token,ownerId:confirmed.ilink_user_id,botId:confirmed.ilink_bot_id,origin:confirmed.baseurl};
  const input={bearer:token,dataDir:dir,maximumSeconds:5};
  const running=runWeixinTest(input,{commands,signal:abort.signal,wall:()=>now,login:async()=>credential,emit:e=>{events.push(e);if(e.stage==='gateway_ready')readyResolve(e.url);},send:async(url,o)=>{
    assert.equal(o.headers.Authorization,'Bearer '+confirmed.bot_token);const body=JSON.parse(o.body);
    if(url.endsWith('getupdates')){const msgs=polled?[]:[wxRaw(),wxRaw(),{...wxRaw('other'),from_user_id:'other'},{...wxRaw('media'),item_list:[{type:2,image_item:{}}]}];polled=true;return response({ret:0,msgs,get_updates_buf:'cursor'});}
    assert.ok(url.endsWith('sendmessage'));sent.push(body.msg);return response({ret:0});
  }});
  const url=await ready;let messages=[];
  for(let i=0;i<30&&!messages.length;i++){const r=await call(url,token,'list_pending');messages=r.result.structuredContent.messages;await new Promise(r=>setTimeout(r,20));}
  assert.equal(messages.length,1);
  for(const phase of ['ack','final'])await call(url,token,'reply',{message_id:messages[0].id,phase,text:phase});
  for(let i=0;i<30&&sent.length<2;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(sent.length,2);assert.ok(sent.every(m=>m.to_user_id==='wx-owner-stable'&&m.context_token==='synthetic-context'));
  commands.emit('close');await running;await assert.rejects(call(url,token,'gateway_status'));assert.equal(credential.token,'');
  const bytes=Buffer.concat(fs.readdirSync(dir).map(n=>fs.readFileSync(path.join(dir,n))));assert.ok(!bytes.includes(Buffer.from(confirmed.bot_token)));assert.ok(!bytes.includes(Buffer.from(token)));
});
test('deadline aborts QR wait without creating data or listener',async t=>{
  const f=fixture(t),dir=path.join(f.dir,'no-bind'),commands=new EventEmitter(),events=[];
  await runWeixinTest({bearer:'b'.repeat(40),dataDir:dir,maximumSeconds:1},{commands,emit:e=>events.push(e),login:async({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true}))});
  assert.equal(fs.existsSync(dir),false);assert.ok(!events.some(e=>e.stage==='gateway_ready'));
});
