import examsHandler from './exams.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

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
