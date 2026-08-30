// פונקציית עזר ליצירת קוד תלמיד אוטומטי (לפי המספר הגבוה ביותר שקיים)
async function getNextStudentCode(env) {
  const result = await env.DB.prepare(
    "SELECT student_code FROM students ORDER BY CAST(student_code AS INTEGER) DESC LIMIT 1"
  ).first();
  
  if (!result || !result.student_code) return '1000'; // מספר התחלתי במידה ואין תלמידים
  
  const lastNum = parseInt(result.student_code, 10);
  if (isNaN(lastNum)) return '1000';
  
  return (lastNum + 1).toString();
}

export default async function studentsHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  
  const pathParts = url.pathname.split('/');
  // חילוץ קוד תלמיד מהנתיב (למשל: /peer/api/students/1001)
  const studentCode = pathParts[4] ? decodeURIComponent(pathParts[4]) : null; 
  
  try {
    // 1. קבלת כל התלמידים
    if (method === 'GET' && !studentCode) {
      const { results } = await env.DB.prepare(
        "SELECT * FROM students WHERE is_deleted = 0 ORDER BY class_grade ASC, first_name ASC"
      ).all();
      
      // המרת מחרוזת ה-JSON של הטלפונים בחזרה למערך עבור צד הלקוח
      const formattedResults = results.map(student => ({
        ...student,
        phones: student.phones ? JSON.parse(student.phones) : []
      }));
      
      return new Response(JSON.stringify(formattedResults), { status: 200 });
    }
    
    // 2. יצירת תלמיד חדש (או רשימת תלמידים דרך POST /bulk)
    if (method === 'POST') {
      if (studentCode === 'bulk') {
        const studentsArray = await request.json();
        const validStudents = studentsArray.filter(s => s && s.student_code);
        
        if (validStudents.length === 0) {
          return new Response(JSON.stringify({ error: 'No valid data' }), { status: 400 });
        }

        const stmts = validStudents.map(student => 
          env.DB.prepare(`
            INSERT INTO students (student_code, first_name, last_name, class_grade, phones)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            student.student_code,
            student.first_name || '',
            student.last_name || '',
            student.class_grade || '',
            JSON.stringify(student.phones || [])
          )
        );
        
        const results = await env.DB.batch(stmts);
        return new Response(JSON.stringify({ success: true, count: results.length }), { status: 201 });
      } 
      else {
        // יצירת תלמיד בודד
        const body = await request.json();
        const finalCode = body.student_code ? body.student_code.toString() : await getNextStudentCode(env);
        
        const result = await env.DB.prepare(`
          INSERT INTO students (student_code, first_name, last_name, class_grade, phones)
          VALUES (?, ?, ?, ?, ?) RETURNING *
        `).bind(
          finalCode, 
          body.first_name || '', 
          body.last_name || '', 
          body.class_grade || '', 
          JSON.stringify(body.phones || [])
        ).first();
        
        if (result) result.phones = JSON.parse(result.phones);
        return new Response(JSON.stringify(result), { status: 201 });
      }
    }
    
    // 3. עדכון תלמיד (כולל אפשרות לעדכן את קוד התלמיד עצמו)
    if (method === 'PUT' && studentCode && studentCode !== 'bulk') {
      const body = await request.json();
      const newCode = body.student_code ? body.student_code.toString() : studentCode;
      
      const result = await env.DB.prepare(`
        UPDATE students SET 
          student_code = ?, first_name = ?, last_name = ?, class_grade = ?, phones = ?
        WHERE student_code = ? AND is_deleted = 0 RETURNING *
      `).bind(
        newCode,
        body.first_name || '',
        body.last_name || '',
        body.class_grade || '',
        JSON.stringify(body.phones || []),
        studentCode
      ).first();
      
      if (!result) return new Response(JSON.stringify({ error: 'Student not found' }), { status: 404 });
      
      result.phones = JSON.parse(result.phones);
      return new Response(JSON.stringify(result), { status: 200 });
    }
    
    // 4. מחיקת תלמיד (מחיקה רכה)
    if (method === 'DELETE' && studentCode && studentCode !== 'bulk') {
      const result = await env.DB.prepare("UPDATE students SET is_deleted = 1 WHERE student_code = ?").bind(studentCode).run();
      if (result.meta.changes === 0) return new Response(JSON.stringify({ error: 'Student not found' }), { status: 404 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    
  } catch (error) {
    // במידה ויש שגיאה כמו קוד כפול
    if (error.message.includes('UNIQUE constraint failed')) {
      return new Response(JSON.stringify({ error: 'Student code already exists' }), { status: 400 });
    }
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
