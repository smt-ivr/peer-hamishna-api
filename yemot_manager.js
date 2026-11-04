import { getLocalTime } from './time.js';
import { phoneGate, logUpdate, loadSettings, normalizePhone, validPhone, isExpired } from './phone_access.js';
import { audit, describeChange } from './phone_audit.js';

// ============================================================
//  yemot_manager.js — קו עדכון הציונים (ימות המשיח)
//
//  כל שאלה נשמרת בפרמטר ששמו מכיל את השלב ואת ההקשר:  p{מספר}_{שלב}_{תלמיד}_{מבחן}
//  ימות המשיח מחזיר את כל הפרמטרים שנאספו; אנחנו קוראים רק את האחרון (המספר הגבוה).
//  שלבים:
//    st  קוד תלמיד
//    ex  קוד מבחן (לתלמיד)
//    ow  למבחן כבר יש ציון ולמתקשר יש הרשאה לשנות: 1 שינוי, 2 מבחן אחר
//    ps  עבר / לא עבר
//    nx  אחרי שמירה: 1 מבחן נוסף לאותו תלמיד, 2 תלמיד אחר
//  ניהול הרשאות (0# במקום קוד תלמיד, רק למספר עם הרשאת ניהול):
//    mm  תפריט: 1 הוספה/הארכה, 2 ביטול, 3 בדיקת מצב, 0 חזרה
//    mp  מספר הטלפון (בשדה התלמיד נשמרת הפעולה: add/del/chk)
//    md  תוקף ההרשאה: 1 יום, 2 שבוע, 3 חודש, 4 שנה, 5 ללא הגבלה
//    mc  אישור ביטול
//
//  שינוי ציון קיים מותר רק אם:
//    • למספר יש הרשאת "שינוי ציון קיים", או
//    • הציון עודכן מהטלפון של המתקשר עצמו לפני פחות מ-X דקות (X בהגדרות)
// ============================================================

const text = body => new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

function getGradeValue(gradeStr) {
    if (!gradeStr) return 0;
    const g = String(gradeStr).replace(/כיתה/g, '').replace(/['"']/g, '').trim();
    const map = { 'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6, 'ז': 7, 'ח': 8, 'ט': 9, 'י': 10, 'יא': 11, 'יב': 12 };
    const n = parseInt(g, 10);
    return !isNaN(n) ? n : (map[g] || 0);
}

// קוד תלמיד/מבחן בשם פרמטר: hex של UTF-8 (רק 0-9a-f — בטוח לכל קוד)
const hex = s => [...new TextEncoder().encode(String(s || ''))].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = h => { try { return new TextDecoder().decode(new Uint8Array((String(h || '').match(/../g) || []).map(x => parseInt(x, 16)))); } catch (e) { return ''; } };

// ---------- פקודות לימות המשיח ----------
// digits: false = הקשה חופשית עם סולמית; true = ספרה אחת 1/2; מחרוזת = ספרה אחת מתוך הרשימה
const ask = (n, stage, msg, ctx = {}, digits = false) => {
    const name = `p${n}_${stage}_${hex(ctx.student)}_${hex(ctx.exam)}`;
    const allowed = digits === true ? '12' : (digits || '');
    return text(`read=t-${msg}=${name},,${digits ? '1' : ''},,,NO,,,,${allowed},,,,,no`);
};
// מספר טלפון להקראה ספרה ספרה (d-) בתוך הודעה
const sayPhone = p => `.d-${p}.t-`;

function lastStep(url) {
    let best = null;
    for (const [key, value] of url.searchParams.entries()) {
        const m = /^p(\d+)_([a-z]{2})_([0-9a-f]*)_([0-9a-f]*)$/.exec(key);
        if (m && (!best || +m[1] > best.n)) best = { n: +m[1], stage: m[2], student: unhex(m[3]), exam: unhex(m[4]), value: String(value || '').trim() };
    }
    return best;
}

const fullName = s => `${s.first_name || ''} ${s.last_name || ''}`.trim();
const passText = v => (v === 1 ? 'עבר' : 'לא עבר');
function minutesSince(ts, now) {
    const a = Date.parse(String(ts || '').replace(' ', 'T') + 'Z'), b = Date.parse(now.replace(' ', 'T') + 'Z');
    return isNaN(a) ? Infinity : (b - a) / 60000;
}

// האם המתקשר רשאי לשנות ציון קיים. מחזיר { ok, why }
function canChange(existing, ctx, settings, now) {
    if (ctx.entry && ctx.entry.can_override) return { ok: true, why: 'override' };
    const mins = settings.edit_minutes;
    if (mins > 0 && existing.update_source === 'phone' && normalizePhone(existing.source_identifier) === ctx.phone
        && minutesSince(existing.updated_at, now) <= mins) return { ok: true, why: 'own' };
    return { ok: false };
}

function examDetails(exam) {
    let d = '';
    if (exam.masechet) d += `${exam.masechet}, `;
    if (exam.chapter_num) d += `פרק ${exam.chapter_num}, `;
    if (exam.chapter_name) d += `${exam.chapter_name}, `;
    if (exam.from_page && exam.to_page) d += `מ ${exam.from_page} עד ${exam.to_page}, `;
    return d;
}

export async function handleYemotManager(request, env) {
    const url = new URL(request.url);
    const step = lastStep(url);

    // שער ההרשאות: רק מספרים מורשים, בשעות שלהם (נבדק בכל שלב בשיחה)
    const gate = await phoneGate(request, env, !step);
    if (gate.block) return gate.block;
    const ctx = gate.ctx;
    if (!ctx.phone) return text('id_list_message=t-לא ניתן לעדכן ציונים ממספר חסוי&go_to_folder=hangup');

    const n = step ? step.n + 1 : 1;
    const canManage = !!(ctx.entry && ctx.entry.can_manage);
    const askStudent = msg => ask(n, 'st', msg + (canManage ? ', לניהול הרשאות טלפון הקישו 0 וסולמית' : ''));

    // --- תחילת שיחה ---
    if (!step) return askStudent('ברוכים הבאים למערכת עדכון המבחנים, הקישו קוד תלמיד וסולמית, או כוכבית ליציאה');
    if (step.value === '*') return step.stage === 'st' ? text('go_to_folder=hangup') : askStudent('הקישו קוד תלמיד וסולמית, או כוכבית ליציאה');

    // --- ניהול הרשאות ---
    if ((step.stage === 'st' && step.value === '0' && canManage) || step.stage.startsWith('m')) {
        if (!canManage) return askStudent('אין לכם הרשאה לניהול, הקישו קוד תלמיד וסולמית');
        return manage(env, ctx, step, n, askStudent);
    }

    // --- תלמיד ---
    const studentCode = step.stage === 'st' ? step.value : step.student;
    const student = studentCode ? await env.DB.prepare('SELECT * FROM students WHERE student_code = ? AND is_deleted = 0').bind(studentCode).first() : null;
    if (!student) return askStudent('קוד תלמיד שגוי, הקישו קוד תלמיד שנית');
    const name = fullName(student);
    const askExam = msg => ask(n, 'ex', msg, { student: studentCode });

    if (step.stage === 'st') return askExam(`${name}, הקישו מספר מבחן, כוכבית, 1 לאות אלף או 2 לאות בית, וסולמית`);

    if (step.stage === 'nx') {
        if (step.value === '1') return askExam(`${name}, הקישו מספר מבחן, כוכבית, 1 לאות אלף או 2 לאות בית, וסולמית`);
        return askStudent('הקישו קוד תלמיד וסולמית, או כוכבית ליציאה');
    }

    // --- מבחן ---
    let examCode = step.exam;
    if (step.stage === 'ex') {
        const parts = step.value.split('*');
        if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || (parts[1] !== '1' && parts[1] !== '2')) {
            return askExam('הקשה שגויה, הקישו מספר מבחן, כוכבית, ואז 1 או 2');
        }
        examCode = `${parts[0]}${parts[1] === '1' ? 'א' : 'ב'}`;
    }
    const exam = examCode ? await env.DB.prepare('SELECT * FROM exams WHERE exam_code = ? AND is_deleted = 0').bind(examCode).first() : null;
    if (!exam) return askExam(`מבחן ${examCode || ''} לא נמצא, הקישו מספר מבחן אחר`);

    if (exam.target_grade && student.class_grade) {
        const sv = getGradeValue(student.class_grade), tv = getGradeValue(exam.target_grade);
        if (sv > 0 && tv > 0 && sv < tv) return askExam('המבחן מיועד לכיתה גבוהה יותר, הקישו מספר מבחן אחר');
    }

    const now = getLocalTime();
    const [settings, existing] = await Promise.all([
        loadSettings(env),
        env.DB.prepare('SELECT * FROM student_exams WHERE student_code = ? AND exam_code = ?').bind(studentCode, examCode).first()
    ]);
    const perm = existing ? canChange(existing, ctx, settings, now) : { ok: true };
    const askPass = (msg = '') => ask(n, 'ps', `${msg}מבחן ${examCode}, ${examDetails(exam)} עבר הקישו 1, לא עבר הקישו 2`, { student: studentCode, exam: examCode }, true);

    // נבחר מבחן: אם כבר יש ציון — מודיעים, ומציעים לשנות רק למי שמורשה
    if (step.stage === 'ex') {
        if (!existing) return askPass();
        if (!perm.ok) return askExam(`למבחן ${examCode} כבר קיים ציון ${passText(existing.passed)}, ואין לכם הרשאה לשנות אותו, הקישו מספר מבחן אחר`);
        const why = perm.why === 'own' ? ` שעודכן ממספר זה לפני ${Math.max(1, Math.round(minutesSince(existing.updated_at, now)))} דקות` : '';
        return ask(n, 'ow', `למבחן ${examCode} כבר קיים ציון ${passText(existing.passed)}${why}, יש לכם הרשאה לשנות אותו, לשינוי הציון הקישו 1, למבחן אחר הקישו 2`,
            { student: studentCode, exam: examCode }, true);
    }

    if (step.stage === 'ow') {
        if (step.value !== '1') return askExam(`${name}, הקישו מספר מבחן, כוכבית, 1 לאות אלף או 2 לאות בית, וסולמית`);
        if (existing && !perm.ok) return askExam(`זמן השינוי הסתיים, לא ניתן לשנות את הציון למבחן ${examCode}, הקישו מספר מבחן אחר`);
        return askPass('שינוי ציון, ');
    }

    // --- שמירה ---
    if (step.stage === 'ps') {
        if (step.value !== '1' && step.value !== '2') return askPass('הקשה שגויה, ');
        const passed = step.value === '1' ? 1 : 2;
        const done = msg => ask(n, 'nx', `${msg}, לעדכון מבחן נוסף ל${name} הקישו 1, לתלמיד אחר הקישו 2`, { student: studentCode }, true);
        try {
            if (!existing) {
                const r = await env.DB.prepare(`INSERT INTO student_exams (student_code, exam_code, passed, updated_at, update_source, source_identifier)
                    VALUES (?, ?, ?, ?, 'phone', ?) ON CONFLICT(student_code, exam_code) DO NOTHING`).bind(studentCode, examCode, passed, now, ctx.phone).run();
                if (r.meta && r.meta.changes === 0) return askExam(`בינתיים עודכן ציון למבחן ${examCode} ממקום אחר, הקישו מספר מבחן אחר`);
                await logUpdate(env, ctx, student, examCode, passed);
                return done(`מבחן ${examCode} עודכן, ${passText(passed)}`);
            }
            if (!perm.ok) return askExam(`זמן השינוי הסתיים, לא ניתן לשנות את הציון למבחן ${examCode}, הקישו מספר מבחן אחר`);
            if ((existing.passed === 1) === (passed === 1)) return done(`הציון למבחן ${examCode} נשאר ${passText(passed)}, לא היה צורך בשינוי`);
            await env.DB.prepare(`UPDATE student_exams SET passed = ?, updated_at = ?, update_source = 'phone', source_identifier = ? WHERE student_code = ? AND exam_code = ?`)
                .bind(passed, now, ctx.phone, studentCode, examCode).run();
            await logUpdate(env, ctx, student, examCode, passed, 'changed');
            return done(`הציון למבחן ${examCode} שונה ל${passText(passed)}`);
        } catch (e) {
            return askPass('אירעה שגיאה בשמירה, נסו שוב, ');
        }
    }

    return askStudent('הקישו קוד תלמיד וסולמית, או כוכבית ליציאה');
}

// ============================================================
//  ניהול הרשאות בטלפון
// ============================================================
const MENU = 'להוספה או הארכה של הרשאה למספר הקישו 1, לביטול הרשאה של מספר הקישו 2, לבדיקת מצב של מספר הקישו 3, לחזרה לעדכון ציונים הקישו 0';
const DURATIONS = { 1: ['יום', d => d.setUTCDate(d.getUTCDate() + 1)], 2: ['שבוע', d => d.setUTCDate(d.getUTCDate() + 7)], 3: ['חודש', d => d.setUTCMonth(d.getUTCMonth() + 1)],
                    4: ['שנה', d => d.setUTCFullYear(d.getUTCFullYear() + 1)], 5: ['ללא הגבלת זמן', null] };
function addTime(local, fn) {
    const d = new Date(local.replace(' ', 'T') + 'Z'); fn(d);
    return d.toISOString().slice(0, 16).replace('T', ' ');
}
const COLS = 'id, phone, name, active, can_override, can_manage, valid_until, sched_enabled, days, time_from, time_to';

async function manage(env, ctx, step, n, askStudent) {
    const menu = (msg = '') => ask(n, 'mm', `${msg}${msg ? ', ' : 'ניהול הרשאות טלפון, '}${MENU}`, {}, '1230');
    const askPhone = (action, msg) => ask(n, 'mp', msg, { student: action });
    const who = { source: 'phone', actor: ctx.entry.name, actor_phone: ctx.phone };

    if (step.stage === 'st') return menu();

    if (step.stage === 'mm') {
        if (step.value === '0') return askStudent('הקישו קוד תלמיד וסולמית, או כוכבית ליציאה');
        const action = { 1: 'add', 2: 'del', 3: 'chk' }[step.value];
        if (!action) return menu('הקשה שגויה');
        return askPhone(action, 'הקישו את מספר הטלפון וסולמית');
    }

    const action = step.student;
    const target = normalizePhone(step.stage === 'mp' ? step.value : step.exam);
    if (!validPhone(target)) return askPhone(action, 'מספר לא תקין, הקישו את מספר הטלפון שנית וסולמית');
    const entry = await env.DB.prepare(`SELECT ${COLS} FROM phone_numbers WHERE phone = ?`).bind(target).first();
    const now = getLocalTime();

    // בדיקת מצב
    if (action === 'chk') {
        let st;
        if (!entry) st = 'לא נמצא ברשימה';
        else if (!entry.active) st = 'מושבת';
        else if (isExpired(entry, now)) st = 'תוקף ההרשאה שלו הסתיים';
        else if (!entry.valid_until) st = 'פעיל ללא הגבלת זמן';
        else {
            const left = (Date.parse(entry.valid_until.replace(' ', 'T') + 'Z') - Date.parse(now.replace(' ', 'T') + 'Z')) / 86400000;
            st = left < 1 ? `פעיל עד היום בשעה.z-T${entry.valid_until.slice(11, 16)}.t-` : `פעיל, בתוקף עוד ${Math.ceil(left)} ימים`;
        }
        return menu(`המספר${sayPhone(target)}${st}`);
    }

    // לא משנים בטלפון את המספר של עצמכם או מספר עם הרשאות מיוחדות
    if (target === ctx.phone) return menu('לא ניתן לשנות בטלפון את ההרשאה של המספר שלכם');
    if (entry && (entry.can_manage || entry.can_override)) return menu('למספר זה יש הרשאות מיוחדות, ניתן לשנות אותו רק דרך האתר');

    if (action === 'add') {
        if (step.stage === 'mp') return ask(n, 'md', `המספר${sayPhone(target)}${entry ? 'כבר ברשימה, ' : ''}לבחירת תוקף ההרשאה, ליום הקישו 1, לשבוע 2, לחודש 3, לשנה 4, ללא הגבלת זמן 5`, { student: 'add', exam: target }, '12345');
        const dur = DURATIONS[step.value];
        if (!dur) return ask(n, 'md', 'הקשה שגויה, ליום הקישו 1, לשבוע 2, לחודש 3, לשנה 4, ללא הגבלת זמן 5', { student: 'add', exam: target }, '12345');
        const until = dur[1] ? addTime(now, dur[1]) : null;
        if (entry) {
            const after = { ...entry, active: 1, valid_until: until };
            await env.DB.prepare('UPDATE phone_numbers SET active = 1, valid_until = ?, updated_at = ? WHERE id = ?').bind(until, now, entry.id).run();
            await audit(env, { ...who, action: 'extend', phone: target, name: entry.name, details: describeChange(entry, after) });
        } else {
            const name = `נוסף בטלפון ע"י ${ctx.entry.name}`;
            const d = { phone: target, name, active: 1, can_override: 0, can_manage: 0, valid_until: until, sched_enabled: 0 };
            await env.DB.prepare(`INSERT INTO phone_numbers (phone, name, active, can_override, can_manage, valid_until, sched_enabled, created_at, updated_at) VALUES (?, ?, 1, 0, 0, ?, 0, ?, ?)`)
                .bind(target, name, until, now, now).run();
            await audit(env, { ...who, action: 'add', phone: target, name, details: describeChange(null, d) });
        }
        return menu(`ההרשאה למספר${sayPhone(target)}נשמרה ${dur[1] ? 'ל' : ''}${dur[0]}`);
    }

    if (action === 'del') {
        if (!entry) return menu(`המספר${sayPhone(target)}לא נמצא ברשימה`);
        if (!entry.active) return menu(`ההרשאה למספר${sayPhone(target)}כבר מבוטלת`);
        if (step.stage === 'mp') return ask(n, 'mc', `לביטול ההרשאה של ${entry.name}, מספר${sayPhone(target)}הקישו 1, לחזרה הקישו 2`, { student: 'del', exam: target }, true);
        if (step.value !== '1') return menu();
        await env.DB.prepare('UPDATE phone_numbers SET active = 0, updated_at = ? WHERE id = ?').bind(now, entry.id).run();
        await audit(env, { ...who, action: 'disable', phone: target, name: entry.name, details: 'מצב: פעיל ← מושבת' });
        return menu(`ההרשאה למספר${sayPhone(target)}בוטלה`);
    }
    return menu();
}
