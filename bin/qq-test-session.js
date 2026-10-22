#!/usr/bin/env node
// Private pipe protocol for scripts/qq_private_test.py, not a public MCP tool.
import readline from 'node:readline';
import {runQQTest} from '../src/qq-private-session.js';
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const abort=new AbortController();
for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>abort.abort());
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
process.stdout.on('error',()=>abort.abort());
const bootTimer=setTimeout(()=>process.exit(1),10000);
lines.once('line',async line=>{
  clearTimeout(bootTimer);
  try{if(line.length>8192)throw new Error();await runQQTest(JSON.parse(line),{emit,commands:lines,signal:abort.signal});}
  catch{emit({stage:'failed',code:'session_failed'});process.exitCode=1;}
  finally{emit({stage:'gateway_stopped'});lines.close();process.exit(process.exitCode||0);}
});
