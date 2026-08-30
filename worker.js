import { handleExceptions } from './exceptions.js';
import { handleReports } from './reports.js';
import { handleStudents, handleBulkUpdate } from './students.js';
import { handleYemot } from './yemot.js';
import { handleSendEmail } from './email.js';
import { handlePhoneSettings } from './phone-settings.js';
import { getCurrentIsraelTime, getSetting } from './utils.js';
import { handleDatabaseQuery } from './db-api.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Pass',
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status: status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
}

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path.endsWith('/yemot')) return await handleYemot(request, env);
            if (path.endsWith('/system-time') && request.method === 'GET') return jsonResponse({ message: "זמן שרת", ...getCurrentIsraelTime() });

            // נתיב חדש: בדיקה האם ה-IP של הלקוח ברשימה הלבנה
            if (path.endsWith('/check-ip') && request.method === 'GET') {
                const clientIP = request.headers.get('cf-connecting-ip');
                let isWhitelisted = false;
                if (clientIP) {
                    try {
                        const ipCheck = await env.DB.prepare("SELECT ip FROM allowed_ips WHERE ip = ?").bind(clientIP).first();
                        if (ipCheck) isWhitelisted = true;
                    } catch (e) {
                        // אם הטבלה עדיין לא קיימת במסד, מתעלמים וממשיכים רגיל
                    }
                }
                return jsonResponse({ whitelisted: isWhitelisted });
            }

            const clientIP = request.headers.get('cf-connecting-ip');
            let isIPWhitelisted = false;

            if (clientIP) {
                try {
                    const ipCheck = await env.DB.prepare("SELECT ip FROM allowed_ips WHERE ip = ?").bind(clientIP).first();
                    if (ipCheck) isIPWhitelisted = true;
                } catch (e) {}
            }

            const passHeader = request.headers.get('X-Admin-Pass');
            const passQuery = url.searchParams.get('code');
            const providedPass = passHeader || passQuery; 
            
            let realPass = null;
            try {
                const dbPassRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password'").first();
                if (dbPassRow) realPass = dbPassRow.value;
            } catch (e) {}

            if (path.endsWith('/login') && request.method === 'POST') {
                if (!realPass) return jsonResponse({ error: "המערכת טרם הוגדרה. אנא הוסף סיסמה במסד הנתונים." }, 500);
                const body = await request.json();
                if (body.password === realPass) return jsonResponse({ success: true });
                return jsonResponse({ error: "שגיאה: הסיסמה שהוזנה שגויה" }, 401);
            }

            // אימות הרשאה - אם ה-IP לא מורשה והסיסמה שגויה/חסרה
            if (!isIPWhitelisted && (!realPass || providedPass !== realPass)) {
                if (!providedPass) {
                    return jsonResponse({ error: "גישה נדחתה: לא צורף קוד הרשאה או סיסמה" }, 401);
                }
                return jsonResponse({ error: "גישה נדחתה: קוד ההרשאה שגוי או פג תוקף" }, 401);
            }

            if (path.endsWith('/system-start-date') && request.method === 'GET') {
                const startDate = await getSetting(env, 'system_start_date', '2000-01-01');
                return jsonResponse({ system_start_date: startDate });
            }

            if (path.endsWith('/send-email') && request.method === 'POST') {
                const result = await handleSendEmail(request, env);
                return jsonResponse(result);
            }

            if (path.endsWith('/exception') && request.method === 'POST') {
                const result = await handleExceptions(request, env);
                return jsonResponse(result);
            }

            if (path.endsWith('/reports') && request.method === 'GET') {
                const result = await handleReports(request, env);
                return jsonResponse(result);
            }
            
            if (path.endsWith('/students') && request.method === 'GET') {
                const result = await handleStudents(request, env);
                return jsonResponse(result);
            }
            
            if (path.endsWith('/add-student') && request.method === 'POST') {
                const { code, first_name, last_name, class_name } = await request.json();
                const existingStudent = await env.DB.prepare("SELECT code FROM students WHERE code = ?").bind(code).first();
                if (existingStudent) return jsonResponse({ error: "שגיאה: קוד תלמיד זה כבר קיים במערכת." }, 400);
                
                await env.DB.prepare("INSERT INTO students (code, first_name, last_name, class_name) VALUES (?, ?, ?, ?)").bind(code, first_name, last_name, class_name).run();
                return jsonResponse({ message: "התלמיד נוסף בהצלחה" });
            }

            if (path.endsWith('/update-student') && request.method === 'POST') {
                const { code, first_name, last_name, class_name } = await request.json();
                await env.DB.prepare("UPDATE students SET first_name = ?, last_name = ?, class_name = ? WHERE code = ?").bind(first_name, last_name, class_name, code).run();
                return jsonResponse({ message: "פרטי התלמיד עודכנו בהצלחה" });
            }

            if (path.endsWith('/delete-student') && request.method === 'POST') {
                const { code } = await request.json();
                await env.DB.prepare("DELETE FROM exceptions WHERE student_code = ?").bind(code).run();
                await env.DB.prepare("DELETE FROM students WHERE code = ?").bind(code).run();
                return jsonResponse({ message: "התלמיד וכל נתוניו נמחקו לצמיתות" });
            }

            if (path.endsWith('/bulk-update-students') && request.method === 'POST') {
                const result = await handleBulkUpdate(request, env);
                return jsonResponse(result);
            }

            if (path.endsWith('/toggle-vacation') && request.method === 'POST') {
                const { date, isVacation } = await request.json();
                if (isVacation) {
                    await env.DB.prepare("INSERT OR IGNORE INTO vacations (date) VALUES (?)").bind(date).run();
                } else {
                    await env.DB.prepare("DELETE FROM vacations WHERE date = ?").bind(date).run();
                }
                return jsonResponse({ message: "יומן החופשות עודכן בהצלחה" });
            }

            if (path.endsWith('/vacations') && request.method === 'GET') {
                const { results } = await env.DB.prepare("SELECT date FROM vacations").all();
                return jsonResponse(results.map(r => r.date));
            }

            if (path.endsWith('/db-query') && request.method === 'POST') {
                const result = await handleDatabaseQuery(request, env);
                const status = result.success ? 200 : 400;
                return jsonResponse(result, status);
            }

            // הניתוב החדש לניהול הגדרות הטלפון מול ימות המשיח (מפנה לקובץ phone-settings.js)
            if (path.includes('/phone-settings/')) {
                const result = await handlePhoneSettings(request, env);
                return jsonResponse(result);
            }

            return jsonResponse({ error: "הנתיב המבוקש לא קיים במערכת", requested_path: path }, 404);

        } catch (error) {
            const statusCode = error.status || 500;
            const prefix = statusCode === 500 ? "שגיאת שרת פנימית: " : "";
            return jsonResponse({ error: prefix + error.message }, statusCode);
        }
    }
};
