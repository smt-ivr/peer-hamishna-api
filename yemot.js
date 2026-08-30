import { getCurrentIsraelTime, isSaturday, getWeekRange, getSetting } from './utils.js';
import { handleSendEmail } from './email.js';
import { getWeeklyHebrewInfo } from './reports.js';

async function getHebrewDateString(dateString) {
    try {
        const { start } = getWeekRange(dateString);
        const { parasha } = await getWeeklyHebrewInfo(start);
        
        const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
        const dayName = days[new Date(dateString).getDay()];
        
        let resText = parasha ? `יום ${dayName} ${parasha}` : `יום ${dayName}`;
        // מסירים נקודות מהתאריך במידה ויש
        return resText.replace(/\./g, '').replace(/-/g, ' '); 
    } catch (error) {
        return ""; 
    }
}

function calculateCustomDate(currentDateStr, customInput) {
    const now = new Date(currentDateStr);
    if (customInput === '1') now.setDate(now.getDate() - 1);
    else if (customInput === '2') now.setDate(now.getDate() - 2);
    else if (customInput.length === 4) {
        const day = parseInt(customInput.substring(0, 2), 10);
        const month = parseInt(customInput.substring(2, 4), 10);
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
            now.setMonth(month - 1);
            now.setDate(day);
        } else return null;
    } else return null;
    
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getLatestInput(url, prefix) {
    let maxIndex = 0;
    let latestValue = null;
    for (const [key, value] of url.searchParams.entries()) {
        if (key.startsWith(prefix)) {
            const idx = parseInt(key.replace(prefix, ''), 10);
            if (idx > maxIndex) {
                maxIndex = idx;
                latestValue = value;
            }
        }
    }
    return { maxIndex, latestValue, nextIndex: maxIndex + 1 };
}

export async function handleYemot(request, env) {
    const url = new URL(request.url);
    
    const reportType = url.searchParams.get('report_type'); 
    const customDateInput = url.searchParams.get('custom_date_input'); 
    const finalReportType = url.searchParams.get('final_report_type'); 
    
    const current = getCurrentIsraelTime();
    
    if (reportType === '0') {
        const email = url.searchParams.get('email');
        if (!email) {
            return new Response("id_list_message=t-כתובת אימייל לא חוקית&", { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        try {
            await handleSendEmail(request, env);
            return new Response("id_list_message=t-האימייל נשלח בהצלחה&", { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        } catch (e) {
            return new Response("id_list_message=t-שגיאה בשליחת אימייל&", { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
    }

    let effectiveDate = current.date;

    if (reportType === '4' && customDateInput) {
        const calcDate = calculateCustomDate(current.date, customDateInput);
        if (calcDate) effectiveDate = calcDate;
        else return new Response("id_list_message=t-תאריך שגוי&", { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    
    const systemStartDate = await getSetting(env, 'system_start_date', '2000-01-01');
    if (effectiveDate < systemStartDate) {
        return new Response("id_list_message=t-המערכת טרם התחילה לפעול בתאריך זה&", { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (isSaturday(effectiveDate)) {
        return new Response("id_list_message=t-אין לימודים בשבת&", { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const actualType = (reportType === '4') ? finalReportType : reportType;

    if (!reportType) {
        const vacCheck = await env.DB.prepare("SELECT date FROM vacations WHERE date = ?").bind(current.date).first();
        const isVacation = !!vacCheck;
        const vacMsg = isVacation ? "מעודכן במערכת שאין היום לימודים, " : "";

        const dateText = await getHebrewDateString(current.date);
        const welcomeMessage = dateText 
            ? `t-${dateText}, ${vacMsg}לאיחור הקישו 1, לחיסור הקישו 2, להתנהגות הקישו 3, לתאריך אחר הקישו 4, לעדכון או ביטול חופשה הקישו 5, לשמיעת נתוני היום הקישו 6, לשליחת המייל היומי הקישו 0` 
            : `t-${vacMsg}לאיחור הקישו 1, לחיסור הקישו 2, להתנהגות הקישו 3, לתאריך אחר הקישו 4, לעדכון או ביטול חופשה הקישו 5, לשמיעת נתוני היום הקישו 6, לשליחת המייל היומי הקישו 0`;
            
        return new Response(`read=${welcomeMessage}=report_type,,1,,,NO,,,,1234560,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (reportType === '4' && !customDateInput) {
        const datePrompt = "t-הקש את התאריך המבוקש, לאתמול הקישו 1 וסולמית, לשלשום הקישו 2 וסולמית, לתאריך ספציפי הקישו 4 ספרות של יום וחודש וסולמית";
        return new Response(`read=${datePrompt}=custom_date_input,,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (reportType === '4' && customDateInput && !finalReportType) {
        const vacCheck = await env.DB.prepare("SELECT date FROM vacations WHERE date = ?").bind(effectiveDate).first();
        const isVacation = !!vacCheck;
        const vacMsg = isVacation ? "מעודכן במערכת שאין היום לימודים, " : "";

        const dateText = await getHebrewDateString(effectiveDate);
        const prompt = dateText 
            ? `t-${dateText}, ${vacMsg}לאיחור הקישו 1, לחיסור הקישו 2, להתנהגות הקישו 3, לעדכון או ביטול חופשה הקישו 5, לשמיעת נתונים הקישו 6` 
            : `t-${vacMsg}לאיחור הקישו 1, לחיסור הקישו 2, להתנהגות הקישו 3, לעדכון או ביטול חופשה הקישו 5, לשמיעת נתונים הקישו 6`;
        return new Response(`read=${prompt}=final_report_type,,1,,,NO,,,,12356,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (actualType === '5') {
        const vacCheck = await env.DB.prepare("SELECT date FROM vacations WHERE date = ?").bind(effectiveDate).first();
        if (vacCheck) {
            await env.DB.prepare("DELETE FROM vacations WHERE date = ?").bind(effectiveDate).run();
            return new Response(`id_list_message=t-בוטל יום חופשה בהצלחה לתאריך המבוקש&`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        } else {
            await env.DB.prepare("INSERT OR IGNORE INTO vacations (date) VALUES (?)").bind(effectiveDate).run();
            return new Response(`id_list_message=t-הוגדר יום חופשה בהצלחה לתאריך המבוקש&`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
    }

    if (actualType === '6') {
        const exceptionsQuery = await env.DB.prepare(`
            SELECT e.type, e.minutes, e.bad_behavior, s.first_name, s.last_name 
            FROM exceptions e
            JOIN students s ON e.student_code = s.code
            WHERE e.date = ?
        `).bind(effectiveDate).all();
        
        if (!exceptionsQuery.results || exceptionsQuery.results.length === 0) {
            return new Response(`id_list_message=t-אין נתונים מעודכנים לתאריך זה&`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        
        let absences = [];
        let latesOnly = [];
        let badOnly = [];
        let latesAndBad = [];
        let absenceAndBad = [];
        
        for (const row of exceptionsQuery.results) {
            const name = `${row.first_name} ${row.last_name}`;
            const isLate = row.type === 'late';
            const isAbsence = row.type === 'absence';
            const isBad = row.bad_behavior === 1;

            if (isAbsence && isBad) {
                absenceAndBad.push(name);
            } else if (isAbsence) {
                absences.push(name);
            } else if (isLate && isBad) {
                latesAndBad.push(`${name} ${row.minutes} דקות`);
            } else if (isLate) {
                latesOnly.push(`${name} ${row.minutes} דקות`);
            } else if (isBad) {
                badOnly.push(name);
            }
        }
        
        let msgParts = [];
        if (absences.length > 0) msgParts.push(`חיסרו: ${absences.join(', ')}`);
        if (absenceAndBad.length > 0) msgParts.push(`חיסרו וגם התנהגות לא טובה: ${absenceAndBad.join(', ')}`);
        if (latesOnly.length > 0) msgParts.push(`איחרו: ${latesOnly.join(', ')}`);
        if (latesAndBad.length > 0) msgParts.push(`איחרו ועם התנהגות לא טובה: ${latesAndBad.join(', ')}`);
        if (badOnly.length > 0) msgParts.push(`התנהגות לא טובה: ${badOnly.join(', ')}`);
        
        // חיבור כל החלקים בפסיקים, ללא נקודות
        const finalMsg = msgParts.join(', ');
        return new Response(`id_list_message=t-${finalMsg}&`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    let prefix = '';
    let dbType = '';

    if (actualType === '1') { prefix = 'late_data_'; dbType = 'late'; }
    else if (actualType === '2') { prefix = 'abs_data_'; dbType = 'absence'; }
    else if (actualType === '3') { prefix = 'beh_data_'; }
    
    if (!prefix) {
        return new Response("id_list_message=t-שגיאה בתפריט&", { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const { maxIndex, latestValue, nextIndex } = getLatestInput(url, prefix);

    if (maxIndex === 0) {
        let prompt = "";
        if (actualType === '1') prompt = "t-הקש קוד תלמיד, כוכבית, ומספר דקות איחור";
        if (actualType === '2') prompt = "t-הקש קוד תלמיד לדיווח חיסור";
        if (actualType === '3') prompt = "t-הקש קוד תלמיד לדיווח התנהגות לא טובה";

        return new Response(`read=${prompt}=${prefix}1,,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    if (latestValue === '*') {
        return new Response("go_to_folder=.&", { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    try {
        let studentCode = latestValue;
        let minutes = null;
        let isCancel = false;

        if (studentCode.endsWith('*') && actualType !== '1') {
            isCancel = true;
            studentCode = studentCode.slice(0, -1);
        } else if (actualType === '1') {
            const parts = studentCode.split('*');
            if (parts.length < 2 && !studentCode.endsWith('*')) {
                return new Response(`read=t-הקשה שגוי, הקש שוב קוד תלמיד כוכבית ודקות=${prefix}${nextIndex},,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
            }
            studentCode = parts[0];
            if (parts.length === 2 && parts[1] === '') {
                 isCancel = true;
            } else if (!isCancel) {
                minutes = parseInt(parts[1], 10);
                if (isNaN(minutes)) {
                    return new Response(`read=t-שגיאה במספר דקות, הקש שוב=${prefix}${nextIndex},,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
                }
            }
        }
        
        if (actualType === '1' && minutes === 0) isCancel = true;

        const student = await env.DB.prepare("SELECT * FROM students WHERE code = ?").bind(studentCode).first();
        if (!student) {
             return new Response(`read=t-תלמיד לא קיים, נסה שוב או הקש כוכבית לסיום=${prefix}${nextIndex},,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }

        if (actualType === '3') {
            if (isCancel) {
                await env.DB.prepare(`
                    UPDATE exceptions 
                    SET bad_behavior = 0 
                    WHERE student_code = ? AND date = ?
                `).bind(studentCode, effectiveDate).run();
                
                await env.DB.prepare(`
                    DELETE FROM exceptions 
                    WHERE student_code = ? AND date = ? AND (type IS NULL OR type = '') AND (bad_behavior IS NULL OR bad_behavior = 0)
                `).bind(studentCode, effectiveDate).run();

                return new Response(`read=t-בוטל דיווח התנהגות לתלמיד ${student.first_name} ${student.last_name}, הקש תלמיד נוסף או כוכבית לסיום=${prefix}${nextIndex},,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
            } else {
                await env.DB.prepare(`
                    INSERT INTO exceptions (student_code, date, bad_behavior) 
                    VALUES (?, ?, 1)
                    ON CONFLICT(student_code, date) 
                    DO UPDATE SET bad_behavior = 1
                `).bind(studentCode, effectiveDate).run();
                
                return new Response(`read=t-עודכנה התנהגות לא טובה לתלמיד ${student.first_name} ${student.last_name}, הקש תלמיד נוסף או כוכבית לסיום=${prefix}${nextIndex},,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
            }
        } else {
            if (isCancel) {
                await env.DB.prepare(`
                    UPDATE exceptions 
                    SET type = NULL, minutes = NULL 
                    WHERE student_code = ? AND date = ?
                `).bind(studentCode, effectiveDate).run();

                await env.DB.prepare(`
                    DELETE FROM exceptions 
                    WHERE student_code = ? AND date = ? AND (type IS NULL OR type = '') AND (bad_behavior IS NULL OR bad_behavior = 0)
                `).bind(studentCode, effectiveDate).run();

                return new Response(`read=t-בוטל דיווח נוכחות לתלמיד ${student.first_name} ${student.last_name}, הקש תלמיד נוסף או כוכבית לסיום=${prefix}${nextIndex},,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
            } else {
                await env.DB.prepare(`
                    INSERT INTO exceptions (student_code, date, type, minutes) 
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(student_code, date) 
                    DO UPDATE SET type = excluded.type, minutes = excluded.minutes
                `).bind(studentCode, effectiveDate, dbType, minutes).run();
                
                let msg = dbType === 'absence' 
                    ? `t-עודכן חיסור לתלמיד ${student.first_name} ${student.last_name}` 
                    : `t-עודכן איחור ${minutes} דקות לתלמיד ${student.first_name} ${student.last_name}`;
                
                return new Response(`read=${msg}, הקש תלמיד נוסף או כוכבית לסיום=${prefix}${nextIndex},,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
            }
        }
    } catch (error) {
        return new Response(`read=t-שגיאת מערכת, נסה שוב=${prefix}${nextIndex},,,,,NO,,,,,,,,,no`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
}
