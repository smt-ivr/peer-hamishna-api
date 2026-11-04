-- מספרים שמורשים לשנות ציון שכבר עודכן (גם ציון שהוזן ממקום אחר)
ALTER TABLE phone_numbers ADD COLUMN can_override INTEGER NOT NULL DEFAULT 0;
