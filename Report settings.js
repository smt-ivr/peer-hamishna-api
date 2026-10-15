import { getLocalTime } from './time.js';

// הגדרות עיצוב הדוחות — נשמרות כ-JSON בטבלת report_settings.
// כרגע פרופיל אחד ('default') שמשותף לכל המשתמשים; הטבלה כבר מוכנה לפרופילים נוספים.
const DEFAULT_PROFILE = 'default';
const MAX_BYTES = 16 * 1024;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

export default async function reportSettingsHandler(request, env) {
  const method = request.method;
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const profile = DEFAULT_PROFILE;

  try {
    // קריאה: מחזיר { settings: null } אם עדיין לא נשמר עיצוב מותאם
    if (method === 'GET') {
      const row = await env.DB.prepare(
        "SELECT settings, updated_at, updated_by FROM report_settings WHERE profile = ?"
      ).bind(profile).first();

      if (!row) return json({ settings: null, updated_at: null, updated_by: null });

      let settings = null;
      try { settings = JSON.parse(row.settings); } catch (e) { settings = null; }
      return json({ settings, updated_at: row.updated_at, updated_by: row.updated_by });
    }

    // שמירה (יצירה או עדכון)
    if (method === 'PUT') {
      const raw = await request.text();
      if (raw.length > MAX_BYTES * 2) return json({ error: 'Payload too large' }, 413);

      let body;
      try { body = JSON.parse(raw); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }

      const settings = body && body.settings;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return json({ error: 'Expected { "settings": { ... } }' }, 400);
      }

      const text = JSON.stringify(settings);
      if (text.length > MAX_BYTES) return json({ error: 'Settings too large' }, 413);

      const now = getLocalTime();
      await env.DB.prepare(`
        INSERT INTO report_settings (profile, settings, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profile)
        DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `).bind(profile, text, now, clientIp).run();

      return json({ success: true, updated_at: now });
    }

    // איפוס: מוחק את העיצוב המותאם וחוזרים לברירת המחדל
    if (method === 'DELETE') {
      await env.DB.prepare("DELETE FROM report_settings WHERE profile = ?").bind(profile).run();
      return json({ success: true });
    }

    return json({ error: 'Method Not Allowed' }, 405);

  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
