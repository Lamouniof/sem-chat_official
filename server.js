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
// ADMIN : UID Firebase du compte admin
// ============================================================
const ADMIN_UIDS = (process.env.ADMIN_UID || "SUDPTlRjaSfNbE3Pt7WiosWla3D3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ============================================================
// INITIALISATION FIREBASE ADMIN
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

// ============================================================
// FIREBASE REALTIME DATABASE : accès à la base de données
// ============================================================
const db = admin.database();

app.use(express.static(path.join(__dirname, "public")));

// ---------- "Base de données" en mémoire + Firebase Realtime Database ----------
const users = new Map();          // uid -> pseudo
const onlineSockets = new Map();  // pseudo -> socket.id
const lastActivity = new Map();   // pseudo -> timestamp (ms) de la dernière activité réelle
const generalHistory = [];        // messages du chat général
const privateHistory = new Map(); // "A|B" (trié) -> [messages]
const leaderboard = new Map();    // pseudo -> meilleur score
let nextMsgId = 1;

const INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes sans activité réelle => affiché "hors ligne"
const FIREBASE_CACHE_TTL_MS = 2 * 60 * 1000; // on ne re-interroge Firebase Auth qu'au max toutes les 2 min

let firebaseUsersCache = [];
let firebaseCacheAt = 0;
let firebaseLastError = null;

function privateKey(a, b) {
  return [a, b].sort().join("|");
}

// ============================================================
// FIREBASE : Charger les messages au démarrage
// ============================================================
async function loadMessagesFromFirebase() {
  try {
    console.log("[Firebase] Chargement des messages au démarrage...");

    // 1. Charger messages généraux
    const generalRef = db.ref("messages/general");
    const generalSnapshot = await generalRef.once("value");
    if (generalSnapshot.exists()) {
      const msgs = generalSnapshot.val();
      // Convertir l'objet Firebase en tableau, trié par ID
      const msgArray = Object.entries(msgs)
        .map(([key, msg]) => ({ ...msg, id: msg.id || parseInt(key.replace(/msg_/, "")) }))
        .sort((a, b) => a.id - b.id);
      generalHistory.push(...msgArray);
      const maxId = Math.max(...msgArray.map(m => m.id), 0);
      nextMsgId = maxId + 1;
      console.log(`✅ ${msgArray.length} messages généraux chargés depuis Firebase.`);
    }

    // 2. Charger messages privés
    const privateRef = db.ref("messages/private");
    const privateSnapshot = await privateRef.once("value");
    if (privateSnapshot.exists()) {
      const conversations = privateSnapshot.val();
      for (const [conversationKey, msgs] of Object.entries(conversations)) {
        const msgArray = Object.entries(msgs)
          .map(([key, msg]) => ({ ...msg, id: msg.id || parseInt(key.replace(/msg_/, "")) }))
          .sort((a, b) => a.id - b.id);
        privateHistory.set(conversationKey, msgArray);
      }
      console.log(`✅ ${privateHistory.size} conversation(s) privée(s) chargée(s) depuis Firebase.`);
    }

    // 3. Charger leaderboard
    const leaderboardRef = db.ref("leaderboard");
    const leaderboardSnapshot = await leaderboardRef.once("value");
    if (leaderboardSnapshot.exists()) {
      const leaderboardData = leaderboardSnapshot.val();
      for (const [pseudo, score] of Object.entries(leaderboardData)) {
        leaderboard.set(pseudo, score);
      }
      console.log(`✅ Leaderboard chargé : ${leaderboard.size} joueur(s).`);
    }

    console.log(`[Firebase] ✅ Démarrage avec nextMsgId = ${nextMsgId}`);
  } catch (error) {
    console.error("[Firebase] ❌ Erreur lors du chargement :", error.message || error);
  }
}

// ============================================================
// FIREBASE : Sauvegarder un message en arrière-plan
// ============================================================
function saveMessageToFirebase(msg) {
  // En arrière-plan, ne pas bloquer la réponse
  (async () => {
    try {
      const msgKey = `msg_${msg.id}`;

      if (!msg.target || msg.target === "Général") {
        // Message général
        await db.ref(`messages/general/${msgKey}`).set({
          id: msg.id,
          user: msg.user,
          text: msg.text,
          type: msg.type || "text",
          fileName: msg.fileName || null,
          timestamp: Date.now()
        });
      } else {
        // Message privé
        const key = privateKey(msg.user, msg.target);
        await db.ref(`messages/private/${key}/${msgKey}`).set({
          id: msg.id,
          user: msg.user,
          text: msg.text,
          type: msg.type || "text",
          fileName: msg.fileName || null,
          target: msg.target,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      console.error("[Firebase] ❌ Erreur sauvegarde message :", error.message || error);
    }
  })();
}

// ============================================================
// FIREBASE : Sauvegarder le leaderboard en arrière-plan
// ============================================================
function saveLeaderboardToFirebase() {
  (async () => {
    try {
      const leaderboardObj = Object.fromEntries(leaderboard);
      await db.ref("leaderboard").set(leaderboardObj);
    } catch (error) {
      console.error("[Firebase] ❌ Erreur sauvegarde leaderboard :", error.message || error);
    }
  })();
}

// ============================================================
// FIREBASE : Rafraîchir le cache des utilisateurs Firebase Auth
// ============================================================
async function refreshFirebaseUsersCache() {
  try {
    const listUsersResult = await admin.auth().listUsers(1000);
    const total = listUsersResult.users.length;
    firebaseUsersCache = listUsersResult.users
      .map(userRecord => userRecord.displayName)
      .filter(Boolean);
    firebaseCacheAt = Date.now();
    firebaseLastError = null;

    if (total > 0 && firebaseUsersCache.length === 0) {
      console.warn(`[Firebase] ${total} compte(s) trouvé(s), mais aucun displayName défini.`);
    }
  } catch (error) {
    firebaseLastError = { code: error.code || null, message: error.message || String(error), at: Date.now() };
    console.error("[Firebase] ❌ Erreur listUsers :", error.code || "", error.message || error);
  }
}

// ============================================================
// Diffuser la liste des utilisateurs en ligne/hors ligne
// ============================================================
function broadcastUserLists() {
  const now = Date.now();
  const onlineList = Array.from(onlineSockets.keys()).filter((pseudo) => {
    const last = lastActivity.get(pseudo) || 0;
    return now - last < INACTIVITY_MS;
  });
  const offlineList = firebaseUsersCache.filter(pseudo => !onlineList.includes(pseudo));

  console.log(`[update_users] ${onlineList.length} en ligne, ${offlineList.length} hors ligne`);

  io.emit("update_users", {
    onlineCount: onlineList.length,
    onlineUsers: onlineList,
    offlineUsers: offlineList
  });

  io.emit("firebase_debug", {
    cacheSize: firebaseUsersCache.length,
    lastRefreshAt: firebaseCacheAt,
    lastError: firebaseLastError
  });
}

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

  socket.on("login_register", async ({ pseudo, token }) => {
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch (err) {
      return socket.emit("auth_response", { success: false, message: "Session invalide, reconnecte-toi." });
    }

    const uid = decoded.uid;
    const knownPseudo = users.get(uid);
    const finalPseudo = String(pseudo || knownPseudo || decoded.name || "Utilisateur_" + uid.substring(0, 5)).trim();

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
    if (pseudo) onlineSockets.set(pseudo, socket.id);
  });

  socket.on("activity", () => {
    if (myPseudo) lastActivity.set(myPseudo, Date.now());
  });

  socket.on("message", (data) => {
    if (!myPseudo) return;
    lastActivity.set(myPseudo, Date.now());
    const msg = {
      id: nextMsgId++,
      user: myPseudo,
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

    // Sauvegarder en arrière-plan
    saveMessageToFirebase(msg);
  });

  socket.on("get_private_history", ({ target }) => {
    if (!myPseudo || !target) return;
    const key = privateKey(myPseudo, target);
    const history = privateHistory.get(key) || [];
    socket.emit("load_private_history", { target, history });
  });

  socket.on("admin_get_private_history", ({ user1, user2 }) => {
    if (!myIsAdmin) return;
    if (!user1 || !user2 || user1 === user2) return;

    const key = privateKey(user1, user2);
    const history = privateHistory.get(key) || [];

    socket.emit("load_admin_private_history", { user1, user2, history });
  });

  socket.on("admin_get_conversation_partners", ({ user1 }) => {
    if (!myIsAdmin) return;
    if (!user1) return;
    const partners = new Set();
    for (const [key, messages] of privateHistory.entries()) {
      const [a, b] = key.split("|");
      if (a === user1) partners.add(b);
      else if (b === user1) partners.add(a);
    }
    socket.emit("admin_conversation_partners", {
      user: user1,
      partners: Array.from(partners).sort()
    });
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

    if (removed) {
      io.emit("message_deleted", id);
      // Supprimer aussi de Firebase
      (async () => {
        try {
          await db.ref(`messages/general/msg_${id}`).remove();
          for (const key of privateHistory.keys()) {
            await db.ref(`messages/private/${key}/msg_${id}`).remove();
          }
        } catch (error) {
          console.error("[Firebase] ❌ Erreur suppression message :", error.message || error);
        }
      })();
    }
  });

  socket.on("ban_user", async ({ target }) => {
    if (!myIsAdmin) return;

    const targetEntry = [...users.entries()].find(([, p]) => p === target);
    if (!targetEntry) return;
    const [targetUid] = targetEntry;

    if (ADMIN_UIDS.includes(targetUid)) return;

    users.delete(targetUid);
    const targetSocketId = onlineSockets.get(target);
    if (targetSocketId) {
      io.to(targetSocketId).emit("user_banned_notice", target);
      onlineSockets.delete(target);
    }

    try {
      await admin.auth().deleteUser(targetUid);
      console.log(`[BAN] Compte Firebase supprimé pour ${target} (${targetUid})`);
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
    if (score > current) {
      leaderboard.set(myPseudo, score);
      saveLeaderboardToFirebase();
    }
    io.emit("update_leaderboard", getTopScores());
  });

  socket.on("disconnect", () => {
    if (myPseudo && onlineSockets.get(myPseudo) === socket.id) {
      onlineSockets.delete(myPseudo);
      sendUserLists();
    }
  });
});

server.listen(PORT, async () => {
  console.log(`Sem-chat démarré sur le port ${PORT}`);

  // Charger les messages depuis Firebase au démarrage
  await loadMessagesFromFirebase();

  // Charger la liste des utilisateurs Firebase Auth
  await sendUserLists();

  // Rafraîchir périodiquement
  setInterval(sendUserLists, 30 * 1000);
});
