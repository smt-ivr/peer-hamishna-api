import examsHandler from './exams.js';
import studentsHandler from './students.js';
import studentExamsHandler from './student_exams.js'; // ייבוא מודול תוצאות המבחנים

const API_VERSION = "1.2.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
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
          message: "API is up and running with Student Exams module!" 
        }), { status: 200 });
      } 
      else if (path.startsWith('/peer/api/exams')) {
        response = await examsHandler(request, env);
      } 
      else if (path.startsWith('/peer/api/students')) {
        response = await studentsHandler(request, env);
      }
      else if (path.startsWith('/peer/api/student-exams')) {
        response = await studentExamsHandler(request, env);
      }
      else {
        response = new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
      }
      
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
