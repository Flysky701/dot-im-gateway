// Hand a verified one-time connection over to the persistent Linux service.
// The single-file connector stays one-shot: it binds the owner, then writes the
// result into an existing deploy.py installation and lets systemd keep it running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {validate} from './config.js';
import {ensure,Fault} from './util.js';

export const DEFAULT_CALLBACK_HOSTS=['chatgpt.com','.chatgpt.com','openai.com','.openai.com'];
export const QQ_GATEWAY_HOSTS=['api.bot.qq.com','api.sgroup.qq.com'];
export const TUNNEL_HEALTH_PORT=8790;
export const GATEWAY_UNIT='dot-im-gateway.service',TUNNEL_UNIT='dot-im-tunnel.service';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const sha=b=>createHash('sha256').update(b).digest('hex');

export function safePrefix(raw){
  ensure(typeof raw==='string'&&path.isAbsolute(raw)&&/^[A-Za-z0-9_./-]+$/.test(raw)&&path.resolve(raw)===raw&&raw.split('/').length>=3,'unsafe_prefix');
  return raw;
}
// systemd EnvironmentFile: single quotes keep every character verbatim except '.
export function parseEnv(text=''){
  const env=new Map();
  for(const line of text.split(/\r?\n/)){
    const m=/^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(!m)continue;let v=m[2].trim();
    if(v.length>=2&&v[0]==="'"&&v.endsWith("'"))v=v.slice(1,-1);
    else if(v.length>=2&&v[0]==='"'&&v.endsWith('"'))v=v.slice(1,-1).replace(/\\(["\\`$])/g,'$1');
    env.set(m[1],v);
  }
  return env;
}
export function envText(env){
  return [...env].map(([k,v])=>{ensure(/^[A-Z][A-Z0-9_]*$/.test(k)&&typeof v==='string'&&v.length>0&&!/['\r\n\0]/.test(v),'unsupported_secret_characters');return `${k}='${v}'`;}).join('\n')+'\n';
}
export function tunnelUnit(prefix,port,healthPort=TUNNEL_HEALTH_PORT){
  safePrefix(prefix);ensure(Number.isInteger(port)&&Number.isInteger(healthPort),'invalid_port');
  return `# Managed by dot-im-gateway handoff for prefix=${prefix}
[Unit]
Description=Official OpenAI tunnel-client for dot-im-gateway
After=network-online.target ${GATEWAY_UNIT}
Wants=network-online.target ${GATEWAY_UNIT}

[Service]
Type=simple
WorkingDirectory=${prefix}
ExecStart=${prefix}/bin/tunnel-client run --control-plane.api-key env:CONTROL_PLANE_API_KEY --control-plane.poll-channel main --control-plane.max-inflight 2 --mcp.max-concurrent-requests 1 --mcp.server-url http://127.0.0.1:${port}/mcp --mcp.extra-headers "Authorization: env:DOT_MCP_AUTH" --mcp.discovery-extra-headers "Authorization: env:DOT_MCP_AUTH" --health.listen-addr 127.0.0.1:${healthPort} --log.format json --log.level warn --admin-ui.log-buffer-events 1
EnvironmentFile=${prefix}/tunnel-runtime.env
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

// Pure merge of the bound result into existing service files. Never changes an
// already bound owner/bot: that would orphan queued messages, so it fails closed.
export function planHandoff(data,{config,runtimeEnv=new Map(),tunnelEnv=new Map(),random=()=>randomBytes(32).toString('hex')}){
  ensure(['qq','weixin'].includes(data?.platform),'platform_required');
  const c=structuredClone(config),p=data.platform,b=data[p];
  ensure(b&&id(b.ownerId)&&typeof (p==='qq'?b.secret:b.token)==='string','handoff_incomplete');
  const bot=p==='qq'?b.appId:b.botId,botKey=p==='qq'?'appId':'botId';ensure(id(bot)||(p==='weixin'&&typeof bot==='string'&&bot.length<=256&&!/[\s'"]/.test(bot)),'handoff_incomplete');
  if(c[p].ownerId)ensure(c[p].ownerId===b.ownerId&&c[p][botKey]===bot,'different_owner_requires_new_data_directory');
  c.mode='live';c.allowSubscriptions=true;c.callbackHosts=[...new Set([...c.callbackHosts,...DEFAULT_CALLBACK_HOSTS])];
  if(p==='qq')Object.assign(c.qq,{enabled:true,ownerId:b.ownerId,appId:bot,apiProfile:'documented',gatewayHosts:[...new Set([...c.qq.gatewayHosts,...QQ_GATEWAY_HOSTS])]});
  else Object.assign(c.weixin,{enabled:true,ownerId:b.ownerId,botId:bot,apiHost:new URL(b.origin).hostname});
  validate(structuredClone(c));
  const runtime=new Map(runtimeEnv),tunnel=new Map(tunnelEnv);
  const existing=runtime.get(c.tokenEnv),token=typeof existing==='string'&&existing.length>=32?existing:random();
  runtime.set(c.tokenEnv,token);runtime.set(p==='qq'?c.qq.secretEnv:c.weixin.tokenEnv,p==='qq'?b.secret:b.token);
  if(data.tunnelId){
    ensure(id(data.tunnelId)&&id(data.organizationId)&&typeof data.runtimeKey==='string'&&data.runtimeKey.length>=16,'invalid_tunnel_settings');
    tunnel.set('CONTROL_PLANE_API_KEY',data.runtimeKey);tunnel.set('CONTROL_PLANE_TUNNEL_ID',data.tunnelId);tunnel.set('CONTROL_PLANE_ORGANIZATION_ID',data.organizationId);
  }
  ensure(['CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','CONTROL_PLANE_ORGANIZATION_ID'].every(k=>tunnel.get(k)),'tunnel_settings_required');
  tunnel.set('DOT_MCP_AUTH','Bearer '+token);
  return {config:c,runtimeEnv:runtime,tunnelEnv:tunnel};
}

function writePrivate(file,data,mode=0o600){
  const tmp=file+'.next-'+randomBytes(6).toString('hex');
  fs.writeFileSync(tmp,data,{mode,flag:'wx'});fs.chmodSync(tmp,mode);fs.renameSync(tmp,file);
}
const defaultSystemctl=(...args)=>spawnSync('systemctl',['--user',...args],{stdio:'ignore',timeout:90000}).status;
async function defaultProbe(url){try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});const body=await r.text();return {status:r.status,body};}catch{return {status:0,body:''};}}
function defaultLinger(){const r=spawnSync('loginctl',['show-user',os.userInfo().username,'--property=Linger','--value'],{encoding:'utf8',timeout:10000});return r.status===0?r.stdout.trim()==='yes':null;}

export function createHandoff({prefix,tunnelBinary,home=os.homedir(),systemctl=defaultSystemctl,probe=defaultProbe,linger=defaultLinger,random,deadlineMs=45000,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
  safePrefix(prefix);
  const file=name=>path.join(prefix,name),unitDir=path.join(home,'.config/systemd/user');
  const read=name=>fs.existsSync(file(name))?fs.readFileSync(file(name),'utf8'):'';
  const installed=()=>{
    for(const p of [prefix,file('current'),file('config.json')])ensure(fs.existsSync(p),'service_not_installed');
    ensure(!fs.lstatSync(prefix).isSymbolicLink()&&fs.lstatSync(file('current')).isSymbolicLink()&&fs.existsSync(file('.dot-im-gateway')),'service_not_installed');
    const gatewayUnit=path.join(unitDir,GATEWAY_UNIT);
    ensure(fs.existsSync(gatewayUnit)&&fs.readFileSync(gatewayUnit,'utf8').split('\n').includes(`WorkingDirectory=${prefix}/current`),'gateway_unit_missing');
    return JSON.parse(read('config.json'));
  };
  let stopped=[],committed=false;
  return {
    // Non-secret facts for the setup page: whether Tunnel fields may be left empty.
    summary(){
      const c=installed(),t=parseEnv(read('tunnel-runtime.env'));
      return {installed:true,tunnelSaved:['CONTROL_PLANE_API_KEY','CONTROL_PLANE_TUNNEL_ID','CONTROL_PLANE_ORGANIZATION_ID'].every(k=>t.get(k)),bound:{qq:Boolean(c.qq?.ownerId),weixin:Boolean(c.weixin?.ownerId)}};
    },
    // One consumer per bot and Tunnel: pause the persistent service during setup.
    async prepare(){
      installed();stopped=[];committed=false;
      for(const unit of [TUNNEL_UNIT,GATEWAY_UNIT])if(systemctl('is-active','--quiet',unit)===0){ensure(systemctl('stop',unit)===0,'service_stop_failed');stopped.push(unit);}
    },
    async restore(){if(committed)return;for(const unit of [GATEWAY_UNIT,TUNNEL_UNIT])if(stopped.includes(unit))systemctl('start',unit);stopped=[];},
    async commit(data){
      const raw=installed();
      const plan=planHandoff(data,{config:raw,runtimeEnv:parseEnv(read('runtime.env')),tunnelEnv:parseEnv(read('tunnel-runtime.env')),random});
      const unitPath=path.join(unitDir,TUNNEL_UNIT);
      if(fs.existsSync(unitPath))ensure(!fs.lstatSync(unitPath).isSymbolicLink()&&fs.readFileSync(unitPath,'utf8').startsWith(`# Managed by dot-im-gateway handoff for prefix=${prefix}\n`),'unrelated_tunnel_unit_exists');
      ensure(Buffer.isBuffer(tunnelBinary)&&tunnelBinary.length>0,'tunnel_binary_missing');
      // Files first, then systemd. Secrets are only ever written with 0600.
      fs.mkdirSync(file('bin'),{recursive:true,mode:0o700});
      const client=file('bin/tunnel-client');if(!fs.existsSync(client)||sha(fs.readFileSync(client))!==sha(tunnelBinary))writePrivate(client,tunnelBinary,0o700);
      writePrivate(file('runtime.env'),envText(plan.runtimeEnv));
      writePrivate(file('tunnel-runtime.env'),envText(plan.tunnelEnv));
      writePrivate(file('config.json'),JSON.stringify(plan.config,null,2)+'\n');
      fs.mkdirSync(unitDir,{recursive:true});writePrivate(unitPath,tunnelUnit(prefix,plan.config.port),0o644);
      committed=true;
      for(const args of [['daemon-reload'],['enable',GATEWAY_UNIT],['enable',TUNNEL_UNIT],['restart',GATEWAY_UNIT],['restart',TUNNEL_UNIT]])ensure(systemctl(...args)===0,'systemctl_failed');
      const deadline=Date.now()+deadlineMs;let gateway=false,tunnel=false;
      while(Date.now()<deadline&&!(gateway&&tunnel)){
        if(!gateway){const r=await probe(`http://127.0.0.1:${plan.config.port}/healthz`);try{gateway=r.status===200&&JSON.parse(r.body).mode==='live';}catch{}}
        if(gateway&&!tunnel)tunnel=(await probe(`http://127.0.0.1:${TUNNEL_HEALTH_PORT}/readyz`)).status===200;
        if(!(gateway&&tunnel))await pause(1000);
      }
      ensure(gateway,'gateway_not_healthy');ensure(tunnel,'tunnel_not_ready');
      return {service:'running',platform:data.platform,events:'enabled',autostart:'enabled',linger:linger()};
    }
  };
}
