// One connection per invocation. The connector itself never persists credentials,
// installs services or enables events. In handoff mode (Linux server) it passes the
// bound result to an existing persistent service, which owns long-running recovery.
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {runQQTest} from './qq-private-session.js';
import {runWeixinTest} from './weixin-private-session.js';
import {qqQrCredentials} from './qq-qr.js';
import {ensure,exact,Fault} from './util.js';

const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
// Tunnel fields may be left empty only when the persistent service already has them.
export const reusesTunnel=(input,tunnelSaved)=>Boolean(tunnelSaved)&&!input.tunnelId&&!input.organizationId&&!input.runtimeKey;
export function connectionInput(input,{tunnelSaved=false}={}){
  exact(input,['platform','qqAuth','appId','secret','tunnelId','organizationId','runtimeKey','confirmed']);
  ensure(['qq','weixin'].includes(input.platform),'platform_required');ensure(input.confirmed===true,'scope_confirmation_required');
  const reuse=reusesTunnel(input,tunnelSaved);
  if(!reuse){
    for(const name of ['tunnelId','organizationId'])ensure(identifier(input[name]),'invalid_identifier');
    ensure(input.tunnelId.startsWith('tunnel_')&&input.organizationId.startsWith('org-'),'invalid_identifier');
  }
  const manual=input.platform==='qq'&&(input.qqAuth||'manual')==='manual';
  if(input.platform==='qq')ensure(['qr','manual'].includes(input.qqAuth||'manual'),'invalid_qq_auth');
  for(const name of [...(reuse?[]:['runtimeKey']),...(manual?['secret']:[])])ensure(typeof input[name]==='string'&&input[name].length>=16&&input[name].length<=1024&&!/[\r\n\u0000]/.test(input[name]),'invalid_secret_shape');
  if(manual||input.appId)ensure(identifier(input.appId),'invalid_identifier');
  return input;
}
export class Connector {
  constructor({dataDir,startTunnel,startQrConnect,onEnd=()=>{},qq=runQQTest,weixin=runWeixinTest,handoff=null}){
    Object.assign(this,{dataDir,startTunnel,startQrConnect,onEnd,runners:{qq,weixin},handoff});
    // Non-secret handoff facts only; summary() fails closed when no service is installed.
    this.handoffInfo=handoff?handoff.summary():null;
    this.state=handoff?{stage:'idle',mode:'handoff',tunnelSaved:this.handoffInfo.tunnelSaved}:{stage:'idle'};this.commands=new EventEmitter();this.abort=new AbortController();this.task=null;this.tunnel=null;this.ending=false;this.tunnelTask=null;
    // A stop (button or Ctrl+C) always wins over a pending handoff: nothing is saved.
    this.stopRequested=false;this.commitAbort=new AbortController();
  }
  snapshot(){return structuredClone(this.state);}
  start(raw){
    ensure(this.state.stage==='idle','connection_already_started');
    const tunnelSaved=Boolean(this.handoffInfo?.tunnelSaved),input=connectionInput(raw,{tunnelSaved}),reuse=reusesTunnel(input,tunnelSaved);
    this.state={stage:'connecting',platform:input.platform};
    // Bound credentials stay in this closure and are never part of page state.
    let bound=null,handoffReady=false;const onBound=this.handoff?data=>{bound={...data};}:null;
    const bearer=randomBytes(32).toString('hex');
    const fail=code=>{this.state={stage:'failed',code};this.abort.abort();};
    const emit=event=>{
      if(this.ending||this.abort.signal.aborted)return;
      // Only explicitly selected fields reach the page. Never forward protocol responses.
      if(event.stage==='progress'){if(typeof event.phase==='string'&&/^[a-z_]+$/.test(event.phase))this.state.phase=event.phase;}
      if(event.stage==='binding_challenge')Object.assign(this.state,{stage:'qq_challenge',challenge:event.challenge});
      if(event.stage==='candidate')Object.assign(this.state,{stage:'qq_confirm',confirmation:`CONFIRM ${event.appId} ${event.ownerId}`});
      if(event.stage==='qr')Object.assign(this.state,{stage:'weixin_qr',qr:event.content});
      if(event.stage==='qq_qr')Object.assign(this.state,{stage:'qq_qr',qr:event.content});
      if(event.stage==='verify_code_required')Object.assign(this.state,{stage:'verify_code'});
      if(event.stage==='failed')fail(/^[a-z0-9_]+$/.test(event.code||'')?event.code:'connection_failed');
      if(event.stage==='gateway_ready'&&this.handoff){
        // Owner bound and credentials verified: stop this one-shot bridge so the
        // persistent service becomes the only consumer of the bot and Tunnel.
        this.state={stage:'handing_off',platform:input.platform};handoffReady=true;this.abort.abort();return;
      }
      if(event.stage==='gateway_ready'){
        this.state={stage:'tunnel_connecting',platform:input.platform};
        this.tunnelTask=Promise.resolve().then(()=>this.startTunnel({url:event.url,bearer,key:input.runtimeKey,tunnelId:input.tunnelId,organizationId:input.organizationId,signal:this.abort.signal,onExit:()=>fail('tunnel_stopped')})).then(client=>{
          this.tunnel=client;if(this.abort.signal.aborted){client.stop();return;}
          this.state={stage:'connected',platform:input.platform,tunnel:'process_started_not_original_dot_verified'};
        }).catch(e=>fail(e instanceof Fault?e.code:'tunnel_start_failed'));
      }
    };
    const common={bearer,dataDir:this.dataDir,maximumSeconds:0};
    const runtimeInput=input.platform==='qq'?{...common,appId:input.appId,secret:input.secret,expectedOwner:'',gatewayHosts:['api.bot.qq.com','api.sgroup.qq.com']}:common;
    this.task=Promise.resolve().then(async()=>{
      if(this.handoff)await this.handoff.prepare();
      let verifiedOwner='';
      if(input.platform==='qq'&&input.qqAuth==='qr'){
        const result=await qqQrCredentials(this.startQrConnect,{signal:this.abort.signal,emit,expectedAppId:input.appId||''});
        runtimeInput.appId=result.appId;runtimeInput.secret=result.appSecret;result.appSecret='';
        verifiedOwner=result.userOpenid;runtimeInput.expectedOwner=verifiedOwner;
        this.state={stage:'qq_app_confirm',platform:'qq',appId:runtimeInput.appId,confirmation:`CONNECT ${runtimeInput.appId}`};
        await new Promise((resolve,reject)=>{
          const cleanup=()=>{clearTimeout(deadline);this.commands.off('line',line);this.abort.signal.removeEventListener('abort',cancel);};
          const line=()=>{cleanup();resolve();};const cancel=()=>{cleanup();reject(new Fault('qq_qr_cancelled'));};
          const deadline=setTimeout(()=>{cleanup();reject(new Fault('qq_app_confirmation_timeout'));},120000);
          this.commands.once('line',line);this.abort.signal.addEventListener('abort',cancel,{once:true});if(this.abort.signal.aborted)cancel();
        });
      }
      ensure(!this.abort.signal.aborted,'connection_stopped');
      return this.runners[input.platform](runtimeInput,{emit,commands:this.commands,signal:this.abort.signal,untilStopped:true,verifiedOwner,...(onBound?{onBound}:{})});
    }).catch(e=>fail(e instanceof Fault?e.code:'connection_failed')).finally(async()=>{
      this.ending=true;this.abort.abort();if(this.tunnelTask)await this.tunnelTask;await this.tunnel?.stop();
      if(this.handoff){
        if(handoffReady&&bound&&this.state.stage!=='failed'&&!this.stopRequested){
          try{
            const result=await this.handoff.commit({platform:input.platform,...(reuse?{}:{tunnelId:input.tunnelId,organizationId:input.organizationId,runtimeKey:input.runtimeKey}),[input.platform]:bound},{signal:this.commitAbort.signal});
            this.state={stage:'handed_off',platform:input.platform,service:result.service,events:result.events,autostart:result.autostart,linger:result.linger};
          }catch(e){this.state=this.stopRequested?{stage:'stopped'}:{stage:'failed',code:e instanceof Fault?e.code:'handoff_failed'};}
        }
        try{await this.handoff.restore();}catch{}
      }
      if(bound){bound.secret='';bound.token='';bound=null;}
      runtimeInput.secret='';input.secret='';input.runtimeKey='';if(!['failed','handed_off'].includes(this.state.stage))this.state={stage:'stopped'};this.onEnd(this.snapshot());
    });
    return this.snapshot();
  }
  command(input){
    exact(input,['value']);ensure(typeof input.value==='string'&&input.value.length<=300,'invalid_confirmation');
    if(['qq_confirm','qq_app_confirm'].includes(this.state.stage))ensure(input.value===this.state.confirmation,'confirmation_mismatch');
    else {ensure(this.state.stage==='verify_code','confirmation_not_expected');ensure(/^[0-9]{1,12}$/.test(input.value),'invalid_verify_code');}
    this.state={stage:'connecting',platform:this.state.platform};this.commands.emit('line',input.value);return this.snapshot();
  }
  async stop(){this.stopRequested=true;this.commitAbort.abort();this.abort.abort();this.commands.emit('line','STOP');if(this.task)await this.task;else{this.state={stage:'stopped'};this.onEnd(this.snapshot());}}
}
