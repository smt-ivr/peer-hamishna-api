import { getLocalTime } from './time.js';
import { identify, SUPER_ADMIN } from './admin.js';
import { REASONS, cleanSettings, settingsError, loadSettings, normalizePhone, validPhone } from './phone_access.js';

// ============================================================
//  phone_admin.js — מספרים מורשים לקו עדכון הציונים (למנהל-על בלבד)
//  GET    /peer/api/phone                      הגדרה + מספרים + סיכום היום + מספרים שעדכנו בעבר ואינם ברשימה
//  PUT    /peer/api/phone/settings             { settings: { edit_minutes, blocked: { action, folder, message } } }
//  POST   /peer/api/phone/numbers              הוספה   { name, phone, active, can_override, sched_enabled, days, time_from, time_to }
//  PUT    /peer/api/phone/numbers?id=          עדכון
//  DELETE /peer/api/phone/numbers?id=          מחיקה
//  GET    /peer/api/phone/log                  יומן שיחות  ?result=allowed|blocked &q= &before_id= &limit=
//  GET    /peer/api/phone/log/updates?call_id= עדכוני הציונים שבוצעו בשיחה
// ============================================================

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const bad = message => json({ error: 'Validation failed', message }, 400);
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateNumber(b) {
    const phone = normalizePhone(b.phone);
    const name = String(b.name || '').trim();
    const days = [...new Set((Array.isArray(b.days) ? b.days : String(b.days ?? '').split(',')).map(x => parseInt(x, 10)).filter(x => x >= 0 && x <= 6))].sort();
    const sched = !!b.sched_enabled;
    const from = String(b.time_from || '00:00'), to = String(b.time_to || '23:59');
    if (!validPhone(phone)) return { message: 'מספר טלפון לא תקין (למשל 0501234567)' };
    if (!name) return { message: 'יש להזין שם' };
    if (name.length > 80) return { message: 'השם ארוך מדי' };
    if (sched && !days.length) return { message: 'יש לבחור לפחות יום אחד' };
    if (!HM.test(from) || !HM.test(to)) return { message: 'שעה לא תקינה' };
    return { data: { phone, name, active: b.active === false || b.active === 0 ? 0 : 1, can_override: b.can_override ? 1 : 0, sched_enabled: sched ? 1 : 0, days: days.join(','), time_from: from, time_to: to } };
}

export default async function phoneAdminHandler(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const route = url.pathname.replace(/\/+$/, '');

    const { rule: me, clientIp } = await identify(request, env);
    if (!me || me.access_level !== SUPER_ADMIN) return json({ error: 'Forbidden', message: 'אזור זה זמין למנהל-על בלבד' }, 403);

    try {
        if (route === '/peer/api/phone' && method === 'GET') {
            const today = getLocalTime().slice(0, 10);
            const [settings, numbers, stats, past] = await Promise.all([
                loadSettings(env),
                env.DB.prepare(`SELECT n.id, n.phone, n.name, n.active, n.can_override, n.sched_enabled, n.days, n.time_from, n.time_to,
                        (SELECT MAX(created_at) FROM phone_log l WHERE l.phone = n.phone AND l.event = 'call') AS last_call
                    FROM phone_numbers n ORDER BY n.name COLLATE NOCASE`).all(),
                env.DB.prepare(`SELECT SUM(CASE WHEN event = 'call' THEN 1 ELSE 0 END) AS calls,
                        SUM(CASE WHEN event = 'call' AND reason NOT LIKE 'ok_%' THEN 1 ELSE 0 END) AS blocked,
                        SUM(CASE WHEN event = 'update' THEN 1 ELSE 0 END) AS updates
                    FROM phone_log WHERE created_at >= ?`).bind(today).first(),
                // מי שעדכן ציונים בטלפון בעבר ועדיין לא ברשימה — להוספה בלחיצה
                env.DB.prepare(`SELECT source_identifier AS phone, COUNT(*) AS updates, MAX(updated_at) AS last
                    FROM student_exams WHERE update_source = 'phone' AND source_identifier IS NOT NULL AND source_identifier != ''
                    GROUP BY source_identifier ORDER BY updates DESC LIMIT 20`).all()
            ]);
            const listed = new Set(numbers.results.map(n => n.phone));
            const suggestions = past.results.map(p => ({ ...p, phone: normalizePhone(p.phone) })).filter(p => validPhone(p.phone) && !listed.has(p.phone));
            return json({ settings, numbers: numbers.results, suggestions, reasons: REASONS,
                today: { calls: (stats && stats.calls) || 0, blocked: (stats && stats.blocked) || 0, updates: (stats && stats.updates) || 0 } });
        }

        if (route === '/peer/api/phone/settings' && method === 'PUT') {
            const s = cleanSettings((await request.json().catch(() => ({}))).settings);
            const err = settingsError(s);
            if (err) return bad(err);
            await env.DB.prepare(`INSERT INTO phone_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
                .bind(JSON.stringify(s), getLocalTime(), me.description || clientIp).run();
            return json({ success: true, settings: s });
        }

        if (route === '/peer/api/phone/numbers') {
            const id = parseInt(url.searchParams.get('id'), 10);
            if (method === 'POST' || method === 'PUT') {
                const v = validateNumber(await request.json().catch(() => ({})));
                if (!v.data) return bad(v.message);
                const d = v.data, now = getLocalTime();
                const dup = await env.DB.prepare('SELECT id, name FROM phone_numbers WHERE phone = ?').bind(d.phone).first();
                if (dup && (method === 'POST' || dup.id !== id)) return bad(`המספר כבר ברשימה (${dup.name})`);
                if (method === 'POST') {
                    const r = await env.DB.prepare(`INSERT INTO phone_numbers (phone, name, active, can_override, sched_enabled, days, time_from, time_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                        .bind(d.phone, d.name, d.active, d.can_override, d.sched_enabled, d.days, d.time_from, d.time_to, now, now).run();
                    return json({ success: true, id: r.meta && r.meta.last_row_id }, 201);
                }
                if (isNaN(id)) return bad('חסר מזהה');
                const r = await env.DB.prepare(`UPDATE phone_numbers SET phone = ?, name = ?, active = ?, can_override = ?, sched_enabled = ?, days = ?, time_from = ?, time_to = ?, updated_at = ? WHERE id = ?`)
                    .bind(d.phone, d.name, d.active, d.can_override, d.sched_enabled, d.days, d.time_from, d.time_to, now, id).run();
                if (!r.meta || !r.meta.changes) return json({ error: 'Not Found', message: 'המספר לא נמצא' }, 404);
                return json({ success: true });
            }
            if (method === 'DELETE') {
                if (isNaN(id)) return bad('חסר מזהה');
                await env.DB.prepare('DELETE FROM phone_numbers WHERE id = ?').bind(id).run();
                return json({ success: true });
            }
        }

        if (route === '/peer/api/phone/log' && method === 'GET') {
            const where = ["l.event = 'call'"], args = [];
            const result = url.searchParams.get('result');
            const q = (url.searchParams.get('q') || '').trim();
            const beforeId = parseInt(url.searchParams.get('before_id'), 10);
            const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 300);
            if (result === 'allowed') where.push("l.reason LIKE 'ok_%'");
            if (result === 'blocked') where.push("l.reason NOT LIKE 'ok_%'");
            if (q) { const p = normalizePhone(q); where.push("(IFNULL(l.number_name, '') LIKE ? OR l.phone LIKE ?)"); args.push(`%${q}%`, `%${p || q}%`); }
            if (!isNaN(beforeId)) { where.push('l.id < ?'); args.push(beforeId); }
            const { results } = await env.DB.prepare(`SELECT l.*,
                    (SELECT COUNT(*) FROM phone_log u WHERE u.event = 'update' AND u.call_id = l.call_id AND l.call_id IS NOT NULL) AS updates
                FROM phone_log l WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ?`).bind(...args, limit + 1).all();
            return json({ rows: results.slice(0, limit), has_more: results.length > limit });
        }
        if (route === '/peer/api/phone/log/updates' && method === 'GET') {
            const callId = url.searchParams.get('call_id');
            if (!callId) return bad('חסר מזהה שיחה');
            const { results } = await env.DB.prepare("SELECT created_at, student_code, student_name, exam_code, passed, reason FROM phone_log WHERE event = 'update' AND call_id = ? ORDER BY id").bind(callId).all();
            return json({ rows: results });
        }

        return json({ error: 'Not Found' }, 404);
    } catch (error) {
        if (/no such table/i.test(error.message)) return json({ error: 'Not Installed', message: 'טבלאות הטלפון עדיין לא נוצרו במסד הנתונים.' }, 503);
        return json({ error: 'Server Error', message: error.message }, 500);
    }
}
