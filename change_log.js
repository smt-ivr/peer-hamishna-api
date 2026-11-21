import { getLocalTime } from './time.js';
import { identify } from './admin.js';

// ============================================================
//  change_log.js — רישום שינויים במבחנים ובתלמידים (מי שינה, מתי, מה)
//  "מי" = שם ההרשאה שדרכה נכנסו לאתר (סיסמה / IP), כמו בהיסטוריית הרשאות הטלפון.
//  GET /peer/api/change-log?entity=exam|student&code=...  → 300 האחרונים
// ============================================================

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
let ready = false;
async function ensure(env) {
    if (ready) return;
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, entity TEXT NOT NULL, code TEXT,
        action TEXT NOT NULL, actor TEXT, details TEXT)`).run();
    await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log (entity, code)').run();
    ready = true;
}

export async function actorOf(request, env) {
    try {
        const { rule, clientIp } = await identify(request, env);
        if (!rule) return `IP ${clientIp}`;
        return rule.description || (rule.rule_type === 'ip' ? `IP ${clientIp}` : 'סיסמה');
    } catch (e) { return null; }
}

// רישום לא עוצר את הפעולה גם אם נכשל
export async function logChange(request, env, entity, code, action, details = '') {
    try {
        await ensure(env);
        await env.DB.prepare('INSERT INTO change_log (created_at, entity, code, action, actor, details) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(getLocalTime(), entity, code == null ? null : String(code), action, await actorOf(request, env), details || null).run();
    } catch (e) { /* ignore */ }
}

// תיאור קריא של השדות שהשתנו
export function diff(before, after, labels) {
    const out = [];
    for (const [k, label] of Object.entries(labels)) {
        const a = before ? before[k] : undefined, b = after ? after[k] : undefined;
        const s = v => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : String(v));
        const same = s(a) === s(b) || (s(a) !== '—' && s(b) !== '—' && !isNaN(s(a)) && !isNaN(s(b)) && Number(s(a)) === Number(s(b)));
        if (!same) out.push(`${label}: ${s(a)} ← ${s(b)}`);
    }
    return out.join(' · ');
}

export default async function changeLogHandler(request, env) {
    if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
    await ensure(env);
    const url = new URL(request.url);
    const entity = url.searchParams.get('entity');
    const code = url.searchParams.get('code');
    const where = [], args = [];
    if (entity) { where.push('entity = ?'); args.push(entity); }
    if (code) { where.push('code = ?'); args.push(code); }
    const { results } = await env.DB.prepare(`SELECT id, created_at, entity, code, action, actor, details FROM change_log
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 300`).bind(...args).all();
    return json(results);
}
