import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,accept} from './helpers.js';
import {publicIPv4,safeURL,pinnedOptions} from '../src/network.js';
import {validate} from '../src/config.js';
import {backupData,restoreData} from '../src/operations.js';
import {Store} from '../src/store.js';
import {lock} from '../src/runtime.js';
test('SSRF blocks local/private/link-local/multicast/reserved addresses and IPv6',()=>{
  for(const ip of ['127.0.0.1','10.1.1.1','192.168.1.1','169.254.169.254','100.64.0.1','172.31.2.1','0.0.0.0','224.0.0.1','192.0.2.1','198.18.0.1','203.0.113.1','::1','::ffff:127.0.0.1','2001:4860:4860::8888'])assert.equal(publicIPv4(ip),false,ip);assert.equal(publicIPv4('8.8.8.8'),true);
});
test('callback URL policy disallows ports, credentials, non-HTTPS, hostname tricks',()=>{
  for(const url of ['http://callback.example.com','https://callback.example.com:8443','https://callback.example.com.evil.test','https://user@callback.example.com','https://callback.example.com/#fragment','https://127.0.0.1'])assert.throws(()=>safeURL(url,['callback.example.com']));
});
test('connection pins public DNS resolution and rejects mixed DNS answers',async()=>{
  const p=await pinnedOptions('https://callback.example.com/path',['callback.example.com'],async()=>[{address:'8.8.8.8',family:4}]);
  p.options.lookup('ignored',{},(e,ip)=>assert.equal(ip,'8.8.8.8'));assert.equal(p.options.servername,'callback.example.com');assert.equal(p.options.agent,false);
  await assert.rejects(pinnedOptions('https://callback.example.com',['callback.example.com'],async()=>[{address:'8.8.8.8'},{address:'127.0.0.1'}]),/non_public/);
});
test('config refuses public listeners and extra credential fields',t=>{
  const f=fixture(t);validate(f.c);assert.throws(()=>validate({...f.c,host:'0.0.0.0'}));assert.throws(()=>validate({...f.c,apiKey:'not-allowed'}));
});
test('media rejects arbitrary paths, type/size violations, and cleanup protects unresolved sends',async t=>{
  const f=fixture(t),m=await accept(f,'weixin');assert.throws(()=>f.media.get('../../secrets',m.id));assert.throws(()=>f.media.put(m.id,Buffer.from('executable'),'application/pdf'));
  const b=Buffer.from('%PDF-1.4\n%%EOF'),file=f.media.put(m.id,b,'application/pdf');assert.throws(()=>f.media.get(file.id,'another-message'));
  f.store.run('UPDATE media SET created=0');f.core.reply({message_id:m.id,phase:'ack',text:'x'});assert.equal(f.media.clean(),0);f.store.run("UPDATE replies SET state='accepted'");assert.equal(f.media.clean(),1);
});
test('single-instance data lock rejects a second process handle',async t=>{
  const f=fixture(t),release=await lock(f.dir);await assert.rejects(lock(f.dir),/data_directory_in_use/);await release();const r=await lock(f.dir);await r();
});
test('backup/restore validates hashes, preserves media and quarantines pending replies',async t=>{
  const f=fixture(t),m=await accept(f,'weixin');const media=f.media.put(m.id,Buffer.from('%PDF-1.4\n%%EOF'),'application/pdf');f.core.reply({message_id:m.id,phase:'ack',text:'x'});
  const backup=path.join(f.dir,'backup'),restored=path.join(f.dir,'restored');await backupData(f.dir,backup);await restoreData(backup,restored);const s=new Store(restored);assert.equal(s.one('SELECT state FROM replies').state,'uncertain');assert.ok(fs.existsSync(path.join(restored,'media',media.id)));s.close();
  await assert.rejects(restoreData(backup,restored),/new_directory/);fs.appendFileSync(path.join(backup,'media',media.id),'tamper');await assert.rejects(restoreData(backup,path.join(f.dir,'bad-restore')),/hash_mismatch/);
});
