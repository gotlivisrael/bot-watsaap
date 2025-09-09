// index.js - גרסה מעודכנת: תפריט אינטראקטיבי יפה בעברית
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

// קישור לאתר שלך (החלף לקישור האמיתי)
const websiteUrl = 'https://www.example.com';
// קישור לתקנון (החלף לקישור האמיתי)
const termsUrl = 'https://www.example.com/terms';

// ---------------------------------
// זיכרון ריצה
// ---------------------------------
// משתמשים שסומנו כ"לא מעוניין" - אל תענה להם יותר
const infoSentUsers = new Set();
// משתמשים שעוברים תהליך מילוי טופס - object keyed by jid
const formUsers = {};
// משתמשים שכבר קיבלו את הודעת הברכה הראשונית
const greetedUsers = new Set();

// ---------------------------------
// טיימרים לניהול סשן טופס
// ---------------------------------
const formTimeouts = {}; // { jid: timeoutId }
const FORM_SESSION_TIMEOUT = 10 * 60 * 1000; // 10 דקות (ניתן לשנות)

const greetingTimers = {}; // { jid: timestamp של הפעם האחרונה שהברכה נשלחה }
const GREETING_COOLDOWN = 60 * 60 * 1000; // 10 דקות

// אתחול/הפעלת טיימר לסשן חדש
async function startFormSession(sock, jid) {
  // מחיקת טיימר קודם אם קיים
  if (formTimeouts[jid]) clearTimeout(formTimeouts[jid]);

  // יצירת טיימר חדש
  formTimeouts[jid] = setTimeout(async () => {
    try {
      // שליחת הודעה על סגירת הפניה עקב חוסר מענה
      await sock.sendMessage(jid, { text: '⚠️ הפניה נסגרה עקב חוסר מענה.' });
      console.log('Form session expired for', jid);
    } catch (e) {
      console.warn('Failed to notify user about session expiry:', jid, e?.message || e);
    } finally {
      // הסרה מהזיכרון
      delete formUsers[jid];
      delete formTimeouts[jid];
    }
  }, FORM_SESSION_TIMEOUT);
}

// ביטול ואיפוס טיימר כאשר המשתמש מתקדם או מאשר את הטופס
function resetFormSessionTimer(jid) {
  if (formTimeouts[jid]) {
    clearTimeout(formTimeouts[jid]);
    delete formTimeouts[jid];
  }
}

// ---------------------------------
// חיבור ל-WhatsApp והאזנה להודעות
// ---------------------------------
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
      const noKeywords = ['2', 'לא מעונין', 'הסר ', 'בטל', 'לא', 'אין'];

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

      const now = Date.now();
      const lastSent = greetingTimers[jid] || 0;
      if (now - lastSent > GREETING_COOLDOWN) {
        await sendInteractiveMenu(sock, jid); // שינוי כאן - שליחת התפריט הראשון
        greetingTimers[jid] = now;
        greetedUsers.add(jid);
      } else {
        console.log('Greeting recently sent to', jid, '- skipping.');
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
// שליחת תפריט אינטראקטיבי יפה (הודעה ראשונה)
// ---------------------------------
async function sendInteractiveMenu(sock, jid) {
  // ניסיון ראשון - שליחת LIST אינטראקטיבי
  const listMsg = {
    text: '🤖 שלום! אני בוט אוטומטי לרישום פניות\n\nבחר מה תרצה לעשות:',
    footer: 'בוט רישום פניות | צוות התמיכה',
    title: '📋 תפריט ראשי',
    buttonText: '📝 בחר פעולה',
    sections: [ 
      {
        title: '🎯 פעולות זמינות',
        rows: [
          { 
            title: '📝 פתיחת פניה חדשה', 
            description: 'למילוי טופס פניה חדש',
            rowId: 'form_request' 
          },
          { 
            title: '🌐 קישור לאתר', 
            description: 'מעבר לאתר הרשמי שלנו',
            rowId: 'website_link' 
          },
          { 
            title: '📜 תקנון השירות', 
            description: 'קריאת התקנון וההנחיות',
            rowId: 'terms_link' 
          },
          { 
            title: '❌ הסר אותי מהרשימה', 
            description: 'הפסקת קבלת הודעות מהבוט',
            rowId: 'remove_me' 
          }
        ]
      }
    ]
  };

  // טקסט גיבוי למקרה שה-LIST לא עובד
  const fallbackText = `🤖 שלום! אני בוט אוטומטי לרישום פניות

📋 *תפריט ראשי:*

1️⃣ פתיחת פניה חדשה - כתוב *"פניה"*
2️⃣ קישור לאתר - כתוב *"אתר"*  
3️⃣ תקנון השירות - כתוב *"תקנון"*
4️⃣ הסר אותי - כתוב *"הסר"*

💡 *טיפ:* ניתן גם לכתוב "menu" בכל זמן להצגת התפריט שוב`;

  try {
    // ניסיון שליחת LIST אינטראקטיבי
    await sock.sendMessage(jid, { listMessage: listMsg });
    console.log('Sent interactive list menu to:', jid);
  } catch (e) {
    console.warn('Interactive list failed, sending buttons fallback:', e?.message);
    
    // גיבוי - כפתורי אינטראקציה פשוטים
    try {
      const buttonsMsg = {
        text: '🤖 שלום! אני בוט אוטומטי לרישום פניות\n\nבחר מה תרצה לעשות:',
        footer: 'בוט רישום פניות | צוות התמיכה',
        buttons: [
          { buttonId: 'form_request', buttonText: { displayText: '📝 פתיחת פניה' }, type: 1 },
          { buttonId: 'website_link', buttonText: { displayText: '🌐 אתר' }, type: 1 },
          { buttonId: 'terms_link', buttonText: { displayText: '📜 תקנון' }, type: 1 }
        ],
        headerType: 1
      };
      
      await sock.sendMessage(jid, { buttonsMessage: buttonsMsg });
      console.log('Sent buttons menu to:', jid);
    } catch (e2) {
      console.warn('Buttons also failed, sending text fallback:', e2?.message);
      
      // גיבוי אחרון - טקסט פשוט
      await sock.sendMessage(jid, { text: fallbackText });
      console.log('Sent text fallback menu to:', jid);
    }
  }
}

// ---------------------------------
// התפריט הישן (נשמר למקרה של בקשת "menu")
// ---------------------------------
async function sendWelcomeMenu(sock, jid) {
  // כאן נשלח את אותו תפריט כמו בהודעה הראשונה
  await sendInteractiveMenu(sock, jid);
}

// ---------------------------------
// עיבוד בחירת תפריט
// ---------------------------------
async function processMenuSelection(sock, jid, selectedId) {
  console.log('processMenuSelection', jid, selectedId);
  
  if (selectedId === 'form_request') {
    // אתחול טופס חדש - שלב 1: שם מלא
    formUsers[jid] = { step: 1, data: {} };
    await sock.sendMessage(jid, { text: '✍️ מצוין! בואו נתחיל במילוי הפניה.\n\n👤 *שלב 1/4:* מה השם המלא שלך?' });

    // אתחול טיימר סשן
    await startFormSession(sock, jid);
    
  } else if (selectedId === 'website_link') {
    // שליחת קישור לאתר
    await sock.sendMessage(jid, { 
      text: `🌐 *האתר הרשמי שלנו:*\n\n${websiteUrl}\n\n💡 לחץ על הקישור כדי לגלוש באתר` 
    });
    
  } else if (selectedId === 'terms_link') {
    // שליחת קישור לתקנון
    await sock.sendMessage(jid, { 
      text: `📜 *תקנון השירות:*\n\n${termsUrl}\n\n📖 לחץ על הקישור לקריאת התקנון המלא` 
    });
    
  } else if (selectedId === 'remove_me') {
    // משתמש בחר "הסר אותי" - נסמן אותו ולא נענה שוב
    infoSentUsers.add(jid);
    await sock.sendMessage(jid, { 
      text: '✅ הוסרת בהצלחה מרשימת התפוצה.\n\n🔇 לא תקבל עוד הודעות מהבוט.\n\n💬 אם תרצה לחדש את השירות - שלח לנו הודעה בעתיד.' 
    });
    console.log('User selected remove - marked as not interested:', jid);
    
  } else {
    // מקרה של בחירה לא מוכרת
    await sock.sendMessage(jid, { 
      text: '❓ לא זיהיתי את הבחירה.\n\n📝 כתוב "menu" כדי לראות את התפריט שוב.' 
    });
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

  // איפוס טיימר בכל תגובה של המשתמש (מאריך את הסשן)
  resetFormSessionTimer(jid);
  await startFormSession(sock, jid);

  // מילים המאשרות או מבקשות לשנות
  const confirmKeywords = ['כן', 'מאשר', 'אישור', 'ok', 'בסדר', 'כן!'];
  const changeKeywords = ['שנה', 'ערוך', 'לשנות', 'לא', 'שינוי'];

  // שלבים מספריים
  if (userForm.step === 1) {
    userForm.data.name = t;
    userForm.step = 2;
    await sock.sendMessage(jid, { text: '📍 *שלב 2/4:* תודה רבה!\n\nכעת אנא כתוב את הכתובת המלאה (רחוב, מספר בית, עיר):' });
    return;
  }

  if (userForm.step === 2) {
    userForm.data.address = t;
    userForm.step = 3;
    await sock.sendMessage(jid, { text: '📞 *שלב 3/4:* מעולה!\n\nעכשיו אנא כתוב את מספר הטלפון שלך:' });
    return;
  }

  if (userForm.step === 3) {
    userForm.data.phone = t;
    userForm.step = 4;
    await sock.sendMessage(jid, { text: '✉️ *שלב 4/4:* כמעט סיימנו!\n\nכעת פרט את הפניה שלך בקצרה (תיאור הבעיה או הבקשה):' });
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
      // אישור סופי - שמירה ושליחה למנהל
      await saveAndNotifyAdmin(sock, jid, userForm.data);

      // הסרת הטופס מהזיכרון וביטול הטיימר
      delete formUsers[jid];
      resetFormSessionTimer(jid);
      return;
    }
    if (changeKeywords.includes(lower) || changeKeywords.includes(t)) {
      userForm.step = 'edit_select';
      const editOptions = '🔧 *עריכת פרטים:*\n\nאיזה שדה ברצונך לשנות?\n\n📝 כתוב אחד מהבאים:\n• *שם* - לשינוי השם\n• *כתובת* - לשינוי הכתובת\n• *טלפון* - לשינוי הטלפון\n• *פירוט* - לשינוי תיאור הפניה';
      await sock.sendMessage(jid, { text: editOptions });
      return;
    }
    await sock.sendMessage(jid, { text: '❓ לא הבנתי את תגובתך.\n\n✅ כתוב *"כן"* לאישור הפניה\n🔧 או *"שנה"* לעריכת הפרטים' });
    return;
  }

  if (userForm.step === 'edit_select') {
    const lower = t.toLowerCase();
    if (lower.includes('שם')) {
      userForm.editingField = 'name';
      userForm.step = 'editing';
      await sock.sendMessage(jid, { text: '👤 *עריכת שם:*\n\nהכנס את השם החדש:' });
      return;
    }
    if (lower.includes('כתובת')) {
      userForm.editingField = 'address';
      userForm.step = 'editing';
      await sock.sendMessage(jid, { text: '📍 *עריכת כתובת:*\n\nהכנס את הכתובת החדשה:' });
      return;
    }
    if (lower.includes('טלפון')) {
      userForm.editingField = 'phone';
      userForm.step = 'editing';
      await sock.sendMessage(jid, { text: '📞 *עריכת טלפון:*\n\nהכנס את מספר הטלפון החדש:' });
      return;
    }
    if (lower.includes('פירט') || lower.includes('פירוט') || lower.includes('פרט')) {
      userForm.editingField = 'message';
      userForm.step = 'editing';
      await sock.sendMessage(jid, { text: '✉️ *עריכת פירוט הפניה:*\n\nהכנס את התיאור החדש:' });
      return;
    }
    await sock.sendMessage(jid, { text: '❓ לא זיהיתי את השדה שתרצה לשנות.\n\n📝 כתוב בדיוק אחד מהמילים הבאות:\n• שם\n• כתובת\n• טלפון\n• פירוט' });
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
      await sock.sendMessage(jid, { text: '⚠️ אירעה שגיאה קטנה.\n\nאיזה שדה תרצה לשנות? (שם/כתובת/טלפון/פירוט)' });
      return;
    }
  }

  // במקרה של מצב לא ידוע - ננקה ונשיב למשתמש כיצד להמשיך
  console.log('Unknown form step for user', jid, userForm);
  delete formUsers[jid];
  resetFormSessionTimer(jid);
  await sock.sendMessage(jid, { text: '⚠️ אירעה שגיאה בתהליך מילוי הטופס.\n\n📝 כתוב "menu" כדי להתחיל תהליך חדש.' });
}

// שולח סיכום ובקשת אישור למשתמש (טקסט מעוצב בעברית)
async function sendSummaryAndAskConfirmation(sock, jid, data) {
  const summary = [
    '📋 *סיכום הפניה שלך:*',
    '',
    `👤 *שם:* ${data.name || 'לא סופק'}`,
    `📍 *כתובת:* ${data.address || 'לא סופק'}`,
    `📞 *טלפון:* ${data.phone || 'לא סופק'}`,
    `✉️ *פירוט הפניה:* ${data.message || 'לא סופק'}`,
    '',
    '─────────────────────',
    '',
    '🤔 *האם הפרטים נכונים?*',
    '',
    '✅ כתוב *"כן"* לאישור ושליחת הפניה',
    '🔧 כתוב *"שנה"* לעריכת הפרטים'
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
    '📬 *New Request Received* 📬',
    '',
    `👤 *User JID:* ${entry.jid}`,
    `📝 *Name:* ${entry.name}`,
    `📍 *Address:* ${entry.address}`,
    `📞 *Phone:* ${entry.phone}`,
    `✉️ *Details:* ${entry.message || 'N/A'}`,
    `⏰ *Time:* ${entry.timestamp}`,
    '',
    '───────────────────────',
    '🔔 *New request added to system*'
  ].join('\n');

  try {
    await sock.sendMessage(adminJid, { text: adminText });
    console.log('Sent request to admin:', adminJid);
  } catch (e) {
    console.error('Failed to send request to admin:', e?.message || e);
  }

  // הודעה סופית מעוצבת למשתמש
  const successMessage = [
    '✅ *הפניה נרשמה בהצלחה!* ✅',
    '',
    '🎉 תודה רבה על פנייתך',
    '📨 הפניה נשלחה למערכת שלנו',
    '⏰ נחזור אליך בהקדם האפשרי',
    '',
    '───────────────────────',
    '',
    '💬 *רוצה לפתוח פניה נוספת?*',
    'כתוב *"menu"* להצגת התפריט'
  ].join('\n');

  try {
    await sock.sendMessage(jid, { text: successMessage });
    console.log('Acknowledgement sent to user:', jid);
  } catch (e) {
    console.warn('Failed to send acknowledgement to user:', e?.message || e);
  }
}

// פקודות מיוחדות - ping, help, menu + תמיכה במילות מפתח חדשות
async function handleSpecialCommands(sock, jid, text) {
  if (!text) return false;
  
  if (text === 'ping') {
    await sock.sendMessage(jid, { text: '🏓 pong! הבוט פועל תקין' });
    return true;
  }
  
  if (text === 'help' || text === '/help') {
    const help = [
      '📚 *מדריך הבוט:*',
      '',
      '🤖 אני בוט לרישום פניות',
      '',
      '📝 *פקודות זמינות:*',
      '• *menu* - הצגת התפריט הראשי',
      '• *ping* - בדיקת חיבור',
      '• *help* - מדריך זה',
      '',
      '🎯 *מילות מפתח מהירות:*',
      '• *פניה* - פתיחת טופס פניה',
      '• *אתר* - קישור לאתר',
      '• *תקנון* - קישור לתקנון',
      '• *הסר* - הסרה מהרשימה',
      '',
      '💡 *טיפ:* השתמש בתפריט האינטראקטיבי לחוויה טובה יותר!'
    ].join('\n');
    await sock.sendMessage(jid, { text: help });
    return true;
  }
  
  if (text === 'menu') {
    // שליחת התפריט האינטראקטיבי
    await sendWelcomeMenu(sock, jid);
    return true;
  }
  
  // מילות מפתח מהירות לפעולות שונות
  if (text === 'פניה' || text === 'טופס' || text === '1') {
    await processMenuSelection(sock, jid, 'form_request');
    return true;
  }
  
  if (text === 'אתר' || text === 'קישור' || text === '2') {
    await processMenuSelection(sock, jid, 'website_link');
    return true;
  }
  
  if (text === 'תקנון' || text === '3') {
    await processMenuSelection(sock, jid, 'terms_link');
    return true;
  }
  
  if (text === 'הסר' || text === 'עזוב' || text === '4') {
    await processMenuSelection(sock, jid, 'remove_me');
    return true;
  }
  
  return false;
}

// הפעלה
connectToWhatsApp().catch(err => console.error('Connection error:', err));