// index.js - גרסה מעודכנת: שולח רק את הודעת הברכה הראשונית לפעם הראשונה
// הערות בעברית בתוך הקוד להסבר כל חלק
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');

// admin JID - הכנס כאן את ה-JID של המנהל (בפורמט בינלאומי ללא סימנים)
const adminJid = '972559555800@s.whatsapp.net';

// ---------------------------------
// זיכרון ריצה
// ---------------------------------
// משתמשים שסומנו כ"לא מעוניין" - אל תענה להם יותר
const infoSentUsers = new Set();
// משתמשים שעוברים תהליך מילוי טופס - object keyed by jid
const formUsers = {};
// משתמשים שכבר קיבלו את הודעת הברכה הראשונית
const greetedUsers = new Set();

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  // connection updates - logged in English (system logs)
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR generated - scan it to connect:');
      qrcode.generate(qr, { small: false });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : false;
      console.log('Connection closed:', lastDisconnect?.error, 'willReconnect:', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('Connected to WhatsApp!');
    }
  });

  // הודעות נכנסות
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg || !msg.message || msg.key?.fromMe) return;

      const jid = msg.key.remoteJid;
      // רק צ'אטים פרטיים - סינון
      if (!jid || !jid.endsWith('@s.whatsapp.net')) {
        console.log('Ignored message - not a private chat:', jid);
        return;
      }

      // קבלת טקסט גולמי (תומך בהודעות טקסט רגילות וב-extendedText)
      const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const t = (rawText || '').toString().toLowerCase().trim();
      console.log('Incoming message from:', jid, '| raw:', rawText, '| normalized:', t);

      // אם המשתמש כבר סומן כ"לא מעוניין" - לא נענה לו יותר
      if (infoSentUsers.has(jid)) {
        console.log('User marked as not interested - ignoring:', jid);
        return;
      }

      // אם המשתמש באמצע מילוי טופס - המשך התהליך
      if (formUsers[jid]) {
        await handleFormProcess(sock, jid, msg);
        return;
      }

      // בחירת פריט מתוך LIST אינטראקטיבי
      if (msg.message.listResponseMessage) {
        const selectedId = msg.message.listResponseMessage.singleSelectReply?.selectedRowId
          || msg.message.listResponseMessage.selectedRowId;
        console.log('ListResponse selectedId =', selectedId);
        if (selectedId) {
          await processMenuSelection(sock, jid, selectedId);
          return;
        }
      }

      // בחירת כפתור אינטראקטיבי
      if (msg.message.buttonsResponseMessage) {
        const sel = msg.message.buttonsResponseMessage.selectedButtonId;
        console.log('ButtonsResponse selectedButtonId =', sel);
        if (sel) {
          await processMenuSelection(sock, jid, sel);
          return;
        }
      }

      // פקודות מיוחדות: ping, help, menu
      if (await handleSpecialCommands(sock, jid, t)) return;

      // מילות מפתח חופשיות לתחילת הטופס או לסימון "לא מעונין"
      const wantsKeywords = ['1', 'מעונין', 'מעוניין', 'מעונין לפתוח פניה', 'מעוניין לפתוח פניה', 'טופס', 'השאר פניה', 'מעוניין לפתוח פנייה', 'מעוניין לפתוח פניה'];
      const noKeywords = ['2', 'לא מעונין', 'לא מעוניין', 'לא מעונין לפתוח פניה', 'לא מעוניין לפתוח פניה', 'אין'];

      if (wantsKeywords.includes(t)) {
        await processMenuSelection(sock, jid, 'form_request');
        return;
      }
      if (noKeywords.includes(t)) {
        // סימון כ"לא מעונין" - לא נענה לו יותר
        infoSentUsers.add(jid);
        console.log('User marked as not interested by text:', jid);
        return; // לא שולחים שום הודעה חזרה
      }

      // אם המשתמש טרם קיבל הודעת ברכה - שלח רק את הודעת הברכה הראשונית
      if (!greetedUsers.has(jid)) {
        await sendInitialGreeting(sock, jid); // עכשיו שולחים רק את הברכה הראשונית
        greetedUsers.add(jid);
        return;
      }

      // בכל שאר המקרים - אין תגובה (כל ההודעות שלא מתאימות ל-flow לא מקבלות תגובה)
      console.log('No action for this message - not matching any flow or command.');
    } catch (err) {
      console.error('message handler error', err);
    }
  });

  return sock;
}

// ---------------------------------
// שליחת הודעת פתיחה ראשונית למשתמש חדש
// בהתאם לתסריט: כל משתמש חדש מקבל הודעה זו רק פעם אחת
// ---------------------------------
async function sendInitialGreeting(sock, jid) {
  // הודעה ראשונית כפי שביקשת
  const greeting = "שלום! אני בוט אוטומטי לרישום פניות. אם ברצונך להשאיר פניה, השב 'מעוניין'. אם לא מעוניין - השב 'לא מעוניין'.";
  try {
    await sock.sendMessage(jid, { text: greeting });
    console.log('Sent initial greeting to:', jid);
  } catch (e) {
    console.warn('Failed to send initial greeting to', jid, e?.message || e);
  }
}

// ---------------------------------
// פונקציה לשולחת LIST אינטראקטיבי + טקסט גיבוי
// נשמרת למקרה שהמשתמש יבקש "menu" מאוחר יותר
// ---------------------------------
async function sendWelcomeMenu(sock, jid) {
  const listMsg = {
    text: '👋 שלום וברוך הבא!\nבחר פעולה:',
    footer: 'בוט רישום פניות',
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
    console.log('Sent listMessage + fallback to:', jid);
  } catch (e) {
    console.warn('listMessage failed - sending fallback text only:', e?.message || e);
    await sock.sendMessage(jid, { text: fallback });
  }
}

// ---------------------------------
// עיבוד בחירת תפריט
// ---------------------------------
async function processMenuSelection(sock, jid, selectedId) {
  console.log('processMenuSelection', jid, selectedId);
  if (selectedId === 'form_request') {
    // אתחול טופס חדש - שלב 1: שם מלא
    formUsers[jid] = { step: 1, data: {} };
    await sock.sendMessage(jid, { text: '✍️ מצוין! מה השם המלא שלך?' });
  } else if (selectedId === 'info_request') {
    // משתמש בחר "לא מעונין" - נסמן אותו ולא ייענה שוב
    infoSentUsers.add(jid);
    console.log('User selected not interested - marked and will not be replied to:', jid);
    // לפי התסריט - לא שולחים הודעה במענה
  } else {
    await sock.sendMessage(jid, { text: 'לא זיהיתי את הבחירה. כתוב "menu" כדי לראות את האפשרויות.' });
  }
}

// ---------------------------------
// תהליך מילוי הטופס - 4 שאלות + אישור/עריכה
// ---------------------------------
async function handleFormProcess(sock, jid, msg) {
  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
  const t = (text || '').toString().trim();
  const userForm = formUsers[jid];
  if (!userForm) return;

  // מילים המאשרות או מבקשות לשנות
  const confirmKeywords = ['כן', 'מאשר', 'אישור', 'ok', 'בסדר', 'כן!'];
  const changeKeywords = ['שנה', 'ערוך', 'לשנות', 'לא', 'שינוי'];

  // שלבים מספריים
  if (userForm.step === 1) {
    userForm.data.name = t;
    userForm.step = 2;
    await sock.sendMessage(jid, { text: '📍 תודה. אנא כתוב את הכתובת (רחוב, מספר, עיר):' });
    return;
  }

  if (userForm.step === 2) {
    userForm.data.address = t;
    userForm.step = 3;
    await sock.sendMessage(jid, { text: '📞 עכשיו אנא כתוב את מספר הטלפון שלך:' });
    return;
  }

  if (userForm.step === 3) {
    userForm.data.phone = t;
    userForm.step = 4;
    await sock.sendMessage(jid, { text: '✉️ כעת פרט את הפניה בקצרה (תיאור הבקשה):' });
    return;
  }

  if (userForm.step === 4) {
    userForm.data.message = t;
    userForm.step = 'confirm';
    await sendSummaryAndAskConfirmation(sock, jid, userForm.data);
    return;
  }

  // שלב אישור / שינוי
  if (userForm.step === 'confirm') {
    const lower = t.toLowerCase();
    if (confirmKeywords.includes(lower) || confirmKeywords.includes(t)) {
      await saveAndNotifyAdmin(sock, jid, userForm.data);
      delete formUsers[jid];
      return;
    }
    if (changeKeywords.includes(lower) || changeKeywords.includes(t)) {
      userForm.step = 'edit_select';
      const editOptions = 'איזה שדה ברצונך לשנות? כתוב: שם / כתובת / טלפון / פירוט';
      await sock.sendMessage(jid, { text: editOptions });
      return;
    }
    await sock.sendMessage(jid, { text: 'לא הבנתי. האם לאשר את הפרטים או לשנות? כתוב "כן" לאישור או "שנה" לעריכה.' });
    return;
  }

  if (userForm.step === 'edit_select') {
    const lower = t.toLowerCase();
    if (lower.includes('שם')) {
      userForm.editingField = 'name';
      userForm.step = 'editing';
      await sock.sendMessage(jid, { text: 'הכנס שם חדש:' });
      return;
    }
    if (lower.includes('כתובת')) {
      userForm.editingField = 'address';
      userForm.step = 'editing';
      await sock.sendMessage(jid, { text: 'הכנס כתובת חדשה:' });
      return;
    }
    if (lower.includes('טלפון')) {
      userForm.editingField = 'phone';
      userForm.step = 'editing';
      await sock.sendMessage(jid, { text: 'הכנס מספר טלפון חדש:' });
      return;
    }
    if (lower.includes('פירט') || lower.includes('פירוט') || lower.includes('פרט')) {
      userForm.editingField = 'message';
      userForm.step = 'editing';
      await sock.sendMessage(jid, { text: 'הכנס פירוט פניה חדש:' });
      return;
    }
    await sock.sendMessage(jid, { text: 'לא זיהיתי את השדה. כתוב אחד מ: שם, כתובת, טלפון, פירוט.' });
    return;
  }

  if (userForm.step === 'editing') {
    const field = userForm.editingField;
    if (field) {
      userForm.data[field] = t;
      delete userForm.editingField;
      userForm.step = 'confirm';
      await sendSummaryAndAskConfirmation(sock, jid, userForm.data);
      return;
    } else {
      userForm.step = 'edit_select';
      await sock.sendMessage(jid, { text: 'אירעה שגיאה קטנה. איזה שדה תרצה לשנות? (שם/כתובת/טלפון/פירוט)' });
      return;
    }
  }

  // במקרה של מצב לא ידוע - ננקה ונשיב למשתמש כיצד להמשיך
  console.log('Unknown form step for user', jid, userForm);
  delete formUsers[jid];
  await sock.sendMessage(jid, { text: 'אירעה שגיאה בתהליך. נא לשלוח "menu" כדי להתחיל שוב.' });
}

// שולח סיכום ובקשת אישור למשתמש (טקסט בעברית)
async function sendSummaryAndAskConfirmation(sock, jid, data) {
  const summary = [
    '🔎 סיכום הפניה שלך:',
    `👤 שם: ${data.name || 'לא סופק'}`,
    `📍 כתובת: ${data.address || 'לא סופק'}`,
    `📞 טלפון: ${data.phone || 'לא סופק'}`,
    `✉️ פירוט: ${data.message || 'לא סופק'}`,
    '',
    'האם לאשר את הפניה? כתוב "כן" לאישור או "שנה" כדי לערוך.'
  ].join('\n');
  try {
    await sock.sendMessage(jid, { text: summary });
    console.log('Sent summary to', jid);
  } catch (e) {
    console.warn('Failed to send summary to', jid, e?.message || e);
  }
}

// שמירת הפניה ל־form_data.json ושליחה למנהל
async function saveAndNotifyAdmin(sock, jid, data) {
  const entry = {
    jid,
    name: data.name || '',
    address: data.address || '',
    phone: data.phone || '',
    message: data.message || '',
    timestamp: new Date().toISOString()
  };

  // קריאה ושמירה לקובץ JSON
  let all = [];
  try {
    if (fs.existsSync('form_data.json')) {
      const raw = fs.readFileSync('form_data.json', 'utf8');
      all = JSON.parse(raw || '[]');
    }
  } catch (e) {
    console.warn('Could not read form_data.json, starting new array:', e?.message || e);
    all = [];
  }

  all.push(entry);
  try {
    fs.writeFileSync('form_data.json', JSON.stringify(all, null, 2), 'utf8');
    console.log('Form saved to form_data.json:', entry);
  } catch (e) {
    console.error('Failed to write form_data.json:', e?.message || e);
  }

  // שליחת הודעה למנהל - הלוג שיישלח הוא באנגלית
  const adminText = [
    '📬 New request received:',
    `User JID: ${entry.jid}`,
    `Name: ${entry.name}`,
    `Address: ${entry.address}`,
    `Phone: ${entry.phone}`,
    `Details: ${entry.message || 'N/A'}`,
    `Time: ${entry.timestamp}`
  ].join('\n');

  try {
    await sock.sendMessage(adminJid, { text: adminText });
    console.log('Sent request to admin:', adminJid);
  } catch (e) {
    console.error('Failed to send request to admin:', e?.message || e);
  }

  // הודעה סופית למשתמש
  try {
    await sock.sendMessage(jid, { text: '✅ תודה! הפניה נרשמה ונשלחה למערכת. נחזור אליך בהקדם.' });
    console.log('Acknowledgement sent to user:', jid);
  } catch (e) {
    console.warn('Failed to send acknowledgement to user:', e?.message || e);
  }
}

// פקודות מיוחדות - ping, help, menu
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
    // שליחת התפריט רק במידה והמשתמש ביקש אותו במפורש
    await sendWelcomeMenu(sock, jid);
    return true;
  }
  return false;
}

// הפעלה
connectToWhatsApp().catch(err => console.error('Connection error:', err));
