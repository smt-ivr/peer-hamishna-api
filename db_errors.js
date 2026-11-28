// ============================================================
//  db_errors.js — זיהוי תקלה במסד הנתונים (כמו מכסת קריאות יומית שהסתיימה ב-Cloudflare)
//  והודעה ברורה: באתר, ובטלפון (בלי נקודות ומירכאות, כדי שימות המשיח יקריא בלי להיתקע)
// ============================================================

export const isLimitError = e => /exceed|quota|limit|too many/i.test(String((e && e.message) || e || '')) && !/syntax/i.test(String((e && e.message) || ''));

// המכסה מתאפסת בחצות UTC — מחזיר את השעה בישראל (2 בחורף, 3 בקיץ)
export function resetHour() {
    const n = new Date();
    const next = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1));
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(next));
}

export function phoneErrorText(e) {
    return isLimitError(e)
        ? `המערכת אינה זמינה כרגע, מכסת השימוש היומית במסד הנתונים הסתיימה, השירות יחזור לפעול בשעה ${resetHour()} בלילה`
        : 'אירעה תקלה זמנית במערכת, נסו שוב מאוחר יותר';
}

export function webError(e) {
    if (isLimitError(e)) return { status: 503, body: { error: 'DB_LIMIT', message: `מכסת הקריאות היומית של מסד הנתונים (Cloudflare) הסתיימה, ולכן המערכת לא זמינה כרגע. היא תחזור לעבוד לבד בשעה ${String(resetHour()).padStart(2, '0')}:00 בלילה. הנתונים לא נפגעו.`, detail: String(e && e.message || e) } };
    return { status: 500, body: { error: String(e && e.message || e) } };
}
