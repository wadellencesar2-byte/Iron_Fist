// ============================================================
// SERVIDOR MULTIPLAYER — Iron Fist (Invasão Zumbi Co-op)
// ============================================================
// O que esse arquivo faz:
//  - Serve o seu index.html (assim as pessoas acessam o jogo direto pela URL do Render)
//  - Cria um servidor WebSocket que gerencia SALAS de até 4 jogadores
//  - Repassa posição dos jogadores E o estado dos zumbis pra todo mundo da sala
//  - Quem decide a vida/morte de cada zumbi de verdade é o jogo de quem CRIOU a
//    sala (o "host") — o servidor só repassa as mensagens, não roda o jogo.
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

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_PLAYERS_PER_ROOM = 4; // Invasão Zumbi co-op é pra até 4 jogadores por sala
const rooms = {}; // "CÓDIGO" -> { players: Map(id -> {ws, name, state}), hostId }

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

function leaveRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms[code];
  if (!room) return;
  room.players.delete(ws.playerId);
  broadcastToRoom(code, { type: 'player_left', id: ws.playerId });
  if (room.players.size === 0) delete rooms[code]; // sala vazia some sozinha
  ws.roomCode = null;
}

function sendToHost(code, obj) {
  const room = rooms[code];
  if (!room) return;
  const hostP = room.players.get(room.hostId);
  if (hostP) send(hostP.ws, obj);
}

function sendToPlayer(code, targetId, obj) {
  const room = rooms[code];
  if (!room) return;
  const p = room.players.get(targetId);
  if (p) send(p.ws, obj);
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
      rooms[code] = { players: new Map(), hostId: id };
      rooms[code].players.set(id, { ws, name: String(msg.name || 'Jogador').slice(0, 14), state: {} });
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
      room.players.set(id, { ws, name, state: {} });
      ws.roomCode = code;
      send(ws, { type: 'room_joined', code, id, players: existingPlayers });
      broadcastToRoom(code, { type: 'player_joined', id, name }, id);

    // ---- sair da sala ----
    } else if (msg.type === 'leave_room') {
      leaveRoom(ws);

    // ---- posição/estado do jogador (enviado várias vezes por segundo) ----
    } else if (msg.type === 'state') {
      const room = rooms[ws.roomCode];
      if (!room) return;
      const p = room.players.get(id);
      if (p) p.state = msg.state;
      broadcastToRoom(ws.roomCode, { type: 'state_update', id, state: msg.state }, id);

    // ---- host avisando que a partida começou ----
    } else if (msg.type === 'start_match') {
      broadcastToRoom(ws.roomCode, { type: 'start_match' }, id);

    // ---- host mandando o estado de todos os zumbis (várias vezes por segundo) ----
    } else if (msg.type === 'zombie_state') {
      broadcastToRoom(ws.roomCode, { type: 'zombie_state', zombies: msg.zombies, timer: msg.timer }, id);

    // ---- qualquer jogador avisando que acertou um zumbi — só o HOST decide o dano de verdade ----
    } else if (msg.type === 'zombie_hit') {
      sendToHost(ws.roomCode, { type: 'zombie_hit', zombieId: msg.zombieId, damage: msg.damage, from: id });

    // ---- host avisando que um zumbi morreu — todo mundo ganha a mesma recompensa ----
    } else if (msg.type === 'zombie_died') {
      broadcastToRoom(ws.roomCode, { type: 'zombie_died', coins: msg.coins, points: msg.points }, id);

    // ---- host avisando que um zumbi acertou um convidado específico ----
    } else if (msg.type === 'player_hurt') {
      sendToPlayer(ws.roomCode, msg.targetId, { type: 'player_hurt', damage: msg.damage });
    }
  });

  ws.on('close', () => leaveRoom(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Servidor do Iron Fist rodando na porta ' + PORT);
});
