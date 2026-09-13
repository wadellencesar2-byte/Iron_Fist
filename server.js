// ============================================================
// SERVIDOR — Iron Fist (Contas + Banco de Dados)
// ============================================================
// O que esse arquivo faz:
//  - Serve o seu index.html (assim as pessoas acessam o jogo direto pela URL do Render)
//  - Guarda contas (nome + senha com hash), progresso de cada jogador e o ranking
//    num banco de dados simples (veja db.js)
//
// Não tem multiplayer/online aqui — é só o jogo single-player com conta salva
// no servidor, pra funcionar em qualquer aparelho que fizer login.
//
// Rodar localmente pra testar:
//   1) npm install
//   2) npm start
//   3) abra http://localhost:3000 no navegador
//
// Publicar no Render: veja o README.md
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Servidor do Iron Fist rodando na porta ' + PORT);
});
