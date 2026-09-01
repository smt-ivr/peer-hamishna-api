import { getLocalTime } from './time.js'; // ייבוא הלוגיקה של השעון

export default async function studentExamsHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  
  const pathParts = url.pathname.split('/');
  // חילוץ קוד תלמיד וקוד מבחן מהנתיב
  const studentCode = pathParts[4] ? decodeURIComponent(pathParts[4]) : null; 
  const examCode = pathParts[5] ? decodeURIComponent(pathParts[5]) : null; 
  
  try {
    // 1. קבלת התוצאות
    if (method === 'GET') {
      if (studentCode) {
        const { results } = await env.DB.prepare(
          "SELECT * FROM student_exams WHERE student_code = ? ORDER BY updated_at DESC"
        ).bind(studentCode).all();
        return new Response(JSON.stringify(results), { status: 200 });
      } else {
        const { results } = await env.DB.prepare(
          "SELECT * FROM student_exams ORDER BY updated_at DESC"
        ).all();
        return new Response(JSON.stringify(results), { status: 200 });
      }
    }
    
    // -- הזנה מרוכזת של תוצאות (Bulk Insert) --
    if (method === 'POST' && studentCode === 'bulk') {
      const resultsArray = await request.json();
      
      // סינון נתונים תקינים שהגיעו מה-HTML
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

    // 2. עדכון או הוספת תוצאה למבחן (בודד)
    if (method === 'POST' || method === 'PUT') {
      const body = await request.json();
      
      if (!body.student_code || !body.exam_code || body.passed === undefined) {
         return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
      }
      
      const passedValue = body.passed ? 1 : 0;
      const currentTime = getLocalTime(); // שימוש בזמן ישראל
      
      const result = await env.DB.prepare(`
        INSERT INTO student_exams (student_code, exam_code, passed, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(student_code, exam_code) 
        DO UPDATE SET passed = excluded.passed, updated_at = ?
        RETURNING *
      `).bind(body.student_code, body.exam_code, passedValue, currentTime, currentTime).first();
      
      return new Response(JSON.stringify(result), { status: 200 });
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
