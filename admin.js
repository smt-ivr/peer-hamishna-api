// ============================================================
//  admin.js — ניהול הרשאות (סיסמאות וכתובות IP) — למנהל-על בלבד
//  GET    /peer/api/admin/auth-rules                 רשימת כל ההרשאות
//  POST   /peer/api/admin/auth-rules                 הוספה  { rule_type, rule_value, access_level, description }
//  PUT    /peer/api/admin/auth-rules?value=<קיים>    עדכון  (אותו גוף; אפשר לשנות גם את הערך עצמו)
//  DELETE /peer/api/admin/auth-rules?value=<קיים>    מחיקה
//  ההרשאה נבדקת כאן מחדש: רק בקשה שזוהתה כ-super_admin (סיסמה או IP) עוברת.
// ============================================================

export const SUPER_ADMIN = 'super_admin';
const TYPES = ['password', 'ip'];
const LEVELS = [SUPER_ADMIN, 'admin', 'read_only'];

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const fail = (status, message) => json({ error: status === 403 ? 'Forbidden' : 'Validation failed', message }, status);

// אותו סדר בדיקה כמו ב-worker.js: קודם סיסמה, אחר כך IP
async function identify(request, env) {
  const url = new URL(request.url);
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const apiKey = request.headers.get('x-api-key') || url.searchParams.get('api_key');
  if (apiKey) {
    const row = await env.DB.prepare("SELECT * FROM auth_rules WHERE rule_type = 'password' AND rule_value = ?").bind(apiKey).first();
    if (row) return { rule: row, clientIp };
  }
  const row = await env.DB.prepare("SELECT * FROM auth_rules WHERE rule_type = 'ip' AND rule_value = ?").bind(clientIp).first();
  return { rule: row || null, clientIp };
}

function validate(body) {
  const rule_type = String(body.rule_type || '').trim();
  const rule_value = String(body.rule_value ?? '').trim();
  const access_level = String(body.access_level || '').trim();
  const description = body.description == null ? null : String(body.description).trim() || null;

  if (!TYPES.includes(rule_type)) return { message: 'סוג ההרשאה חייב להיות סיסמה או כתובת IP' };
  if (!LEVELS.includes(access_level)) return { message: 'רמת הרשאה לא תקינה' };
  if (!rule_value) return { message: rule_type === 'ip' ? 'יש להזין כתובת IP' : 'יש להזין סיסמה' };
  if (rule_value.length > 200) return { message: 'הערך ארוך מדי' };
  if (rule_type === 'password' && rule_value.length < 4) return { message: 'הסיסמה חייבת להכיל לפחות 4 תווים' };
  if (rule_type === 'ip' && !/^[0-9a-fA-F:.]+$/.test(rule_value)) return { message: 'כתובת IP לא תקינה' };
  if (description && description.length > 200) return { message: 'התיאור ארוך מדי' };
  return { data: { rule_type, rule_value, access_level, description } };
}

async function superAdminCount(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM auth_rules WHERE access_level = ?").bind(SUPER_ADMIN).first();
  return r ? r.c : 0;
}

export default async function adminHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  const { rule: me, clientIp } = await identify(request, env);
  if (!me || me.access_level !== SUPER_ADMIN) return fail(403, 'אזור זה זמין למנהל-על בלבד');

  if (url.pathname.replace(/\/+$/, '') !== '/peer/api/admin/auth-rules') {
    return json({ error: 'Not Found' }, 404);
  }

  const isMe = value => value === me.rule_value;
  const target = url.searchParams.get('value');

  try {
    if (method === 'GET') {
      const { results } = await env.DB.prepare("SELECT rule_value, rule_type, access_level, description, created_at FROM auth_rules ORDER BY rule_type ASC, created_at ASC").all();
      return json({
        client_ip: clientIp,
        current: { rule_type: me.rule_type, rule_value: me.rule_value },
        rules: results.map(r => ({ ...r, is_current: isMe(r.rule_value) }))
      });
    }

    if (method === 'POST') {
      const v = validate(await request.json().catch(() => ({})));
      if (!v.data) return fail(400, v.message);
      const exists = await env.DB.prepare("SELECT 1 FROM auth_rules WHERE rule_value = ?").bind(v.data.rule_value).first();
      if (exists) return fail(400, 'ערך זה כבר קיים ברשימת ההרשאות');
      await env.DB.prepare("INSERT INTO auth_rules (rule_value, rule_type, access_level, description) VALUES (?, ?, ?, ?)")
        .bind(v.data.rule_value, v.data.rule_type, v.data.access_level, v.data.description).run();
      return json({ success: true, rule: v.data }, 201);
    }

    if (method === 'PUT') {
      if (!target) return fail(400, 'חסר הערך לעדכון');
      const old = await env.DB.prepare("SELECT * FROM auth_rules WHERE rule_value = ?").bind(target).first();
      if (!old) return json({ error: 'Not Found', message: 'ההרשאה לא נמצאה' }, 404);
      const v = validate(await request.json().catch(() => ({})));
      if (!v.data) return fail(400, v.message);

      if (v.data.rule_value !== target) {
        const exists = await env.DB.prepare("SELECT 1 FROM auth_rules WHERE rule_value = ?").bind(v.data.rule_value).first();
        if (exists) return fail(400, 'ערך זה כבר קיים ברשימת ההרשאות');
      }
      // מונעים נעילה עצמית: אי אפשר להוריד את עצמך ממנהל-על או להפוך את עצמך לסוג אחר
      if (isMe(target) && (v.data.access_level !== SUPER_ADMIN || v.data.rule_type !== old.rule_type)) {
        return fail(400, 'לא ניתן להוריד את ההרשאה שאיתה אתם מחוברים כעת');
      }
      if (old.access_level === SUPER_ADMIN && v.data.access_level !== SUPER_ADMIN && await superAdminCount(env) <= 1) {
        return fail(400, 'חייב להישאר לפחות מנהל-על אחד במערכת');
      }

      await env.DB.prepare("UPDATE auth_rules SET rule_value = ?, rule_type = ?, access_level = ?, description = ? WHERE rule_value = ?")
        .bind(v.data.rule_value, v.data.rule_type, v.data.access_level, v.data.description, target).run();
      return json({ success: true, rule: v.data, was_current: isMe(target) });
    }

    if (method === 'DELETE') {
      if (!target) return fail(400, 'חסר הערך למחיקה');
      if (isMe(target)) return fail(400, 'לא ניתן למחוק את ההרשאה שאיתה אתם מחוברים כעת');
      const old = await env.DB.prepare("SELECT access_level FROM auth_rules WHERE rule_value = ?").bind(target).first();
      if (!old) return json({ error: 'Not Found', message: 'ההרשאה לא נמצאה' }, 404);
      if (old.access_level === SUPER_ADMIN && await superAdminCount(env) <= 1) {
        return fail(400, 'חייב להישאר לפחות מנהל-על אחד במערכת');
      }
      await env.DB.prepare("DELETE FROM auth_rules WHERE rule_value = ?").bind(target).run();
      return json({ success: true });
    }

    return json({ error: 'Method Not Allowed' }, 405);
  } catch (error) {
    return json({ error: 'Server Error', message: error.message }, 500);
  }
}
