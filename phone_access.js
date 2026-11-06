import { getLocalTime } from './time.js';

// ============================================================
//  phone_access.js — הרשאות לקו עדכון הציונים (ימות המשיח)
//  רק מספרים שברשימה יכולים לעדכן, ובשעות שהוגדרו לכל מספר — תמיד, בלי יוצא מן הכלל.
//  רשימה ריקה = אף אחד לא יכול לעדכן. תקלה בבדיקה = חסימה.
//  מספר לא מורשה: ניתוק, או העברה לשלוחה אחרת (עם הודעה לפני, אם רוצים).
//  קו התלמידים לא מוגבל.
// ============================================================

export const REASONS = {
    ok_listed: 'אושר',
    no_caller_id: 'מספר חסוי',
    not_listed: 'המספר לא ברשימה',
    inactive: 'המספר מושבת',
    expired: 'תוקף ההרשאה הסתיים',
    bad_pin: 'סיסמה שגויה',
    number_hours: 'מחוץ לשעות של המספר',
    error: 'תקלה בבדיקה'
};

export const DEFAULT_STUDENT = { enabled: true, require_phone: true, closed_message: 'האזור האישי סגור כעת, נסו שוב מאוחר יותר' };
export const DEFAULT_SETTINGS = { edit_minutes: 5, student: DEFAULT_STUDENT, blocked: { action: 'hangup', folder: '', message: 'מספר הטלפון שלכם אינו מורשה לעדכן ציונים במערכת' } };

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
    const m = parseInt(raw && raw.edit_minutes, 10);
    const edit_minutes = isNaN(m) ? DEFAULT_SETTINGS.edit_minutes : Math.min(Math.max(m, 0), 1440);   // 0 = אין שינוי עצמי
    const st = (raw && raw.student) || {};
    const student = {
        enabled: st.enabled === undefined ? true : !!st.enabled,
        require_phone: st.require_phone === undefined ? true : !!st.require_phone,
        closed_message: speakable(st.closed_message ?? DEFAULT_STUDENT.closed_message)
    };
    return { edit_minutes, student, blocked: { action, folder: action === 'goto' ? String(b.folder || '').trim() : '', message: speakable(b.message ?? DEFAULT_SETTINGS.blocked.message) } };
}
export const settingsError = s => s.blocked.action === 'goto' && !validFolder(s.blocked.folder) ? 'יש להזין שלוחה תקינה להעברה (למשל /5 או /2/3)' : null;

// ---------- סיסמה לטלפון (נשמרת כ-hash עם salt, לא ניתנת לשחזור) ----------
export const validPin = p => /^\d{4,8}$/.test(String(p || ''));
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
export async function hashPin(pin) {
    const salt = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${salt}:${await sha(salt + ':' + pin)}`;
}
export async function checkPin(pin, stored) {
    const [salt, h] = String(stored || '').split(':');
    if (!salt || !h || !validPin(pin)) return false;
    return (await sha(salt + ':' + pin)) === h;
}

// ---------- זמן ----------
// "לפני 3 שעות" / "לפני יומיים" / "לפני שבועיים" ... (להקראה)
export function agoText(ts, now = getLocalTime()) {
    const a = Date.parse(String(ts || '').replace(' ', 'T') + 'Z'), b = Date.parse(now.replace(' ', 'T') + 'Z');
    if (isNaN(a)) return '';
    const m = Math.max(0, Math.floor((b - a) / 60000));
    const say = (v, one, two, many) => (v === 1 ? `לפני ${one}` : v === 2 ? `לפני ${two}` : `לפני ${v} ${many}`);
    if (m < 1) return 'לפני פחות מדקה';
    if (m < 60) return say(m, 'דקה', 'שתי דקות', 'דקות');
    const h = Math.floor(m / 60); if (h < 24) return say(h, 'שעה', 'שעתיים', 'שעות');
    const d = Math.floor(h / 24); if (d < 7) return say(d, 'יום', 'יומיים', 'ימים');
    if (d < 30) return say(Math.floor(d / 7), 'שבוע', 'שבועיים', 'שבועות');
    if (d < 365) return say(Math.max(1, Math.floor(d / 30)), 'חודש', 'חודשיים', 'חודשים');
    return say(Math.floor(d / 365), 'שנה', 'שנתיים', 'שנים');
}

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

// תוקף: 'YYYY-MM-DD HH:MM' (או תאריך בלבד = עד סוף היום)
export const untilOf = v => { const s = String(v || '').trim(); return !s ? '' : s.length === 10 ? s + ' 23:59' : s.slice(0, 16); };
export const isExpired = (entry, local = getLocalTime()) => !!(entry && entry.valid_until && local.slice(0, 16) > untilOf(entry.valid_until));

// ---------- ההחלטה ----------
export function decide(phone, entry, t) {
    if (!phone) return 'no_caller_id';
    if (!entry) return 'not_listed';
    if (!entry.active) return 'inactive';
    if (isExpired(entry, t.local)) return 'expired';
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
// מחוץ לשעות של המספר: אומרים שזה מחוץ לשעות ומתי כן אפשר (שעות בתבנית z-T13:00 של ימות המשיח)
const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export function daysSpoken(days) {
    const d = [...new Set(days)].sort((a, b) => a - b);
    if (d.length === 7) return 'בכל יום';
    const parts = [];
    for (let i = 0; i < d.length; i++) {
        let j = i;
        while (j + 1 < d.length && d[j + 1] === d[j] + 1) j++;
        if (j - i >= 2) parts.push(`${DAY_NAMES[d[i]]} עד ${DAY_NAMES[d[j]]}`);
        else for (let k = i; k <= j; k++) parts.push(DAY_NAMES[d[k]]);
        i = j;
    }
    return (d.length === 1 ? 'ביום ' : 'בימים ') + parts.join(' ו');
}
export function hoursCommand(entry, cfg) {
    const msg = `id_list_message=t-השעה הזו מחוץ לשעות העדכון שלכם ניתן לעדכן ${daysSpoken(parseDays(entry.days))} משעה.z-T${entry.time_from}.t-עד שעה.z-T${entry.time_to}`;
    return `${msg}&go_to_folder=${cfg.action === 'goto' && validFolder(cfg.folder) ? cfg.folder : 'hangup'}`;
}

export function expiredCommand(cfg) {
    return `id_list_message=t-תוקף ההרשאה שלכם לעדכון ציונים הסתיים, לחידוש ההרשאה פנו להנהלה&go_to_folder=${cfg.action === 'goto' && validFolder(cfg.folder) ? cfg.folder : 'hangup'}`;
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
            getLocalTime(), row.call_id || null, row.line || 'manager', row.event, row.phone || null, row.number_id ?? null, row.number_name || null,
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
        const [s, entry] = await Promise.all([
            loadSettings(env),
            phone ? env.DB.prepare('SELECT * FROM phone_numbers WHERE phone = ?').bind(phone).first() : null
        ]);
        settings = s; ctx.entry = entry;
        reason = decide(phone, entry, nowParts());
    } catch (e) {
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
    if (allowed) return { block: null, ctx };
    const cmd = reason === 'number_hours' ? hoursCommand(ctx.entry, settings.blocked) : reason === 'expired' ? expiredCommand(settings.blocked) : blockCommand(settings.blocked);
    return { block: text(cmd), ctx };
}

export function logUpdate(env, ctx, student, examCode, passed, reason = 'saved') {
    return writeLog(env, {
        event: 'update', phone: ctx.phone, call_id: ctx.call_id, number_id: ctx.entry && ctx.entry.id, number_name: ctx.entry && ctx.entry.name,
        reason, action: 'continue', student_code: student.student_code,
        student_name: `${student.first_name || ''} ${student.last_name || ''}`.trim(), exam_code: examCode, passed
    });
}
