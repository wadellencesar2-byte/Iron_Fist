// ============================================================
// BANCO DE DADOS — Iron Fist
// ============================================================
// Guarda tudo num arquivo "database.json" nesta mesma pasta, usando só o
// próprio Node (nada de instalar/compilar nada). Isso é de propósito: a
// versão anterior usava "better-sqlite3", que precisa compilar código
// nativo durante o "npm install" — e isso costuma falhar silenciosamente
// em vários serviços de hospedagem, deixando o servidor fora do ar sem
// nenhum aviso claro do motivo. Esse arquivo aqui não tem esse risco:
// é só JavaScript puro, funciona igual em qualquer lugar que rode Node.
//
// ⚠️ IMPORTANTE sobre o Render (plano gratuito):
// O disco do plano free do Render é "temporário" — toda vez que o serviço
// reinicia ou você faz um novo deploy, o database.json volta do zero.
// Pra testar e usar no dia a dia funciona liso; se quiser que os dados
// NUNCA se percam (mesmo depois de redeploys), as opções são:
//   1) Adicionar um "Persistent Disk" no Render (pago) e apontar o
//      caminho do banco pra dentro dele.
//   2) Usar um banco externo de verdade (ex: MongoDB Atlas, que tem
//      plano grátis) — dá mais trabalho de configurar, mas é 100%
//      persistente e também não depende de compilar nada nativo.
// ============================================================

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { users: {}, nextId: 1 }; // users: nomeNormalizado -> {id, username, passwordHash, avatar, save}
  }
}
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data));
}

// nomes de usuário são únicos SEM diferenciar maiúscula/minúscula
// (ex: "Cesar" e "cesar" contam como o mesmo nome) — evita gente repetida
function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function findUser(username) {
  const dbData = loadDB();
  return dbData.users[normalizeUsername(username)] || null;
}

function createUser(username, password) {
  const clean = String(username || '').trim().slice(0, 20);
  if (!clean) throw { code: 'invalid_name' };
  const norm = normalizeUsername(clean);
  const dbData = loadDB();
  if (dbData.users[norm]) throw { code: 'name_taken' };
  const id = dbData.nextId++;
  const hash = bcrypt.hashSync(password, 10);
  dbData.users[norm] = { id, username: clean, passwordHash: hash, avatar: '👊', save: {} };
  saveDB(dbData);
  return { id, username: clean, avatar: '👊', save: {} };
}

function verifyLogin(username, password) {
  const user = findUser(username);
  if (!user) return { ok: false, reason: 'not_found' };
  const valid = bcrypt.compareSync(password, user.passwordHash);
  if (!valid) return { ok: false, reason: 'wrong_password' };
  return { ok: true, id: user.id, username: user.username, avatar: user.avatar, save: user.save || {} };
}

function saveProgress(username, password, saveData, avatar) {
  const check = verifyLogin(username, password);
  if (!check.ok) return check;
  const dbData = loadDB();
  const norm = normalizeUsername(username);
  const user = dbData.users[norm];
  if (!user) return { ok: false };
  user.save = saveData || {};
  if (avatar) user.avatar = avatar;
  saveDB(dbData);
  return { ok: true };
}

// ranking: pega o "highScore" de dentro do save de todo mundo e ordena
function getLeaderboard(limit = 20) {
  const dbData = loadDB();
  const list = Object.values(dbData.users).map(u => ({
    username: u.username,
    avatar: u.avatar,
    highScore: (u.save && u.save.highScore) || 0,
    totalKills: (u.save && u.save.totalKills) || 0,
    maxStage: (u.save && u.save.maxStage) || 1,
    zombieBest: (u.save && u.save.zombieBest) || 0
  }));
  list.sort((a, b) => b.highScore - a.highScore);
  return list.slice(0, limit);
}

function findUserById(id) {
  const dbData = loadDB();
  return Object.values(dbData.users).find(u => u.id === Number(id)) || null;
}

// usado só pelo painel ADMIN: soma moedas/gemas na conta de alguém, direto pelo ID da conta
function adminAddCurrency(targetId, coins, gems) {
  const dbData = loadDB();
  const norm = Object.keys(dbData.users).find(k => dbData.users[k].id === Number(targetId));
  if (!norm) return { ok: false, reason: 'not_found' };
  const user = dbData.users[norm];
  user.save = user.save || {};
  user.save.coins = Math.max(0, (user.save.coins || 0) + (coins || 0));
  user.save.gems = Math.max(0, (user.save.gems || 0) + (gems || 0));
  saveDB(dbData);
  return { ok: true, username: user.username, coins: user.save.coins, gems: user.save.gems };
}

module.exports = { createUser, verifyLogin, saveProgress, getLeaderboard, findUser, findUserById, adminAddCurrency };
