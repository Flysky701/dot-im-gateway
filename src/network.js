import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import {ensure, Fault} from './util.js';
// Deliberately use only public IPv4. IPv6-only destinations fail closed in v0.1.
export function publicIPv4(ip) {
  if(net.isIP(ip)!==4) return false;
  const [a,b,c]=ip.split('.').map(Number);
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) ||
    (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99))) ||
    (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
}
export function safeURL(raw, hosts, protocol='https:') {
  let u; try {u=new URL(raw);} catch {throw new Fault('invalid_destination');}
  ensure(u.protocol===protocol && !u.username && !u.password && !u.hash && (!u.port || u.port==='443') && hosts.includes(u.hostname) && !net.isIP(u.hostname),'destination_denied');
  return u;
}
export async function pinnedOptions(raw, hosts, resolver = dns.lookup, timeout = 10000) {
  const u=safeURL(raw,hosts);
  let timer,addresses;
  try{
    addresses=await Promise.race([resolver(u.hostname,{all:true,family:4}),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Fault('dns_timeout','retry')),timeout);
    })]);
  }finally{clearTimeout(timer);}
  ensure(addresses.length>0 && addresses.every(x=>publicIPv4(x.address)),'non_public_destination');
  const address=addresses[0].address;
  return {u,options:{hostname:u.hostname,port:443,path:u.pathname+u.search,servername:u.hostname,family:4,autoSelectFamily:false,
    lookup:(_h,_o,cb)=>cb(null,address,4), agent:false, rejectUnauthorized:true}};
}
export async function request(raw,{hosts,method='POST',headers={},body=Buffer.alloc(0),limit=1048576,timeout=10000,signal}={}) {
  if(signal?.aborted)throw new Fault('request_cancelled','retry');
  let options; try {({options}=await pinnedOptions(raw,hosts));} catch(e) {if(e instanceof Fault) throw e; throw new Fault('network_before_connect','retry');}
  if(signal?.aborted)throw new Fault('request_cancelled','retry');
  return new Promise((resolve,reject)=>{
    let sent=false;
    const req=https.request({...options,signal,method,headers:{...headers,'Content-Length':body.length}},res=>{
      const chunks=[];let size=0;
      res.on('data',b=>{size+=b.length;if(size>limit) req.destroy(new Fault('response_too_large','uncertain')); else chunks.push(b);});
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
      res.on('error',()=>reject(new Fault('response_interrupted','uncertain')));
    });
    const deadline=setTimeout(()=>req.destroy(new Error('timeout')),timeout);
    req.on('socket',s=>s.once('secureConnect',()=>{sent=true;}));
    req.on('error',e=>reject(e instanceof Fault ? e : new Fault('network_failure',sent?'uncertain':'retry')));
    req.on('close',()=>clearTimeout(deadline));
    req.end(body);
  });
}
