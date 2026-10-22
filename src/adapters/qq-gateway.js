import https from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {pinnedOptions,safeURL} from '../network.js';
import {ensure,Fault,parseJson,pause} from '../util.js';
export function clientFrame(data,opcode=1){
  const b=Buffer.from(data);ensure(b.length<=65535,'frame_limit');const head=Buffer.alloc(b.length<126?6:8);head[0]=0x80|opcode;
  if(b.length<126)head[1]=0x80|b.length;else{head[1]=0x80|126;head.writeUInt16BE(b.length,2);}
  const mask=randomBytes(4);mask.copy(head,head.length-4);const payload=Buffer.from(b);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];return Buffer.concat([head,payload]);
}
export class Frames extends EventEmitter {
  constructor(){super();this.buf=Buffer.alloc(0);this.parts=[];this.size=0;}
  feed(chunk){
    this.buf=Buffer.concat([this.buf,chunk]);ensure(this.buf.length<=131072,'frame_limit');
    while(this.buf.length>=2){
      const a=this.buf[0],b=this.buf[1],op=a&15,fin=!!(a&128);ensure(!(a&112)&&!(b&128),'invalid_frame');let n=b&127,offset=2;
      if(n===126){if(this.buf.length<4)return;n=this.buf.readUInt16BE(2);offset=4;}
      else if(n===127){if(this.buf.length<10)return;const big=this.buf.readBigUInt64BE(2);ensure(big<=65536n,'frame_limit');n=Number(big);offset=10;}
      ensure(n<=65536,'frame_limit');if(this.buf.length<offset+n)return;
      const data=this.buf.subarray(offset,offset+n);this.buf=this.buf.subarray(offset+n);
      if(op>=8){ensure(fin&&n<=125,'invalid_control_frame');if(op===8){ensure(n!==1,'invalid_close');this.emit('close',n>=2?data.readUInt16BE():1000);}else if(op===9)this.emit('ping',data);else ensure(op===10,'invalid_opcode');continue;}
      ensure(op===1||op===0,'unsupported_frame');ensure(op===0?this.parts.length>0:this.parts.length===0,'invalid_fragment');
      this.parts.push(data);this.size+=n;ensure(this.size<=65536,'frame_limit');
      if(fin){const bytes=Buffer.concat(this.parts);this.parts=[];this.size=0;this.emit('message',parseJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
    }
  }
}
export async function openSocket(url,hosts){
  safeURL(url,hosts,'wss:');const {options}=await pinnedOptions(url.replace(/^wss:/,'https:'),hosts),key=randomBytes(16).toString('base64');
  return new Promise((resolve,reject)=>{
    const req=https.request({...options,method:'GET',headers:{Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':key,'Sec-WebSocket-Version':'13'}});
    const timer=setTimeout(()=>req.destroy(new Error('timeout')),10000);
    req.on('error',()=>{clearTimeout(timer);reject(new Fault('qq_websocket_connect','retry'));});
    req.on('response',r=>{clearTimeout(timer);r.destroy();reject(new Fault('qq_websocket_rejected'));});
    req.on('upgrade',(res,socket,head)=>{
      clearTimeout(timer);const expected=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if(res.statusCode!==101||res.headers['sec-websocket-accept']!==expected||res.headers['sec-websocket-extensions']){socket.destroy();reject(new Fault('qq_websocket_handshake'));return;}
      socket.pause();resolve({socket,head});
    });req.end();
  });
}
export class QQGateway {
  constructor(adapter,store,hosts,connect=openSocket){Object.assign(this,{adapter,store,hosts,connect});this.stopped=false;this.socket=null;}
  stop(){this.stopped=true;this.socket?.destroy();}
  async run(){let failures=0;while(!this.stopped){try{await this.session();failures=0;}catch{this.store.audit('qq_connection_retry');failures++;}if(!this.stopped)await pause(Math.min(60000,1000*2**Math.min(failures,6)));}}
  async session(){
    const info=await this.adapter.gateway();if(this.stopped)return;
    if(!this.store.get('qq.session')&&info.session_start_limit?.remaining===0){await pause(Math.min(60000,Math.max(1000,info.session_start_limit.reset_after||60000)));return;}
    const {socket,head}=await this.connect(info.url,this.hosts);this.socket=socket;if(this.stopped){socket.destroy();return;}
    return new Promise((resolve,reject)=>{
      let timer,hello=false,waiting=false,settled=false;
      const timeout=setTimeout(()=>finish(new Fault('qq_hello_timeout')),30000);
      const finish=(e)=>{if(settled)return;settled=true;clearTimeout(timeout);clearInterval(timer);socket.destroy();this.socket=null;e?reject(e):resolve();};
      const send=p=>{ensure(socket.writable&&socket.writableLength<65536,'qq_socket_backpressure');socket.write(clientFrame(JSON.stringify(p)));};
      const frames=new Frames();frames.on('ping',d=>socket.write(clientFrame(d,10)));
      frames.on('close',code=>{
        if([4001,4002,4010,4011,4012,4013,4014,4914,4915].includes(code)){this.stopped=true;this.store.audit('qq_fatal_close');}
        finish();
      });
      frames.on('message',p=>{
        if(p.op===10){
          ensure(!hello&&Number.isInteger(p.d?.heartbeat_interval)&&p.d.heartbeat_interval>=1000&&p.d.heartbeat_interval<=300000,'qq_invalid_hello');hello=true;clearTimeout(timeout);
          const session=this.store.get('qq.session');send(session?{op:6,d:{token:`QQBot ${info.token}`,session_id:session,seq:Number(this.store.get('qq.seq')||0)}}:{op:2,d:{token:`QQBot ${info.token}`,intents:1<<25,shard:[0,1]}});
          timer=setInterval(()=>{try{if(waiting)return finish(new Fault('qq_heartbeat_timeout'));waiting=true;send({op:1,d:this.store.get('qq.seq')?Number(this.store.get('qq.seq')):null});}catch(e){finish(e);}},p.d.heartbeat_interval);
        }else if(p.op===11)waiting=false;
        else if(p.op===7)finish();
        else if(p.op===9){this.store.run("DELETE FROM meta WHERE k IN ('qq.session','qq.seq')");finish();}
        else if(p.op===0){ensure(hello&&Number.isSafeInteger(p.s),'qq_invalid_dispatch');if(p.t==='READY'){ensure(typeof p.d?.session_id==='string','qq_invalid_session');this.store.set('qq.session',p.d.session_id);}this.adapter.receive(p);}
      });
      socket.on('data',b=>{try{frames.feed(b);}catch(e){finish(e);}});socket.on('error',()=>finish(new Fault('qq_socket_error')));socket.on('close',()=>finish());
      if(head.length)try{frames.feed(head);}catch(e){finish(e);}socket.resume();
    });
  }
}
