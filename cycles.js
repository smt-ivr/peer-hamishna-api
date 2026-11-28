import { getLocalTime } from './time.js';
import { identify, SUPER_ADMIN } from './admin.js';
import { logChange } from './change_log.js';

// ============================================================
//  cycles.js — מחזורים. שום דבר לא נמחק: בסגירת מחזור הציונים, הבונוסים ורשימת המבחנים
//  מועתקים לטבלאות cycle_*, ורק אז הציונים והבונוסים מתרוקנים לקראת המחזור החדש.
//  תלמידים, מבחנים (נשארים כמו שהם — אפשר לערוך), הגדרות והרשאות לא משתנים.
//
//  GET  /peer/api/cycles                         רשימת המחזורים + כמויות
//  POST /peer/api/cycles/start  {name, closed_name?}     (הרשאה עליונה) סגירת המחזור ופתיחת חדש
//  POST /peer/api/cycles/<id>/restore-exams  {codes?: [...], replace?: bool}   (הרשאה עליונה)
//       מחזיר מבחנים כפי שהיו במחזור <id>. codes ריק = כולם. replace = מבחנים שלא היו אז יסומנו כמחוקים
// ============================================================

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const EXAM_COLS = 'exam_code, masechet, chapter_num, chapter_name, chapter_title, from_page, to_page, total_mishnayot, gemara_pages, target_grade, exam_type';

// הוספת המחזור הנוכחי לטבלה אם עוד אין (בפעם הראשונה)
async function current(env) {
    let cur = await env.DB.prepare('SELECT * FROM cycles WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').first();
    if (!cur) {
        const first = await env.DB.prepare('SELECT MIN(updated_at) AS t FROM student_exams').first();
        cur = await env.DB.prepare('INSERT INTO cycles (name, started_at) VALUES (?, ?) RETURNING *').bind('מחזור 1', (first && first.t) || getLocalTime()).first();
    }
    return cur;
}

export async function startCycle(env, { name, closed_name, actor }) {
    const cur = await current(env);
    const now = getLocalTime();
    const id = cur.id;
    // הכל באצווה אחת (D1 batch = טרנזקציה): העתקה, בדיקה, ורק אז ריקון
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO cycle_student_exams (cycle_id, id, student_code, exam_code, passed, updated_at, update_source, source_identifier)
            SELECT ?, id, student_code, exam_code, passed, updated_at, update_source, source_identifier FROM student_exams`).bind(id),
        env.DB.prepare(`INSERT INTO cycle_student_bonuses (cycle_id, id, student_code, amount, note, created_at, created_by, show_in_report)
            SELECT ?, id, student_code, amount, note, created_at, created_by, show_in_report FROM student_bonuses`).bind(id),
        env.DB.prepare(`INSERT INTO cycle_exams (cycle_id, id, ${EXAM_COLS}, is_deleted, created_at)
            SELECT ?, id, ${EXAM_COLS}, is_deleted, created_at FROM exams`).bind(id),
        env.DB.prepare('UPDATE cycles SET ended_at = ?, name = COALESCE(?, name) WHERE id = ?').bind(now, closed_name || null, id),
        env.DB.prepare(`DELETE FROM student_exams WHERE (SELECT COUNT(*) FROM cycle_student_exams WHERE cycle_id = ?) >= (SELECT COUNT(*) FROM student_exams)`).bind(id),
        env.DB.prepare(`DELETE FROM student_bonuses WHERE (SELECT COUNT(*) FROM cycle_student_bonuses WHERE cycle_id = ?) >= (SELECT COUNT(*) FROM student_bonuses)`).bind(id),
        env.DB.prepare('INSERT INTO cycles (name, started_at, created_by) VALUES (?, ?, ?)').bind(name || `מחזור ${id + 1}`, now, actor || null)
    ]);
    return id;
}

export default async function cyclesHandler(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.replace(/\/+$/, '').split('/');      // ['', 'peer', 'api', 'cycles', id?, action?]
    const sub = parts[4] || '', action = parts[5] || '';
    try {
        if (request.method === 'GET' && !sub) {
            await current(env);
            const { results } = await env.DB.prepare(`SELECT c.*,
                (SELECT COUNT(*) FROM cycle_student_exams x WHERE x.cycle_id = c.id) AS exams_rows,
                (SELECT COUNT(*) FROM cycle_student_bonuses x WHERE x.cycle_id = c.id) AS bonus_rows,
                (SELECT COUNT(*) FROM cycle_exams x WHERE x.cycle_id = c.id) AS exam_list_rows
                FROM cycles c ORDER BY c.id`).all();
            return json(results);
        }
        if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

        const { rule, clientIp } = await identify(request, env);
        if (!rule || rule.access_level !== SUPER_ADMIN) return json({ error: 'Forbidden', message: 'פעולה זו זמינה להרשאה עליונה בלבד' }, 403);
        const actor = rule.description || (rule.rule_type === 'ip' ? `IP ${clientIp}` : 'סיסמה');
        const body = await request.json().catch(() => ({}));

        if (sub === 'start') {
            const closed = await startCycle(env, { name: body.name, closed_name: body.closed_name, actor });
            await logChange(request, env, 'cycle', String(closed), 'מחזור חדש', `המחזור ${closed} נשמר ונסגר`);
            return json({ success: true, closed_cycle: closed });
        }

        if (/^\d+$/.test(sub) && action === 'restore-exams') {
            const id = +sub;
            const { results: old } = await env.DB.prepare(`SELECT ${EXAM_COLS}, is_deleted FROM cycle_exams WHERE cycle_id = ?`).bind(id).all();
            if (!old.length) return json({ error: 'Not found', message: 'אין רשימת מבחנים שמורה למחזור הזה' }, 404);
            const want = Array.isArray(body.codes) && body.codes.length ? new Set(body.codes.map(String)) : null;
            const list = old.filter(e => !want || want.has(e.exam_code));
            const cols = EXAM_COLS.split(', ');
            const stmts = list.map(e => env.DB.prepare(`INSERT INTO exams (${EXAM_COLS}, is_deleted) VALUES (${cols.map(() => '?').join(', ')}, ?)
                ON CONFLICT(exam_code) DO UPDATE SET ${cols.filter(c => c !== 'exam_code').map(c => `${c} = excluded.${c}`).join(', ')}, is_deleted = excluded.is_deleted`)
                .bind(...cols.map(c => e[c] ?? null), e.is_deleted ? 1 : 0));
            if (body.replace && !want) {
                stmts.push(env.DB.prepare(`UPDATE exams SET is_deleted = 1 WHERE exam_code NOT IN (SELECT exam_code FROM cycle_exams WHERE cycle_id = ?)`).bind(id));
            }
            if (stmts.length) await env.DB.batch(stmts);
            await logChange(request, env, 'exam', null, 'שחזור ממחזור', `מחזור ${id}: ${list.length} מבחנים${body.replace && !want ? ' (החלפה מלאה)' : ''}`);
            return json({ success: true, restored: list.length });
        }
        return json({ error: 'Not found' }, 404);
    } catch (e) {
        return json({ error: e.message }, 500);
    }
}
