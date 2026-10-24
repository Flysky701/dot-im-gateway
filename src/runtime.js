import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from './store.js';
import {Media} from './media.js';
import {Core} from './core.js';
import {Events} from './events.js';
import {QQ} from './adapters/qq.js';
import {QQGateway} from './adapters/qq-gateway.js';
import {Weixin} from './adapters/weixin.js';
import {RPC,makeServer} from './server.js';
import {request} from './network.js';
import {secret,privateDir} from './config.js';
import {ensure,Fault,pause} from './util.js';
// OS-owned lock, released on crash. Linux production uses an abstract Unix socket.
export async function lock(dir){
  privateDir(dir);const {hash}=await import('./util.js');
  const name=process.platform==='linux'?'\0dot-im-'+hash(path.resolve(dir)):process.platform==='win32'?'\\\\.\\pipe\\dot-im-'+hash(path.resolve(dir)):path.join(dir,'service.lock');
  const server=net.createServer(s=>s.end());await new Promise((resolve,reject)=>{server.once('error',()=>reject(new Fault('data_directory_in_use')));server.listen(name,resolve);});return ()=>new Promise(resolve=>server.close(resolve));
}
export async function serve(config){
  const token=secret(config.tokenEnv);ensure(token.length>=32,'strong_gateway_token_required');
  if(config.mode==='live')for(const p of ['qq','weixin'])if(config[p].enabled)secret(p==='qq'?config.qq.secretEnv:config.weixin.tokenEnv);
  const release=await lock(config.dataDir);let store,server,gateway;let stopped=false;const jobs=[];const shutdown=new AbortController();
  try{
    store=new Store(config.dataDir);store.recover();const media=new Media(store,config);
    const send=config.mode==='live'?request:async()=>{throw new Fault('offline_network_disabled');};
    const adapters={qq:new QQ(config.qq,store,send,Date.now,media),weixin:new Weixin(config.weixin,store,media,send)};
    const core=new Core(store,config,media,adapters),events=new Events(store,config,send);
    server=makeServer(new RPC(core,events),token);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
    fs.writeFileSync(path.join(config.dataDir,'service.pid'),String(process.pid),{mode:0o600});
    store.audit('service_started');
    const loop=async(fn,interval,code)=>{let failures=0;while(!stopped){try{await fn();failures=0;}catch{store.audit(code);failures++;}if(!stopped)await delay(Math.min(60000,interval*2**Math.min(failures,6)),undefined,{signal:shutdown.signal}).catch(()=>{});}};
    jobs.push(loop(async()=>{if(config.mode==='live'){await core.tick();await events.tick();}},1000,'worker_failed'));
    jobs.push(loop(()=>media.clean(),60000,'media_cleanup_failed'));
    if(config.mode==='live'&&config.weixin.enabled)jobs.push(loop(()=>adapters.weixin.poll(),1000,'weixin_poll_failed'));
    if(config.mode==='live'&&config.qq.enabled){gateway=new QQGateway(adapters.qq,store,config.qq.gatewayHosts);jobs.push(gateway.run());}
    console.log(JSON.stringify({event:'listening',host:config.host,port:config.port,mode:config.mode}));
    await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
  }finally{
    stopped=true;shutdown.abort();gateway?.stop();if(server)await new Promise(resolve=>server.close(resolve));
    await Promise.allSettled(jobs);if(store){store.audit('service_stopped');store.close();}await release();
  }
}
