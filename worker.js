import examsHandler from './exams.js';

const API_VERSION = "1.0.2";

// הגדרות גישה כדי שנוכל לשלוח נתונים מדף HTML שנמצא אצלך במחשב
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    // טיפול בבקשות מקדימות של הדפדפן
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      let response;
      
      if (path === '/peer/api' || path === '/peer/api/') {
        response = new Response(JSON.stringify({ 
          status: "ready", 
          version: API_VERSION,
          message: "API is up and running with CORS!" 
        }), { status: 200 });
      } 
      else if (path.startsWith('/peer/api/exams')) {
        response = await examsHandler(request, env);
      } 
      else {
        response = new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
      }
      
      // הוספת כותרי ה-CORS לכל תשובה שיוצאת מהשרת
      const newHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders)) {
        newHeaders.set(key, value);
      }
      newHeaders.set('Content-Type', 'application/json');
      
      return new Response(response.body, { 
        status: response.status, 
        headers: newHeaders 
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500, headers: corsHeaders
      });
    }
  }
};
