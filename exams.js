// פונקציית עזר לחישוב קוד המבחן הבא (לדוגמה: מ-1א ל-1ב, ומ-1ב ל-2א)
function calculateNextCode(lastCode) {
  if (!lastCode) return '1א'; 
  
  const match = lastCode.match(/^(\d+)([אב])$/);
  if (!match) return '1א'; 
  
  const num = parseInt(match[1], 10);
  const letter = match[2];
  
  if (letter === 'א') {
    return `${num}ב`;
  } else {
    return `${num + 1}א`;
  }
}

export default async function examsHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  
  // חילוץ קוד המבחן מהנתיב אם נשלח (לדוגמה: /peer/api/exams/1א)
  const pathParts = url.pathname.split('/');
  const examCode = pathParts[4] ? decodeURIComponent(pathParts[4]) : null; 
  
  try {
    // 1. קבלת כל המבחנים הפעילים
    if (method === 'GET' && !examCode) {
      const { results } = await env.DB.prepare(
        "SELECT * FROM exams WHERE is_deleted = 0 ORDER BY id ASC"
      ).all();
      
      return new Response(JSON.stringify(results), { 
        status: 200, headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // 2. יצירת מבחן חדש
    if (method === 'POST') {
      const body = await request.json();
      
      // מציאת הקוד האחרון שנוצר כדי לחשב את הקוד הבא אוטומטית
      const lastExam = await env.DB.prepare(
        "SELECT exam_code FROM exams ORDER BY id DESC LIMIT 1"
      ).first();
      
      const nextCode = calculateNextCode(lastExam ? lastExam.exam_code : null);
      
      const result = await env.DB.prepare(`
        INSERT INTO exams (
          exam_code, masechet, chapter_num, chapter_name, chapter_title, 
          from_page, to_page, total_mishnayot, gemara_pages, target_grade
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
      `).bind(
        nextCode, 
        body.masechet || null,
        body.chapter_num || null,
        body.chapter_name || null,
        body.chapter_title || null,
        body.from_page || null,
        body.to_page || null,
        body.total_mishnayot || null,
        body.gemara_pages || null,
        body.target_grade || null
      ).first();
      
      return new Response(JSON.stringify(result), { 
        status: 201, headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // 3. עדכון מבחן לפי קוד
    if (method === 'PUT' && examCode) {
      const body = await request.json();
      
      const result = await env.DB.prepare(`
        UPDATE exams SET 
          masechet = ?, chapter_num = ?, chapter_name = ?, chapter_title = ?, 
          from_page = ?, to_page = ?, total_mishnayot = ?, gemara_pages = ?, target_grade = ?
        WHERE exam_code = ? AND is_deleted = 0 RETURNING *
      `).bind(
        body.masechet || null,
        body.chapter_num || null,
        body.chapter_name || null,
        body.chapter_title || null,
        body.from_page || null,
        body.to_page || null,
        body.total_mishnayot || null,
        body.gemara_pages || null,
        body.target_grade || null,
        examCode
      ).first();
      
      if (!result) {
        return new Response(JSON.stringify({ error: 'Exam not found or deleted' }), { status: 404 });
      }
      
      return new Response(JSON.stringify(result), { 
        status: 200, headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // 4. מחיקת מבחן (מחיקה רכה)
    if (method === 'DELETE' && examCode) {
      const result = await env.DB.prepare(
        "UPDATE exams SET is_deleted = 1 WHERE exam_code = ?"
      ).bind(examCode).run();
      
      if (result.meta.changes === 0) {
        return new Response(JSON.stringify({ error: 'Exam not found' }), { status: 404 });
      }
      
      return new Response(JSON.stringify({ success: true, message: 'Exam marked as deleted' }), { 
        status: 200, headers: { 'Content-Type': 'application/json' } 
      });
    }
    
    // מתודה לא נתמכת
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
