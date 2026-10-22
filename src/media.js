import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensure} from './util.js';
import {privateDir} from './config.js';
export function detect(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'image/jpeg';
  if(bytes.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  throw new Error('unsupported_media');
}
export class Media {
  constructor(store,config){this.store=store;this.config=config;this.dir=path.join(store.dir,'media');privateDir(this.dir);}
  put(messageId,bytes,mime,name='attachment'){
    ensure(Buffer.isBuffer(bytes) && bytes.length>0 && bytes.length<=this.config.maxMediaBytes,'media_size_limit');
    ensure(detect(bytes)===mime,'media_type_mismatch');
    const used=this.store.one('SELECT COALESCE(sum(size),0) n FROM media').n;ensure(used+bytes.length<=this.config.maxStoredMediaBytes,'media_quota');
    const id=randomUUID(); const clean=mime==='application/pdf'?'attachment.pdf':mime==='image/png'?'image.png':'image.jpg';
    fs.writeFileSync(path.join(this.dir,id),bytes,{flag:'wx',mode:0o600});
    try{this.store.run('INSERT INTO media VALUES(?,?,?,?,?,?)',id,messageId,mime,clean,bytes.length,Date.now());}catch(e){fs.unlinkSync(path.join(this.dir,id));throw e;}
    return {id,mime,name:clean,size:bytes.length};
  }
  get(id,messageId){
    ensure(typeof id==='string' && /^[0-9a-f-]{36}$/.test(id),'invalid_media_id');
    const m=this.store.one('SELECT * FROM media WHERE id=? AND message_id=?',id,messageId);ensure(m,'media_not_found');
    const file=path.join(this.dir,id);ensure(!fs.lstatSync(file).isSymbolicLink(),'unsafe_media_file');
    const data=fs.readFileSync(file);ensure(data.length===m.size && data.length<=this.config.maxMediaBytes,'media_size_limit');return {...m,data};
  }
  clean(now=Date.now()){
    let n=0;
    for(const m of this.store.all('SELECT * FROM media WHERE created<?',now-this.config.mediaRetentionHours*3600000)){
      if(this.store.one("SELECT id FROM replies WHERE message_id=? AND state IN ('pending','sending','uncertain')",m.message_id))continue;
      fs.rmSync(path.join(this.dir,m.id),{force:true});this.store.run('DELETE FROM media WHERE id=?',m.id);n++;
    }
    // Crash-orphan files: only this private UUID namespace, never arbitrary paths.
    for(const f of fs.readdirSync(this.dir))if(/^[0-9a-f-]{36}$/.test(f)&&!this.store.one('SELECT id FROM media WHERE id=?',f)){
      const p=path.join(this.dir,f);if(fs.lstatSync(p).mtimeMs<now-3600000)fs.rmSync(p,{force:true});
    }
    return n;
  }
}
