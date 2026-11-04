import { getLocalTime } from './time.js';

// ============================================================
//  phone_audit.js — היסטוריית שינויים בהרשאות הטלפון
//  כל הוספה / עריכה / מחיקה / השבתה / שינוי הגדרות — מהאתר או מהטלפון — נרשמת כאן.
// ============================================================

const DAY = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const fmtUntil = v => { const s = String(v || ''); if (!s) return 'ללא הגבלה'; const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?/.exec(s); return m ? `${m[3]}/${m[2]}/${m[1].slice(2)}${m[4] ? ' ' + m[4] : ''}` : s; };
const fmtHours = n => !n.sched_enabled ? 'תמיד' : `${String(n.days || '').split(',').filter(Boolean).map(d => DAY[+d]).join(',')} ${n.time_from}–${n.time_to}`;
const yes = v => (v ? 'כן' : 'לא');

// תיאור קריא של מה שהשתנה במספר
export function describeChange(before, after) {
    if (!before) return [`תוקף: ${fmtUntil(after.valid_until)}`, `שעות: ${fmtHours(after)}`, after.can_override ? 'שינוי כל ציון: כן' : '', after.can_manage ? 'ניהול בטלפון: כן' : ''].filter(Boolean).join(' · ');
    const out = [];
    const f = (label, a, b) => { if (String(a ?? '') !== String(b ?? '')) out.push(`${label}: ${a} ← ${b}`); };
    f('שם', before.name, after.name);
    f('טלפון', before.phone, after.phone);
    f('מצב', before.active ? 'פעיל' : 'מושבת', after.active ? 'פעיל' : 'מושבת');
    f('תוקף', fmtUntil(before.valid_until), fmtUntil(after.valid_until));
    f('שעות', fmtHours(before), fmtHours(after));
    f('שינוי כל ציון', yes(before.can_override), yes(after.can_override));
    f('ניהול בטלפון', yes(before.can_manage), yes(after.can_manage));
    return out.join(' · ');
}

export async function audit(env, row) {
    try {
        await env.DB.prepare(`INSERT INTO phone_audit (created_at, source, actor, actor_phone, action, phone, name, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(getLocalTime(), row.source, row.actor || null, row.actor_phone || null, row.action, row.phone || null, row.name || null, row.details || null).run();
    } catch (e) { /* רישום לא עוצר את הפעולה */ }
}
