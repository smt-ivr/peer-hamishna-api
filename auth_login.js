import { getLocalTime } from './time.js';

// ============================================================
//  auth_login.js — כניסה למערכת + רישום בהיסטוריית הכניסות
//  POST /peer/api/auth/login   { key?, mode: 'manual' | 'auto' }
//  הבדיקה זהה לחלוטין ל-/auth-check (אותן שאילתות, אותו סדר עדיפות),
//  ומחזירה את אותו מבנה תשובה — ההבדל היחיד הוא שהניסיון נרשם ב-login_log.
// ============================================================

const RETENTION_DAYS = 180;

export default async function authLoginHandler(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  const url = new URL(request.url);
  const body = await request.json().catch(() => ({}));
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const apiKey = (typeof body.key === 'string' && body.key) || request.headers.get('x-api-key') || url.searchParams.get('api_key');
  const mode = body.mode === 'auto' ? 'auto' : 'manual';

  // --- אותה בדיקה כמו ב-auth-check ---
  const ipRecord = await env.DB.prepare("SELECT access_level, description FROM auth_rules WHERE rule_type = 'ip' AND rule_value = ?").bind(clientIp).first();
  const isIpAllowed = !!ipRecord;

  let keyRecord = null;
  if (apiKey) {
    keyRecord = await env.DB.prepare("SELECT access_level, description FROM auth_rules WHERE rule_type = 'password' AND rule_value = ?").bind(apiKey).first();
  }
  const isKeyValid = !!keyRecord;
  const matched = isKeyValid ? keyRecord : (isIpAllowed ? ipRecord : null);
  const isAuthorized = isIpAllowed || isKeyValid;

  // --- רישום (שגיאה ברישום לא חוסמת כניסה) ---
  try {
    const cf = request.cf || {};
    await env.DB.prepare(`
      INSERT INTO login_log (created_at, success, mode, method, access_level, rule_description, key_length, ip, country, city, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      getLocalTime(), isAuthorized ? 1 : 0, mode,
      isKeyValid ? 'password' : (isIpAllowed ? 'ip' : null),
      matched ? matched.access_level : null,
      matched ? matched.description : null,
      apiKey ? String(apiKey).length : null,
      clientIp, cf.country || null, cf.city || null,
      (request.headers.get('user-agent') || '').slice(0, 300)
    ).run();

    if (Math.random() < 0.02) {
      await env.DB.prepare("DELETE FROM login_log WHERE created_at < datetime('now', ?)").bind(`-${RETENTION_DAYS} days`).run();
    }
  } catch (e) {}

  return new Response(JSON.stringify({
    client_ip: clientIp,
    is_ip_allowed: isIpAllowed,
    is_key_valid: isKeyValid,
    is_authorized: isAuthorized,
    access_level: matched ? matched.access_level : null
  }), { status: 200 });
}
