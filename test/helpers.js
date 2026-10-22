import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {example} from '../src/config.js';
import {Store} from '../src/store.js';
import {Media} from '../src/media.js';
import {Core} from '../src/core.js';
import {QQ} from '../src/adapters/qq.js';
import {Weixin} from '../src/adapters/weixin.js';
export const now=1792640000000;
export const signingSecret='whsec_'+Buffer.alloc(32,7).toString('base64');
export function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-im-test-'));fs.chmodSync(dir,0o700);
  const c=structuredClone(example);c.dataDir=dir;c.qq.enabled=true;c.qq.ownerId='qq-owner-stable';c.qq.appId='qq-app';c.weixin.enabled=true;c.weixin.ownerId='wx-owner-stable';c.weixin.botId='wx-bot';c.callbackHosts=['callback.example.com'];c.allowSubscriptions=true;
  const store=new Store(dir),media=new Media(store,c);const send=async()=>{throw new Error('unexpected_network');};
  const adapters={qq:new QQ(c.qq,store,send,()=>now),weixin:new Weixin(c.weixin,store,media,send,()=>now)};
  const core=new Core(store,c,media,adapters,()=>now);
  t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});return {dir,c,store,media,adapters,core};
}
export function qqRaw(id='q1'){return {op:0,t:'C2C_MESSAGE_CREATE',s:1,id:'event-'+id,d:{id,author:{user_openid:'qq-owner-stable'},content:'hello',timestamp:new Date(now).toISOString()}};}
export function wxRaw(id='18446744073709551615'){return {message_id:id,from_user_id:'wx-owner-stable',to_user_id:'wx-bot',message_type:1,message_state:2,create_time_ms:now,context_token:'synthetic-context',item_list:[{type:1,text_item:{text:'hello'}}]};}
export async function accept(f,platform='qq',id){const m=await f.adapters[platform].normalize(platform==='qq'?qqRaw(id):wxRaw(id));f.store.accept(m,now);return m;}
export const response=(data,status=200,headers={})=>({status,headers,body:Buffer.from(JSON.stringify(data))});
