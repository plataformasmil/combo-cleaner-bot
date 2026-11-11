const { Bot, InputFile, InlineKeyboard } = require('grammy');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { runValidation, ProxyPool } = require('./validator');

if (!process.env.BOT_TOKEN) {
  console.error('Falta BOT_TOKEN. Usa: BOT_TOKEN=xxx node index.js');
  console.error('O crea un archivo .env con BOT_TOKEN=xxx');
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      }
    }
  } catch {}
  if (!process.env.BOT_TOKEN) { process.exit(1); }
}

const TOKEN = process.env.BOT_TOKEN;
const bot = new Bot(TOKEN);

const API_ID = parseInt(process.env.API_ID || '0');
const API_HASH = process.env.API_HASH || '';
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const ALLOWED_FILE = path.join(__dirname, 'allowed_users.json');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

function loadAllowed() {
  if (!fs.existsSync(ALLOWED_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ALLOWED_FILE, 'utf-8')); } catch { return []; }
}
function saveAllowed(list) { fs.writeFileSync(ALLOWED_FILE, JSON.stringify(list), 'utf-8'); }
function isAllowed(uid) { return uid === ADMIN_ID || loadAllowed().includes(uid); }

const userData = new Map();

function getUser(uid) {
  if (!userData.has(uid)) userData.set(uid, {
    state: 'idle', files: [], counterMsgId: null, lines: 0,
    fwdGroups: null, fwdGroupIdx: null, fwdFrom: null, fwdTo: null,
    valProxies: [], valFile: null, valRunning: false, valConcurrency: 50,
    valComboLines: null, valComboCount: 0,
    linkPhone: null, linkHash: null, linkClient: null,
  });
  return userData.get(uid);
}

function resetUser(u) {
  u.state = 'idle';
  u.files = [];
  u.lines = 0;
  u.counterMsgId = null;
  u.fwdGroups = null;
  u.fwdGroupIdx = null;
  u.fwdFrom = null;
  u.fwdTo = null;
  u.valProxies = [];
  u.valFile = null;
  u.valRunning = false;
  u.valConcurrency = 50;
  u.valComboLines = null;
  u.valComboCount = 0;
  if (u.linkClient) { try { u.linkClient.disconnect(); } catch {} }
  u.linkPhone = null;
  u.linkHash = null;
  u.linkClient = null;
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function bar(pct) {
  const f = Math.round(pct / 10);
  return '\u2588'.repeat(f) + '\u2591'.repeat(10 - f);
}

async function editProgress(ctx, chatId, msgId, pct, text) {
  try {
    await ctx.api.editMessageText(chatId, msgId, '\ud83d\udd04 [ ' + bar(pct) + ' ] ' + pct + '%\n' + text);
  } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const GMAIL_BASES = ['gmail', 'googlemail'];
const HOTMAIL_BASES = ['hotmail', 'outlook', 'live', 'msn', 'windowslive'];
const YAHOO_BASES = ['yahoo', 'ymail', 'rocketmail', 'aol'];

function getProvider(line) {
  const at = line.indexOf('@');
  if (at < 0) return 'imap';
  const after = line.substring(at + 1).toLowerCase();
  const sep = after.search(/[:;|]/);
  const domain = (sep > 0 ? after.substring(0, sep) : after).trim();
  const base = domain.split('.')[0];
  if (GMAIL_BASES.includes(base)) return 'gmail';
  if (HOTMAIL_BASES.includes(base)) return 'hotmail';
  if (YAHOO_BASES.includes(base)) return 'yahoo';
  return 'imap';
}

function startKeyboard() {
  return new InlineKeyboard()
    .text('\u25b6\ufe0f Iniciar', 'iniciar')
    .text('\ud83d\udce4 Reenviar', 'reenviar')
    .row()
    .text('\u2705 Validar', 'validar');
}

function receivingKeyboard() {
  return new InlineKeyboard()
    .text('\ud83d\udd04 Merge', 'merge')
    .text('\ud83d\uddd1 Clear', 'clear')
    .row()
    .text('\ud83d\udcca Status', 'status');
}

// ========== PER-USER TELEGRAM CLIENTS ==========
const userClients = new Map();

function getSessionPath(uid) { return path.join(SESSIONS_DIR, uid + '.txt'); }

async function getUserClientForUid(uid) {
  if (userClients.has(uid)) {
    const c = userClients.get(uid);
    if (c.connected) return c;
    userClients.delete(uid);
  }
  const sp = getSessionPath(uid);
  if (!fs.existsSync(sp)) return null;
  const saved = fs.readFileSync(sp, 'utf-8').trim();
  if (!saved) return null;
  try {
    const session = new StringSession(saved);
    const client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 });
    await client.connect();
    userClients.set(uid, client);
    return client;
  } catch {
    try { fs.unlinkSync(sp); } catch {}
    return null;
  }
}

// ========== /start ==========
bot.command('start', (ctx) => {
  const u = getUser(ctx.from.id);
  resetUser(u);
  const hasSession = fs.existsSync(SESSION_FILE) && fs.readFileSync(SESSION_FILE, 'utf-8').trim();

  let text = '\ud83d\udce7 Text Cleaner Bot - @niupimateo\n\n' +
    '\u25b6\ufe0f Iniciar = enviar .txt manualmente y merge\n' +
    '\ud83d\udce4 Reenviar = jalar .txt de un grupo (cuenta propia)\n' +
    '\u2705 Validar = checker IMAP (solo autorizados)\n\n' +
    'Separa en: Gmail / Hotmail / Yahoo / IMAP\n\n' +
    '\ud83c\udd94 Tu ID: ' + ctx.from.id;

  return ctx.reply(text, { reply_markup: startKeyboard() });
});

// ========== COMANDOS ADMIN ==========
bot.command('myid', (ctx) => ctx.reply('\ud83c\udd94 Tu ID: ' + ctx.from.id));

bot.command('addval', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (isNaN(id)) return ctx.reply('Uso: /addval <user_id>');
  const list = loadAllowed();
  if (!list.includes(id)) { list.push(id); saveAllowed(list); }
  ctx.reply('\u2705 ' + id + ' habilitado para validar.');
});

bot.command('delval', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (isNaN(id)) return ctx.reply('Uso: /delval <user_id>');
  saveAllowed(loadAllowed().filter(x => x !== id));
  ctx.reply('\u274c ' + id + ' removido del validador.');
});

bot.command('listval', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const list = loadAllowed();
  ctx.reply(list.length ? '\ud83d\udccb Usuarios autorizados:\n' + list.join('\n') : 'No hay usuarios autorizados.');
});

bot.command('desconectar', async (ctx) => {
  const uid = ctx.from.id;
  const sp = getSessionPath(uid);
  if (fs.existsSync(sp)) fs.unlinkSync(sp);
  if (userClients.has(uid)) {
    try { userClients.get(uid).disconnect(); } catch {}
    userClients.delete(uid);
  }
  ctx.reply('\ud83d\udd13 Sesion desvinculada. Puedes vincular de nuevo con Reenviar.');
});

// ========== INICIAR ==========
bot.callbackQuery('iniciar', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  u.state = 'receiving';
  u.files = [];
  u.lines = 0;
  u.counterMsgId = null;
  try {
    await ctx.editMessageText(
      '\u2705 Modo recepcion activado!\n\nEnvia o reenvia tus archivos .txt ahora.\nCuando tengas todos, presiona Merge.',
      { reply_markup: receivingKeyboard() }
    );
  } catch {
    await ctx.reply(
      '\u2705 Modo recepcion activado!\n\nEnvia o reenvia tus archivos .txt ahora.\nCuando tengas todos, presiona Merge.',
      { reply_markup: receivingKeyboard() }
    );
  }
});

// ========== VALIDAR FLOW (Combo -> Proxies -> Workers -> Start) ==========
bot.callbackQuery('validar', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);

  if (!isAllowed(ctx.from.id)) {
    return ctx.editMessageText(
      '⛔ No tienes acceso al validador.\nContacta al admin para habilitarte.\n\n🆔 Tu ID: ' + ctx.from.id,
      { reply_markup: new InlineKeyboard().text('🔙 Menu', 'menu') }
    );
  }

  u.state = 'val_combo';
  u.valProxies = [];
  u.valFile = null;
  u.valComboLines = null;
  u.valComboCount = 0;
  u.valConcurrency = 50;

  await ctx.editMessageText(
    '\u2705 Modo Validador IMAP\n\n' +
    'Paso 1/3: Envia el archivo .txt con las combos.\n' +
    'Formato: email:password (uno por linea)',
    { reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu') }
  );
});

// ========== REENVIAR FLOW ==========
bot.callbackQuery('reenviar', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  const uid = ctx.from.id;

  let client;
  try { client = await getUserClientForUid(uid); } catch { client = null; }

  if (!client) {
    u.state = 'fwd_phone';
    return ctx.editMessageText(
      '\ud83d\udcf1 Vincular tu cuenta de Telegram\n\n' +
      'Para jalar archivos de tus grupos necesitas vincular tu cuenta.\n\n' +
      'Envia tu numero de telefono con codigo de pais.\n' +
      'Ejemplo: +573001234567',
      { reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu') }
    );
  }

  await ctx.editMessageText('\u23f3 Cargando tus grupos...');

  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    const groups = dialogs.filter(d => d.isGroup || d.isChannel);

    if (groups.length === 0) {
      return ctx.editMessageText('No se encontraron grupos.', {
        reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu'),
      });
    }

    u.fwdGroups = groups;
    u.state = 'fwd_select_group';

    const PAGE_SIZE = 8;
    const kb = new InlineKeyboard();
    groups.slice(0, PAGE_SIZE).forEach((g, i) => {
      kb.text(g.title.substring(0, 40), 'fwd_grp_' + i).row();
    });
    if (groups.length > PAGE_SIZE) kb.text('\u25b6 Mas grupos (' + (groups.length - PAGE_SIZE) + ' mas)', 'fwd_page_1');
    kb.row().text('\ud83d\udd13 Desvincular', 'fwd_unlink').text('\ud83d\udd19 Menu', 'menu');

    await ctx.editMessageText('\ud83d\udcc2 Selecciona el grupo:', { reply_markup: kb });
  } catch (err) {
    await ctx.editMessageText('Error cargando grupos: ' + err.message, {
      reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu'),
    });
  }
});

// Group pagination
bot.callbackQuery(/^fwd_page_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  if (!u.fwdGroups) return;
  const page = parseInt(ctx.match[1]);
  const PAGE_SIZE = 8;
  const start = page * PAGE_SIZE;
  const groups = u.fwdGroups;
  const kb = new InlineKeyboard();
  groups.slice(start, start + PAGE_SIZE).forEach((g, i) => {
    kb.text(g.title.substring(0, 40), 'fwd_grp_' + (start + i)).row();
  });
  if (start > 0) kb.text('\u25c0 Anterior', 'fwd_page_' + (page - 1));
  if (start + PAGE_SIZE < groups.length) kb.text('\u25b6 Siguiente', 'fwd_page_' + (page + 1));
  kb.row().text('\ud83d\udd19 Menu', 'menu');
  await ctx.editMessageText('\ud83d\udcc2 Selecciona el grupo:', { reply_markup: kb });
});

// Group selected
bot.callbackQuery(/^fwd_grp_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  if (!u.fwdGroups) return;
  u.fwdGroupIdx = parseInt(ctx.match[1]);
  u.state = 'fwd_date_from';
  const groupName = u.fwdGroups[u.fwdGroupIdx].title;
  await ctx.editMessageText(
    '\ud83d\udcc2 Grupo: ' + groupName + '\n\n\ud83d\udcc5 Escribe la fecha INICIO (DD/MM/YYYY):',
    { reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu') }
  );
});

// ========== TEXT MESSAGE HANDLER ==========
bot.on('message:text', async (ctx) => {
  const u = getUser(ctx.from.id);
  const uid = ctx.from.id;

  // ---- Vincular cuenta: telefono ----
  if (u.state === 'fwd_phone') {
    const phone = ctx.message.text.trim().replace(/\s/g, '');
    if (!phone.startsWith('+') || phone.length < 8) {
      return ctx.reply('Formato invalido. Envia con codigo de pais: +573001234567');
    }
    try {
      await ctx.reply('⏳ Enviando codigo de verificacion...');
      const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 });
      await client.connect();
      const result = await client.invoke(new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: API_ID,
        apiHash: API_HASH,
        settings: new Api.CodeSettings({}),
      }));
      u.linkClient = client;
      u.linkPhone = phone;
      u.linkHash = result.phoneCodeHash;
      u.state = 'fwd_code';
      return ctx.reply(
        '✅ Codigo enviado a tu Telegram!\n\n' +
        'Escribe el codigo que recibiste.\n' +
        'Si tiene espacios, escribelo junto: 12345',
        { reply_markup: new InlineKeyboard().text('❌ Cancelar', 'menu') }
      );
    } catch (err) {
      u.linkClient = null;
      return ctx.reply('❌ Error: ' + (err.errorMessage || err.message) + '\n\nIntenta de nuevo o presiona Menu.', {
        reply_markup: new InlineKeyboard().text('🔙 Menu', 'menu'),
      });
    }
  }

  // ---- Vincular cuenta: codigo ----
  if (u.state === 'fwd_code') {
    const code = ctx.message.text.trim().replace(/\s/g, '');
    if (!u.linkClient || !u.linkPhone || !u.linkHash) {
      u.state = 'idle';
      return ctx.reply('Sesion expirada. Intenta de nuevo.', { reply_markup: startKeyboard() });
    }
    try {
      await u.linkClient.invoke(new Api.auth.SignIn({
        phoneNumber: u.linkPhone,
        phoneCodeHash: u.linkHash,
        phoneCode: code,
      }));
      const sessionStr = u.linkClient.session.save();
      fs.writeFileSync(getSessionPath(uid), sessionStr, 'utf-8');
      userClients.set(uid, u.linkClient);
      u.linkClient = null;
      u.linkPhone = null;
      u.linkHash = null;
      u.state = 'idle';
      return ctx.reply(
        '✅ Cuenta vinculada correctamente!\n\n' +
        'Ahora puedes usar Reenviar para jalar archivos de tus grupos.\n' +
        'Usa /desconectar para desvincular.',
        { reply_markup: startKeyboard() }
      );
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        u.state = 'fwd_2fa';
        return ctx.reply(
          '🔒 Tu cuenta tiene verificacion en 2 pasos.\n\nEscribe tu contrasena:',
          { reply_markup: new InlineKeyboard().text('❌ Cancelar', 'menu') }
        );
      }
      if (err.errorMessage === 'PHONE_CODE_INVALID' || err.errorMessage === 'PHONE_CODE_EXPIRED') {
        return ctx.reply('❌ Codigo invalido o expirado. Intenta de nuevo:');
      }
      u.state = 'idle';
      u.linkClient = null;
      return ctx.reply('❌ Error: ' + (err.errorMessage || err.message), { reply_markup: startKeyboard() });
    }
  }

  // ---- Vincular cuenta: 2FA password ----
  if (u.state === 'fwd_2fa') {
    if (!u.linkClient) {
      u.state = 'idle';
      return ctx.reply('Sesion expirada.', { reply_markup: startKeyboard() });
    }
    try {
      const passwordData = await u.linkClient.invoke(new Api.account.GetPassword());
      const { computeCheck } = require('telegram/Password');
      const srpCheck = await computeCheck(passwordData, ctx.message.text.trim());
      await u.linkClient.invoke(new Api.auth.CheckPassword({ password: srpCheck }));
      const sessionStr = u.linkClient.session.save();
      fs.writeFileSync(getSessionPath(uid), sessionStr, 'utf-8');
      userClients.set(uid, u.linkClient);
      u.linkClient = null;
      u.linkPhone = null;
      u.linkHash = null;
      u.state = 'idle';
      try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {}
      return ctx.reply(
        '✅ Cuenta vinculada correctamente!\n\nUsa /desconectar para desvincular.',
        { reply_markup: startKeyboard() }
      );
    } catch (err) {
      if (err.errorMessage === 'PASSWORD_HASH_INVALID') {
        return ctx.reply('❌ Contrasena incorrecta. Intenta de nuevo:');
      }
      u.state = 'idle';
      u.linkClient = null;
      return ctx.reply('❌ Error: ' + (err.errorMessage || err.message), { reply_markup: startKeyboard() });
    }
  }

  // Proxy input: text paste or "sin proxies"
  if (u.state === 'val_proxies') {
    const text = ctx.message.text.trim();
    if (text.toLowerCase().includes('sin prox')) {
      u.valProxies = [];
      u.state = 'val_threads';
      return ctx.reply(
        '\u2705 Sin proxies.\n\nPaso 3/3: Cuantos workers?\nSin proxies se recomienda bajo.',
        { reply_markup: new InlineKeyboard()
          .text('3', 'val_t_3').text('5', 'val_t_5').text('10', 'val_t_10')
          .row().text('\ud83d\udd19 Menu', 'menu') }
      );
    }
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length > 0) {
      u.valProxies = lines;
      const pool = new ProxyPool(lines);
      if (pool.total > 0) {
        const st = pool.stats();
        const detected = [];
        if (st.socks5) detected.push('SOCKS5: ' + st.socks5);
        if (st.socks4) detected.push('SOCKS4: ' + st.socks4);
        if (st.http) detected.push('HTTP: ' + st.http);
        u.state = 'val_threads';
        return ctx.reply(
          '\u2705 ' + pool.total + ' proxies cargados!\n\ud83c\udf10 ' + detected.join(' | ') +
          '\n\nPaso 3/3: Cuantos workers?',
          { reply_markup: new InlineKeyboard()
            .text('50', 'val_t_50').text('100', 'val_t_100').text('200', 'val_t_200')
            .row().text('\ud83d\udd19 Menu', 'menu') }
        );
      }
    }
    return ctx.reply('No se reconocio el formato. Envia un .txt, pega las proxies, o escribe "sin proxies".');
  }

  // Custom thread count
  if (u.state === 'val_threads') {
    const num = parseInt(ctx.message.text.trim());
    if (isNaN(num) || num < 1 || num > 500) {
      return ctx.reply('Numero invalido. Escribe un numero entre 1 y 500.');
    }
    u.valConcurrency = num;
    u.state = 'val_ready';
    return ctx.reply(
      '\u2705 Configuracion lista:\n' +
      '\ud83d\udce6 Combos: ' + (u.valComboCount || '?') + '\n' +
      '\ud83c\udf10 Proxies: ' + (u.valProxies.length || 'sin proxies') + '\n' +
      '\ud83d\udcbb Workers: ' + num + '\n\nPresiona Iniciar Validacion.',
      { reply_markup: new InlineKeyboard().text('\ud83d\ude80 Iniciar Validacion', 'val_start').text('\u274c Cancelar', 'menu') }
    );
  }

  // Date inputs for forwarder
  if (u.state === 'fwd_date_from') {
    const text = ctx.message.text.trim();
    const parts = text.split('/');
    if (parts.length !== 3) return ctx.reply('Formato invalido. Usa DD/MM/YYYY');
    const [d, m, y] = parts.map(Number);
    const date = new Date(y, m - 1, d);
    if (isNaN(date.getTime())) return ctx.reply('Fecha invalida.');
    u.fwdFrom = text;
    u.state = 'fwd_date_to';
    const groupName = u.fwdGroups[u.fwdGroupIdx].title;
    return ctx.reply(
      '\ud83d\udcc2 Grupo: ' + groupName + '\n\ud83d\udcc5 Desde: ' + text + '\n\nEscribe la fecha FIN (DD/MM/YYYY):',
      { reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu') }
    );
  }

  if (u.state === 'fwd_date_to') {
    const text = ctx.message.text.trim();
    const parts = text.split('/');
    if (parts.length !== 3) return ctx.reply('Formato invalido. Usa DD/MM/YYYY');
    const [d, m, y] = parts.map(Number);
    const date = new Date(y, m - 1, d);
    if (isNaN(date.getTime())) return ctx.reply('Fecha invalida.');
    u.fwdTo = text;
    u.state = 'fwd_confirm';
    const groupName = u.fwdGroups[u.fwdGroupIdx].title;
    return ctx.reply(
      '\ud83d\udce4 Confirmar reenvio:\n\n\ud83d\udcc2 Grupo: ' + groupName +
      '\n\ud83d\udcc5 Desde: ' + u.fwdFrom + '\n\ud83d\udcc5 Hasta: ' + u.fwdTo,
      { reply_markup: new InlineKeyboard().text('\u2705 Confirmar', 'fwd_go').text('\u274c Cancelar', 'menu') }
    );
  }
});

// ========== DOCUMENT HANDLER ==========
bot.on('message:document', async (ctx) => {
  const u = getUser(ctx.from.id);
  const doc = ctx.message.document;
  if (!doc.file_name || !doc.file_name.toLowerCase().endsWith('.txt')) return;

  // Validator: combo file (STEP 1)
  if (u.state === 'val_combo') {
    if (u.valRunning) return ctx.reply('Ya hay una validacion en curso. Espera a que termine.');

    try {
      const file = await ctx.api.getFile(doc.file_id);
      const url = 'https://api.telegram.org/file/bot' + TOKEN + '/' + file.file_path;
      const content = await downloadFile(url);
      const comboLines = content.split('\n').filter(l => l.trim());

      if (comboLines.length === 0) return ctx.reply('Archivo vacio.');

      u.valComboLines = comboLines;
      u.valComboCount = comboLines.length;
      u.state = 'val_proxies';
      return ctx.reply(
        '\u2705 ' + comboLines.length + ' combos cargados!\n\n' +
        'Paso 2/3: Proxies\n' +
        '\u2022 Envia un archivo .txt con proxies\n' +
        '\u2022 Pega las proxies aqui (una por linea)\n' +
        '\u2022 Escribe "sin proxies"\n\n' +
        'Formatos: host:port:user:pass, socks5://..., http://...',
        { reply_markup: new InlineKeyboard().text('Sin proxies', 'val_no_proxy').text('\ud83d\udd19 Menu', 'menu') }
      );
    } catch (err) {
      return ctx.reply('Error: ' + err.message);
    }
  }

  // Validator: proxy file (STEP 2)
  if (u.state === 'val_proxies') {
    try {
      const file = await ctx.api.getFile(doc.file_id);
      const url = 'https://api.telegram.org/file/bot' + TOKEN + '/' + file.file_path;
      const content = await downloadFile(url);
      const lines = content.split('\n').filter(l => l.trim());
      u.valProxies = lines;
      const pool = new ProxyPool(lines);
      const st = pool.stats();
      const detected = [];
      if (st.socks5) detected.push('SOCKS5: ' + st.socks5);
      if (st.socks4) detected.push('SOCKS4: ' + st.socks4);
      if (st.http) detected.push('HTTP: ' + st.http);
      const invalidCount = lines.length - pool.total;
      u.state = 'val_threads';
      return ctx.reply(
        '\u2705 ' + pool.total + ' proxies cargados!\n' +
        '\ud83c\udf10 ' + detected.join(' | ') +
        (invalidCount > 0 ? '\n\u26a0\ufe0f ' + invalidCount + ' lineas invalidas ignoradas' : '') +
        '\n\nPaso 3/3: Cuantos workers?',
        { reply_markup: new InlineKeyboard()
          .text('50', 'val_t_50').text('100', 'val_t_100').text('200', 'val_t_200')
          .row().text('\ud83d\udd19 Menu', 'menu') }
      );
    } catch (err) {
      return ctx.reply('Error leyendo proxies: ' + err.message);
    }
  }

  // Normal receiving mode (cleaner)
  if (u.state !== 'receiving') {
    return ctx.reply('Primero presiona Iniciar para entrar en modo recepcion.', { reply_markup: startKeyboard() });
  }

  try {
    const file = await ctx.api.getFile(doc.file_id);
    const url = 'https://api.telegram.org/file/bot' + TOKEN + '/' + file.file_path;
    const content = await downloadFile(url);
    const lineCount = content.split('\n').filter(l => l.trim()).length;

    u.files.push(content);
    u.lines += lineCount;

    const text = '\ud83d\udce6 Archivos almacenados: ' + u.files.length + '\n\ud83d\udcdd Lineas totales: ' + u.lines.toLocaleString() + '\n\nSigue enviando o presiona Merge.';

    try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {}

    if (u.counterMsgId) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, u.counterMsgId, text, { reply_markup: receivingKeyboard() });
        return;
      } catch {}
    }

    const sent = await ctx.reply(text, { reply_markup: receivingKeyboard() });
    u.counterMsgId = sent.message_id;
  } catch (err) {
    await ctx.reply('Error: ' + err.message);
  }
});

// ========== FWD EXECUTE ==========
bot.callbackQuery('fwd_go', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  const chatId = ctx.chat.id;

  if (!u.fwdGroups || u.fwdGroupIdx == null || !u.fwdFrom || !u.fwdTo) {
    return ctx.editMessageText('Error: datos incompletos.', { reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu') });
  }

  let client;
  try { client = await getUserClientForUid(ctx.from.id); } catch {
    return ctx.editMessageText('Error conectando. Usa /desconectar y vincula de nuevo.', { reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu') });
  }

  const group = u.fwdGroups[u.fwdGroupIdx];
  const [fd, fm, fy] = u.fwdFrom.split('/').map(Number);
  const [td, tm, ty] = u.fwdTo.split('/').map(Number);
  const fromDate = new Date(fy, fm - 1, fd, 0, 0, 0);
  const toDate = new Date(ty, tm - 1, td, 23, 59, 59);
  const minDate = Math.floor(fromDate.getTime() / 1000);
  const offsetDate = Math.floor(toDate.getTime() / 1000) + 1;

  await ctx.editMessageText('\ud83d\udd04 Buscando archivos en ' + group.title + '...');
  const msgId = ctx.callbackQuery.message.message_id;

  let totalFound = 0;
  let offset = 0;
  const batchSize = 100;
  let keepSearching = true;
  const collectedFiles = [];

  while (keepSearching) {
    const messages = await client.getMessages(group.entity, {
      limit: batchSize,
      offsetDate: offset === 0 ? offsetDate : undefined,
      addOffset: offset === 0 ? 0 : offset,
      filter: new Api.InputMessagesFilterDocument(),
    });
    if (messages.length === 0) break;

    for (const msg of messages) {
      if (msg.date < minDate) { keepSearching = false; break; }
      if (msg.date > Math.floor(toDate.getTime() / 1000)) continue;
      if (msg.document) {
        const attrs = msg.document.attributes || [];
        const fileNameAttr = attrs.find(a => a.className === 'DocumentAttributeFilename');
        const fileName = fileNameAttr ? fileNameAttr.fileName : '';
        if (fileName.toLowerCase().endsWith('.txt')) {
          totalFound++;
          if (totalFound % 10 === 0) {
            try { await ctx.api.editMessageText(chatId, msgId, '\ud83d\udd04 Descargando... ' + totalFound + ' archivos'); } catch {}
          }
          try {
            const buffer = await client.downloadMedia(msg, {});
            if (buffer) collectedFiles.push(Buffer.from(buffer).toString('utf-8'));
          } catch {}
          await sleep(200);
        }
      }
    }
    offset += messages.length;
    if (messages.length < batchSize) break;
  }

  if (collectedFiles.length === 0) {
    return ctx.api.editMessageText(chatId, msgId, 'No se encontraron .txt en ese rango.', { reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu') });
  }

  await ctx.api.editMessageText(chatId, msgId, '\ud83d\udd04 Procesando ' + collectedFiles.length + ' archivos...');

  const allLines = collectedFiles.join('\n').split('\n');
  const totalRaw = allLines.length;
  const seen = new Set();
  const cleaned = [];
  let emptyCount = 0, dupes = 0;

  for (const line of allLines) {
    const s = line.trim();
    if (!s) { emptyCount++; continue; }
    const n = s.toLowerCase();
    if (seen.has(n)) { dupes++; continue; }
    seen.add(n);
    cleaned.push(s);
  }

  cleaned.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const provGroups = { gmail: [], hotmail: [], yahoo: [], imap: [] };
  for (const line of cleaned) provGroups[getProvider(line)].push(line);

  const tmpDir = os.tmpdir();
  const tmpFiles = [];

  const allFile = path.join(tmpDir, 'todos_' + cleaned.length + '.txt');
  fs.writeFileSync(allFile, cleaned.join('\n'), 'utf-8');
  tmpFiles.push(allFile);

  for (const [name, lines] of Object.entries(provGroups)) {
    if (lines.length > 0) {
      const f = path.join(tmpDir, name + '_' + lines.length + '.txt');
      fs.writeFileSync(f, lines.join('\n'), 'utf-8');
      tmpFiles.push(f);
    }
  }

  await ctx.api.editMessageText(chatId, msgId, '\u2705 Proceso finalizado!');

  const stats = '\u2705 Reenvio completado!\n\n' +
    '\ud83d\udcc2 Grupo: ' + group.title + '\n' +
    '\ud83d\udcc5 ' + u.fwdFrom + ' - ' + u.fwdTo + '\n\n' +
    'Archivos: ' + collectedFiles.length + '\nLineas: ' + totalRaw.toLocaleString() + '\n' +
    'Duplicados: ' + dupes.toLocaleString() + '\nUnicas: ' + cleaned.length.toLocaleString() + '\n\n' +
    'Gmail: ' + provGroups.gmail.length.toLocaleString() + '\n' +
    'Hotmail: ' + provGroups.hotmail.length.toLocaleString() + '\n' +
    'Yahoo: ' + provGroups.yahoo.length.toLocaleString() + '\n' +
    'IMAP: ' + provGroups.imap.length.toLocaleString();

  try {
    await ctx.api.sendDocument(chatId, new InputFile(allFile, 'todos_' + cleaned.length + '.txt'), { caption: stats });
  } catch (err) {
    await ctx.api.sendMessage(chatId, 'Error: ' + err.message);
  }

  for (const [name, lines] of Object.entries(provGroups)) {
    if (lines.length > 0) {
      await sleep(500);
      const f = path.join(tmpDir, name + '_' + lines.length + '.txt');
      try {
        await ctx.api.sendDocument(chatId, new InputFile(f, name + '_' + lines.length + '.txt'), {
          caption: name.toUpperCase() + ' - ' + lines.length.toLocaleString() + ' lineas',
        });
      } catch {}
    }
  }

  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
  resetUser(u);
  await ctx.api.sendMessage(chatId, 'Listo.', { reply_markup: startKeyboard() });
});

// ========== UNLINK SESSION ==========
bot.callbackQuery('fwd_unlink', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const uid = ctx.from.id;
  const sp = getSessionPath(uid);
  if (fs.existsSync(sp)) fs.unlinkSync(sp);
  if (userClients.has(uid)) {
    try { userClients.get(uid).disconnect(); } catch {}
    userClients.delete(uid);
  }
  await ctx.editMessageText('🔓 Sesion desvinculada.', { reply_markup: startKeyboard() });
});

// ========== VALIDATOR CALLBACKS ==========

// Thread count buttons
bot.callbackQuery(/^val_t_(\d+)$/, async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  const num = parseInt(ctx.match[1]);
  u.valConcurrency = num;
  u.state = 'val_ready';
  await ctx.editMessageText(
    '\u2705 Configuracion lista:\n' +
    '\ud83d\udce6 Combos: ' + (u.valComboCount || '?') + '\n' +
    '\ud83c\udf10 Proxies: ' + (u.valProxies.length || 'sin proxies') + '\n' +
    '\ud83d\udcbb Workers: ' + num + '\n\nPresiona Iniciar Validacion.',
    { reply_markup: new InlineKeyboard().text('\ud83d\ude80 Iniciar Validacion', 'val_start').text('\u274c Cancelar', 'menu') }
  );
});

// "Sin proxies" button
bot.callbackQuery('val_no_proxy', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  u.valProxies = [];
  u.state = 'val_threads';
  await ctx.editMessageText(
    '\u2705 Sin proxies.\n\nPaso 3/3: Cuantos workers?\nSin proxies se recomienda bajo.',
    { reply_markup: new InlineKeyboard()
      .text('3', 'val_t_3').text('5', 'val_t_5').text('10', 'val_t_10')
      .row().text('\ud83d\udd19 Menu', 'menu') }
  );
});

// Start validation button
bot.callbackQuery('val_start', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  const chatId = ctx.chat.id;

  if (!u.valComboLines || u.valComboLines.length === 0) {
    return ctx.editMessageText('Error: no hay combos.', { reply_markup: new InlineKeyboard().text('\ud83d\udd19 Menu', 'menu') });
  }

  u.valRunning = true;
  const comboLines = u.valComboLines;
  const concurrency = Math.min(u.valConcurrency || 50, comboLines.length);

  await ctx.editMessageText(
    '\ud83d\udd04 Iniciando validacion...\n' +
    '\ud83d\udce6 Combos: ' + comboLines.length + '\n' +
    '\ud83c\udf10 Proxies: ' + (u.valProxies.length || 'sin proxies') + '\n' +
    '\ud83d\udcbb Workers: ' + concurrency
  );
  const msgId = ctx.callbackQuery.message.message_id;

  let lastUpdate = 0;

  runValidation(comboLines, u.valProxies, concurrency, (processed, results, pool) => {
    const now = Date.now();
    if (now - lastUpdate < 3000) return;
    lastUpdate = now;
    const pct = Math.round((processed / results.total) * 100);
    const proxyInfo = pool && pool.total > 0 ? '\n\ud83c\udf10 Proxies: ' + pool.alive + '/' + pool.total + ' vivos' : '';
    try {
      ctx.api.editMessageText(chatId, msgId,
        '\ud83d\udd04 [ ' + bar(pct) + ' ] ' + pct + '%\n' +
        '\u2705 HIT: ' + results.hit.length + '  \u274c BAD: ' + results.bad.length + '  \u26a0\ufe0f EXC: ' + results.exc.length +
        '\n\ud83d\udccb ' + processed + '/' + results.total + proxyInfo
      ).catch(() => {});
    } catch {}
  }).then(async (results) => {
    u.valRunning = false;

    try {
      await ctx.api.editMessageText(chatId, msgId,
        '\u2705 Validacion completada!\n\n' +
        '\u2705 HIT: ' + results.hit.length + '\n\u274c BAD: ' + results.bad.length + '\n\u26a0\ufe0f EXC: ' + results.exc.length +
        '\n\ud83d\udccb Total: ' + results.total
      );
    } catch {}

    const tmpDir = os.tmpdir();

    if (results.hit.length > 0) {
      const hitFile = path.join(tmpDir, 'hit_' + results.hit.length + '.txt');
      fs.writeFileSync(hitFile, results.hit.join('\n'), 'utf-8');
      try {
        await ctx.api.sendDocument(chatId, new InputFile(hitFile, 'hit_' + results.hit.length + '.txt'), {
          caption: '\u2705 HIT - ' + results.hit.length + ' cuentas validas',
        });
      } catch (err) {
        await ctx.api.sendMessage(chatId, 'Error enviando hits: ' + err.message);
      }
      try { fs.unlinkSync(hitFile); } catch {}
    }

    if (results.bad.length > 0) {
      const badFile = path.join(tmpDir, 'bad_' + results.bad.length + '.txt');
      fs.writeFileSync(badFile, results.bad.join('\n'), 'utf-8');
      try {
        await ctx.api.sendDocument(chatId, new InputFile(badFile, 'bad_' + results.bad.length + '.txt'), {
          caption: '\u274c BAD - ' + results.bad.length + ' cuentas invalidas',
        });
      } catch (err) {
        await ctx.api.sendMessage(chatId, 'Error enviando bads: ' + err.message);
      }
      try { fs.unlinkSync(badFile); } catch {}
    }

    if (results.exc.length > 0) {
      const excFile = path.join(tmpDir, 'exc_' + results.exc.length + '.txt');
      fs.writeFileSync(excFile, results.exc.join('\n'), 'utf-8');
      try {
        await ctx.api.sendDocument(chatId, new InputFile(excFile, 'exc_' + results.exc.length + '.txt'), {
          caption: '\u26a0\ufe0f EXC - ' + results.exc.length + ' errores de conexion',
        });
      } catch (err) {
        await ctx.api.sendMessage(chatId, 'Error enviando exc: ' + err.message);
      }
      try { fs.unlinkSync(excFile); } catch {}
    }

    await ctx.api.sendMessage(chatId, 'Validacion terminada.', { reply_markup: startKeyboard() });
    resetUser(u);
  }).catch(async (err) => {
    u.valRunning = false;
    await ctx.api.sendMessage(chatId, 'Error: ' + err.message, { reply_markup: startKeyboard() });
    resetUser(u);
  });
});

// ========== MENU ==========
bot.callbackQuery('menu', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  resetUser(u);
  const text = '\ud83d\udce7 Text Cleaner Bot - @niupimateo\n\n' +
    '\u25b6\ufe0f Iniciar = enviar .txt y merge\n' +
    '\ud83d\udce4 Reenviar = jalar de grupo (cuenta propia)\n' +
    '\u2705 Validar = checker IMAP (solo autorizados)';
  try { await ctx.editMessageText(text, { reply_markup: startKeyboard() }); }
  catch { await ctx.reply(text, { reply_markup: startKeyboard() }); }
});

// ========== MERGE ==========
bot.callbackQuery('merge', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);

  if (u.files.length === 0) {
    try { return ctx.answerCallbackQuery({ text: 'No hay archivos.', show_alert: true }); } catch { return; }
  }

  const statusMsg = await ctx.reply('\ud83d\udd04 [ ' + bar(0) + ' ] 0%\nIniciando...');
  const msgId = statusMsg.message_id;
  const chatId = ctx.chat.id;

  await sleep(300);
  await editProgress(ctx, chatId, msgId, 15, 'Uniendo ' + u.files.length + ' archivos...');

  const allLines = u.files.join('\n').split('\n');
  const totalRaw = allLines.length;

  await editProgress(ctx, chatId, msgId, 30, 'Limpiando...');

  const seen = new Set();
  const cleaned = [];
  let emptyCount = 0, dupes = 0;

  for (const line of allLines) {
    const s = line.trim();
    if (!s) { emptyCount++; continue; }
    const n = s.toLowerCase();
    if (seen.has(n)) { dupes++; continue; }
    seen.add(n);
    cleaned.push(s);
  }

  await editProgress(ctx, chatId, msgId, 50, dupes.toLocaleString() + ' duplicados eliminados...');

  cleaned.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  await editProgress(ctx, chatId, msgId, 65, 'Separando...');

  const groups = { gmail: [], hotmail: [], yahoo: [], imap: [] };
  for (const line of cleaned) groups[getProvider(line)].push(line);

  await editProgress(ctx, chatId, msgId, 80, 'Generando archivos...');

  const tmpDir = os.tmpdir();
  const tmpFiles = [];

  const allFile = path.join(tmpDir, 'todos_' + cleaned.length + '.txt');
  fs.writeFileSync(allFile, cleaned.join('\n'), 'utf-8');
  tmpFiles.push(allFile);

  for (const [name, lines] of Object.entries(groups)) {
    if (lines.length > 0) {
      const f = path.join(tmpDir, name + '_' + lines.length + '.txt');
      fs.writeFileSync(f, lines.join('\n'), 'utf-8');
      tmpFiles.push(f);
    }
  }

  await editProgress(ctx, chatId, msgId, 95, 'Enviando...');

  const stats = '\u2705 Proceso finalizado!\n\n' +
    'Archivos: ' + u.files.length + '\nLineas: ' + totalRaw.toLocaleString() + '\n' +
    'Vacias: ' + emptyCount.toLocaleString() + '\nDuplicados: ' + dupes.toLocaleString() + '\n' +
    'Unicas: ' + cleaned.length.toLocaleString() + '\n\n' +
    'Gmail: ' + groups.gmail.length.toLocaleString() + '\n' +
    'Hotmail: ' + groups.hotmail.length.toLocaleString() + '\n' +
    'Yahoo: ' + groups.yahoo.length.toLocaleString() + '\n' +
    'IMAP: ' + groups.imap.length.toLocaleString();

  try { await ctx.api.editMessageText(chatId, msgId, '\u2705 100% Listo!'); } catch {}

  try {
    await ctx.replyWithDocument(new InputFile(allFile, 'todos_' + cleaned.length + '.txt'), { caption: stats });
  } catch (err) {
    await ctx.reply('Error: ' + err.message);
  }

  for (const [name, lines] of Object.entries(groups)) {
    if (lines.length > 0) {
      await sleep(500);
      const f = path.join(tmpDir, name + '_' + lines.length + '.txt');
      try {
        await ctx.replyWithDocument(new InputFile(f, name + '_' + lines.length + '.txt'), {
          caption: name.toUpperCase() + ' - ' + lines.length.toLocaleString() + ' lineas',
        });
      } catch {}
    }
  }

  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
  resetUser(u);
  await ctx.reply('Completado.', { reply_markup: startKeyboard() });
});

bot.callbackQuery('clear', async (ctx) => {
  try { await ctx.answerCallbackQuery(); } catch {}
  const u = getUser(ctx.from.id);
  const count = u.files.length;
  resetUser(u);
  return ctx.reply(count + ' archivos eliminados.', { reply_markup: startKeyboard() });
});

bot.callbackQuery('status', async (ctx) => {
  const u = getUser(ctx.from.id);
  if (u.files.length === 0) return ctx.answerCallbackQuery({ text: 'No hay archivos.', show_alert: true });
  try { return ctx.answerCallbackQuery({ text: 'Archivos: ' + u.files.length + ' | Lineas: ' + u.lines.toLocaleString(), show_alert: true }); } catch { return; }
});

bot.catch((err) => {
  console.error('Bot error (no crash):', err.message || err);
});

bot.start();
console.log('Bot iniciado...');
