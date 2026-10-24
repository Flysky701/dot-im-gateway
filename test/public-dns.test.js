import test from 'node:test';
import assert from 'node:assert/strict';
import {publicDnsResolver} from '../src/public-dns.js';
import {pinnedOptions} from '../src/network.js';

const response=data=>({status:200,body:Buffer.from(JSON.stringify(data))});
test('public DNS uses fixed TLS endpoint and public bootstrap without app credentials',async()=>{
  let observed;
  const lookup=publicDnsResolver(async(url,options)=>{observed={url,options};return response({Status:0,Answer:[{type:5,data:'alias.example.com'},{type:1,data:'8.8.8.8'}]});});
  const p=await pinnedOptions('https://api.example.com/path',['api.example.com'],lookup);
  assert.equal(observed.url,'https://dns.alidns.com/resolve?name=api.example.com&type=A');
  assert.equal(observed.options.method,'GET');assert.equal(observed.options.timeout,5000);assert.equal(observed.options.limit,65536);
  assert.equal(observed.options.headers,undefined);assert.equal(observed.options.body,undefined);
  const dns=await pinnedOptions(observed.url,observed.options.hosts,observed.options.resolver);
  dns.options.lookup('ignored',{},(e,ip)=>assert.equal(ip,'223.5.5.5'));
  assert.equal(dns.options.servername,'dns.alidns.com');assert.equal(dns.options.rejectUnauthorized,true);
  p.options.lookup('ignored',{},(e,ip)=>assert.equal(ip,'8.8.8.8'));
  assert.equal(p.options.servername,'api.example.com');assert.equal(p.options.rejectUnauthorized,true);
});
test('public DNS cannot turn private, mixed, fake or malformed answers into allowed destinations',async()=>{
  for(const answer of [[{type:1,data:'127.0.0.1'}],[{type:1,data:'8.8.8.8'},{type:1,data:'10.0.0.1'}],[{type:1,data:'198.18.0.1'}],[{type:1,data:'not-an-ip'}]]){
    const lookup=publicDnsResolver(async()=>response({Status:0,Answer:answer}));
    await assert.rejects(pinnedOptions('https://api.example.com',['api.example.com'],lookup),/non_public_destination/);
  }
  let called=false;
  await assert.rejects(pinnedOptions('https://other.example.com',['api.example.com'],publicDnsResolver(async()=>{called=true;})),/destination_denied/);
  assert.equal(called,false);
});
test('public DNS fails closed on errors, invalid JSON, missing records and redirects',async()=>{
  for(const r of [{status:302,body:Buffer.from('')},{status:200,body:Buffer.from('invalid')},response({Status:3}),response({Status:0,Answer:[]}),response({Status:0,Answer:[{type:28,data:'::1'}]})]){
    await assert.rejects(publicDnsResolver(async()=>r)('api.example.com'),/public_dns_/);
  }
});
