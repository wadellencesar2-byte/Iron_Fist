// ============================================================
// SERVIDOR MULTIPLAYER — Iron Fist (Invasão Zumbi Co-op)
// ============================================================
// O que esse arquivo faz:
//  - Serve o seu index.html (assim as pessoas acessam o jogo direto pela URL do Render)
//  - Cria um servidor WebSocket que gerencia SALAS de até 4 jogadores
//  - O PRÓPRIO SERVIDOR roda a invasão de zumbi (spawna, movimenta, decide vida e
//    ataque) — ninguém tem "poder especial" por ter criado a sala. Todo mundo é
//    tratado exatamente igual: todos mandam posição, todos podem acertar qualquer
//    zumbi, todos podem apertar "Começar Partida". Se alguém sair ou fechar o
//    jogo, a partida continua normal pros outros, porque não depende do
//    aparelho de ninguém — só do servidor.
//
// Rodar localmente pra testar:
//   1) npm install
//   2) npm start
//   3) abra http://localhost:3000 no navegador (em duas abas, pra testar com "2 jogadores")
//
// Publicar no Render: veja o README.md
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const db = require('./db.js');

const app = express();
app.use(express.json()); // pra ler o corpo (JSON) das requisições de login/registro/save

// serve o index.html (e qualquer outro arquivo que você colocar na mesma pasta)
app.use(express.static(path.join(__dirname)));

// ---- ROTAS DE CONTA (banco de dados) ----

// cria uma conta nova. Dá erro 409 se o nome já existir (nomes repetidos são proibidos)
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || String(username).trim().length < 2 || String(password).length < 3) {
    return res.status(400).json({ message: 'Usuário precisa de ao menos 2 letras e senha ao menos 3 caracteres.' });
  }
  try {
    const user = db.createUser(username, password);
    res.json({ id: user.id, username: user.username, avatar: user.avatar, save: user.save });
  } catch (e) {
    if (e && e.code === 'name_taken') return res.status(409).json({ message: 'Esse nome de usuário já está em uso.' });
    res.status(500).json({ message: 'Erro ao criar conta.' });
  }
});

// login numa conta existente
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ message: 'Preencha usuário e senha.' });
  const result = db.verifyLogin(username, password);
  if (!result.ok) {
    if (result.reason === 'not_found') return res.status(404).json({ message: 'Conta não encontrada.' });
    return res.status(401).json({ message: 'Senha incorreta.' });
  }
  res.json({ id: result.id, username: result.username, avatar: result.avatar, save: result.save });
});

// salva o progresso (moedas, upgrades, etc.) — manda usuário+senha de novo pra confirmar que é você
app.post('/api/save', (req, res) => {
  const { username, password, save, avatar } = req.body || {};
  if (!username || !password) return res.status(400).json({ message: 'Preencha usuário e senha.' });
  const result = db.saveProgress(username, password, save, avatar);
  if (!result.ok) return res.status(401).json({ message: 'Não foi possível salvar (login inválido).' });
  res.json({ ok: true });
});

// ranking dos jogadores (por recorde de pontos)
app.get('/api/leaderboard', (req, res) => {
  try {
    res.json(db.getLeaderboard(20));
  } catch (e) {
    res.status(500).json({ message: 'Erro ao buscar ranking.' });
  }
});

// ---- ROTA ADMIN: enviar moedas/gemas pra qualquer conta pelo ID ----
// só funciona pra quem loga como CESAR/12345 (a mesma trava que libera o botão admin no jogo)
const ADMIN_USER = 'cesar', ADMIN_PASS = '12345';
app.post('/api/admin/send-currency', (req, res) => {
  const { adminUser, adminPass, targetId, coins, gems } = req.body || {};
  if (String(adminUser || '').trim().toLowerCase() !== ADMIN_USER || String(adminPass) !== ADMIN_PASS) {
    return res.status(403).json({ message: 'Acesso negado — só a conta admin pode fazer isso.' });
  }
  const id = parseInt(targetId, 10);
  if (!id) return res.status(400).json({ message: 'ID da conta inválido.' });
  const c = parseInt(coins, 10) || 0, g = parseInt(gems, 10) || 0;
  const result = db.adminAddCurrency(id, c, g);
  if (!result.ok) return res.status(404).json({ message: 'Não existe conta com esse ID.' });
  res.json(result);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_PLAYERS_PER_ROOM = 4; // Invasão Zumbi co-op é pra até 4 jogadores por sala
const rooms = {}; // "CÓDIGO" -> { players: Map(id -> {ws, name, state}), match }

let nextId = 1;

function generateRoomCode() {
  // sem 0/O e 1/I, pra ninguém confundir o código na hora de digitar
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastToRoom(code, obj, exceptId = null) {
  const room = rooms[code];
  if (!room) return;
  for (const [id, p] of room.players) {
    if (id !== exceptId) send(p.ws, obj);
  }
}

function sendToPlayer(code, targetId, obj) {
  const room = rooms[code];
  if (!room) return;
  const p = room.players.get(targetId);
  if (p) send(p.ws, obj);
}

function stopMatch(room) {
  if (room.match && room.match.tickHandle) clearInterval(room.match.tickHandle);
  room.match = null;
}

function leaveRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms[code];
  if (!room) return;
  room.players.delete(ws.playerId);
  broadcastToRoom(code, { type: 'player_left', id: ws.playerId });
  if (room.players.size === 0) {
    stopMatch(room); // sala vazia — para a invasão e libera o intervalo, sem deixar nada rodando à toa
    delete rooms[code];
  } else {
    broadcastToRoom(code, { type: 'ready_update', players: getReadyList(room) });
    if (!room.match) checkAllReady(room); // se só faltava quem saiu pra completar, começa agora
  }
  ws.roomCode = null;
}

// ============================================================
// INVASÃO ZUMBI — simulação roda AQUI, no servidor, pra ser igual pra todo mundo
// ============================================================
const ZOMBIE_CFG = {
  zombie:      { w: 14, h: 20, hp: 45,  speed: 24, damage: 14, points: 60,  coins: 2 },
  zombie_fast: { w: 12, h: 18, hp: 28,  speed: 58, damage: 12, points: 70,  coins: 2 },
  zombie_tank: { w: 18, h: 23, hp: 110, speed: 16, damage: 22, points: 100, coins: 3 }
};
const ZOMBIE_TYPES = Object.keys(ZOMBIE_CFG);
const ARENA_WORLD_W = 60 * 16; // tem que bater com generateZombieArena() do index.html (60 colunas de 16px)

function spawnServerZombie(match) {
  const type = ZOMBIE_TYPES[Math.floor(Math.random() * ZOMBIE_TYPES.length)];
  const cfg = ZOMBIE_CFG[type];
  const fromRight = Math.random() < 0.5;
  const t = match.timer;
  const hpMult = Math.min(4, 1 + t * 0.025);
  const dmgMult = Math.min(2.5, 1 + t * 0.015);
  const id = match.nextZombieId++;
  match.zombies.set(id, {
    id, type, w: cfg.w, h: cfg.h,
    x: fromRight ? ARENA_WORLD_W - 14 : 14, y: 50,
    hp: Math.round(cfg.hp * hpMult), maxHp: Math.round(cfg.hp * hpMult),
    speed: cfg.speed, damage: Math.round(cfg.damage * dmgMult),
    points: cfg.points, coins: cfg.coins,
    dir: fromRight ? -1 : 1, state: 'walk', alive: true, attackCooldown: 0
  });
}

function startMatch(room) {
  stopMatch(room);
  room.match = { timer: 0, spawnTimer: 1, zombies: new Map(), nextZombieId: 1, tickHandle: null };
  room.match.tickHandle = setInterval(() => tickMatch(room), 150);
}

function tickMatch(room) {
  const m = room.match;
  if (!m) return;
  const dt = 0.15;
  m.timer += dt;

  const players = [...room.players.entries()].map(([id, p]) => ({
    id, x: (p.state && p.state.x) || 40, y: (p.state && p.state.y) || 50, dead: !!(p.state && p.state.dead)
  }));
  const playerCount = Math.max(1, room.players.size);

  // spawn: escala com o número de jogadores, com teto pra não pesar em ninguém
  m.spawnTimer -= dt;
  const spawnInterval = Math.max(0.75, 2.4 - m.timer * 0.012) / Math.sqrt(playerCount);
  const aliveCap = Math.min(10 * playerCount, 28);
  let aliveCount = 0;
  for (const z of m.zombies.values()) if (z.alive) aliveCount++;
  if (m.spawnTimer <= 0 && aliveCount < aliveCap) {
    m.spawnTimer = spawnInterval;
    const burst = Math.min(2, 1 + Math.floor(m.timer / 60));
    for (let i = 0; i < Math.min(burst, 3); i++) spawnServerZombie(m);
  }

  // move cada zumbi em direção ao jogador vivo mais perto, ataca quando chega perto
  for (const z of m.zombies.values()) {
    if (!z.alive) continue;
    let best = null, bestDist = Infinity;
    for (const p of players) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - z.x, p.y - z.y);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    if (best) {
      z.dir = best.x < z.x ? -1 : 1;
      if (bestDist > 14) { z.x += z.dir * z.speed * dt; z.state = 'walk'; } else { z.state = 'idle'; }
      if (z.attackCooldown > 0) z.attackCooldown -= dt;
      if (bestDist < 16 && z.attackCooldown <= 0) {
        z.attackCooldown = 1.0;
        sendToPlayer(room.code, best.id, { type: 'player_hurt', damage: z.damage });
      }
    }
  }

  // manda o estado pra TODO MUNDO por igual — inclusive quem criou a sala, não tem exceção
  const zlist = [];
  for (const z of m.zombies.values()) {
    if (!z.alive) continue;
    zlist.push({ i: z.id, t: z.type, x: Math.round(z.x), y: Math.round(z.y), h: Math.round(z.hp), m: z.maxHp, d: z.dir, s: z.state });
  }
  broadcastToRoom(room.code, { type: 'zombie_state', z: zlist, tm: Math.round(m.timer) });
}

function getReadyList(room) {
  return [...room.players.entries()].map(([pid, p]) => ({ id: pid, name: p.name, ready: !!p.ready }));
}
function checkAllReady(room) {
  if (room.match) return; // já começou, não faz nada
  const list = [...room.players.values()];
  if (list.length > 0 && list.every(p => p.ready)) {
    startMatch(room);
    broadcastToRoom(room.code, { type: 'start_match' }); // sem exceção — todo mundo recebe igual
  }
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  ws.playerId = id;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // ---- criar sala ----
    if (msg.type === 'create_room') {
      const code = generateRoomCode();
      rooms[code] = { code, players: new Map(), match: null };
      rooms[code].players.set(id, { ws, name: String(msg.name || 'Jogador').slice(0, 14), state: {}, ready: false });
      ws.roomCode = code;
      send(ws, { type: 'room_created', code, id });

    // ---- entrar numa sala existente ----
    } else if (msg.type === 'join_room') {
      const code = String(msg.code || '').toUpperCase();
      const room = rooms[code];
      if (!room) { send(ws, { type: 'error', message: 'Sala não encontrada.' }); return; }
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) { send(ws, { type: 'error', message: 'Sala cheia.' }); return; }
      const name = String(msg.name || 'Jogador').slice(0, 14);
      const existingPlayers = [...room.players.entries()].map(([pid, p]) => ({ id: pid, name: p.name }));
      room.players.set(id, { ws, name, state: {}, ready: false });
      ws.roomCode = code;
      send(ws, { type: 'room_joined', code, id, players: existingPlayers });
      broadcastToRoom(code, { type: 'player_joined', id, name }, id);
      broadcastToRoom(code, { type: 'ready_update', players: getReadyList(room) }); // novo jogador sempre entra "não pronto"

    // ---- sair da sala ----
    } else if (msg.type === 'leave_room') {
      leaveRoom(ws);

    // ---- jogador marcando/desmarcando "pronto" — só começa quando TODOS estiverem prontos ----
    } else if (msg.type === 'toggle_ready') {
      const room = rooms[ws.roomCode];
      if (!room || room.match) return; // já começou, não dá mais pra mexer
      const p = room.players.get(id);
      if (!p) return;
      p.ready = !p.ready;
      broadcastToRoom(ws.roomCode, { type: 'ready_update', players: getReadyList(room) });
      checkAllReady(room);

    // ---- posição/estado do jogador (enviado várias vezes por segundo) ----
    } else if (msg.type === 'state') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      const p = room.players.get(id);
      if (p) p.state = msg.state;
      broadcastToRoom(ws.roomCode, { type: 'state_update', id, state: msg.state }, id);

    // ---- QUALQUER jogador avisando que acertou um zumbi — o SERVIDOR decide o dano ----
    } else if (msg.type === 'zombie_hit') {
      const room = rooms[ws.roomCode];
      if (!room || !room.match) return;
      const z = room.match.zombies.get(msg.zombieId);
      if (z && z.alive) {
        z.hp -= msg.damage;
        if (z.hp <= 0) {
          z.alive = false;
          broadcastToRoom(ws.roomCode, { type: 'zombie_died', coins: z.coins, points: z.points });
        }
      }

    // ---- qualquer jogador atirando — só repassa pra desenhar o tiro nos outros aparelhos ----
    } else if (msg.type === 'bullet_fired') {
      broadcastToRoom(ws.roomCode, { type: 'bullet_fired', x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy }, id);
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Servidor do Iron Fist rodando na porta ' + PORT);
});
