import http from 'node:http';
import {same,ensure,Fault} from './util.js';
export function connectServer({token,connector,assets,finish=()=>{}}){
  ensure(token.length>=32,'invalid_ui_token');let busy=false;
  const server=http.createServer(async(req,res)=>{
    const send=(code,data,type='application/json')=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(typeof data==='string'?data:JSON.stringify(data));};
    const host='127.0.0.1:'+server.address().port;
    if(req.headers.host!==host||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){send(403,{error:'loopback_required'});return;}
    if(req.headers.origin&&req.headers.origin!=='http://'+host){send(403,{error:'origin_denied'});return;}
    if(req.method==='GET'&&assets[req.url]){const a=assets[req.url];send(200,a.body,a.type);return;}
    if(!same(req.headers.authorization||'','Bearer '+token)){send(401,{error:'unauthorized'});return;}
    if(req.url==='/state'&&req.method==='GET'){send(200,connector.snapshot());return;}
    if(req.method!=='POST'||!['/connect','/confirm','/stop','/finish'].includes(req.url)){send(404,{error:'not_found'});return;}
    if(req.headers.origin!=='http://'+host||req.headers['content-type']!=='application/json'){send(403,{error:'same_origin_json_required'});return;}
    if(busy){send(409,{error:'operation_in_progress'});return;}busy=true;
    try{
      let size=0;const chunks=[];for await(const b of req){size+=b.length;ensure(size<=8192,'body_limit');chunks.push(b);}
      let input;try{input=JSON.parse(Buffer.concat(chunks));}catch{throw new Fault('invalid_json');}
      if(req.url==='/connect')connector.start(input);
      else if(req.url==='/confirm')connector.command(input);
      else {ensure(input&&Object.keys(input).length===0,'invalid_input');if(req.url==='/stop')await connector.stop();else ensure(['connected','handed_off'].includes(connector.snapshot().stage),'not_connected');}
      send(200,connector.snapshot());if(req.url==='/finish')setImmediate(finish);
    }catch(e){send(400,{error:e instanceof Fault?e.code:'operation_failed'});}finally{busy=false;}
  });
  server.headersTimeout=5000;server.requestTimeout=10000;server.timeout=15000;server.maxConnections=8;return server;
}
