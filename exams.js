// פונקציית עזר לחישוב הקוד הבא
function calculateNextCode(lastCode) {
  if (!lastCode) return '1א'; 
  const match = lastCode.match(/^(\d+)([אב])$/);
  if (!match) return '1א'; 
  const num = parseInt(match[1], 10);
  const letter = match[2];
  if (letter === 'א') return `${num}ב`;
  return `${num + 1}א`;
}

export default async function examsHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  
  const pathParts = url.pathname.split('/');
  const examCode = pathParts[4] ? decodeURIComponent(pathParts[4]) : null; 
  
  // -- הזנה מרוכזת של נתונים (Bulk Insert) --
  if (method === 'POST' && examCode === 'bulk') {
    const examsArray = await request.json();
    
    // הכנת שאילתה לכל מבחן במערך
    const stmts = examsArray.map(exam => 
      env.DB.prepare(`
        INSERT INTO exams (
          exam_code, masechet, chapter_num, chapter_name, chapter_title, 
          from_page, to_page, total_mishnayot, gemara_pages, target_grade
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        exam.exam_code, 
        exam.masechet || null,
        exam.chapter_num || null,
        exam.chapter_name || null,
        exam.chapter_title || null,
        exam.from_page || null,
        exam.to_page || null,
        exam.total_mishnayot || null,
        exam.gemara_pages || null,
        exam.target_grade || null
      )
    );
    
    // הרצה במקביל של כל ההכנסות
    const results = await env.DB.batch(stmts);
    return new Response(JSON.stringify({ success: true, count: results.length }), { status: 201 });
  }

  // 1. קבלת כל המבחנים הפעילים
  if (method === 'GET' && !examCode) {
    const { results } = await env.DB.prepare("SELECT * FROM exams WHERE is_deleted = 0 ORDER BY id ASC").all();
    return new Response(JSON.stringify(results), { status: 200 });
  }
  
  // 2. יצירת מבחן בודד (לשימוש בהמשך המערכת)
  if (method === 'POST' && !examCode) {
    const body = await request.json();
    const lastExam = await env.DB.prepare("SELECT exam_code FROM exams ORDER BY id DESC LIMIT 1").first();
    const nextCode = calculateNextCode(lastExam ? lastExam.exam_code : null);
    
    const result = await env.DB.prepare(`
      INSERT INTO exams (
        exam_code, masechet, chapter_num, chapter_name, chapter_title, 
        from_page, to_page, total_mishnayot, gemara_pages, target_grade
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).bind(
      nextCode, body.masechet || null, body.chapter_num || null, body.chapter_name || null, 
      body.chapter_title || null, body.from_page || null, body.to_page || null, 
      body.total_mishnayot || null, body.gemara_pages || null, body.target_grade || null
    ).first();
    
    return new Response(JSON.stringify(result), { status: 201 });
  }
  
  // 3. עדכון
  if (method === 'PUT' && examCode && examCode !== 'bulk') {
    const body = await request.json();
    const result = await env.DB.prepare(`
      UPDATE exams SET 
        masechet = ?, chapter_num = ?, chapter_name = ?, chapter_title = ?, 
        from_page = ?, to_page = ?, total_mishnayot = ?, gemara_pages = ?, target_grade = ?
      WHERE exam_code = ? AND is_deleted = 0 RETURNING *
    `).bind(
      body.masechet || null, body.chapter_num || null, body.chapter_name || null, body.chapter_title || null,
      body.from_page || null, body.to_page || null, body.total_mishnayot || null, body.gemara_pages || null, body.target_grade || null,
      examCode
    ).first();
    
    if (!result) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    return new Response(JSON.stringify(result), { status: 200 });
  }
  
  // 4. מחיקה
  if (method === 'DELETE' && examCode && examCode !== 'bulk') {
    const result = await env.DB.prepare("UPDATE exams SET is_deleted = 1 WHERE exam_code = ?").bind(examCode).run();
    if (result.meta.changes === 0) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }
  
  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
}
