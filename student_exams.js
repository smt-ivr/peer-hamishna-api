import { getLocalTime } from './time.js'; // ייבוא הלוגיקה של השעון

// פונקציית עזר להמרת נתונים בוליאניים
function formatStudentExam(exam) {
  if (!exam) return exam;
  return {
    ...exam,
    passed: exam.passed === 1
  };
}

export default async function studentExamsHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  
  const pathParts = url.pathname.split('/');
  const studentCode = pathParts[4] ? decodeURIComponent(pathParts[4]) : null; 
  const examCode = pathParts[5] ? decodeURIComponent(pathParts[5]) : null; 
  
  try {
    // 1. קבלת התוצאות
    if (method === 'GET') {
      if (studentCode) {
        const { results } = await env.DB.prepare(
          "SELECT * FROM student_exams WHERE student_code = ? ORDER BY updated_at DESC"
        ).bind(studentCode).all();
        return new Response(JSON.stringify(results.map(formatStudentExam)), { status: 200 });
      } else {
        const { results } = await env.DB.prepare(
          "SELECT * FROM student_exams ORDER BY updated_at DESC"
        ).all();
        return new Response(JSON.stringify(results.map(formatStudentExam)), { status: 200 });
      }
    }
    
    // -- הזנה מרוכזת של תוצאות לכלל המערכת (Bulk Insert) --
    if (method === 'POST' && studentCode === 'bulk') {
      const resultsArray = await request.json();
      const validResults = resultsArray.filter(res => res && res.student_code && res.exam_code && res.passed !== undefined);
      
      if (validResults.length === 0) {
        return new Response(JSON.stringify({ error: 'No valid data to insert' }), { status: 400 });
      }

      const currentTime = getLocalTime(); 
      
      const stmts = validResults.map(item => {
        const passedValue = item.passed ? 1 : 0;
        return env.DB.prepare(`
          INSERT INTO student_exams (student_code, exam_code, passed, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(student_code, exam_code) 
          DO UPDATE SET passed = excluded.passed, updated_at = ?
        `).bind(item.student_code, item.exam_code, passedValue, currentTime, currentTime);
      });
      
      const results = await env.DB.batch(stmts);
      return new Response(JSON.stringify({ success: true, count: results.length }), { status: 201 });
    }

    // 2. עדכון או הוספת תוצאות מבחנים לתלמיד ספציפי 
    if (method === 'POST' && !studentCode) {
      const body = await request.json();
      
      if (!body.student_code || !Array.isArray(body.exams)) {
         return new Response(JSON.stringify({ error: 'Expected student_code and an array of exams' }), { status: 400 });
      }
      
      const currentTime = getLocalTime(); 
      const results = { updated: [], skipped: [], errors: [] };

      // שליפת המבחנים הקיימים במערכת כדי לוודא שהמבחן שמנסים לעדכן חוקי
      const validExamsQuery = await env.DB.prepare(
        "SELECT exam_code FROM exams WHERE is_deleted = 0"
      ).all();
      const validExamCodes = new Set(validExamsQuery.results.map(r => r.exam_code));

      // שליפת המבחנים שכבר קיימים לתלמיד כדי להגן מפני דריסה (כולל הציון הנוכחי)
      const existingExamsQuery = await env.DB.prepare(
        "SELECT exam_code, passed FROM student_exams WHERE student_code = ?"
      ).bind(body.student_code).all();
      
      const existingExamsMap = new Map(existingExamsQuery.results.map(r => [r.exam_code, r.passed]));
      const stmts = [];

      for (const item of body.exams) {
        if (!item.exam_code || item.passed === undefined) {
           results.errors.push({ exam_code: item.exam_code || 'לא ידוע', reason: 'שדות חובה חסרים' });
           continue;
        }

        // חסימת מבחנים שלא מוגדרים במסד
        if (!validExamCodes.has(item.exam_code)) {
            results.errors.push({ exam_code: item.exam_code, reason: 'מבחן לא קיים במערכת' });
            continue;
        }

        const isExisting = existingExamsMap.has(item.exam_code);

        // מנגנון ההגנה מפני דריסה (עם תגובה נורמלית)
        if (isExisting && !item.force_update) {
          const currentStatus = existingExamsMap.get(item.exam_code) === 1 ? 'עבר' : 'לא עבר';
          results.skipped.push({ 
            exam_code: item.exam_code, 
            reason: `ציון כבר מעודכן במערכת כ-${currentStatus}` 
          });
          continue;
        }

        const passedValue = item.passed ? 1 : 0;
        const statusText = item.passed ? 'עבר' : 'לא עבר';
        
        stmts.push(
          env.DB.prepare(`
            INSERT INTO student_exams (student_code, exam_code, passed, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(student_code, exam_code) 
            DO UPDATE SET passed = excluded.passed, updated_at = ?
          `).bind(body.student_code, item.exam_code, passedValue, currentTime, currentTime)
        );
        
        results.updated.push({
            exam_code: item.exam_code,
            status: `עודכן בהצלחה: ${statusText}`
        });
      }
      
      if (stmts.length > 0) {
        await env.DB.batch(stmts);
      }

      return new Response(JSON.stringify(results), { status: 200 });
    }

    // 3. מחיקת תוצאה
    if (method === 'DELETE' && studentCode && examCode) {
      const result = await env.DB.prepare(
        "DELETE FROM student_exams WHERE student_code = ? AND exam_code = ?"
      ).bind(studentCode, examCode).run();
      
      if (result.meta.changes === 0) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
