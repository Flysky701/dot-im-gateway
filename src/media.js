import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {ensure} from './util.js';
import {privateDir} from './config.js';
export function detect(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.length>=4 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'image/jpeg';
  if(bytes.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  throw new Error('unsupported_media');
}
export function safeMediaName(value='attachment'){
  let name=typeof value==='string'?value.replace(/\\/g,'/').split('/').pop():'';
  name=name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069:*?"<>|]/g,'_').trim().replace(/^[. ]+|[. ]+$/g,'');
  name=Array.from(name).slice(0,180).join('');
  if(/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))name='_'+name;
  return name||'attachment';
}
const textExtensions={txt:'text/plain',md:'text/markdown',csv:'text/csv',tsv:'text/tab-separated-values',json:'application/json',jsonl:'application/x-ndjson',xml:'application/xml',yaml:'text/yaml',yml:'text/yaml',log:'text/plain'};
const knownExtensions={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',pdf:'application/pdf'};
const defaultSuffix={'image/png':'.png','image/jpeg':'.jpg','application/pdf':'.pdf','text/plain':'.txt','text/markdown':'.md','text/csv':'.csv','text/tab-separated-values':'.tsv','application/json':'.json','application/x-ndjson':'.jsonl','application/xml':'.xml','text/xml':'.xml','text/yaml':'.yaml','application/yaml':'.yaml'};
export function declaredMediaType(value){
  const mime=typeof value==='string'?value.split(';',1)[0].trim().toLowerCase():'';
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime)&&mime.length<=128?mime:'application/octet-stream';
}
function qqMediaType(bytes,declared,name){
  const mime=declaredMediaType(declared),ext=path.extname(name).slice(1).toLowerCase();
  let detected;try{detected=detect(bytes);}catch{}
  // Existing PNG/JPEG/PDF signatures remain mandatory for those claimed types.
  // Other images are stored as ordinary files, never advertised as decoded images.
  const expected=knownExtensions[ext]||(['image/png','image/jpeg','application/pdf'].includes(mime)?mime:null);
  if(expected)ensure(detected===expected&&(mime==='application/octet-stream'||mime===expected),'media_type_mismatch');
  if(mime.startsWith('image/')&&!['image/png','image/jpeg'].includes(mime))return 'application/octet-stream';
  if(detected)return detected;
  return textExtensions[ext]||mime;
}
function isText(mime){return mime.startsWith('text/')||['application/json','application/x-ndjson','application/xml','application/yaml'].includes(mime);}
export class Media {
  constructor(store,config){this.store=store;this.config=config;this.dir=path.join(store.dir,'media');privateDir(this.dir);}
  put(messageId,bytes,mime,name='attachment'){
    ensure(Buffer.isBuffer(bytes) && bytes.length>0 && bytes.length<=this.config.maxMediaBytes,'media_size_limit');
    ensure(detect(bytes)===mime,'media_type_mismatch');
    const clean=mime==='application/pdf'?'attachment.pdf':mime==='image/png'?'image.png':'image.jpg';
    return this.save(messageId,bytes,mime,clean);
  }
  // QQ alone accepts ordinary files. The existing put() path stays image/PDF-only.
  putQQ(messageId,bytes,mime,name='attachment'){
    ensure(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=this.config.maxMediaBytes,'media_size_limit');
    let clean=safeMediaName(name);const type=qqMediaType(bytes,mime,clean);
    if(!path.extname(clean)){
      const suffix=defaultSuffix[type]||(type.startsWith('text/')?'.txt':'.bin');
      clean=Array.from(clean).slice(0,180-suffix.length).join('')+suffix;
    }
    return this.save(messageId,bytes,type,clean);
  }
  save(messageId,bytes,mime,clean){
    for(const m of this.store.all('SELECT * FROM media WHERE message_id=? AND mime=? AND size=?',messageId,mime,bytes.length)){
      if(m.name===clean&&this.get(m.id,messageId).data.equals(bytes))return {id:m.id,mime:m.mime,name:m.name,size:m.size};
    }
    const used=this.store.one('SELECT COALESCE(sum(size),0) n FROM media').n;ensure(used+bytes.length<=this.config.maxStoredMediaBytes,'media_quota');
    const id=randomUUID();
    fs.writeFileSync(path.join(this.dir,id),bytes,{flag:'wx',mode:0o600});
    try{this.store.run('INSERT INTO media VALUES(?,?,?,?,?,?)',id,messageId,mime,clean,bytes.length,Date.now());}catch(e){fs.unlinkSync(path.join(this.dir,id));throw e;}
    return {id,mime,name:clean,size:bytes.length};
  }
  inspect(id,messageId){
    const f=this.get(id,messageId),result={id:f.id,name:f.name,size:f.size,mime:f.mime,sha256:createHash('sha256').update(f.data).digest('hex'),content_status:f.mime.startsWith('image/')?'image_not_decoded':f.mime==='application/pdf'?'pdf_not_parsed':'binary_unparsed'};
    if(isText(f.mime)){
      try{
        const text=new TextDecoder('utf-8',{fatal:true}).decode(f.data);
        ensure(!/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text),'binary_text');
        result.content_status='utf8_text';result.preview=Array.from(text).slice(0,2000).join('');result.preview_truncated=result.preview.length<text.length;
      }catch{result.content_status='text_encoding_unrecognized';}
    }
    return result;
  }
  get(id,messageId){
    ensure(typeof id==='string' && /^[0-9a-f-]{36}$/.test(id),'invalid_media_id');
    const m=this.store.one('SELECT * FROM media WHERE id=? AND message_id=?',id,messageId);ensure(m,'media_not_found');
    const file=path.join(this.dir,id);ensure(!fs.lstatSync(file).isSymbolicLink(),'unsafe_media_file');
    const data=fs.readFileSync(file);ensure(data.length===m.size && data.length<=this.config.maxMediaBytes,'media_size_limit');return {...m,data};
  }
  discardUnaccepted(messageId){
    if(this.store.one('SELECT id FROM messages WHERE id=?',messageId))return;
    for(const m of this.store.all('SELECT id FROM media WHERE message_id=?',messageId)){
      fs.rmSync(path.join(this.dir,m.id),{force:true});this.store.run('DELETE FROM media WHERE id=?',m.id);
    }
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
