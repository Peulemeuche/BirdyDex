// ========== CONFIG ==========
const WORKER_URL = "https://birdyrex.peulmeule-valentin.workers.dev";

const DEFAULT_LOCATIONS = ["Avelin", "Brétignolles", "Chalon", "Bienvillers"];
const AVATARS = ["🦅", "🦉", "🦜", "🐦", "🦚", "🦩", "🦆", "🐧", "🦋", "🌿"];
const BADGES = [
  { id: "first",    icon: "🥚", name: "Premier envol",  desc: "1er oiseau",        req: p => uniqueMyBirds(p).length >= 1  },
  { id: "five",     icon: "🌿", name: "Observateur",    desc: "5 espèces",          req: p => uniqueMyBirds(p).length >= 5  },
  { id: "ten",      icon: "🔭", name: "Naturaliste",    desc: "10 espèces",         req: p => uniqueMyBirds(p).length >= 10 },
  { id: "twenty",   icon: "📚", name: "Ornithologue",   desc: "20 espèces",         req: p => uniqueMyBirds(p).length >= 20 },
  { id: "traveler", icon: "🗺️", name: "Explorateur",    desc: "3+ lieux visités",  req: p => (p.myLocs || []).length >= 3  },
  { id: "master",   icon: "🏆", name: "Maître Birdr",   desc: "50 espèces",         req: p => uniqueMyBirds(p).length >= 50 },
  { id: "rarebird", icon: "⭐", name: "Chasseur rare",  desc: "1ère espèce rare",   req: p => uniqueMyBirds(p).some(b => b.rarity === "rare") },
  { id: "rarehunt", icon: "💎", name: "Traqueur",       desc: "5 espèces rares",    req: p => uniqueMyBirds(p).filter(b => b.rarity === "rare").length >= 5 },
  { id: "raregod",  icon: "🔥", name: "Légende",        desc: "15 espèces rares",   req: p => uniqueMyBirds(p).filter(b => b.rarity === "rare").length >= 15 },
];

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCZ6zwFo3TUh7OyPhRxx5KUPrvtOA_zt3Q",
  authDomain: "birdyrex-6a076.firebaseapp.com",
  databaseURL: "https://birdyrex-6a076-default-rtdb.europe-west1.firebasedatabase.app/",
  projectId: "birdyrex-6a076",
};

// ========== STATE ==========
let currentProfileId = null;
let currentLocation  = DEFAULT_LOCATIONS[0];
let currentLocSort   = "date";   // "date" | "alpha" | "rarity"
let currentDexSort   = "date";   // "date" | "alpha" | "rarity" 
let selectedAvatar   = AVATARS[0];
let firebaseDb       = null;
let groupCode        = null;
let syncListener     = null;

// ========== FIREBASE INIT ==========
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function initFirebase() {
  try {
    if (!window.firebase) {
      await loadScript("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
      await loadScript("https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js");
    }
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    firebaseDb = firebase.database();
    console.log("✅ Firebase connecté");
  } catch (e) {
    console.error("Firebase init error:", e);
  }
}

// ========== SYNC FIREBASE ==========
// Structure Firebase :
//   groups/{groupCode}/meta = { createdAt }
//   groups/{groupCode}/sharedBirds/{locKey}/{birdKey} = { name, image, date, location, addedBy }
//
// Les profils (myBirds, XP) restent en localStorage — privés à chaque appareil.
// Seules les sharedBirds (liste commune par lieu) sont dans Firebase.

function locationKey(loc) {
  return loc.replace(/[.#$[\]/\s]/g, "_");
}

function birdKey(name) {
  return name.replace(/[.#$[\]/\s'é è ê ë à â ù û î ï ô ç]/g, "_").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function groupRef() {
  if (!firebaseDb || !groupCode) return null;
  return firebaseDb.ref(`groups/${groupCode}`);
}

// Vérifier si un groupe existe
async function groupExists(code) {
  if (!firebaseDb) return false;
  try {
    const snap = await firebaseDb.ref(`groups/${code}/meta`).once("value");
    return snap.exists();
  } catch(e) { return false; }
}

// Créer un groupe
async function createGroupInFirebase(code) {
  if (!firebaseDb) return false;
  try {
    await firebaseDb.ref(`groups/${code}/meta`).set({
      createdAt: new Date().toISOString()
    });
    return true;
  } catch(e) { console.error("createGroup error:", e); return false; }
}

// Push un oiseau vers Firebase (appelé lors de chaque ajout)
async function pushBirdToFirebase(loc, bird) {
  if (!firebaseDb || !groupCode) return;
  try {
    await firebaseDb.ref(`groups/${groupCode}/sharedBirds/${locationKey(loc)}/${birdKey(bird.name)}`).set(bird);
  } catch(e) { console.error("pushBird error:", e); }
}


// Push a new location to Firebase so all group members see it
async function pushLocationToFirebase(locName) {
  if (!firebaseDb || !groupCode) return;
  try {
    await firebaseDb.ref(`groups/${groupCode}/locations/${locationKey(locName)}`).set({
      name: locName,
      createdAt: new Date().toISOString()
    });
  } catch(e) { console.error("pushLocation error:", e); }
}

// Pull all group locations from Firebase and merge locally
async function pullLocationsFromFirebase() {
  if (!firebaseDb || !groupCode) return;
  try {
    const snap = await firebaseDb.ref(`groups/${groupCode}/locations`).once("value");
    const data = snap.val();
    const db = getDB();
    // Reconstruction complète (pas d'accumulation d'anciens noms)
    db.groupLocs = data
      ? Object.values(data).filter(e => e && e.name).map(e => e.name)
      : [];
    saveDB(db);
  } catch(e) { console.error("pullLocations error:", e); }
}

// Pull one-time pour un lieu (au changement de lieu)
async function pullSharedBirdsForLocation(loc) {
  if (!firebaseDb || !groupCode) return;
  try {
    const snap = await firebaseDb.ref(`groups/${groupCode}/sharedBirds/${locationKey(loc)}`).once("value");
    const data = snap.val();
    if (!data) return;
    const birds = Object.values(data);
    mergeSharedBirdsLocally(loc, birds);
  } catch(e) { console.error("pullSharedBirds error:", e); }
}

function mergeSharedBirdsLocally(loc, birds) {
  const db = getDB();
  if (!db.sharedBirds) db.sharedBirds = {};
  const existing      = db.sharedBirds[loc] || [];
  const existingNames = existing.map(b => b.name);
  const toAdd         = birds.filter(b => !existingNames.includes(b.name));
  if (toAdd.length > 0) {
    db.sharedBirds[loc] = [...existing, ...toAdd];
    saveDB(db);
  }
}

// Push un profil vers Firebase (appelé à chaque modification)
async function pushProfileToFirebase(profile) {
  if (!firebaseDb || !groupCode) return;
  try {
    // On ne stocke que les infos publiques du classement (pas les données sensibles)
    const pub = {
      id: profile.id,
      name: profile.name,
      avatar: profile.avatar,
      xp: profile.xp || 0,
      myBirds: profile.myBirds || [],
      myLocs: profile.myLocs || [],
      updatedAt: new Date().toISOString()
    };
    await firebaseDb.ref(`groups/${groupCode}/profiles/${profile.id}`).set(pub);
  } catch(e) { console.error("pushProfile error:", e); }
}

// Merger les profils distants dans le localStorage
function mergeRemoteProfiles(remoteProfiles) {
  const db = getDB();
  let changed = false;
  Object.values(remoteProfiles).forEach(remote => {
    if (!remote || !remote.id) return;
    const local = db.profiles[remote.id];

    if (!local) {
      // Profil inconnu localement → on l'importe toujours
      db.profiles[remote.id] = remote;
      changed = true;
      return;
    }

    // Profil courant : on ne l'écrase jamais avec une version distante
    if (remote.id === currentProfileId) return;

    // Mettre à jour si la version distante est plus récente
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    const localTime  = local.updatedAt  ? new Date(local.updatedAt).getTime()  : 0;
    if (remoteTime > localTime) {
      db.profiles[remote.id] = remote;
      changed = true;
    }
  });
  if (changed) saveDB(db);
  return changed;
}

// Listener temps réel sur tout le groupe (déclenché à l'entrée dans l'app)
function startRealtimeSync() {
  if (!firebaseDb || !groupCode) return;
  if (syncListener) {
    firebaseDb.ref(`groups/${groupCode}/sharedBirds`).off("value", syncListener);
    syncListener = null;
  }

  // Sync oiseaux partagés
  syncListener = firebaseDb.ref(`groups/${groupCode}/sharedBirds`).on("value", snap => {
    const data = snap.val();
    if (!data) return;
    Object.entries(data).forEach(([locKey, birdsObj]) => {
      const birds = Object.values(birdsObj);
      if (birds.length === 0) return;
      const loc = birds[0].location || locKey;
      mergeSharedBirdsLocally(loc, birds);
    });
    if (currentProfileId) renderLocationsTab();
  });

  // Sync sessions de scan en temps réel → stats de fréquence partagées
  firebaseDb.ref(`groups/${groupCode}/sessions`).on("value", () => {
    pullSessionsFromFirebase().then(() => {
      if (currentProfileId) renderLocationsTab();
    });
  });

  // Sync lieux du groupe en temps réel → tout le monde voit les nouveaux lieux
  firebaseDb.ref(`groups/${groupCode}/locations`).on("value", snap => {
    const data = snap.val();
    const db = getDB();
    const newLocs = data
      ? Object.values(data).filter(e => e && e.name).map(e => e.name)
      : [];
    const oldLocs = db.groupLocs || [];
    const same = newLocs.length === oldLocs.length && newLocs.every(l => oldLocs.includes(l));
    if (!same) {
      db.groupLocs = newLocs;
      saveDB(db);
      if (currentProfileId) {
        renderLocationsTab();
        renderLocationSelect();
      }
    }
  });

  // Sync renamedDefaults (pour que tous les appareils voient les renommages des lieux par défaut)
  firebaseDb.ref(`groups/${groupCode}/renamedDefaults`).on("value", snap => {
    const data = snap.val();
    const db = getDB();
    db.renamedDefaults = data || {};
    saveDB(db);
    if (currentProfileId) {
      renderLocationsTab();
      renderLocationSelect();
    }
  });

  // Sync profils famille en temps réel → classement toujours à jour
  firebaseDb.ref(`groups/${groupCode}/profiles`).on("value", snap => {
    const data = snap.val();
    if (!data) return;
    const changed = mergeRemoteProfiles(data);
    // Toujours re-render le classement (même si pas de changement local, les données sont là)
    if (currentProfileId) {
      const statsTab = document.getElementById("tab-stats");
      if (statsTab && statsTab.classList.contains("active")) renderStats();
    }
    // Re-render la sélection de profils si on y est
    const profileScreen = document.getElementById("profileScreen");
    if (profileScreen && profileScreen.classList.contains("active")) renderProfileScreen();
  });
}

// ========== ONBOARDING (nouveau profil / première connexion) ==========
const ALLOWED_GROUP = "FAMILLE"; // Seul code autorisé

function getStoredGroupCode() { return localStorage.getItem("birdrGroupCode") || null; }
function storeGroupCode(code) { localStorage.setItem("birdrGroupCode", code); groupCode = code; }

// Mémoriser / récupérer le dernier profil utilisé sur cet appareil
function getLastProfileId() { return localStorage.getItem("birdyLastProfile") || null; }
function storeLastProfileId(id) { localStorage.setItem("birdyLastProfile", id); }

function showOnboarding() {
  document.getElementById("onboardingScreen").classList.add("active");
  document.getElementById("profileScreen").classList.remove("active");
  document.getElementById("appScreen").classList.remove("active");
  // Ne pas pré-remplir le code groupe
  const gi = document.getElementById("obGroupInput");
  if (gi) gi.value = "";
  renderObAvatarPicker();
}

function renderObAvatarPicker() {
  const picker = document.getElementById("obAvatarPicker");
  if (!picker) return;
  picker.innerHTML = "";
  AVATARS.forEach(av => {
    const btn = document.createElement("button");
    btn.className = "ob-avatar-btn" + (av === selectedAvatar ? " selected" : "");
    btn.textContent = av;
    btn.onclick = () => {
      selectedAvatar = av;
      picker.querySelectorAll(".ob-avatar-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    };
    picker.appendChild(btn);
  });
}

async function handleOnboardingSubmit() {
  const name      = (document.getElementById("obNameInput").value || "").trim();
  const code      = (document.getElementById("obGroupInput").value || "").trim().toUpperCase().replace(/\s/g, "");
  const errEl     = document.getElementById("obGroupError");
  const btn       = document.getElementById("obJoinBtn");

  errEl.textContent = "";
  if (!name) { document.getElementById("obNameInput").focus(); errEl.textContent = "Entre ton prénom !"; return; }
  if (code !== ALLOWED_GROUP) { errEl.textContent = "Code invalide. Demande le code à ta famille ! 🏡"; return; }

  btn.disabled = true;
  btn.querySelector("span").textContent = "Connexion…";

  if (!firebaseDb) {
    errEl.textContent = "Firebase non connecté. Vérifie ta connexion.";
    btn.disabled = false; btn.querySelector("span").textContent = "Rejoindre le groupe";
    return;
  }

  const exists = await groupExists(code);
  if (!exists) {
    // On crée le groupe seulement si c'est le code par défaut FAMILLE ou un code valide
    const ok = await createGroupInFirebase(code);
    if (!ok) {
      errEl.textContent = "Erreur lors de la connexion. Réessaie.";
      btn.disabled = false; btn.querySelector("span").textContent = "Rejoindre le groupe";
      return;
    }
  }

  storeGroupCode(code);
  startRealtimeSync();

  // Créer le profil
  const db = getDB();
  const id = "p_" + Date.now();
  const newProfile = { id, name, avatar: selectedAvatar, xp: 0, myBirds: [], myLocs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  db.profiles[id] = newProfile;
  saveDB(db);
  pushProfileToFirebase(newProfile);

  document.getElementById("onboardingScreen").classList.remove("active");
  openProfile(id);
}

// ========== DB LOCALE ==========
function getDB() { return JSON.parse(localStorage.getItem("birdyDexDB") || '{"profiles":{},"sharedBirds":{}}'); }
function saveDB(db) { localStorage.setItem("birdyDexDB", JSON.stringify(db)); }
function getProfile(id) { return getDB().profiles[id] || null; }
function saveProfile(p) {
  p.updatedAt = new Date().toISOString();
  const db = getDB();
  db.profiles[p.id] = p;
  saveDB(db);
  pushProfileToFirebase(p); // Sync Firebase
}
function getAllProfiles() { return Object.values(getDB().profiles); }

function getSharedBirds(location) {
  const db = getDB();
  return (db.sharedBirds || {})[location] || [];
}
function saveSharedBirds(location, birds) {
  const db = getDB();
  if (!db.sharedBirds) db.sharedBirds = {};
  db.sharedBirds[location] = birds;
  saveDB(db);
}

function uniqueMyBirds(profile) {
  const seen = {};
  (profile.myBirds || []).forEach(b => { seen[b.name] = b; });
  return Object.values(seen);
}

function migrateProfile(profile) {
  if (profile.birds && !profile.myBirds) {
    profile.myBirds = [];
    profile.myLocs  = [];
    const seen = {};
    Object.entries(profile.birds).forEach(([loc, birds]) => {
      if (!profile.myLocs.includes(loc)) profile.myLocs.push(loc);
      birds.forEach(b => {
        if (!seen[b.name]) { seen[b.name] = true; profile.myBirds.push({ ...b, location: loc }); }
      });
    });
    delete profile.birds;
    saveProfile(profile);
  }
  if (!profile.myBirds) profile.myBirds = [];
  if (!profile.myLocs)  profile.myLocs  = [];
  return profile;
}

function getLevel(xp) {
  if (xp < 50)   return { level: 1, next: 50 };
  if (xp < 150)  return { level: 2, next: 150 };
  if (xp < 350)  return { level: 3, next: 350 };
  if (xp < 700)  return { level: 4, next: 700 };
  if (xp < 1200) return { level: 5, next: 1200 };
  return { level: Math.floor(xp / 500) + 1, next: (Math.floor(xp / 500) + 2) * 500 };
}

// ========== SCAN GEMINI ==========
async function extractBirdNamesWithGemini(base64Image) {
  const pureBase64 = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image;
  const body = {
    contents: [{
      parts: [
        { text: 'Liste les oiseaux sur ce screenshot de l\'app Merlin. Pour chaque oiseau, indique son nom français ET sa rareté (déterminée par la pastille visible à droite de son nom : pastille rouge = "rare", pastille marron/ambre à moitié remplie = "uncommon", pas de pastille = "common"). Retourne UNIQUEMENT un objet JSON avec une clé "birds" contenant un tableau d\'objets. Exemple: {"birds": [{"name": "Merle noir", "rarity": "common"}, {"name": "Fauvette babillarde", "rarity": "rare"}, {"name": "Corbeau freux", "rarity": "uncommon"}]}. Réponds UNIQUEMENT avec le JSON, sans texte avant ou après.' },
        { inline_data: { mime_type: "image/png", data: pureBase64.trim() } }
      ]
    }]
  };
  const resp = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error.message);
  const text = json.candidates[0].content.parts[0].text;
  try {
    const clean  = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    // Support both [{name, rarity}] and ["name"] formats
    const birds = parsed.birds || [];
    return birds.map(b => typeof b === "string" ? { name: b, rarity: "common" } : { name: b.name, rarity: b.rarity || "common" });
  } catch(e) {
    return text.split(',').map(s => s.trim()).filter(s => s.length > 0).map(name => ({ name, rarity: "common" }));
  }
}

// ========== IMAGES OISEAUX via iNaturalist ==========
// iNaturalist = base de données de terrain, photos parfaitement cadrées sur l'animal

// Génère une image placeholder SVG avec les initiales de l'oiseau
function generateBirdPlaceholder(name) {
  const initials = name.split(" ").slice(0, 2).map(w => w[0].toUpperCase()).join("");
  const colors = ["#2d5a27","#d4862a","#7bb8d4","#c0432a","#8db87a","#5a3e2b","#6b8f71"];
  const color = colors[name.length % colors.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <rect width="100" height="100" fill="${color}" rx="12"/>
    <text x="50" y="58" font-family="Georgia,serif" font-size="28" fill="white" text-anchor="middle" font-weight="bold">${initials}</text>
    <text x="50" y="80" font-family="Georgia,serif" font-size="10" fill="rgba(255,255,255,0.7)" text-anchor="middle">🕊️</text>
  </svg>`;
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
}

// Cherche via iNaturalist : retourne { thumb, photos[], sciName }
async function fetchFromiNaturalist(frenchName) {
  try {
    const url = `https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(frenchName)}&locale=fr&rank=species&photos=true&per_page=1`;
    const resp = await fetch(url);
    const data = await resp.json();
    const taxon = data.results?.[0];
    if (!taxon) return null;

    // Photo principale
    const thumb = taxon.default_photo?.medium_url || taxon.default_photo?.url || null;

    // Galerie : jusqu'à 8 photos depuis taxon_photos
    const gallery = (taxon.taxon_photos || [])
      .map(tp => tp.photo?.medium_url || tp.photo?.url)
      .filter(Boolean)
      .slice(0, 8);

    if (thumb && !gallery.includes(thumb)) gallery.unshift(thumb);

    return {
      thumb: thumb || (gallery[0] || null),
      photos: gallery,
      sciName: taxon.name || null,
      wikiUrl: taxon.wikipedia_url || null
    };
  } catch(e) {
    console.warn("iNaturalist fetch failed for", frenchName, e);
    return null;
  }
}

// Fallback Wikimedia Commons : cherche par nom dans l'espace fichiers (namespace 6)
async function fetchFromWikimediaCommons(frenchName) {
  try {
    // Chercher les fichiers image correspondants
    const searchResp = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&list=search&srnamespace=6&srsearch=${encodeURIComponent(frenchName)}&srlimit=8&format=json&origin=*`
    );
    const searchData = await searchResp.json();
    const hits = searchData.query?.search || [];
    if (hits.length === 0) return [];

    // Filtrer pour garder seulement les vrais jpg/png de l'oiseau
    const titles = hits
      .map(h => h.title)
      .filter(t => /\.(jpg|jpeg|png)$/i.test(t) && !/map|carte|range|distribution|logo|icon/i.test(t))
      .slice(0, 6);

    if (titles.length === 0) return [];

    // Récupérer les URLs de thumbnails
    const titlesParam = titles.map(t => encodeURIComponent(t)).join("|");
    const urlsResp = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&titles=${titlesParam}&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json&origin=*`
    );
    const urlsData = await urlsResp.json();
    return Object.values(urlsData.query?.pages || {})
      .map(p => p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url)
      .filter(Boolean);
  } catch(e) {
    return [];
  }
}

// Fonction principale : iNaturalist en priorité, Commons en fallback
async function fetchBirdImageMain(frenchName) {
  const inat = await fetchFromiNaturalist(frenchName);
  if (inat?.thumb) return inat.thumb;
  const commons = await fetchFromWikimediaCommons(frenchName);
  return commons[0] || null;
}

async function fetchBirdImages(birdObjects, onProgress) {
  const images = [];
  for (let i = 0; i < birdObjects.length; i++) {
    const name = typeof birdObjects[i] === "string" ? birdObjects[i] : birdObjects[i].name;
    if (onProgress) onProgress(i + 1, birdObjects.length, name);
    const url = await fetchBirdImageMain(name);
    images.push(url || generateBirdPlaceholder(name));
    if (i < birdObjects.length - 1) await new Promise(r => setTimeout(r, 100));
  }
  return images;
}



// ========== NOTIFICATIONS ==========
// Structure Firebase: groups/{code}/notifications/{profileId}/{notifId}
// { fromName, fromAvatar, birdCount, xp, timestamp, read: false }

async function pushNotificationsForProfiles(profileIds, fromProfile, newBirdsCount, xpGained) {
  if (!firebaseDb || !groupCode) return;
  const notif = {
    fromName:   fromProfile.name,
    fromAvatar: fromProfile.avatar,
    birdCount:  newBirdsCount,
    xp:         xpGained,
    timestamp:  new Date().toISOString(),
    read:       false
  };
  const pushes = profileIds
    .filter(id => id !== fromProfile.id) // don't notify yourself
    .map(id => firebaseDb.ref(`groups/${groupCode}/notifications/${id}`).push(notif));
  await Promise.all(pushes);
}

function listenForNotifications(profileId) {
  if (!firebaseDb || !groupCode || !profileId) return;
  firebaseDb.ref(`groups/${groupCode}/notifications/${profileId}`)
    .on("value", snap => {
      const data = snap.val();
      if (!data) { updateNotifBadge(0); return; }
      // Filtrer côté client (évite le warning Firebase index)
      const allNotifs = Object.entries(data).map(([k, v]) => ({ key: k, ...v }));
      const unread = allNotifs.filter(n => !n.read);
      updateNotifBadge(unread.length);
      if (unread.length > 0) {
        unread.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        showNotifToast(unread[0], profileId, unread);
      }
    });
}

function updateNotifBadge(count) {
  const badge = document.getElementById("notifBadge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.add("visible");
  } else {
    badge.classList.remove("visible");
  }
}

function showNotifToast(notif, profileId, allNotifs) {
  // Only show once per session per notif key
  const seenKey = "notifSeen_" + notif.key;
  if (sessionStorage.getItem(seenKey)) return;
  sessionStorage.setItem(seenKey, "1");

  const toast = document.createElement("div");
  toast.className = "notif-toast";
  toast.innerHTML = `
    <div class="notif-toast-icon">${notif.fromAvatar}</div>
    <div class="notif-toast-body">
      <div class="notif-toast-title">${notif.fromName} a ajouté des découvertes !</div>
      <div class="notif-toast-sub">+${notif.birdCount} oiseau${notif.birdCount > 1 ? "x" : ""} · +${notif.xp} XP pour vous</div>
    </div>
    <button class="notif-toast-close">✕</button>
  `;
  toast.querySelector(".notif-toast-close").onclick = () => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 350);
    markNotifsAsRead(profileId, allNotifs);
  };
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  // Auto-dismiss after 6s
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 350);
      markNotifsAsRead(profileId, allNotifs);
    }
  }, 6000);
}

async function markNotifsAsRead(profileId, notifs) {
  if (!firebaseDb || !groupCode) return;
  const updates = {};
  notifs.forEach(n => {
    updates[`groups/${groupCode}/notifications/${profileId}/${n.key}/read`] = true;
  });
  try { await firebaseDb.ref().update(updates); } catch(e) {}
}

// ========== SCAN MULTI-PROFILE PICKER ==========
function renderScanProfilePicker() {
  const container = document.getElementById("scanProfilesPicker");
  if (!container) return;
  const profiles = getAllProfiles();
  container.innerHTML = "";
  profiles.forEach(p => {
    const chip = document.createElement("div");
    chip.className = "scan-profile-chip" + (p.id === currentProfileId ? " is-me selected" : "");
    chip.dataset.profileId = p.id;
    chip.innerHTML = `<span class="chip-avatar">${p.avatar}</span><span>${p.name}</span>`;
    chip.onclick = () => {
      // Always keep at least 1 selected (current user always stays selected if alone)
      const selected = container.querySelectorAll(".scan-profile-chip.selected");
      if (chip.classList.contains("selected") && selected.length === 1) return;
      chip.classList.toggle("selected");
    };
    container.appendChild(chip);
  });
}

function getSelectedProfileIds() {
  const container = document.getElementById("scanProfilesPicker");
  if (!container) return [currentProfileId];
  const chips = container.querySelectorAll(".scan-profile-chip.selected");
  const ids = Array.from(chips).map(c => c.dataset.profileId);
  return ids.length > 0 ? ids : [currentProfileId];
}

// ========== SCAN BUTTON ==========
document.addEventListener("DOMContentLoaded", () => {
document.getElementById("analyzeBtn").addEventListener("click", async () => {
  const file = document.getElementById("imageInput").files[0];
  if (!file) { alert("Choisis une image d'abord"); return; }

  const location = document.getElementById("locationSelect").value;
  const status   = document.getElementById("scanStatus");
  const btn      = document.getElementById("analyzeBtn");

  btn.disabled       = true;
  status.textContent = "🤖 Gemini analyse le screenshot Merlin…";

  try {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const birds = await extractBirdNamesWithGemini(e.target.result);
        if (birds.length === 0) {
          status.textContent = "Aucun oiseau détecté. Essayez une autre image.";
          btn.disabled = false;
          return;
        }
        status.textContent = `✅ ${birds.length} oiseau(x) détecté(s) — recherche des photos…`;
        const birdImages = await fetchBirdImages(birds, (i, total, name) => {
          status.textContent = `🖼️ Photo ${i}/${total} : ${name}…`;
        });
        // birds is now [{name, rarity}], pass as-is to all selected profiles
        const selectedIds = getSelectedProfileIds();
        let totalNewBirds = 0;
        let totalXp = 0;
        for (const profileId of selectedIds) {
          const result = await addBirdsToProfile(birds, birdImages, location, profileId);
          if (result && profileId !== currentProfileId) {
            totalNewBirds += result.newCount;
            totalXp       += result.xpGained;
          }
        }
        // Notify other selected profiles
        if (selectedIds.length > 1 && totalNewBirds > 0) {
          const me = getProfile(currentProfileId);
          const othersIds = selectedIds.filter(id => id !== currentProfileId);
          await pushNotificationsForProfiles(othersIds, me, totalNewBirds, totalXp);
        }
        status.textContent = "";
        document.getElementById("imageInput").value = "";
      } catch(err) {
        status.textContent = "❌ Erreur : " + err.message;
      }
      btn.disabled = false;
    };
    reader.readAsDataURL(file);
  } catch (e) {
    status.textContent = "Erreur lors de l'analyse.";
    btn.disabled = false;
  }
});
}); // end DOMContentLoaded analyzeBtn


// ========== SESSIONS DE SCAN (fréquence des oiseaux par lieu) ==========
// Stocké dans Firebase (données partagées du groupe) + cache local

// Lire les sessions depuis le cache local (rempli par le listener Firebase)
function getLocSessions(location) {
  const db = getDB();
  return (db.locSessions || {})[location] || [];
}

// Enregistrer une session dans Firebase ET en local
async function recordScanSession(location, birdNames) {
  if (!birdNames || birdNames.length === 0) return;
  const session = { date: new Date().toISOString(), birds: birdNames };

  // Local (cache)
  const db = getDB();
  if (!db.locSessions) db.locSessions = {};
  if (!db.locSessions[location]) db.locSessions[location] = [];
  db.locSessions[location].push(session);
  saveDB(db);

  // Firebase (partagé avec tout le groupe)
  if (firebaseDb && groupCode) {
    try {
      await firebaseDb.ref(`groups/${groupCode}/sessions/${locationKey(location)}`).push(session);
    } catch(e) { console.warn("recordScanSession Firebase error:", e); }
  }
}

// Sync les sessions Firebase → local (appelé au démarrage et par le listener)
async function pullSessionsFromFirebase() {
  if (!firebaseDb || !groupCode) return;
  try {
    const snap = await firebaseDb.ref(`groups/${groupCode}/sessions`).once("value");
    const data = snap.val();
    const db = getDB();
    db.locSessions = {};
    if (data) {
      Object.entries(data).forEach(([locKey, sessionsObj]) => {
        // Retrouver le vrai nom du lieu depuis sharedBirds ou groupLocs
        const locName = Object.values(db.sharedBirds || {})
          .flatMap(b => b)
          .find(b => locationKey(b.location || "") === locKey)?.location
          || (db.groupLocs || []).find(l => locationKey(l) === locKey)
          || locKey;
        db.locSessions[locName] = Object.values(sessionsObj);
      });
    }
    saveDB(db);
  } catch(e) { console.warn("pullSessionsFromFirebase error:", e); }
}

// Calcule les stats de fréquence pour un lieu
function getFrequencyStats(location) {
  const sessions = getLocSessions(location);
  if (sessions.length === 0) return { total: 0, stats: {} };
  const total = sessions.length;
  const counts = {};
  sessions.forEach(s => {
    (s.birds || []).forEach(name => {
      counts[name] = (counts[name] || 0) + 1;
    });
  });
  const stats = {};
  Object.entries(counts).forEach(([name, count]) => {
    const pct = Math.round((count / total) * 100);
    // NC si 1 seule session au total (pas assez de données pour être significatif)
    const label = total === 1 ? "NC" : pct + "%";
    stats[name] = { count, total, pct, label };
  });
  return { total, stats };
}

// Badge de fréquence HTML
function freqBadgeHTML(birdName, location) {
  const { total, stats } = getFrequencyStats(location);
  if (total === 0) return "";
  const s = stats[birdName];
  if (!s) return "";
  // NC = pas assez de données
  if (s.label === "NC") {
    return `<span class="freq-badge" style="color:#aaa;background:rgba(0,0,0,0.04)">NC</span>`;
  }
  const color = s.pct >= 80 ? "#2d5a27"
              : s.pct >= 40 ? "#7a5c0f"
              : "#888";
  const bg    = s.pct >= 80 ? "rgba(45,90,39,0.1)"
              : s.pct >= 40 ? "rgba(212,134,42,0.1)"
              : "rgba(0,0,0,0.05)";
  return `<span class="freq-badge" style="color:${color};background:${bg}">${s.label}</span>`;
}

// ========== AJOUTER DES OISEAUX ==========
async function addBirdsToProfile(names, images, location, targetProfileId = null) {
  const profileId = targetProfileId || currentProfileId;
  let p = getProfile(profileId);
  if (!p.myBirds) p.myBirds = [];
  if (!p.myLocs)  p.myLocs  = [];

  const myExistingNames     = uniqueMyBirds(p).map(b => b.name);
  const sharedExistingNames = getSharedBirds(location).map(b => b.name);
  const sharedBirds         = getSharedBirds(location);
  const firebasePushes      = [];
  const newBirds            = [];
  let   xpGained            = 0;

  // XP par rareté
  const XP_BY_RARITY = { common: 25, uncommon: 50, rare: 100 };

  const sessionBirdNames = []; // tous les oiseaux de ce scan (nouveaux + existants)

  names.forEach((birdObj, i) => {
    const name   = typeof birdObj === "string" ? birdObj : birdObj.name;
    const rarity = (typeof birdObj === "object" && birdObj.rarity) ? birdObj.rarity : "common";
    const bird   = { name, image: images[i], date: new Date().toISOString(), location, addedBy: p.name, rarity };

    sessionBirdNames.push(name); // toujours compter, même si déjà présent

    // Ajout dans la liste partagée (locale + Firebase) si pas déjà présent
    if (!sharedExistingNames.includes(name)) {
      sharedBirds.push(bird);
      sharedExistingNames.push(name);
      firebasePushes.push(pushBirdToFirebase(location, bird));
    }

    // Ajout au profil personnel si nouvel oiseau pour CE profil
    if (!myExistingNames.includes(name)) {
      p.myBirds.unshift(bird);
      newBirds.push({ ...bird, isNew: true });
      xpGained += XP_BY_RARITY[rarity] || 25;
      myExistingNames.push(name);
    }
  });

  if (!p.myLocs.includes(location)) p.myLocs.push(location);
  saveSharedBirds(location, sharedBirds);

  // Enregistrer la session de scan pour les stats de fréquence (Firebase + local)
  await recordScanSession(location, sessionBirdNames);

  // Envoi Firebase en parallèle
  await Promise.all(firebasePushes);

  if (newBirds.length > 0) {
    p.xp = (p.xp || 0) + xpGained;
    saveProfile(p);
    currentLocation = location;
    renderLocationsTab();
    renderLocationSelect();
    // Show discovery modal only for the active profile
    if (!targetProfileId || targetProfileId === currentProfileId) {
      showDiscoveryModal(newBirds, xpGained);
    }
  } else {
    saveProfile(p);
    // Only alert for the active profile
    if (!targetProfileId || targetProfileId === currentProfileId) {
      alert("Aucun nouvel oiseau pour toi dans ce lot 🙂");
    }
  }
  return { newCount: newBirds.length, xpGained };
}

// ========== HAPTIC FEEDBACK ==========
function haptic(type = "light") {
  if (!navigator.vibrate) return;
  const patterns = { light: [10], medium: [20], success: [10, 50, 20] };
  navigator.vibrate(patterns[type] || [10]);
}

// ========== RESET COMPLET ==========
function promptDevReset() {
  const code = prompt("Code développeur requis :");
  if (code === null) return;
  if (code !== "BIRDY2024") { alert("Code incorrect."); return; }
  resetAllData();
}

async function resetAllData() {
  const confirmed = confirm("⚠️ Supprimer TOUS les profils, oiseaux, lieux et données ?\n\nCela efface aussi Firebase (données partagées du groupe).");
  if (!confirmed) return;

  // Effacer Firebase en premier (on a encore groupCode)
  if (firebaseDb && groupCode) {
    try {
      await firebaseDb.ref(`groups/${groupCode}`).remove();
      console.log("✅ Firebase groupe effacé");
    } catch(e) { console.error("Erreur reset Firebase:", e); }
  }

  // Couper les listeners
  if (syncListener && firebaseDb && groupCode) {
    firebaseDb.ref(`groups/${groupCode}/sharedBirds`).off("value", syncListener);
    syncListener = null;
  }

  localStorage.clear();
  groupCode = null;
  currentProfileId = null;
  document.getElementById("appScreen").classList.remove("active");
  document.getElementById("profileScreen").classList.remove("active");
  selectedAvatar = AVATARS[0];
  showOnboarding();
  alert("✅ Tout effacé (local + Firebase). L'app repart de zéro.");
}
function showDiscoveryModal(birds, xp) {
  haptic("success");
  document.getElementById("modalXp").textContent = xp;
  // Colorize XP badge by highest rarity found
  const xpBadge = document.querySelector(".xp-badge");
  if (xpBadge) {
    xpBadge.className = "xp-badge";
    if (birds.some(b => b.rarity === "rare"))          xpBadge.classList.add("rare");
    else if (birds.some(b => b.rarity === "uncommon")) xpBadge.classList.add("uncommon");
  }
  const modalBirds = document.getElementById("modalBirds");
  modalBirds.innerHTML = birds.map(b => {
    const r = b.rarity || "common";
    const rarityTag = r === "rare"     ? `<span class="modal-bird-tag" style="background:var(--red-breast)">⭐ RARE · +100 XP</span>` :
                      r === "uncommon" ? `<span class="modal-bird-tag" style="background:var(--amber)">◑ PEU COMMUN · +50 XP</span>` :
                      b.isNew          ? `<span class="modal-bird-tag">NOUVEAU ! · +25 XP</span>` : "";
    return `
    <div class="modal-bird-item">
      <img src="${b.image}" alt="${b.name}" style="object-fit:cover;object-position:center top;">
      <span class="modal-bird-name">${b.name}</span>
      ${rarityTag}
    </div>
  `}).join("");

  const confetti = document.getElementById("modalConfetti");
  confetti.innerHTML = "";
  const colors = ["#2d5a27","#d4862a","#7bb8d4","#c0432a","#8db87a","#ede5d0"];
  for (let i = 0; i < 20; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti-piece";
    piece.style.cssText = `left:${Math.random()*100}%;background:${colors[Math.floor(Math.random()*colors.length)]};animation-duration:${0.8+Math.random()*1.5}s;animation-delay:${Math.random()*0.5}s;transform:rotate(${Math.random()*360}deg);`;
    confetti.appendChild(piece);
  }
  document.getElementById("discoveryModal").classList.add("show");

  const freshP = getProfile(currentProfileId);
  const lvl    = getLevel(freshP.xp || 0);
  document.getElementById("topbarXp").textContent = `Niv.${lvl.level} · ${freshP.xp || 0} XP`;
}

document.addEventListener("DOMContentLoaded", () => {
document.getElementById("modalClose").onclick = () => {
  document.getElementById("discoveryModal").classList.remove("show");
  // Aller sur l'onglet Lieux du lieu où les oiseaux ont été ajoutés
  switchTab("locations");
};

});
// ========== ÉCRAN PROFILS (utilisateurs déjà connectés) ==========
function renderProfileScreen() {
  const profiles = getAllProfiles();
  const list     = document.getElementById("profilesList");
  list.innerHTML = "";

  profiles.forEach(rawP => {
    const p      = migrateProfile(rawP);
    const unique = uniqueMyBirds(p);
    const locs   = (p.myLocs || []).length;
    const lvl    = getLevel(p.xp || 0);
    const div    = document.createElement("div");
    div.className = "profile-card";
    div.innerHTML = `
      <div class="profile-card-avatar">${p.avatar}</div>
      <div class="profile-card-info">
        <div class="profile-card-name">${p.name}</div>
        <div class="profile-card-stats">Niv.${lvl.level} · ${unique.length} espèces · ${locs} lieu${locs > 1 ? "x" : ""}</div>
      </div>
      <span class="profile-card-arrow">›</span>
    `;
    div.onclick = () => openProfile(p.id);
    list.appendChild(div);
  });

  if (profiles.length === 0) {
    list.innerHTML = `<p style="color:rgba(255,255,255,0.5);text-align:center;font-size:14px;margin-bottom:12px;">Aucun profil. Créez le vôtre !</p>`;
  }
  
  // Wire add profile button
  const addBtn = document.getElementById("addProfileBtn");
  if (addBtn) addBtn.onclick = openAddProfileModal;
}

function openProfile(id) {
  currentProfileId = id;
  storeLastProfileId(id); // Mémoriser le profil sur cet appareil
  let p = getProfile(id);
  p     = migrateProfile(p);
  pushProfileToFirebase(p); // S'assurer que Firebase est à jour
  const lvl = getLevel(p.xp || 0);
  document.getElementById("topbarName").textContent   = p.name;
  document.getElementById("topbarXp").textContent     = `Niv.${lvl.level} · ${p.xp || 0} XP`;
  const avatarBtn = document.getElementById("topbarAvatar");
  avatarBtn.textContent = p.avatar;
  // Badge groupe
  const badge = document.getElementById("topbarGroupBadge");
  if (badge) badge.textContent = groupCode ? `🏡 ${groupCode}` : "";
  document.getElementById("onboardingScreen").classList.remove("active");
  document.getElementById("profileScreen").classList.remove("active");
  document.getElementById("appScreen").classList.add("active");
  currentLocation = DEFAULT_LOCATIONS[0];
  switchTab("locations");
  renderLocationsTab();
  renderLocationSelect();
  renderScanProfilePicker();
  listenForNotifications(id);
  pullSharedBirdsForLocation(currentLocation).then(() => renderLocationsTab());
}


// ========== FAVORIS DE LIEUX ==========
function getFavLocs() {
  return JSON.parse(localStorage.getItem("birdyFavLocs") || "[]");
}
function toggleFavLoc(locName) {
  let favs = getFavLocs();
  if (favs.includes(locName)) {
    favs = favs.filter(f => f !== locName);
  } else {
    favs.push(locName);
  }
  localStorage.setItem("birdyFavLocs", JSON.stringify(favs));
}
function isFavLoc(locName) {
  return getFavLocs().includes(locName);
}

// Tri: favoris en premier, puis reste dans l'ordre
function sortLocsWithFavs(locs) {
  const favs = getFavLocs();
  const favSet = new Set(favs);
  const favLocs    = favs.filter(f => locs.includes(f));       // favoris dans l'ordre mémorisé
  const nonFavLocs = locs.filter(l => !favSet.has(l));         // reste
  return [...favLocs, ...nonFavLocs];
}

// Renommage d'un lieu (local + Firebase) — tout en une seule passe atomique
async function renameLoc(oldName, newName) {
  if (!newName || newName === oldName) return;
  const db = getDB();

  // 1. localStorage sharedBirds
  if (db.sharedBirds && db.sharedBirds[oldName]) {
    db.sharedBirds[newName] = db.sharedBirds[oldName].map(b => ({ ...b, location: newName }));
    delete db.sharedBirds[oldName];
  }

  // 2. groupLocs locale : remplacer si présent, sinon ajouter
  if (!db.groupLocs) db.groupLocs = [];
  const idx = db.groupLocs.indexOf(oldName);
  if (idx !== -1) db.groupLocs[idx] = newName;
  else if (!db.groupLocs.includes(newName)) db.groupLocs.push(newName);

  // 3. renamedDefaults : mémoriser les lieux par défaut renommés pour les masquer
  if (!db.renamedDefaults) db.renamedDefaults = {};
  if (DEFAULT_LOCATIONS.includes(oldName)) {
    db.renamedDefaults[oldName] = newName; // "Chalon" → "Le Chalon"
  }
  // Propager les renommages en cascade (si on renomme un déjà-renommé)
  Object.keys(db.renamedDefaults).forEach(orig => {
    if (db.renamedDefaults[orig] === oldName) db.renamedDefaults[orig] = newName;
  });

  saveDB(db);

  // 4. Favoris
  const favs = getFavLocs();
  const fi = favs.indexOf(oldName);
  if (fi !== -1) { favs[fi] = newName; localStorage.setItem("birdyFavLocs", JSON.stringify(favs)); }

  // 5. Firebase : tout en UN SEUL update atomique
  if (firebaseDb && groupCode) {
    try {
      const updates = {};
      // Nouveau lieu dans /locations
      updates[`groups/${groupCode}/locations/${locationKey(newName)}`] = {
        name: newName,
        createdAt: new Date().toISOString()
      };
      // Supprimer ancien lieu dans /locations
      updates[`groups/${groupCode}/locations/${locationKey(oldName)}`] = null;

      // Migrer les oiseaux depuis l'ancien nœud Firebase
      const snap = await firebaseDb.ref(`groups/${groupCode}/sharedBirds/${locationKey(oldName)}`).once("value");
      const data = snap.val();
      if (data) {
        Object.entries(data).forEach(([k, v]) => {
          updates[`groups/${groupCode}/sharedBirds/${locationKey(newName)}/${k}`] = { ...v, location: newName };
        });
        updates[`groups/${groupCode}/sharedBirds/${locationKey(oldName)}`] = null;
      }

      // Stocker les renommages côté Firebase aussi (pour les autres appareils)
      updates[`groups/${groupCode}/renamedDefaults/${locationKey(oldName)}`] = newName;

      await firebaseDb.ref().update(updates);
    } catch(e) { console.error("renameLoc Firebase error:", e); }
  }

  if (currentLocation === oldName) currentLocation = newName;
  renderLocationsTab();
  renderLocationSelect();
}

// Supprimer un lieu (local + Firebase)
async function deleteLoc(locName) {
  const db = getDB();

  // localStorage : sharedBirds
  if (db.sharedBirds) delete db.sharedBirds[locName];

  // localStorage : groupLocs
  if (db.groupLocs) db.groupLocs = db.groupLocs.filter(l => l !== locName);

  saveDB(db);

  // Favoris
  const favs = getFavLocs().filter(f => f !== locName);
  localStorage.setItem("birdyFavLocs", JSON.stringify(favs));

  // Firebase : supprimer lieu + oiseaux en une seule passe
  if (firebaseDb && groupCode) {
    try {
      const updates = {};
      updates[`groups/${groupCode}/locations/${locationKey(locName)}`] = null;
      updates[`groups/${groupCode}/sharedBirds/${locationKey(locName)}`] = null;
      await firebaseDb.ref().update(updates);
    } catch(e) { console.error("deleteLoc Firebase error:", e); }
  }

  // Aller sur le premier lieu disponible
  const remaining = [...new Set([
    ...DEFAULT_LOCATIONS,
    ...(getDB().groupLocs || []),
    ...Object.keys(getDB().sharedBirds || {})
  ])];
  currentLocation = remaining[0] || DEFAULT_LOCATIONS[0];
  renderLocationsTab();
  renderLocationSelect();
}

// Trier une liste d'oiseaux selon le critère choisi
function sortBirds(birds, sortBy, location = null) {
  const rarityVal = r => ({ rare: 0, uncommon: 1, common: 2 })[r] ?? 2;
  const copy = [...birds];
  if (sortBy === "alpha")  return copy.sort((a, b) => a.name.localeCompare(b.name, "fr"));
  if (sortBy === "rarity") return copy.sort((a, b) => rarityVal(a.rarity) - rarityVal(b.rarity));
  if (sortBy === "freq" && location) {
    const { stats } = getFrequencyStats(location);
    return copy.sort((a, b) => {
      const pa = stats[a.name]?.pct ?? -1;
      const pb = stats[b.name]?.pct ?? -1;
      return pb - pa; // plus haut % en premier
    });
  }
  return copy.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function renderSortBar(containerId, currentSort, onSort, showFreq = false) {
  const bar = document.getElementById(containerId);
  if (!bar) return;
  bar.innerHTML = "";
  const row = document.createElement("div");
  row.className = "sort-row";
  row.innerHTML = '<span class="sort-label">Trier :</span>';
  const btns = [["date","📅 Date"],["alpha","🔤 A→Z"],["rarity","⭐ Rareté"]];
  if (showFreq) btns.push(["freq","📊 %"]);
  btns.forEach(([key, label]) => {
    const btn = document.createElement("button");
    btn.className = "sort-btn" + (currentSort === key ? " active" : "");
    btn.textContent = label;
    btn.onclick = () => onSort(key);
    row.appendChild(btn);
  });
  bar.appendChild(row);
}
// ========== ONGLET LIEUX ==========
function renderLocationsTab() {
  const db     = getDB();
  const p      = getProfile(currentProfileId);
  const scroll = document.getElementById("locationsScroll");
  scroll.innerHTML = "";

  const renamed = db.renamedDefaults || {};
  const renamedOriginals = new Set(Object.keys(renamed));
  const rawLocs = [...new Set([
    ...DEFAULT_LOCATIONS.filter(l => !renamedOriginals.has(l)), // exclure defaults renommés
    ...(db.groupLocs || []),
    ...Object.keys(db.sharedBirds || {}),
    ...(p.myLocs || [])
  ])];
  const allLocs = sortLocsWithFavs(rawLocs);

  allLocs.forEach(loc => {
    const isFav  = isFavLoc(loc);
    const isActive = loc === currentLocation;
    const chip = document.createElement("button");
    chip.className = "loc-chip" + (isActive ? " active" : "") + (isFav ? " fav" : "");

    // Étoile cliquable
    const star = document.createElement("span");
    star.className = "loc-chip-star" + (isFav ? " active" : "");
    star.textContent = isFav ? "★" : "☆";
    // Pas de onclick ici — l'étoile est juste un indicateur visuel
    // Le toggle fav se fait uniquement via l'étoile dans le titre du lieu ouvert

    const label = document.createElement("span");
    label.textContent = loc;

    chip.appendChild(star);
    chip.appendChild(label);
    chip.onclick = () => {
      currentLocation = loc;
      pullSharedBirdsForLocation(loc).then(() => renderLocationsTab());
    };
    scroll.appendChild(chip);
  });

  const addChip = document.createElement("button");
  addChip.className = "loc-chip add-loc";
  addChip.textContent = "＋ Lieu";
  addChip.onclick = async () => {
    const name = prompt("Nom du nouveau lieu ?");
    if (name && name.trim()) {
      const locName = name.trim();
      currentLocation = locName;
      // Push the new location to Firebase so all group members see it
      await pushLocationToFirebase(locName);
      renderLocationsTab();
      renderLocationSelect();
      renderScanProfilePicker(); // refresh scan tab picker too
    }
  };
  scroll.appendChild(addChip);

  const rawBirds = getSharedBirds(currentLocation);
  const birds    = sortBirds(rawBirds, currentLocSort, currentLocation);
  const list     = document.getElementById("birdList");
  const empty    = document.getElementById("emptyState");
  const title   = document.getElementById("currentLocationTitle");
  const countEl = document.getElementById("locationBirdCount");

  // Titre avec étoile interactive + crayon de renommage
  const isFavCurrent = isFavLoc(currentLocation);
  title.innerHTML = "";

  const starBtn = document.createElement("button");
  starBtn.className = "loc-title-star" + (isFavCurrent ? " active" : "");
  starBtn.textContent = isFavCurrent ? "★" : "☆";
  starBtn.title = isFavCurrent ? "Retirer des favoris" : "Ajouter aux favoris";
  starBtn.onclick = () => { toggleFavLoc(currentLocation); renderLocationsTab(); renderLocationSelect(); };

  const nameSpan = document.createElement("span");
  nameSpan.textContent = currentLocation;

  const editBtn = document.createElement("button");
  editBtn.className = "loc-title-edit";
  editBtn.innerHTML = "✏️";
  editBtn.title = "Renommer ce lieu";
  editBtn.onclick = async () => {
    const newName = prompt("Nouveau nom pour ce lieu ?", currentLocation);
    if (newName && newName.trim() && newName.trim() !== currentLocation) {
      await renameLoc(currentLocation, newName.trim());
    }
  };

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "loc-title-delete";
  deleteBtn.innerHTML = "🗑️";
  deleteBtn.title = "Supprimer ce lieu";
  deleteBtn.onclick = async () => {
    const code = prompt(`Taper DELETE pour confirmer la suppression de "${currentLocation}" et tous ses oiseaux :`);
    if (code === null) return;
    if (code !== "DELETE") { alert("Code incorrect. Rien n'a été supprimé."); return; }
    await deleteLoc(currentLocation);
  };

  title.appendChild(starBtn);
  title.appendChild(nameSpan);
  title.appendChild(editBtn);
  title.appendChild(deleteBtn);

  countEl.textContent = birds.length + " oiseau" + (birds.length > 1 ? "x" : "");
  list.innerHTML      = "";

  // Barre de tri
  renderSortBar("locSortBar", currentLocSort, (key) => { currentLocSort = key; renderLocationsTab(); }, true);

  if (birds.length === 0) {
    empty.classList.add("show");
    countEl.textContent = "";
  } else {
    empty.classList.remove("show");
    birds.forEach(bird => {
      const li      = document.createElement("li");
      li.className  = "bird-card";
      const date    = new Date(bird.date);
      const dateStr = date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
      const r = bird.rarity || "common";
      if (r !== "common") li.classList.add(r);
      const rarityDot = r === "rare" ? `<span class="rarity-dot rare" title="Rare"></span>` :
                        r === "uncommon" ? `<span class="rarity-dot uncommon" title="Peu commun"></span>` : "";
      const freqBadge = freqBadgeHTML(bird.name, currentLocation);
      li.innerHTML  = `
        <img src="${bird.image}" alt="${bird.name}" style="object-fit:cover;object-position:center top;">
        <div class="bird-card-info">
          <div class="bird-card-name">${bird.name}${rarityDot}</div>
          <div class="bird-card-meta">Observé le ${dateStr}${bird.addedBy ? " par " + bird.addedBy : ""}</div>
          ${freqBadge}
        </div>
        ${r === "rare" ? `<span class="rarity-badge rare">⭐ Rare</span>` :
          r === "uncommon" ? `<span class="rarity-badge uncommon">◑ Peu commun</span>` :
          `<span style="color:var(--muted);font-size:18px;margin-left:auto;padding-right:4px;">›</span>`}
      `;
      li.onclick = () => {
        const allObs = getSharedBirds(currentLocation).filter(b => b.name === bird.name);
        openBirdSheet(bird.name, allObs.length > 0 ? allObs : [bird]);
      };
      list.appendChild(li);
    });
  }
}

function renderLocationSelect() {
  const db = getDB();
  const p  = getProfile(currentProfileId);
  const renamed2 = db.renamedDefaults || {};
  const renamedOriginals2 = new Set(Object.keys(renamed2));
  const rawLocs2 = [...new Set([
    ...DEFAULT_LOCATIONS.filter(l => !renamedOriginals2.has(l)),
    ...(db.groupLocs || []),
    ...Object.keys(db.sharedBirds || {}),
    ...(p.myLocs || [])
  ])];
  const allLocs = sortLocsWithFavs(rawLocs2);
  const select     = document.getElementById("locationSelect");
  select.innerHTML = allLocs.map(l => `<option value="${l}">${l}</option>`).join("")
    + `<option value="__new__">＋ Nouveau lieu…</option>`;
  select.value = allLocs.includes(currentLocation) ? currentLocation : allLocs[0];

  // Handle "new location" option
  select.onchange = async () => {
    if (select.value === "__new__") {
      const name = prompt("Nom du nouveau lieu ?");
      if (name && name.trim()) {
        const locName = name.trim();
        currentLocation = locName;
        await pushLocationToFirebase(locName);
        renderLocationsTab();
        renderLocationSelect();
      } else {
        select.value = currentLocation; // revert
      }
    } else {
      currentLocation = select.value;
    }
  };
}

// ========== ONGLET BIRDDEX ==========
function renderBirddex(query = "") {
  const p          = getProfile(currentProfileId);
  const all        = uniqueMyBirds(p);
  const filtered_q = query ? all.filter(b => b.name.toLowerCase().includes(query.toLowerCase())) : all;
  const filtered   = sortBirds(filtered_q, currentDexSort);

  const rareCount     = all.filter(b => b.rarity === "rare").length;
  const uncommonCount = all.filter(b => b.rarity === "uncommon").length;
  const commonCount   = all.length - rareCount - uncommonCount;
  let countLabel = `${all.length} espèce${all.length > 1 ? "s" : ""}`;
  if (rareCount > 0 || uncommonCount > 0) {
    const parts = [];
    if (commonCount > 0)   parts.push(`${commonCount} commune${commonCount > 1 ? "s" : ""}`);
    if (uncommonCount > 0) parts.push(`${uncommonCount} peu commune${uncommonCount > 1 ? "s" : ""}`);
    if (rareCount > 0)     parts.push(`${rareCount} rare${rareCount > 1 ? "s" : ""}`);
    countLabel = parts.join(" · ");
  }
  document.getElementById("birddexCount").textContent = countLabel;
  document.getElementById("birddexFill").style.width  = Math.min((all.length / 100) * 100, 100) + "%";

  const list = document.getElementById("birddexList");
  list.innerHTML = "";

  // Barre de tri
  renderSortBar("dexSortBar", currentDexSort, (key) => { currentDexSort = key; renderBirddex(query); });

  filtered.forEach(bird => {
    const li = document.createElement("li");
    const dr = bird.rarity || "common";
    li.className = "birddex-item" + (dr !== "common" ? " " + dr : "");
    const rarityLabel = dr === "rare" ? "⭐ Rare" : dr === "uncommon" ? "◑ Peu commun" : "✓ Commun";
    const badgeClass  = "birddex-item-badge" + (dr !== "common" ? " " + dr : "");
    li.innerHTML = `
      <img src="${bird.image}" alt="${bird.name}" style="object-fit:cover;object-position:center top;">
      <div class="birddex-item-body">
        <div class="birddex-item-name">${bird.name}</div>
        <div class="birddex-item-loc">${bird.location || ""}</div>
        <span class="${badgeClass}">${rarityLabel}</span>
      </div>
    `;
    li.onclick = () => {
      const p = getProfile(currentProfileId);
      const allObs = (p.myBirds || []).filter(b => b.name === bird.name);
      openBirdSheet(bird.name, allObs.length > 0 ? allObs : [bird]);
    };
    list.appendChild(li);
  });

  if (filtered.length === 0) {
    list.innerHTML = `<li style="grid-column:span 2;text-align:center;padding:40px;color:var(--muted);font-size:14px;">🔍 Aucun résultat</li>`;
  }
}

// ========== ONGLET CLASSEMENT ==========
async function fetchAndRenderStats() {
  const container = document.getElementById("leaderboardList");
  container.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--muted);">
    <div style="font-size:28px;margin-bottom:8px;">⏳</div>Chargement du classement…
  </div>`;

  // Aller chercher tous les profils du groupe Firebase en temps réel
  if (firebaseDb && groupCode) {
    try {
      const snap = await firebaseDb.ref(`groups/${groupCode}/profiles`).once("value");
      const data = snap.val();
      if (data) mergeRemoteProfiles(data);
    } catch(e) {
      console.warn("fetchAndRenderStats: Firebase error", e);
    }
  }

  renderStats();
}

function renderStats() {
  const allProfiles = getAllProfiles().map(migrateProfile);
  const sorted      = [...allProfiles].sort((a, b) => (b.xp || 0) - (a.xp || 0));
  const medals      = ["🥇", "🥈", "🥉"];

  if (sorted.length === 0) {
    document.getElementById("leaderboardList").innerHTML =
      `<p style="text-align:center;color:var(--muted);padding:40px 20px;">Aucun profil. Créez-en un pour commencer !</p>`;
    return;
  }

  document.getElementById("leaderboardList").innerHTML = sorted.map((p, i) => {
    const unique       = uniqueMyBirds(p);
    const lvl          = getLevel(p.xp || 0);
    const isMe         = p.id === currentProfileId;
    const badgesEarned = BADGES.filter(b => b.req(p)).length;
    return `
      <div class="leaderboard-item${isMe ? " leaderboard-me" : ""}">
        <div class="leaderboard-rank">${medals[i] || (i + 1)}</div>
        <div class="leaderboard-avatar">${p.avatar}</div>
        <div class="leaderboard-info">
          <div class="leaderboard-name">${p.name}${isMe ? ' <span class="leaderboard-you">moi</span>' : ''}</div>
          <div class="leaderboard-sub">${(() => {
            const rc = unique.filter(b=>b.rarity==="rare").length;
            const uc = unique.filter(b=>b.rarity==="uncommon").length;
            const lvlStr = "Niv." + lvl.level;
            let sub = lvlStr + " · " + unique.length + " espèces";
            if (rc > 0) sub += " · " + rc + "⭐";
            if (uc > 0) sub += " · " + uc + "◑";
            return sub;
          })()}</div>
        </div>
        <div class="leaderboard-xp">${p.xp || 0}<span class="leaderboard-xp-label"> XP</span></div>
      </div>
    `;
  }).join("");
}

// ========== ONGLET PROFIL ==========
function renderProfileTab() {
  const p      = getProfile(currentProfileId);
  const unique = uniqueMyBirds(p);
  const lvl    = getLevel(p.xp || 0);
  const xpPct  = Math.min(((p.xp || 0) / lvl.next) * 100, 100);
  const locs   = p.myLocs || [];

  const countByLoc = {};
  (p.myBirds || []).forEach(b => { countByLoc[b.location] = (countByLoc[b.location] || 0) + 1; });

  const locsHTML = locs.length > 0 ? `
    <div class="profile-section">
      <h3 class="profile-section-title">📍 Mes lieux</h3>
      ${locs.map(loc => {
        const count = countByLoc[loc] || 0;
        return `<div class="stats-loc-item">
          <span class="stats-loc-name">📍 ${loc}</span>
          <span class="stats-loc-count">${count} oiseau${count > 1 ? "x" : ""}</span>
        </div>`;
      }).join("")}
    </div>
  ` : "";

  const badgesHTML = `
    <div class="profile-section">
      <h3 class="profile-section-title">🏅 Badges</h3>
      <div class="badges-grid">
        ${BADGES.map(b => {
          const earned = b.req(p);
          return `<div class="badge-item${earned ? "" : " locked"}">
            <div class="badge-icon">${b.icon}</div>
            <div class="badge-name">${b.name}</div>
            <div class="badge-desc">${b.desc}</div>
          </div>`;
        }).join("")}
      </div>
    </div>
  `;

  document.getElementById("profileTabContent").innerHTML = `
    <div class="profile-hero" style="position:relative;">
      <button class="profile-edit-btn" onclick="openEditProfileModal()" title="Modifier le profil">✏️</button>
      <span class="profile-hero-avatar">${p.avatar}</span>
      <div class="profile-hero-name">${p.name}</div>
      <div class="profile-hero-level">Niveau ${lvl.level}</div>
      <div class="profile-xp-bar">
        <div class="profile-xp-fill" style="width:${xpPct}%"></div>
      </div>
      <div class="profile-xp-label">${p.xp || 0} / ${lvl.next} XP</div>
    </div>

    <div class="stats-grid" style="margin-bottom:12px">
      <div class="stat-tile">
        <div class="stat-tile-icon">🕊️</div>
        <div class="stat-tile-value">${unique.length}</div>
        <div class="stat-tile-label">Espèces</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile-icon">📍</div>
        <div class="stat-tile-value">${locs.length}</div>
        <div class="stat-tile-label">Lieux</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile-icon">🏅</div>
        <div class="stat-tile-value">${BADGES.filter(b => b.req(p)).length}/${BADGES.length}</div>
        <div class="stat-tile-label">Badges</div>
      </div>
    </div>
    <div class="rarity-scale-section">
      <div class="rarity-scale-title">🎯 Échelle de rareté</div>
      <div class="rarity-scale">
        <div class="rarity-scale-row rare">
          <div class="rarity-scale-icon">⭐</div>
          <div class="rarity-scale-info">
            <div class="rarity-scale-name rare">Rares</div>
            <div class="rarity-scale-sub">Observations exceptionnelles</div>
          </div>
          <div class="rarity-scale-count rare">${unique.filter(b=>b.rarity==="rare").length}</div>
          <div class="rarity-scale-xp rare">+100 XP</div>
        </div>
        <div class="rarity-scale-row uncommon">
          <div class="rarity-scale-icon">◑</div>
          <div class="rarity-scale-info">
            <div class="rarity-scale-name uncommon">Peu communs</div>
            <div class="rarity-scale-sub">Espèces moins fréquentes</div>
          </div>
          <div class="rarity-scale-count uncommon">${unique.filter(b=>b.rarity==="uncommon").length}</div>
          <div class="rarity-scale-xp uncommon">+50 XP</div>
        </div>
        <div class="rarity-scale-row common">
          <div class="rarity-scale-icon">🕊️</div>
          <div class="rarity-scale-info">
            <div class="rarity-scale-name">Communs</div>
            <div class="rarity-scale-sub">Espèces régulières</div>
          </div>
          <div class="rarity-scale-count">${unique.filter(b=>!b.rarity||b.rarity==="common").length}</div>
          <div class="rarity-scale-xp common">+25 XP</div>
        </div>
      </div>
    </div>

    ${locsHTML}
    ${badgesHTML}

    <div class="sync-section">
      <h3 style="font-family:'Playfair Display',serif;font-size:18px;color:var(--forest);margin-bottom:12px;">🔗 Groupe actif</h3>
      <div class="sync-code-display">
        <span class="sync-label">Code :</span>
        <span class="sync-code">${groupCode || "—"}</span>
        <button onclick="copyGroupCode()" class="btn-copy">📋 Copier</button>
      </div>
      <p style="font-size:12px;color:var(--muted);margin-top:8px;">Partagez ce code avec votre famille. La liste des oiseaux par lieu est synchronisée en temps réel pour tout le groupe.</p>
      <button onclick="changeGroup()" class="btn-sync" style="margin-top:12px;">🔄 Changer de groupe</button>
    </div>

    <button onclick="confirmDeleteProfile()" style="width:100%;background:none;border:2px solid #ddd;border-radius:10px;padding:12px;color:#aaa;font-family:'DM Sans',sans-serif;font-size:14px;cursor:pointer;margin-top:16px;">
      Supprimer ce profil
    </button>

    <button onclick="promptDevReset()" style="width:100%;background:none;border:none;padding:10px;color:#ddd;font-family:'DM Sans',sans-serif;font-size:11px;cursor:pointer;margin-top:4px;opacity:0.4;">
      ··· Options développeur
    </button>
  `;
}

// ========== EDIT PROFILE MODAL ==========
let editSelectedAvatar = null;

function openEditProfileModal() {
  const p = getProfile(currentProfileId);
  if (!p) return;
  editSelectedAvatar = p.avatar;

  // Fill fields
  document.getElementById("editNameInput").value = p.name;

  // Render avatar picker
  const picker = document.getElementById("editAvatarPicker");
  picker.innerHTML = "";
  AVATARS.forEach(av => {
    const btn = document.createElement("button");
    btn.className = "ob-avatar-btn" + (av === editSelectedAvatar ? " selected" : "");
    btn.textContent = av;
    btn.onclick = () => {
      editSelectedAvatar = av;
      picker.querySelectorAll(".ob-avatar-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    };
    picker.appendChild(btn);
  });

  document.getElementById("editProfileModal").style.display = "flex";
}
window.openEditProfileModal = openEditProfileModal;

function closeEditProfileModal() {
  document.getElementById("editProfileModal").style.display = "none";
}
window.closeEditProfileModal = closeEditProfileModal;

function saveEditProfile() {
  const name = (document.getElementById("editNameInput").value || "").trim();
  if (!name) { document.getElementById("editNameInput").focus(); return; }
  const p = getProfile(currentProfileId);
  if (!p) return;
  p.name   = name;
  p.avatar = editSelectedAvatar || p.avatar;
  saveProfile(p);
  closeEditProfileModal();
  renderProfileTab();
  // Update topbar
  document.getElementById("topbarName").textContent  = p.name;
  document.getElementById("topbarAvatar").textContent = p.avatar;
}
window.saveEditProfile = saveEditProfile;

function copyGroupCode() {
  if (groupCode) navigator.clipboard.writeText(groupCode).then(() => alert("Code copié ! " + groupCode));
}

function changeGroup() {
  if (syncListener && firebaseDb && groupCode) {
    firebaseDb.ref(`groups/${groupCode}/sharedBirds`).off("value", syncListener);
    syncListener = null;
  }
  localStorage.removeItem("birdrGroupCode");
  groupCode = null;
  currentProfileId = null;
  document.getElementById("appScreen").classList.remove("active");
  document.getElementById("profileScreen").classList.remove("active");
  showGroupScreen();
}

async function confirmDeleteProfile() {
  if (!confirm("Supprimer ce profil et toutes ses données ?")) return;

  const idToDelete = currentProfileId;

  // 1. Supprimer du localStorage
  const db = getDB();
  delete db.profiles[idToDelete];
  saveDB(db);

  // 2. Supprimer de Firebase (sinon le listener le réimporte immédiatement)
  if (firebaseDb && groupCode && idToDelete) {
    try {
      await firebaseDb.ref(`groups/${groupCode}/profiles/${idToDelete}`).remove();
      console.log("✅ Profil supprimé de Firebase :", idToDelete);
    } catch(e) {
      console.error("Erreur suppression Firebase :", e);
    }
  }

  // 3. Effacer le lastProfile mémorisé si c'était lui
  if (localStorage.getItem("birdyLastProfile") === idToDelete) {
    localStorage.removeItem("birdyLastProfile");
  }

  currentProfileId = null;
  document.getElementById("appScreen").classList.remove("active");
  renderProfileScreen();
  document.getElementById("profileScreen").classList.add("active");
}

// ========== NAVIGATION ==========
function switchTab(tabId) {
  document.querySelectorAll(".tabnav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-content").forEach(el => {
    el.classList.toggle("active", el.id === "tab-" + tabId);
  });
  if (tabId === "birddex")   renderBirddex();
  if (tabId === "stats")     fetchAndRenderStats();
  if (tabId === "profile")   renderProfileTab();
  if (tabId === "locations") renderLocationsTab();
  if (tabId === "scan")      renderScanProfilePicker();
}

document.addEventListener("DOMContentLoaded", () => {

document.querySelectorAll(".tabnav-btn").forEach(btn => {
  btn.onclick = () => switchTab(btn.dataset.tab);
});

const birddexSearchEl = document.getElementById("birddexSearch");
if (birddexSearchEl) {
  birddexSearchEl.addEventListener("input", e => renderBirddex(e.target.value));
}

// ========== PROFILE SWITCHER (modal blanc avec belles cards) ==========
function openProfileSwitcher() {
  const list = document.getElementById("pswProfilesList");
  list.innerHTML = "";
  const profiles = getAllProfiles();
  profiles.forEach(rawP => {
    const p   = migrateProfile(rawP);
    const lvl = getLevel(p.xp || 0);
    const locs = (p.myLocs || []).length;
    const div = document.createElement("div");
    const isCurrent = p.id === currentProfileId;
    div.className = "psw-profile-card" + (isCurrent ? " current" : "");
    div.innerHTML = `
      <div class="psw-avatar">${p.avatar}</div>
      <div class="psw-info">
        <div class="psw-name">
          ${p.name}
          ${isCurrent ? '<span class="psw-active-badge">ACTIF</span>' : ''}
        </div>
        <div class="psw-stats">Niv.${lvl.level} · ${uniqueMyBirds(p).length} espèces · ${locs} lieu${locs > 1 ? "x" : ""}</div>
      </div>
      <span class="psw-arrow">›</span>
    `;
    div.onclick = () => {
      closeProfileSwitcher();
      if (p.id !== currentProfileId) openProfile(p.id);
    };
    list.appendChild(div);
  });
  document.getElementById("profileSwitcherModal").classList.add("show");
}

function closeProfileSwitcher() {
  document.getElementById("profileSwitcherModal").classList.remove("show");
}

document.getElementById("topbarAvatar").addEventListener("click", openProfileSwitcher);
document.getElementById("closeSwitcher").onclick = closeProfileSwitcher;
// Close on backdrop click
document.getElementById("profileSwitcherModal").addEventListener("click", e => {
  if (e.target === document.getElementById("profileSwitcherModal")) closeProfileSwitcher();
});
document.getElementById("pswAddBtn").onclick = () => {
  closeProfileSwitcher();
  openAddProfileModal();
};

// ========== MODAL AJOUT PROFIL ==========
function openAddProfileModal() {
  const picker = document.getElementById("avatarPicker");
  picker.innerHTML = "";
  AVATARS.forEach(av => {
    const btn = document.createElement("button");
    btn.className = "avatar-option" + (av === selectedAvatar ? " selected" : "");
    btn.textContent = av;
    btn.onclick = () => {
      selectedAvatar = av;
      picker.querySelectorAll(".avatar-option").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    };
    picker.appendChild(btn);
  });
  document.getElementById("profileNameInput").value = "";
  document.getElementById("addProfileModal").classList.add("show");
}

document.getElementById("cancelProfile").onclick = () => {
  document.getElementById("addProfileModal").classList.remove("show");
};

document.getElementById("confirmProfile").onclick = () => {
  const name = document.getElementById("profileNameInput").value.trim();
  if (!name) { alert("Entre un prénom !"); return; }
  const db = getDB();
  const id = "p_" + Date.now();
  const newProf = { id, name, avatar: selectedAvatar, xp: 0, myBirds: [], myLocs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  db.profiles[id] = newProf;
  saveDB(db);
  pushProfileToFirebase(newProf);
  document.getElementById("addProfileModal").classList.remove("show");
  openProfile(id);
};


// ========== FICHE OISEAU ==========

// Cache pour ne pas re-fetcher Wikipedia à chaque ouverture
const birdInfoCache = {};

async function fetchWikipediaInfo(frenchName) {
  if (birdInfoCache[frenchName]) return birdInfoCache[frenchName];

  try {
    // Lancer iNaturalist + Wikipedia en parallèle
    const [inat, wikiData] = await Promise.all([
      fetchFromiNaturalist(frenchName),
      (async () => {
        const searchResp = await fetch(
          `https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(frenchName + " oiseau")}&srlimit=1&format=json&origin=*`
        );
        const searchData = await searchResp.json();
        const hit = searchData.query?.search?.[0];
        if (!hit) return null;
        const pageTitle = hit.title;
        const infoResp = await fetch(
          `https://fr.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=extracts|pageimages&exintro=1&exsentences=6&explaintext=1&piprop=thumbnail&pithumbsize=400&format=json&origin=*`
        );
        const infoData = await infoResp.json();
        const page = Object.values(infoData.query?.pages || {})[0];
        return {
          title: pageTitle,
          extract: (page?.extract || "").replace(/\n+/g, " ").trim(),
          wikiUrl: `https://fr.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`
        };
      })()
    ]);

    // Galerie : iNaturalist en priorité (photos terrain), Commons en fallback
    let gallery = inat?.photos || [];
    if (gallery.length < 4) {
      const commons = await fetchFromWikimediaCommons(frenchName);
      const newOnes = commons.filter(u => !gallery.includes(u));
      gallery = [...gallery, ...newOnes].slice(0, 8);
    }

    const result = {
      title: wikiData?.title || frenchName,
      extract: wikiData?.extract || "",
      gallery,
      wikiUrl: inat?.wikiUrl || wikiData?.wikiUrl || null,
      sciName: inat?.sciName || null
    };

    birdInfoCache[frenchName] = result;
    return result;
  } catch(e) {
    console.warn("fetchWikipediaInfo failed:", e);
    return null;
  }
}


// ========== XENO-CANTO (sons d'oiseaux) ==========
// ========== XENO-CANTO API v3 (via Cloudflare Worker) ==========
// API v3 nécessite une clé — stockée dans le Worker en variable secrète XENO_KEY
// Le Worker fait le call API et renvoie les enregistrements

async function fetchXenoCanto(birdName, sciName) {
  const cacheKey = sciName || birdName;
  if (window._xenoCache && window._xenoCache[cacheKey]) return window._xenoCache[cacheKey];
  if (!window._xenoCache) window._xenoCache = {};

  try {
    // Xeno-canto : nom scientifique directement (sans guillemets ni préfixe)
    const query = sciName || birdName;
    const resp = await fetch(WORKER_URL + "?xeno=1&query=" + encodeURIComponent(query), {
      method: "GET"
    });
    if (!resp.ok) throw new Error("xeno " + resp.status);
    const data = await resp.json();
    const recs = (data.recordings || []).slice(0, 8);
    const result = {
      songs: recs.filter(r => /song|chant/i.test(r.type||"")),
      calls: recs.filter(r => /call|cri|alarm/i.test(r.type||"")),
      all:   recs
    };
    window._xenoCache[cacheKey] = result;
    return result;
  } catch(e) {
    console.warn("fetchXenoCanto failed:", e);
    return null;
  }
}

function renderSoundsSection(sounds, birdName, sciName) {
  const query = encodeURIComponent(sciName || birdName);
  const exploreUrl = `https://xeno-canto.org/explore?query=${query}`;

  if (!sounds || sounds.all.length === 0) {
    return `
      <div class="bird-sheet-section">
        <div class="bird-sheet-section-title">🎧 Chants & Cris</div>
        <a href="${exploreUrl}" target="_blank" rel="noopener" class="sound-more-link" style="margin-top:0">
          🔊 Écouter sur Xeno-canto →
        </a>
      </div>
    `;
  }

  const tracks = [
    ...sounds.songs.slice(0,2).map(r => ({ ...r, typeLabel: "🎵 Chant" })),
    ...sounds.calls.slice(0,2).map(r => ({ ...r, typeLabel: "📢 Cri" }))
  ];
  const finalTracks = tracks.length > 0 ? tracks : sounds.all.slice(0,3).map(r => ({ ...r, typeLabel: "🔊 Son" }));

  const items = finalTracks.map(r => `
    <div class="sound-item">
      <div class="sound-type-badge">${r.typeLabel}</div>
      <div class="sound-info">
        <div class="sound-place">📍 ${r.loc || "?"}</div>
        <div class="sound-by">par ${r.rec || "?"}</div>
      </div>
      <audio class="sound-player" controls preload="none">
        <source src="https:${r.file}" type="audio/mpeg">
      </audio>
    </div>
  `).join("");

  return `
    <div class="bird-sheet-section">
      <div class="bird-sheet-section-title">🎧 Chants & Cris</div>
      <div class="sound-list">${items}</div>
      <a href="${exploreUrl}" target="_blank" rel="noopener" class="sound-more-link">
        Écouter plus sur Xeno-canto →
      </a>
    </div>
  `;
}
function openBirdSheet(birdName, birdObservations) {
  const overlay = document.getElementById("birdSheetOverlay");
  const heroImg = document.getElementById("birdSheetHeroImg");
  const heroName = document.getElementById("birdSheetHeroName");
  const gallery = document.getElementById("birdSheetGallery");
  const body = document.getElementById("birdSheetBody");

  // Affichage immédiat avec l'image déjà connue
  const knownImage = birdObservations[0]?.image || "";
  heroImg.src = knownImage;
  heroName.textContent = birdName;
  gallery.innerHTML = "";
  body.innerHTML = `<div class="bird-sheet-loading"><div class="bird-sheet-spinner"></div>Chargement de la fiche…</div>`;

  overlay.classList.add("show");
  document.body.style.overflow = "hidden";

  // Charger les infos Wikipedia en arrière-plan
  // Charger Wikipedia d'abord, puis Xeno-canto avec le nom scientifique
  fetchWikipediaInfo(birdName).then(async info => {
    const sciName = info?.sciName || null;
    const sounds  = await fetchXenoCanto(birdName, sciName);
    renderBirdSheet(birdName, birdObservations, info, knownImage, sounds);
  });
}
window.openBirdSheet = openBirdSheet;

function renderBirdSheet(birdName, observations, info, knownImage, sounds = null) {
  const heroImg = document.getElementById("birdSheetHeroImg");
  const gallery = document.getElementById("birdSheetGallery");
  const body    = document.getElementById("birdSheetBody");

  // Galerie
  const allPhotos = info?.gallery?.length > 0 ? info.gallery : [knownImage].filter(Boolean);
  if (allPhotos.length > 0) {
    heroImg.src = allPhotos[0];
    gallery.innerHTML = "";
    allPhotos.forEach((url, i) => {
      const img = document.createElement("img");
      img.className = "bird-gallery-thumb" + (i === 0 ? " active" : "");
      img.src = url;
      img.alt = birdName;
      img.onerror = () => img.style.display = "none";
      img.onclick = () => {
        heroImg.src = url;
        gallery.querySelectorAll(".bird-gallery-thumb").forEach(t => t.classList.remove("active"));
        img.classList.add("active");
      };
      gallery.appendChild(img);
    });
  }

  // Mes observations de cet oiseau
  const myObs = observations.map(o => {
    const d = new Date(o.date);
    const dateStr = d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    return `<div class="bird-sheet-obs-item">
      <div class="bird-sheet-obs-dot"></div>
      <span>📍 ${o.location} — ${dateStr}${o.addedBy ? " par " + o.addedBy : ""}</span>
    </div>`;
  }).join("");

  // Extraire des phrases intéressantes de l'extrait Wikipedia
  const extract = info?.extract || "";
  // Première phrase = description courte
  const sentences = extract.split(/(?<=[.!?])\s+/);
  const shortDesc = sentences.slice(0, 2).join(" ");
  const fullDesc  = sentences.slice(2, 6).join(" ");

  // Tenter d'extraire taille/poids depuis l'extrait
  const tailleMatch = extract.match(/(\d+[,.]?\d*)\s*(?:à|-|–)\s*(\d+[,.]?\d*)\s*cm/i);
  const poidsMatch  = extract.match(/(\d+[,.]?\d*)\s*(?:à|-|–)\s*(\d+[,.]?\d*)\s*g/i);

  const taille = tailleMatch ? `${tailleMatch[1]}–${tailleMatch[2]} cm` : "—";
  const poids  = poidsMatch  ? `${poidsMatch[1]}–${poidsMatch[2]} g`   : "—";

  body.innerHTML = `
    <div style="margin-bottom:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span class="bird-sheet-observed">✅ ${observations.length} observation${observations.length > 1 ? "s" : ""} par ta famille</span>
      ${info?.sciName ? `<span style="font-size:12px;color:var(--muted);font-style:italic;">${info.sciName}</span>` : ""}
    </div>

    ${shortDesc ? `
    <div class="bird-sheet-section">
      <div class="bird-sheet-section-text" style="font-style:italic;color:#555;margin-bottom:14px;">"${shortDesc}"</div>
    </div>` : ""}

    <div class="bird-sheet-stats">
      <div class="bird-stat-chip">
        <div class="bird-stat-chip-icon">📏</div>
        <div class="bird-stat-chip-val">${taille}</div>
        <div class="bird-stat-chip-label">Taille</div>
      </div>
      <div class="bird-stat-chip">
        <div class="bird-stat-chip-icon">⚖️</div>
        <div class="bird-stat-chip-val">${poids}</div>
        <div class="bird-stat-chip-label">Poids</div>
      </div>
      <div class="bird-stat-chip">
        <div class="bird-stat-chip-icon">📅</div>
        <div class="bird-stat-chip-val">${new Date(observations[0].date).toLocaleDateString("fr-FR", {day:"numeric", month:"short"})}</div>
        <div class="bird-stat-chip-label">1ère obs.</div>
      </div>
    </div>

    ${fullDesc ? `
    <div class="bird-sheet-section">
      <div class="bird-sheet-section-title">📖 Description</div>
      <div class="bird-sheet-section-text">${fullDesc}</div>
    </div>` : ""}

    <div class="bird-sheet-section">
      <div class="bird-sheet-section-title">📍 Nos observations</div>
      <div class="bird-sheet-my-obs">${myObs || "<div style='color:var(--muted);font-size:13px;padding:8px 0;'>Aucune observation enregistrée</div>"}</div>
    </div>

    ${renderSoundsSection(sounds, birdName, info?.sciName || null)}

    ${info?.wikiUrl ? `
    <a href="${info.wikiUrl}" target="_blank" rel="noopener" style="display:block;text-align:center;color:var(--forest);font-size:13px;font-weight:600;padding:14px;background:white;border-radius:14px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,0.07);">
      🔗 Voir la fiche complète sur Wikipedia
    </a>` : ""}
  `;
}

function closeBirdSheet() {
  const overlay = document.getElementById("birdSheetOverlay");
  const sheet   = document.getElementById("birdSheet");
  sheet.style.transform = "translateY(100%)";
  setTimeout(() => {
    overlay.classList.remove("show");
    sheet.style.transform = "";
    document.body.style.overflow = "";
  }, 350);
}
window.closeBirdSheet = closeBirdSheet;

// Fermer la fiche
document.getElementById("birdSheetClose").onclick = closeBirdSheet;
document.getElementById("birdSheetOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("birdSheetOverlay")) closeBirdSheet();
});

}); // end DOMContentLoaded

// ========== INIT ==========
(async () => {
  await initFirebase();

  // Brancher le bouton onboarding (saisie code famille - 1ère connexion ever)
  const obBtn = document.getElementById("obJoinBtn");
  if (obBtn) obBtn.onclick = handleOnboardingSubmit;
  const obInput = document.getElementById("obGroupInput");
  if (obInput) obInput.addEventListener("keydown", e => { if (e.key === "Enter") handleOnboardingSubmit(); });
  const obName = document.getElementById("obNameInput");
  if (obName) obName.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("obGroupInput").focus(); });

  renderObAvatarPicker();

  const storedCode = getStoredGroupCode();

  if (!storedCode) {
    // Toute première ouverture : onboarding (saisie code + prénom)
    showOnboarding();
    return;
  }

  // Code connu → vérifier Firebase
  groupCode = storedCode;
  const exists = await groupExists(storedCode);
  if (!exists) {
    localStorage.removeItem("birdrGroupCode");
    groupCode = null;
    showOnboarding();
    return;
  }

  startRealtimeSync();
  await pullLocationsFromFirebase(); // pull custom locations before rendering
  await pullSessionsFromFirebase();  // pull scan sessions (fréquences partagées)
  const profiles = getAllProfiles();
  
  

  if (profiles.length === 0) {
    // Groupe connu mais aucun profil local → sélecteur + modal création directe
    renderProfileScreen();
    document.getElementById("profileScreen").classList.add("active");
    openAddProfileModal();
    return;
  }

  // Vérifier si un profil a été mémorisé sur cet appareil
  const lastId = getLastProfileId();
  if (lastId && getProfile(lastId)) {
    // Auto-login sur le dernier profil utilisé
    openProfile(lastId);
    return;
  }

  // Sinon → écran sélection de profil
  renderProfileScreen();
  document.getElementById("profileScreen").classList.add("active");
})();