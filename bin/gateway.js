#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {example,readConfig} from '../src/config.js';
import {Store} from '../src/store.js';
import {serve,lock} from '../src/runtime.js';
import {backupData,restoreData} from '../src/operations.js';
import {ensure,Fault} from '../src/util.js';
const args=process.argv.slice(2);const command=args.shift()||'help';
function option(key,fallback){const i=args.indexOf('--'+key);if(i<0)return fallback;ensure(args[i+1]&&!args[i+1].startsWith('--'),'option_value_required');const value=args[i+1];args.splice(i,2);return value;}
const configPath=path.resolve(option('config','config.json'));
const out=x=>console.log(JSON.stringify(x,null,2));
try{
  if(command==='help'||command==='--help')console.log(`dot-im-gateway 0.1.1 (Node 24.21+)
config init [--config FILE]       Write offline configuration without secrets
doctor [--config FILE]            Local configuration/runtime checks, no network
serve [--config FILE]             Loopback service (live requires explicit config)
status | logs [--config FILE]     Redacted queue counts / audit categories
backup --to NEW_DIR               Stop service first; includes DB, media and secrets
restore --from BACKUP --to NEW_DIR  Quarantines pending sends; revokes subscriptions
reconcile --id REPLY_OR_NOTICE --decision accepted|cancelled  No automatic resend
upgrade | rollback | uninstall   Deployment plan by default; --apply executes
                                 See python3 scripts/deploy.py --help
`);
  else if(command==='config'){
    ensure(args.shift()==='init','use_config_init');fs.writeFileSync(configPath,JSON.stringify(example,null,2)+'\n',{flag:'wx',mode:0o600});out({created:configPath,mode:'offline'});
  }else if(['upgrade','rollback','uninstall'].includes(command)){
    const script=fileURLToPath(new URL('../scripts/deploy.py',import.meta.url));const r=spawnSync(process.platform==='win32'?'python':'python3',[script,command,...args],{stdio:'inherit'});process.exitCode=r.status??1;
  }else if(command==='restore')out(await restoreData(path.resolve(option('from')),path.resolve(option('to'))));
  else{
    const c=readConfig(configPath);
    if(command==='serve')await serve(c);
    else if(command==='doctor'){
      const major=Number(process.versions.node.split('.')[0]);
      const checks={node24:major===24,loopback:c.host==='127.0.0.1',mode:c.mode,subscriptionsEnabled:c.allowSubscriptions,configuredPlatforms:['qq','weixin'].filter(p=>c[p].enabled),gatewaySecretPresent:!!process.env[c.tokenEnv],qqSecretPresent:!!process.env[c.qq.secretEnv],weixinSecretPresent:!!process.env[c.weixin.tokenEnv],realDotAcceptance:'pending_user_environment'};
      out(checks);if(!checks.node24)process.exitCode=1;
    }else if(command==='backup')out(await backupData(c.dataDir,path.resolve(option('to'))));
    else{
      ensure(['status','logs','reconcile'].includes(command),'unknown_command');
      const release=command==='reconcile'?await lock(c.dataDir):null;const store=new Store(c.dataDir);
      try{if(command==='status')out(store.status());if(command==='logs')out(store.all('SELECT * FROM audit ORDER BY seq DESC LIMIT 100'));if(command==='reconcile'){store.resolve(option('id'),option('decision'));out({reconciled:true});}}finally{store.close();if(release)await release();}
    }
  }
}catch(e){console.error(JSON.stringify({error:e instanceof Fault?e.code:e.code==='EEXIST'?'destination_exists':'operation_failed'}));process.exitCode=1;}
