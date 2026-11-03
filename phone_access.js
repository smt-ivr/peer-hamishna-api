import { getLocalTime } from './time.js';

// ============================================================
//  phone_access.js — הרשאות לקו עדכון הציונים (ימות המשיח)
//  רק מספרים שברשימה יכולים לעדכן, ובשעות שהוגדרו לכל מספר.
//  כל עוד הרשימה ריקה — הקו פתוח כמו קודם (כדי לא לנעול את המערכת לפני שהוזנו מספרים).
//  מספר לא מורשה: ניתוק, או העברה לשלוחה אחרת (עם הודעה לפני, אם רוצים).
//  קו התלמידים לא מוגבל.
// ============================================================

export const REASONS = {
    ok_listed: 'אושר',
    ok_empty: 'אושר (הרשימה ריקה)',
    no_caller_id: 'מספר חסוי',
    not_listed: 'המספר לא ברשימה',
    inactive: 'המספר מושבת',
    number_hours: 'מחוץ לשעות של המספר',
    error: 'תקלה בבדיקה'
};

export const DEFAULT_SETTINGS = { blocked: { action: 'hangup', folder: '', message: 'מספר הטלפון שלכם אינו מורשה לעדכן ציונים במערכת' } };

// שלוחה בימות המשיח: /5 , /2/3 — ספרות ולוכסנים בלבד
export const validFolder = f => /^\/?[0-9]+(\/[0-9]+)*$/.test(String(f || ''));
// טקסט להקראה (t-): בלי תווים שמפרקים את הפקודה של ימות המשיח
export const speakable = s => String(s || '').replace(/[.,&=\-"'\n\r*#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

export function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('972')) d = '0' + d.slice(3);
    return d;
}
export const validPhone = p => /^0\d{8,9}$/.test(p);

export function cleanSettings(raw) {
    // תמיכה במבנה הישן (lines.manager.blocked)
    const b = (raw && (raw.blocked || (raw.lines && raw.lines.manager && raw.lines.manager.blocked))) || {};
    const action = b.action === 'goto' ? 'goto' : 'hangup';
    return { blocked: { action, folder: action === 'goto' ? String(b.folder || '').trim() : '', message: speakable(b.message ?? DEFAULT_SETTINGS.blocked.message) } };
}
export const settingsError = s => s.blocked.action === 'goto' && !validFolder(s.blocked.folder) ? 'יש להזין שלוחה תקינה להעברה (למשל /5 או /2/3)' : null;

// ---------- זמן ----------
export function nowParts(local = getLocalTime()) {
    const date = local.slice(0, 10);
    return { local, date, hm: local.slice(11, 16), day: new Date(date + 'T00:00:00Z').getUTCDay() };   // 0 = ראשון
}
const parseDays = s => String(s ?? '').split(',').filter(x => x !== '').map(Number);
// אם "עד" מוקדם מ"מ" — החלון עובר את חצות (22:00–02:00)
export function inWindow(days, from, to, t) {
    const set = new Set(days);
    if (from <= to) return set.has(t.day) && t.hm >= from && t.hm <= to;
    return (set.has(t.day) && t.hm >= from) || (set.has((t.day + 6) % 7) && t.hm <= to);
}

// ---------- ההחלטה ----------
export function decide(listSize, phone, entry, t) {
    if (!listSize) return 'ok_empty';
    if (!phone) return 'no_caller_id';
    if (!entry) return 'not_listed';
    if (!entry.active) return 'inactive';
    if (entry.sched_enabled && !inWindow(parseDays(entry.days), entry.time_from, entry.time_to, t)) return 'number_hours';
    return 'ok_listed';
}
export const isAllowed = reason => reason.startsWith('ok_');

export function blockCommand(cfg) {
    const msg = speakable(cfg.message), parts = [];
    if (msg) parts.push(`id_list_message=t-${msg}`);
    parts.push(`go_to_folder=${cfg.action === 'goto' && validFolder(cfg.folder) ? cfg.folder : 'hangup'}`);
    return parts.join('&');
}
export const actionLabel = cfg => cfg.action === 'goto' && validFolder(cfg.folder) ? `goto:${cfg.folder}` : 'hangup';

// ---------- מסד ----------
export async function loadSettings(env) {
    const row = await env.DB.prepare('SELECT settings FROM phone_settings WHERE id = 1').first();
    let raw = null;
    try { raw = row ? JSON.parse(row.settings) : null; } catch (e) { raw = null; }
    return cleanSettings(raw);
}

export async function writeLog(env, row) {
    try {
        await env.DB.prepare(`INSERT INTO phone_log (created_at, call_id, line, event, phone, number_id, number_name, reason, action, student_code, student_name, exam_code, passed)
            VALUES (?, ?, 'manager', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            getLocalTime(), row.call_id || null, row.event, row.phone || null, row.number_id ?? null, row.number_name || null,
            row.reason || null, row.action || null, row.student_code || null, row.student_name || null, row.exam_code || null, row.passed ?? null
        ).run();
        if (Math.random() < 0.01) await env.DB.prepare("DELETE FROM phone_log WHERE created_at < datetime('now', '-365 days')").run();
    } catch (e) { /* רישום לא עוצר את השיחה */ }
}

const text = body => new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

// ============================================================
//  השער: נבדק בכל שלב בשיחה. מחזיר { block: Response|null, ctx }
//  first = תחילת השיחה (נרשמת ביומן). חסימה נרשמת תמיד.
// ============================================================
export async function phoneGate(request, env, first) {
    const url = new URL(request.url);
    const phone = normalizePhone(url.searchParams.get('ApiPhone'));
    const call_id = url.searchParams.get('ApiCallId') || null;
    const ctx = { phone, call_id, entry: null };
    let settings, reason;
    try {
        const [s, count, entry] = await Promise.all([
            loadSettings(env),
            env.DB.prepare('SELECT COUNT(*) AS c FROM phone_numbers').first(),
            phone ? env.DB.prepare('SELECT * FROM phone_numbers WHERE phone = ?').bind(phone).first() : null
        ]);
        settings = s; ctx.entry = entry;
        reason = decide(count ? count.c : 0, phone, entry, nowParts());
    } catch (e) {
        if (/no such table/i.test(e.message)) return { block: null, ctx };   // לפני התקנת הטבלאות — כמו קודם
        await writeLog(env, { event: 'call', phone, call_id, reason: 'error', action: 'hangup' });
        return { block: text('id_list_message=t-אירעה תקלה זמנית במערכת נסו שוב מאוחר יותר&go_to_folder=hangup'), ctx };
    }

    const allowed = isAllowed(reason);
    if (!allowed || first) {
        let log = true;
        if (allowed && call_id) {   // אותה שיחה שחזרה להתחלה (כוכבית) — נרשמת פעם אחת
            const seen = await env.DB.prepare("SELECT 1 FROM phone_log WHERE call_id = ? AND event = 'call' LIMIT 1").bind(call_id).first().catch(() => null);
            log = !seen;
        }
        if (log) await writeLog(env, { event: 'call', phone, call_id, number_id: ctx.entry && ctx.entry.id, number_name: ctx.entry && ctx.entry.name, reason, action: allowed ? 'continue' : actionLabel(settings.blocked) });
    }
    return { block: allowed ? null : text(blockCommand(settings.blocked)), ctx };
}

export function logUpdate(env, ctx, student, examCode, passed) {
    return writeLog(env, {
        event: 'update', phone: ctx.phone, call_id: ctx.call_id, number_id: ctx.entry && ctx.entry.id, number_name: ctx.entry && ctx.entry.name,
        reason: 'saved', action: 'continue', student_code: student.student_code,
        student_name: `${student.first_name || ''} ${student.last_name || ''}`.trim(), exam_code: examCode, passed
    });
}
