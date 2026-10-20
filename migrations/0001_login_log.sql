-- היסטוריית כניסות (מוצלחות ונכשלות) — נרשמת ע"י auth_login.js, מוצגת למנהל-על
CREATE TABLE IF NOT EXISTS login_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,          -- YYYY-MM-DD HH:MM:SS (שעון ישראל)
    success INTEGER NOT NULL,          -- 1 הצליח, 0 נכשל
    mode TEXT,                         -- 'manual' הקלדת סיסמה | 'auto' כניסה אוטומטית (IP / סיסמה שמורה)
    method TEXT,                       -- 'password' | 'ip' | NULL כשנכשל
    access_level TEXT,
    rule_description TEXT,             -- התיאור של ההרשאה שזוהתה (לא הסיסמה עצמה)
    key_length INTEGER,                -- אורך הסיסמה שהוקלדה (הסיסמה עצמה לא נשמרת)
    ip TEXT,
    country TEXT,
    city TEXT,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_log_created ON login_log (created_at);
CREATE INDEX IF NOT EXISTS idx_login_log_ip ON login_log (ip);
