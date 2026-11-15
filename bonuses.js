import { getLocalTime } from './time.js';

// ============================================================
//  bonuses.js — בונוס כסף לתלמיד
//  הסכום נכנס לסכום הכסף של התלמיד בכל מקום (דוח, טלפון, אקסל...), בלי לכתוב שזה בונוס.
//  רק בניהול תלמידים רואים שזה בונוס. show_in_report = 1 → בדוח יופיע "כולל בונוס".
//  GET    /peer/api/bonuses?student_code=   רשימת הבונוסים של התלמיד
//  POST   /peer/api/bonuses                 { student_code, amount, note, show_in_report }
//  PUT    /peer/api/bonuses?id=             { show_in_report }
//  DELETE /peer/api/bonuses?id=             (יורד מכל המקומות)
//  הטבלה נוצרת אוטומטית בפעם הראשונה (אין צורך במיגרציה ידנית).
// ============================================================

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const bad = message => json({ error: 'Validation failed', message }, 400);

export const ensureBonusTable = env => env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_bonuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_code TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    created_at TEXT,
    created_by TEXT
)`).run()
    .then(() => env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_bonus_student ON student_bonuses (student_code)').run())
    .then(() => env.DB.prepare('ALTER TABLE student_bonuses ADD COLUMN show_in_report INTEGER NOT NULL DEFAULT 0').run().catch(() => {}));   // כבר קיים — בסדר

// סכום הבונוסים לכל תלמיד: { total, visible }. אם הטבלה עוד לא קיימת — ריק
export async function bonusTotals(env, studentCode = null) {
    const map = new Map();
    try {
        const q = `SELECT student_code, SUM(amount) AS total, SUM(CASE WHEN show_in_report = 1 THEN amount ELSE 0 END) AS visible FROM student_bonuses ${studentCode ? 'WHERE student_code = ?' : ''} GROUP BY student_code`;
        const st = env.DB.prepare(q);
        const r = await (studentCode ? st.bind(studentCode) : st).all();
        (r.results || []).forEach(x => map.set(x.student_code, { total: Number(x.total) || 0, visible: Number(x.visible) || 0 }));
    } catch (e) {
        // עמודת show_in_report עוד לא נוספה — סוכמים בלעדיה
        try {
            const r = await env.DB.prepare('SELECT student_code, SUM(amount) AS total FROM student_bonuses GROUP BY student_code').all();
            (r.results || []).forEach(x => map.set(x.student_code, { total: Number(x.total) || 0, visible: 0 }));
        } catch (e2) { /* אין טבלה */ }
    }
    return map;
}

async function who(request, env) {
    const key = request.headers.get('x-api-key') || new URL(request.url).searchParams.get('api_key');
    const ip = request.headers.get('cf-connecting-ip') || '';
    const row = key ? await env.DB.prepare("SELECT description FROM auth_rules WHERE rule_type = 'password' AND rule_value = ?").bind(key).first() : null;
    return (row && row.description) || ip || null;
}

export default async function bonusesHandler(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    try {
        await ensureBonusTable(env);

        if (method === 'GET') {
            const code = url.searchParams.get('student_code');
            if (!code) return bad('חסר קוד תלמיד');
            const { results } = await env.DB.prepare('SELECT id, amount, note, show_in_report, created_at, created_by FROM student_bonuses WHERE student_code = ? ORDER BY id DESC').bind(code).all();
            return json({ rows: results, total: results.reduce((a, r) => a + (Number(r.amount) || 0), 0) });
        }

        if (method === 'POST') {
            const b = await request.json().catch(() => ({}));
            const code = String(b.student_code || '').trim();
            const amount = Math.round(Number(b.amount) * 100) / 100;
            const note = String(b.note || '').trim().slice(0, 120) || null;
            if (!code) return bad('חסר קוד תלמיד');
            if (!isFinite(amount) || amount === 0) return bad('יש להזין סכום');
            if (Math.abs(amount) > 100000) return bad('הסכום גדול מדי');
            const st = await env.DB.prepare('SELECT 1 FROM students WHERE student_code = ? AND is_deleted = 0').bind(code).first();
            if (!st) return bad('התלמיד לא נמצא');
            const r = await env.DB.prepare('INSERT INTO student_bonuses (student_code, amount, note, show_in_report, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
                .bind(code, amount, note, b.show_in_report ? 1 : 0, getLocalTime(), await who(request, env)).run();
            return json({ success: true, id: r.meta && r.meta.last_row_id }, 201);
        }

        if (method === 'PUT') {
            const id = parseInt(url.searchParams.get('id'), 10);
            if (isNaN(id)) return bad('חסר מזהה');
            const b = await request.json().catch(() => ({}));
            await env.DB.prepare('UPDATE student_bonuses SET show_in_report = ? WHERE id = ?').bind(b.show_in_report ? 1 : 0, id).run();
            return json({ success: true });
        }

        if (method === 'DELETE') {
            const id = parseInt(url.searchParams.get('id'), 10);
            if (isNaN(id)) return bad('חסר מזהה');
            await env.DB.prepare('DELETE FROM student_bonuses WHERE id = ?').bind(id).run();
            return json({ success: true });
        }

        return json({ error: 'Method Not Allowed' }, 405);
    } catch (error) {
        return json({ error: 'Server Error', message: error.message }, 500);
    }
}
