import fs from 'node:fs';
import path from 'node:path';
import {Store} from './store.js';
import {lock} from './runtime.js';
import {privateDir} from './config.js';
import {ensure,hash} from './util.js';
export async function backupData(dataDir,dest){
  ensure(!fs.existsSync(dest),'backup_destination_exists');const release=await lock(dataDir);let store;
  try{
    privateDir(dest);store=new Store(dataDir);await store.backup(path.join(dest,'gateway.sqlite'));
    const media=path.join(dataDir,'media');privateDir(path.join(dest,'media'));
    const files=['gateway.sqlite'];
    if(fs.existsSync(media))for(const f of fs.readdirSync(media)){
      ensure(/^[0-9a-f-]{36}$/.test(f)&&fs.lstatSync(path.join(media,f)).isFile()&&!fs.lstatSync(path.join(media,f)).isSymbolicLink(),'unsafe_backup_media');
      fs.copyFileSync(path.join(media,f),path.join(dest,'media',f),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(dest,'media',f),0o600);files.push('media/'+f);
    }
    fs.writeFileSync(path.join(dest,'manifest.json'),JSON.stringify({schema:1,files:Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(dest,f)))]))},null,2),{flag:'wx',mode:0o600});
    return {backup:dest,files:files.length,containsPrivateData:true};
  }finally{store?.close();await release();}
}
export async function restoreData(source,dest){
  ensure(!fs.existsSync(dest),'restore_requires_new_directory');
  const m=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));ensure(m.schema===1&&m.files['gateway.sqlite'],'invalid_backup');
  for(const [f,digest] of Object.entries(m.files)){
    ensure(f==='gateway.sqlite'||/^media\/[0-9a-f-]{36}$/.test(f),'unsafe_backup_path');
    const p=path.join(source,f);ensure(!fs.lstatSync(p).isSymbolicLink()&&fs.lstatSync(p).isFile(),'unsafe_backup_file');ensure(hash(fs.readFileSync(p))===digest,'backup_hash_mismatch');
  }
  privateDir(dest);privateDir(path.join(dest,'media'));
  for(const f of Object.keys(m.files)){fs.copyFileSync(path.join(source,f),path.join(dest,f),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(dest,f),0o600);}
  const store=new Store(dest);try{
    ensure(store.one('PRAGMA integrity_check').integrity_check==='ok','database_integrity_failed');
    store.tx(()=>{
      store.run("UPDATE replies SET state='uncertain',error='restore_requires_reconciliation' WHERE state IN ('pending','sending')");
      store.run("UPDATE notifications SET state='uncertain',error='restore_requires_reconciliation' WHERE state IN ('pending','sending')");
      store.run("UPDATE subscriptions SET active=0,secret='revoked',old_secret=NULL");
      store.run("UPDATE events SET state='cancelled' WHERE state IN ('pending','sending','expired')");
      store.run("DELETE FROM meta WHERE k IN ('qq.session','qq.seq')");store.audit('restored_quarantined');
    });
  }finally{store.close();}
  return {restored:dest,subscriptions:'revoked',pendingReplies:'uncertain',pendingNotifications:'uncertain'};
}
