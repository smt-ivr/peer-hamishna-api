-- ============================================================
--  הרשאות טלפון (ימות המשיח): הגדרות קווים, רשימה לבנה, יומן שיחות
--  הרצה: npx wrangler d1 execute peer --remote --file=migrations/0002_phone_access.sql
-- ============================================================

-- הגדרות הקווים (שורה אחת, JSON). אם אין שורה — כל הקווים פתוחים כמו קודם.
CREATE TABLE IF NOT EXISTS phone_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings TEXT NOT NULL,
    updated_at TEXT,
    updated_by TEXT
);

-- מספרים מורשים (רשימה לבנה)
CREATE TABLE IF NOT EXISTS phone_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,          -- מנורמל: ספרות בלבד, מתחיל ב-0 (0501234567)
    name TEXT NOT NULL,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    lines TEXT NOT NULL DEFAULT 'manager',   -- 'manager' / 'student' / 'manager,student'
    sched_enabled INTEGER NOT NULL DEFAULT 0, -- 0 = בכל שעה, 1 = רק בימים ובשעות שלמטה
    days TEXT NOT NULL DEFAULT '0,1,2,3,4,5', -- 0 = ראשון ... 6 = שבת
    time_from TEXT NOT NULL DEFAULT '00:00',
    time_to TEXT NOT NULL DEFAULT '23:59',
    valid_from TEXT,                      -- YYYY-MM-DD (רשות)
    valid_until TEXT,                     -- YYYY-MM-DD (רשות, כולל היום הזה)
    created_at TEXT,
    updated_at TEXT
);

-- יומן: כל שיחה (אושרה / נחסמה) + כל עדכון ציון שבוצע בטלפון
CREATE TABLE IF NOT EXISTS phone_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,             -- שעון ישראל
    call_id TEXT,                         -- ApiCallId של ימות המשיח
    line TEXT NOT NULL,                   -- manager / student
    event TEXT NOT NULL,                  -- call / update
    phone TEXT,
    number_id INTEGER,
    number_name TEXT,
    reason TEXT,                          -- ok_open / ok_listed / not_listed / no_caller_id / inactive / expired / not_yet / line_not_allowed / number_hours / out_of_hours / line_off
    action TEXT,                          -- continue / hangup / goto:/path
    student_code TEXT,
    student_name TEXT,
    exam_code TEXT,
    passed INTEGER
);
CREATE INDEX IF NOT EXISTS idx_phone_log_created ON phone_log (created_at);
CREATE INDEX IF NOT EXISTS idx_phone_log_call ON phone_log (call_id);
CREATE INDEX IF NOT EXISTS idx_phone_log_phone ON phone_log (phone);
