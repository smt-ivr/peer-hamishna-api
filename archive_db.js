// ============================================================
//  archive_db.js — צפייה במחזור שנסגר (בקשות עם הכותרת x-cycle).
//  כל השאילתות של המערכת רצות כרגיל, רק שהטבלאות student_exams / student_bonuses / exams
//  מוחלפות בתצוגות (VIEW) של הנתונים השמורים של אותו מחזור. כל פעולת כתיבה לא עושה כלום.
// ============================================================

const MAP = {
    student_exams: id => `SELECT id, student_code, exam_code, passed, updated_at, update_source, source_identifier FROM cycle_student_exams WHERE cycle_id = ${id}`,
    student_bonuses: id => `SELECT id, student_code, amount, note, created_at, created_by, show_in_report FROM cycle_student_bonuses WHERE cycle_id = ${id}`,
    exams: id => `SELECT id, exam_code, masechet, chapter_num, chapter_name, chapter_title, from_page, to_page, total_mishnayot, gemara_pages, target_grade, is_deleted, created_at, exam_type FROM cycle_exams WHERE cycle_id = ${id}`
};
const RE = new RegExp(`\\b(${Object.keys(MAP).join('|')})\\b`, 'g');
const READ = /^\s*(SELECT|WITH|PRAGMA)\b/i;
const made = new Set();

export async function archiveDB(DB, cycleId) {
    const id = Number(cycleId);
    if (!made.has(id)) {
        await DB.batch(Object.entries(MAP).map(([t, sql]) => DB.prepare(`CREATE VIEW IF NOT EXISTS cy${id}_${t} AS ${sql(id)}`)));
        made.add(id);
    }
    const noop = () => {
        const st = DB.prepare('SELECT 0 WHERE 0');
        st.bind = () => st;                       // פעולת כתיבה במחזור סגור: לא עושה כלום
        return st;
    };
    return {
        prepare: sql => READ.test(sql) ? DB.prepare(sql.replace(RE, t => `cy${id}_${t}`)) : noop(),
        batch: list => DB.batch(list),
        exec: () => Promise.resolve({ count: 0 }),
        dump: () => DB.dump()
    };
}
