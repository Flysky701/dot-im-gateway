import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
import {hash, canonical, ensure, iso} from './util.js';
import {privateDir} from './config.js';
export class Store {
  constructor(dir) {
    privateDir(dir); this.dir=dir; this.file=path.join(dir,'gateway.sqlite');
    ensure(!fs.existsSync(this.file) || !fs.lstatSync(this.file).isSymbolicLink(),'unsafe_database');
    this.db=new DatabaseSync(this.file); fs.chmodSync(this.file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,platform TEXT NOT NULL,raw TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,platform TEXT NOT NULL,source_id TEXT NOT NULL,owner TEXT NOT NULL,conversation TEXT NOT NULL,text TEXT NOT NULL,media TEXT NOT NULL,context TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,UNIQUE(platform,source_id));
      CREATE TABLE IF NOT EXISTS replies(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id),phase TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL DEFAULT 0,provider_id TEXT,error TEXT,UNIQUE(message_id,phase));
      CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY,principal TEXT NOT NULL,platform TEXT NOT NULL,url TEXT NOT NULL,secret TEXT NOT NULL,old_secret TEXT,rotation_until INTEGER,expires INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,sub_id TEXT NOT NULL REFERENCES subscriptions(id),message_id TEXT NOT NULL REFERENCES messages(id),body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(sub_id,message_id));
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,mime TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,code TEXT NOT NULL,ref TEXT);
    `);
    const version=this.get('schema'); ensure(!version || version==='1','unsupported_schema');this.set('schema','1');
  }
  close(){this.db.close();}
  run(sql,...p){return this.db.prepare(sql).run(...p);}
  one(sql,...p){return this.db.prepare(sql).get(...p);}
  all(sql,...p){return this.db.prepare(sql).all(...p);}
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  get(k){return this.one('SELECT v FROM meta WHERE k=?',k)?.v;}
  set(k,v){this.run('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',k,String(v));}
  audit(code,ref=null){this.run('INSERT INTO audit(time,code,ref) VALUES(?,?,?)',Date.now(),code,ref);this.run('DELETE FROM audit WHERE seq < (SELECT COALESCE(MAX(seq),0)-10000 FROM audit)');}
  recover(){this.run("UPDATE replies SET state='uncertain',error='restart_during_send' WHERE state='sending'");this.run("UPDATE events SET state='pending' WHERE state='sending'");}
  checkpoint(platform,records,cursorKey,cursor){
    return this.tx(()=>{
      for(const r of records){this.run('INSERT OR IGNORE INTO inbox(id,platform,raw) VALUES(?,?,?)',hash(platform+':'+r.key),platform,canonical(r.raw));}
      this.set(cursorKey,cursor);
    });
  }
  accept(m,now){
    return this.tx(()=>{
      this.run('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)',m.id,m.platform,m.sourceId,m.owner,m.conversation,m.text,canonical(m.media||[]),m.context||'',m.created,m.expires);
      for(const sub of this.all('SELECT * FROM subscriptions WHERE active=1 AND expires>? AND platform=?',now,m.platform))this.event(sub,m);
      return m.id;
    });
  }
  event(sub,m){
    const id='evt_'+hash(sub.id+':'+m.id);
    const body={eventId:id,name:'message.created',timestamp:iso(m.created),data:{message_id:m.id,platform:m.platform},cursor:null};
    this.run('INSERT OR IGNORE INTO events(id,sub_id,message_id,body) VALUES(?,?,?,?)',id,sub.id,m.id,canonical(body));
  }
  message(id){const r=this.one('SELECT * FROM messages WHERE id=?',id);ensure(r,'message_not_found');return r;}
  publicMessage(id){const m=this.message(id);return {id:m.id,platform:m.platform,text:m.text,media:JSON.parse(m.media),created:iso(m.created),expires:iso(m.expires),replies:this.all('SELECT id,phase,state,provider_id,error FROM replies WHERE message_id=?',id)};}
  pending(){return this.all("SELECT m.id FROM messages m WHERE NOT EXISTS(SELECT 1 FROM replies r WHERE r.message_id=m.id AND r.phase='final' AND r.state='accepted') ORDER BY m.created LIMIT 50").map(r=>this.publicMessage(r.id));}
  enqueue(id,phase,payload){
    return this.tx(()=>{
      this.message(id);ensure(['ack','final'].includes(phase));
      const body=canonical(payload),existing=this.one('SELECT * FROM replies WHERE message_id=? AND phase=?',id,phase);
      if(existing){ensure(existing.payload===body,'reply_conflict');return {id:existing.id,state:existing.state};}
      if(phase==='final')ensure(this.one("SELECT id FROM replies WHERE message_id=? AND phase='ack'",id),'ack_required');
      const rid='reply_'+hash(id+':'+phase);this.run('INSERT INTO replies(id,message_id,phase,payload) VALUES(?,?,?,?)',rid,id,phase,body);
      return {id:rid,state:'pending'};
    });
  }
  resolve(id,decision){
    ensure(['accepted','cancelled'].includes(decision));
    ensure(this.run("UPDATE replies SET state=?,error='operator_reconciled' WHERE id=? AND state='uncertain'",decision,id).changes===1,'not_uncertain');this.audit('operator_reconciled',id);
  }
  async backup(dest){ensure(!fs.existsSync(dest),'backup_exists');await backup(this.db,dest);fs.chmodSync(dest,0o600);}
  status(){return {schema:1,messages:this.one('SELECT count(*) n FROM messages').n,inbox:this.all('SELECT state,count(*) count FROM inbox GROUP BY state'),replies:this.all('SELECT state,count(*) count FROM replies GROUP BY state'),events:this.all('SELECT state,count(*) count FROM events GROUP BY state'),subscriptions:this.one('SELECT count(*) n FROM subscriptions WHERE active=1 AND expires>?',Date.now()).n};}
}
