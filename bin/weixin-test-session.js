import readline from 'node:readline';
import {runWeixinTest} from '../src/weixin-private-session.js';
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity}),abort=new AbortController();
for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>abort.abort());
process.stdout.on('error',()=>abort.abort());
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const timer=setTimeout(()=>process.exit(1),10000);
lines.once('line',async line=>{
  clearTimeout(timer);
  try{if(line.length>8192)throw new Error();await runWeixinTest(JSON.parse(line),{emit,commands:lines,signal:abort.signal});}
  catch{emit({stage:'failed',code:'weixin_test_failed'});process.exitCode=1;}
  finally{emit({stage:'gateway_stopped'});lines.close();process.exit(process.exitCode||0);}
});
