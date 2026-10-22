import {secret} from '../config.js';
import {ensure,str,hash,canonical,parseJson,Fault} from '../util.js';
export class QQ {
  constructor(c,store,send,clock=Date.now){Object.assign(this,{c,store,send,clock});this.token=null;this.tokenExpires=0;}
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
    ensure(!d.author.bot&&!d.group_openid&&!d.guild_id&&!d.channel_id&&!d.message_reference&&!d.ark_data&&(!d.attachments||d.attachments.length===0)&&(!d.msg_elements||d.msg_elements.length===0)&&(d.message_type===undefined||d.message_type===0),'unsupported_message');
    str(d.id);str(d.content,4000);const created=Date.parse(d.timestamp);ensure(Number.isFinite(created)&&created<=this.clock()+30000,'invalid_timestamp');
    return {id:'msg_'+hash('qq:'+d.id),platform:'qq',sourceId:d.id,owner:this.c.ownerId,conversation:this.c.ownerId,text:d.content,media:[],context:'',created,expires:created+this.c.replyTtlMs};
  }
  receive(p){
    // Checkpoint only after durable packet insertion. Replay duplicates are harmless.
    if(p.op===0&&p.t==='C2C_MESSAGE_CREATE'&&p.d?.author?.user_openid===this.c.ownerId){str(p.d.id);this.store.checkpoint('qq',[{key:p.d.id,raw:p}],'qq.seq',p.s);}
    else if(Number.isSafeInteger(p.s))this.store.set('qq.seq',p.s);
  }
  async sendReply(m,r){
    ensure(m.owner===this.c.ownerId&&m.conversation===this.c.ownerId,'owner_mismatch');const p=JSON.parse(r.payload);ensure(!p.media_id,'qq_media_unsupported');str(p.text,4000);
    let token;try{token=await this.accessToken();}catch{throw new Fault('qq_token_unavailable','retry');}
    ensure(m.expires>this.clock(),'reply_window_expired');
    const res=await this.send(`https://${this.apiHost}/v2/users/${encodeURIComponent(m.owner)}/messages`,{hosts:[this.apiHost],headers:{Authorization:`QQBot ${token}`,'X-Bot-Appid':this.c.appId,'Content-Type':'application/json'},body:Buffer.from(canonical({msg_type:0,content:p.text,msg_id:m.source_id,msg_seq:r.phase==='ack'?1:2}))});
    if(res.status===401){this.token=null;throw new Fault('qq_token_expired','retry');}
    if(res.status===429)throw new Fault('qq_rate_limit','retry');
    if(res.status>=500)throw new Fault('qq_server_error','uncertain');
    ensure(res.status>=200&&res.status<300,'qq_send_rejected');
    let d;try{d=parseJson(res.body);}catch{throw new Fault('qq_invalid_response','uncertain');}
    ensure((d.code===undefined||d.code===0)&&(d.err_code===undefined||d.err_code===0),'qq_send_rejected');
    if(typeof d.id!=='string'||!d.id)throw new Fault('qq_acknowledgement_unknown','uncertain');return d.id;
  }
}
