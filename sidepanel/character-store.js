// Overflow — character reference image store (Consistent Character feature)
//
// Persists uploaded character reference images in IndexedDB, keyed by a
// generated id with the character's name (derived from the uploaded
// filename) attached as metadata. chrome.storage.local isn't used here
// because its ~10MB quota isn't meant for binary image blobs; IndexedDB
// has a much larger practical quota and stores Blobs natively.
//
// Loaded as a plain <script> tag (no build step in this repo), exposing a
// single global: window.CharacterStore.

const CHARACTER_DB_NAME = "overflow-characters";
const CHARACTER_DB_VERSION = 1;
const CHARACTER_STORE_NAME = "images";

// Reference images only need to be big enough for Flow to see the
// character clearly — downscale on upload so IndexedDB footprint and (once
// re-encoded as a data URL for message-passing) chrome.runtime message
// size both stay small regardless of how large the source photo was.
const MAX_LONG_EDGE = 1024;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CHARACTER_DB_NAME, CHARACTER_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHARACTER_STORE_NAME)) {
        db.createObjectStore(CHARACTER_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open the character image database."));
  });
  return dbPromise;
}

function withStore(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(CHARACTER_STORE_NAME, mode);
        const store = tx.objectStore(CHARACTER_STORE_NAME);
        let result;
        Promise.resolve(fn(store))
          .then((r) => {
            result = r;
          })
          .catch(reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error("Character image store transaction failed."));
      })
  );
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Character image store request failed."));
  });
}

/**
 * "narrator.png" -> "narrator". Strips the extension only — case and
 * whitespace normalization happens at match time in character-matcher.js,
 * not here, so the stored characterName still reflects what the user
 * actually named the file for display purposes.
 */
function characterNameFromFileName(fileName) {
  return fileName.replace(/\.[^./\\]+$/, "").trim();
}

function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const longEdge = Math.max(img.width, img.height);
      const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      const outputType = file.type === "image/png" ? "image/png" : "image/jpeg";
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Failed to downscale the uploaded image."));
            return;
          }
          resolve({ blob, mimeType: outputType });
        },
        outputType,
        0.9
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read the uploaded file as an image."));
    };
    img.src = objectUrl;
  });
}

function stripBlob(record) {
  const { blob, ...rest } = record;
  return rest;
}

const CharacterStore = {
  async addCharacterImage(file) {
    const { blob, mimeType } = await downscaleImage(file);
    const record = {
      id: crypto.randomUUID(),
      characterName: characterNameFromFileName(file.name),
      fileName: file.name,
      mimeType,
      blob,
      addedAt: Date.now(),
    };
    await withStore("readwrite", (store) => requestToPromise(store.put(record)));
    return stripBlob(record);
  },

  async listCharacterImages() {
    const records = await withStore("readonly", (store) => requestToPromise(store.getAll()));
    return records.map(stripBlob).sort((a, b) => a.addedAt - b.addedAt);
  },

  async removeCharacterImage(id) {
    await withStore("readwrite", (store) => requestToPromise(store.delete(id)));
  },

  async getCharacterImageBlob(id) {
    const record = await withStore("readonly", (store) => requestToPromise(store.get(id)));
    return record ? record.blob : null;
  },
};

window.CharacterStore = CharacterStore;
