const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB pour autoriser l'envoi de fichiers en base64
});

const PORT = process.env.PORT || 3000;

// ============================================================
// FIREBASE ADMIN — vérifie les tokens envoyés par le client au lieu
// de comparer un mot de passe stocké en clair.
//
// Sur Render : variable d'environnement FIREBASE_SERVICE_ACCOUNT
// contenant le JSON COMPLET de la clé de service (jamais commité
// sur GitHub — voir l'incident de sécurité qu'on vient de corriger).
// En local : FIREBASE_CREDENTIALS_PATH pointant vers le fichier JSON
// téléchargé (lui aussi à garder hors du repo, dans .gitignore).
// ============================================================
let credential;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
} else {
  const credPath = process.env.FIREBASE_CREDENTIALS_PATH || "./firebase-service-account.json";
  credential = admin.credential.cert(require(credPath));
}
admin.initializeApp({ credential });

// UID Firebase du compte admin (Firebase Console > Authentication > Users
// > colonne "User UID"). Pas d'email, pas de pseudo : c'est le seul
// identifiant fiable et non falsifiable depuis qu'on est passé en
// connexion pseudo-only avec email fantôme.
const ADMIN_UID = process.env.ADMIN_UID || "COLLE_ICI_L_UID_FIREBASE";

app.use(express.static(path.join(__dirname, "public")));

// ---------- "Base de données" en mémoire (remise à zéro à chaque redémarrage) ----------
const users = new Map();          // uid -> pseudo
const onlineSockets = new Map();  // pseudo -> socket.id
const onlineUids = new Set();     // uid actuellement connectés (anti double-connexion)
const sessions = new Map();       // socket.id -> { uid, pseudo, isAdmin }
const generalHistory = [];
const privateHistory = new Map(); // "A|B" (trié) -> [messages]
const leaderboard = new Map();
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
  socket.on("login_register", async ({ pseudo, token }) => {
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch (err) {
      return socket.emit("auth_response", { success: false, message: "Session invalide, reconnecte-toi." });
    }

    const uid = decoded.uid;

    // Empêcher la double connexion du même compte
    if (onlineUids.has(uid)) {
      return socket.emit("auth_response", { success: false, message: "Ce compte est déjà connecté sur un autre appareil." });
    }

    const finalPseudo = String(pseudo || users.get(uid) || uid).trim();
    const isAdmin = uid === ADMIN_UID;

    users.set(uid, finalPseudo);
    onlineSockets.set(finalPseudo, socket.id);
    onlineUids.add(uid);
    sessions.set(socket.id, { uid, pseudo: finalPseudo, isAdmin });

    socket.emit("auth_response", { success: true, pseudo: finalPseudo, is_admin: isAdmin });
    socket.emit("load_history", generalHistory);
    io.emit("update_users", getOnlineList());
  });

  socket.on("heartbeat", (pseudo) => {
    const session = sessions.get(socket.id);
    if (session) onlineSockets.set(session.pseudo, socket.id);
  });

  // Message général OU privé (le client envoie toujours sur le même événement 'message')
  socket.on("message", (data) => {
    const session = sessions.get(socket.id);
    if (!session) return;

    // On utilise le pseudo authentifié côté serveur, pas celui envoyé
    // par le client, pour empêcher toute usurpation.
    const msg = {
      id: nextMsgId++,
      user: session.pseudo,
      text: data.text,
      type: data.type || "text",
      fileName: data.fileName || null,
      target: data.target
    };

    if (!data.target || data.target === "Général") {
      generalHistory.push(msg);
      io.emit("message", msg);
    } else {
      const key = privateKey(msg.user, data.target);
      if (!privateHistory.has(key)) privateHistory.set(key, []);
      privateHistory.get(key).push(msg);

      socket.emit("private_message", msg);
      const targetSocketId = onlineSockets.get(data.target);
      if (targetSocketId) {
        io.to(targetSocketId).emit("private_message", msg);
      }
    }
  });

  socket.on("get_private_history", ({ target }) => {
    const session = sessions.get(socket.id);
    if (!session || !target) return;
    const key = privateKey(session.pseudo, target);
    const history = privateHistory.get(key) || [];
    socket.emit("load_private_history", { target, history });
  });

  socket.on("delete_message", (id) => {
    const session = sessions.get(socket.id);
    if (!session || !session.isAdmin) return;

    let removed = false;
    const idxG = generalHistory.findIndex((m) => m.id === id);
    if (idxG !== -1) { generalHistory.splice(idxG, 1); removed = true; }

    for (const arr of privateHistory.values()) {
      const idxP = arr.findIndex((m) => m.id === id);
      if (idxP !== -1) { arr.splice(idxP, 1); removed = true; }
    }

    if (removed) io.emit("message_deleted", id);
  });

  socket.on("ban_user", async ({ target }) => {
    const session = sessions.get(socket.id);
    if (!session || !session.isAdmin) return;

    const targetUid = Array.from(users.entries()).find(([u, p]) => p === target)?.[0];
    if (!targetUid || targetUid === ADMIN_UID) return; // protection : impossible de bannir l'admin

    try {
      // Désactive le compte côté Firebase (empêche toute reconnexion)
      await admin.auth().updateUser(targetUid, { disabled: true });
      await admin.auth().revokeRefreshTokens(targetUid);
    } catch (err) {
      console.error("Erreur lors du ban Firebase :", err.message);
    }

    users.delete(targetUid);
    onlineUids.delete(targetUid);

    const targetSocketId = onlineSockets.get(target);
    if (targetSocketId) {
      io.to(targetSocketId).emit("user_banned_notice", target);
      onlineSockets.delete(target);
      sessions.delete(targetSocketId);
    }
    io.emit("update_users", getOnlineList());
  });

  // --- Mode admin : inspecter une conversation privée entre deux utilisateurs ---
  socket.on("admin_get_private_history", ({ user1, user2 }) => {
    const session = sessions.get(socket.id);
    if (!session || !session.isAdmin) return;
    if (!user1 || !user2 || user1 === user2) return;

    const key = privateKey(user1, user2);
    const history = privateHistory.get(key) || [];
    socket.emit("load_admin_private_history", { user1, user2, history });
  });

  socket.on("get_leaderboard", () => {
    socket.emit("update_leaderboard", getTopScores());
  });

  socket.on("save_score", ({ score }) => {
    const session = sessions.get(socket.id);
    if (!session) return;
    const current = leaderboard.get(session.pseudo) || 0;
    if (score > current) leaderboard.set(session.pseudo, score);
    io.emit("update_leaderboard", getTopScores());
  });

  socket.on("disconnect", () => {
    const session = sessions.get(socket.id);
    if (session) {
      onlineUids.delete(session.uid);
      if (onlineSockets.get(session.pseudo) === socket.id) {
        onlineSockets.delete(session.pseudo);
      }
      sessions.delete(socket.id);
      io.emit("update_users", getOnlineList());
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sem-chat démarré sur le port ${PORT}`);
});
