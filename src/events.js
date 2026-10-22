import {createHmac,randomBytes} from 'node:crypto';
import {canonical,hash,ensure,str,same,iso,Fault,exact,parseJson} from './util.js';
import {safeURL} from './network.js';
export function signingKey(secret){str(secret,128);ensure(/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret),'invalid_signing_secret');const k=Buffer.from(secret.slice(6),'base64');ensure(k.length>=24&&k.length<=64&&k.toString('base64')===secret.slice(6),'invalid_signing_secret');return k;}
export function signature(secret,id,time,body){return 'v1,'+createHmac('sha256',signingKey(secret)).update(`${id}.${time}.`).update(body).digest('base64');}
export class Events {
  constructor(store,c,send,clock=Date.now){Object.assign(this,{store,c,send,clock});this.verified=new Map();this.revisions=new Map();}
  identity(p){
    exact(p,['name','arguments','delivery','cursor','ttlMs']);ensure(p.name==='message.created');exact(p.arguments,['platform']);ensure(['qq','weixin'].includes(p.arguments.platform));
    ensure(this.c[p.arguments.platform].enabled,'platform_disabled');
    exact(p.delivery,['mode','url','secret']);ensure(p.delivery.mode==='webhook');safeURL(p.delivery.url,this.c.callbackHosts);
    ensure(p.cursor===undefined||p.cursor===null,'replay_not_supported');
    return 'sub_'+hash(canonical([this.c.principal,p.delivery.url,p.name,p.arguments]));
  }
  async subscribe(p){
    ensure(this.c.allowSubscriptions,'subscription_gate_closed');const id=this.identity(p),now=this.clock();signingKey(p.delivery.secret);
    ensure(this.store.one('SELECT count(*) n FROM subscriptions WHERE active=1').n<16||this.store.one('SELECT id FROM subscriptions WHERE id=?',id),'subscription_limit');
    const revision=(this.revisions.get(id)||0)+1;this.revisions.set(id,revision);
    ensure(p.ttlMs===undefined||p.ttlMs===null||(Number.isSafeInteger(p.ttlMs)&&p.ttlMs>0),'invalid_ttl');
    const ttl=p.ttlMs==null?3600000:Math.min(p.ttlMs,86400000);
    const cacheKey=hash(canonical([this.c.principal,p.delivery.url,p.delivery.secret]));
    if((this.verified.get(cacheKey)||0)<=now){
      const challenge=randomBytes(32).toString('hex'),body=Buffer.from(canonical({type:'verification',challenge}));
      const vid='verify_'+randomBytes(16).toString('hex');let response;
      try{response=await this.post({id,url:p.delivery.url,secret:p.delivery.secret},vid,body);}catch(e){throw new Fault(e.code==='destination_denied'||e.code==='non_public_destination'?'callback_denied':'callback_timeout');}
      let echoed;try{echoed=parseJson(response.body).challenge;}catch{throw new Fault('challenge_failed');}
      ensure(response.status>=200&&response.status<300&&typeof echoed==='string'&&same(echoed,challenge)&&this.clock()-now<15000,'challenge_failed');
      if(this.verified.size>=64)this.verified.clear();this.verified.set(cacheKey,now+300000);
    }
    ensure(this.revisions.get(id)===revision,'subscription_superseded');
    this.store.tx(()=>{
      const old=this.store.one('SELECT * FROM subscriptions WHERE id=?',id);
      const rotated=old?.active&&old.secret!==p.delivery.secret;
      const oldSecret=rotated?old.secret:(old?.active&&old.rotation_until>now?old.old_secret:null);
      this.store.run(`INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,old_secret=excluded.old_secret,rotation_until=excluded.rotation_until,expires=excluded.expires,active=1`,id,this.c.principal,p.arguments.platform,p.delivery.url,p.delivery.secret,oldSecret,rotated?now+300000:(old?.rotation_until||0),now+ttl);
      const sub=this.store.one('SELECT * FROM subscriptions WHERE id=?',id);
      for(const m of this.store.all("SELECT * FROM messages WHERE platform=? AND NOT EXISTS(SELECT 1 FROM replies WHERE message_id=messages.id AND phase='final' AND state='accepted')",p.arguments.platform))this.store.event(sub,m);
      this.store.run("UPDATE events SET state='pending',attempts=0,due=0 WHERE sub_id=? AND state='expired'",id);
    });
    return {id,refreshBefore:iso(now+ttl),cursor:null,truncated:false};
  }
  unsubscribe(p){const id=this.identity(p);this.revisions.set(id,(this.revisions.get(id)||0)+1);this.verified.clear();this.store.tx(()=>{this.store.run('UPDATE subscriptions SET active=0,secret=?,old_secret=NULL WHERE id=?','revoked',id);this.store.run("UPDATE events SET state='cancelled' WHERE sub_id=? AND state IN ('pending','sending','expired')",id);});return {};}
  async post(sub,id,body){
    ensure(body.length<=262144,'event_size_limit');const stamp=String(Math.floor(this.clock()/1000));let sig=signature(sub.secret,id,stamp,body);
    if(sub.old_secret&&sub.rotation_until>this.clock())sig+=' '+signature(sub.old_secret,id,stamp,body);
    return this.send(sub.url,{hosts:this.c.callbackHosts,body,timeout:10000,limit:16384,headers:{'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':stamp,'webhook-signature':sig,'X-MCP-Subscription-Id':sub.id}});
  }
  async tick(){
    const now=this.clock();this.store.run('UPDATE subscriptions SET old_secret=NULL WHERE rotation_until<=?',now);
    const rows=this.store.all("SELECT * FROM events WHERE state='pending' AND due<=? ORDER BY rowid LIMIT 10",now);
    for(const e of rows){
      const sub=this.store.one('SELECT * FROM subscriptions WHERE id=?',e.sub_id);
      if(!sub.active||sub.principal!==this.c.principal||!this.c[sub.platform].enabled){this.store.run("UPDATE events SET state='cancelled' WHERE id=?",e.id);continue;}
      if(sub.expires<=now){this.store.run("UPDATE events SET state='expired' WHERE id=?",e.id);continue;}
      this.store.run("UPDATE events SET state='sending',attempts=attempts+1 WHERE id=?",e.id);
      let status=0;try{status=(await this.post(sub,e.id,Buffer.from(e.body))).status;}catch{}
      // Revocation can occur while HTTP is in flight; never reactivate its queue.
      const active=this.store.one('SELECT active FROM subscriptions WHERE id=?',sub.id).active;
      const state=!active?'cancelled':status>=200&&status<300?'accepted':status===410||status===413?'dead':(status===0||status===429||status>=500)&&e.attempts<7?'pending':'dead';
      this.store.run('UPDATE events SET state=?,due=?,error=? WHERE id=?',state,now+Math.min(300000,1000*2**e.attempts),state==='accepted'?null:'callback_delivery_failed',e.id);
      if(status===410)this.store.run('UPDATE subscriptions SET active=0 WHERE id=?',sub.id);
    }
  }
}
