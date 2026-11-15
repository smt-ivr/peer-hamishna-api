import { getLocalTime } from './time.js';

// ============================================================
//  bonuses.js — בונוס כסף לתלמיד (מופיע בניהול תלמידים ובאקסל, לא בדוח התלמיד)
//  GET    /peer/api/bonuses?student_code=   רשימת הבונוסים של התלמיד
//  POST   /peer/api/bonuses                 { student_code, amount, note }
//  DELETE /peer/api/bonuses?id=
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
)`).run().then(() => env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_bonus_student ON student_bonuses (student_code)').run());

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
            const { results } = await env.DB.prepare('SELECT id, amount, note, created_at, created_by FROM student_bonuses WHERE student_code = ? ORDER BY id DESC').bind(code).all();
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
            const r = await env.DB.prepare('INSERT INTO student_bonuses (student_code, amount, note, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
                .bind(code, amount, note, getLocalTime(), await who(request, env)).run();
            return json({ success: true, id: r.meta && r.meta.last_row_id }, 201);
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
