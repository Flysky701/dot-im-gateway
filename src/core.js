import {hash,canonical,ensure,Fault,exact,str} from './util.js';
import {NOTIFICATION_LIMITS} from './store.js';
// Meta rows owned by one platform binding: the owner/bot record and that platform's
// sync state. A failed handoff restores exactly these for a platform it added.
export const bindingKeys=p=>['binding.'+p,...(p==='qq'?['qq.session','qq.seq']:['weixin.cursor'])];
export const bindingValue=(config,p)=>hash(canonical([config.principal,p,config[p].ownerId,config[p][p==='qq'?'appId':'botId']]));
export class Core {
  constructor(store,config,media,adapters,clock=Date.now){
    Object.assign(this,{store,config,media,adapters,clock});this.busy=false;
    // Per-platform owner binding: adding a second platform keeps existing data, but
    // swapping the owner or bot of an already bound platform requires a new data directory.
    const legacy=store.get('binding');
    if(legacy){
      // v0.1 stored one combined hash. Accept it when each platform is either unchanged
      // or was unbound at that time (a platform added later), then migrate.
      const q=[config.qq.ownerId,config.qq.appId],w=[config.weixin.ownerId,config.weixin.botId],blank=['',''];
      ensure([[q,w],[blank,w],[q,blank],[blank,blank]].some(([a,b])=>legacy===hash(canonical([config.principal,...a,...b]))),'binding_changed_new_data_directory_required');
      store.run("DELETE FROM meta WHERE k='binding'");
    }
    for(const p of ['qq','weixin']){
      if(!config[p].ownerId)continue;
      const value=bindingValue(config,p),old=store.get('binding.'+p);
      ensure(!old||old===value,'binding_changed_new_data_directory_required');store.set('binding.'+p,value);
    }
  }
  authorize(m){ensure(this.config[m.platform].enabled && m.owner===this.config[m.platform].ownerId&&m.conversation===m.owner,'binding_revoked');}
  reply(args){
    exact(args,['message_id','phase','text','media_id']);str(args.message_id);const m=this.store.message(args.message_id);this.authorize(m);
    ensure(args.phase==='ack'||args.phase==='final');ensure(Boolean(args.text)!==Boolean(args.media_id),'one_reply_content_required');
    if(args.media_id){ensure(m.platform==='weixin'&&args.phase==='final','unsupported_media_reply');this.media.get(args.media_id,m.id);}else str(args.text,m.platform==='qq'?4000:16000);
    return this.store.enqueue(m.id,args.phase,args.media_id?{media_id:args.media_id}:{text:args.text},this.clock());
  }
  notificationCapabilities(){
    const bound=p=>Boolean(this.config[p].enabled&&this.config[p].ownerId&&this.config[p][p==='qq'?'appId':'botId']&&this.store.get('binding.'+p)===bindingValue(this.config,p));
    return {qq:{implemented:true,bound:bound('qq'),mode:this.config.mode,platform_permission:'unverified',phone_delivery:'unknown'},
      weixin:{implemented:true,experimental:true,bound:bound('weixin'),mode:this.config.mode,platform_permission:'unverified',context_modes:['none','latest'],phone_delivery:'unknown',context_available:Boolean(this.store.one("SELECT 1 FROM messages WHERE platform='weixin' AND owner=? AND conversation=? AND context<>'' AND expires>? LIMIT 1",this.config.weixin.ownerId,this.config.weixin.ownerId,this.clock()))},
      local_limits:NOTIFICATION_LIMITS,scheduler:'external_agent'};
  }
  notify(args){
    exact(args,['platform','idempotency_key','text','context_mode']);ensure(['qq','weixin'].includes(args.platform),'platform_required');
    ensure(typeof args.idempotency_key==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotency_key),'invalid_idempotency_key');str(args.text,args.platform==='qq'?4000:16000);
    ensure(args.text.trim().length>0,'notification_text_required');
    const capability=this.notificationCapabilities()[args.platform];ensure(capability.bound,'binding_required');
    const mode=args.context_mode??(args.platform==='qq'?'none':undefined);
    ensure(['none','latest'].includes(mode),'context_mode_required');ensure(args.platform!=='qq'||mode==='none','qq_context_mode_unsupported');
    ensure(this.config.mode==='live','notification_live_mode_required');
    return this.store.enqueueNotification(args.platform,bindingValue(this.config,args.platform),args.idempotency_key,{text:args.text,context_mode:mode},this.clock());
  }
  notificationStatus(id){
    const row=this.store.one('SELECT platform,binding FROM notifications WHERE id=?',id);ensure(row,'notification_not_found');
    ensure(['qq','weixin'].includes(row.platform)&&row.binding===bindingValue(this.config,row.platform),'binding_revoked');
    return this.store.notification(id);
  }
  messageTiming(id){
    const route=this.store.one('SELECT platform,owner,conversation FROM messages WHERE id=?',id);ensure(route,'message_not_found');this.authorize(route);
    return this.store.timing(id);
  }
  async sendNotification(){
    const now=this.clock();
    this.store.run("UPDATE notifications SET state='rejected',error='notification_expired' WHERE state='pending' AND expires<=?",now);
    const r=this.store.one("SELECT n.* FROM notifications n WHERE n.state='pending' AND n.due<=? AND NOT EXISTS(SELECT 1 FROM notifications recent WHERE recent.platform=n.platform AND recent.last_started_at>?) ORDER BY n.rowid LIMIT 1",now,now-NOTIFICATION_LIMITS.minimumAttemptIntervalMs);if(!r)return;
    try{ensure(['qq','weixin'].includes(r.platform)&&this.config[r.platform].enabled&&r.binding===bindingValue(this.config,r.platform)&&r.binding===this.store.get('binding.'+r.platform),'binding_revoked');}
    catch{this.store.run("UPDATE notifications SET state='cancelled',error='binding_revoked' WHERE id=?",r.id);return;}
    this.store.run("UPDATE notifications SET state='sending',attempts=attempts+1,started_at=COALESCE(started_at,?),last_started_at=? WHERE id=?",now,now,r.id);
    try{
      const provider=await this.adapters[r.platform].sendNotification(r);
      this.store.run("UPDATE notifications SET state='accepted',provider_id=?,accepted_at=?,error=NULL WHERE id=?",provider,this.clock(),r.id);
    }catch(e){
      const kind=e instanceof Fault?e.kind:'uncertain';
      const state=kind==='uncertain'?'uncertain':kind==='retry'&&r.attempts+1<NOTIFICATION_LIMITS.maxAttempts?'pending':'rejected';
      this.store.run('UPDATE notifications SET state=?,due=?,error=? WHERE id=?',state,this.clock()+Math.max(NOTIFICATION_LIMITS.minimumAttemptIntervalMs,Math.min(300000,1000*2**r.attempts)),e instanceof Fault?e.code:'send_result_unknown',r.id);
    }
  }
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      for(const row of this.store.all("SELECT * FROM inbox WHERE state='pending' AND due<=? AND ((platform='qq' AND ?=1) OR (platform='weixin' AND ?=1)) ORDER BY rowid LIMIT 10",this.clock(),Number(this.config.qq.enabled),Number(this.config.weixin.enabled))){
        try{
          if(!this.config[row.platform].enabled)continue;
          const raw=JSON.parse(row.raw);const m=await this.adapters[row.platform].normalize(raw);
          this.authorize(m);this.store.accept(m,this.clock());
          this.store.run("UPDATE inbox SET state='accepted',raw='{}' WHERE id=?",row.id);
        }catch(e){
          if(e.kind==='retry'||e.kind==='uncertain'){
            this.store.run('UPDATE inbox SET attempts=attempts+1,due=? WHERE id=?',this.clock()+Math.min(300000,1000*2**Math.min(row.attempts,9)),row.id);continue;
          }
          this.store.run("UPDATE inbox SET state='rejected',raw='{}',error=? WHERE id=?",e instanceof Fault?e.code:'invalid_message',row.id);
        }
      }
      for(let slot=0;slot<10;slot++){
        this.store.run("UPDATE replies SET state='rejected',error='reply_window_expired' WHERE state='pending' AND message_id IN (SELECT id FROM messages WHERE expires<=?)",this.clock());
        this.store.run("UPDATE replies SET state='cancelled',error='ack_terminal' WHERE state='pending' AND phase='final' AND message_id IN (SELECT message_id FROM replies WHERE phase='ack' AND state IN ('rejected','cancelled'))");
        const r=this.store.one("SELECT r.* FROM replies r WHERE r.state='pending' AND r.due<=? AND (r.phase='ack' OR EXISTS(SELECT 1 FROM replies a WHERE a.message_id=r.message_id AND a.phase='ack' AND a.state='accepted')) ORDER BY r.rowid LIMIT 1",this.clock());
        if(!r)break;
        const m=this.store.message(r.message_id);
        try{this.authorize(m);ensure(m.expires>this.clock(),'reply_window_expired');}catch(e){this.store.run("UPDATE replies SET state='rejected',error=? WHERE id=?",e.code,r.id);continue;}
        const started=this.clock();this.store.run("UPDATE replies SET state='sending',attempts=attempts+1,started_at=COALESCE(started_at,?),last_started_at=? WHERE id=? AND state='pending'",started,started,r.id);
        try{
          const provider=await this.adapters[m.platform].sendReply(m,r);
          this.store.run("UPDATE replies SET state='accepted',provider_id=?,accepted_at=?,error=NULL WHERE id=?",provider,this.clock(),r.id);
        }catch(e){
          const kind=e instanceof Fault?e.kind:'uncertain';
          const state=kind==='uncertain'?'uncertain':kind==='retry'&&r.attempts<7?'pending':'rejected';
          this.store.run('UPDATE replies SET state=?,due=?,error=? WHERE id=?',state,this.clock()+Math.min(300000,1000*2**r.attempts),e instanceof Fault?e.code:'send_result_unknown',r.id);
        }
      }
      await this.sendNotification();
    }finally{this.busy=false;}
  }
}
