import {request} from './network.js';
import {ensure,Fault,parseJson} from './util.js';

// AliDNS JSON-over-HTTPS. Bootstrap with its public IPv4, while request() keeps
// hostname allowlisting, TLS hostname verification and IP pinning intact.
// Only public domain names are sent; no application headers or credentials.
export function publicDnsResolver(send=request){
  return async hostname=>{
    ensure(typeof hostname==='string'&&/^[a-z0-9.-]+$/i.test(hostname),'invalid_dns_name');
    const url='https://dns.alidns.com/resolve?name='+encodeURIComponent(hostname)+'&type=A';
    const r=await send(url,{hosts:['dns.alidns.com'],method:'GET',timeout:5000,limit:65536,
      resolver:async()=>[{address:'223.5.5.5',family:4}]});
    if(r.status!==200)throw new Fault('public_dns_failed','retry');
    let data;try{data=parseJson(r.body);}catch{throw new Fault('public_dns_failed','retry');}
    ensure(data?.Status===0&&Array.isArray(data.Answer)&&data.Answer.length<=64,'public_dns_failed');
    const addresses=data.Answer.filter(x=>x?.type===1).map(x=>({address:x.data,family:4}));
    ensure(addresses.length>0,'public_dns_no_ipv4');
    // pinnedOptions validates every returned address before sending app traffic.
    return addresses;
  };
}
