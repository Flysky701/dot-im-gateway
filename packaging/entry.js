import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {getAsset} from 'node:sea';
import {DatabaseSync} from 'node:sqlite';
import {Connector} from '../src/connector.js';
import {qqWorkerStart,verifyQQWorker} from '../src/qq-qr-worker.js';
import {connectServer} from '../src/connect-http.js';
import {lock} from '../src/runtime.js';
import {createHandoff,safePrefix} from '../src/handoff.js';
import {ensure,Fault} from '../src/util.js';

const text=name=>getAsset(name,'utf8');
const manifest=JSON.parse(text('manifest'));
const args=process.argv.slice(2);
const safePrint=data=>console.log(JSON.stringify(data));
async function unusedPort(){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export function cleanEnvironment(dir){
  const env={HOME:dir,USERPROFILE:dir,TMPDIR:dir,TMP:dir,TEMP:dir};
  for(const k of ['SystemRoot','WINDIR','PATH','LANG','LC_ALL'])if(process.env[k])env[k]=process.env[k];return env;
}
async function childStop(child){
  if(!child.pid||child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');
  const kill=setTimeout(()=>child.kill('SIGKILL'),3000);try{await exited;}finally{clearTimeout(kill);}
}
async function main(){
  if(args.includes('--licenses')){console.log(text('licenses'));return;}
  if(args.includes('--help')){console.log('dot-im-connect [--port 8789] [--no-browser] [--handoff PREFIX]\nSingle connection: owner text only; this program saves no credentials and installs nothing by itself.\nWindows runs locally; on Linux use an existing SSH local port forward.\nClosing the page keeps the bridge running; Ctrl+C stops it and cleans temporary data.\n--handoff PREFIX (Linux): bind once, then hand the result to the persistent service installed by\n  scripts/deploy.py at PREFIX (credentials go to PREFIX/*.env, 0600). Rerun it to re-authorize.\n--self-test performs offline embedded-runtime checks. --licenses prints bundled notices.');return;}
  const preview=args.includes('--preview'),selfTest=args.includes('--self-test');let port=0;
  const pi=args.indexOf('--port');if(pi>=0){port=Number(args[pi+1]);ensure(Number.isInteger(port)&&port>=1024&&port<=65535,'invalid_port');args.splice(pi,2);}
  let handoffPrefix='';const hi=args.indexOf('--handoff');if(hi>=0){ensure(process.platform==='linux','handoff_requires_linux');handoffPrefix=safePrefix(args[hi+1]);args.splice(hi,2);}
  ensure(args.every(x=>['--preview','--self-test','--no-browser'].includes(x)),'unknown_option');
  ensure(manifest.platform===process.platform&&manifest.arch===process.arch,'wrong_platform_binary');
  const release=await lock(path.join(os.tmpdir(),'dot-im-connect-single-instance'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-im-connect-'));fs.chmodSync(dir,0o700);
  const identity=fs.statSync(dir);let server,connector,closing=false,idleTimer,endTimer,subPollInterval;const children=new Set();
  const cleanup=async()=>{
    if(closing)return;closing=true;clearTimeout(idleTimer);clearTimeout(endTimer);clearInterval(subPollInterval);
    if(connector)await connector.stop();for(const child of children)await childStop(child);
    if(server){server.closeAllConnections();await new Promise(r=>server.close(()=>r()));}
    const stat=fs.lstatSync(dir);ensure(!stat.isSymbolicLink()&&stat.dev===identity.dev&&stat.ino===identity.ino,'cleanup_identity_mismatch');
    fs.rmSync(dir,{recursive:true});await release();safePrint({stage:'stopped',processes_remaining:false,data_removed:true});
  };
  process.once('SIGINT',()=>{void cleanup();});process.once('SIGTERM',()=>{void cleanup();});
  // A dropped SSH session must still restore a paused persistent service (handoff).
  process.once('SIGHUP',()=>{void cleanup();});
  try{
    const binary=gunzipSync(getAsset('tunnel.gz'));ensure(createHash('sha256').update(binary).digest('hex')===manifest.tunnelSha256,'embedded_binary_changed');
    const clientPath=path.join(dir,process.platform==='win32'?'tunnel-client.exe':'tunnel-client');fs.writeFileSync(clientPath,binary,{mode:0o700,flag:'wx'});
    if(selfTest){
      const db=new DatabaseSync(':memory:');ensure(db.prepare('SELECT 1 n').get().n===1,'sqlite_failed');db.close();
      const child=spawn(clientPath,['--version'],{cwd:dir,env:cleanEnvironment(dir),stdio:'ignore',windowsHide:true});children.add(child);
      const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});ensure(code===0,'embedded_client_failed');
      await verifyQQWorker(text('qq-sdk'));
      safePrint({self_test:'passed',node:process.versions.node,platform:process.platform,sqlite:true,official_client:true,qq_sdk:true,network:false,external_runtime_required:false});await cleanup();return;
    }
    const startTunnel=async({url,bearer,key,tunnelId,organizationId,signal,onExit})=>{
      ensure(!preview,'preview_network_disabled');ensure(/^http:\/\/127\.0\.0\.1:[0-9]+\/mcp$/.test(url),'invalid_gateway_address');
      const healthPort=await unusedPort();ensure(!signal.aborted,'connection_stopped');
      const env={...cleanEnvironment(dir),CONTROL_PLANE_API_KEY:key,CONTROL_PLANE_TUNNEL_ID:tunnelId,DOT_MCP_AUTH:'Bearer '+bearer};
      if(organizationId)env.CONTROL_PLANE_ORGANIZATION_ID=organizationId;
      const child=spawn(clientPath,['run','--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--control-plane.poll-channel','main','--control-plane.max-inflight','2','--mcp.max-concurrent-requests','1','--mcp.server-url',url,'--mcp.startup-wait-timeout','30s','--mcp.extra-headers','Authorization: env:DOT_MCP_AUTH','--mcp.discovery-extra-headers','Authorization: env:DOT_MCP_AUTH','--health.listen-addr','127.0.0.1:'+healthPort,'--log.format','json','--log.level','warn','--admin-ui.log-buffer-events','1'],{cwd:dir,env,stdio:'ignore',windowsHide:true});children.add(child);
      let stopping=false;const stop=async()=>{stopping=true;await childStop(child);};
      child.once('exit',()=>{children.delete(child);if(!stopping&&!signal.aborted)onExit();});
      try{
        await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j);});
        signal.addEventListener('abort',()=>{void stop();},{once:true});
        const deadline=Date.now()+20000;let ready=false;
        while(Date.now()<deadline&&!signal.aborted&&child.exitCode===null){
          try{const r=await fetch('http://127.0.0.1:'+healthPort+'/readyz',{signal:AbortSignal.timeout(700)});await r.arrayBuffer();if(r.status===200){ready=true;break;}}catch{}
          await new Promise(r=>setTimeout(r,500));
        }
        ensure(ready&&!signal.aborted,'tunnel_not_ready');return {stop};
      }catch(e){await stop();throw e;}
    };
    const handoff=handoffPrefix?createHandoff({prefix:handoffPrefix,tunnelBinary:binary}):null;
    connector=preview?{snapshot:()=>({stage:'idle'}),start:()=>{throw new Fault('preview_network_disabled');},command:()=>{throw new Fault('preview_network_disabled');},stop:async()=>{}}:new Connector({dataDir:path.join(dir,'data'),startTunnel,handoff,onEnd:s=>{
      safePrint({stage:s.stage,...(s.code?{code:s.code}:{}),...(s.stage==='handed_off'?{service:s.service,events:s.events,autostart:s.autostart,linger:s.linger,tunnelHint:s.tunnelHint,subscribed:s.subscribed,mcpConnected:s.mcpConnected}:{})});
      if(s.stage==='handed_off'){
        endTimer=setTimeout(()=>{void cleanup();},s.subscribed?15000:600000);
        if(!s.subscribed){
          subPollInterval=setInterval(()=>{
            if(connector.snapshot().subscribed===true){
              clearInterval(subPollInterval);subPollInterval=null;
              safePrint({stage:'mcp_subscribed',platform:s.platform});
              clearTimeout(endTimer);
              endTimer=setTimeout(()=>{void cleanup();},15000);
            }
          },1500);
          subPollInterval?.unref?.();
        }
      }else{
        endTimer=setTimeout(()=>{void cleanup();},s.stage==='failed'?20000:500);
      }
    },startQrConnect:qqWorkerStart(text('qq-sdk'))});
    const token=preview?'synthetic-preview-access-0000000000000000':randomBytes(32).toString('hex');
    server=connectServer({token,connector,assets:{'/':{body:text('html'),type:'text/html; charset=utf-8'},'/app.js':{body:text('js'),type:'text/javascript; charset=utf-8'},'/style.css':{body:text('css'),type:'text/css; charset=utf-8'}},finish:()=>{
      if(handoffPrefix){void cleanup();}
      else{server.closeAllConnections();server.close();safePrint({stage:'page_closed',bridge_running:true});}
    }});
    await new Promise((r,j)=>{server.once('error',j);server.listen(port,'127.0.0.1',r);});
    const url='http://127.0.0.1:'+server.address().port+'/#'+token;
    // Printed only in the user's own terminal. Never save this temporary UI capability.
    console.log('Open in your own browser (do not share this link):\n'+url);
    idleTimer=setTimeout(()=>{if(connector.snapshot().stage==='idle')void cleanup();},300000);
    if(process.platform==='win32'&&!args.includes('--no-browser')){const opener=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',windowsHide:true});opener.on('error',()=>{});}
  }catch(e){await cleanup();throw e;}
}
main().catch(e=>{safePrint({stage:'failed',code:e instanceof Fault?e.code:'connector_failed'});process.exitCode=1;});
