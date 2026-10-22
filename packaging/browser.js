import qrcode from 'qrcode-generator';
const $=s=>document.querySelector(s);let token=location.hash.slice(1),timer,lastQR='',appConfirmation='';history.replaceState(null,'',location.pathname);
async function api(route,body){const r=await fetch(route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});const data=await r.json();if(!r.ok)throw new Error(data.error||'operation_failed');return data;}
const titles={idle:'等待连接',connecting:'正在连接…',qq_qr:'用本人 QQ 扫码确认',qq_app_confirm:'核对扫码选择的机器人',qq_challenge:'在本人 QQ 中发送验证文字',qq_confirm:'确认这条消息来自你本人',weixin_qr:'用本人微信扫码确认',verify_code:'输入手机上显示的验证码',tunnel_connecting:'正在启动私人通道…',connected:'连接程序已就绪',failed:'本次连接未完成',stopped:'连接已停止'};
function paint(s){
  if(s.stage==='idle')return;$('#setup').hidden=true;$('#flow').hidden=false;$('#step').textContent=titles[s.stage]||'正在处理…';
  $('#challenge').hidden=!['qq_challenge','qq_confirm'].includes(s.stage);$('#challenge').textContent=s.challenge||s.confirmation||'';
  $('#instruction').textContent=s.stage==='qq_challenge'?'复制下面文字，只发给你自己管理的 QQ 机器人。':s.stage==='qq_confirm'?'确认刚才的验证文字是你本人发送的，再输入下面整行。不要替陌生来信认主。':s.stage==='weixin_qr'?'扫码会建立微信侧绑定；程序退出不会自动解除手机上的绑定。':s.stage==='verify_code'?'验证码只用于本次手机确认，不会保存在日志中。':s.stage==='connected'?'可以关闭此页面，保持连接程序所在终端运行。':s.stage==='failed'?'请检查错误后重新运行程序，不会自动尝试重新绑定。':'';
  if(s.stage==='qq_qr')$('#instruction').textContent='手机页面显示“第三方机器人”。选择你要复用的机器人；二维码只供本人扫描，不发送给其他人。两分钟未完成会停止。';
  if(s.stage==='qq_app_confirm')$('#instruction').textContent='本次选择 AppID：'+s.appId+'。确认这是你要连接的机器人；选错请停止重来。';
  $('#approve-app').hidden=s.stage!=='qq_app_confirm';appConfirmation=s.stage==='qq_app_confirm'?s.confirmation:'';
  $('#confirm').hidden=!['qq_confirm','verify_code'].includes(s.stage);$('#answer').type=s.stage==='verify_code'?'password':'text';$('#confirm-label').textContent=s.stage==='verify_code'?'手机验证码':'确认文字';
  const showQR=['qq_qr','weixin_qr'].includes(s.stage);$('#complete').hidden=s.stage!=='connected';$('#qr').hidden=!showQR;$('#qr').alt=s.stage==='qq_qr'?'请用本人 QQ 扫描':'请用本人微信扫描';
  if(showQR&&s.qr!==lastQR){const q=qrcode(0,'M');q.addData(s.qr);q.make();$('#qr').src=q.createDataURL(5,20);lastQR=s.qr;}
  if(!showQR){$('#qr').removeAttribute('src');lastQR='';}
  $('#error').textContent=s.code||'';if(['failed','stopped'].includes(s.stage)){clearInterval(timer);$('#stop').disabled=true;}
}
function platformFields(){const qq=document.querySelector('[name=platform]:checked').value==='qq',manual=qq&&$('#setup').elements.qqAuth.value==='manual';$('#qq-fields').hidden=!qq;$('#qq-help').hidden=!qq;$('#weixin-help').hidden=qq;$('#secret-field').hidden=!manual;$('#appid-caption').textContent=manual?'机器人 AppID（必填）':'已有 AppID（可选，防止选错机器人）';for(const n of ['appId','secret'])$('#setup').elements[n].required=manual;}
document.querySelectorAll('[name=platform], [name=qqAuth]').forEach(x=>x.addEventListener('change',platformFields));
document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',async()=>{const field=document.getElementById(button.dataset.copy);try{await navigator.clipboard.writeText(field.value);$('#copy-status').textContent='已复制，可以交给有仓库访问权限的 Agent。';}catch{field.focus();field.select();$('#copy-status').textContent='浏览器未允许复制。文字已选中，请手动复制。';}}));
$('#setup').addEventListener('submit',async e=>{e.preventDefault();$('#connect').disabled=true;const f=e.currentTarget;let input=Object.fromEntries(new FormData(f));input.confirmed=f.elements.confirmed.checked;try{paint(await api('/connect',input));f.reset();timer=setInterval(async()=>{try{paint(await api('/state'));}catch{$('#error').textContent='连接程序不可达，请查看终端或重新运行。';clearInterval(timer);}},1000);}catch(err){$('#error').textContent=err.message;$('#connect').disabled=false;}finally{input.secret='';input.runtimeKey='';f.elements.secret.value='';f.elements.runtimeKey.value='';}});
$('#confirm').addEventListener('submit',async e=>{e.preventDefault();const value=$('#answer').value;$('#answer').value='';try{paint(await api('/confirm',{value}));}catch(err){$('#error').textContent=err.message;}});
$('#approve-app').addEventListener('click',async()=>{try{paint(await api('/confirm',{value:appConfirmation}));}catch(err){$('#error').textContent=err.message;}});
$('#stop').addEventListener('click',async()=>{try{paint(await api('/stop',{}));}catch{$('#error').textContent='请在终端按 Ctrl+C 结束程序。';}});
$('#finish').addEventListener('click',async()=>{try{await api('/finish',{});clearInterval(timer);token='';$('#flow').textContent='配置页面已关闭。桥接进程继续运行；停止时在终端按 Ctrl+C。';}catch(err){$('#error').textContent=err.message;}});
