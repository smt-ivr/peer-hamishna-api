import { getLocalTime } from './time.js';

// ============================================================
//  dashboard.js — נתוני לוח הבקרה (סקירה וסטטיסטיקות) בקריאה אחת
//  GET /peer/api/dashboard
//  התגמולים מחושבים כמו ב-student_summary: רק תלמידים ומבחנים פעילים.
// ============================================================

const DAYS_BACK = 30;
const TOP = 10;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const round = v => Math.round((Number(v) || 0) * 100) / 100;

// מחזיר YYYY-MM-DD של התאריך שלפני n ימים (התאריך הבסיסי בשעון ישראל)
function shiftDate(baseDate, n) {
  const d = new Date(`${baseDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export default async function dashboardHandler(request, env) {
  if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);

  try {
    const [ratesRes, examsRes, studentsRes, resultsRes] = await env.DB.batch([
      env.DB.prepare("SELECT unit_type, price_per_unit FROM reward_rates"),
      env.DB.prepare("SELECT exam_code, masechet, chapter_num, chapter_name, chapter_title, total_mishnayot, gemara_pages, target_grade FROM exams WHERE is_deleted = 0"),
      env.DB.prepare("SELECT student_code, first_name, last_name, class_grade FROM students WHERE is_deleted = 0"),
      env.DB.prepare("SELECT student_code, exam_code, passed, updated_at, update_source FROM student_exams")
    ]);

    const rates = {};
    ratesRes.results.forEach(r => rates[r.unit_type] = Number(r.price_per_unit) || 0);

    const exams = new Map();
    examsRes.results.forEach(e => exams.set(e.exam_code, {
      ...e,
      reward: (Number(e.total_mishnayot) || 0) * (rates.mishnayot || 0) + (Number(e.gemara_pages) || 0) * (rates.gemara_pages || 0)
    }));

    const students = new Map();
    studentsRes.results.forEach(s => students.set(s.student_code, {
      student_code: s.student_code,
      name: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
      class_grade: s.class_grade || 'ללא כיתה',
      attempts: 0, passed: 0, reward: 0, last_update: null
    }));

    // רק תוצאות של תלמידים ומבחנים פעילים
    const results = resultsRes.results.filter(r => students.has(r.student_code) && exams.has(r.exam_code));

    const today = getLocalTime().slice(0, 10);
    const yesterday = shiftDate(today, 1);
    const weekStart = shiftDate(today, 6);
    const monthStart = shiftDate(today, DAYS_BACK - 1);
    const inactiveSince = shiftDate(today, 13);

    const periods = {
      today: { total: 0, passed: 0 },
      yesterday: { total: 0, passed: 0 },
      week: { total: 0, passed: 0 },
      month: { total: 0, passed: 0 }
    };
    const daily = new Map();
    for (let i = DAYS_BACK - 1; i >= 0; i--) daily.set(shiftDate(today, i), { date: shiftDate(today, i), passed: 0, failed: 0 });
    const weekday = [0, 0, 0, 0, 0, 0, 0];
    const sources = { phone: 0, web: 0, other: 0 };
    const examStats = new Map();

    let passedTotal = 0;
    let rewardTotal = 0;

    for (const r of results) {
      const isPass = r.passed === 1;
      const st = students.get(r.student_code);
      const ex = exams.get(r.exam_code);
      const date = String(r.updated_at || '').slice(0, 10);

      st.attempts++;
      if (isPass) { st.passed++; st.reward += ex.reward; passedTotal++; rewardTotal += ex.reward; }
      if (r.updated_at && (!st.last_update || r.updated_at > st.last_update)) st.last_update = r.updated_at;

      const es = examStats.get(r.exam_code) || { attempts: 0, passed: 0 };
      es.attempts++; if (isPass) es.passed++;
      examStats.set(r.exam_code, es);

      const src = r.update_source === 'phone' ? 'phone' : (String(r.update_source || '').startsWith('web') ? 'web' : 'other');
      sources[src]++;

      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const bump = p => { p.total++; if (isPass) p.passed++; };
        if (date === today) bump(periods.today);
        if (date === yesterday) bump(periods.yesterday);
        if (date >= weekStart && date <= today) bump(periods.week);
        if (date >= monthStart && date <= today) bump(periods.month);
        const d = daily.get(date);
        if (d) { if (isPass) d.passed++; else d.failed++; }
        weekday[new Date(`${date}T12:00:00Z`).getUTCDay()]++;
      }
    }

    // --- לפי כיתה ---
    const classMap = new Map();
    for (const st of students.values()) {
      const c = classMap.get(st.class_grade) || { class_grade: st.class_grade, students: 0, active_students: 0, attempts: 0, passed: 0, reward: 0 };
      c.students++;
      if (st.attempts) c.active_students++;
      c.attempts += st.attempts; c.passed += st.passed; c.reward += st.reward;
      classMap.set(st.class_grade, c);
    }
    const classes = [...classMap.values()]
      .map(c => ({ ...c, reward: round(c.reward), pass_rate: pct(c.passed, c.attempts), avg_passed: c.students ? Math.round((c.passed / c.students) * 10) / 10 : 0 }))
      .sort((a, b) => String(a.class_grade).localeCompare(String(b.class_grade), 'he'));

    // --- תלמידים ---
    const studentList = [...students.values()];
    const topStudents = studentList.filter(s => s.passed > 0)
      .sort((a, b) => b.reward - a.reward || b.passed - a.passed)
      .slice(0, TOP)
      .map(s => ({ ...s, reward: round(s.reward) }));
    const noResults = studentList.filter(s => !s.attempts).length;
    const inactive = studentList
      .filter(s => s.attempts && s.last_update && s.last_update.slice(0, 10) < inactiveSince)
      .sort((a, b) => a.last_update.localeCompare(b.last_update));

    // --- מבחנים ---
    const examLabel = code => {
      const e = exams.get(code);
      return [e.masechet, e.chapter_title || e.chapter_name].filter(Boolean).join(' · ');
    };
    const examList = [...examStats.entries()].map(([code, s]) => ({
      exam_code: code, label: examLabel(code), attempts: s.attempts, passed: s.passed, pass_rate: pct(s.passed, s.attempts)
    }));
    const popularExams = [...examList].sort((a, b) => b.attempts - a.attempts).slice(0, TOP);
    const hardestExams = examList.filter(e => e.attempts >= 3)
      .sort((a, b) => a.pass_rate - b.pass_rate || b.attempts - a.attempts).slice(0, TOP);

    // --- פעילות אחרונה ---
    const recent = [...results]
      .filter(r => r.updated_at)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 15)
      .map(r => {
        const st = students.get(r.student_code);
        return {
          updated_at: r.updated_at, student_code: r.student_code, name: st.name, class_grade: st.class_grade,
          exam_code: r.exam_code, label: examLabel(r.exam_code), passed: r.passed === 1, source: r.update_source || 'unknown'
        };
      });

    const activeStudents = studentList.filter(s => s.attempts).length;

    return json({
      generated_at: getLocalTime(),
      today,
      rates,
      totals: {
        students: students.size,
        active_students: activeStudents,
        students_no_results: noResults,
        exams: exams.size,
        exams_attempted: examStats.size,
        results: results.length,
        passed: passedTotal,
        failed: results.length - passedTotal,
        pass_rate: pct(passedTotal, results.length),
        reward_total: round(rewardTotal),
        avg_reward_per_active: activeStudents ? round(rewardTotal / activeStudents) : 0,
        avg_passed_per_active: activeStudents ? Math.round((passedTotal / activeStudents) * 10) / 10 : 0
      },
      periods,
      daily: [...daily.values()],
      weekday,
      sources,
      classes,
      top_students: topStudents,
      inactive_students: inactive.slice(0, TOP).map(s => ({ student_code: s.student_code, name: s.name, class_grade: s.class_grade, last_update: s.last_update })),
      inactive_count: inactive.length,
      popular_exams: popularExams,
      hardest_exams: hardestExams,
      recent
    });
  } catch (error) {
    return json({ error: 'Server Error', message: error.message }, 500);
  }
}
