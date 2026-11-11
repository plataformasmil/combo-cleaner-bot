const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const API_ID = 39588930;
const API_HASH = 'fd7d17de3ced8fed73fdbf66b363c4ef';
const BOT_USERNAME = 'Clener_Text_Niupi_Mateo_bot';
const SESSION_FILE = path.join(__dirname, 'session.txt');

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function clickButton(client, botEntity, dataText) {
  const history = await client.getMessages(botEntity, { limit: 50 });
  for (const msg of history) {
    if (msg.replyMarkup && msg.replyMarkup.rows) {
      for (const row of msg.replyMarkup.rows) {
        for (const btn of row.buttons) {
          if (btn.data && Buffer.from(btn.data).toString('utf-8') === dataText) {
            await client.invoke(new Api.messages.GetBotCallbackAnswer({
              peer: botEntity,
              msgId: msg.id,
              data: btn.data,
            }));
            return true;
          }
        }
      }
    }
  }
  return false;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let savedSession = '';
  if (fs.existsSync(SESSION_FILE)) {
    savedSession = fs.readFileSync(SESSION_FILE, 'utf-8').trim();
  }

  const session = new StringSession(savedSession);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  console.log('\n=== COMBO FORWARDER - @niupimateo ===\n');

  if (!savedSession) {
    console.log('Primera vez: necesitas loguearte con tu numero de Telegram.\n');
  }

  await client.start({
    phoneNumber: async () => await ask(rl, 'Numero de telefono (con codigo pais, ej: +57300...): '),
    password: async () => await ask(rl, 'Contrasena 2FA (si tienes): '),
    phoneCode: async () => await ask(rl, 'Codigo que recibiste en Telegram: '),
    onError: (err) => console.log('Error:', err.message),
  });

  fs.writeFileSync(SESSION_FILE, client.session.save(), 'utf-8');
  console.log('\nSesion guardada.\n');

  console.log('Cargando tus grupos y chats...\n');
  const dialogs = await client.getDialogs({ limit: 100 });

  const groups = dialogs.filter(d => d.isGroup || d.isChannel);

  if (groups.length === 0) {
    console.log('No se encontraron grupos.');
    await client.disconnect();
    rl.close();
    return;
  }

  console.log('=== TUS GRUPOS ===\n');
  groups.forEach((g, i) => {
    const count = g.unreadCount || 0;
    console.log(`  [${i + 1}] ${g.title}${count > 0 ? ` (${count} sin leer)` : ''}`);
  });

  const groupIdx = parseInt(await ask(rl, '\nNumero del grupo: ')) - 1;
  if (groupIdx < 0 || groupIdx >= groups.length) {
    console.log('Indice invalido.');
    await client.disconnect();
    rl.close();
    return;
  }

  const selectedGroup = groups[groupIdx];
  console.log(`\nGrupo seleccionado: ${selectedGroup.title}\n`);

  const fromStr = await ask(rl, 'Fecha inicio (DD/MM/YYYY): ');
  const toStr = await ask(rl, 'Fecha fin (DD/MM/YYYY): ');

  const [fd, fm, fy] = fromStr.split('/').map(Number);
  const [td, tm, ty] = toStr.split('/').map(Number);
  const fromDate = new Date(fy, fm - 1, fd, 0, 0, 0);
  const toDate = new Date(ty, tm - 1, td, 23, 59, 59);

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    console.log('Fecha invalida. Usa formato DD/MM/YYYY');
    await client.disconnect();
    rl.close();
    return;
  }

  const botEntity = await client.getEntity(BOT_USERNAME);

  // Step 1: Send /start to the bot
  console.log('Activando bot... enviando /start');
  await client.sendMessage(botEntity, { message: '/start' });
  await sleep(1500);

  // Step 2: Click "Iniciar" button
  console.log('Presionando boton Iniciar...');
  const clicked = await clickButton(client, botEntity, 'iniciar');
  if (!clicked) {
    console.log('ERROR: No se encontro el boton Iniciar. Asegurate de que el bot este corriendo.');
    await client.disconnect();
    rl.close();
    return;
  }
  await sleep(1500);
  console.log('Bot en modo recepcion!\n');

  // Step 3: Search and forward files
  console.log(`Buscando archivos .txt del ${fromStr} al ${toStr}...\n`);

  const offsetDate = Math.floor(toDate.getTime() / 1000) + 1;
  const minDate = Math.floor(fromDate.getTime() / 1000);

  let totalFound = 0;
  let totalForwarded = 0;
  let offset = 0;
  const batchSize = 100;
  let keepSearching = true;

  while (keepSearching) {
    const messages = await client.getMessages(selectedGroup.entity, {
      limit: batchSize,
      offsetDate: offset === 0 ? offsetDate : undefined,
      addOffset: offset === 0 ? 0 : offset,
      filter: new Api.InputMessagesFilterDocument(),
    });

    if (messages.length === 0) break;

    for (const msg of messages) {
      const msgDate = msg.date;

      if (msgDate < minDate) {
        keepSearching = false;
        break;
      }

      if (msgDate > Math.floor(toDate.getTime() / 1000)) continue;

      if (msg.document) {
        const attrs = msg.document.attributes || [];
        const fileNameAttr = attrs.find(a => a.className === 'DocumentAttributeFilename');
        const fileName = fileNameAttr ? fileNameAttr.fileName : '';

        if (fileName.toLowerCase().endsWith('.txt')) {
          totalFound++;
          process.stdout.write(`  [${totalFound}] Reenviando: ${fileName}...`);

          try {
            await client.forwardMessages(botEntity, {
              messages: [msg.id],
              fromPeer: selectedGroup.entity,
            });
            totalForwarded++;
            console.log(' OK');
          } catch (err) {
            console.log(` ERROR: ${err.message}`);
          }

          await sleep(800);
        }
      }
    }

    offset += messages.length;
    if (messages.length < batchSize) break;
  }

  console.log(`\n  Archivos encontrados: ${totalFound}`);
  console.log(`  Reenviados: ${totalForwarded}\n`);

  if (totalForwarded > 0) {
    // Step 4: Click "Merge" button
    console.log('Presionando boton Merge...');
    await sleep(2000);
    const merged = await clickButton(client, botEntity, 'merge');
    if (merged) {
      console.log('Merge iniciado! El bot esta procesando los archivos.\n');
      console.log('Revisa el chat del bot para ver los resultados.');
    } else {
      console.log('No se pudo presionar Merge automaticamente.');
      console.log('Abre el bot en Telegram y presiona Merge manualmente.');
    }
  } else {
    console.log('No se encontraron archivos .txt en ese rango de fechas.');
  }

  console.log('\n=== RESULTADO ===');
  console.log(`  Grupo: ${selectedGroup.title}`);
  console.log(`  Rango: ${fromStr} - ${toStr}`);
  console.log(`  Archivos .txt: ${totalFound}`);
  console.log(`  Reenviados: ${totalForwarded}\n`);

  await client.disconnect();
  rl.close();
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
