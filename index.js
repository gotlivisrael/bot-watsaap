// index.js - מעודכן לפי הבקשות שלך
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');

// admin JID - המספר שנתת: 0559555800 -> בינלאומי +972559555800
const adminJid = '972559555800@s.whatsapp.net';

const warnedUsers = new Set();
const infoSentUsers = new Set(); // משתמשים שלא נענים יותר (לדוגמה: כתבו "לא מעונין")
const formUsers = {};
const greetedUsers = new Set();

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 סרוק את ה-QR הבא כדי להתחבר:');
      qrcode.generate(qr, { small: false });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : false;
      console.log('❌ החיבור נסגר:', lastDisconnect?.error, 'מתחבר מחדש:', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('🎉 הבוט מחובר בהצלחה ל-WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg || !msg.message || msg.key?.fromMe) return;

      const jid = msg.key.remoteJid;
      if (!jid || !jid.endsWith('@s.whatsapp.net')) return; // רק צ'אטים פרטיים

      const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const t = (rawText || '').toString().toLowerCase().trim();
      console.log('📨 הודעה נכנסת מ:', jid, '| raw:', rawText, '| normalized:', t);

      // אזהרה ראשונית - פעם אחת
      if (!warnedUsers.has(jid)) {
        await sock.sendMessage(jid, { text: 'זהו מענה אוטמטי מבוט שנמצא בתהליכי פיתוח אפשר להגיב לו' });
        warnedUsers.add(jid);
      }

      // אם המשתמש כבר סומן כ"לא מעונין" - לא נענה לו יותר
      if (infoSentUsers.has(jid)) {
        console.log('ℹ️ לא מגיבים ל:', jid, '(מסומן כלא מעונין)');
        return;
      }

      // אם באמצע טופס - המשך
      if (formUsers[jid]) {
        await handleFormProcess(sock, jid, msg);
        return;
      }

      // 1) תגובת רשימה אינטראקטיבית
      if (msg.message.listResponseMessage) {
        const selectedId = msg.message.listResponseMessage.singleSelectReply?.selectedRowId
          || msg.message.listResponseMessage.selectedRowId;
        console.log('🔘 listResponseMessage selectedId =', selectedId);
        if (selectedId) {
          await processMenuSelection(sock, jid, selectedId);
          return;
        }
      }

      // 2) תגובת כפתור
      if (msg.message.buttonsResponseMessage) {
        const sel = msg.message.buttonsResponseMessage.selectedButtonId;
        console.log('🔘 buttonsResponseMessage selectedButtonId =', sel);
        if (sel) {
          await processMenuSelection(sock, jid, sel);
          return;
        }
      }

      // 3) פקודות טקסט רגילות או מילים חופשי
      // תמיכה בבחירות חופשיות של המשתמש: "מעונין", "לא מעונין", "1", "2"
      // מילים בעברית בשצורת המשתמשים
      const wantsKeywords = ['1', 'מעונין', 'מעונין לפתוח פניה', 'מעוניין', 'מעוניין לפתוח פניה', 'טופס', 'השאר פניה'];
      const noKeywords = ['2', 'לא מעונין', 'לא מעוניין', 'לא מעונין לפתוח פניה', 'לא מעוניין לפתוח פניה', 'אין'];

      if (wantsKeywords.includes(t)) {
        await processMenuSelection(sock, jid, 'form_request');
        return;
      }
      if (noKeywords.includes(t)) {
        // אם המשתמש כותב "לא מעונין" - נסמן אותו ולא נגיב לו שוב
        infoSentUsers.add(jid);
        console.log('ℹ️ משתמש סימן כלא מעונין:', jid);
        return; // לא שולחים תשובה
      }

      // תמיכה בפקודות מהירות
      if (await handleSpecialCommands(sock, jid, t)) return;

      // אם המשתמש עדיין לא קיבל תפריט - שלח תפריט + טקסט גיבוי
      if (!greetedUsers.has(jid)) {
        await sendWelcomeMenu(sock, jid);
        greetedUsers.add(jid);
        return;
      }

      // אחרת לא מגיבים
      console.log('— לא נעשתה פעולה נוספת על ההודעה הזו');
    } catch (err) {
      console.error('message handler error', err);
    }
  });

  return sock;
}

// שולח LIST אינטראקטיבי + טקסט גיבוי - כותרות שונו לפי בקשתך
async function sendWelcomeMenu(sock, jid) {
  const listMsg = {
    text: '👋 שלום וברוך הבא!\nבחר פעולה:',
    footer: 'בוט לדוגמה',
    title: 'תפריט ראשי',
    buttonText: 'פתח תפריט',
    sections: [
      {
        title: 'אפשרויות',
        rows: [
          { title: '1) 📝 מעונין לפתוח פניה', rowId: 'form_request' },
          { title: '2) ℹ️ לא מעונין לפתוח פניה', rowId: 'info_request' }
        ]
      }
    ]
  };

  const fallback = 'בחר אפשרות:\n1) מעונין לפתוח פניה\n2) לא מעונין לפתוח פניה\nאו כתוב "menu" כדי להציג שוב את התפריט.';
  try {
    await sock.sendMessage(jid, { listMessage: listMsg });
    await sock.sendMessage(jid, { text: fallback });
    console.log('✅ נשלח listMessage + fallback ל-', jid);
  } catch (e) {
    console.warn('⚠ listMessage לא עבר - שולח רק טקסט גיבוי:', e?.message || e);
    await sock.sendMessage(jid, { text: fallback });
  }
}

// עיבוד בחירה מהתפריט
async function processMenuSelection(sock, jid, selectedId) {
  console.log('processMenuSelection', jid, selectedId);
  if (selectedId === 'form_request') {
    formUsers[jid] = { step: 1 };
    await sock.sendMessage(jid, { text: '✍️ מצוין! מה השם המלא שלך?' });
  } else if (selectedId === 'info_request') {
    // משתמש בחר "לא מעונין" - לא נענה לו שוב
    infoSentUsers.add(jid);
    console.log('ℹ️ המשתמש בחר לא מעונין, מסומן ולא ייענה שוב:', jid);
    // שים לב: לא שולחים לו הודעה לפי בקשתך
  } else {
    await sock.sendMessage(jid, { text: 'לא זיהיתי את הבחירה. כתוב "menu" כדי לראות את האפשרויות.' });
  }
}

async function handleFormProcess(sock, jid, msg) {
  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
  const userForm = formUsers[jid];
  if (!userForm) return;

  if (userForm.step === 1) {
    userForm.name = text;
    userForm.step = 2;
    await sock.sendMessage(jid, { text: '📞 עכשיו אנא כתוב את מספר הטלפון שלך:' });
    return;
  }

  if (userForm.step === 2) {
    userForm.phone = text;
    userForm.step = 3;
    await sock.sendMessage(jid, { text: '✉️ כעת פרט את הפניה בקצרה:' });
    return;
  }

  if (userForm.step === 3) {
    userForm.message = text;
    const entry = { jid, ...userForm, timestamp: new Date().toISOString() };

    // שמירה ל־JSON
    let data = [];
    if (fs.existsSync('form_data.json')) {
      try { data = JSON.parse(fs.readFileSync('form_data.json')); } catch (e) { data = []; }
    }
    data.push(entry);
    fs.writeFileSync('form_data.json', JSON.stringify(data, null, 2));
    console.log('✅ טופס נשמר ל־form_data.json:', entry);

    // שליחה אוטומטית למנהל (adminJid)
    const adminText = [
      '📬 פניה חדשה התקבלה:',
      `🆔 משתמש: ${entry.jid}`,
      `👤 שם: ${entry.name}`,
      `📞 טלפון: ${entry.phone}`,
      `✉️ פרטי הפניה: ${entry.message || 'לא סופק'}`,
      `🕒 זמן: ${entry.timestamp}`
    ].join('\n');

    try {
      await sock.sendMessage(adminJid, { text: adminText });
      console.log('✅ הודעת פניה נשלחה ל-admin:', adminJid);
    } catch (e) {
      console.error('❌ שגיאה בשליחת הפניה ל-admin:', e?.message || e);
    }

    delete formUsers[jid];
    await sock.sendMessage(jid, { text: '✅ תודה! הפניה נפתחה בהצלחה. נחזור אליך בקרוב.' });
  }
}

async function handleSpecialCommands(sock, jid, text) {
  if (!text) return false;
  if (text === 'ping') {
    await sock.sendMessage(jid, { text: '🏓 pong!' });
    return true;
  }
  if (text === 'help' || text === '/help') {
    const help = '📋 פקודות: ping, help, menu\nניתן גם לשלוח 1 או 2 או לכתוב "מעונין" / "לא מעונין".';
    await sock.sendMessage(jid, { text: help });
    return true;
  }
  if (text === 'menu') {
    await sendWelcomeMenu(sock, jid);
    return true;
  }
  return false;
}

// הפעלה
connectToWhatsApp().catch(err => console.error('שגיאה בחיבור:', err));
