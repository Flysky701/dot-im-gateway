import {Worker} from 'node:worker_threads';
export function verifyQQWorker(code){
  return new Promise((resolve,reject)=>{
    const w=new Worker(code,{eval:true,env:{},workerData:{offlineCheck:true},stdout:true,stderr:true});w.stdout.resume();w.stderr.resume();let done=false;
    const finish=async ok=>{if(done)return;done=true;clearTimeout(timer);await w.terminate();if(ok)resolve();else reject(new Error('qq_sdk_self_test_failed'));};
    const timer=setTimeout(()=>{void finish(false);},5000);w.on('message',m=>{void finish(m?.kind==='offline_check'&&m.publicApi===true);});w.on('error',()=>{void finish(false);});w.on('exit',()=>{if(!done)void finish(false);});
  });
}
// A worker bounds cancellation even when the SDK has an in-flight HTTP request.
// No parent environment, stdout or raw errors cross into the UI or logs.
export function qqWorkerStart(code){
  return (callbacks,options)=>{
    const worker=new Worker(code,{eval:true,env:{},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:32}});
    worker.stdout.resume();worker.stderr.resume();let stopped=false,termination;
    const stop=()=>{
      if(termination)return termination;stopped=true;options.signal?.removeEventListener('abort',stop);
      termination=worker.terminate().then(()=>{});return termination;
    };
    worker.on('message',m=>{if(stopped)return;if(m?.kind==='qr')callbacks.onQrDisplayed(m.url);else if(m?.kind==='success')callbacks.onSuccess(m.credentials);else if(m?.kind==='expired')callbacks.onQrExpired();else callbacks.onFailure();});
    worker.on('error',()=>{if(!stopped)callbacks.onFailure();});
    worker.on('exit',()=>{if(!stopped)callbacks.onFailure();});
    options.signal?.addEventListener('abort',stop,{once:true});
    if(options.signal?.aborted)void stop();
    return stop;
  };
}
