import { getLocalTime } from './time.js';

// פונקציית עזר לחישוב והשוואת כיתות
function getGradeValue(gradeStr) {
  if (!gradeStr) return 0;
  const cleanGrade = String(gradeStr).replace(/כיתה/g, '').replace(/['"']/g, '').trim();
  
  const gradesMap = {
    'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6,
    'ז': 7, 'ח': 8, 'ט': 9, 'י': 10, 'יא': 11, 'יב': 12
  };
  
  const num = parseInt(cleanGrade, 10);
  if (!isNaN(num)) return num; 
  return gradesMap[cleanGrade] || 0;
}

// פונקציה חכמה לזיהוי האינדקס האחרון שהוקש
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

export async function handleYemotManager(request, env) {
    const url = new URL(request.url);
    const apiPhone = url.searchParams.get('ApiPhone'); 
    
    if (!apiPhone) {
        return new Response("read=t-שגיאה, לא ניתן לעדכן מבחן ללא זיהוי מספר הטלפון המעדכן=error_input,,,,,NO,,,,,,,,,no", { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    const studentReq = getLatestInput(url, 'student_code_');
    const examReq = getLatestInput(url, 'exam_input_');
    const passReq = getLatestInput(url, 'pass_input_');

    // ביטול ואיפוס - הפנייה לאותה שלוחה מחדש מנקה את ה-URL
    if (studentReq.latestValue === '*' || examReq.latestValue === '*' || passReq.latestValue === '*') {
        return new Response("go_to_folder=.&", { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // --- שלב 1: קוד תלמיד ---
    if (studentReq.maxIndex === 0) {
        return new Response(`read=t-ברוכים הבאים למערכת עדכון המבחנים, אנא הקישו קוד תלמיד וסולמית, או כוכבית ליציאה=student_code_1,,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    const studentCode = studentReq.latestValue;
    const student = await env.DB.prepare("SELECT * FROM students WHERE student_code = ? AND is_deleted = 0").bind(studentCode).first();
    
    if (!student) {
        // במקרה של שגיאה, מבקשים את האינדקס הבא (nextIndex) כדי לא להיתקע בלולאה אינסופית
        return new Response(`read=t-קוד תלמיד שגוי, אנא הקישו קוד תלמיד שנית=student_code_${studentReq.nextIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // --- שלב 2: קוד מבחן ---
    // מבקשים מבחן רק אם תלמיד תקין, ורק אם טרם התבקש מבחן עבור איטרציית התלמיד הנוכחית
    if (examReq.maxIndex < studentReq.maxIndex) {
        return new Response(`read=t-שלום ${student.first_name} ${student.last_name}, הקישו את מספר המבחן כוכבית ואז 1 לאות אלף או 2 לאות בית ולסיום סולמית=exam_input_${studentReq.maxIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    const examInput = examReq.latestValue;
    const parts = examInput.split('*');
    if (parts.length !== 2 || (parts[1] !== '1' && parts[1] !== '2')) {
        return new Response(`read=t-הקשה שגויה, הקפידו להקיש מספר מבחן כוכבית ואז את הספרה 1 או 2=exam_input_${examReq.nextIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }
    
    const letter = parts[1] === '1' ? 'א' : 'ב';
    const examCode = `${parts[0]}${letter}`;

    const exam = await env.DB.prepare("SELECT * FROM exams WHERE exam_code = ? AND is_deleted = 0").bind(examCode).first();
    if (!exam) {
        return new Response(`read=t-מבחן מספר ${examCode} לא נמצא, אנא הקישו שוב=exam_input_${examReq.nextIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    if (exam.target_grade && student.class_grade) {
        const studentGradeVal = getGradeValue(student.class_grade);
        const targetGradeVal = getGradeValue(exam.target_grade);
        if (studentGradeVal > 0 && targetGradeVal > 0 && studentGradeVal < targetGradeVal) {
            return new Response(`read=t-שגיאה, המבחן מיועד לכיתה גבוהה יותר, הקישו קוד מבחן אחר=exam_input_${examReq.nextIndex},,,,,NO,,,,,,,,,no`, { 
                headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
            });
        }
    }

    const existingResult = await env.DB.prepare("SELECT * FROM student_exams WHERE student_code = ? AND exam_code = ?").bind(studentCode, examCode).first();
    if (existingResult) {
        return new Response(`read=t-שימו לב, למבחן ${examCode} כבר קיים ציון במערכת, הקישו קוד מבחן אחר, או כוכבית ליציאה=exam_input_${examReq.nextIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // --- שלב 3: ציון מבחן ---
    if (passReq.maxIndex < examReq.maxIndex) {
        let examDetails = `מבחן ${examCode}, `;
        if (exam.masechet) examDetails += `חלק ${exam.masechet}, `;
        if (exam.chapter_num) examDetails += `פרק ${exam.chapter_num}, `;
        if (exam.chapter_name) examDetails += `${exam.chapter_name}, `;
        if (exam.from_page && exam.to_page) examDetails += `מ ${exam.from_page} עד ${exam.to_page}, `;

        return new Response(`read=t-${examDetails} לעדכון שעבר הקישו 1, לא עבר הקישו 2=pass_input_${examReq.maxIndex},,1,,,NO,,,,12,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    const passInput = passReq.latestValue;
    if (passInput !== '1' && passInput !== '2') {
        return new Response(`read=t-הקשה שגויה, הקישו 1 או 2=pass_input_${passReq.nextIndex},,1,,,NO,,,,12,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // --- שלב 4: שמירה ורצף ---
    try {
        const passedValue = passInput === '1' ? 1 : 2;
        const currentTime = getLocalTime(); 

        await env.DB.prepare(`
            INSERT INTO student_exams (student_code, exam_code, passed, updated_at, update_source, source_identifier)
            VALUES (?, ?, ?, ?, 'phone', ?)
            ON CONFLICT(student_code, exam_code) DO NOTHING
        `).bind(studentCode, examCode, passedValue, currentTime, apiPhone).run();
        
        // מעלים אינדקס לתלמיד הבא ליצירת לולאה רציפה
        return new Response(`read=t-הציון למבחן ${examCode} עבור ${student.first_name} ${student.last_name} עודכן בהצלחה, להזנת תלמיד נוסף הקישו קוד תלמיד, או כוכבית לסיום=student_code_${studentReq.nextIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    } catch (error) {
        return new Response(`read=t-אירעה שגיאה בשמירת הנתונים, נסו שוב=pass_input_${passReq.nextIndex},,1,,,NO,,,,12,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }
}
