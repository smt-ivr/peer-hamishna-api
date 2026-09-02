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

// פונקציית עזר לאריזת נתוני המבחן למבנה נקי לפי סוג
function formatExam(exam) {
  if (!exam) return exam;
  
  // המבנה הראשי (המשותף לכל המבחנים)
  let formatted = {
    id: exam.id,
    exam_code: exam.exam_code,
    exam_type: exam.exam_type || 'unknown',
    target_grade: exam.target_grade,
    reward_price: exam.reward_price || 0, // המחיר המחושב מהמסד
    is_deleted: exam.is_deleted === 1
  };

  // אריזת הפרטים הספציפיים לפי סוג המבחן למניעת ערכי null
  if (exam.exam_type === 'mishnayot') {
    formatted.details = {
      masechet: exam.masechet,
      chapter_num: exam.chapter_num,
      chapter_name: exam.chapter_name,
      chapter_title: exam.chapter_title,
      total_mishnayot: exam.total_mishnayot
    };
  } else if (exam.exam_type === 'gemara') {
    formatted.details = {
      masechet: exam.masechet,
      from_page: exam.from_page,
      to_page: exam.to_page,
      gemara_pages: exam.gemara_pages
    };
  } else {
    // ברירת מחדל במידה וסוג המבחן טרם הוגדר
    formatted.details = {
      masechet: exam.masechet,
      chapter_num: exam.chapter_num,
      chapter_name: exam.chapter_name,
      chapter_title: exam.chapter_title,
      from_page: exam.from_page,
      to_page: exam.to_page,
      total_mishnayot: exam.total_mishnayot,
      gemara_pages: exam.gemara_pages
    };
  }

  return formatted;
}

export default async function examsHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  
  const pathParts = url.pathname.split('/');
  const examCode = pathParts[4] ? decodeURIComponent(pathParts[4]) : null; 
  
  // -- הזנה מרוכזת של נתונים (Bulk Insert) --
  if (method === 'POST' && examCode === 'bulk') {
    const examsArray = await request.json();
    
    const validExams = examsArray.filter(exam => exam && exam.exam_code);
    
    if (validExams.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid data to insert' }), { status: 400 });
    }

    const stmts = validExams.map(exam => 
      env.DB.prepare(`
        INSERT INTO exams (
          exam_code, exam_type, masechet, chapter_num, chapter_name, chapter_title, 
          from_page, to_page, total_mishnayot, gemara_pages, target_grade
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        exam.exam_code, 
        exam.exam_type || null,
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
    
    const results = await env.DB.batch(stmts);
    return new Response(JSON.stringify({ success: true, count: results.length }), { status: 201 });
  }

  // 1. קבלת כל המבחנים הפעילים (כולל חישוב התגמול הכספי של כל מבחן)
  if (method === 'GET' && !examCode) {
    const query = `
      SELECT 
        e.*,
        (
          IFNULL(e.total_mishnayot, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'mishnayot') +
          IFNULL(e.gemara_pages, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'gemara_pages')
        ) as reward_price
      FROM exams e 
      WHERE e.is_deleted = 0 
      ORDER BY e.id ASC
    `;
    const { results } = await env.DB.prepare(query).all();
    const formattedResults = results.map(formatExam);
    return new Response(JSON.stringify(formattedResults), { status: 200 });
  }
  
  // 2. יצירת מבחן בודד 
  if (method === 'POST' && !examCode) {
    const body = await request.json();
    const lastExam = await env.DB.prepare("SELECT exam_code FROM exams ORDER BY id DESC LIMIT 1").first();
    const nextCode = calculateNextCode(lastExam ? lastExam.exam_code : null);
    
    const result = await env.DB.prepare(`
      INSERT INTO exams (
        exam_code, exam_type, masechet, chapter_num, chapter_name, chapter_title, 
        from_page, to_page, total_mishnayot, gemara_pages, target_grade
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
    `).bind(
      nextCode, body.exam_type || null, body.masechet || null, body.chapter_num || null, body.chapter_name || null, 
      body.chapter_title || null, body.from_page || null, body.to_page || null, 
      body.total_mishnayot || null, body.gemara_pages || null, body.target_grade || null
    ).first();
    
    return new Response(JSON.stringify(formatExam(result)), { status: 201 });
  }
  
  // 3. עדכון
  if (method === 'PUT' && examCode && examCode !== 'bulk') {
    const body = await request.json();
    const result = await env.DB.prepare(`
      UPDATE exams SET 
        exam_type = ?, masechet = ?, chapter_num = ?, chapter_name = ?, chapter_title = ?, 
        from_page = ?, to_page = ?, total_mishnayot = ?, gemara_pages = ?, target_grade = ?
      WHERE exam_code = ? AND is_deleted = 0 RETURNING *
    `).bind(
      body.exam_type || null, body.masechet || null, body.chapter_num || null, body.chapter_name || null, body.chapter_title || null,
      body.from_page || null, body.to_page || null, body.total_mishnayot || null, body.gemara_pages || null, body.target_grade || null,
      examCode
    ).first();
    
    if (!result) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    return new Response(JSON.stringify(formatExam(result)), { status: 200 });
  }
  
  // 4. מחיקה
  if (method === 'DELETE' && examCode && examCode !== 'bulk') {
    const result = await env.DB.prepare("UPDATE exams SET is_deleted = 1 WHERE exam_code = ?").bind(examCode).run();
    if (result.meta.changes === 0) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }
  
  return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
}
