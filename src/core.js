import {hash,canonical,ensure,Fault,exact,str} from './util.js';
export class Core {
  constructor(store,config,media,adapters,clock=Date.now){
    Object.assign(this,{store,config,media,adapters,clock});this.busy=false;
    const binding=hash(canonical([config.principal,config.qq.ownerId,config.qq.appId,config.weixin.ownerId,config.weixin.botId]));
    ensure(!store.get('binding')||store.get('binding')===binding,'binding_changed_new_data_directory_required');store.set('binding',binding);
  }
  authorize(m){ensure(this.config[m.platform].enabled && m.owner===this.config[m.platform].ownerId&&m.conversation===m.owner,'binding_revoked');}
  reply(args){
    exact(args,['message_id','phase','text','media_id']);str(args.message_id);const m=this.store.message(args.message_id);this.authorize(m);
    ensure(args.phase==='ack'||args.phase==='final');ensure(Boolean(args.text)!==Boolean(args.media_id),'one_reply_content_required');
    if(args.media_id){ensure(m.platform==='weixin'&&args.phase==='final','unsupported_media_reply');this.media.get(args.media_id,m.id);}else str(args.text,m.platform==='qq'?4000:16000);
    return this.store.enqueue(m.id,args.phase,args.media_id?{media_id:args.media_id}:{text:args.text});
  }
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      for(const row of this.store.all("SELECT * FROM inbox WHERE state='pending' ORDER BY rowid LIMIT 10")){
        try{
          if(!this.config[row.platform].enabled)continue;
          const raw=JSON.parse(row.raw);const m=await this.adapters[row.platform].normalize(raw);
          this.authorize(m);this.store.accept(m,this.clock());
          this.store.run("UPDATE inbox SET state='accepted',raw='{}' WHERE id=?",row.id);
        }catch(e){
          if(e.kind==='retry'||e.kind==='uncertain')continue;
          this.store.run("UPDATE inbox SET state='rejected',raw='{}',error=? WHERE id=?",e instanceof Fault?e.code:'invalid_message',row.id);
        }
      }
      for(const r of this.store.all("SELECT * FROM replies WHERE state='pending' AND due<=? ORDER BY rowid LIMIT 10",this.clock())){
        const m=this.store.message(r.message_id);
        if(r.phase==='final'&&!this.store.one("SELECT id FROM replies WHERE message_id=? AND phase='ack' AND state='accepted'",m.id))continue;
        try{this.authorize(m);ensure(m.expires>this.clock(),'reply_window_expired');}catch(e){this.store.run("UPDATE replies SET state='rejected',error=? WHERE id=?",e.code,r.id);continue;}
        this.store.run("UPDATE replies SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'",r.id);
        try{
          const provider=await this.adapters[m.platform].sendReply(m,r);
          this.store.run("UPDATE replies SET state='accepted',provider_id=?,error=NULL WHERE id=?",provider,r.id);
        }catch(e){
          const kind=e instanceof Fault?e.kind:'uncertain';
          const state=kind==='uncertain'?'uncertain':kind==='retry'&&r.attempts<7?'pending':'rejected';
          this.store.run('UPDATE replies SET state=?,due=?,error=? WHERE id=?',state,this.clock()+Math.min(300000,1000*2**r.attempts),e instanceof Fault?e.code:'send_result_unknown',r.id);
        }
      }
    }finally{this.busy=false;}
  }
}
