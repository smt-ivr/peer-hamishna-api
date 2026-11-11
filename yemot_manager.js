import { getLocalTime } from './time.js';
import { phoneGate, logUpdate, loadSettings, normalizePhone, validPhone, isExpired, checkPin, writeLog, say } from './phone_access.js';
import { audit, describeChange } from './phone_audit.js';

// ============================================================
//  yemot_manager.js — קו עדכון הציונים (ימות המשיח)
//
//  כל שאלה נשמרת בפרמטר ששמו מכיל את השלב ואת ההקשר:  p{מספר}_{שלב}_{תלמיד}_{מבחן}
//  ימות המשיח מחזיר את כל הפרמטרים שנאספו; אנחנו קוראים רק את האחרון (המספר הגבוה).
//  שלבים:
//    pw  סיסמה (רק למספר שהוגדרה לו סיסמה, ורק אחרי שעבר את בדיקת ההרשאה/שעות/תוקף). 3 ניסיונות
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
//    ms  קוד תלמיד לניהול הטלפונים שלו     mz  תפריט טלפוני התלמיד: 1 שמיעה, 2 הוספה, 3 הסרה, 0 חזרה
//    ma  טלפון להוספה לתלמיד              mr  בחירת טלפון להסרה
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

// מה המבחן — בקצרה ובלי דפים / פרקים (תווים כמו נקודה וגרש תוקעים את ימות המשיח)
function examLabel(exam) {
    const type = exam.exam_type === 'gemara' ? 'בגמרא' : exam.exam_type === 'mishnayot' ? 'במשניות' : '';
    return [type, say(exam.masechet)].filter(Boolean).join(' ');
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

    // --- סיסמה: נבדקת בכל שלב (אחת מהסיסמאות שהוקשו בשיחה חייבת להיות נכונה) ---
    const WELCOME = 'ברוכים הבאים למערכת עדכון המבחנים, הקישו קוד תלמיד וסולמית, או כוכבית ליציאה';
    if (ctx.entry && ctx.entry.pin_hash) {
        const tries = [...url.searchParams.entries()].filter(([k]) => /^p\d+_pw_/.test(k)).map(([, v]) => String(v || '').trim());
        let ok = false;
        for (const t of tries) if (await checkPin(t, ctx.entry.pin_hash)) { ok = true; break; }
        if (!ok) {
            if (!step) return ask(n, 'pw', 'הקישו סיסמה וסולמית');
            if (step.stage === 'pw' && step.value === '*') return text('go_to_folder=hangup');
            if (tries.length >= 3) {
                await writeLog(env, { event: 'call', phone: ctx.phone, call_id: ctx.call_id, number_id: ctx.entry.id, number_name: ctx.entry.name, reason: 'bad_pin', action: 'hangup' });
                return text('id_list_message=t-הסיסמה שגויה, השיחה תסתיים&go_to_folder=hangup');
            }
            return ask(n, 'pw', 'הסיסמה שגויה, הקישו סיסמה שנית וסולמית');
        }
        if (step && step.stage === 'pw') return askStudent(WELCOME);
    }

    // --- תחילת שיחה ---
    if (!step) return askStudent(WELCOME);
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
    const name = say(fullName(student));     // להקראה בלבד
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
    const askPass = (msg = '') => ask(n, 'ps', `${msg}מבחן ${examCode}${examLabel(exam) ? `, ${examLabel(exam)}` : ''}, עבר הקישו 1, לא עבר הקישו 2`, { student: studentCode, exam: examCode }, true);

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
const MENU = 'להוספה או הארכה של הרשאה למספר הקישו 1, לביטול הרשאה של מספר הקישו 2, לבדיקת מצב של מספר הקישו 3, לניהול טלפונים של תלמיד הקישו 4, לחזרה לעדכון ציונים הקישו 0';
const DURATIONS = { 1: ['יום', d => d.setUTCDate(d.getUTCDate() + 1)], 2: ['שבוע', d => d.setUTCDate(d.getUTCDate() + 7)], 3: ['חודש', d => d.setUTCMonth(d.getUTCMonth() + 1)],
                    4: ['שנה', d => d.setUTCFullYear(d.getUTCFullYear() + 1)], 5: ['ללא הגבלת זמן', null] };
function addTime(local, fn) {
    const d = new Date(local.replace(' ', 'T') + 'Z'); fn(d);
    return d.toISOString().slice(0, 16).replace('T', ' ');
}
const COLS = 'id, phone, name, active, can_override, can_manage, valid_until, sched_enabled, days, time_from, time_to';

async function manage(env, ctx, step, n, askStudent) {
    const menu = (msg = '') => ask(n, 'mm', `${msg}${msg ? ', ' : 'ניהול הרשאות טלפון, '}${MENU}`, {}, '12340');
    const askPhone = (action, msg) => ask(n, 'mp', msg, { student: action });
    const who = { source: 'phone', actor: ctx.entry.name, actor_phone: ctx.phone };

    if (step.stage === 'st') return menu();

    if (step.stage === 'mm') {
        if (step.value === '0') return askStudent('הקישו קוד תלמיד וסולמית, או כוכבית ליציאה');
        if (step.value === '4') return ask(n, 'ms', 'הקישו קוד תלמיד וסולמית', { student: 'sp' });
        const action = { 1: 'add', 2: 'del', 3: 'chk' }[step.value];
        if (!action) return menu('הקשה שגויה');
        return askPhone(action, 'הקישו את מספר הטלפון וסולמית');
    }

    if (['ms', 'mz', 'ma', 'mr'].includes(step.stage)) return studentPhones(env, step, n, menu, who);

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
        if (step.stage === 'mp') return ask(n, 'mc', `לביטול ההרשאה של ${say(entry.name)}, מספר${sayPhone(target)}הקישו 1, לחזרה הקישו 2`, { student: 'del', exam: target }, true);
        if (step.value !== '1') return menu();
        await env.DB.prepare('UPDATE phone_numbers SET active = 0, updated_at = ? WHERE id = ?').bind(now, entry.id).run();
        await audit(env, { ...who, action: 'disable', phone: target, name: entry.name, details: 'מצב: פעיל ← מושבת' });
        return menu(`ההרשאה למספר${sayPhone(target)}בוטלה`);
    }
    return menu();
}

// ============================================================
//  ניהול הטלפונים של תלמיד (מתוך תפריט הניהול, 4)
// ============================================================
const stuPhones = s => { try { const p = typeof s.phones === 'string' ? JSON.parse(s.phones) : s.phones; return (Array.isArray(p) ? p : []).map(normalizePhone).filter(Boolean); } catch (e) { return []; } };
const listSpoken = list => list.map((p, i) => `טלפון ${i + 1}${sayPhone(p)}`).join('');

async function studentPhones(env, step, n, menu, who) {
    const code = step.stage === 'ms' ? step.value : step.exam;
    const student = code ? await env.DB.prepare('SELECT * FROM students WHERE student_code = ? AND is_deleted = 0').bind(code).first() : null;
    if (!student) return ask(n, 'ms', 'קוד תלמיד שגוי, הקישו קוד תלמיד שנית וסולמית', { student: 'sp' });
    const name = fullName(student), phones = stuPhones(student);
    const sub = (msg = '') => ask(n, 'mz', `${msg}${msg ? ', ' : ''}${say(name)}, ${phones.length ? `רשומים ${phones.length} טלפונים` : 'אין טלפונים רשומים'}, לשמיעת הטלפונים הקישו 1, להוספת טלפון הקישו 2, להסרת טלפון הקישו 3, לחזרה לתפריט הניהול הקישו 0`,
        { student: 'sp', exam: code }, '1230');
    const save = async (list, action, ph, details) => {
        await env.DB.prepare('UPDATE students SET phones = ? WHERE student_code = ?').bind(JSON.stringify(list), code).run();
        await audit(env, { ...who, action, phone: ph, name: `${name} (${code})`, details });
        phones.splice(0, phones.length, ...list);
    };

    if (step.stage === 'ms') return sub();
    if (step.stage === 'mz') {
        if (step.value === '0') return menu();
        if (step.value === '1') return sub(phones.length ? listSpoken(phones) : 'אין טלפונים רשומים');
        if (step.value === '2') {
            if (phones.length >= 5) return sub('לתלמיד כבר רשומים 5 טלפונים, הסירו טלפון לפני הוספה');
            return ask(n, 'ma', 'הקישו את מספר הטלפון להוספה וסולמית', { student: 'sp', exam: code });
        }
        if (step.value === '3') {
            if (!phones.length) return sub('אין טלפונים להסרה');
            const digits = phones.map((_, i) => String(i + 1)).join('');
            return ask(n, 'mr', `${phones.map((p, i) => `להסרת${sayPhone(p)}הקישו ${i + 1}`).join(', ')}, לחזרה הקישו 0`, { student: 'sp', exam: code }, digits + '0');
        }
        return sub('הקשה שגויה');
    }
    if (step.stage === 'ma') {
        const p = normalizePhone(step.value);
        if (!validPhone(p)) return ask(n, 'ma', 'מספר לא תקין, הקישו את מספר הטלפון שנית וסולמית', { student: 'sp', exam: code });
        if (phones.includes(p)) return sub(`המספר${sayPhone(p)}כבר רשום לתלמיד`);
        if (phones.length >= 5) return sub('לתלמיד כבר רשומים 5 טלפונים');
        await save([...phones, p], 'student_phone_add', p, `טלפון נוסף לתלמיד: ${p}`);
        return sub(`המספר${sayPhone(p)}נוסף`);
    }
    if (step.stage === 'mr') {
        const i = parseInt(step.value, 10) - 1;
        if (step.value === '0' || !(i >= 0 && i < phones.length)) return sub();
        const p = phones[i];
        await save(phones.filter((_, k) => k !== i), 'student_phone_remove', p, `טלפון הוסר מהתלמיד: ${p}`);
        return sub(`המספר${sayPhone(p)}הוסר`);
    }
    return menu();
}
