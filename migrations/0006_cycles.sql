-- מחזורים: כל מחזור נשמר במלואו (ציונים, בונוסים, ורשימת המבחנים כפי שהייתה)
-- ended_at ריק = המחזור הנוכחי. הנתונים של המחזור הנוכחי נמצאים בטבלאות הרגילות.
CREATE TABLE IF NOT EXISTS cycles ( id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, started_at TEXT, ended_at TEXT, created_by TEXT );
CREATE TABLE IF NOT EXISTS cycle_student_exams ( cycle_id INTEGER NOT NULL, id INTEGER, student_code TEXT NOT NULL, exam_code TEXT NOT NULL, passed INTEGER, updated_at TEXT, update_source TEXT, source_identifier TEXT );
CREATE INDEX IF NOT EXISTS idx_cse_cycle ON cycle_student_exams (cycle_id, student_code);
CREATE TABLE IF NOT EXISTS cycle_student_bonuses ( cycle_id INTEGER NOT NULL, id INTEGER, student_code TEXT NOT NULL, amount REAL, note TEXT, created_at TEXT, created_by TEXT, show_in_report INTEGER );
CREATE TABLE IF NOT EXISTS cycle_exams ( cycle_id INTEGER NOT NULL, id INTEGER, exam_code TEXT NOT NULL, masechet TEXT, chapter_num INTEGER, chapter_name TEXT, chapter_title TEXT, from_page TEXT, to_page TEXT, total_mishnayot INTEGER, gemara_pages TEXT, target_grade TEXT, is_deleted INTEGER, created_at TEXT, exam_type TEXT );
CREATE INDEX IF NOT EXISTS idx_ce_cycle ON cycle_exams (cycle_id, exam_code);
