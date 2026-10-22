import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fixture} from './helpers.js';
test('standalone offline CLI boots loopback and stops without external enrollment',async t=>{
  const f=fixture(t),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  f.c.port=port;f.c.dataDir=path.join(f.dir,'service-data');f.c.qq.enabled=false;f.c.weixin.enabled=false;f.c.allowSubscriptions=false;
  const config=path.join(f.dir,'config.json');fs.writeFileSync(config,JSON.stringify(f.c));
  const child=spawn(process.execPath,['bin/gateway.js','serve','--config',config],{env:{...process.env,DOT_GATEWAY_TOKEN:'synthetic-service-test-token-0000000000'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const stopped=new Promise(resolve=>child.once('exit',resolve));t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('startup_timeout')),10000);child.stdout.once('data',b=>{clearTimeout(timer);assert.equal(JSON.parse(b).mode,'offline');resolve();});child.once('exit',()=>{clearTimeout(timer);reject(new Error('startup_exit'));});});
  const health=await new Promise((resolve,reject)=>{http.get(`http://127.0.0.1:${port}/healthz`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve(JSON.parse(b)));}).on('error',reject);});assert.equal(health.mode,'offline');
  child.kill('SIGTERM');await Promise.race([stopped,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('shutdown_timeout')),5000);timer.unref();})]);
});
