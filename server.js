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
// ADMIN : UID Firebase du compte admin (PAS un pseudo, PAS un
// email — il n'y en a plus de vrai côté client).
//
// Pour le trouver : connecte-toi une première fois avec le compte
// à rendre admin, puis Firebase Console > Authentication > Users,
// colonne "User UID". Colle la valeur dans la variable
// d'environnement ADMIN_UID sur Render.
//
// Pour plusieurs admins : sépare les UID par des virgules,
// ex. ADMIN_UID="uid1,uid2"
// ============================================================
const ADMIN_UIDS = (process.env.ADMIN_UID || "SUDPTlRjaSfNbE3Pt7WiosWla3D3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ============================================================
// INITIALISATION FIREBASE ADMIN
// Sur Render (production) : colle le JSON COMPLET de la clé de
// service dans la variable d'environnement FIREBASE_SERVICE_ACCOUNT.
// Ne commite JAMAIS ce fichier JSON sur GitHub — utilise UNIQUEMENT
// cette variable d'environnement.
//
// En local pour développer (jamais en prod, jamais commité) :
// FIREBASE_CREDENTIALS_PATH peut pointer vers un fichier local,
// à condition qu'il soit dans .gitignore.
// ============================================================
let credential;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  credential = admin.credential.cert(serviceAccount);
} else if (process.env.FIREBASE_CREDENTIALS_PATH) {
  credential = admin.credential.cert(require(path.resolve(process.env.FIREBASE_CREDENTIALS_PATH)));
} else {
  throw new Error(
    "Aucune credential Firebase trouvée. Définis FIREBASE_SERVICE_ACCOUNT (recommandé en prod) ou FIREBASE_CREDENTIALS_PATH (dev local uniquement)."
  );
}

admin.initializeApp({ credential });

app.use(express.static(path.join(__dirname, "public")));

// ---------- "Base de données" en mémoire (remise à zéro à chaque redémarrage) ----------
const users = new Map();          // uid -> pseudo
const onlineSockets = new Map();  // pseudo -> socket.id
const generalHistory = [];        // messages du chat général
const privateHistory = new Map(); // "A|B" (trié) -> [messages]
const leaderboard = new Map();    // pseudo -> meilleur score
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
  let myUid = null;
  let myIsAdmin = false;

  // Le client envoie maintenant { pseudo, token } au lieu de { pseudo, mdp }
  socket.on("login_register", async ({ pseudo, token }) => {
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch (err) {
    return socket.emit("auth_response", { success: false, message: "Session invalide, reconnecte-toi." });
  }

  const uid = decoded.uid;

  // On récupère le pseudo : soit celui envoyé, soit celui déjà stocké en mémoire, soit le nom Firebase
  const knownPseudo = users.get(uid);
  const finalPseudo = String(pseudo || knownPseudo || decoded.name || "Utilisateur_" + uid.substring(0, 5)).trim();

  // Vérification de double connexion
  if (onlineSockets.has(finalPseudo) && onlineSockets.get(finalPseudo) !== socket.id) {
    return socket.emit("auth_response", {
      success: false,
      message: "Ce compte est déjà connecté sur un autre appareil."
    });
  }

  const isAdmin = ADMIN_UIDS.includes(uid);

  users.set(uid, finalPseudo);
  myPseudo = finalPseudo;
  myUid = uid;
  myIsAdmin = isAdmin;

  onlineSockets.set(finalPseudo, socket.id);

  socket.emit("auth_response", { success: true, pseudo: finalPseudo, is_admin: isAdmin });
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
      user: myPseudo, // toujours le pseudo authentifié côté serveur, jamais celui du client
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
    if (!myPseudo || !target) return;
    const key = privateKey(myPseudo, target);
    const history = privateHistory.get(key) || [];
    socket.emit("load_private_history", { target, history });
  });

  // --- Mode espion admin : consulter la conversation privée de deux autres utilisateurs ---
  // --- Mode espion admin : consulter la conversation privée de deux autres utilisateurs ---
  socket.on("admin_get_private_history", ({ user1, user2 }) => {
    if (!myIsAdmin) return;
    if (!user1 || !user2 || user1 === user2) return;
    
    // La fonction privateKey trie automatiquement les pseudos pour trouver la bonne clé
    const key = privateKey(user1, user2);
    const history = privateHistory.get(key) || [];
    
    // Renvoie l'historique au socket de l'admin
    socket.emit("load_admin_private_history", { user1, user2, history });
  });

  socket.on("delete_message", (id) => {
    if (!myIsAdmin) return;

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
    if (!myIsAdmin) return;

    // 1. Trouver l'UID Firebase associé au pseudo ciblé
    const targetEntry = [...users.entries()].find(([, p]) => p === target);
    if (!targetEntry) return;
    const [targetUid] = targetEntry;

    // Protection : impossible de bannir un autre admin
    if (ADMIN_UIDS.includes(targetUid)) return;

    // 2. Supprimer la session mémoire locale
    users.delete(targetUid);

    const targetSocketId = onlineSockets.get(target);
    if (targetSocketId) {
      io.to(targetSocketId).emit("user_banned_notice", target);
      onlineSockets.delete(target);
    }

    // 3. Action définitive sur Firebase Authentication
    try {

      console.log(`[BAN] L'utilisateur ${target} (UID: ${targetUid}) a été banni définitivement.`);
    } catch (err) {
      console.error(`[BAN ERROR] Échec de la suspension Firebase pour ${target}:`, err.message);
    }

    // 4. Mettre à jour la liste des utilisateurs en ligne pour tout le monde
    io.emit("update_users", getOnlineList());
  });

  socket.on("get_leaderboard", () => {
    socket.emit("update_leaderboard", getTopScores());
  });

  socket.on("save_score", (data) => {
    if (!myPseudo) return;
    const score = data.score || 0;
    const current = leaderboard.get(myPseudo) || 0;
    if (score > current) leaderboard.set(myPseudo, score);
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
