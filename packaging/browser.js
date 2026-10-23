import qrcode from 'qrcode-generator';

const $ = s => document.querySelector(s);
let token = location.hash.slice(1);
let timer;
let lastQR = '';
let appConfirmation = '';
let tunnelSaved = false;

history.replaceState(null, '', location.pathname);

async function api(route, body) {
  const r = await fetch(route, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'operation_failed');
  return data;
}

const titles = {
  idle: '等待连接',
  connecting: '正在连接…',
  qq_qr: '用本人 QQ 扫码确认',
  qq_app_confirm: '核对扫码选择的机器人',
  qq_challenge: '在本人 QQ 中发送验证文字',
  qq_confirm: '确认这条消息来自你本人',
  weixin_qr: '用本人微信扫码确认',
  verify_code: '输入手机上显示的验证码',
  tunnel_connecting: '正在启动私人通道…',
  connected: '连接程序已就绪',
  handing_off: '正在交给常驻服务…',
  handed_off: '常驻服务已接管',
  failed: '本次连接未完成',
  stopped: '连接已停止'
};

const instructions = {
  connecting: '',
  qq_qr: '手机选择要连接的机器人（2 分钟内有效）',
  qq_challenge: '用本人 QQ 发送下面这行给该机器人：',
  qq_confirm: '确认上方消息由本人发出后，粘贴下面整行提交：',
  weixin_qr: '用本人微信扫码并在手机上确认',
  verify_code: '',
  tunnel_connecting: '',
  connected: '连接已就绪。可关闭此页，保持终端运行（Ctrl+C 停止）。',
  handing_off: '正在写入服务并重启，请勿关闭页面…',
  handed_off: '',
  failed: '请核对上方提示后重新运行连接程序。',
  stopped: ''
};

const errorMessages = {
  unauthorized: '一次性页面令牌已失效（刷新会清除），请从终端重新打开完整链接',
  connection_already_started: '连接已在进行中',
  tunnel_auth_failed: 'Tunnel ID 不存在或运行密钥缺少 Tunnels: Read + Use 权限',
  invalid_identifier: 'Tunnel ID 或 AppID 格式有误（Tunnel ID 需以 tunnel_ 开头）',
  invalid_secret_shape: '密钥或 Secret 格式不符合要求（长度 16~1024 字符）',
  scope_confirmation_required: '请勾选同意仅连接本人私聊',
  platform_required: '请选择连接平台',
  qq_qr_expired: 'QQ 扫码二维码已过期，请重新发起',
  qq_qr_timeout: 'QQ 扫码超时，请重新发起',
  qq_qr_cancelled: 'QQ 扫码已取消',
  qq_qr_app_mismatch: '手机选中的机器人与填写的限定 AppID 不一致',
  qq_qr_selection_rejected: '手机端未选择机器人',
  qq_qr_owner_rejected: '只有机器人开发者或管理员本人才能连接',
  qq_qr_failed: 'QQ 扫码连接失败，请重试',
  qq_app_confirmation_timeout: '核对机器人超时，请重新发起连接',
  confirmation_mismatch: '验证文字不匹配，请核对后重新输入',
  invalid_verify_code: '验证码格式错误，应为纯数字',
  tunnel_not_ready: 'OpenAI Tunnel 通道尚未就绪',
  tunnel_start_failed: 'OpenAI Tunnel 启动失败，请检查配置与权限',
  tunnel_stopped: 'OpenAI Tunnel 进程已停止',
  gateway_not_healthy: '网关服务健康检查未通过',
  different_owner_requires_new_data_directory: '当前数据属于其他账号，更换需指定新数据目录',
  unrelated_tunnel_unit_exists: '系统已存在不属于此网关的 Tunnel 服务',
  gateway_unit_not_ours: '系统已存在同名的其他网关服务',
  handoff_failed: '常驻服务交接写入失败',
  operation_in_progress: '另一项操作正在进行中，请稍候',
  preview_network_disabled: '开发预览网络已被禁用'
};

function formatError(code) {
  if (!code) return '';
  return errorMessages[code] ? `${errorMessages[code]} (${code})` : String(code);
}

function dotPrompt(platform) {
  const n = platform === 'qq' ? 'QQ' : '微信';
  return `请订阅私人插件 dot-im-gateway 的 message.created 事件（platform=${platform}）。收到${n}消息后按插件说明读取，先回 ack“收到”，处理完再回 final。`;
}

function paint(s) {
  if (s.stage === 'idle') return;
  $('#setup').hidden = true;
  $('#flow').hidden = false;
  $('#step').textContent = titles[s.stage] || '正在处理…';

  $('#challenge').hidden = !['qq_challenge', 'qq_confirm'].includes(s.stage);
  $('#challenge').textContent = s.challenge || s.confirmation || '';
  $('#copy-challenge').hidden = s.stage !== 'qq_challenge';

  $('#instruction').textContent = s.stage === 'qq_app_confirm'
    ? 'AppID：' + (s.appId || '')
    : (instructions[s.stage] ?? '');

  $('#approve-app').hidden = s.stage !== 'qq_app_confirm';
  appConfirmation = s.stage === 'qq_app_confirm' ? (s.confirmation || '') : '';

  $('#confirm').hidden = !['qq_confirm', 'verify_code'].includes(s.stage);
  $('#answer').type = s.stage === 'verify_code' ? 'password' : 'text';
  $('#confirm-label').textContent = s.stage === 'verify_code' ? '手机验证码' : '确认文字';

  $('#handed').hidden = s.stage !== 'handed_off';
  if (s.stage === 'handed_off') {
    $('#linger-warning').hidden = s.linger !== false;
    const hintEl = $('#tunnel-hint');
    if (hintEl) hintEl.textContent = s.tunnelHint || '选刚建的通道';
    $('#dot-prompt').value = dotPrompt(s.platform);
    $('#stop').hidden = true;

    const mcpOk = Boolean(s.mcpConnected || s.subscribed);
    const subOk = Boolean(s.subscribed);

    const chkMcp = $('#chk-mcp');
    if (chkMcp) {
      if (mcpOk) {
        chkMcp.className = 'done';
        chkMcp.textContent = '✓ ChatGPT MCP 插件已连通';
      } else {
        chkMcp.className = '';
        chkMcp.textContent = '⏳ 等待 ChatGPT 连接插件…';
      }
    }

    const chkSub = $('#chk-sub');
    if (chkSub) {
      if (subOk) {
        chkSub.className = 'done';
        chkSub.textContent = '✓ 来信自动唤醒已就绪！拿手机发句「你好」试试';
      } else {
        chkSub.className = '';
        chkSub.textContent = '⏳ 等待原 dot 完成事件订阅…';
      }
    }

    if ($('#mcp-guide')) $('#mcp-guide').hidden = subOk;
    if ($('#finish-handed')) $('#finish-handed').hidden = !subOk;
    if ($('#close-handed')) $('#close-handed').hidden = subOk;

    if (subOk) {
      clearInterval(timer);
      timer = null;
    }
  }

  const showQR = ['qq_qr', 'weixin_qr'].includes(s.stage);
  $('#complete').hidden = s.stage !== 'connected';
  $('#qr').hidden = !showQR;
  $('#qr').alt = s.stage === 'qq_qr' ? '请用本人 QQ 扫描' : '请用本人微信扫描';
  if (showQR && s.qr !== lastQR) {
    const q = qrcode(0, 'M');
    q.addData(s.qr);
    q.make();
    $('#qr').src = q.createDataURL(5, 20);
    lastQR = s.qr;
  }
  if (!showQR) {
    $('#qr').removeAttribute('src');
    lastQR = '';
  }

  if (s.code) {
    $('#error').textContent = formatError(s.code);
  }
  if (['failed', 'stopped'].includes(s.stage)) {
    clearInterval(timer);
    timer = null;
    $('#stop').disabled = true;
  }
}

function platformFields() {
  const qq = $('#setup').elements.platform.value === 'qq';
  const manual = qq && $('#setup').elements.qqAuth.value === 'manual';
  $('#qq-advanced').hidden = !qq;
  if (manual) {
    $('#qq-advanced').open = true;
    $('#secret-field').hidden = false;
    $('#appid-caption').textContent = '机器人 AppID';
    $('#setup').elements.appId.required = true;
    $('#setup').elements.secret.required = true;
  } else {
    $('#secret-field').hidden = true;
    $('#setup').elements.secret.value = '';
    $('#appid-caption').textContent = '限定 AppID（可选）';
    $('#setup').elements.appId.required = false;
    $('#setup').elements.secret.required = false;
  }
}

document.querySelectorAll('[name=platform], [name=qqAuth]').forEach(x => {
  x.addEventListener('change', platformFields);
});

const tunnelInputs = ['tunnelId', 'runtimeKey'].map(n => $('#setup').elements[n]);
for (const input of tunnelInputs) {
  input.addEventListener('input', () => {
    if (!tunnelSaved) return;
    const anyFilled = tunnelInputs.some(x => x.value.trim().length > 0);
    for (const x of tunnelInputs) {
      x.required = anyFilled;
    }
  });
}

document.querySelectorAll('[data-copy]').forEach(button => {
  const orig = button.textContent;
  let copyTimer;
  button.addEventListener('click', async () => {
    const field = document.getElementById(button.dataset.copy);
    if (!field) return;
    const text = field.value ?? field.textContent ?? '';
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制 ✓';
    } catch {
      if (typeof field.select === 'function') {
        field.focus();
        field.select();
        button.textContent = '已选中，请按 Ctrl+C';
      } else {
        button.textContent = '复制失败';
      }
    }
    copyTimer = setTimeout(() => { button.textContent = orig; }, 2000);
  });
});

$('#setup').addEventListener('submit', async e => {
  e.preventDefault();
  $('#error').textContent = '';
  $('#connect').disabled = true;
  const f = e.currentTarget;

  const platform = f.elements.platform.value;
  const qqAuth = platform === 'qq' ? f.elements.qqAuth.value : 'qr';
  const appId = platform === 'qq' ? (f.elements.appId.value || '').trim() : '';
  const secret = (platform === 'qq' && qqAuth === 'manual') ? f.elements.secret.value : '';
  const tunnelId = (f.elements.tunnelId.value || '').trim();
  const runtimeKey = (f.elements.runtimeKey.value || '').trim();
  const confirmed = Boolean(f.elements.confirmed.checked);

  const input = {
    platform,
    qqAuth,
    appId,
    secret,
    tunnelId,
    organizationId: '',
    runtimeKey,
    confirmed
  };

  try {
    const res = await api('/connect', input);
    paint(res);
    if (!['failed', 'stopped'].includes(res.stage) && !(res.stage === 'handed_off' && res.subscribed)) {
      startPolling();
    }
  } catch (err) {
    $('#error').textContent = formatError(err.message);
    $('#connect').disabled = false;
  } finally {
    input.secret = '';
    input.runtimeKey = '';
    f.elements.secret.value = '';
    f.elements.runtimeKey.value = '';
  }
});

$('#confirm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#error').textContent = '';
  const value = $('#answer').value;
  $('#answer').value = '';
  try {
    paint(await api('/confirm', { value }));
  } catch (err) {
    $('#error').textContent = formatError(err.message);
  }
});

$('#approve-app').addEventListener('click', async () => {
  $('#error').textContent = '';
  try {
    paint(await api('/confirm', { value: appConfirmation }));
  } catch (err) {
    $('#error').textContent = formatError(err.message);
  }
});

$('#stop').addEventListener('click', async () => {
  $('#error').textContent = '';
  try {
    paint(await api('/stop', {}));
  } catch (err) {
    $('#error').textContent = formatError(err.message) || '请在终端按 Ctrl+C 结束程序。';
  }
});

async function finishPage() {
  $('#error').textContent = '';
  try {
    await api('/finish', {});
    clearInterval(timer);
    timer = null;
    token = '';
    const handed = !$('#handed').hidden;
    $('#flow').textContent = handed
      ? '配置页面已关闭。常驻服务继续在后台运行。'
      : '配置页面已关闭。桥接进程继续运行；停止时在终端按 Ctrl+C。';
  } catch (err) {
    $('#error').textContent = formatError(err.message);
  }
}

$('#finish').addEventListener('click', finishPage);
const finishHanded = $('#finish-handed');
if (finishHanded) finishHanded.addEventListener('click', finishPage);
const closeHanded = $('#close-handed');
if (closeHanded) closeHanded.addEventListener('click', finishPage);

function startPolling() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      paint(await api('/state'));
    } catch {
      $('#error').textContent = '连接程序不可达，请查看终端或重新运行。';
      clearInterval(timer);
      timer = null;
    }
  }, 1200);
}

async function loadMode() {
  if (!token) {
    $('#error').textContent = formatError('unauthorized');
    $('#connect').disabled = true;
    return;
  }
  try {
    const s = await api('/state');
    if (s.mode === 'handoff') {
      $('#mode-badge').textContent = '服务器常驻';
      $('#mode-badge').classList.add('live');
      $('#consent-text').textContent = '仅连接本人私聊，绑定后交由常驻服务运行并开启来信唤醒';
      $('#weixin-cap').textContent = '文字 · 图片 · PDF';
      if (s.tunnelSaved) {
        tunnelSaved = true;
        $('#tunnel-fields').open = false;
        $('#tunnel-summary').textContent = '已沿用现有 Tunnel（点击更换）';
        for (const input of tunnelInputs) {
          input.placeholder = '留空沿用当前配置';
          input.required = false;
        }
      }
    }
    if (s.stage && s.stage !== 'idle') {
      paint(s);
      if (!['failed', 'stopped'].includes(s.stage) && !(s.stage === 'handed_off' && s.subscribed)) {
        startPolling();
      }
    }
  } catch (err) {
    if (err.message === 'unauthorized') {
      $('#error').textContent = formatError('unauthorized');
      $('#connect').disabled = true;
    }
  }
}

platformFields();
void loadMode();
