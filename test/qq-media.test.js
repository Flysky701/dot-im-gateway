import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,qqRaw,wxRaw,now,response} from './helpers.js';
import {QQ} from '../src/adapters/qq.js';
import {QQ_ATTACHMENT_HOSTS} from '../src/adapters/qq-media.js';
import {pinnedOptions} from '../src/network.js';
import {safeMediaName} from '../src/media.js';
import {Fault} from '../src/util.js';

const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
const pdf=Buffer.from('%PDF-1.4\n%%EOF');
const file=(name,mime,bytes,url='https://multimedia.nt.qq.com.cn/download?fileid=signed')=>({filename:name,content_type:mime,size:bytes.length,url});
const prepared=t=>{const f=fixture(t);f.adapters.qq.media=f.media;f.adapters.qq.token='synthetic-token';f.adapters.qq.tokenExpires=now+3600000;return f;};

test('QQ text remains synchronous and temporary adapter without Media stays text-only',t=>{
  const f=prepared(t);assert.equal(f.adapters.qq.normalize(qqRaw()).text,'hello');
  const minimal=new QQ(f.c.qq,f.store,()=>assert.fail('network not expected'),()=>now),raw=qqRaw();raw.d.attachments=[file('a.txt','text/plain',Buffer.from('x'))];
  assert.throws(()=>minimal.normalize(raw),/qq_media_unsupported/);
});

test('QQ accepts owner attachment-only messages and preserves filenames for inspection',async t=>{
  const f=prepared(t),raw=qqRaw('files'),text=Buffer.from('第一行\n第二行');delete raw.d.content;
  raw.d.attachments=[file('../../报告.txt','text/plain',text),file('photo.png','image/png',png),file('报告.pdf','application/pdf',pdf),file('archive.zip','application/zip',Buffer.from([0x50,0x4b,3,4,0,255]))];
  const bytes=[text,png,pdf,Buffer.from([0x50,0x4b,3,4,0,255])];let index=0;
  f.adapters.qq.send=async(url,o)=>{assert.equal(url,raw.d.attachments[index].url);assert.equal(o.method,'GET');assert.deepEqual(o.headers,{});assert.deepEqual(o.hosts,QQ_ATTACHMENT_HOSTS);assert.equal(o.limit,4194304);return {status:200,headers:{},body:bytes[index++]};};
  const m=await f.adapters.qq.normalize(raw);f.store.accept(m,now);assert.equal(m.text,'');assert.equal(m.media.length,4);assert.ok(m.media.every(x=>x.status==='available'));
  const report=f.media.inspect(m.media[0].id,m.id);assert.equal(report.name,'报告.txt');assert.equal(report.mime,'text/plain');assert.equal(report.size,text.length);assert.equal(report.sha256,createHash('sha256').update(text).digest('hex'));assert.equal(report.preview,text.toString());assert.equal(report.content_status,'utf8_text');
  assert.equal(f.media.inspect(m.media[1].id,m.id).content_status,'image_not_decoded');assert.equal(f.media.inspect(m.media[2].id,m.id).content_status,'pdf_not_parsed');
  assert.equal(f.media.inspect(m.media[3].id,m.id).content_status,'binary_unparsed');assert.throws(()=>f.media.inspect(m.media[0].id,'wrong-message'),/media_not_found/);
});

test('QQ mixed message retains body and good files when another attachment fails',async t=>{
  const f=prepared(t),raw=qqRaw('partial'),bytes=Buffer.from('ok');raw.d.attachments=[file('ok.txt','text/plain',bytes),file('bad.pdf','application/pdf',bytes)];
  f.adapters.qq.send=async()=>({status:200,headers:{},body:bytes});const m=await f.adapters.qq.normalize(raw);
  assert.equal(m.text,'hello');assert.equal(m.media[0].status,'available');assert.deepEqual(m.media[1],{name:'bad.pdf',mime:'application/pdf',status:'failed',error:'media_type_mismatch'});
  assert.equal(f.store.one('SELECT count(*) n FROM media').n,1);
});

test('QQ download rejects external URLs, local paths and redirects without leaking URLs',async t=>{
  const f=prepared(t),bytes=Buffer.from('x');
  for(const url of ['https://evil.example/secret','file:///etc/passwd','https://127.0.0.1/','https://multimedia.nt.qq.com.cn.evil.example/x','https://user:pass@multimedia.nt.qq.com.cn/x']){
    const raw=qqRaw(url);raw.d.attachments=[file('a.txt','text/plain',bytes,url)];f.adapters.qq.send=async()=>assert.fail('blocked before network');
    const m=await f.adapters.qq.normalize(raw);assert.equal(m.media[0].status,'failed');assert.equal(m.media[0].error,'destination_denied');assert.ok(!JSON.stringify(m.media).includes(url));
  }
  const raw=qqRaw('redirect');raw.d.attachments=[file('a.txt','text/plain',bytes)];let requests=0;
  f.adapters.qq.send=async()=>{requests++;return {status:302,headers:{location:'https://evil.example/secret'},body:bytes};};
  const m=await f.adapters.qq.normalize(raw);assert.equal(requests,1);assert.equal(m.media[0].error,'attachment_redirect_rejected');
  await assert.rejects(pinnedOptions(raw.d.attachments[0].url,QQ_ATTACHMENT_HOSTS,async()=>[{address:'127.0.0.1',family:4}]),/non_public_destination/);
});

test('QQ reports unauthorized, oversized and unavailable files while retaining message text',async t=>{
  const f=prepared(t),bytes=Buffer.from('x');
  for(const [status,error] of [[403,'attachment_download_auth_required'],[503,'attachment_download_rejected']]){
    const raw=qqRaw(String(status));raw.d.attachments=[file('a.txt','text/plain',bytes)];f.adapters.qq.send=async()=>({status,body:bytes,headers:{}});
    const m=await f.adapters.qq.normalize(raw);assert.equal(m.text,'hello');assert.equal(m.media[0].error,error);
  }
  const raw=qqRaw('large');raw.d.attachments=[{...file('a.bin','application/octet-stream',bytes),size:4194305}];f.adapters.qq.send=async()=>assert.fail('oversized file requested');
  assert.equal((await f.adapters.qq.normalize(raw)).media[0].error,'media_size_limit');
  raw.d.attachments[0].size=2;f.adapters.qq.send=async()=>({status:200,headers:{},body:bytes});assert.equal((await f.adapters.qq.normalize(raw)).media[0].error,'media_length_mismatch');
});

test('QQ retries exact multimedia download authentication once and never authorizes other hosts or redirects',async t=>{
  const f=prepared(t),bytes=Buffer.from('ok'),raw=qqRaw('auth');raw.d.attachments=[file('a.txt','text/plain',bytes)];let requests=[];
  f.adapters.qq.send=async(url,o)=>{requests.push({url,headers:o.headers});return {status:requests.length===1?403:200,headers:{},body:bytes};};
  const m=await f.adapters.qq.normalize(raw);assert.equal(m.media[0].status,'available');assert.deepEqual(requests.map(r=>r.headers),[{}, {Authorization:'QQBot synthetic-token'}]);assert.equal(requests[0].url,requests[1].url);
  for(const url of ['https://multimedia.nt.qq.com/download','https://gchat.qpic.cn/download','https://multimedia.nt.qq.com.cn/other']){
    raw.d.attachments[0].url=url;requests=[];f.adapters.qq.send=async(_url,o)=>{requests.push(o);return {status:403,headers:{},body:bytes};};
    assert.equal((await f.adapters.qq.normalize(raw)).media[0].error,'attachment_download_auth_required');assert.deepEqual(requests.map(r=>r.headers),[{}]);
  }
  raw.d.attachments[0].url='https://multimedia.nt.qq.com.cn/download';requests=[];
  f.adapters.qq.send=async(_url,o)=>{requests.push(o);return {status:requests.length===1?401:302,headers:{location:'https://gchat.qpic.cn/download'},body:bytes};};
  assert.equal((await f.adapters.qq.normalize(raw)).media[0].error,'attachment_redirect_rejected');assert.equal(requests.length,2);
  requests=[];f.adapters.qq.send=async(_url,o)=>{requests.push(o);f.c.qq.ownerId='revoked';return {status:403,headers:{},body:bytes};};
  assert.equal((await f.adapters.qq.normalize(raw)).media[0].error,'binding_revoked');assert.equal(requests.length,1);
});

test('QQ names, UTF-8 preview and dedup remain bounded; Weixin type scope is unchanged',async t=>{
  const f=prepared(t),bytes=Buffer.from('甲'.repeat(2100)),saved=f.media.putQQ('qq-text',bytes,'text/plain','C:\\tmp\\报告.txt');
  assert.equal(saved.name,'报告.txt');assert.deepEqual(f.media.putQQ('qq-text',bytes,'text/plain','报告.txt'),saved);
  const summary=f.media.inspect(saved.id,'qq-text');assert.equal(summary.preview.length,2000);assert.equal(summary.preview_truncated,true);
  assert.equal(f.media.inspect(f.media.putQQ('invalid',Buffer.from([0xff,0xfe]),'text/plain','a.txt').id,'invalid').content_status,'text_encoding_unrecognized');
  assert.equal(safeMediaName('../CON.txt'),'_CON.txt');assert.equal(safeMediaName('\u202eabc\n.txt'),'_abc_.txt');
  assert.throws(()=>f.media.put('wx',Buffer.from('text'),'text/plain','a.txt'),/unsupported_media/);
  assert.throws(()=>f.media.putQQ('bad',Buffer.from('not PNG'),'image/png','photo.png'),/media_type_mismatch/);
  const raw=wxRaw();raw.item_list=[{type:4,file_item:{file_name:'a.txt',media:{encrypt_query_param:'x'}}}];await assert.rejects(f.adapters.weixin.normalize(raw),/pdf_only/);
});

test('QQ supplies useful extensions for omitted or extensionless filenames and preserves explicit names',t=>{
  const f=prepared(t);
  for(const [mime,bytes,extension] of [['application/octet-stream',png,'png'],['image/jpeg',Buffer.from([255,216,255,224]),'jpg'],['application/pdf',pdf,'pdf'],['text/plain',Buffer.from('text'),'txt'],['application/json',Buffer.from('{}'),'json'],['text/csv',Buffer.from('a,b'),'csv'],['application/octet-stream',Buffer.from([0,255]),'bin']]){
    assert.equal(f.media.putQQ('default-'+extension,bytes,mime).name,'attachment.'+extension);
    assert.equal(f.media.putQQ('named-'+extension,bytes,mime,'报告').name,'报告.'+extension);
  }
  assert.equal(f.media.putQQ('explicit',Buffer.from('text'),'text/plain','notes.custom').name,'notes.custom');
  assert.equal(f.media.putQQ('basename',Buffer.from('text'),'text/plain','pdf').name,'pdf.txt');
});

for(const [mime,bytes,type,name] of [['image/png',png,1,'photo.png'],['application/pdf',pdf,4,'report.pdf'],['text/plain',Buffer.from('answer'),4,'answer.txt']])test(`QQ uploads ${mime} then sends one media reply to original owner`,async t=>{
  const f=prepared(t),m=f.adapters.qq.normalize(qqRaw('out-'+type));f.store.accept(m,now);const saved=f.media.putQQ(m.id,bytes,mime,name),requests=[];
  f.adapters.qq.send=async(url,o)=>{requests.push({url,body:JSON.parse(o.body),headers:o.headers});return response(url.endsWith('/files')?{file_info:'opaque-file-info'}:{id:'sent-message'});};
  const id=await f.adapters.qq.sendReply(f.store.message(m.id),{phase:'final',seq:1,payload:JSON.stringify({media_id:saved.id})});assert.equal(id,'sent-message');
  assert.equal(requests.length,2);assert.ok(requests[0].url.endsWith('/v2/users/qq-owner-stable/files'));assert.deepEqual(requests[0].body,{file_data:bytes.toString('base64'),file_name:name,file_type:type,srv_send_msg:false});
  assert.deepEqual(requests[1].body,{msg_type:7,media:{file_info:'opaque-file-info'},msg_id:m.sourceId,msg_seq:1});
});

test('QQ merged-source media access, reply sequence, and upload/send retry boundaries',async t=>{
  const f=prepared(t),m=f.adapters.qq.normalize(qqRaw('reply'));f.store.accept(m,now);const saved=f.media.putQQ('source-message',Buffer.from('a'),'text/plain','a.txt');
  const route={...f.store.message(m.id),media_message_id:'source-message'},r={phase:'final',seq:2,payload:JSON.stringify({media_id:saved.id})};
  let uploads=0,sends=0;f.adapters.qq.send=async(url,o)=>{if(url.endsWith('/files')){uploads++;return response({},503);}sends++;return response({id:'sent'});};
  await assert.rejects(f.adapters.qq.sendReply(route,r),e=>e.kind==='retry');assert.equal(uploads,1);assert.equal(sends,0);
  f.adapters.qq.send=async url=>{if(url.endsWith('/files'))return response({file_info:'upload-ok'});return response({},500);};
  await assert.rejects(f.adapters.qq.sendReply(route,r),e=>e.kind==='uncertain');
  f.adapters.qq.send=async()=>{throw new Fault('network_failure','uncertain');};await assert.rejects(f.adapters.qq.sendReply(route,r),e=>e.kind==='retry');
  f.adapters.qq.send=async()=>assert.fail('wrong owner was sent');await assert.rejects(f.adapters.qq.sendReply({...route,owner:'other'},r),/owner_mismatch/);
});

test('QQ final-only text defaults to sequence 1; an accepted ack uses sequence 2',async t=>{
  const f=prepared(t),m=f.adapters.qq.normalize(qqRaw('seq'));f.store.accept(m,now);const seq=[];
  f.adapters.qq.send=async(_url,o)=>{seq.push(JSON.parse(o.body).msg_seq);return response({id:'sent'});};
  await f.adapters.qq.sendReply(f.store.message(m.id),{phase:'final',payload:'{"text":"done"}'});
  f.store.enqueue(m.id,'ack',{text:'processing'},now);f.store.run("UPDATE replies SET state='accepted' WHERE message_id=?",m.id);
  await f.adapters.qq.sendReply(f.store.message(m.id),{phase:'final',payload:'{"text":"done"}'});assert.deepEqual(seq,[1,2]);
});
