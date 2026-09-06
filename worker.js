import examsHandler from './exams.js';
import studentsHandler from './students.js';
import studentExamsHandler from './student_exams.js';
import { handleYemotManager } from './yemot_manager.js';
import { handleYemotStudents } from './yemot_students.js';

const API_VERSION = "1.4.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key', 
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    
    // קליטת ה-IP של המשתמש והסיסמה (אם סופקה)
    const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
    const apiKey = request.headers.get('x-api-key') || url.searchParams.get('api_key');

    try {
      // -- נתיב פתוח לבדיקת סטטוס הרשאות --
      if (path === '/peer/api/auth-check') {
        const ipRecord = await env.DB.prepare("SELECT access_level FROM auth_rules WHERE rule_type = 'ip' AND rule_value = ?").bind(clientIp).first();
        const isIpAllowed = !!ipRecord;
        
        let isKeyValid = false;
        let keyAccessLevel = null;
        if (apiKey) {
            const keyRecord = await env.DB.prepare("SELECT access_level FROM auth_rules WHERE rule_type = 'password' AND rule_value = ?").bind(apiKey).first();
            isKeyValid = !!keyRecord;
            if (keyRecord) keyAccessLevel = keyRecord.access_level;
        }
        
        const finalAccessLevel = isKeyValid ? keyAccessLevel : (isIpAllowed ? ipRecord.access_level : null);

        return new Response(JSON.stringify({
          client_ip: clientIp,
          is_ip_allowed: isIpAllowed,
          is_key_valid: isKeyValid,
          is_authorized: isIpAllowed || isKeyValid,
          access_level: finalAccessLevel
        }), { 
          status: 200, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      // -- מנגנון אבטחה מול מסד הנתונים --
      const isYemotPath = path.startsWith('/peer/api/yemot/');
      
      if (!isYemotPath && path !== '/peer/api' && path !== '/peer/api/') {
         let isAuthorized = false;
         let accessLevel = null;
         
         // 1. בדיקה אם סופקה סיסמה והאם היא קיימת בטבלה
         if (apiKey) {
             const keyRecord = await env.DB.prepare("SELECT access_level FROM auth_rules WHERE rule_type = 'password' AND rule_value = ?").bind(apiKey).first();
             if (keyRecord) {
                 isAuthorized = true;
                 accessLevel = keyRecord.access_level;
             }
         }

         // 2. אם לא אושר דרך סיסמה, נבדוק את ה-IP
         if (!isAuthorized) {
             const ipRecord = await env.DB.prepare("SELECT access_level FROM auth_rules WHERE rule_type = 'ip' AND rule_value = ?").bind(clientIp).first();
             if (ipRecord) {
                 isAuthorized = true;
                 accessLevel = ipRecord.access_level;
             }
         }

         // 3. דחיית הבקשה אם אין הרשאה (לא IP ולא סיסמה)
         if (!isAuthorized) {
             return new Response(JSON.stringify({ 
                 error: 'Unauthorized Access',
                 message: 'אין לכם הרשאה לצפות או לעדכן נתונים'
             }), { 
                 status: 401, 
                 headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
             });
         }

         // 4. אכיפת הרשאות כתיבה למשתמשי צפייה בלבד (read_only)
         const isWriteMethod = ['POST', 'PUT', 'DELETE'].includes(request.method);
         if (accessLevel === 'read_only' && isWriteMethod) {
             return new Response(JSON.stringify({ 
                 error: 'Forbidden',
                 message: ',לא ניתן לשנות נתונים, ההרשאה שלכם מוגבלת לצפייה בלבד'
             }), { 
                 status: 403, 
                 headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
             });
         }
      }

      // -- הניתוב המקורי של המערכת --
      let response;
      
      if (path === '/peer/api' || path === '/peer/api/') {
        response = new Response(JSON.stringify({ 
          status: "ready", 
          version: API_VERSION,
          message: "API is up and running securely!" 
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
      else if (path.startsWith('/peer/api/yemot/manager')) {
        response = await handleYemotManager(request, env);
        return response; 
      }
      else if (path.startsWith('/peer/api/yemot/student')) {
        response = await handleYemotStudents(request, env);
        return response; 
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
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};
