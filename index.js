const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const readline = require('readline');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');

dotenv.config();

const OWNER_ID = (process.env.OWNER_ID || '85217134002343@lid').trim();
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '85217134002343').replace(/\D/g, '');
const BOT_NAME = process.env.BOT_NAME || 'Bot de Ajuda';
const DEFAULT_RESPONSE = process.env.DEFAULT_RESPONSE || 'Desculpe, não encontrei a resposta. Fale com o administrador.';
const GROUPS_ENABLED = process.env.GROUPS_ENABLED !== 'false';
const PRIVATE_ENABLED = process.env.PRIVATE_ENABLED !== 'false';
const USE_GEMINI = process.env.USE_GEMINI === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isOwnerJid(jid) {
  if (!jid) return false;
  const clean = jid.replace(/@.*$/, '');
  const ownerClean = OWNER_ID.replace(/@.*$/, '');
  return clean === ownerClean || jid === OWNER_ID || jid.includes(ownerClean);
}

function extractText(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return '';
}

function initDb() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS faq (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pergunta TEXT NOT NULL,
        resposta TEXT NOT NULL,
        criado_por TEXT,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
}

function addFaq(pergunta, resposta, author) {
  return new Promise((resolve, reject) => {
    const q = normalizeText(pergunta);
    const r = (resposta || '').trim();

    if (!q || !r) {
      return reject(new Error('Pergunta e resposta são obrigatórias.'));
    }

    db.run(
      `INSERT INTO faq (pergunta, resposta, criado_por) VALUES (?, ?, ?)`,
      [q, r, author || 'admin'],
      function (err) {
        if (err) return reject(err);
        resolve({ id: this.lastID, pergunta: q, resposta: r });
      }
    );
  });
}

function listFaq() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM faq ORDER BY id DESC`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function deleteFaq(pergunta) {
  return new Promise((resolve, reject) => {
    const q = normalizeText(pergunta);
    if (!q) return reject(new Error('Pergunta inválida'));
    db.run(`DELETE FROM faq WHERE pergunta = ?`, [q], function (err) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}

function editFaq(pergunta, resposta) {
  return new Promise((resolve, reject) => {
    const q = normalizeText(pergunta);
    const r = (resposta || '').trim();
    if (!q || !r) return reject(new Error('Pergunta e resposta são obrigatórias'));

    db.run(
      `UPDATE faq SET resposta = ?, atualizado_em = CURRENT_TIMESTAMP WHERE pergunta = ?`,
      [r, q],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

function clearFaq() {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM faq`, (err) => {
      if (err) return reject(err);
      resolve(true);
    });
  });
}

function countFaq() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) as total FROM faq`, (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.total : 0);
    });
  });
}

async function findFaqByText(input) {
  const text = normalizeText(input);
  if (!text) return null;

  const words = text.split(' ').filter(Boolean);
  if (!words.length) return null;

  return new Promise((resolve, reject) => {
    let sql = `SELECT * FROM faq WHERE 1 = 0`;
    const params = [];

    for (const word of words) {
      if (word.length < 2) continue;
      sql += ` OR pergunta LIKE ?`;
      params.push(`%${word}%`);
    }

    if (!params.length) return resolve(null);

    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      if (!rows || rows.length === 0) return resolve(null);

      let best = rows[0];
      let bestScore = -1;

      for (const row of rows) {
        const score = normalizeText(row.pergunta).split(' ').filter((w) => text.includes(w)).length;
        if (score > bestScore) {
          bestScore = score;
          best = row;
        }
      }

      resolve(best);
    });
  });
}

let geminiModel = null;

if (USE_GEMINI && GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
}

async function askGemini(message) {
  if (!geminiModel) return null;

  try {
    const result = await geminiModel.generateContent(message);
    const text = await result.response.text();
    return text?.trim() || null;
  } catch (error) {
    console.error('Erro Gemini:', error);
    return null;
  }
}

async function handleOwnerCommand(text, from) {
  const command = text.trim();

  if (command === '!help') {
    return `Comandos de admin:\n!addfaq pergunta | resposta\n!listfaq\n!editfaq pergunta | nova resposta\n!delfaq pergunta\n!clearfaq\n!status`;
  }

  if (command === '!status') {
    const total = await countFaq();
    return `Bot online\nNome: ${BOT_NAME}\nAdmin: ${OWNER_ID}\nFAQ salva: ${total}\nGemini: ${geminiModel ? 'ativo' : 'desativado'}`;
  }

  if (command === '!listfaq') {
    const rows = await listFaq();
    if (!rows.length) return 'Nenhuma FAQ salva ainda.';
    return rows.map((row, i) => `${i + 1}. ${row.pergunta} => ${row.resposta}`).join('\n');
  }

  if (command === '!clearfaq') {
    await clearFaq();
    return '✅ Banco de FAQ limpo.';
  }

  if (command.startsWith('!addfaq ')) {
    const value = command.slice(8).trim();
    const sep = value.indexOf('|');
    if (sep === -1) return 'Formato: !addfaq pergunta | resposta';
    const pergunta = value.slice(0, sep).trim();
    const resposta = value.slice(sep + 1).trim();
    const saved = await addFaq(pergunta, resposta, from);
    return `✅ FAQ salva: ${saved.pergunta}`;
  }

  if (command.startsWith('!editfaq ')) {
    const value = command.slice(9).trim();
    const sep = value.indexOf('|');
    if (sep === -1) return 'Formato: !editfaq pergunta | nova resposta';
    const pergunta = value.slice(0, sep).trim();
    const resposta = value.slice(sep + 1).trim();
    const ok = await editFaq(pergunta, resposta);
    return ok ? `✅ FAQ atualizada: ${pergunta}` : '❌ FAQ não encontrada.';
  }

  if (command.startsWith('!delfaq ')) {
    const pergunta = command.slice(8).trim();
    if (!pergunta) return 'Formato: !delfaq pergunta';
    const ok = await deleteFaq(pergunta);
    return ok ? `✅ FAQ removida: ${pergunta}` : '❌ FAQ não encontrada.';
  }

  return 'Comando desconhecido. Use !help';
}

async function handleIncomingMessage(sock, msg) {
  if (!msg.message || msg.key?.fromMe) return;

  const jid = msg.key.remoteJid;
  if (!jid) return;

  const text = extractText(msg.message);
  if (!text) return;

  const isOwner = isOwnerJid(jid);

  if (text.startsWith('!')) {
    if (!isOwner) {
      await sock.sendMessage(jid, { text: 'Você não tem permissão para usar comandos de admin.' });
      return;
    }

    const resp = await handleOwnerCommand(text, jid);
    await sock.sendMessage(jid, { text: resp });
    return;
  }

  if (!GROUPS_ENABLED && jid.includes('-')) return;
  if (!PRIVATE_ENABLED && !jid.includes('-')) return;

  const faq = await findFaqByText(text);
  if (faq) {
    await sock.sendMessage(jid, { text: faq.resposta });
    return;
  }

  if (USE_GEMINI && geminiModel) {
    const answer = await askGemini(text);
    if (answer) {
      await sock.sendMessage(jid, { text: answer });
      return;
    }
  }

  await sock.sendMessage(jid, { text: DEFAULT_RESPONSE });
}

async function startPairingCode(sock) {
  if (!PHONE_NUMBER) {
    console.log('Defina PHONE_NUMBER no .env');
    return;
  }

  try {
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    console.log('\n🔗 Código de emparelhamento:');
    console.log(code);
    console.log('Abra o WhatsApp > Ajustes > Dispositivos vinculados > Vincular dispositivo');
  } catch (error) {
    console.log('Não foi possível gerar o código de emparelhamento.');
    console.log('Se o código não aparecer, use o QR no celular.');
  }
}

function startTerminal() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = () => {
    rl.question('> ', async (input) => {
      const cmd = input.trim();

      if (!cmd) return ask();

      if (cmd === '!help') {
        console.log('Comandos do terminal:\n!addfaq pergunta | resposta\n!listfaq\n!editfaq pergunta | nova resposta\n!delfaq pergunta\n!clearfaq\n!status');
        return ask();
      }

      if (cmd === '!status') {
        const total = await countFaq();
        console.log(`Bot online | FAQ salva: ${total}`);
        return ask();
      }

      if (cmd === '!listfaq') {
        const rows = await listFaq();
        if (!rows.length) {
          console.log('Nenhuma FAQ salva.');
        } else {
          rows.forEach((row, i) => console.log(`${i + 1}. ${row.pergunta} => ${row.resposta}`));
        }
        return ask();
      }

      if (cmd === '!clearfaq') {
        await clearFaq();
        console.log('✅ FAQ limpa.');
        return ask();
      }

      if (cmd.startsWith('!addfaq ')) {
        const value = cmd.slice(8).trim();
        const sep = value.indexOf('|');
        if (sep === -1) {
          console.log('Formato: !addfaq pergunta | resposta');
          return ask();
        }

        const pergunta = value.slice(0, sep).trim();
        const resposta = value.slice(sep + 1).trim();

        try {
          const saved = await addFaq(pergunta, resposta, 'terminal');
          console.log(`✅ FAQ salva: ${saved.pergunta}`);
        } catch (e) {
          console.log('Erro ao salvar FAQ:', e.message);
        }

        return ask();
      }

      if (cmd.startsWith('!editfaq ')) {
        const value = cmd.slice(9).trim();
        const sep = value.indexOf('|');
        if (sep === -1) {
          console.log('Formato: !editfaq pergunta | nova resposta');
          return ask();
        }

        const pergunta = value.slice(0, sep).trim();
        const resposta = value.slice(sep + 1).trim();

        const ok = await editFaq(pergunta, resposta);
        console.log(ok ? `✅ FAQ atualizada: ${pergunta}` : '❌ FAQ não encontrada.');
        return ask();
      }

      if (cmd.startsWith('!delfaq ')) {
        const pergunta = cmd.slice(8).trim();
        const ok = await deleteFaq(pergunta);
        console.log(ok ? `✅ FAQ removida: ${pergunta}` : '❌ FAQ não encontrada.');
        return ask();
      }

      console.log('Comando não reconhecido. Use !help');
      ask();
    });
  };

  ask();
}

async function startBot() {
  initDb();

  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'session'));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} conectado ao WhatsApp.`);
      console.log(`Admin: ${OWNER_ID}`);
      console.log('Você pode usar !help no privado ou grupo.');
      return;
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = status !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(startBot, 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      await handleIncomingMessage(sock, msg);
    }
  });

  setTimeout(async () => {
    const sessionExists = fs.existsSync(path.join(__dirname, 'session', 'creds.json'));
    if (!sessionExists) {
      await startPairingCode(sock);
    }
  }, 2500);
}

console.log('🤖 Bot:', BOT_NAME);
console.log('💡 Dica: use !addfaq pergunta | resposta no terminal para salvar FAQ');
startTerminal();
startBot();

process.on('SIGINT', () => {
  console.log('\nEncerrando bot...');
  process.exit(0);
});
