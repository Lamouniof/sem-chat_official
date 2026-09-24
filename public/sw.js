// Service worker minimal pour Sem-chat.
// Objectif : rendre l'app installable (PWA) et permettre un affichage de secours
// hors-ligne. Le chat étant en temps réel (Socket.IO), on NE met PAS en cache les
// messages : seules les connexions HTTP passent par fetch() ci-dessous, les
// connexions WebSocket de Socket.IO ne sont jamais interceptées par un service worker.

const CACHE_NAME = "sem-chat-shell-v1";
const APP_SHELL = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // On ne touche jamais aux requêtes non-GET (ex: rien de spécial ici, mais sécurité)
  // ni aux appels vers d'autres origines (API tierces, CDN, etc.).
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  // Page principale : réseau en priorité (toujours la version la plus fraîche du
  // chat), avec repli sur le cache si hors-ligne.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }

  // Reste des fichiers statiques (icônes, manifest...) : cache d'abord, réseau en secours.
  event.respondWith(
    caches.match(request).then((cached) => {
      return (
        cached ||
        fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
      );
    })
  );
});
