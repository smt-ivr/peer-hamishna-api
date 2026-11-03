import { getLocalTime } from './time.js';

// ============================================================
//  phone_access.js — שער ההרשאות לקווי הטלפון (ימות המשיח)
//  כל בקשה מימות המשיח עוברת כאן לפני שמשהו קורה:
//    1. הקו כבוי?                     → "קו סגור"
//    2. מחוץ לשעות הפעילות של הקו?   → "קו סגור"
//    3. הקו פתוח לכולם?               → מאושר
//    4. רשימה לבנה: המספר ברשימה, פעיל, בתוקף, מורשה לקו הזה ובשעות שלו? אחרת → "מספר לא מורשה"
//  לכל חסימה יש פעולה: ניתוק, או העברה לשלוחה אחרת (עם הודעה לפני, אם רוצים).
// ============================================================

export const LINES = ['manager', 'student'];
export const REASONS = {
    ok_open: 'אושר (הקו פתוח לכולם)',
    ok_listed: 'אושר (מספר מורשה)',
    line_off: 'הקו כבוי',
    out_of_hours: 'מחוץ לשעות הפעילות של הקו',
    no_caller_id: 'מספר חסוי / ללא זיהוי',
    not_listed: 'המספר לא ברשימה',
    inactive: 'המספר מושבת',
    not_yet: 'ההרשאה עוד לא התחילה',
    expired: 'תוקף ההרשאה הסתיים',
    line_not_allowed: 'המספר לא מורשה לקו הזה',
    number_hours: 'מחוץ לשעות שהוגדרו למספר',
    error: 'תקלה בבדיקת ההרשאה'
};
const CLOSED_REASONS = new Set(['line_off', 'out_of_hours']);

const lineDefaults = (blockedMsg) => ({
    mode: 'open',                                       // open = כולם | whitelist = רק מספרים מורשים | off = הקו כבוי
    hours: { enabled: false, days: [0, 1, 2, 3, 4, 5], from: '07:00', to: '23:00' },
    blocked: { action: 'hangup', folder: '', message: blockedMsg },
    closed: { action: 'hangup', folder: '', message: 'המערכת סגורה כעת, נסו שוב בשעות הפעילות' }
});
export const DEFAULT_SETTINGS = {
    lines: {
        manager: lineDefaults('מספר הטלפון שלכם אינו מורשה לעדכן ציונים במערכת'),
        student: lineDefaults('מספר הטלפון שלכם אינו מורשה להאזין למערכת')
    }
};

// ---------- ניקוי וולידציה ----------
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// שלוחה בימות המשיח: /1 , /2/5 , או . (אותה שלוחה) — ספרות ולוכסנים בלבד
export const validFolder = f => /^\/?[0-9]+(\/[0-9]+)*$/.test(String(f || '')) || String(f || '') === '/';
// טקסט להקראה (t-): בלי תווים שמפרקים את הפקודה של ימות המשיח
export const speakable = s => String(s || '').replace(/[.,&=\-"'\n\r*#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

export function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('972')) d = '0' + d.slice(3);
    return d;
}
export const validPhone = p => /^0\d{8,9}$/.test(p);

function cleanDays(v) {
    const arr = (Array.isArray(v) ? v : String(v ?? '').split(',')).map(x => parseInt(x, 10)).filter(x => x >= 0 && x <= 6);
    return [...new Set(arr)].sort();
}
function cleanAction(a, def) {
    a = a && typeof a === 'object' ? a : {};
    const action = a.action === 'goto' ? 'goto' : 'hangup';
    const folder = String(a.folder || '').trim();
    return { action, folder: action === 'goto' ? folder : '', message: speakable(a.message ?? def.message) };
}
export function cleanSettings(raw) {
    const out = { lines: {} };
    for (const line of LINES) {
        const d = DEFAULT_SETTINGS.lines[line], r = (raw && raw.lines && raw.lines[line]) || {};
        const h = r.hours || {};
        out.lines[line] = {
            mode: ['open', 'whitelist', 'off'].includes(r.mode) ? r.mode : d.mode,
            hours: {
                enabled: !!h.enabled,
                days: h.days === undefined ? d.hours.days : cleanDays(h.days),
                from: HM.test(h.from) ? h.from : d.hours.from,
                to: HM.test(h.to) ? h.to : d.hours.to
            },
            blocked: cleanAction(r.blocked, d.blocked),
            closed: cleanAction(r.closed, d.closed)
        };
    }
    return out;
}
// שגיאה לתצוגה, או null
export function settingsError(s) {
    for (const line of LINES) {
        const L = s.lines[line];
        for (const k of ['blocked', 'closed']) {
            if (L[k].action === 'goto' && !validFolder(L[k].folder)) return 'יש להזין שלוחה תקינה להעברה (למשל /5 או /2/3)';
        }
        if (L.hours.enabled && !L.hours.days.length) return 'יש לבחור לפחות יום פעילות אחד';
    }
    return null;
}

// ---------- זמן ----------
export function nowParts(local = getLocalTime()) {
    const date = local.slice(0, 10), hm = local.slice(11, 16);
    const day = new Date(date + 'T00:00:00Z').getUTCDay();   // 0 = ראשון
    return { local, date, hm, day };
}
// חלון ימים+שעות. אם "עד" קטן מ"מ" — החלון עובר את חצות (למשל 22:00–02:00)
export function inWindow(days, from, to, t) {
    const set = new Set(days);
    if (from <= to) return set.has(t.day) && t.hm >= from && t.hm <= to;
    return (set.has(t.day) && t.hm >= from) || (set.has((t.day + 6) % 7) && t.hm <= to);
}

// ---------- ההחלטה ----------
export function decide(settings, line, phone, entry, t) {
    const L = settings.lines[line];
    if (L.mode === 'off') return 'line_off';
    if (L.hours.enabled && !inWindow(L.hours.days, L.hours.from, L.hours.to, t)) return 'out_of_hours';
    if (L.mode === 'open') return 'ok_open';
    if (!phone) return 'no_caller_id';
    if (!entry) return 'not_listed';
    if (!entry.active) return 'inactive';
    if (entry.valid_from && t.date < entry.valid_from) return 'not_yet';
    if (entry.valid_until && t.date > entry.valid_until) return 'expired';
    if (!String(entry.lines || '').split(',').includes(line)) return 'line_not_allowed';
    if (entry.sched_enabled && !inWindow(cleanDays(entry.days), entry.time_from, entry.time_to, t)) return 'number_hours';
    return 'ok_listed';
}
export const isAllowed = reason => reason.startsWith('ok_');

// הפקודה שחוזרת לימות המשיח כשהשיחה נחסמת
export function blockCommand(cfg) {
    const parts = [];
    const msg = speakable(cfg.message);
    if (msg) parts.push(`id_list_message=t-${msg}`);
    parts.push(`go_to_folder=${cfg.action === 'goto' && validFolder(cfg.folder) ? cfg.folder : 'hangup'}`);
    return parts.join('&');
}
export function actionFor(settings, line, reason) {
    if (isAllowed(reason)) return { label: 'continue', command: null };
    const cfg = CLOSED_REASONS.has(reason) ? settings.lines[line].closed : settings.lines[line].blocked;
    return { label: cfg.action === 'goto' && validFolder(cfg.folder) ? `goto:${cfg.folder}` : 'hangup', command: blockCommand(cfg) };
}

// ---------- גישה למסד ----------
export async function loadSettings(env) {
    const row = await env.DB.prepare('SELECT settings FROM phone_settings WHERE id = 1').first();
    let raw = null;
    try { raw = row ? JSON.parse(row.settings) : null; } catch (e) { raw = null; }
    return cleanSettings(raw);
}
export async function findNumber(env, phone) {
    if (!phone) return null;
    return env.DB.prepare('SELECT * FROM phone_numbers WHERE phone = ?').bind(phone).first();
}

const text = body => new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export async function writeLog(env, row) {
    try {
        await env.DB.prepare(`INSERT INTO phone_log (created_at, call_id, line, event, phone, number_id, number_name, reason, action, student_code, student_name, exam_code, passed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            getLocalTime(), row.call_id || null, row.line, row.event, row.phone || null, row.number_id ?? null, row.number_name || null,
            row.reason || null, row.action || null, row.student_code || null, row.student_name || null, row.exam_code || null, row.passed ?? null
        ).run();
        if (Math.random() < 0.01) await env.DB.prepare("DELETE FROM phone_log WHERE created_at < datetime('now', '-365 days')").run();
    } catch (e) { /* רישום לא עוצר את השיחה */ }
}

// ============================================================
//  השער עצמו. מחזיר { block: Response|null, ctx }
//  first = הבקשה הראשונה בשיחה (נרשמת ביומן). חסימה נרשמת תמיד.
// ============================================================
export async function phoneGate(request, env, line, first) {
    const url = new URL(request.url);
    const phone = normalizePhone(url.searchParams.get('ApiPhone'));
    const call_id = url.searchParams.get('ApiCallId') || null;
    const ctx = { line, phone, call_id, entry: null };
    let settings, reason;
    try {
        settings = await loadSettings(env);
        ctx.entry = await findNumber(env, phone);
        reason = decide(settings, line, phone, ctx.entry, nowParts());
    } catch (e) {
        // הטבלאות עוד לא נוצרו (לפני הרצת המיגרציה) — ממשיכים כמו קודם, בלי הגבלה
        if (/no such table/i.test(e.message)) return { block: null, ctx };
        await writeLog(env, { line, event: 'call', phone, call_id, reason: 'error', action: 'hangup' });
        return { block: text('id_list_message=t-אירעה תקלה זמנית במערכת נסו שוב מאוחר יותר&go_to_folder=hangup'), ctx };
    }

    const act = actionFor(settings, line, reason);
    const allowed = isAllowed(reason);
    if (!allowed || first) {
        let log = true;
        if (allowed && call_id) {   // אותה שיחה שחזרה להתחלה (כוכבית) — לא נרשמת פעמיים
            const seen = await env.DB.prepare("SELECT 1 FROM phone_log WHERE call_id = ? AND event = 'call' LIMIT 1").bind(call_id).first().catch(() => null);
            log = !seen;
        }
        if (log) await writeLog(env, { line, event: 'call', phone, call_id, number_id: ctx.entry && ctx.entry.id, number_name: ctx.entry && ctx.entry.name, reason, action: act.label });
    }
    return { block: allowed ? null : text(act.command), ctx };
}

// עדכון ציון שבוצע בטלפון
export function logUpdate(env, ctx, student, examCode, passed) {
    return writeLog(env, {
        line: ctx.line, event: 'update', phone: ctx.phone, call_id: ctx.call_id,
        number_id: ctx.entry && ctx.entry.id, number_name: ctx.entry && ctx.entry.name, reason: 'saved', action: 'continue',
        student_code: student.student_code, student_name: `${student.first_name || ''} ${student.last_name || ''}`.trim(), exam_code: examCode, passed
    });
}
