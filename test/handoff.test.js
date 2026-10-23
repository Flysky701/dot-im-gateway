import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setImmediate as next} from 'node:timers/promises';
import {example} from '../src/config.js';
import {hostAllowed,safeURL} from '../src/network.js';
import {planHandoff,envText,parseEnv,tunnelUnit,createHandoff,safePrefix,DEFAULT_CALLBACK_HOSTS} from '../src/handoff.js';
import {Connector,connectionInput} from '../src/connector.js';
import {Fault} from '../src/util.js';

const tunnel={tunnelId:'tunnel_synthetic',organizationId:'org-synthetic',runtimeKey:'synthetic-tunnel-key-only'};
const qq={platform:'qq',...tunnel,qq:{appId:'qq-app',secret:'synthetic-qq-secret-only',ownerId:'qq-owner-stable'}};
const wx={platform:'weixin',...tunnel,weixin:{token:'synthetic-weixin-token',botId:'wx-bot@im.bot',ownerId:'wx-owner-stable',origin:'https://ilinkai.weixin.qq.com'}};
const config=()=>({...structuredClone(example),dataDir:'/srv/dot/data'});

test('callback host suffix entries match subdomains only',()=>{
  const hosts=['chatgpt.com','.openai.com'];
  for(const h of ['chatgpt.com','a.openai.com','x.y.openai.com'])assert.equal(hostAllowed(h,hosts),true,h);
  for(const h of ['openai.com','evil-openai.com','openai.com.evil','xopenai.com','a.chatgpt.com','chatgpt.com.evil'])assert.equal(hostAllowed(h,hosts),false,h);
  assert.equal(hostAllowed('a.b',['.']),false);
  assert.equal(safeURL('https://hooks.openai.com/x',DEFAULT_CALLBACK_HOSTS).hostname,'hooks.openai.com');
  for(const raw of ['https://evil-openai.com/x','https://openai.com.evil/x','http://chatgpt.com/x','https://chatgpt.com:8443/x'])assert.throws(()=>safeURL(raw,DEFAULT_CALLBACK_HOSTS));
});

test('environment files round-trip and reject characters systemd cannot keep verbatim',()=>{
  const env=new Map([['A','x y$z"\\`'],['B_2','plain']]);
  assert.deepEqual([...parseEnv(envText(env))],[...env]);
  assert.equal(parseEnv('# c\nX="a\\"b"\nbad line\n').get('X'),'a"b');
  for(const v of ["it's",'a\nb','a\rb','a\0b',''])assert.throws(()=>envText(new Map([['K',v]])),/unsupported_secret_characters/);
  assert.throws(()=>envText(new Map([['lower','x']])));
});

test('handoff plan enables the platform, events and keeps an existing service token',()=>{
  const p=planHandoff(qq,{config:config(),runtimeEnv:new Map([['DOT_GATEWAY_TOKEN','k'.repeat(40)]]),random:()=>'unused'});
  assert.equal(p.config.mode,'live');assert.equal(p.config.allowSubscriptions,true);
  assert.deepEqual(p.config.callbackHosts,DEFAULT_CALLBACK_HOSTS);
  assert.equal(p.config.qq.enabled,true);assert.equal(p.config.qq.ownerId,'qq-owner-stable');assert.equal(p.config.qq.appId,'qq-app');
  assert.deepEqual(p.config.qq.gatewayHosts,['api.bot.qq.com','api.sgroup.qq.com']);
  assert.equal(p.runtimeEnv.get('DOT_GATEWAY_TOKEN'),'k'.repeat(40));assert.equal(p.runtimeEnv.get('DOT_QQ_SECRET'),'synthetic-qq-secret-only');
  assert.equal(p.tunnelEnv.get('DOT_MCP_AUTH'),'Bearer '+'k'.repeat(40));assert.equal(p.tunnelEnv.get('CONTROL_PLANE_TUNNEL_ID'),'tunnel_synthetic');
  assert.equal(JSON.stringify(p.config).includes('synthetic-qq-secret-only'),false);
  // A short or missing token is replaced; Weixin is added next to an existing QQ binding.
  const w=planHandoff({platform:'weixin',weixin:wx.weixin},{config:p.config,runtimeEnv:new Map([['DOT_GATEWAY_TOKEN','short']]),tunnelEnv:p.tunnelEnv,random:()=>'r'.repeat(64)});
  assert.equal(w.runtimeEnv.get('DOT_GATEWAY_TOKEN'),'r'.repeat(64));assert.equal(w.config.qq.ownerId,'qq-owner-stable');
  assert.equal(w.config.weixin.botId,'wx-bot@im.bot');assert.equal(w.config.weixin.apiHost,'ilinkai.weixin.qq.com');
  assert.equal(w.tunnelEnv.get('CONTROL_PLANE_API_KEY'),'synthetic-tunnel-key-only');assert.equal(w.tunnelEnv.get('DOT_MCP_AUTH'),'Bearer '+'r'.repeat(64));
  // Callback hosts are merged without duplicates.
  assert.deepEqual(planHandoff(qq,{config:{...config(),callbackHosts:['hooks.example.com','chatgpt.com']}}).config.callbackHosts,['hooks.example.com','chatgpt.com','.chatgpt.com','openai.com','.openai.com']);
});

test('handoff plan fails closed for another owner, missing Tunnel settings or incomplete data',()=>{
  const bound=planHandoff(qq,{config:config()}).config;
  assert.throws(()=>planHandoff({...qq,qq:{...qq.qq,ownerId:'someone-else'}},{config:bound}),/different_owner_requires_new_data_directory/);
  assert.throws(()=>planHandoff({...qq,qq:{...qq.qq,appId:'other-app'}},{config:bound}),/different_owner_requires_new_data_directory/);
  assert.equal(planHandoff(qq,{config:bound}).config.qq.ownerId,'qq-owner-stable');
  assert.throws(()=>planHandoff({platform:'qq',qq:qq.qq},{config:config()}),/tunnel_settings_required/);
  assert.throws(()=>planHandoff({...qq,tunnelId:'bad id'},{config:config()}),/invalid_tunnel_settings/);
  assert.throws(()=>planHandoff({platform:'qq',...tunnel},{config:config()}),/handoff_incomplete/);
  assert.throws(()=>planHandoff({platform:'other'},{config:config()}),/platform_required/);
});

test('handoff prefixes and units stay inside reviewed absolute paths',()=>{
  for(const p of ['relative/x','/a','/srv/../etc','/srv/a b','/srv/a;rm'])assert.throws(()=>safePrefix(p),/unsafe_prefix/);
  assert.equal(safePrefix('/home/u/.local/lib/dot-im-gateway'),'/home/u/.local/lib/dot-im-gateway');
  const unit=tunnelUnit('/srv/dot/gw',8788);
  assert.match(unit,/^# Managed by dot-im-gateway handoff for prefix=\/srv\/dot\/gw\n/);
  assert.match(unit,/--mcp.server-url http:\/\/127.0.0.1:8788\/mcp/);assert.match(unit,/Restart=always/);
  assert.match(unit,/EnvironmentFile=\/srv\/dot\/gw\/tunnel-runtime.env/);assert.equal(unit.includes('Bearer'),false);
});

function installation(t,{tunnelEnv=''}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dot-im-handoff-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const home=path.join(root,'home'),prefix=path.join(root,'gw'),release=path.join(prefix,'releases/r1');
  fs.mkdirSync(release,{recursive:true});fs.mkdirSync(path.join(home,'.config/systemd/user'),{recursive:true});
  fs.writeFileSync(path.join(prefix,'.dot-im-gateway'),'1\n');fs.symlinkSync(release,path.join(prefix,'current'));
  fs.writeFileSync(path.join(prefix,'config.json'),JSON.stringify({...config(),dataDir:path.join(prefix,'data')}));
  fs.writeFileSync(path.join(home,'.config/systemd/user/dot-im-gateway.service'),`[Service]\nWorkingDirectory=${prefix}/current\nEnvironmentFile=${prefix}/runtime.env\n`);
  if(tunnelEnv)fs.writeFileSync(path.join(prefix,'tunnel-runtime.env'),tunnelEnv,{mode:0o600});
  const calls=[],active=new Set(['dot-im-gateway.service']);
  const systemctl=(...args)=>{calls.push(args.join(' '));if(args[0]==='is-active')return active.has(args.at(-1))?0:3;if(args[0]==='stop')active.delete(args[1]);if(['start','restart'].includes(args[0]))active.add(args[1]);return 0;};
  const probes=[];
  const probe=async url=>{probes.push(url);return url.endsWith('/healthz')?{status:200,body:JSON.stringify({ok:true,mode:'live'})}:{status:200,body:'ok'};};
  const make=extra=>createHandoff({prefix,home,tunnelBinary:Buffer.from('#!/bin/sh\n'),systemctl,probe,linger:()=>false,random:()=>'t'.repeat(64),pause:async()=>{},deadlineMs:1000,...extra});
  return {root,home,prefix,calls,active,probes,make};
}
const mode=f=>fs.statSync(f).mode&0o777;

test('handoff writes private files, a marked Tunnel unit and starts both services',{skip:process.platform==='win32'},async t=>{
  const s=installation(t),h=s.make();
  assert.deepEqual(h.summary(),{installed:true,tunnelSaved:false,bound:{qq:false,weixin:false}});
  await h.prepare();assert.equal(s.active.has('dot-im-gateway.service'),false);
  const result=await h.commit(qq);
  assert.deepEqual(result,{service:'running',platform:'qq',events:'enabled',autostart:'enabled',linger:false});
  for(const f of ['runtime.env','tunnel-runtime.env','config.json'])assert.equal(mode(path.join(s.prefix,f)),0o600,f);
  assert.equal(mode(path.join(s.prefix,'bin/tunnel-client')),0o700);
  const runtime=parseEnv(fs.readFileSync(path.join(s.prefix,'runtime.env'),'utf8'));
  assert.equal(runtime.get('DOT_QQ_SECRET'),'synthetic-qq-secret-only');assert.equal(runtime.get('DOT_GATEWAY_TOKEN'),'t'.repeat(64));
  const saved=JSON.parse(fs.readFileSync(path.join(s.prefix,'config.json'),'utf8'));
  assert.equal(saved.mode,'live');assert.equal(saved.qq.ownerId,'qq-owner-stable');assert.equal(saved.allowSubscriptions,true);
  const unit=fs.readFileSync(path.join(s.home,'.config/systemd/user/dot-im-tunnel.service'),'utf8');
  assert.match(unit,new RegExp('^# Managed by dot-im-gateway handoff for prefix='+s.prefix));
  for(const c of ['daemon-reload','enable dot-im-gateway.service','enable dot-im-tunnel.service','restart dot-im-gateway.service','restart dot-im-tunnel.service'])assert.ok(s.calls.includes(c),c);
  assert.deepEqual(s.probes,['http://127.0.0.1:8788/healthz','http://127.0.0.1:8790/readyz']);
  // Committed: restore must not restart anything a second time.
  const before=s.calls.length;await h.restore();assert.equal(s.calls.length,before);
  // The saved Tunnel settings are reported (without values) for the next re-authorisation.
  assert.deepEqual(s.make().summary(),{installed:true,tunnelSaved:true,bound:{qq:true,weixin:false}});
  assert.equal(JSON.stringify(s.make().summary()).includes('synthetic'),false);
  // Re-running for the same owner reuses the saved Tunnel settings and token.
  const again=s.make();await again.prepare();await again.commit({platform:'qq',qq:qq.qq});
  assert.equal(parseEnv(fs.readFileSync(path.join(s.prefix,'runtime.env'),'utf8')).get('DOT_GATEWAY_TOKEN'),'t'.repeat(64));
});

test('handoff restores paused services when setup does not finish',{skip:process.platform==='win32'},async t=>{
  const s=installation(t),h=s.make();
  await h.prepare();assert.equal(s.active.has('dot-im-gateway.service'),false);
  await h.restore();assert.equal(s.active.has('dot-im-gateway.service'),true);
  // A failed plan (no Tunnel settings) writes nothing and still allows restore.
  await h.prepare();await assert.rejects(h.commit({platform:'qq',qq:qq.qq}),/tunnel_settings_required/);
  assert.equal(fs.existsSync(path.join(s.prefix,'runtime.env')),false);
  await h.restore();assert.equal(s.active.has('dot-im-gateway.service'),true);
});

test('handoff refuses missing installations, foreign Tunnel units and unhealthy services',{skip:process.platform==='win32'},async t=>{
  const s=installation(t);
  assert.throws(()=>createHandoff({prefix:path.join(s.root,'none'),home:s.home}).summary(),/service_not_installed/);
  fs.writeFileSync(path.join(s.home,'.config/systemd/user/dot-im-gateway.service'),'[Service]\nWorkingDirectory=/elsewhere/current\n');
  assert.throws(()=>s.make().summary(),/gateway_unit_missing/);
  fs.writeFileSync(path.join(s.home,'.config/systemd/user/dot-im-gateway.service'),`[Service]\nWorkingDirectory=${s.prefix}/current\n`);
  fs.writeFileSync(path.join(s.home,'.config/systemd/user/dot-im-tunnel.service'),'[Service]\nExecStart=/usr/bin/other\n');
  await assert.rejects(s.make().commit(qq),/unrelated_tunnel_unit_exists/);
  fs.rmSync(path.join(s.home,'.config/systemd/user/dot-im-tunnel.service'));
  await assert.rejects(s.make({probe:async()=>({status:0,body:''})}).commit(qq),/gateway_not_healthy/);
  await assert.rejects(s.make({probe:async url=>url.endsWith('/healthz')?{status:200,body:'{"mode":"live"}'}:{status:503,body:''}}).commit(qq),/tunnel_not_ready/);
});

test('connector hands a bound result to the service without starting a transient Tunnel',async()=>{
  let committed,restored=0,prepared=0,ended;
  const handoff={summary:()=>({installed:true,tunnelSaved:true}),prepare:async()=>{prepared++;},restore:async()=>{restored++;},commit:async data=>{committed=structuredClone(data);return {service:'running',platform:'weixin',events:'enabled',autostart:'enabled',linger:true};}};
  const connector=new Connector({dataDir:'synthetic',handoff,onEnd:s=>ended=s,startTunnel:()=>{throw Error('must not start');},weixin:async(i,o)=>{
    o.onBound({token:'synthetic-weixin-token',botId:'wx-bot',ownerId:'wx-owner-stable',origin:'https://ilinkai.weixin.qq.com'});
    o.emit({stage:'gateway_ready',url:'http://127.0.0.1:1/mcp'});
    assert.equal(o.signal.aborted,true);
  }});
  assert.deepEqual(connector.snapshot(),{stage:'idle',mode:'handoff',tunnelSaved:true});
  const raw={platform:'weixin',tunnelId:'',organizationId:'',runtimeKey:'',confirmed:true};
  connector.start(raw);while(!ended)await next();
  assert.equal(prepared,1);assert.equal(restored,1);
  assert.deepEqual(committed,{platform:'weixin',weixin:{token:'synthetic-weixin-token',botId:'wx-bot',ownerId:'wx-owner-stable',origin:'https://ilinkai.weixin.qq.com'}});
  assert.deepEqual(ended,{stage:'handed_off',platform:'weixin',service:'running',events:'enabled',autostart:'enabled',linger:true});
  assert.equal(JSON.stringify(ended).includes('synthetic'),false);
});

test('connector passes new Tunnel settings and reports handoff failures',async()=>{
  let committed,restored=0,ended;
  const handoff={summary:()=>({installed:true,tunnelSaved:false}),prepare:async()=>{},restore:async()=>{restored++;},commit:async data=>{committed=structuredClone(data);throw new Fault('tunnel_not_ready');}};
  const connector=new Connector({dataDir:'synthetic',handoff,onEnd:s=>ended=s,startTunnel:()=>{throw Error('must not start');},weixin:async(i,o)=>{
    o.onBound({token:'synthetic-weixin-token',botId:'wx-bot',ownerId:'wx-owner-stable',origin:'https://ilinkai.weixin.qq.com'});
    o.emit({stage:'gateway_ready',url:'http://127.0.0.1:1/mcp'});
    assert.equal(o.signal.aborted,true);
  }});
  // Without saved settings, empty Tunnel fields are rejected up front.
  assert.throws(()=>connector.start({platform:'weixin',tunnelId:'',organizationId:'',runtimeKey:'',confirmed:true}),/invalid_identifier/);
  const raw={platform:'weixin',...tunnel,confirmed:true};connector.start(raw);while(!ended)await next();
  assert.equal(committed.tunnelId,'tunnel_synthetic');assert.equal(committed.runtimeKey,'synthetic-tunnel-key-only');
  assert.deepEqual(ended,{stage:'failed',code:'tunnel_not_ready'});assert.equal(restored,1);assert.equal(raw.runtimeKey,'');
});

test('connector does not commit when login fails before the owner is bound',async()=>{
  let commits=0,restored=0,ended;
  const handoff={summary:()=>({installed:true,tunnelSaved:true}),prepare:async()=>{},restore:async()=>{restored++;},commit:async()=>{commits++;}};
  const connector=new Connector({dataDir:'synthetic',handoff,onEnd:s=>ended=s,weixin:async(i,o)=>{o.emit({stage:'failed',code:'qr_expired'});}});
  connector.start({platform:'weixin',tunnelId:'',organizationId:'',runtimeKey:'',confirmed:true});while(!ended)await next();
  assert.equal(commits,0);assert.equal(restored,1);assert.deepEqual(ended,{stage:'failed',code:'qr_expired'});
  // Partially filled Tunnel fields never mix with saved ones.
  assert.throws(()=>connectionInput({platform:'weixin',tunnelId:'tunnel_x',organizationId:'',runtimeKey:'',confirmed:true},{tunnelSaved:true}),/invalid_identifier/);
});
