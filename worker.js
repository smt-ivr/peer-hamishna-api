import indexHtml from './index.html';
import stylesCss from './styles.css';
import clientAppJs from './client-app.js';
import clientExamUpdateJs from './client-exam-update.js';
import clientStudentsJs from './client-students.js';
import clientExamsJs from './client-exams.js';
import clientHistoryJs from './client-history.js';
import clientReportsJs from './client-reports.js'; // התווסף

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/peer' || path === '/peer/' || path === '/peer/index.html') {
      return new Response(indexHtml, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (path === '/peer/styles.css') {
      return new Response(stylesCss, { status: 200, headers: { 'Content-Type': 'text/css; charset=utf-8' } });
    }
    if (path === '/peer/client-app.js') {
      return new Response(clientAppJs, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
    }
    if (path === '/peer/client-exam-update.js') {
      return new Response(clientExamUpdateJs, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
    }
    if (path === '/peer/client-students.js') {
      return new Response(clientStudentsJs, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
    }
    if (path === '/peer/client-exams.js') {
      return new Response(clientExamsJs, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
    }
    if (path === '/peer/client-history.js') {
      return new Response(clientHistoryJs, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
    }
    if (path === '/peer/client-reports.js') {
      return new Response(clientReportsJs, { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
    }

    return new Response('404 - Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
};
