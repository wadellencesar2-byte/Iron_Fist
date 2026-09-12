// ============================================================
// BANCO DE DADOS — Iron Fist
// ============================================================
// Usa SQLite (um arquivo só, "database.sqlite", guardado nesta mesma pasta).
// Não precisa instalar nem configurar nenhum banco externo — já funciona sozinho.
//
// ⚠️ IMPORTANTE sobre o Render (plano gratuito):
// O disco do plano free do Render é "temporário" — ou seja, toda vez que o
// serviço reinicia ou você faz um novo deploy, o arquivo database.sqlite volta
// do zero. Pra testar e usar no dia a dia funciona liso; se quiser que os dados
// NUNCA se percam (mesmo depois de redeploys), as opções são:
//   1) Adicionar um "Persistent Disk" no Render (isso é pago) e apontar o
//      caminho do banco pra dentro dele.
//   2) Usar um banco externo de verdade (ex: MongoDB Atlas ou Postgres do
//      próprio Render) — dá mais trabalho de configurar, mas é 100% persistente.
// Por enquanto, o mais simples (e o que já está pronto aqui) é o SQLite local.
// ============================================================

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'database.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar TEXT DEFAULT '👊',
    save_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// nomes de usuário são únicos SEM diferenciar maiúscula/minúscula
// (ex: "Cesar" e "cesar" contam como o mesmo nome) — evita gente repetida
function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function findUser(username) {
  const norm = normalizeUsername(username);
  return db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(norm);
}

function createUser(username, password) {
  const clean = String(username || '').trim().slice(0, 20);
  if (!clean) throw { code: 'invalid_name' };
  if (findUser(clean)) throw { code: 'name_taken' };
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(clean, hash);
  return { id: info.lastInsertRowid, username: clean, avatar: '👊', save: {} };
}

function verifyLogin(username, password) {
  const user = findUser(username);
  if (!user) return { ok: false, reason: 'not_found' };
  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return { ok: false, reason: 'wrong_password' };
  let save = {};
  try { save = JSON.parse(user.save_json || '{}'); } catch (e) {}
  return { ok: true, id: user.id, username: user.username, avatar: user.avatar, save };
}

function saveProgress(username, password, saveData, avatar) {
  const check = verifyLogin(username, password);
  if (!check.ok) return check;
  const stmt = avatar
    ? db.prepare('UPDATE users SET save_json = ?, avatar = ? WHERE id = ?')
    : db.prepare('UPDATE users SET save_json = ? WHERE id = ?');
  if (avatar) stmt.run(JSON.stringify(saveData || {}), avatar, check.id);
  else stmt.run(JSON.stringify(saveData || {}), check.id);
  return { ok: true };
}

// ranking: pega o "highScore" de dentro do save_json de todo mundo e ordena.
// Como o save fica guardado como texto JSON, isso é feito em JS (não em SQL puro).
function getLeaderboard(limit = 20) {
  const rows = db.prepare('SELECT username, avatar, save_json FROM users').all();
  const list = rows.map(r => {
    let save = {};
    try { save = JSON.parse(r.save_json || '{}'); } catch (e) {}
    return {
      username: r.username,
      avatar: r.avatar,
      highScore: save.highScore || 0,
      totalKills: save.totalKills || 0,
      maxStage: save.maxStage || 1,
      zombieBest: save.zombieBest || 0
    };
  });
  list.sort((a, b) => b.highScore - a.highScore);
  return list.slice(0, limit);
}

function findUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// usado só pelo painel ADMIN: soma moedas/gemas na conta de alguém, direto pelo ID da conta
function adminAddCurrency(targetId, coins, gems) {
  const user = findUserById(targetId);
  if (!user) return { ok: false, reason: 'not_found' };
  let save = {};
  try { save = JSON.parse(user.save_json || '{}'); } catch (e) {}
  save.coins = Math.max(0, (save.coins || 0) + (coins || 0));
  save.gems = Math.max(0, (save.gems || 0) + (gems || 0));
  db.prepare('UPDATE users SET save_json = ? WHERE id = ?').run(JSON.stringify(save), user.id);
  return { ok: true, username: user.username, coins: save.coins, gems: save.gems };
}

module.exports = { createUser, verifyLogin, saveProgress, getLeaderboard, findUser, findUserById, adminAddCurrency };
