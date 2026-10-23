import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
import {hash, canonical, ensure, iso} from './util.js';
import {privateDir} from './config.js';
export const NOTIFICATION_LIMITS={minimumAttemptIntervalMs:30000,maxNewPerHour:20,maxPending:20,ttlMs:86400000,maxAttempts:8};
const elapsed=(start,end)=>Number.isFinite(start)&&Number.isFinite(end)&&end>=start?end-start:null;
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
      CREATE TABLE IF NOT EXISTS message_timing(message_id TEXT PRIMARY KEY REFERENCES messages(id),received_at INTEGER,dot_read_at INTEGER);
      CREATE TABLE IF NOT EXISTS message_batches(id TEXT PRIMARY KEY REFERENCES messages(id),latest_id TEXT NOT NULL REFERENCES messages(id),first_at INTEGER NOT NULL,ready_at INTEGER NOT NULL,sealed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS batch_members(message_id TEXT PRIMARY KEY REFERENCES messages(id),batch_id TEXT NOT NULL REFERENCES message_batches(id));
      CREATE INDEX IF NOT EXISTS batch_members_batch ON batch_members(batch_id);
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,platform TEXT NOT NULL,binding TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,due INTEGER NOT NULL DEFAULT 0,queued_at INTEGER NOT NULL,expires INTEGER NOT NULL,started_at INTEGER,last_started_at INTEGER,accepted_at INTEGER,provider_id TEXT,error TEXT);
      CREATE INDEX IF NOT EXISTS notifications_due ON notifications(state,due);
      CREATE INDEX IF NOT EXISTS notifications_rate ON notifications(platform,queued_at);
      CREATE INDEX IF NOT EXISTS notifications_attempt_clock ON notifications(platform,last_started_at);
    `);
    // Additive migration: existing v1 inbox rows start immediately eligible.
    const columns=this.all('PRAGMA table_info(inbox)').map(x=>x.name);
    for(const column of ['attempts','due'])if(!columns.includes(column))this.db.exec(`ALTER TABLE inbox ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    // Nullable observations: historical times stay unknown. Keep the ten-column
    // messages layout intact so older schema-1 code can still insert messages.
    for(const [table,names] of [['inbox',['received_at']],['replies',['queued_at','started_at','last_started_at','accepted_at']],['events',['queued_at','started_at','last_started_at','accepted_at']]]){
      const present=this.all(`PRAGMA table_info(${table})`).map(x=>x.name);
      for(const column of names)if(!present.includes(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
    }
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
  recover(){this.run("UPDATE replies SET state='uncertain',error='restart_during_send' WHERE state='sending'");this.run("UPDATE notifications SET state='uncertain',error='restart_during_send' WHERE state='sending'");this.run("UPDATE events SET state='pending' WHERE state='sending'");}
  checkpoint(platform,records,cursorKey,cursor,now=Date.now()){
    return this.tx(()=>{
      for(const r of records){this.run('INSERT OR IGNORE INTO inbox(id,platform,raw,received_at) VALUES(?,?,?,?)',hash(platform+':'+r.key),platform,canonical(r.raw),now);}
      this.set(cursorKey,cursor);
    });
  }
  accept(m,now,conversation={debounceMs:0,maxWaitMs:0}){
    return this.tx(()=>{
      const added=this.run('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)',m.id,m.platform,m.sourceId,m.owner,m.conversation,m.text,canonical(m.media||[]),m.context||'',m.created,m.expires);
      if(added.changes){
        const receipt=this.one('SELECT received_at FROM inbox WHERE id=?',hash(m.platform+':'+m.sourceId));
        this.run('INSERT INTO message_timing(message_id,received_at) VALUES(?,?)',m.id,receipt?receipt.received_at:now);
        const received=receipt?.received_at??now;
        // Only short plain text is debounced. Files, commands and long requests
        // are separate turns; a delivered/read batch is immutable.
        const short=conversation.debounceMs>0&&m.text.length<=1000&&!(m.media?.length)&&!m.text.trimStart().startsWith('/');
        const candidate=short?this.one(`SELECT b.* FROM message_batches b JOIN messages last ON last.id=b.latest_id
          WHERE b.sealed=0 AND b.ready_at>? AND b.first_at+?>? AND last.platform=? AND last.owner=? AND last.conversation=?
          AND last.created<=? AND last.created+?>=? AND last.media='[]' AND length(last.text)<=1000
          AND NOT EXISTS(SELECT 1 FROM replies r WHERE r.message_id=b.id)
          AND (SELECT count(*) FROM batch_members WHERE batch_id=b.id)<20
          AND (SELECT sum(length(text)+1) FROM messages JOIN batch_members ON messages.id=message_id WHERE batch_id=b.id)+?<=8000
          ORDER BY b.rowid DESC LIMIT 1`,received,conversation.maxWaitMs,now,m.platform,m.owner,m.conversation,m.created,conversation.debounceMs,m.created,m.text.length):null;
        if(candidate){
          this.run('INSERT INTO batch_members VALUES(?,?)',m.id,candidate.id);
          const ready=Math.min(received+conversation.debounceMs,candidate.first_at+conversation.maxWaitMs);
          this.run('UPDATE message_batches SET latest_id=?,ready_at=? WHERE id=?',m.id,ready,candidate.id);
          this.run("UPDATE events SET due=? WHERE message_id=? AND state='pending' AND attempts=0",ready,candidate.id);
        }else{
          // A new independent turn closes any older collecting turn on this route.
          this.run(`UPDATE message_batches SET sealed=1,ready_at=MIN(ready_at,?) WHERE sealed=0 AND id IN
            (SELECT id FROM messages WHERE platform=? AND owner=? AND conversation=?)`,now,m.platform,m.owner,m.conversation);
          this.run(`UPDATE events SET due=MIN(due,?) WHERE state='pending' AND attempts=0 AND message_id IN
            (SELECT b.id FROM message_batches b JOIN messages m ON m.id=b.id WHERE b.sealed=1 AND b.ready_at<=? AND m.platform=? AND m.owner=? AND m.conversation=?)`,now,now,m.platform,m.owner,m.conversation);
          this.run('INSERT INTO message_batches VALUES(?,?,?,?,?)',m.id,m.id,received,short?Math.min(received+conversation.debounceMs,received+conversation.maxWaitMs):now,short?0:1);
          this.run('INSERT INTO batch_members VALUES(?,?)',m.id,m.id);
        }
      }
      const root=this.message(this.batchId(m.id));
      for(const sub of this.all('SELECT * FROM subscriptions WHERE active=1 AND expires>? AND platform=?',now,m.platform))this.event(sub,root,now);
      return m.id;
    });
  }
  event(sub,m,now=Date.now()){
    if(this.batchId(m.id)!==m.id)return;
    const id='evt_'+hash(sub.id+':'+m.id);
    const body={eventId:id,name:'message.created',timestamp:iso(m.created),data:{message_id:m.id,platform:m.platform},cursor:null};
    this.run('INSERT OR IGNORE INTO events(id,sub_id,message_id,body,queued_at,due) VALUES(?,?,?,?,?,?)',id,sub.id,m.id,canonical(body),now,this.one('SELECT ready_at FROM message_batches WHERE id=?',m.id)?.ready_at??0);
  }
  message(id){const r=this.one('SELECT * FROM messages WHERE id=?',id);ensure(r,'message_not_found');return r;}
  batchId(id){return this.one('SELECT batch_id FROM batch_members WHERE message_id=?',id)?.batch_id??id;}
  batchMessages(id){const root=this.batchId(id);const rows=this.all('SELECT m.* FROM messages m JOIN batch_members b ON b.message_id=m.id WHERE b.batch_id=? ORDER BY m.rowid',root);return rows.length?rows:[this.message(root)];}
  replyRoute(id){const root=this.batchId(id);return this.message(this.one('SELECT latest_id FROM message_batches WHERE id=?',root)?.latest_id??root);}
  seal(id,now){
    const root=this.batchId(id),batch=this.one('SELECT * FROM message_batches WHERE id=?',root);
    ensure(!batch||batch.ready_at<=now,'batch_collecting');
    this.run('UPDATE message_batches SET sealed=1 WHERE id=?',root);return root;
  }
  publicMessage(id){const root=this.batchId(id),parts=this.batchMessages(root),m=parts[0],last=this.replyRoute(root);return {id:root,platform:m.platform,text:parts.map(p=>p.text).filter(Boolean).join('\n'),media:parts.flatMap(p=>JSON.parse(p.media).map(f=>({...f,message_id:p.id}))),created:iso(m.created),expires:iso(last.expires),message_ids:parts.map(p=>p.id),batch_count:parts.length,replies:this.all('SELECT id,phase,state,provider_id,error FROM replies WHERE message_id=?',root)};}
  pendingPage(cursor='0',now=Date.now(),platforms=['qq','weixin']){
    ensure(typeof cursor==='string'&&/^(0|[1-9][0-9]{0,14})$/.test(cursor),'invalid_cursor');
    const rows=this.all("SELECT m.rowid position,m.id FROM messages m LEFT JOIN message_batches b ON b.id=m.id WHERE m.rowid>? AND COALESCE((SELECT expires FROM messages WHERE id=b.latest_id),m.expires)>? AND (b.ready_at IS NULL OR b.ready_at<=?) AND NOT EXISTS(SELECT 1 FROM batch_members WHERE message_id=m.id AND batch_id<>m.id) AND ((m.platform='qq' AND ?=1) OR (m.platform='weixin' AND ?=1)) AND NOT EXISTS(SELECT 1 FROM replies r WHERE r.message_id=m.id AND ((r.phase='final' AND r.state IN ('accepted','rejected','cancelled')) OR (r.phase='ack' AND r.state IN ('rejected','cancelled')))) ORDER BY m.rowid LIMIT 51",Number(cursor),now,now,Number(platforms.includes('qq')),Number(platforms.includes('weixin')));
    return {messages:rows.slice(0,50).map(r=>this.publicMessage(r.id)),next_cursor:rows.length>50?String(rows[49].position):null};
  }
  enqueue(id,phase,payload,now=Date.now()){
    return this.tx(()=>{
      this.message(id);ensure(['ack','final'].includes(phase));
      const body=canonical(payload),existing=this.one('SELECT * FROM replies WHERE message_id=? AND phase=?',id,phase);
      if(existing){ensure(existing.payload===body,'reply_conflict');return {id:existing.id,state:existing.state};}
      if(phase==='ack')ensure(!this.one("SELECT id FROM replies WHERE message_id=? AND phase='final'",id),'final_already_queued');
      const rid='reply_'+hash(id+':'+phase);this.run('INSERT INTO replies(id,message_id,phase,payload,queued_at) VALUES(?,?,?,?,?)',rid,id,phase,body,now);
      return {id:rid,state:'pending'};
    });
  }
  resolve(id,decision){
    ensure(['accepted','cancelled'].includes(decision));
    const table=id?.startsWith('notice_')?'notifications':'replies';
    ensure(this.run(`UPDATE ${table} SET state=?,error='operator_reconciled' WHERE id=? AND state='uncertain'`,decision,id).changes===1,'not_uncertain');this.audit('operator_reconciled',id);
  }
  enqueueNotification(platform,binding,key,content,now){
    return this.tx(()=>{
      const id='notice_'+hash(canonical([platform,binding,key])),payload=canonical(content);
      const previous=this.one('SELECT payload FROM notifications WHERE id=?',id);
      if(previous){ensure(previous.payload===payload,'notification_conflict');return this.notification(id);}
      ensure(this.one('SELECT count(*) n FROM notifications WHERE platform=? AND queued_at>?',platform,now-3600000).n<NOTIFICATION_LIMITS.maxNewPerHour,'notification_rate_limit');
      ensure(this.one("SELECT count(*) n FROM notifications WHERE platform=? AND state IN ('pending','sending')",platform).n<NOTIFICATION_LIMITS.maxPending,'notification_queue_full');
      this.run('INSERT INTO notifications(id,platform,binding,payload,queued_at,expires) VALUES(?,?,?,?,?,?)',id,platform,binding,payload,now,now+NOTIFICATION_LIMITS.ttlMs);
      return this.notification(id);
    });
  }
  notification(id){
    const row=this.one("SELECT id,platform,state,attempts,due,queued_at,expires,started_at,last_started_at,accepted_at,error,json_extract(payload,'$.context_mode') context_mode FROM notifications WHERE id=?",id);
    ensure(row,'notification_not_found');return {...row,state:row.state==='pending'?'queued':row.state,retries:Math.max(0,row.attempts-1),phone_delivery:'unknown'};
  }
  markRead(id,now){this.seal(id,now);for(const m of this.batchMessages(id))this.run('INSERT INTO message_timing(message_id,dot_read_at) VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET dot_read_at=COALESCE(dot_read_at,excluded.dot_read_at)',m.id,now);}
  timing(id){
    const m=this.one('SELECT m.id,m.platform,m.created,t.received_at,t.dot_read_at FROM messages m LEFT JOIN message_timing t ON t.message_id=m.id WHERE m.id=?',id);ensure(m,'message_not_found');
    const summarize=row=>({...row,retries:Math.max(0,row.attempts-1),durations_ms:{queue_to_first_send:elapsed(row.queued_at,row.started_at),last_send_to_accept:elapsed(row.last_started_at,row.accepted_at),first_send_to_accept:elapsed(row.started_at,row.accepted_at)}});
    const replies=this.all('SELECT phase,state,attempts,queued_at,started_at,last_started_at,accepted_at FROM replies WHERE message_id=? ORDER BY rowid',id).map(summarize);
    const events=this.all('SELECT state,attempts,queued_at,started_at,last_started_at,accepted_at FROM events WHERE message_id=? ORDER BY rowid LIMIT 32',id).map(summarize);
    return {message_id:m.id,platform:m.platform,source_created_at:m.created,source_clock:'platform',observation_clock:'server_unix_ms',received_at:m.received_at,dot_read_at:m.dot_read_at,events,replies,
      durations_ms:{gateway_to_dot_read:elapsed(m.received_at,m.dot_read_at),dot_read_to_final_queue:elapsed(m.dot_read_at,replies.find(r=>r.phase==='final')?.queued_at)},phone_delivery_at:null};
  }
  async backup(dest){ensure(!fs.existsSync(dest),'backup_exists');await backup(this.db,dest);fs.chmodSync(dest,0o600);}
  status(){return {schema:1,messages:this.one('SELECT count(*) n FROM messages').n,inbox:this.all('SELECT state,count(*) count FROM inbox GROUP BY state'),replies:this.all('SELECT state,count(*) count FROM replies GROUP BY state'),notifications:this.all('SELECT platform,state,count(*) count FROM notifications GROUP BY platform,state'),events:this.all('SELECT state,count(*) count FROM events GROUP BY state'),subscriptions:this.one('SELECT count(*) n FROM subscriptions WHERE active=1 AND expires>?',Date.now()).n};}
}
