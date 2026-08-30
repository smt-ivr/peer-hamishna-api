import examsHandler from './exams.js';

// מספר גירסא - שנה אותו בכל פעם שאתה מעלה עדכון כדי לוודא שהקוד התעדכן בשרת
const API_VERSION = "1.0.1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // נתיב ראשי לבדיקת תקינות וגירסא (מגיב ל- /peer/api או /peer/api/)
    if (path === '/peer/api' || path === '/peer/api/') {
      return new Response(JSON.stringify({ 
        status: "ready", 
        version: API_VERSION,
        message: "API is up and running!" 
      }), { 
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // ניתוב של בקשות ה-API של המבחנים
    if (path.startsWith('/peer/api/exams')) {
      return await examsHandler(request, env);
    }

    // אם הגיעו לנתיב שלא קיים
    return new Response(JSON.stringify({ error: 'Not Found' }), { 
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
