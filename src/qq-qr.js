// Public Tencent SDK callback adapter. No private protocol endpoints are copied.
import {Fault,ensure} from './util.js';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export function qqQrCredentials(start,{signal,emit,expectedAppId='',timeoutMs=120000}={}){
  ensure(typeof start==='function','qq_qr_unavailable');
  ensure(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=120000,'invalid_qr_timeout');
  return new Promise((resolve,reject)=>{
    let settled=false,dispose,timer;const local=new AbortController();
    const clear=rows=>{if(Array.isArray(rows))for(const row of rows)if(row&&typeof row==='object')row.appSecret='';};
    const finish=async(error,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
      local.abort();try{await dispose?.();}catch{error=new Fault('qq_qr_cleanup_failed');}
      if(error){if(value)value.appSecret='';reject(error);}else resolve(value);
    };
    const cancel=()=>{void finish(new Fault('qq_qr_cancelled'));};
    if(signal?.aborted){cancel();return;}
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>{void finish(new Fault('qq_qr_timeout'));},timeoutMs);
    // Defer callbacks until start has returned its disposer, including test SDKs.
    const later=fn=>(...args)=>queueMicrotask(()=>fn(...args));
    try{dispose=start({
      onQrDisplayed:later(url=>{
        if(settled)return;
        try{const u=new URL(url);ensure(url.length<=2048&&u.protocol==='https:'&&u.hostname==='q.qq.com'&&!u.port&&!u.username&&!u.password&&u.pathname==='/qqbot/openclaw/connect.html','qq_qr_url_rejected');emit({stage:'qq_qr',content:url});}
        catch{void finish(new Fault('qq_qr_url_rejected'));}
      }),
      onQrExpired:later(()=>{void finish(new Fault('qq_qr_expired'));}),
      onFailure:later(()=>{void finish(new Fault('qq_qr_failed'));}),
      onSuccess:later(rows=>{
        if(settled){clear(rows);return;}
        try{
          ensure(Array.isArray(rows)&&rows.length===1,'qq_qr_selection_rejected');const row=rows[0];
          ensure(id(row?.appId)&&typeof row.appSecret==='string'&&row.appSecret.length>=16&&row.appSecret.length<=1024&&!/[\r\n\0]/.test(row.appSecret),'qq_qr_credentials_rejected');
          ensure(!expectedAppId||row.appId===expectedAppId,'qq_qr_app_mismatch');
          ensure(!row.userOpenid||id(row.userOpenid),'qq_qr_owner_rejected');
          const value={appId:row.appId,appSecret:row.appSecret,userOpenid:row.userOpenid||''};clear(rows);void finish(null,value);
        }catch(e){clear(rows);void finish(e instanceof Fault?e:new Fault('qq_qr_failed'));}
      })
    },{source:'',displayQrCodeToConsole:false,signal:local.signal});}
    catch{void finish(new Fault('qq_qr_failed'));}
  });
}
