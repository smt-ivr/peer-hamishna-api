import { getLocalTime } from './time.js';
import { identify, SUPER_ADMIN } from './admin.js';
import {
    LINES, REASONS, cleanSettings, settingsError, loadSettings, normalizePhone, validPhone,
    decide, isAllowed, actionFor, nowParts, findNumber
} from './phone_access.js';

// ============================================================
//  phone_admin.js — ניהול הרשאות הטלפון (למנהל-על בלבד)
//  GET    /peer/api/phone                      הגדרות + מספרים + סיכום היום
//  PUT    /peer/api/phone/settings             { settings }
//  POST   /peer/api/phone/numbers              הוספת מספר
//  PUT    /peer/api/phone/numbers?id=          עדכון
//  DELETE /peer/api/phone/numbers?id=          מחיקה
//  GET    /peer/api/phone/log                  יומן שיחות  ?result=allowed|blocked &line= &q= &before_id= &limit=
//  GET    /peer/api/phone/log/updates?call_id= עדכוני הציונים שבוצעו בשיחה
//  POST   /peer/api/phone/test                 { phone, line, at? } — מה יקרה אם המספר יתקשר
// ============================================================

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const bad = message => json({ error: 'Validation failed', message }, 400);
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NO_TABLES = 'טבלאות הטלפון עדיין לא נוצרו במסד הנתונים. יש להריץ את המיגרציה migrations/0002_phone_access.sql';

function validateNumber(b) {
    const phone = normalizePhone(b.phone);
    const name = String(b.name || '').trim();
    const notes = String(b.notes || '').trim() || null;
    const lines = (Array.isArray(b.lines) ? b.lines : String(b.lines || '').split(',')).filter(l => LINES.includes(l));
    const days = [...new Set((Array.isArray(b.days) ? b.days : String(b.days || '').split(',')).map(x => parseInt(x, 10)).filter(x => x >= 0 && x <= 6))].sort();
    const sched = !!b.sched_enabled;
    const from = String(b.time_from || '00:00'), to = String(b.time_to || '23:59');
    const vf = String(b.valid_from || '').trim() || null, vu = String(b.valid_until || '').trim() || null;

    if (!validPhone(phone)) return { message: 'מספר טלפון לא תקין (למשל 0501234567)' };
    if (!name) return { message: 'יש להזין שם' };
    if (name.length > 80 || (notes && notes.length > 200)) return { message: 'הטקסט ארוך מדי' };
    if (!lines.length) return { message: 'יש לבחור לפחות קו אחד שהמספר מורשה אליו' };
    if (sched && !days.length) return { message: 'יש לבחור לפחות יום אחד' };
    if (!HM.test(from) || !HM.test(to)) return { message: 'שעה לא תקינה' };
    if ((vf && !DATE.test(vf)) || (vu && !DATE.test(vu))) return { message: 'תאריך לא תקין' };
    if (vf && vu && vf > vu) return { message: 'תאריך הסיום מוקדם מתאריך ההתחלה' };
    return { data: { phone, name, notes, active: b.active === false || b.active === 0 ? 0 : 1, lines: lines.join(','), sched_enabled: sched ? 1 : 0, days: days.join(','), time_from: from, time_to: to, valid_from: vf, valid_until: vu } };
}

export default async function phoneAdminHandler(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const route = url.pathname.replace(/\/+$/, '');

    const { rule: me, clientIp } = await identify(request, env);
    if (!me || me.access_level !== SUPER_ADMIN) return json({ error: 'Forbidden', message: 'אזור זה זמין למנהל-על בלבד' }, 403);

    try {
        // ---------- סקירה ----------
        if (route === '/peer/api/phone' && method === 'GET') {
            const today = getLocalTime().slice(0, 10);
            const [settings, numbers, stats] = await Promise.all([
                loadSettings(env),
                env.DB.prepare(`SELECT n.*, (SELECT MAX(created_at) FROM phone_log l WHERE l.phone = n.phone AND l.event = 'call') AS last_call
                                FROM phone_numbers n ORDER BY n.name COLLATE NOCASE`).all(),
                env.DB.prepare(`SELECT
                        SUM(CASE WHEN event = 'call' THEN 1 ELSE 0 END) AS calls,
                        SUM(CASE WHEN event = 'call' AND reason NOT LIKE 'ok_%' THEN 1 ELSE 0 END) AS blocked,
                        SUM(CASE WHEN event = 'update' THEN 1 ELSE 0 END) AS updates
                    FROM phone_log WHERE created_at >= ?`).bind(today).first()
            ]);
            return json({ settings, numbers: numbers.results, now: getLocalTime(), reasons: REASONS,
                today: { calls: (stats && stats.calls) || 0, blocked: (stats && stats.blocked) || 0, updates: (stats && stats.updates) || 0 } });
        }

        // ---------- הגדרות הקווים ----------
        if (route === '/peer/api/phone/settings' && method === 'PUT') {
            const body = await request.json().catch(() => ({}));
            const s = cleanSettings(body.settings);
            const err = settingsError(s);
            if (err) return bad(err);
            const now = getLocalTime();
            await env.DB.prepare(`INSERT INTO phone_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
                .bind(JSON.stringify(s), now, me.description || clientIp).run();
            return json({ success: true, settings: s, updated_at: now });
        }

        // ---------- מספרים מורשים ----------
        if (route === '/peer/api/phone/numbers') {
            const id = parseInt(url.searchParams.get('id'), 10);
            if (method === 'POST' || method === 'PUT') {
                const v = validateNumber(await request.json().catch(() => ({})));
                if (!v.data) return bad(v.message);
                const d = v.data, now = getLocalTime();
                const dup = await env.DB.prepare('SELECT id, name FROM phone_numbers WHERE phone = ?').bind(d.phone).first();
                if (dup && (method === 'POST' || dup.id !== id)) return bad(`המספר כבר קיים ברשימה (${dup.name})`);
                if (method === 'POST') {
                    const r = await env.DB.prepare(`INSERT INTO phone_numbers (phone, name, notes, active, lines, sched_enabled, days, time_from, time_to, valid_from, valid_until, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(d.phone, d.name, d.notes, d.active, d.lines, d.sched_enabled, d.days, d.time_from, d.time_to, d.valid_from, d.valid_until, now, now).run();
                    return json({ success: true, id: r.meta && r.meta.last_row_id }, 201);
                }
                if (isNaN(id)) return bad('חסר מזהה');
                const r = await env.DB.prepare(`UPDATE phone_numbers SET phone = ?, name = ?, notes = ?, active = ?, lines = ?, sched_enabled = ?, days = ?, time_from = ?, time_to = ?, valid_from = ?, valid_until = ?, updated_at = ? WHERE id = ?`)
                    .bind(d.phone, d.name, d.notes, d.active, d.lines, d.sched_enabled, d.days, d.time_from, d.time_to, d.valid_from, d.valid_until, now, id).run();
                if (!r.meta || !r.meta.changes) return json({ error: 'Not Found', message: 'המספר לא נמצא' }, 404);
                return json({ success: true });
            }
            if (method === 'DELETE') {
                if (isNaN(id)) return bad('חסר מזהה');
                await env.DB.prepare('DELETE FROM phone_numbers WHERE id = ?').bind(id).run();
                return json({ success: true });
            }
        }

        // ---------- יומן שיחות ----------
        if (route === '/peer/api/phone/log' && method === 'GET') {
            const where = ["l.event = 'call'"], args = [];
            const result = url.searchParams.get('result'), line = url.searchParams.get('line');
            const q = (url.searchParams.get('q') || '').trim();
            const beforeId = parseInt(url.searchParams.get('before_id'), 10);
            const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 300);
            if (result === 'allowed') where.push("l.reason LIKE 'ok_%'");
            if (result === 'blocked') where.push("l.reason NOT LIKE 'ok_%'");
            if (LINES.includes(line)) { where.push('l.line = ?'); args.push(line); }
            if (q) { const p = normalizePhone(q); where.push("(IFNULL(l.number_name, '') LIKE ? OR l.phone LIKE ?)"); args.push(`%${q}%`, `%${p || q}%`); }
            if (!isNaN(beforeId)) { where.push('l.id < ?'); args.push(beforeId); }
            const { results } = await env.DB.prepare(`SELECT l.*,
                    (SELECT COUNT(*) FROM phone_log u WHERE u.event = 'update' AND u.call_id = l.call_id AND l.call_id IS NOT NULL) AS updates
                FROM phone_log l WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ?`).bind(...args, limit + 1).all();
            return json({ rows: results.slice(0, limit), has_more: results.length > limit, reasons: REASONS });
        }
        if (route === '/peer/api/phone/log/updates' && method === 'GET') {
            const callId = url.searchParams.get('call_id');
            if (!callId) return bad('חסר מזהה שיחה');
            const { results } = await env.DB.prepare("SELECT created_at, student_code, student_name, exam_code, passed FROM phone_log WHERE event = 'update' AND call_id = ? ORDER BY id")
                .bind(callId).all();
            return json({ rows: results });
        }

        // ---------- בדיקה: מה יקרה אם המספר יתקשר ----------
        if (route === '/peer/api/phone/test' && method === 'POST') {
            const b = await request.json().catch(() => ({}));
            const line = LINES.includes(b.line) ? b.line : 'manager';
            const phone = normalizePhone(b.phone);
            let t = nowParts();
            if (b.at) {
                const at = String(b.at).replace('T', ' ');
                if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) return bad('מועד לא תקין');
                t = nowParts(at + ':00');
            }
            const settings = await loadSettings(env);
            const entry = await findNumber(env, phone);
            const reason = decide(settings, line, phone, entry, t);
            const act = actionFor(settings, line, reason);
            return json({ allowed: isAllowed(reason), reason, reason_text: REASONS[reason], action: act.label, command: act.command, entry, at: t.local });
        }

        return json({ error: 'Not Found' }, 404);
    } catch (error) {
        if (/no such table/i.test(error.message)) return json({ error: 'Not Installed', message: NO_TABLES }, 503);
        return json({ error: 'Server Error', message: error.message }, 500);
    }
}
