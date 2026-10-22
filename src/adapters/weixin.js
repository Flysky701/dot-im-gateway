import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {ensure,str,Fault,hash,canonical,parseJson} from '../util.js';
import {secret} from '../config.js';
import {detect} from '../media.js';
export function aes(data,key,decrypt=false){ensure(key.length===16,'invalid_media_key');const c=decrypt?createDecipheriv('aes-128-ecb',key,null):createCipheriv('aes-128-ecb',key,null);return Buffer.concat([c.update(data),c.final()]);}
export function mediaKey(item){
  if(item.aeskey){ensure(/^[0-9a-fA-F]{32}$/.test(item.aeskey),'invalid_media_key');return Buffer.from(item.aeskey,'hex');}
  const b=Buffer.from(str(item.media?.aes_key,128),'base64');
  if(b.length===16)return b;
  ensure(b.length===32&&/^[0-9a-fA-F]{32}$/.test(b.toString()),'invalid_media_key');return Buffer.from(b.toString(),'hex');
}
export class Weixin {
  constructor(c,store,media,send,clock=Date.now){Object.assign(this,{c,store,media,send,clock});this.pausedUntil=0;}
  async api(endpoint,body,timeout=20000){
    const r=await this.send(`https://${this.c.apiHost}/ilink/bot/${endpoint}`,{hosts:[this.c.apiHost],timeout,
      headers:{'Content-Type':'application/json',AuthorizationType:'ilink_bot_token',Authorization:`Bearer ${secret(this.c.tokenEnv)}`,'X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),'iLink-App-Id':'bot','iLink-App-ClientVersion':String((2<<16)|(4<<8)|10)},
      body:Buffer.from(canonical({...body,base_info:{channel_version:'2.4.10',bot_agent:'DotIMGateway/0.1.0'}}))});
    if(r.status===429)throw new Fault('weixin_rate_limit','retry');
    if(r.status>=500)throw new Fault('weixin_server_error','uncertain');
    ensure(r.status>=200&&r.status<300,'weixin_http_rejected');
    let data;try{data=parseJson(r.body);}catch{throw new Fault('weixin_invalid_response','uncertain');}
    if(data.ret===-14||data.errcode===-14){this.pausedUntil=this.clock()+3600000;throw new Fault('weixin_session_expired');}
    ensure((data.ret===undefined||data.ret===0)&&(data.errcode===undefined||data.errcode===0),'weixin_rejected');return data;
  }
  authorized(raw){return raw.message_type===1 && raw.message_state===2 && !raw.group_id && raw.from_user_id===this.c.ownerId && raw.to_user_id===this.c.botId;}
  async poll(){
    if(this.clock()<this.pausedUntil)return;
    const d=await this.api('getupdates',{get_updates_buf:this.store.get('weixin.cursor')||''},40000);
    ensure(Array.isArray(d.msgs||[])&&(d.msgs||[]).length<=100,'weixin_invalid_batch');
    str(d.get_updates_buf||this.store.get('weixin.cursor')||'empty',65536);
    const records=(d.msgs||[]).filter(m=>this.authorized(m)).map(raw=>{const key=String(raw.message_id);ensure(/^[0-9a-zA-Z_-]{1,256}$/.test(key),'invalid_message_id');return {key,raw};});
    this.store.checkpoint('weixin',records,'weixin.cursor',d.get_updates_buf??this.store.get('weixin.cursor')??'');
  }
  async normalize(raw){
    ensure(this.authorized(raw),'owner_mismatch');str(raw.context_token,8192);
    const sourceId=String(raw.message_id);ensure(/^[0-9a-zA-Z_-]{1,256}$/.test(sourceId));
    const created=Number(raw.create_time_ms);ensure(Number.isSafeInteger(created)&&created<=this.clock()+30000,'invalid_timestamp');
    const id='msg_'+hash('weixin:'+sourceId),items=raw.item_list;ensure(Array.isArray(items)&&items.length>0&&items.length<=8,'unsupported_message');
    let text='',media=[];
    try{
    for(const item of items){
      if(item.type===1){text+=str(item.text_item?.text,16000)+'\n';continue;}
      ensure(item.type===2||item.type===4,'unsupported_message');
      const detail=item.type===2?item.image_item:item.file_item;ensure(detail?.media,'unsupported_media');
      if(item.type===4)ensure(typeof detail.file_name==='string'&&/\.pdf$/i.test(detail.file_name),'pdf_only');
      const url=detail.media.full_url || `https://${this.c.cdnHost}/c2c/download?encrypted_query_param=${encodeURIComponent(str(detail.media.encrypt_query_param,8192))}`;
      const r=await this.send(url,{hosts:[this.c.cdnHost],method:'GET',limit:this.media.config.maxMediaBytes+16,timeout:20000});
      if(r.status>=500||r.status===429)throw new Fault('media_download_retry','retry');
      ensure(r.status===200,'media_download_rejected');
      let bytes;try{bytes=aes(r.body,mediaKey(detail),true);}catch{throw new Fault('media_decryption_failed');}
      const mime=detect(bytes);ensure(item.type===4?mime==='application/pdf':mime.startsWith('image/'),'media_type_mismatch');
      if(detail.len!==undefined)ensure(String(bytes.length)===String(detail.len),'media_length_mismatch');
      if(detail.md5)ensure(createHash('md5').update(bytes).digest('hex')===detail.md5,'media_hash_mismatch');
      media.push(this.media.put(id,bytes,mime,detail.file_name));
    }
    ensure(text.length<=16000,'text_limit');
    return {id,platform:'weixin',sourceId,owner:this.c.ownerId,conversation:this.c.ownerId,text:text.trim(),media,context:raw.context_token,created,expires:created+this.c.replyTtlMs};
    }catch(e){
      if(e.kind!=='retry'&&e.kind!=='uncertain')this.media.discardUnaccepted(id);
      throw e;
    }
  }
  async sendReply(m,r){
    ensure(m.owner===this.c.ownerId && m.conversation===this.c.ownerId,'owner_mismatch');
    ensure(m.expires>this.clock()&&m.context,'reply_window_expired');
    const payload=JSON.parse(r.payload);let item;
    if(payload.media_id){
      const f=this.media.get(payload.media_id,m.id),key=randomBytes(16),filekey=randomBytes(16).toString('hex'),cipher=aes(f.data,key);
      let u;
      try{u=await this.api('getuploadurl',{filekey,media_type:f.mime==='application/pdf'?3:1,to_user_id:m.owner,rawsize:f.size,rawfilemd5:createHash('md5').update(f.data).digest('hex'),filesize:cipher.length,no_need_thumb:true,aeskey:key.toString('hex')});}
      catch(e){throw new Fault(e.code||'upload_prepare_failed',e.kind==='uncertain'?'retry':e.kind);}
      const url=u.upload_full_url||`https://${this.c.cdnHost}/c2c/upload?encrypted_query_param=${encodeURIComponent(str(u.upload_param,8192))}&filekey=${filekey}`;
      let up;try{up=await this.send(url,{hosts:[this.c.cdnHost],body:cipher,headers:{'Content-Type':'application/octet-stream'},timeout:20000});}catch{throw new Fault('media_upload_failed','retry');}
      ensure(up.status===200&&typeof up.headers['x-encrypted-param']==='string','media_upload_rejected');
      const ref={encrypt_query_param:up.headers['x-encrypted-param'],aes_key:Buffer.from(key.toString('hex')).toString('base64'),encrypt_type:1};
      item=f.mime==='application/pdf'?{type:4,file_item:{media:ref,file_name:f.name,len:String(f.size)}}:{type:2,image_item:{media:ref,mid_size:cipher.length}};
    }else item={type:1,text_item:{text:payload.text}};
    ensure(m.expires>this.clock(),'reply_window_expired');
    const d=await this.api('sendmessage',{msg:{from_user_id:'',to_user_id:m.owner,client_id:r.id,message_type:2,message_state:2,item_list:[item],context_token:m.context}});
    // ret=0 means server acceptance, not human delivery/read receipt.
    if(d.ret!==0 && !d.message_id)throw new Fault('weixin_acknowledgement_unknown','uncertain');
    return d.message_id?String(d.message_id):r.id;
  }
}
