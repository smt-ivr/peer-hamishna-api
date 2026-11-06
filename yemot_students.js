import { getLocalTime } from './time.js';
import { loadSettings, normalizePhone, writeLog, agoText, decide, nowParts } from './phone_access.js';

// ============================================================
//  yemot_students.js — האזור האישי לתלמיד (ימות המשיח)
//
//  כניסה רק עם קוד תלמיד, ורק מטלפון שרשום אצל אותו תלמיד (אפשר לכבות בהגדרות).
//  אחרי הכניסה: "שלום <שם>, העדכון האחרון בוצע לפני ..." ותפריט:
//    1 פירוט (נבחן / עבר / לא עבר / מלגה)   2 בדיקה לפי קוד מבחן   3 תלמיד אחר   * יציאה
//  כל פעולה חוזרת לתפריט. הכל נרשם ביומן (phone_log, line = 'student').
//  מספר עם הרשאת "ניהול בטלפון" (פעיל, בתוקף ובשעות שלו) יכול לשמוע כל תלמיד.
//
//  שם הפרמטר שומר את השלב וההקשר:  s{מספר}_{שלב}_{תלמיד hex}_{ניסיונות שגויים}
//    sc  קוד תלמיד      mn  תפריט      ex  קוד מבחן
// ============================================================

const text = body => new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
const hex = s => [...new TextEncoder().encode(String(s || ''))].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = h => { try { return new TextDecoder().decode(new Uint8Array((String(h || '').match(/../g) || []).map(x => parseInt(x, 16)))); } catch (e) { return ''; } };
const MAX_FAILS = 3;

// digits: false = הקשה חופשית עם סולמית; מחרוזת = ספרה אחת מתוך הרשימה
const ask = (n, stage, msg, student = '', fails = 0, digits = false) =>
    text(`read=t-${msg}=s${n}_${stage}_${hex(student)}_${fails},,${digits ? '1' : ''},,,NO,,,,${digits || ''},,,,,no`);

function lastStep(url) {
    let best = null;
    for (const [key, value] of url.searchParams.entries()) {
        const m = /^s(\d+)_([a-z]{2})_([0-9a-f]*)_(\d+)$/.exec(key);
        if (m && (!best || +m[1] > best.n)) best = { n: +m[1], stage: m[2], student: unhex(m[3]), fails: +m[4], value: String(value || '').trim() };
    }
    return best;
}

const phonesOf = s => { try { const p = typeof s.phones === 'string' ? JSON.parse(s.phones) : s.phones; return (Array.isArray(p) ? p : []).map(normalizePhone).filter(Boolean); } catch (e) { return []; } };
const fullName = s => `${s.first_name || ''} ${s.last_name || ''}`.trim();
const MENU = 'לשמיעת הפירוט הקישו 1, לבדיקה לפי קוד מבחן הקישו 2, לתלמיד אחר הקישו 3, ליציאה הקישו כוכבית';

async function summary(env, code) {
    const r = await env.DB.prepare(`
        SELECT COUNT(*) AS total,
            SUM(CASE WHEN se.passed = 1 THEN 1 ELSE 0 END) AS passed,
            COALESCE(SUM(CASE WHEN se.passed = 1 THEN
                IFNULL(e.total_mishnayot, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'mishnayot') +
                IFNULL(e.gemara_pages, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'gemara_pages')
            ELSE 0 END), 0) AS reward,
            MAX(se.updated_at) AS last
        FROM student_exams se JOIN exams e ON se.exam_code = e.exam_code WHERE se.student_code = ?`).bind(code).first();
    return { total: (r && r.total) || 0, passed: (r && r.passed) || 0, reward: Number((r && r.reward) || 0), last: r && r.last };
}

export async function handleYemotStudents(request, env) {
    const url = new URL(request.url);
    const step = lastStep(url);
    const phone = normalizePhone(url.searchParams.get('ApiPhone'));
    const call_id = url.searchParams.get('ApiCallId') || null;
    const n = step ? step.n + 1 : 1;
    const log = row => writeLog(env, { line: 'student', phone, call_id, ...row });

    let settings;
    try { settings = (await loadSettings(env)).student; } catch (e) { settings = { enabled: true, require_phone: true, closed_message: '' }; }

    // --- הקו סגור ---
    if (!settings.enabled) {
        if (!step) await log({ event: 'call', reason: 'line_closed', action: 'hangup' });
        return text(`${settings.closed_message ? `id_list_message=t-${settings.closed_message}&` : ''}go_to_folder=hangup`);
    }
    if (settings.require_phone && !phone) {
        if (!step) await log({ event: 'call', reason: 'no_caller_id', action: 'hangup' });
        return text('id_list_message=t-לא ניתן להיכנס לאזור האישי ממספר חסוי&go_to_folder=hangup');
    }

    const askCode = (msg, fails = 0) => ask(n, 'sc', msg, '', fails);
    if (!step) {
        await log({ event: 'call', reason: 'ok_open', action: 'continue' });
        return askCode('ברוכים הבאים לאזור האישי, הקישו קוד תלמיד וסולמית');
    }
    if (step.value === '*') return text('id_list_message=t-להתראות&go_to_folder=hangup');

    // --- זיהוי התלמיד (נבדק מחדש בכל שלב) ---
    const code = step.stage === 'sc' ? step.value : step.student;
    const [student, mgrEntry] = await Promise.all([
        code ? env.DB.prepare('SELECT * FROM students WHERE student_code = ? AND is_deleted = 0').bind(code).first() : null,
        phone ? env.DB.prepare('SELECT * FROM phone_numbers WHERE phone = ? AND can_manage = 1').bind(phone).first().catch(() => null) : null
    ]);
    const manager = !!(mgrEntry && decide(phone, mgrEntry, nowParts()) === 'ok_listed');   // מנהל: פעיל, בתוקף, בשעות שלו
    const allowed = student && (manager || !settings.require_phone || phonesOf(student).includes(phone));

    if (!allowed) {
        if (step.stage !== 'sc') return askCode('הקישו קוד תלמיד וסולמית');   // הקשר לא תקף — מתחילים מחדש
        const reason = !student ? 'wrong_code' : 'phone_mismatch';
        const fails = step.fails + 1;
        await log({ event: 'access', reason: fails >= MAX_FAILS ? 'too_many' : reason, action: fails >= MAX_FAILS ? 'hangup' : 'continue',
            student_code: code, student_name: student ? fullName(student) : null });
        if (fails >= MAX_FAILS) return text('id_list_message=t-יותר מדי ניסיונות שגויים, השיחה תסתיים&go_to_folder=hangup');
        return askCode(!student ? 'קוד תלמיד שגוי, הקישו קוד תלמיד שנית וסולמית'
            : 'מספר הטלפון שממנו התקשרתם אינו רשום אצל תלמיד זה, הקישו קוד תלמיד אחר וסולמית', fails);
    }

    const name = fullName(student);
    // מנהל שומע בגוף שלישי, תלמיד בגוף שני
    const W = manager ? { notYet: 'עדיין לא נבחן באף מבחן', tested: 'בסך הכל נבחן ב', passed: 'עבר', failed: 'ולא עבר', reward: 'הסכום שנצבר לזכותו', inExamNot: 'עדיין לא נבחן', ok: 'עבר', bad: 'לא עבר' }
                      : { notYet: 'עדיין לא נבחנת באף מבחן', tested: 'בסך הכל נבחנת ב', passed: 'עברת', failed: 'ולא עברת', reward: 'הסכום שנצבר לזכותך', inExamNot: 'עדיין לא נבחנת', ok: 'עברת', bad: 'לא עברת' };
    const menu = msg => ask(n, 'mn', msg ? `${msg}, ${MENU}` : MENU, code, 0, '123');
    const st = () => summary(env, code);

    // נכנס עכשיו: שלום + העדכון האחרון + תפריט
    if (step.stage === 'sc') {
        await log({ event: 'access', reason: manager ? 'ok_manager' : 'ok', action: 'continue', student_code: code, student_name: name, number_name: manager ? mgrEntry.name : null });
        const s = await st();
        return menu(`${manager ? 'כניסת מנהל, התלמיד' : 'שלום'} ${name}, ${s.last ? `העדכון האחרון בוצע ${agoText(s.last)}` : W.notYet}`);
    }

    if (step.stage === 'mn') {
        if (step.value === '3') return askCode('הקישו קוד תלמיד וסולמית');
        if (step.value === '2') return ask(n, 'ex', 'הקישו מספר מבחן, כוכבית, 1 לאות אלף או 2 לאות בית, וסולמית', code);
        if (step.value !== '1') return menu('הקשה שגויה');
        // פירוט
        const s = await st();
        await log({ event: 'view', reason: 'summary', student_code: code, student_name: name });
        if (!s.total) return menu(W.notYet);
        const shekels = Math.floor(s.reward), agorot = Math.round((s.reward - shekels) * 100);
        const failed = s.total - s.passed;
        const parts = [`${W.tested}.n-${s.total}.t-מבחנים, ${W.passed}.n-${s.passed}.t-מבחנים`];
        if (failed > 0) parts.push(`.t-${W.failed}.n-${failed}.t-מבחנים`);
        parts.push(`.t-, ${W.reward}.n-${shekels}.t-שקלים`);
        if (agorot > 0) parts.push(`.t-ו.n-${agorot}.t-אגורות`);
        parts.push(`.t-, העדכון האחרון בוצע ${agoText(s.last)}`);
        return menu(parts.join(''));
    }

    if (step.stage === 'ex') {
        const p = step.value.split('*');
        if (p.length !== 2 || !/^\d+$/.test(p[0]) || (p[1] !== '1' && p[1] !== '2')) {
            return ask(n, 'ex', 'הקשה שגויה, הקישו מספר מבחן, כוכבית, ואז 1 או 2, וסולמית', code);
        }
        const examCode = `${p[0]}${p[1] === '1' ? 'א' : 'ב'}`;
        const exam = await env.DB.prepare('SELECT exam_code FROM exams WHERE exam_code = ? AND is_deleted = 0').bind(examCode).first();
        if (!exam) return menu(`מבחן ${examCode} לא נמצא`);
        const row = await env.DB.prepare('SELECT passed, updated_at FROM student_exams WHERE student_code = ? AND exam_code = ?').bind(code, examCode).first();
        await log({ event: 'view', reason: 'exam', student_code: code, student_name: name, exam_code: examCode, passed: row ? row.passed : null });
        if (!row) return menu(`במבחן ${examCode} ${W.inExamNot}`);
        return menu(`במבחן ${examCode} ${row.passed === 1 ? W.ok : W.bad}, העדכון בוצע ${agoText(row.updated_at)}`);
    }

    return askCode('הקישו קוד תלמיד וסולמית');
}
