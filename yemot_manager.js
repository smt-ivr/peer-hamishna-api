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

export async function handleYemotManager(request, env) {
    const url = new URL(request.url);
    const apiPhone = url.searchParams.get('ApiPhone'); 
    
    if (!apiPhone) {
        return new Response("read=t-שגיאה, לא ניתן לעדכן מבחן ללא זיהוי מספר הטלפון המעדכן=error_input,,,,,NO,,,,,,,,,no", { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // 1. איתור האינדקס הנוכחי (הגבוה ביותר) של סבב ההזנה
    let maxIndex = 1;
    for (const key of url.searchParams.keys()) {
        const match = key.match(/^(student_code_|exam_input_|pass_input_)(\d+)$/);
        if (match) {
            const idx = parseInt(match[2], 10);
            if (idx > maxIndex) maxIndex = idx;
        }
    }

    // שליפת הנתונים לפי האינדקס הנוכחי
    const studentCode = url.searchParams.get(`student_code_${maxIndex}`);
    const examInput = url.searchParams.get(`exam_input_${maxIndex}`);
    const passInput = url.searchParams.get(`pass_input_${maxIndex}`);

    // יציאה וביטול - אם הוקש כוכבית באחד השלבים
    if (studentCode === '*' || examInput === '*' || passInput === '*') {
        return new Response("go_to_folder=.&", { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // שלב א': דרישת קוד תלמיד (או התחלת סבב חדש)
    if (!studentCode) {
        const prompt = maxIndex === 1 
            ? "t-ברוכים הבאים למערכת עדכון המבחנים, אנא הקישו קוד תלמיד וסולמית, או כוכבית ליציאה"
            : "t-להזנת ציון לתלמיד נוסף הקישו קוד תלמיד וסולמית, או כוכבית ליציאה";
            
        return new Response(`read=${prompt}=student_code_${maxIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // אימות התלמיד
    const student = await env.DB.prepare("SELECT * FROM students WHERE student_code = ? AND is_deleted = 0").bind(studentCode).first();
    if (!student) {
        return new Response(`read=t-קוד תלמיד שגוי, אנא הקישו קוד תלמיד שנית=student_code_${maxIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // שלב ב': דרישת קוד מבחן
    if (!examInput) {
        return new Response(`read=t-שלום ${student.first_name} ${student.last_name}, הקישו את מספר המבחן כוכבית ואז 1 לאות אלף או 2 לאות בית ולסיום סולמית=exam_input_${maxIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // פענוח קוד המבחן
    const parts = examInput.split('*');
    if (parts.length !== 2 || (parts[1] !== '1' && parts[1] !== '2')) {
        return new Response(`read=t-הקשה שגויה, הקפידו להקיש מספר מבחן כוכבית ואז את הספרה 1 או 2=exam_input_${maxIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }
    
    const letter = parts[1] === '1' ? 'א' : 'ב';
    const examCode = `${parts[0]}${letter}`;

    // שלב ג': אימות המבחן ודרישת ציון
    if (!passInput) {
        const exam = await env.DB.prepare("SELECT * FROM exams WHERE exam_code = ? AND is_deleted = 0").bind(examCode).first();
        if (!exam) {
            return new Response(`read=t-מבחן מספר ${examCode} לא נמצא, אנא הקישו שוב=exam_input_${maxIndex},,,,,NO,,,,,,,,,no`, { 
                headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
            });
        }

        // אכיפת כיתת יעד מול כיתת התלמיד
        if (exam.target_grade && student.class_grade) {
            const studentGradeVal = getGradeValue(student.class_grade);
            const targetGradeVal = getGradeValue(exam.target_grade);
            
            if (studentGradeVal > 0 && targetGradeVal > 0 && studentGradeVal < targetGradeVal) {
                return new Response(`read=t-שגיאה, המבחן מיועד לכיתה גבוהה יותר. הקישו קוד מבחן אחר=exam_input_${maxIndex},,,,,NO,,,,,,,,,no`, { 
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
                });
            }
        }

        // מניעת דריסה
        const existingResult = await env.DB.prepare("SELECT * FROM student_exams WHERE student_code = ? AND exam_code = ?").bind(studentCode, examCode).first();
        if (existingResult) {
            return new Response(`read=t-שימו לב, למבחן ${examCode} כבר קיים ציון במערכת. הקישו קוד מבחן אחר, או כוכבית ליציאה=exam_input_${maxIndex},,,,,NO,,,,,,,,,no`, { 
                headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
            });
        }

        let examDetails = `מבחן ${examCode}, `;
        if (exam.masechet) examDetails += `מסכת ${exam.masechet}, `;
        if (exam.chapter_num) examDetails += `פרק ${exam.chapter_num}, `;
        if (exam.chapter_name) examDetails += `${exam.chapter_name}, `;
        if (exam.from_page && exam.to_page) examDetails += `מ ${exam.from_page} עד ${exam.to_page}, `;

        return new Response(`read=t-${examDetails} לעדכון שעבר הקישו 1, לא עבר הקישו 2=pass_input_${maxIndex},,1,,,NO,,,,12,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // שלב ד': שמירת הנתונים ופתיחת לולאה לאינדקס הבא
    try {
        const passedValue = passInput === '1' ? 1 : 2;
        const currentTime = getLocalTime(); 

        // ON CONFLICT DO NOTHING מבטיח שלא נקרוס במקרה של ניתוק ושליחה כפולה מצד ימות המשיח
        await env.DB.prepare(`
            INSERT INTO student_exams (student_code, exam_code, passed, updated_at, update_source, source_identifier)
            VALUES (?, ?, ?, ?, 'phone', ?)
            ON CONFLICT(student_code, exam_code) DO NOTHING
        `).bind(studentCode, examCode, passedValue, currentTime, apiPhone).run();

        const nextIndex = maxIndex + 1;
        
        // מדלגים לאינדקס הבא כדי ליצור רצף הזנות ללא חזרה לתפריט הראשי
        return new Response(`read=t-הציון למבחן ${examCode} עבור ${student.first_name} ${student.last_name} עודכן בהצלחה. להזנת תלמיד נוסף הקישו קוד תלמיד, או כוכבית לסיום=student_code_${nextIndex},,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    } catch (error) {
        return new Response(`read=t-אירעה שגיאה בשמירת הנתונים. נסו שוב=pass_input_${maxIndex},,1,,,NO,,,,12,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }
}
