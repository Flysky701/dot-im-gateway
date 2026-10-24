import {secret} from '../config.js';
import {ensure,str,hash,canonical,parseJson,Fault} from '../util.js';
import {receiveQQMedia} from './qq-media.js';
export class QQ {
  constructor(c,store,send,clock=Date.now,media=null){Object.assign(this,{c,store,send,clock,media});this.token=null;this.tokenExpires=0;}
  get apiHost(){return this.c.apiProfile==='documented'?'api.bot.qq.com':'api.sgroup.qq.com';}
  async accessToken(){
    if(this.token&&this.tokenExpires>this.clock()+60000)return this.token;
    const host=this.c.apiProfile==='documented'?'api.bot.qq.com':'bots.qq.com';
    const r=await this.send(`https://${host}/app/getAppAccessToken`,{hosts:[host],headers:{'Content-Type':'application/json'},body:Buffer.from(canonical({appId:this.c.appId,clientSecret:secret(this.c.secretEnv)}))});
    const d=parseJson(r.body);ensure(r.status===200&&typeof d.access_token==='string'&&Number(d.expires_in)>60,'qq_token_rejected');
    this.token=d.access_token;this.tokenExpires=this.clock()+Number(d.expires_in)*1000;return this.token;
  }
  async gateway(){
    const token=await this.accessToken();
    const r=await this.send(`https://${this.apiHost}/gateway/bot`,{hosts:[this.apiHost],method:'GET',headers:{Authorization:`QQBot ${token}`,'X-Bot-Appid':this.c.appId}});
    if(r.status===401)this.token=null;
    ensure(r.status===200,'qq_gateway_rejected');const d=parseJson(r.body);str(d.url,2048);return {...d,token};
  }
  normalize(p){
    ensure(p.op===0&&p.t==='C2C_MESSAGE_CREATE','unsupported_message');const d=p.d;
    ensure(d?.author?.user_openid===this.c.ownerId,'owner_mismatch');
    const attachments=d.attachments??[];
    ensure(Array.isArray(attachments)&&attachments.length<=8,'unsupported_message');
    ensure(!d.author.bot&&!d.group_openid&&!d.guild_id&&!d.channel_id&&!d.message_reference&&!d.ark_data&&(!d.msg_elements||d.msg_elements.length===0)&&(d.message_type===undefined||d.message_type===0||d.message_type===7&&attachments.length>0),'unsupported_message');
    ensure(!attachments.length||this.media,'qq_media_unsupported');
    str(d.id);const text=d.content??'';if(text)str(text,4000);else ensure(attachments.length>0,'unsupported_message');
    ensure(typeof text==='string','unsupported_message');
    const created=Date.parse(d.timestamp);ensure(Number.isFinite(created)&&created<=this.clock()+30000,'invalid_timestamp');
    const message={id:'msg_'+hash('qq:'+d.id),platform:'qq',sourceId:d.id,owner:this.c.ownerId,conversation:this.c.ownerId,text,media:[],context:'',created,expires:created+this.c.replyTtlMs};
    if(!attachments.length)return message;
    const owner=this.c.ownerId,appId=this.c.appId;
    const downloadToken=async()=>{
      const check=()=>ensure(this.c.enabled&&owner===this.c.ownerId&&appId===this.c.appId,'binding_revoked');
      check();let token;try{token=await this.accessToken();}catch{throw new Fault('attachment_download_auth_unavailable');}check();return token;
    };
    return receiveQQMedia(message.id,attachments,this.media,this.send,downloadToken).then(media=>({...message,media}));
  }
  receive(p){
    // Checkpoint only after durable packet insertion. Replay duplicates are harmless.
    if(p.op===0&&p.t==='C2C_MESSAGE_CREATE'&&p.d?.author?.user_openid===this.c.ownerId){str(p.d.id);this.store.checkpoint('qq',[{key:p.d.id,raw:p}],'qq.seq',p.s,this.clock());}
    else if(Number.isSafeInteger(p.s))this.store.set('qq.seq',p.s);
  }
  async sendReply(m,r){
    ensure(m.owner===this.c.ownerId&&m.conversation===this.c.ownerId,'owner_mismatch');const p=JSON.parse(r.payload);
    ensure(Boolean(p.text)!==Boolean(p.media_id),'one_reply_content_required');
    let file;if(p.media_id){ensure(this.media,'qq_media_unsupported');file=this.media.get(p.media_id,m.media_message_id||m.id);}else str(p.text,4000);
    const owner=m.owner,appId=this.c.appId;
    let token;try{token=await this.accessToken();}catch{throw new Fault('qq_token_unavailable','retry');}
    ensure(m.expires>this.clock(),'reply_window_expired');
    const seq=r.seq??(r.phase==='ack'?1:this.store.one("SELECT 1 FROM replies WHERE message_id=? AND phase='ack' AND state='accepted'",m.id)?2:1);
    ensure(seq===1||seq===2,'invalid_reply_sequence');
    const body=file?{msg_type:7,media:{file_info:await this.uploadFile(file,token,owner,appId)}}:{msg_type:0,content:p.text};
    ensure(m.expires>this.clock(),'reply_window_expired');
    return this.sendText({...body,msg_id:m.source_id,msg_seq:seq},token,owner,appId);
  }
  async uploadFile(file,token,owner,appId){
    ensure(this.c.enabled&&owner===this.c.ownerId&&appId===this.c.appId,'binding_revoked');
    let res;
    try{res=await this.send(`https://${this.apiHost}/v2/users/${encodeURIComponent(owner)}/files`,{hosts:[this.apiHost],headers:{Authorization:`QQBot ${token}`,'X-Bot-Appid':appId,'Content-Type':'application/json'},body:Buffer.from(canonical({file_type:file.mime==='image/png'||file.mime==='image/jpeg'?1:4,file_data:file.data.toString('base64'),file_name:file.name,srv_send_msg:false})),timeout:20000});}
    catch{throw new Fault('qq_media_upload_failed','retry');}
    // This call never sends a user message, so its transport/5xx failures are
    // retryable. The later /messages result retains normal uncertain handling.
    if(res.status===401){this.token=null;throw new Fault('qq_token_expired','retry');}
    if(res.status===429||res.status>=500)throw new Fault('qq_media_upload_unavailable','retry');
    ensure(res.status>=200&&res.status<300,'qq_media_upload_rejected');
    let data;try{data=parseJson(res.body);}catch{throw new Fault('qq_media_upload_invalid_response','retry');}
    ensure((data.code===undefined||data.code===0)&&(data.err_code===undefined||data.err_code===0),'qq_media_upload_rejected');
    if(typeof data.file_info!=='string'||!data.file_info||data.file_info.length>65536)throw new Fault('qq_media_upload_invalid_response','retry');
    return data.file_info;
  }
  async sendNotification(r){
    ensure(this.c.enabled&&this.c.ownerId&&this.c.appId,'binding_required');
    const p=JSON.parse(r.payload);str(p.text,4000);
    const owner=this.c.ownerId,appId=this.c.appId;
    let token;try{token=await this.accessToken();}catch{throw new Fault('qq_token_unavailable','retry');}
    // No inbound ID, sequence, group or caller-controlled recipient. QQ's active
    // C2C path is still subject to the account's platform permission and quota.
    ensure(r.expires>this.clock(),'notification_expired');
    return this.sendText({msg_type:0,content:p.text},token,owner,appId);
  }
  async sendText(body,token,owner,appId){
    ensure(this.c.enabled&&owner===this.c.ownerId&&appId===this.c.appId,'binding_revoked');
    const res=await this.send(`https://${this.apiHost}/v2/users/${encodeURIComponent(owner)}/messages`,{hosts:[this.apiHost],headers:{Authorization:`QQBot ${token}`,'X-Bot-Appid':appId,'Content-Type':'application/json'},body:Buffer.from(canonical(body))});
    if(res.status===401){this.token=null;throw new Fault('qq_token_expired','retry');}
    if(res.status===429)throw new Fault('qq_rate_limit','retry');
    if(res.status>=500)throw new Fault('qq_server_error','uncertain');
    ensure(res.status>=200&&res.status<300,'qq_send_rejected');
    let d;try{d=parseJson(res.body);}catch{throw new Fault('qq_invalid_response','uncertain');}
    ensure((d.code===undefined||d.code===0)&&(d.err_code===undefined||d.err_code===0),'qq_send_rejected');
    if(typeof d.id!=='string'||!d.id)throw new Fault('qq_acknowledgement_unknown','uncertain');return d.id;
  }
}
