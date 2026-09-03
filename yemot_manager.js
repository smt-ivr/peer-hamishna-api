import { getLocalTime } from './time.js';

// פונקציית עזר לחישוב והשוואת כיתות
function getGradeValue(gradeStr) {
  if (!gradeStr) return 0;
  // ניקוי המילה "כיתה" וגרשיים כדי להשאיר רק את האות
  const cleanGrade = String(gradeStr).replace(/כיתה/g, '').replace(/['"']/g, '').trim();
  
  const gradesMap = {
    'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6,
    'ז': 7, 'ח': 8, 'ט': 9, 'י': 10, 'יא': 11, 'יב': 12
  };
  
  const num = parseInt(cleanGrade, 10);
  if (!isNaN(num)) return num; // במקרה שהכיתה הוזנה כמספר
  return gradesMap[cleanGrade] || 0;
}

export async function handleYemotManager(request, env) {
    const url = new URL(request.url);
    
    // שליפת פרמטרים שנאספו על ידי מערכת ימות המשיח
    const studentCode = url.searchParams.get('student_code');
    const examInput = url.searchParams.get('exam_input');
    const passInput = url.searchParams.get('pass_input');
    const apiPhone = url.searchParams.get('ApiPhone'); // קליטת מספר הטלפון מימות המשיח
    
    // חסימה אם אין זיהוי טלפון
    if (!apiPhone) {
        return new Response("read=t-שגיאה, לא ניתן לעדכן מבחן ללא זיהוי מספר הטלפון המעדכן=error,,,,,NO,,,,,,,,,no", { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // שלב 1: בקשת קוד תלמיד (אם טרם הוקלד)
    if (!studentCode) {
        return new Response("read=t-ברוכים הבאים למערכת עדכון המבחנים, אנא הקישו קוד תלמיד וסולמית=student_code,,,,,NO,,,,,,,,,no", { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // אימות קיום התלמיד במסד הנתונים
    const student = await env.DB.prepare("SELECT * FROM students WHERE student_code = ? AND is_deleted = 0").bind(studentCode).first();
    if (!student) {
        return new Response("read=t-קוד תלמיד שגוי, אנא הקישו קוד תלמיד שנית=student_code,,,,,NO,,,,,,,,,no", { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // שלב 2: קבלת קוד המבחן (לדוגמה: 12*1 למבחן 12א)
    if (!examInput) {
        return new Response(`read=t-שלום ${student.first_name} ${student.last_name}, הקישו את מספר המבחן כוכבית ואז 1 לאות אלף או 2 לאות בית ולסיום סולמית=exam_input,,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // פענוח קוד המבחן מהפורמט הטלפוני לפורמט של מסד הנתונים
    const parts = examInput.split('*');
    if (parts.length !== 2 || (parts[1] !== '1' && parts[1] !== '2')) {
        return new Response(`read=t-הקשה שגויה, הקפידו להקיש מספר מבחן כוכבית ואז את הספרה 1 או 2=exam_input,,,,,NO,,,,,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }
    
    const letter = parts[1] === '1' ? 'א' : 'ב';
    const examCode = `${parts[0]}${letter}`;

    // שלב 3: בדיקת המבחן, הקראת פרטיו וקליטת ציון
    if (!passInput) {
        // בדיקה האם המבחן עצמו קיים במערכת
        const exam = await env.DB.prepare("SELECT * FROM exams WHERE exam_code = ? AND is_deleted = 0").bind(examCode).first();
        if (!exam) {
            return new Response(`read=t-מבחן מספר ${examCode} לא נמצא, אנא הקישו שוב=exam_input,,,,,NO,,,,,,,,,no`, { 
                headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
            });
        }

        // אכיפת כיתת יעד מול כיתת התלמיד
        if (exam.target_grade && student.class_grade) {
            const studentGradeVal = getGradeValue(student.class_grade);
            const targetGradeVal = getGradeValue(exam.target_grade);
            
            if (studentGradeVal > 0 && targetGradeVal > 0 && studentGradeVal < targetGradeVal) {
                return new Response(`id_list_message=t-שגיאה, המבחן מיועד לכיתה ${exam.target_grade} ומעלה. תלמיד זה אינו מורשה להיבחן בו.&go_to_folder=/`, { 
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
                });
            }
        }

        // מניעת דריסה: בדיקה אם לתלמיד כבר יש תוצאה למבחן זה
        const existingResult = await env.DB.prepare("SELECT * FROM student_exams WHERE student_code = ? AND exam_code = ?").bind(studentCode, examCode).first();
        if (existingResult) {
            return new Response(`id_list_message=t-שימו לב למבחן ${examCode} כבר קיים ציון במערכת לא ניתן לעדכן שוב דרך הטלפון&go_to_folder=/`, { 
                headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
            });
        }

        // בנייה דינמית של משפט פרטי המבחן
        let examDetails = `מבחן ${examCode}, `;
        if (exam.masechet) examDetails += `מסכת ${exam.masechet}, `;
        if (exam.chapter_num) examDetails += `פרק ${exam.chapter_num}, `;
        if (exam.chapter_name) examDetails += `${exam.chapter_name}, `;
        if (exam.from_page && exam.to_page) examDetails += `מ ${exam.from_page} עד ${exam.to_page}, `;

        // בקשת הציון עצמו (1 = עבר, 2 = לא עבר) לאחר הקראת הפרטים
        return new Response(`read=t-${examDetails} לעדכון שעבר הקישו 1, לא עבר הקישו 2=pass_input,,1,,,NO,,,,12,,,,,no`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // שלב 4: שמירת הנתונים במסד עם ציון מקור העדכון
    try {
        const passedValue = passInput === '1' ? 1 : 2;
        const currentTime = getLocalTime(); 

        await env.DB.prepare(`
            INSERT INTO student_exams (student_code, exam_code, passed, updated_at, update_source, source_identifier)
            VALUES (?, ?, ?, ?, 'phone', ?)
        `).bind(studentCode, examCode, passedValue, currentTime, apiPhone).run();

        return new Response(`id_list_message=t-הציון למבחן ${examCode} עבור התלמיד ${student.first_name} ${student.last_name} עודכן בהצלחה&go_to_folder=/`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    } catch (error) {
        return new Response(`id_list_message=t-אירעה שגיאה בשמירת הנתונים&go_to_folder=/`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }
}
