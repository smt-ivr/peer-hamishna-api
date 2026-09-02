// פונקציית עזר ליצירת קוד תלמיד אוטומטי
async function getNextStudentCode(env) {
  const result = await env.DB.prepare(
    "SELECT student_code FROM students ORDER BY CAST(student_code AS INTEGER) DESC LIMIT 1"
  ).first();
  
  if (!result || !result.student_code) return '1000'; 
  
  const lastNum = parseInt(result.student_code, 10);
  if (isNaN(lastNum)) return '1000';
  
  return (lastNum + 1).toString();
}

// פונקציית עזר להמרת נתונים לפורמט הנדרש
function formatStudent(student) {
  if (!student) return student;
  
  let formattedStudent = {
    ...student,
    phones: student.phones ? (typeof student.phones === 'string' ? JSON.parse(student.phones) : student.phones) : [],
    is_deleted: student.is_deleted === 1
  };

  // טיפול בשדות המורחבים במידה והם קיימים
  if (student.hasOwnProperty('exams_details')) {
    try {
      let examsArray = typeof student.exams_details === 'string' ? JSON.parse(student.exams_details) : student.exams_details;
      
      // עיצוב מחדש של כל מבחן בהתאם לסוג שלו
      formattedStudent.exams_details = examsArray.map(exam => {
        let isPassed = exam.passed === 1;
        let formattedExam = {
          exam_code: exam.exam_code,
          exam_type: exam.exam_type || 'unknown',
          passed: isPassed
        };

        if (exam.exam_type === 'mishnayot') {
          formattedExam.details = {
            masechet: exam.masechet,
            chapter_num: exam.chapter_num,
            chapter_name: exam.chapter_name,
            chapter_title: exam.chapter_title,
            total_mishnayot: exam.total_mishnayot
          };
        } else if (exam.exam_type === 'gemara') {
          formattedExam.details = {
            masechet: exam.masechet,
            from_page: exam.from_page,
            to_page: exam.to_page,
            gemara_pages: exam.gemara_pages
          };
        } else {
          formattedExam.details = {
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

        // הוספת פרמטר התגמול אך ורק אם התלמיד עבר את המבחן בהצלחה
        if (isPassed && exam.reward !== undefined && exam.reward !== null) {
          formattedExam.reward = exam.reward;
        }

        return formattedExam;
      });
    } catch (e) {
      console.error("Error parsing exams details", e);
      formattedStudent.exams_details = [];
    }
  }

  if (student.hasOwnProperty('total_reward')) {
    formattedStudent.total_reward = student.total_reward || 0;
  }

  return formattedStudent;
}

export default async function studentsHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  
  const pathParts = url.pathname.split('/');
  const pathStudentCode = pathParts[4] ? decodeURIComponent(pathParts[4]) : null; 
  const queryStudentCode = url.searchParams.get('student_code');
  
  const studentCode = queryStudentCode || pathStudentCode;
  
  const fullDetails = url.searchParams.get('full_details') === 'true';
  
  try {
    if (method === 'GET') {
      let baseQuery = "";
      
      if (fullDetails || studentCode) {
        baseQuery = `
          SELECT 
            s.*,
            COALESCE(
              (
                SELECT json_group_array(
                  json_object(
                    'exam_code', e.exam_code,
                    'exam_type', e.exam_type,
                    'masechet', e.masechet,
                    'chapter_num', e.chapter_num,
                    'chapter_name', e.chapter_name,
                    'chapter_title', e.chapter_title,
                    'from_page', e.from_page,
                    'to_page', e.to_page,
                    'total_mishnayot', e.total_mishnayot,
                    'gemara_pages', e.gemara_pages,
                    'passed', se.passed,
                    'reward', (
                      IFNULL(e.total_mishnayot, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'mishnayot') +
                      IFNULL(e.gemara_pages, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'gemara_pages')
                    )
                  )
                )
                FROM student_exams se
                JOIN exams e ON se.exam_code = e.exam_code
                WHERE se.student_code = s.student_code
              ), '[]'
            ) as exams_details,
            COALESCE(
              (
                SELECT SUM(
                  IFNULL(e.total_mishnayot, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'mishnayot') +
                  IFNULL(e.gemara_pages, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'gemara_pages')
                )
                FROM student_exams se
                JOIN exams e ON se.exam_code = e.exam_code
                WHERE se.student_code = s.student_code AND se.passed = 1
              ), 0
            ) as total_reward
          FROM students s
          WHERE s.is_deleted = 0
        `;
      } else {
        baseQuery = `SELECT s.* FROM students s WHERE s.is_deleted = 0`;
      }

      if (studentCode) {
        const result = await env.DB.prepare(`${baseQuery} AND s.student_code = ?`).bind(studentCode).first();
        if (!result) return new Response(JSON.stringify({ error: 'Student not found' }), { status: 404 });
        return new Response(JSON.stringify(formatStudent(result)), { status: 200 });
      } else {
        const { results } = await env.DB.prepare(`${baseQuery} ORDER BY s.class_grade ASC, s.first_name ASC`).all();
        const formattedResults = results.map(formatStudent);
        return new Response(JSON.stringify(formattedResults), { status: 200 });
      }
    }
    
    if (method === 'POST') {
      if (studentCode === 'bulk') {
        const studentsArray = await request.json();
        const validStudents = studentsArray.filter(s => s && s.student_code);
        if (validStudents.length === 0) return new Response(JSON.stringify({ error: 'No valid data' }), { status: 400 });

        const stmts = validStudents.map(student => 
          env.DB.prepare(`
            INSERT INTO students (student_code, first_name, last_name, class_grade, phones)
            VALUES (?, ?, ?, ?, ?)
          `).bind(student.student_code, student.first_name || '', student.last_name || '', student.class_grade || '', JSON.stringify(student.phones || []))
        );
        const results = await env.DB.batch(stmts);
        return new Response(JSON.stringify({ success: true, count: results.length }), { status: 201 });
      } else {
        const body = await request.json();
        const finalCode = body.student_code ? body.student_code.toString() : await getNextStudentCode(env);
        const result = await env.DB.prepare(`
          INSERT INTO students (student_code, first_name, last_name, class_grade, phones)
          VALUES (?, ?, ?, ?, ?) RETURNING *
        `).bind(finalCode, body.first_name || '', body.last_name || '', body.class_grade || '', JSON.stringify(body.phones || [])).first();
        return new Response(JSON.stringify(formatStudent(result)), { status: 201 });
      }
    }
    
    if (method === 'PUT' && studentCode && studentCode !== 'bulk') {
      const body = await request.json();
      const newCode = body.student_code ? body.student_code.toString() : studentCode;
      const result = await env.DB.prepare(`
        UPDATE students SET student_code = ?, first_name = ?, last_name = ?, class_grade = ?, phones = ?
        WHERE student_code = ? AND is_deleted = 0 RETURNING *
      `).bind(newCode, body.first_name || '', body.last_name || '', body.class_grade || '', JSON.stringify(body.phones || []), studentCode).first();
      if (!result) return new Response(JSON.stringify({ error: 'Student not found' }), { status: 404 });
      return new Response(JSON.stringify(formatStudent(result)), { status: 200 });
    }
    
    if (method === 'DELETE' && studentCode && studentCode !== 'bulk') {
      const result = await env.DB.prepare("UPDATE students SET is_deleted = 1 WHERE student_code = ?").bind(studentCode).run();
      if (result.meta.changes === 0) return new Response(JSON.stringify({ error: 'Student not found' }), { status: 404 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
    
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) return new Response(JSON.stringify({ error: 'Student code already exists' }), { status: 400 });
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
