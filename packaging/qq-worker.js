import {parentPort,workerData} from 'node:worker_threads';
import {startQrConnect} from '@tencent-connect/qqbot-connector';
let stop;
if(workerData?.offlineCheck)parentPort.postMessage({kind:'offline_check',publicApi:typeof startQrConnect==='function'});
else stop=startQrConnect({
  onQrDisplayed:url=>parentPort.postMessage({kind:'qr',url}),
  onSuccess:credentials=>{parentPort.postMessage({kind:'success',credentials});for(const c of credentials)c.appSecret='';},
  onQrExpired:()=>{stop?.();parentPort.postMessage({kind:'expired'});},
  onFailure:()=>parentPort.postMessage({kind:'failure'})
},{source:'',displayQrCodeToConsole:false});
