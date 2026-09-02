export async function handleYemotStudents(request, env) {
    const url = new URL(request.url);
    
    // שליפת קוד התלמיד מהשלוחה בימות המשיח
    const studentCode = url.searchParams.get('student_code');
    
    // שלב 1: בקשת קוד תלמיד (אם הלקוח נכנס לראשונה)
    if (!studentCode) {
        return new Response("read=t-ברוכים הבאים לאזור האישי אנא הקישו את קוד התלמיד שלכם ולסיום סולמית=student_code,,,,,NO,,,,,,,,,no", { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // שלב 2: אימות התלמיד במסד הנתונים
    const student = await env.DB.prepare("SELECT * FROM students WHERE student_code = ? AND is_deleted = 0").bind(studentCode).first();
    if (!student) {
        return new Response("read=t-קוד תלמיד שגוי אנא הקישו שוב ולסיום סולמית=student_code,,,,,NO,,,,,,,,,no", { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }

    // שלב 3: שליפת סיכום המבחנים והתגמולים
    const query = `
        SELECT 
            COUNT(*) as total_exams,
            SUM(CASE WHEN se.passed = 1 THEN 1 ELSE 0 END) as passed_exams,
            SUM(CASE WHEN se.passed != 1 THEN 1 ELSE 0 END) as failed_exams,
            COALESCE(
                SUM(
                    CASE WHEN se.passed = 1 THEN
                        IFNULL(e.total_mishnayot, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'mishnayot') +
                        IFNULL(e.gemara_pages, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'gemara_pages')
                    ELSE 0 END
                ), 0
            ) as total_reward
        FROM student_exams se
        JOIN exams e ON se.exam_code = e.exam_code
        WHERE se.student_code = ?
    `;

    try {
        const stats = await env.DB.prepare(query).bind(studentCode).first();
        
        const totalExams = stats.total_exams || 0;
        const passedExams = stats.passed_exams || 0;
        const failedExams = stats.failed_exams || 0;
        
        // הפרדת הסכום לשקלים ואגורות
        const totalReward = Number(stats.total_reward || 0);
        const shekels = Math.floor(totalReward);
        const agorot = Math.round((totalReward - shekels) * 100);

        // שלב 4: בניית שרשור הפקודות באמצעות מערך (כדי לשים את הנקודות רק בין הפקודות)
        let messageParts = [];
        let intro = `t-שלום ${student.first_name} ${student.last_name}`;
        
        if (totalExams === 0) {
            messageParts.push(`${intro} עדיין לא נבחנו באף מבחן`);
        } else {
            messageParts.push(`${intro} בסך הכל נבחנת ב`);
            messageParts.push(`n-${totalExams}`); // מספר המבחנים
            messageParts.push(`t-מבחנים עברת בהצלחה`);
            messageParts.push(`n-${passedExams}`); // מבחנים שעבר
            
            if (failedExams > 0) {
                messageParts.push(`t-מבחנים ולא עברת`);
                messageParts.push(`n-${failedExams}`); // מבחנים שנכשל
            }
            
            messageParts.push(`t-מבחנים הסכום שנצבר לזכותך הוא`);
            messageParts.push(`n-${shekels}`); // סכום שקלים
            
            if (agorot > 0) {
                messageParts.push(`t-שקלים ו`);
                messageParts.push(`n-${agorot}`); // אגורות
                messageParts.push(`t-אגורות`);
            } else {
                messageParts.push(`t-שקלים`);
            }
        }

        // חיבור כל חלקי המערך בעזרת נקודה (זה יוצר את השרשור המדויק לימות המשיח)
        const finalMessage = messageParts.join('.');

        return new Response(`id_list_message=${finalMessage}`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
        
    } catch (error) {
        return new Response(`id_list_message=t-אירעה שגיאה בקבלת הנתונים`, { 
            headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
        });
    }
}
