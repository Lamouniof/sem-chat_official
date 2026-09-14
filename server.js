const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB pour autoriser l'envoi de fichiers en base64
});

const PORT = process.env.PORT || 3000;

// Le·s pseudo·s listés ici sont admin ET impossibles à bannir (comme "william" dans le client)
const SUPER_ADMINS = ["william"];

app.use(express.static(path.join(__dirname, "public")));

// ---------- "Base de données" en mémoire (remise à zéro à chaque redémarrage) ----------
const users = new Map();        // pseudo -> { mdp, isAdmin }
const bannedUsers = new Set();  // pseudos bannis
const onlineSockets = new Map();// pseudo -> socket.id
const generalHistory = [];      // messages du chat général
const privateHistory = new Map(); // "A|B" (trié) -> [messages]
const leaderboard = new Map();  // pseudo -> meilleur score
let nextMsgId = 1;

function privateKey(a, b) {
  return [a, b].sort().join("|");
}

function getOnlineList() {
  return Array.from(onlineSockets.keys());
}

function getTopScores() {
  return Array.from(leaderboard.entries())
    .map(([pseudo, score]) => ({ pseudo, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

io.on("connection", (socket) => {
  let myPseudo = null;

  socket.on("login_register", ({ pseudo, mdp }) => {
    pseudo = String(pseudo).trim();

    if (bannedUsers.has(pseudo)) {
      return socket.emit("auth_response", { success: false, message: "Cet utilisateur est banni." });
    }

    const existing = users.get(pseudo);

    if (existing) {
      // Utilisateur déjà enregistré : on vérifie le mot de passe
      if (existing.mdp !== mdp) {
        return socket.emit("auth_response", { success: false, message: "Mot de passe incorrect." });
      }
    } else {
      // Nouvel utilisateur : on l'enregistre
      users.set(pseudo, { mdp, isAdmin: SUPER_ADMINS.includes(pseudo) });
    }

    myPseudo = pseudo;
    onlineSockets.set(pseudo, socket.id);

    socket.emit("auth_response", {
      success: true,
      pseudo,
      is_admin: users.get(pseudo).isAdmin
    });

    socket.emit("load_history", generalHistory);
    io.emit("update_users", getOnlineList());
  });

  socket.on("heartbeat", (pseudo) => {
    if (pseudo) onlineSockets.set(pseudo, socket.id);
  });

  // Message général OU privé (le client envoie toujours sur le même événement 'message')
  socket.on("message", (data) => {
    if (!myPseudo) return;
    const msg = {
      id: nextMsgId++,
      user: data.user,
      text: data.text,
      type: data.type || "text",
      fileName: data.fileName || null,
      target: data.target
    };

    if (!data.target || data.target === "Général") {
      generalHistory.push(msg);
      io.emit("message", msg);
    } else {
      // Message privé entre myPseudo et data.target
      const key = privateKey(msg.user, data.target);
      if (!privateHistory.has(key)) privateHistory.set(key, []);
      privateHistory.get(key).push(msg);

      // Envoi à l'expéditeur ET au destinataire s'il est connecté
      socket.emit("private_message", msg);
      const targetSocketId = onlineSockets.get(data.target);
      if (targetSocketId) {
        io.to(targetSocketId).emit("private_message", msg);
      }
    }
  });

  socket.on("get_private_history", ({ user, target }) => {
    const key = privateKey(user, target);
    const history = privateHistory.get(key) || [];
    socket.emit("load_private_history", { target, history });
  });

  socket.on("delete_message", (id) => {
    if (!myPseudo || !users.get(myPseudo)?.isAdmin) return;

    let removed = false;
    const idxG = generalHistory.findIndex((m) => m.id === id);
    if (idxG !== -1) { generalHistory.splice(idxG, 1); removed = true; }

    for (const arr of privateHistory.values()) {
      const idxP = arr.findIndex((m) => m.id === id);
      if (idxP !== -1) { arr.splice(idxP, 1); removed = true; }
    }

    if (removed) io.emit("message_deleted", id);
  });

  socket.on("ban_user", ({ target, requester }) => {
    const requesterData = users.get(requester);
    if (!requesterData?.isAdmin) return;
    if (SUPER_ADMINS.includes(target)) return; // protection des super-admins

    bannedUsers.add(target);

    const targetSocketId = onlineSockets.get(target);
    if (targetSocketId) {
      io.to(targetSocketId).emit("user_banned_notice", target);
      onlineSockets.delete(target);
    }
    io.emit("update_users", getOnlineList());
  });

  socket.on("get_leaderboard", () => {
    socket.emit("update_leaderboard", getTopScores());
  });

  socket.on("save_score", ({ pseudo, score }) => {
    const current = leaderboard.get(pseudo) || 0;
    if (score > current) leaderboard.set(pseudo, score);
    io.emit("update_leaderboard", getTopScores());
  });

  socket.on("disconnect", () => {
    if (myPseudo && onlineSockets.get(myPseudo) === socket.id) {
      onlineSockets.delete(myPseudo);
      io.emit("update_users", getOnlineList());
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sem-chat démarré sur le port ${PORT}`);
});
