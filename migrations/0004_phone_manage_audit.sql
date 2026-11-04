-- ניהול הרשאות בטלפון (0#) + היסטוריית שינויים בהרשאות
ALTER TABLE phone_numbers ADD COLUMN can_manage INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS phone_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL,          -- web / phone
    actor TEXT,                    -- מי ביצע (תיאור ההרשאה באתר, או שם המספר בטלפון)
    actor_phone TEXT,              -- כשבוצע מהטלפון
    action TEXT NOT NULL,          -- add / edit / delete / enable / disable / extend / settings
    phone TEXT,                    -- המספר שעליו בוצע השינוי
    name TEXT,
    details TEXT
);
CREATE INDEX IF NOT EXISTS idx_phone_audit_created ON phone_audit (created_at);
CREATE INDEX IF NOT EXISTS idx_phone_audit_phone ON phone_audit (phone);
CREATE INDEX IF NOT EXISTS idx_phone_audit_actor ON phone_audit (actor_phone);
