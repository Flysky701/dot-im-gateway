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
const WX_OWNER='o9cq80synthetic_Owner-1@im.wechat',WX_BOT='b0f1synthetic2c3d@im.bot';
const wx={platform:'weixin',...tunnel,weixin:{token:'synthetic-weixin-token',botId:WX_BOT,ownerId:WX_OWNER,origin:'https://ilinkai.weixin.qq.com'}};
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
  assert.equal(w.config.weixin.botId,WX_BOT);assert.equal(w.config.weixin.ownerId,WX_OWNER);assert.equal(w.config.weixin.apiHost,'ilinkai.weixin.qq.com');
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

test('handoff accepts official Weixin ID formats and rejects unsafe ones',()=>{
  assert.equal(planHandoff(wx,{config:config()}).config.weixin.ownerId,WX_OWNER);
  for(const bad of ['a b@im.wechat','a\n@im.wechat','','x'.repeat(257),'tab\there'])
    assert.throws(()=>planHandoff({...wx,weixin:{...wx.weixin,ownerId:bad}},{config:config()}),/handoff_incomplete/,JSON.stringify(bad));
  assert.throws(()=>planHandoff({...wx,weixin:{...wx.weixin,botId:'bot id'}},{config:config()}),/handoff_incomplete/);
  // QQ identities stay strict: user_openid and numeric/alnum app IDs only.
  assert.throws(()=>planHandoff({...qq,qq:{...qq.qq,ownerId:'x@im.wechat'}},{config:config()}),/handoff_incomplete/);
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
  const calls=[],active=new Set(['dot-im-gateway.service']),enabled=new Set(['dot-im-gateway.service']);
  const systemctl=(...args)=>{calls.push(args.join(' '));const unit=args.at(-1);
    if(args[0]==='is-active')return active.has(unit)?0:3;if(args[0]==='is-enabled')return enabled.has(unit)?0:1;
    if(args[0]==='stop')active.delete(unit);if(['start','restart'].includes(args[0]))active.add(unit);
    if(args[0]==='enable')enabled.add(unit);if(args[0]==='disable')enabled.delete(unit);return 0;};
  const probes=[];
  const probe=async url=>{probes.push(url);return url.endsWith('/healthz')?{status:200,body:JSON.stringify({ok:true,mode:'live'})}:{status:200,body:'ok'};};
  const make=extra=>createHandoff({prefix,home,tunnelBinary:Buffer.from('#!/bin/sh\n'),systemctl,probe,linger:()=>false,random:()=>'t'.repeat(64),pause:async()=>{},deadlineMs:1000,...extra});
  const unitPath=path.join(home,'.config/systemd/user/dot-im-tunnel.service');
  return {root,home,prefix,unitPath,calls,active,enabled,probes,systemctl,make};
}
const mode=f=>fs.statSync(f).mode&0o777;
const NOT_READY=async url=>url.endsWith('/healthz')?{status:200,body:'{"mode":"live"}'}:{status:503,body:''};
const snapshotFiles=s=>Object.fromEntries(['bin/tunnel-client','runtime.env','tunnel-runtime.env','config.json'].map(f=>path.join(s.prefix,f)).concat(s.unitPath)
  .map(f=>[f,fs.existsSync(f)?{data:fs.readFileSync(f,'base64'),mode:mode(f)}:null]));

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

test('handoff refuses missing installations and unhealthy services',{skip:process.platform==='win32'},async t=>{
  const s=installation(t);
  assert.throws(()=>createHandoff({prefix:path.join(s.root,'none'),home:s.home}).summary(),/service_not_installed/);
  fs.writeFileSync(path.join(s.home,'.config/systemd/user/dot-im-gateway.service'),'[Service]\nWorkingDirectory=/elsewhere/current\n');
  assert.throws(()=>s.make().summary(),/gateway_unit_missing/);
  fs.writeFileSync(path.join(s.home,'.config/systemd/user/dot-im-gateway.service'),`[Service]\nWorkingDirectory=${s.prefix}/current\n`);
  await assert.rejects(s.make({probe:async()=>({status:0,body:''}),deadlineMs:1}).commit(qq),/gateway_not_healthy/);
  await assert.rejects(s.make({probe:NOT_READY,deadlineMs:1}).commit(qq),/tunnel_not_ready/);
});

test('a Tunnel unit of another program is never stopped, overwritten or followed',{skip:process.platform==='win32'},async t=>{
  const s=installation(t);s.active.add('dot-im-tunnel.service');
  for(const write of [()=>fs.writeFileSync(s.unitPath,'[Service]\nExecStart=/usr/bin/other\n'),
    ()=>fs.writeFileSync(s.unitPath,`# Managed by dot-im-gateway handoff for prefix=${s.prefix}-other\n[Service]\n`),
    ()=>{const target=path.join(s.root,'elsewhere.service');fs.writeFileSync(target,`# Managed by dot-im-gateway handoff for prefix=${s.prefix}\n`);fs.symlinkSync(target,s.unitPath);}]){
    fs.rmSync(s.unitPath,{force:true});write();const before=fs.lstatSync(s.unitPath).isSymbolicLink()?fs.readlinkSync(s.unitPath):fs.readFileSync(s.unitPath,'utf8');
    const h=s.make();
    assert.throws(()=>h.summary(),/unrelated_tunnel_unit_exists/);
    await assert.rejects(h.prepare(),/unrelated_tunnel_unit_exists/);
    await assert.rejects(h.commit(qq),/unrelated_tunnel_unit_exists/);
    assert.equal(fs.lstatSync(s.unitPath).isSymbolicLink()?fs.readlinkSync(s.unitPath):fs.readFileSync(s.unitPath,'utf8'),before);
  }
  assert.deepEqual(s.calls,[],'nothing may be stopped or changed');
  assert.equal(fs.existsSync(path.join(s.prefix,'runtime.env')),false);
  // The connector refuses to start at all, so the page never offers a binding.
  assert.throws(()=>new Connector({dataDir:'synthetic',handoff:s.make()}),/unrelated_tunnel_unit_exists/);
});

test('a failed handoff on a running, bound service restores every file, mode and unit state',{skip:process.platform==='win32'},async t=>{
  const s=installation(t);
  const first=s.make();await first.prepare();await first.commit(qq);
  assert.ok(s.active.has('dot-im-tunnel.service')&&s.enabled.has('dot-im-tunnel.service'));
  fs.chmodSync(path.join(s.prefix,'config.json'),0o640);
  const before=snapshotFiles(s);s.calls.length=0;
  // A new Weixin binding with different Tunnel settings and a newer tunnel-client fails at readiness.
  const h=s.make({probe:NOT_READY,tunnelBinary:Buffer.from('#!/bin/sh\n# newer\n'),deadlineMs:1});
  await h.prepare();assert.equal(s.active.size,0);
  await assert.rejects(h.commit({...wx,runtimeKey:'another-tunnel-key-only'}),/tunnel_not_ready/);
  assert.deepEqual(snapshotFiles(s),before,'files are byte-identical with their original modes');
  assert.equal(s.calls.some(c=>c.startsWith('disable')),false,'previously enabled units stay enabled');
  assert.deepEqual([...s.enabled].sort(),['dot-im-gateway.service','dot-im-tunnel.service']);
  assert.equal(s.calls.at(-1),'daemon-reload');
  assert.deepEqual(fs.readdirSync(s.prefix).filter(f=>f.includes('.next-')),[]);
  // restore() restarts both originally running services with the old configuration.
  await h.restore();assert.deepEqual([...s.active].sort(),['dot-im-gateway.service','dot-im-tunnel.service']);
  assert.ok(s.calls.includes('start dot-im-gateway.service')&&s.calls.includes('start dot-im-tunnel.service'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.prefix,'config.json'),'utf8')).weixin.ownerId,'');
});

test('a failed first handoff removes new files and disables only the new Tunnel unit',{skip:process.platform==='win32'},async t=>{
  const s=installation(t),before=snapshotFiles(s);let unitPresentAtDisable=null;
  const h=s.make({probe:async()=>({status:0,body:''}),deadlineMs:1,systemctl:(...a)=>{if(a[0]==='disable')unitPresentAtDisable=fs.existsSync(s.unitPath);return s.systemctl(...a);}});
  await h.prepare();await assert.rejects(h.commit(qq),/gateway_not_healthy/);
  assert.deepEqual(snapshotFiles(s),before);
  for(const f of ['runtime.env','tunnel-runtime.env','bin/tunnel-client'])assert.equal(fs.existsSync(path.join(s.prefix,f)),false,f);
  assert.equal(fs.existsSync(s.unitPath),false);
  assert.equal(unitPresentAtDisable,true,'disable runs while the unit file still exists');
  assert.ok(s.calls.includes('disable dot-im-tunnel.service'));assert.equal(s.calls.includes('disable dot-im-gateway.service'),false);
  assert.deepEqual([...s.enabled],['dot-im-gateway.service']);
  await h.restore();assert.deepEqual([...s.active],['dot-im-gateway.service']);
});

test('cancelling a handoff stops waiting and rolls back; an already cancelled one writes nothing',{skip:process.platform==='win32'},async t=>{
  const s=installation(t),before=snapshotFiles(s),ac=new AbortController();
  const h=s.make({probe:async()=>{ac.abort();return {status:0,body:''};},deadlineMs:5000});
  await h.prepare();await assert.rejects(h.commit(qq,{signal:ac.signal}),/handoff_cancelled/);
  assert.deepEqual(snapshotFiles(s),before);assert.deepEqual([...s.enabled],['dot-im-gateway.service']);
  await h.restore();assert.deepEqual([...s.active],['dot-im-gateway.service']);
  s.calls.length=0;
  await assert.rejects(s.make().commit(qq,{signal:AbortSignal.abort()}),/handoff_cancelled/);
  assert.deepEqual(s.calls,[]);assert.deepEqual(snapshotFiles(s),before);
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

test('connector stop while handing off saves nothing and reports stopped',async()=>{
  let commits=0,restored=0,ended,release;const gate=new Promise(r=>release=r);
  const handoff={summary:()=>({installed:true,tunnelSaved:true}),prepare:async()=>{},restore:async()=>{restored++;},commit:async()=>{commits++;return {};}};
  const connector=new Connector({dataDir:'synthetic',handoff,onEnd:s=>ended=s,weixin:async(i,o)=>{
    o.onBound({token:'synthetic-weixin-token',botId:WX_BOT,ownerId:WX_OWNER,origin:'https://ilinkai.weixin.qq.com'});
    o.emit({stage:'gateway_ready',url:'http://127.0.0.1:1/mcp'});await gate;
  }});
  connector.start({platform:'weixin',tunnelId:'',organizationId:'',runtimeKey:'',confirmed:true});
  while(connector.snapshot().stage!=='handing_off')await next();
  const stopping=connector.stop();release();await stopping;
  assert.equal(commits,0);assert.equal(restored,1);assert.deepEqual(ended,{stage:'stopped'});
});

test('connector stop during commit cancels it and reports stopped',async()=>{
  let signal,restored=0,ended,entered;const inCommit=new Promise(r=>entered=r);
  const handoff={summary:()=>({installed:true,tunnelSaved:true}),prepare:async()=>{},restore:async()=>{restored++;},commit:async(data,o)=>{
    signal=o?.signal;entered();if(!signal)throw new Fault('commit_signal_missing');
    await new Promise(r=>signal.addEventListener('abort',r,{once:true}));throw new Fault('handoff_cancelled');}};
  const connector=new Connector({dataDir:'synthetic',handoff,onEnd:s=>ended=s,weixin:async(i,o)=>{
    o.onBound({token:'synthetic-weixin-token',botId:WX_BOT,ownerId:WX_OWNER,origin:'https://ilinkai.weixin.qq.com'});
    o.emit({stage:'gateway_ready',url:'http://127.0.0.1:1/mcp'});
  }});
  connector.start({platform:'weixin',tunnelId:'',organizationId:'',runtimeKey:'',confirmed:true});
  await inCommit;assert.equal(signal?.aborted,false);
  await connector.stop();
  assert.equal(signal.aborted,true);assert.equal(restored,1);assert.deepEqual(ended,{stage:'stopped'});
});

test('connector and the real handoff persist an official Weixin binding end to end',{skip:process.platform==='win32'},async t=>{
  const s=installation(t);let ended;
  const connector=new Connector({dataDir:path.join(s.root,'session'),handoff:s.make(),onEnd:x=>ended=x,startTunnel:()=>{throw Error('must not start');},weixin:async(i,o)=>{
    assert.equal(s.active.has('dot-im-gateway.service'),false,'the persistent service is paused while binding');
    o.onBound({token:'synthetic-weixin-token',botId:WX_BOT,ownerId:WX_OWNER,origin:'https://ilinkai.weixin.qq.com'});
    o.emit({stage:'gateway_ready',url:'http://127.0.0.1:1/mcp'});
  }});
  assert.deepEqual(connector.snapshot(),{stage:'idle',mode:'handoff',tunnelSaved:false});
  connector.start({platform:'weixin',...tunnel,confirmed:true});while(!ended)await next();
  assert.deepEqual(ended,{stage:'handed_off',platform:'weixin',service:'running',events:'enabled',autostart:'enabled',linger:false});
  const saved=JSON.parse(fs.readFileSync(path.join(s.prefix,'config.json'),'utf8'));
  assert.equal(saved.weixin.enabled,true);assert.equal(saved.weixin.ownerId,WX_OWNER);assert.equal(saved.weixin.botId,WX_BOT);
  assert.equal(parseEnv(fs.readFileSync(path.join(s.prefix,'runtime.env'),'utf8')).get(saved.weixin.tokenEnv),'synthetic-weixin-token');
  assert.equal(parseEnv(fs.readFileSync(path.join(s.prefix,'tunnel-runtime.env'),'utf8')).get('CONTROL_PLANE_TUNNEL_ID'),'tunnel_synthetic');
  assert.deepEqual([...s.active].sort(),['dot-im-gateway.service','dot-im-tunnel.service']);
  assert.equal(JSON.stringify(ended).includes('synthetic'),false);
});
