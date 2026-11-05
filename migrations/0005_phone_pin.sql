-- סיסמה לטלפון (רשות). נשמרת כ-salt:sha256 — לא ניתנת לשחזור
ALTER TABLE phone_numbers ADD COLUMN pin_hash TEXT;
