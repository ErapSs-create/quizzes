// Сервер викторин. Без зависимостей.
//   Локально:  node server.js            → http://localhost:3000
//   На Render: порт берётся из PORT, пароль ведущего — из HOST_PASSWORD.
// Каждая викторина живёт по своему адресу: /finance и /rudn (игроки), /finance/host и /rudn/host (ведущий).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const QUIZZES = require('./quizzes.js');
const PORT = Number(process.env.PORT) || Number(process.argv.find((a, i) => i > 1 && /^\d+$/.test(a))) || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || '';

const MAX_POINTS = 1000;
const MIN_POINTS = 500;
const DECAY_MS = 20000;

function pointsFor(ms) {
  const t = Math.min(Math.max(ms, 0), DECAY_MS) / DECAY_MS;
  return Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * t);
}

// ---------- одна игра на каждую викторину ----------
class Game {
  constructor(id, quiz) {
    this.id = id;
    this.quiz = quiz;
    this.clients = new Set(); // {res, role, pid}
    this.reset();
  }

  reset() {
    this.phase = 'lobby'; // lobby | question | reveal | final
    this.index = -1;
    this.qStart = 0;
    this.players = new Map(); // pid -> {pid, name, score, correct, totalMs, joined, answers}
  }

  question() { return this.index >= 0 ? this.quiz.questions[this.index] : null; }

  ranking() {
    return [...this.players.values()]
      .sort((a, b) => b.score - a.score || b.correct - a.correct || a.totalMs - b.totalMs || a.joined - b.joined)
      .map((p, i) => ({ pid: p.pid, name: p.name, score: p.score, correct: p.correct, place: i + 1 }));
  }

  answered() {
    let n = 0;
    for (const p of this.players.values()) if (p.answers[this.index]) n++;
    return n;
  }

  counts() {
    const q = this.question();
    const c = q ? q.options.map(() => 0) : [];
    for (const p of this.players.values()) { const a = p.answers[this.index]; if (a) c[a.choice]++; }
    return c;
  }

  hostView() {
    const q = this.question();
    const reveal = this.phase === 'reveal';
    return {
      role: 'host', title: this.quiz.title, subtitle: this.quiz.subtitle,
      phase: this.phase, index: this.index, total: this.quiz.questions.length,
      qStart: this.qStart, now: Date.now(), decayMs: DECAY_MS,
      question: q ? { text: q.text, options: q.options } : null,
      correct: reveal ? q.answer : null,
      note: reveal ? q.note || null : null,
      counts: reveal ? this.counts() : null,
      answered: this.answered(),
      players: [...this.players.values()].map((p) => p.name),
      ranking: this.ranking(),
      lanUrls: lanUrls(this.id),
    };
  }

  playerView(pid) {
    const p = this.players.get(pid);
    const q = this.question();
    const rank = this.ranking();
    const me = rank.find((r) => r.pid === pid);
    const mine = p && p.answers[this.index];
    const reveal = this.phase === 'reveal';
    return {
      role: 'player', title: this.quiz.title,
      phase: this.phase, index: this.index, total: this.quiz.questions.length,
      joined: !!p, name: p ? p.name : null,
      question: q && (this.phase === 'question' || reveal) ? { text: q.text, options: q.options } : null,
      myChoice: mine ? mine.choice : null,
      lastPoints: mine ? mine.points : 0,
      correct: reveal ? q.answer : null,
      note: reveal ? q.note || null : null,
      score: p ? p.score : 0,
      correctCount: p ? p.correct : 0,
      place: me ? me.place : null,
      playersTotal: rank.length,
      top3: this.phase === 'final' ? rank.slice(0, 3) : null,
    };
  }

  send(c) {
    const data = c.role === 'host' ? this.hostView() : this.playerView(c.pid);
    c.res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  broadcast() { for (const c of this.clients) this.send(c); }

  start(i) { this.index = i; this.phase = 'question'; this.qStart = Date.now(); }

  host(action) {
    switch (action) {
      case 'start': if (this.phase === 'lobby') this.start(0); break;
      case 'reveal': if (this.phase === 'question') this.phase = 'reveal'; break;
      case 'next':
        if (this.phase === 'question') this.phase = 'reveal';
        else if (this.phase === 'reveal') {
          if (this.index + 1 < this.quiz.questions.length) this.start(this.index + 1);
          else this.phase = 'final';
        }
        break;
      case 'finish': this.phase = 'final'; break;
      case 'reset': this.reset(); break;
      case 'ping': break; // проверка пароля

      default: return false;
    }
    return true;
  }

  join(body) {
    if (body.pid && this.players.has(body.pid)) return { pid: body.pid };
    let base = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!base) return { error: 'Введите имя' };
    if (this.players.size >= 300) return { error: 'В игре уже слишком много участников' };
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    let name = base, n = 2;
    while (taken.has(name.toLowerCase())) name = base + ' ' + n++;
    const pid = crypto.randomBytes(9).toString('hex');
    this.players.set(pid, { pid, name, score: 0, correct: 0, totalMs: 0, joined: Date.now(), answers: {} });
    return { pid };
  }

  answer(body) {
    const p = this.players.get(body.pid);
    const q = this.question();
    if (!p || this.phase !== 'question' || body.index !== this.index) return { error: 'Вопрос уже закрыт' };
    if (p.answers[this.index]) return { error: 'Ответ уже принят' };
    const choice = Number(body.choice);
    if (!(choice >= 0 && choice < q.options.length)) return { error: 'Нет такого варианта' };
    const ms = Date.now() - this.qStart;
    const ok = choice === q.answer;
    const points = ok ? pointsFor(ms) : 0;
    p.answers[this.index] = { choice, ms, points };
    p.score += points;
    if (ok) { p.correct++; p.totalMs += ms; }
    if (this.answered() >= this.players.size) this.phase = 'reveal'; // все ответили — сразу показываем ответ
    return { ok: true };
  }
}

const games = {};
for (const [id, quiz] of Object.entries(QUIZZES)) games[id] = new Game(id, quiz);

setInterval(() => {
  for (const g of Object.values(games)) for (const c of g.clients) c.res.write(': ping\n\n');
}, 15000);

// ---------- доступ ведущего ----------
function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return !req.headers['x-forwarded-for'] && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1');
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// С паролем — пускаем по паролю откуда угодно. Без пароля — только с этого же компьютера.
function isHost(req, key) {
  if (HOST_PASSWORD) return safeEqual(key || '', HOST_PASSWORD);
  return isLocal(req);
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const STATIC = new Set(['style.css', 'qrcode.js']);

function serveFile(res, file) {
  fs.readFile(path.join(PUBLIC, file), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts.length === 0) return serveFile(res, 'index.html');
  if (parts.length === 1 && STATIC.has(parts[0])) return serveFile(res, parts[0]);
  if (parts[0] === 'healthz') return json(res, 200, { ok: true });

  const game = games[parts[0]];
  if (!game) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Нет такой викторины'); }
  const rest = parts.slice(1).join('/');

  if (req.method === 'GET' && rest === '') return serveFile(res, 'play.html');
  if (req.method === 'GET' && rest === 'host') return serveFile(res, 'host.html');

  if (req.method === 'GET' && rest === 'events') {
    const wantsHost = url.searchParams.get('role') === 'host';
    if (wantsHost && !isHost(req, url.searchParams.get('key'))) return json(res, 403, { error: 'Неверный пароль ведущего' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const c = { res, role: wantsHost ? 'host' : 'player', pid: url.searchParams.get('pid') || '' };
    game.clients.add(c);
    req.on('close', () => game.clients.delete(c));
    return game.send(c);
  }

  if (req.method === 'POST' && rest === 'api/join') {
    const r = game.join(await readBody(req));
    if (r.error) return json(res, 400, r);
    game.broadcast();
    return json(res, 200, r);
  }

  if (req.method === 'POST' && rest === 'api/answer') {
    const r = game.answer(await readBody(req));
    if (r.error) return json(res, 409, r);
    game.broadcast();
    return json(res, 200, r);
  }

  if (req.method === 'POST' && rest.startsWith('api/host/')) {
    if (!isHost(req, req.headers['x-host-key'])) {
      return json(res, 403, { error: HOST_PASSWORD ? 'Неверный пароль ведущего' : 'Управлять игрой можно только с компьютера ведущего' });
    }
    if (!game.host(rest.slice('api/host/'.length))) return json(res, 404, { error: 'Нет такого действия' });
    game.broadcast();
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

// Адреса в локальной сети — для запуска на своём компьютере. На Render их нет, там ссылка берётся из адреса сайта.
function lanUrls(id) {
  if (process.env.RENDER) return [];
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      // 169.254.x.x — адреса отключённых адаптеров, с телефона они не открываются
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push('http://' + a.address + ':' + PORT + '/' + id);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Викторины запущены на порту ' + PORT + (HOST_PASSWORD ? ' (ведущий входит по паролю)' : ''));
  for (const [id, g] of Object.entries(games)) {
    console.log('\n  ' + g.quiz.title + ' — ' + g.quiz.questions.length + ' вопросов');
    console.log('    Ведущий: http://localhost:' + PORT + '/' + id + '/host');
    for (const u of lanUrls(id)) console.log('    Игроки:  ' + u);
  }
  console.log('\n  Остановить: Ctrl+C\n');
  const open = process.argv.find((a) => a.startsWith('--open='));
  if (open && process.platform === 'win32') {
    require('child_process').exec('start "" "http://localhost:' + PORT + '/' + open.slice(7) + '/host"');
  }
});
