import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,qqRaw,wxRaw,accept,now,response} from './helpers.js';
import {aes,mediaKey} from '../src/adapters/weixin.js';
import {Frames,clientFrame} from '../src/adapters/qq-gateway.js';
const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
const pdf=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
test('QQ accepts only bound stable ID C2C text; attachments and groups rejected',t=>{
  const f=fixture(t);assert.equal(f.adapters.qq.normalize(qqRaw()).owner,f.c.qq.ownerId);
  for(const update of [{author:{user_openid:'other',nickname:'qq-owner-stable'}},{attachments:[{}]},{group_openid:'g'},{author:{user_openid:f.c.qq.ownerId,bot:true}},{message_reference:{}}]){const p=qqRaw();Object.assign(p.d,update);assert.throws(()=>f.adapters.qq.normalize(p));}
});
test('QQ uses pinned passive message ID and distinct phase sequence',async t=>{
  const f=fixture(t),m=await accept(f);f.adapters.qq.token='synthetic-token';f.adapters.qq.tokenExpires=now+3600000;const requests=[];f.adapters.qq.send=async(url,o)=>{requests.push({url,...JSON.parse(o.body)});return response({id:'server-id'});};
  f.core.reply({message_id:m.id,phase:'ack',text:'received'});f.core.reply({message_id:m.id,phase:'final',text:'done'});await f.core.tick();assert.deepEqual(requests.map(r=>r.msg_seq),[1,2]);assert.ok(requests.every(r=>r.msg_id==='q1'&&r.url.endsWith('/v2/users/qq-owner-stable/messages')));
});
test('QQ 5xx and malformed success are uncertain; 429 is retryable',async t=>{
  const f=fixture(t),m=await accept(f),r={id:'r',phase:'ack',payload:'{"text":"x"}'};f.adapters.qq.token='synthetic';f.adapters.qq.tokenExpires=now+3600000;
  for(const [status,kind] of [[500,'uncertain'],[429,'retry']]){f.adapters.qq.send=async()=>response({},status);await assert.rejects(f.adapters.qq.sendReply(f.store.message(m.id),r),e=>e.kind===kind);}
  f.adapters.qq.send=async()=>response({});await assert.rejects(f.adapters.qq.sendReply(f.store.message(m.id),r),e=>e.kind==='uncertain');
});
test('Weixin binds both owner and bot and ignores group/self traffic',t=>{
  const f=fixture(t);for(const patch of [{from_user_id:'other'},{to_user_id:'other'},{group_id:'g'},{message_type:2},{message_state:1}])assert.equal(f.adapters.weixin.authorized({...wxRaw(),...patch}),false);
});
test('Weixin polling persists batch and cursor together without storing other users',async t=>{
  const f=fixture(t);f.adapters.weixin.api=async()=>({ret:0,msgs:[wxRaw(),{...wxRaw('2'),from_user_id:'other'}],get_updates_buf:'cursor1'});await f.adapters.weixin.poll();assert.equal(f.store.get('weixin.cursor'),'cursor1');assert.equal(f.store.all('SELECT * FROM inbox').length,1);await f.core.tick();assert.equal(f.store.status().messages,1);
});
for(const [mime,bytes,type] of [['image/png',png,2],['application/pdf',pdf,4]])test(`Weixin ${mime} incoming encrypted CDN and outgoing upload/send protocol`,async t=>{
  const f=fixture(t),key=Buffer.alloc(16,9),raw=wxRaw();raw.item_list=[type===2?{type:2,image_item:{aeskey:key.toString('hex'),media:{encrypt_query_param:'encrypted-param'}}}:{type:4,file_item:{file_name:'report.pdf',len:String(bytes.length),media:{aes_key:Buffer.from(key.toString('hex')).toString('base64'),encrypt_query_param:'encrypted-param'}}}];
  f.adapters.weixin.send=async(url,o)=>{assert.ok(url.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/download?'));assert.equal(o.method,'GET');return {status:200,headers:{},body:aes(bytes,key)};};
  const m=await f.adapters.weixin.normalize(raw);f.store.accept(m,now);assert.equal(m.media[0].mime,mime);assert.deepEqual(f.media.get(m.media[0].id,m.id).data,bytes);
  let upload,sendBody,uploaded;
  f.adapters.weixin.api=async(endpoint,body)=>{if(endpoint==='getuploadurl'){upload=body;return {upload_param:'signed-upload'};}sendBody=body;return {ret:0,message_id:'18446744073709551615'};};
  f.adapters.weixin.send=async(url,o)=>{assert.ok(url.includes('/c2c/upload?'));uploaded=o.body;return {status:200,headers:{'x-encrypted-param':'download-ticket'},body:Buffer.alloc(0)};};
  const result=await f.adapters.weixin.sendReply(f.store.message(m.id),{id:'reply-synthetic',payload:JSON.stringify({media_id:m.media[0].id})});
  assert.equal(upload.media_type,type===2?1:3);assert.deepEqual(aes(uploaded,Buffer.from(upload.aeskey,'hex'),true),bytes);assert.equal(result,'18446744073709551615');assert.equal(sendBody.msg.to_user_id,f.c.weixin.ownerId);assert.equal(sendBody.msg.context_token,'synthetic-context');assert.equal(sendBody.msg.item_list.length,1);assert.equal(sendBody.msg.item_list[0].type,type);
});
test('AES fixture supports raw and hex-base64 keys, rejects padding/key errors',()=>{
  const key=Buffer.alloc(16,3),data=Buffer.alloc(32,1);assert.equal(aes(data,key).length,48);assert.deepEqual(aes(aes(data,key),key,true),data);assert.deepEqual(mediaKey({media:{aes_key:key.toString('base64')}}),key);assert.throws(()=>mediaKey({media:{aes_key:'eA=='}}));assert.throws(()=>aes(Buffer.alloc(17),key,true));
});
test('Weixin session expiration pauses polling and is never reported delivered',async t=>{
  const f=fixture(t);process.env.DOT_WEIXIN_TOKEN='synthetic-test-token';t.after(()=>delete process.env.DOT_WEIXIN_TOKEN);f.adapters.weixin.send=async()=>response({ret:-14});await assert.rejects(f.adapters.weixin.api('getupdates',{}),/session_expired/);assert.equal(f.adapters.weixin.pausedUntil,now+3600000);
});
test('WebSocket frame parser handles split packets, fragmentation, ping and masking',()=>{
  const frames=new Frames(),seen=[];frames.on('message',x=>seen.push(x));const b=Buffer.from('{"op":11}');const wire=Buffer.concat([Buffer.from([0x81,b.length]),b]);frames.feed(wire.subarray(0,3));frames.feed(wire.subarray(3));assert.deepEqual(seen,[{op:11}]);
  frames.feed(Buffer.concat([Buffer.from([1,5]),Buffer.from('{"op"')]));frames.feed(Buffer.concat([Buffer.from([128,4]),Buffer.from(':11}')]));assert.equal(seen.length,2);
  const masked=clientFrame('hello');assert.equal(masked[1]&128,128);const unmasked=Buffer.from(masked.subarray(6));for(let i=0;i<unmasked.length;i++)unmasked[i]^=masked[2+i%4];assert.equal(unmasked.toString(),'hello');assert.throws(()=>new Frames().feed(Buffer.from([0x81,0x80])));
});
