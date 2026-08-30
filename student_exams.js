export default async function studentExamsHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  
  const pathParts = url.pathname.split('/');
  // חילוץ קוד התלמיד מהנתיב אם נשלח (למשל: /peer/api/student-exams/1001)
  const studentCode = pathParts[4] ? decodeURIComponent(pathParts[4]) : null; 
  
  try {
    // 1. קבלת התוצאות
    if (method === 'GET') {
      if (studentCode) {
        // הבאת כל המבחנים של תלמיד ספציפי
        const { results } = await env.DB.prepare(
          "SELECT * FROM student_exams WHERE student_code = ? ORDER BY updated_at DESC"
        ).bind(studentCode).all();
        
        return new Response(JSON.stringify(results), { status: 200 });
      } else {
        // הבאת כל התוצאות של כל התלמידים במערכת
        const { results } = await env.DB.prepare(
          "SELECT * FROM student_exams ORDER BY updated_at DESC"
        ).all();
        
        return new Response(JSON.stringify(results), { status: 200 });
      }
    }
    
    // 2. עדכון או הוספת תוצאה למבחן (יעבוד גם עם POST וגם עם PUT)
    if (method === 'POST' || method === 'PUT') {
      const body = await request.json();
      
      // וידוא שנשלחו הנתונים ההכרחיים
      if (!body.student_code || !body.exam_code || body.passed === undefined) {
         return new Response(JSON.stringify({ error: 'Missing student_code, exam_code, or passed status' }), { status: 400 });
      }
      
      const passedValue = body.passed ? 1 : 0;
      
      // מכניס רשומה חדשה, ואם קיימת כזו לאותו תלמיד ואותו מבחן - מעדכן אותה
      const result = await env.DB.prepare(`
        INSERT INTO student_exams (student_code, exam_code, passed, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(student_code, exam_code) 
        DO UPDATE SET passed = excluded.passed, updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `).bind(body.student_code, body.exam_code, passedValue).first();
      
      return new Response(JSON.stringify(result), { status: 200 });
    }
    
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
