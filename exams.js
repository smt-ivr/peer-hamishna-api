// ============================================================
//  exams.js — ניהול מבחנים (שרת)
//  GET    /exams                      רשימת מבחנים   (?include_deleted=true  ?with_usage=true)
//  GET    /exams/meta                 מחירון + הקוד הבא
//  POST   /exams                      מבחן חדש (הקוד נקבע אוטומטית)
//  POST   /exams/series               כמה מבחנים בבת אחת (קודים רצופים אוטומטית)
//  POST   /exams/bulk                 ייבוא עם קודים מפורשים (כמו קודם, ללא שינוי)
//  PUT    /exams/:code                עדכון מבחן
//  DELETE /exams/:code                מחיקה רכה (אפשר לשחזר)
//  POST   /exams/:code/restore        שחזור מבחן שנמחק
// ============================================================

const TYPES = ['mishnayot', 'gemara'];
const GRADE_VALUES = { 'א': 1, 'ב': 2, 'ג': 3, 'ד': 4, 'ה': 5, 'ו': 6, 'ז': 7, 'ח': 8, 'ט': 9, 'י': 10, 'יא': 11, 'יב': 12 };
const GRADE_LETTERS = Object.keys(GRADE_VALUES);
const MAX_SERIES = 200;

// ---------- קודים ----------

// קוד = מספר + א/ב  (1א, 1ב, 2א, ...)
function codeRank(code) {
  const m = String(code || '').match(/^(\d+)([אב])$/);
  return m ? parseInt(m[1], 10) * 2 + (m[2] === 'ב' ? 1 : 0) : -1;
}

function calculateNextCode(lastCode) {
  const match = String(lastCode || '').match(/^(\d+)([אב])$/);
  if (!match) return '1א';
  const num = parseInt(match[1], 10);
  return match[2] === 'א' ? `${num}ב` : `${num + 1}א`;
}

// הקוד הבא = אחרי הקוד הגבוה ביותר שקיים (כולל מבחנים שנמחקו, כדי לא להשתמש שוב בקוד ישן)
async function getNextExamCode(env) {
  const { results } = await env.DB.prepare("SELECT exam_code FROM exams").all();
  let best = null, bestRank = -1;
  for (const r of results) {
    const rank = codeRank(r.exam_code);
    if (rank > bestRank) { bestRank = rank; best = r.exam_code; }
  }
  return calculateNextCode(best);
}

// ---------- ולידציה ----------

function fail(message) { return { ok: false, message }; }

function cleanStr(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function normalizeGrade(v) {
  const s = cleanStr(v, 12).replace(/כיתה/g, '').replace(/['"׳״]/g, '').trim();
  if (!s) return { ok: true, value: null };
  if (GRADE_VALUES[s]) return { ok: true, value: s };
  const n = parseInt(s, 10);
  if (!isNaN(n) && n >= 1 && n <= 12) return { ok: true, value: GRADE_LETTERS[n - 1] };
  return { ok: false };
}

// מחזיר את השדות הנקיים לשמירה (שדות שלא שייכים לסוג המבחן מאופסים)
function validateExam(body) {
  if (!body || typeof body !== 'object') return fail('נתונים חסרים');

  const type = body.exam_type;
  if (!TYPES.includes(type)) return fail('יש לבחור סוג מבחן: משניות או גמרא');

  const masechet = cleanStr(body.masechet, 40);
  if (!masechet) return fail('חובה להזין שם מסכת');

  const grade = normalizeGrade(body.target_grade);
  if (!grade.ok) return fail('כיתת יעד לא תקינה (אפשר להשאיר ריק, או א עד יב)');

  const data = {
    exam_type: type, masechet,
    chapter_num: null, chapter_name: null, chapter_title: cleanStr(body.chapter_title, 120) || null,
    from_page: null, to_page: null, total_mishnayot: null, gemara_pages: null,
    target_grade: grade.value
  };

  if (type === 'mishnayot') {
    const num = body.chapter_num === '' || body.chapter_num == null ? null : Number(body.chapter_num);
    if (num !== null && (!Number.isInteger(num) || num < 1 || num > 99)) return fail('מספר פרק חייב להיות מספר שלם בין 1 ל-99');
    const name = cleanStr(body.chapter_name, 30);
    if (num === null && !name) return fail('יש להזין מספר פרק או שם פרק');
    const count = Number(body.total_mishnayot);
    if (!Number.isInteger(count) || count < 1 || count > 99) return fail('מספר המשניות חייב להיות מספר שלם בין 1 ל-99');
    data.chapter_num = num;
    data.chapter_name = name || null;
    data.total_mishnayot = count;
  } else {
    const from = cleanStr(body.from_page, 10), to = cleanStr(body.to_page, 10);
    if (!from || !to) return fail('בגמרא חובה להזין "מדף" ו"עד דף"');
    const pages = Number(body.gemara_pages);
    if (!isFinite(pages) || pages <= 0 || pages > 99) return fail('מספר הדפים חייב להיות מספר חיובי (עד 99)');
    data.from_page = from;
    data.to_page = to;
    data.gemara_pages = Math.round(pages * 10) / 10;
  }
  return { ok: true, data };
}

// ---------- אריזה ושליפה ----------

function formatExam(exam, usage) {
  if (!exam) return exam;

  const formatted = {
    id: exam.id,
    exam_code: exam.exam_code,
    exam_type: exam.exam_type || 'unknown',
    target_grade: exam.target_grade,
    reward_price: Math.round((exam.reward_price || 0) * 100) / 100,
    is_deleted: exam.is_deleted === 1
  };
  if (usage !== undefined) formatted.results_count = usage;

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
      chapter_title: exam.chapter_title,
      from_page: exam.from_page,
      to_page: exam.to_page,
      gemara_pages: exam.gemara_pages
    };
  } else {
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

const REWARD_SQL = `(
  IFNULL(e.total_mishnayot, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'mishnayot') +
  IFNULL(e.gemara_pages, 0) * (SELECT price_per_unit FROM reward_rates WHERE unit_type = 'gemara_pages')
) as reward_price`;

async function fetchByCodes(env, codes) {
  if (codes.length === 0) return [];
  const marks = codes.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT e.*, ${REWARD_SQL} FROM exams e WHERE e.exam_code IN (${marks}) ORDER BY e.id ASC`
  ).bind(...codes).all();
  return results.map(r => formatExam(r));
}

const INSERT_SQL = `
  INSERT INTO exams (
    exam_code, exam_type, masechet, chapter_num, chapter_name, chapter_title,
    from_page, to_page, total_mishnayot, gemara_pages, target_grade
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const insertArgs = (code, d) => [
  code, d.exam_type, d.masechet, d.chapter_num, d.chapter_name, d.chapter_title,
  d.from_page, d.to_page, d.total_mishnayot, d.gemara_pages, d.target_grade
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

// ---------- ה-handler ----------

export default async function examsHandler(request, env) {
  const url = new URL(request.url);
  const method = request.method;

  const pathParts = url.pathname.split('/');
  const examCode = pathParts[4] ? decodeURIComponent(pathParts[4]) : null;
  const subAction = pathParts[5] ? decodeURIComponent(pathParts[5]) : null;

  try {
    // ----- ייבוא מרוכז עם קודים מפורשים (ללא שינוי) -----
    if (method === 'POST' && examCode === 'bulk') {
      const examsArray = await request.json();
      const validExams = examsArray.filter(exam => exam && exam.exam_code);

      if (validExams.length === 0) return json({ error: 'No valid data to insert' }, 400);

      const stmts = validExams.map(exam =>
        env.DB.prepare(INSERT_SQL).bind(
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
      return json({ success: true, count: results.length }, 201);
    }

    // ----- מידע עזר: מחירון והקוד הבא -----
    if (method === 'GET' && examCode === 'meta') {
      const { results } = await env.DB.prepare("SELECT unit_type, price_per_unit FROM reward_rates").all();
      const rates = {};
      results.forEach(r => { rates[r.unit_type] = r.price_per_unit; });
      return json({ rates, next_code: await getNextExamCode(env) });
    }

    // ----- רשימת מבחנים -----
    if (method === 'GET' && !examCode) {
      const includeDeleted = url.searchParams.get('include_deleted') === 'true';
      const withUsage = url.searchParams.get('with_usage') === 'true';

      const { results } = await env.DB.prepare(`
        SELECT e.*, ${REWARD_SQL}
        FROM exams e
        ${includeDeleted ? '' : 'WHERE e.is_deleted = 0'}
        ORDER BY e.id ASC
      `).all();

      let usage = null;
      if (withUsage) {
        // כמה תלמידים (פעילים) כבר נבחנו בכל מבחן — שאילתה אחת מקובצת
        const u = await env.DB.prepare(`
          SELECT se.exam_code, COUNT(*) AS c
          FROM student_exams se
          JOIN students s ON s.student_code = se.student_code AND s.is_deleted = 0
          GROUP BY se.exam_code
        `).all();
        usage = {};
        u.results.forEach(r => { usage[r.exam_code] = r.c; });
      }

      return json(results.map(r => formatExam(r, usage ? (usage[r.exam_code] || 0) : undefined)));
    }

    // ----- מבחן חדש (הקוד נקבע אוטומטית) -----
    if (method === 'POST' && !examCode) {
      const v = validateExam(await request.json());
      if (!v.ok) return json({ error: 'Validation failed', message: v.message }, 400);

      const code = await getNextExamCode(env);
      await env.DB.prepare(INSERT_SQL).bind(...insertArgs(code, v.data)).run();
      const [created] = await fetchByCodes(env, [code]);
      return json(created, 201);
    }

    // ----- כמה מבחנים בבת אחת, קודים רצופים (הכול או כלום) -----
    if (method === 'POST' && examCode === 'series') {
      const body = await request.json();
      const list = body && Array.isArray(body.exams) ? body.exams : null;
      if (!list || list.length === 0) return json({ error: 'Validation failed', message: 'לא נשלחו מבחנים להוספה' }, 400);
      if (list.length > MAX_SERIES) return json({ error: 'Validation failed', message: `אפשר להוסיף עד ${MAX_SERIES} מבחנים בבת אחת` }, 400);

      const cleaned = [];
      for (let i = 0; i < list.length; i++) {
        const v = validateExam(list[i]);
        if (!v.ok) return json({ error: 'Validation failed', message: `שורה ${i + 1}: ${v.message}` }, 400);
        cleaned.push(v.data);
      }

      let code = await getNextExamCode(env);
      const codes = [];
      const stmts = cleaned.map(d => {
        codes.push(code);
        const st = env.DB.prepare(INSERT_SQL).bind(...insertArgs(code, d));
        code = calculateNextCode(code);
        return st;
      });
      await env.DB.batch(stmts);
      return json({ success: true, count: codes.length, created: await fetchByCodes(env, codes) }, 201);
    }

    // ----- שחזור מבחן שנמחק -----
    if (method === 'POST' && examCode && subAction === 'restore') {
      const r = await env.DB.prepare("UPDATE exams SET is_deleted = 0 WHERE exam_code = ? AND is_deleted = 1").bind(examCode).run();
      if (r.meta.changes === 0) return json({ error: 'Not found' }, 404);
      const [restored] = await fetchByCodes(env, [examCode]);
      return json(restored, 200);
    }

    // ----- עדכון מבחן (הקוד לא משתנה) -----
    if (method === 'PUT' && examCode && examCode !== 'bulk') {
      const v = validateExam(await request.json());
      if (!v.ok) return json({ error: 'Validation failed', message: v.message }, 400);
      const d = v.data;

      const r = await env.DB.prepare(`
        UPDATE exams SET
          exam_type = ?, masechet = ?, chapter_num = ?, chapter_name = ?, chapter_title = ?,
          from_page = ?, to_page = ?, total_mishnayot = ?, gemara_pages = ?, target_grade = ?
        WHERE exam_code = ? AND is_deleted = 0
      `).bind(d.exam_type, d.masechet, d.chapter_num, d.chapter_name, d.chapter_title,
              d.from_page, d.to_page, d.total_mishnayot, d.gemara_pages, d.target_grade, examCode).run();

      if (r.meta.changes === 0) return json({ error: 'Not found' }, 404);
      const [updated] = await fetchByCodes(env, [examCode]);
      return json(updated, 200);
    }

    // ----- מחיקה רכה -----
    if (method === 'DELETE' && examCode && examCode !== 'bulk') {
      const result = await env.DB.prepare("UPDATE exams SET is_deleted = 1 WHERE exam_code = ? AND is_deleted = 0").bind(examCode).run();
      if (result.meta.changes === 0) return json({ error: 'Not found' }, 404);
      return json({ success: true });
    }

    return json({ error: 'Method Not Allowed' }, 405);

  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      return json({ error: 'Duplicate', message: 'קוד המבחן כבר קיים במערכת' }, 409);
    }
    return json({ error: error.message }, 500);
  }
}
