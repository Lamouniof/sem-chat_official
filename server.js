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
const lastActivity = new Map();   // pseudo -> timestamp (ms) de la dernière activité réelle
const generalHistory = [];        // messages du chat général
const privateHistory = new Map(); // "A|B" (trié) -> [messages]
const leaderboard = new Map();    // pseudo -> meilleur score
let nextMsgId = 1;

const INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes sans activité réelle => affiché "hors ligne"
const FIREBASE_CACHE_TTL_MS = 2 * 60 * 1000; // on ne re-interroge Firebase Auth qu'au max toutes les 2 min

// Cache des pseudos Firebase (évite de spammer admin.auth().listUsers() à chaque
// rafraîchissement toutes les 30s, ce qui pouvait déclencher des erreurs/quota et
// vider la liste "hors ligne" en silence).
let firebaseUsersCache = [];
let firebaseCacheAt = 0;

function privateKey(a, b) {
  return [a, b].sort().join("|");
}

// Va chercher tous les pseudos (displayName) de tous les comptes Firebase Auth et
// met à jour le cache. En cas d'erreur, on GARDE l'ancien cache plutôt que de le vider,
// pour ne pas faire disparaître la liste "hors ligne" à cause d'une erreur passagère.
async function refreshFirebaseUsersCache() {
  try {
    // Récupérer TOUS les comptes Firebase Auth (limite à 1000 utilisateurs) : c'est cette
    // liste complète qui permet d'afficher tous les pseudos existants comme "hors ligne"
    // dès le démarrage du serveur, avant même qu'aucun d'eux ne se connecte.
    const listUsersResult = await admin.auth().listUsers(1000);
    firebaseUsersCache = listUsersResult.users
      .map(userRecord => userRecord.displayName)
      .filter(Boolean); // Filtre les pseudos non nuls
    firebaseCacheAt = Date.now();
  } catch (error) {
    console.error(
      "Erreur lors de la récupération des utilisateurs Firebase (on garde le dernier cache connu) :",
      error.code || "", error.message || error
    );
  }
}

// Diffuse à tout le monde l'état en ligne / hors ligne, à partir du cache Firebase.
function broadcastUserLists() {
  const now = Date.now();

  // "En ligne" = socket connecté ET activité réelle (souris/clavier/message) il y a moins
  // de 5 minutes. Un socket connecté mais inactif depuis plus de 5 min bascule en "hors ligne"
  // dans l'affichage, sans pour autant être déconnecté.
  const onlineList = Array.from(onlineSockets.keys()).filter((pseudo) => {
    const last = lastActivity.get(pseudo) || 0;
    return now - last < INACTIVITY_MS;
  });

  // Hors ligne = tout compte Firebase connu qui n'est pas actuellement dans la liste "en ligne"
  const offlineList = firebaseUsersCache.filter(pseudo => !onlineList.includes(pseudo));

  console.log(`[update_users] ${onlineList.length} en ligne, ${offlineList.length} hors ligne (cache Firebase: ${firebaseUsersCache.length} comptes)`);

  io.emit("update_users", {
    onlineCount: onlineList.length,
    onlineUsers: onlineList,
    offlineUsers: offlineList
  });
}

// Rafraîchit le cache Firebase si besoin (TTL) puis diffuse les listes.
async function sendUserLists() {
  if (Date.now() - firebaseCacheAt > FIREBASE_CACHE_TTL_MS) {
    await refreshFirebaseUsersCache();
  }
  broadcastUserLists();
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

  // Si ce pseudo est déjà marqué "en ligne" sur un AUTRE socket, on prend le relais au lieu
  // de bloquer la nouvelle connexion : ça évite de rester bloqué "connecté ailleurs" après
  // une coupure réseau, une mise en veille du téléphone, un onglet qui a planté, etc.
  const existingSocketId = onlineSockets.get(finalPseudo);
  if (existingSocketId && existingSocketId !== socket.id) {
    const existingSocket = io.sockets.sockets.get(existingSocketId);
    if (existingSocket) {
      existingSocket.emit("session_replaced", "Vous vous êtes connecté depuis un autre appareil/onglet.");
      existingSocket.disconnect(true);
    }
    onlineSockets.delete(finalPseudo);
  }

  const isAdmin = ADMIN_UIDS.includes(uid);

  users.set(uid, finalPseudo);
  myPseudo = finalPseudo;
  myUid = uid;
  myIsAdmin = isAdmin;

  onlineSockets.set(finalPseudo, socket.id);
  lastActivity.set(finalPseudo, Date.now());

  socket.emit("auth_response", { success: true, pseudo: finalPseudo, is_admin: isAdmin });
  socket.emit("load_history", generalHistory);
  sendUserLists();
});

  socket.on("heartbeat", (pseudo) => {
    // Le heartbeat garde juste le socket "connu" ; il ne compte PAS comme
    // activité réelle (sinon le statut "inactif depuis 5 min" ne marcherait jamais).
    if (pseudo) onlineSockets.set(pseudo, socket.id);
  });

  // Émis par le client sur une vraie interaction (souris, clavier, clic...), throttlé côté client.
  socket.on("activity", () => {
    if (myPseudo) lastActivity.set(myPseudo, Date.now());
  });

  // Message général OU privé (le client envoie toujours sur le même événement 'message')
  socket.on("message", (data) => {
    if (!myPseudo) return;
    lastActivity.set(myPseudo, Date.now());
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

    const targetEntry = [...users.entries()].find(([, p]) => p === target);
    if (!targetEntry) return;
    const [targetUid] = targetEntry;

    if (ADMIN_UIDS.includes(targetUid)) return; // Protection admin

    // 1. Déconnexion immédiate du socket
    users.delete(targetUid);
    const targetSocketId = onlineSockets.get(target);
    if (targetSocketId) {
      io.to(targetSocketId).emit("user_banned_notice", target);
      onlineSockets.delete(target);
    }

    // 2. SUPPRESSION DÉFINITIVE DANS FIREBASE
    try {
      // Option radicale : supprime le compte de Firebase Authentication
      await admin.auth().deleteUser(targetUid);
      console.log(`[BAN] Compte Firebase supprimé définitivement pour ${target} (${targetUid})`);
    } catch (err) {
      console.error(`[BAN ERROR] Impossible de supprimer le compte Firebase :`, err.message);
    }

    sendUserLists();
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
      sendUserLists();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Sem-chat démarré sur le port ${PORT}`);

  // Charge immédiatement tous les pseudos Firebase au démarrage : ils apparaissent
  // tous en "hors ligne" avant même qu'un seul utilisateur ne se connecte.
  sendUserLists();

  // Rafraîchit périodiquement la liste : ça permet de basculer automatiquement en
  // "hors ligne" quelqu'un d'inactif depuis 5 min, et de détecter les nouveaux
  // comptes Firebase créés depuis le dernier appel, sans attendre un login/logout.
  setInterval(sendUserLists, 30 * 1000);
});
