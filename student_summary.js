// פונקציית עזר לחישוב והשוואת כיתות
function getGradeValue(gradeStr) {
  if (!gradeStr) return 0;
  const cleanGrade = String(gradeStr).replace(/כיתה/g, '').replace(/['"']/g, '').trim();
  
  const gradesMap = {
    'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6,
    'ז': 7, 'ח': 8, 'ט': 9, 'י': 10, 'יא': 11, 'יב': 12
  };
  
  const num = parseInt(cleanGrade, 10);
  if (!isNaN(num)) return num; 
  return gradesMap[cleanGrade] || 0;
}

export default async function studentSummaryHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  if (method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405 });
  }

  // אפשרות לסינון לפי תלמיד בודד או כיתה
  const studentCode = url.searchParams.get('student_code');
  const classGrade = url.searchParams.get('class_grade');

  try {
    // 1. קבלת תעריפי התגמולים (לצורך חישוב שווי כל מבחן)
    const ratesResult = await env.DB.prepare("SELECT * FROM reward_rates").all();
    const rates = {};
    if (ratesResult && ratesResult.results) {
      ratesResult.results.forEach(r => rates[r.unit_type] = r.price_per_unit);
    }

    // 2. שליפת כל המבחנים הפעילים במערכת
    const examsResult = await env.DB.prepare("SELECT * FROM exams WHERE is_deleted = 0 ORDER BY id ASC").all();
    const allExams = examsResult.results;

    // 3. הרכבת שאילתת התלמידים בהתאם לפרמטרים שסופקו
    let studentsQuery = "SELECT * FROM students WHERE is_deleted = 0";
    let studentsParams = [];

    if (studentCode) {
      studentsQuery += " AND student_code = ?";
      studentsParams.push(studentCode);
    } else if (classGrade) {
      studentsQuery += " AND class_grade = ?";
      studentsParams.push(classGrade);
    }

    studentsQuery += " ORDER BY class_grade ASC, first_name ASC";

    let studentsResult;
    if (studentsParams.length > 0) {
      studentsResult = await env.DB.prepare(studentsQuery).bind(...studentsParams).all();
    } else {
      studentsResult = await env.DB.prepare(studentsQuery).all();
    }
    const students = studentsResult.results;

    if (!students || students.length === 0) {
      return new Response(JSON.stringify([]), { status: 200 });
    }

    // 4. שליפת כל תוצאות המבחנים למיפוי בזיכרון (יעיל יותר משאילתה לכל תלמיד)
    const studentExamsResult = await env.DB.prepare("SELECT * FROM student_exams").all();
    const seMap = {};
    if (studentExamsResult && studentExamsResult.results) {
      studentExamsResult.results.forEach(se => {
        if (!seMap[se.student_code]) {
          seMap[se.student_code] = {};
        }
        seMap[se.student_code][se.exam_code] = se;
      });
    }

    // 5. עיבוד ובניית המערך הסופי לכל תלמיד
    const summary = students.map(student => {
      const studentGradeVal = getGradeValue(student.class_grade);

      let total_available_exams = 0;
      let total_attempted = 0;
      let total_passed = 0;
      let total_reward = 0;

      const studentExamsList = [];

      allExams.forEach(exam => {
        // סינון חכם: אם המבחן מיועד לכיתה גבוהה יותר, נדלג ולא נציג אותו לתלמיד
        if (exam.target_grade && student.class_grade) {
          const targetGradeVal = getGradeValue(exam.target_grade);
          if (studentGradeVal > 0 && targetGradeVal > 0 && studentGradeVal < targetGradeVal) {
            return; 
          }
        }

        total_available_exams++; 

        // חישוב פוטנציאל הרווח על המבחן הזה
        const examReward = ((exam.total_mishnayot || 0) * (rates['mishnayot'] || 0)) +
                           ((exam.gemara_pages || 0) * (rates['gemara_pages'] || 0));

        let statusText = 'לא בוצע';
        let passed = null;
        let rewardEarned = 0;

        // בדיקה האם לתלמיד הספציפי יש תוצאה במבחן הזה
        const studentExamRecord = seMap[student.student_code]?.[exam.exam_code];

        if (studentExamRecord) {
          total_attempted++;
          if (studentExamRecord.passed === 1) {
            statusText = 'עבר';
            passed = true;
            total_passed++;
            rewardEarned = examReward;
            total_reward += examReward;
          } else {
            statusText = 'לא עבר';
            passed = false;
          }
        }

        // אריזת פרטי המבחן באופן נקי (כמו בקריאת המבחנים הרגילה)
        let details = {};
        if (exam.exam_type === 'mishnayot') {
          details = {
            masechet: exam.masechet,
            chapter_num: exam.chapter_num,
            chapter_name: exam.chapter_name,
            chapter_title: exam.chapter_title,
            total_mishnayot: exam.total_mishnayot
          };
        } else if (exam.exam_type === 'gemara') {
          details = {
            masechet: exam.masechet,
            chapter_title: exam.chapter_title,
            from_page: exam.from_page,
            to_page: exam.to_page,
            gemara_pages: exam.gemara_pages
          };
        } else {
          details = {
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

        studentExamsList.push({
          exam_code: exam.exam_code,
          exam_type: exam.exam_type || 'unknown',
          target_grade: exam.target_grade,
          details: details,
          status_text: statusText, 
          passed: passed, 
          reward_earned: rewardEarned, 
          potential_reward: examReward 
        });
      });

      return {
        student_code: student.student_code,
        first_name: student.first_name,
        last_name: student.last_name,
        class_grade: student.class_grade,
        phones: typeof student.phones === 'string' ? JSON.parse(student.phones) : student.phones,
        stats: {
          total_available_exams: total_available_exams,
          total_attempted: total_attempted,
          total_passed: total_passed,
          total_reward: total_reward
        },
        exams: studentExamsList
      };
    });

    return new Response(JSON.stringify(summary), { status: 200 });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
