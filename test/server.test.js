import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {fixture,accept,now,response} from './helpers.js';
import {RPC,makeServer,VERSION} from '../src/server.js';
import {Events} from '../src/events.js';
const token='synthetic-local-loopback-test-token-000000';
const meta={'io.modelcontextprotocol/protocolVersion':VERSION,'io.modelcontextprotocol/clientInfo':{name:'offline-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
async function setup(t){
  const f=fixture(t),events=new Events(f.store,f.c,async(u,o)=>response({challenge:JSON.parse(o.body).challenge}),()=>now),rpc=new RPC(f.core,events),server=makeServer(rpc,token);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return {...f,events,rpc,port:server.address().port};
}
function call(port,method,params={},headers={}){
  const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method,params:{_meta:meta,...params}}));
  return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':VERSION,'Mcp-Method':method,...(params.name?{'Mcp-Name':params.name}:{}),...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(body);});
}
test('real loopback HTTP discovers MCP 2.0, lists tools and rejects auth/origin/header mismatch',async t=>{
  const f=await setup(t),d=await call(f.port,'server/discover');assert.equal(d.status,200);assert.deepEqual(d.body.result.supportedVersions,[VERSION]);assert.equal(d.body.result.resultType,'complete');
  assert.equal((await call(f.port,'tools/list')).body.result.tools.length,9);
  assert.equal((await call(f.port,'tools/list',{}, {Authorization:'Bearer wrong'})).status,401);
  assert.equal((await call(f.port,'tools/list',{}, {Origin:'https://evil.test'})).status,403);
  assert.equal((await call(f.port,'tools/list',{}, {'Mcp-Method':'tools/call'})).status,400);
  assert.equal((await call(f.port,'unknown')).status,404);
});
test('loopback request -> queued ack/final -> mock provider status, no real dot',async t=>{
  const f=await setup(t),m=await accept(f);const sent=[];f.adapters.qq.sendReply=async(msg,r)=>{sent.push(r.phase);return 'mock-'+r.phase;};
  const read=await call(f.port,'tools/call',{name:'read_message',arguments:{message_id:m.id}});assert.equal(read.body.result.structuredContent.text,'hello');
  for(const phase of ['ack','final']){const r=await call(f.port,'tools/call',{name:'reply',arguments:{message_id:m.id,phase,text:phase}});assert.equal(r.body.result.structuredContent.state,'pending');}
  await f.core.tick();assert.deepEqual(sent,['ack','final']);const done=await call(f.port,'tools/call',{name:'read_message',arguments:{message_id:m.id}});assert.ok(done.body.result.structuredContent.replies.every(r=>r.state==='accepted'));
});
test('Mcp-Name decodes base64 UTF-8 and rejects malformed or mismatched headers',async t=>{
  const f=await setup(t),params={name:'gateway_status',arguments:{}};
  const encoded='=?base64?'+Buffer.from(params.name).toString('base64')+'?=';
  assert.equal((await call(f.port,'tools/call',params,{'Mcp-Name':encoded})).status,200);
  for(const header of ['=?base64?%%%?=','=?base64?/w==?=','other-tool']){
    const r=await call(f.port,'tools/call',params,{'Mcp-Name':header});assert.equal(r.body.error.code,-32020);
  }
  const missing=await call(f.port,'tools/list',{}, {'MCP-Protocol-Version':''});assert.equal(missing.body.error.code,-32020);
  const version=await call(f.port,'tools/list',{_meta:{...meta,'io.modelcontextprotocol/protocolVersion':'2025-11-25'}},{'MCP-Protocol-Version':'2025-11-25'});assert.equal(version.body.error.code,-32022);
});
test('media tools expose opaque handles, never raw paths or secrets',async t=>{
  const f=await setup(t),m=await accept(f,'weixin');const b=Buffer.from('%PDF-1.4\n%%EOF');
  const put=await f.rpc.dispatch('tools/call',{name:'put_media',arguments:{message_id:m.id,mime:'application/pdf',data_base64:b.toString('base64')}});assert.equal(put.isError,false);
  const again=await f.rpc.dispatch('tools/call',{name:'put_media',arguments:{message_id:m.id,mime:'application/pdf',data_base64:b.toString('base64')}});assert.equal(again.structuredContent.id,put.structuredContent.id);
  const read=await f.rpc.dispatch('tools/call',{name:'read_media',arguments:{message_id:m.id,media_id:put.structuredContent.id}});assert.equal(read.content[0].resource.blob,b.toString('base64'));
  assert.ok(!JSON.stringify(f.store.publicMessage(m.id)).includes('synthetic-context'));
});
