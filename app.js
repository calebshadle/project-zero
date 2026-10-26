(function () {
  "use strict";

  // The 1 second fade is part of the interval. 30 seconds means 29 seconds still, then a 1 second fade.
  var FADE_MS = 1000;
  var LONG_PRESS_MS = 1500;
  var MOVE_CANCEL_PX = 12;
  var ALLOWED_INTERVALS = [10000, 30000, 60000, 300000];
  var DEFAULT_INTERVAL = 30000;
  var STORAGE_INTERVAL = "photoFrame.intervalMs";
  var STORAGE_SHUFFLE = "photoFrame.shuffle";
  var DB_NAME = "photo-frame";
  var DB_STORE = "photos";
  // Long edge of the 13-inch iPad screen. Saved JPEGs stay sharp when cover-cropped, and smaller than camera originals.
  var MAX_EDGE = 2752;
  var JPEG_QUALITY = 0.82;

  var stage = document.getElementById("stage");
  var slideA = document.getElementById("slide-a");
  var slideB = document.getElementById("slide-b");
  var statusEl = document.getElementById("status");
  var settingsEl = document.getElementById("settings");
  var stayAwake = document.getElementById("stay-awake");
  var shuffleButton = document.getElementById("shuffle-toggle");
  var closeButton = document.getElementById("close-settings");
  var photoInput = document.getElementById("photo-input");
  var photoCount = document.getElementById("photo-count");
  var clearButton = document.getElementById("clear-photos");

  var front = slideA;
  var back = slideB;
  var photos = [];
  var queue = [];
  var now = null;
  var intervalMs = DEFAULT_INTERVAL;
  var shuffle = true;
  var settingsOpen = false;
  var fading = false;
  var holdTimer = 0;
  var pressTimer = 0;
  var pressX = 0;
  var pressY = 0;
  var pressing = false;
  var wakeLockSentinel = null;
  var wakeLockTask = null;
  var localUrls = [];
  var savedCount = 0;
  var playGeneration = 0;
  var libraryChain = Promise.resolve();
  var dbPromise = null;

  stayAwake.muted = true;
  stayAwake.defaultMuted = true;
  stayAwake.playsInline = true;
  stayAwake.setAttribute("playsinline", "");
  stayAwake.setAttribute("webkit-playsinline", "");

  function readList() {
    var raw = window.PHOTO_FRAME_PHOTOS;
    if (!Array.isArray(raw)) return [];
    var list = [];
    for (var i = 0; i < raw.length; i += 1) {
      if (typeof raw[i] !== "string") continue;
      var trimmed = raw[i].trim();
      if (trimmed) list.push(trimmed);
    }
    return list;
  }

  function readSettings() {
    var storedInterval = DEFAULT_INTERVAL;
    var storedShuffle = true;
    try {
      var intervalValue = Number(localStorage.getItem(STORAGE_INTERVAL));
      if (ALLOWED_INTERVALS.indexOf(intervalValue) !== -1) storedInterval = intervalValue;
      var shuffleValue = localStorage.getItem(STORAGE_SHUFFLE);
      if (shuffleValue === "false") storedShuffle = false;
      if (shuffleValue === "true") storedShuffle = true;
    } catch (err) {
      storedInterval = DEFAULT_INTERVAL;
      storedShuffle = true;
    }
    intervalMs = storedInterval;
    shuffle = storedShuffle;
  }

  function writeSettings() {
    try {
      localStorage.setItem(STORAGE_INTERVAL, String(intervalMs));
      localStorage.setItem(STORAGE_SHUFFLE, shuffle ? "true" : "false");
    } catch (err) {
      // Storage can throw in private mode. The choice still applies until the page closes.
    }
  }

  function syncControls() {
    var buttons = document.querySelectorAll(".interval-list button");
    for (var i = 0; i < buttons.length; i += 1) {
      var selected = Number(buttons[i].getAttribute("data-ms")) === intervalMs;
      buttons[i].setAttribute("aria-pressed", selected ? "true" : "false");
    }
    shuffleButton.setAttribute("aria-pressed", shuffle ? "true" : "false");
    shuffleButton.textContent = shuffle ? "Shuffle on" : "Shuffle off";
  }

  function showStatus(text) {
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  function hideStatus() {
    statusEl.hidden = true;
    statusEl.textContent = "";
  }

  function clearSlide(slide) {
    slide.style.transition = "none";
    slide.style.opacity = "0";
    slide.removeAttribute("src");
    slide.removeAttribute("data-url");
  }

  function hasAnother(url) {
    for (var i = 0; i < photos.length; i += 1) {
      if (photos[i] !== url) return true;
    }
    return false;
  }

  function shuffledCopy(list) {
    var copy = list.slice();
    for (var i = copy.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  function refillQueue() {
    if (!photos.length) {
      queue = [];
      return;
    }
    if (!shuffle) {
      var start = 0;
      if (now) {
        var at = photos.indexOf(now);
        start = at === -1 ? 0 : (at + 1) % photos.length;
      }
      queue = photos.slice(start).concat(photos.slice(0, start));
      return;
    }
    queue = shuffledCopy(photos);
    if (now && queue.length > 1 && queue[0] === now) {
      var swapAt = -1;
      for (var i = 1; i < queue.length; i += 1) {
        if (queue[i] !== now) {
          swapAt = i;
          break;
        }
      }
      if (swapAt > 0) {
        var first = queue[0];
        queue[0] = queue[swapAt];
        queue[swapAt] = first;
      }
    }
  }

  function takeNextUrl() {
    var guard = 0;
    var limit = Math.max(photos.length * 3, 1);
    while (guard < limit) {
      if (!queue.length) {
        refillQueue();
        if (!queue.length) return null;
      }
      var url = queue.shift();
      guard += 1;
      if (url === now && hasAnother(now)) continue;
      if (url === now) return null;
      return url;
    }
    return null;
  }

  function preload(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(url); };
      image.onerror = function () { reject(new Error("image failed")); };
      image.src = url;
    });
  }

  function showImmediate(url) {
    clearSlide(back);
    front.style.transition = "none";
    front.style.zIndex = "2";
    front.style.opacity = "1";
    front.setAttribute("data-url", url);
    front.src = url;
    back.style.zIndex = "1";
    now = url;
    hideStatus();
  }

  function beginIncoming(url, generation) {
    return new Promise(function (resolve) {
      var settled = false;
      var started = false;
      var backup = 0;
      var giveUp = 0;

      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(backup);
        clearTimeout(giveUp);
        back.removeEventListener("transitionend", onEnd);
        back.onload = null;
        back.onerror = null;
        if (generation !== playGeneration) {
          resolve(false);
          return;
        }
        if (!ok) {
          clearSlide(back);
          resolve(false);
          return;
        }
        var outgoing = front;
        outgoing.style.transition = "none";
        outgoing.style.opacity = "0";
        outgoing.removeAttribute("src");
        outgoing.removeAttribute("data-url");
        front = back;
        back = outgoing;
        front.style.zIndex = "2";
        back.style.zIndex = "1";
        resolve(true);
      }

      function onEnd(event) {
        if (event.target !== back || event.propertyName !== "opacity") return;
        finish(true);
      }

      function startTransition() {
        if (started || settled) return;
        if (generation !== playGeneration) {
          finish(false);
          return;
        }
        started = true;
        back.style.zIndex = "3";
        front.style.zIndex = "2";
        back.style.transition = "none";
        back.style.opacity = "0";
        // Force the browser to apply opacity 0 before the fade, or the first frame can jump.
        void back.offsetWidth;
        back.style.transition = "opacity 1s linear";
        back.style.opacity = "1";
        back.addEventListener("transitionend", onEnd);
        backup = setTimeout(function () { finish(true); }, FADE_MS + 150);
      }

      if (generation !== playGeneration) {
        resolve(false);
        return;
      }
      giveUp = setTimeout(function () { finish(false); }, 8000);
      back.onload = function () { startTransition(); };
      back.onerror = function () { finish(false); };
      back.setAttribute("data-url", url);
      back.src = url;
      if (back.complete && back.naturalWidth > 0) startTransition();
    });
  }

  function armHold() {
    clearTimeout(holdTimer);
    holdTimer = 0;
    if (settingsOpen || fading || !hasAnother(now)) return;
    var stillMs = Math.max(0, intervalMs - FADE_MS);
    holdTimer = setTimeout(function () {
      holdTimer = 0;
      startFade();
    }, stillMs);
  }

  async function startFade() {
    var generation = playGeneration;
    if (fading || settingsOpen || !hasAnother(now)) return;
    fading = true;
    try {
      var guard = 0;
      while (guard < photos.length * 3) {
        if (generation !== playGeneration) return;
        var url = takeNextUrl();
        guard += 1;
        if (!url) break;
        try {
          await preload(url);
        } catch (err) {
          continue;
        }
        if (generation !== playGeneration) return;
        if (url === now) continue;
        var faded = await beginIncoming(url, generation);
        if (generation !== playGeneration) return;
        if (!faded) continue;
        now = url;
        return;
      }
    } finally {
      if (generation === playGeneration) {
        fading = false;
        armHold();
      }
    }
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var request;
      if (!window.indexedDB) {
        reject(new Error("no indexedDB"));
        return;
      }
      try {
        request = indexedDB.open(DB_NAME, 1);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, { keyPath: "id", autoIncrement: true });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("indexedDB")); };
    }).catch(function (err) {
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  function readAllSaved() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readonly");
        var request = tx.objectStore(DB_STORE).getAll();
        request.onsuccess = function () { resolve(request.result || []); };
        request.onerror = function () { reject(request.error || new Error("read")); };
      });
    });
  }

  function saveBlob(blob) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).add({ blob: blob });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error("save")); };
        tx.onabort = function () { reject(tx.error || new Error("save aborted")); };
      });
    });
  }

  function clearSaved() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error("clear")); };
        tx.onabort = function () { reject(tx.error || new Error("clear aborted")); };
      });
    });
  }

  function fileToJpeg(file) {
    var decoded;
    if (typeof createImageBitmap === "function") {
      decoded = createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bitmap) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: function () { bitmap.close(); }
        };
      });
    } else {
      decoded = new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var image = new Image();
        image.onload = function () {
          URL.revokeObjectURL(url);
          resolve({
            source: image,
            width: image.naturalWidth,
            height: image.naturalHeight,
            close: function () {}
          });
        };
        image.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error("decode"));
        };
        image.src = url;
      });
    }
    return decoded.then(function (image) {
      var longEdge = Math.max(image.width, image.height);
      var scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
      var width = Math.max(1, Math.round(image.width * scale));
      var height = Math.max(1, Math.round(image.height * scale));
      var canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      var context = canvas.getContext("2d");
      if (!context) {
        image.close();
        return null;
      }
      context.drawImage(image.source, 0, 0, width, height);
      image.close();
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) { resolve(blob); }, "image/jpeg", JPEG_QUALITY);
      });
    }).catch(function () {
      return null;
    });
  }

  function updateCount(text) {
    document.documentElement.dataset.savedPhotoCount = String(savedCount);
    if (text) {
      photoCount.textContent = text;
      return;
    }
    if (savedCount === 0) photoCount.textContent = "No saved photos";
    else if (savedCount === 1) photoCount.textContent = "1 saved photo";
    else photoCount.textContent = savedCount + " saved photos";
  }

  function revokeLocalUrls(previous) {
    for (var i = 0; i < previous.length; i += 1) {
      if (localUrls.indexOf(previous[i]) === -1) URL.revokeObjectURL(previous[i]);
    }
  }

  async function boot() {
    var generation = ++playGeneration;
    readSettings();
    syncControls();
    clearTimeout(holdTimer);
    holdTimer = 0;
    var records = [];
    try {
      records = await readAllSaved();
    } catch (err) {
      records = [];
    }
    if (generation !== playGeneration) return;
    fading = false;
    var nextUrls = [];
    for (var i = 0; i < records.length; i += 1) {
      if (records[i] && records[i].blob) nextUrls.push(URL.createObjectURL(records[i].blob));
    }
    var previousUrls = localUrls;
    localUrls = nextUrls;
    savedCount = nextUrls.length;
    updateCount();
    queue = [];
    now = null;
    if (savedCount > 0) {
      photos = nextUrls.slice();
      document.documentElement.dataset.photoSource = "local";
    } else {
      photos = readList();
      document.documentElement.dataset.photoSource = "samples";
    }
    if (!photos.length) {
      clearSlide(front);
      clearSlide(back);
      showStatus("No photos yet. Hold the screen, then tap Choose Photos.");
      revokeLocalUrls(previousUrls);
      return;
    }
    refillQueue();
    var tried = 0;
    while (tried < photos.length && queue.length) {
      if (generation !== playGeneration) {
        revokeLocalUrls(previousUrls);
        return;
      }
      var url = queue.shift();
      tried += 1;
      try {
        await preload(url);
      } catch (err) {
        continue;
      }
      if (generation !== playGeneration) {
        revokeLocalUrls(previousUrls);
        return;
      }
      showImmediate(url);
      revokeLocalUrls(previousUrls);
      armHold();
      return;
    }
    if (generation !== playGeneration) return;
    clearSlide(front);
    clearSlide(back);
    showStatus("These photos could not be loaded.");
    revokeLocalUrls(previousUrls);
  }

  async function addFiles(files) {
    if (!files.length) return;
    updateCount("Saving…");
    var savedAny = false;
    for (var i = 0; i < files.length; i += 1) {
      var blob = await fileToJpeg(files[i]);
      if (!blob) continue;
      try {
        await saveBlob(blob);
        savedAny = true;
      } catch (err) {
        break;
      }
    }
    if (!savedAny) {
      try {
        var existing = await readAllSaved();
        savedCount = existing.length;
      } catch (err) {
        savedCount = 0;
      }
      updateCount(savedCount ? "" : "Could not save photos on this iPad");
      return;
    }
    await boot();
  }

  function enqueueLibraryWork(work) {
    libraryChain = libraryChain.then(work).catch(function () {});
    return libraryChain;
  }

  function openSettings() {
    if (settingsOpen) return;
    settingsOpen = true;
    clearTimeout(holdTimer);
    holdTimer = 0;
    syncControls();
    settingsEl.hidden = false;
  }

  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    settingsEl.hidden = true;
    if (!fading) armHold();
  }

  function cancelPress() {
    pressing = false;
    clearTimeout(pressTimer);
    pressTimer = 0;
  }

  stage.addEventListener("pointerdown", function (event) {
    if (settingsOpen) return;
    if (event.button !== undefined && event.button !== 0) return;
    pressing = true;
    pressX = event.clientX;
    pressY = event.clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function () {
      pressTimer = 0;
      pressing = false;
      openSettings();
    }, LONG_PRESS_MS);
  });

  window.addEventListener("pointerup", cancelPress);
  window.addEventListener("pointercancel", cancelPress);
  window.addEventListener("pointermove", function (event) {
    if (!pressing) return;
    var dx = event.clientX - pressX;
    var dy = event.clientY - pressY;
    if (Math.sqrt(dx * dx + dy * dy) > MOVE_CANCEL_PX) cancelPress();
  });

  stage.addEventListener("contextmenu", function (event) {
    event.preventDefault();
  });

  settingsEl.addEventListener("pointerdown", function (event) {
    if (event.target === settingsEl) closeSettings();
  });

  closeButton.addEventListener("click", function () {
    closeSettings();
  });

  photoInput.addEventListener("change", function () {
    var selected = photoInput.files;
    var files = [];
    if (selected) {
      for (var i = 0; i < selected.length; i += 1) files.push(selected[i]);
    }
    photoInput.value = "";
    if (!files.length) return;
    enqueueLibraryWork(function () { return addFiles(files); });
  });

  clearButton.addEventListener("click", function () {
    enqueueLibraryWork(function () {
      return clearSaved().then(function () { return boot(); });
    });
  });

  shuffleButton.addEventListener("click", function () {
    shuffle = !shuffle;
    queue = [];
    writeSettings();
    syncControls();
  });

  var intervalButtons = document.querySelectorAll(".interval-list button");
  for (var b = 0; b < intervalButtons.length; b += 1) {
    intervalButtons[b].addEventListener("click", function (event) {
      var next = Number(event.currentTarget.getAttribute("data-ms"));
      if (ALLOWED_INTERVALS.indexOf(next) === -1) return;
      intervalMs = next;
      writeSettings();
      syncControls();
    });
  }

  function stopVideoFallback() {
    stayAwake.pause();
  }

  function startVideoFallback(reason) {
    stayAwake.muted = true;
    stayAwake.playsInline = true;
    document.documentElement.dataset.wakeLock = "fallback-video";
    document.documentElement.dataset.wakeLockReason = reason || "error";
    var pending = stayAwake.play();
    if (pending && typeof pending.catch === "function") {
      pending.catch(function () {
        if (!wakeLockSentinel) {
          document.documentElement.dataset.wakeLock = "needs-gesture";
        }
      });
    }
  }

  function requestScreenWakeLock() {
    document.documentElement.dataset.wakeLockAttempted = "true";
    if (wakeLockSentinel) return Promise.resolve();
    if (wakeLockTask) return wakeLockTask;
    wakeLockTask = requestScreenWakeLockNow().finally(function () {
      wakeLockTask = null;
    });
    return wakeLockTask;
  }

  async function requestScreenWakeLockNow() {
    var wakeLock = navigator.wakeLock;
    if (!wakeLock || typeof wakeLock.request !== "function") {
      startVideoFallback("unsupported");
      return;
    }
    try {
      var sentinel = await wakeLock.request("screen");
      wakeLockSentinel = sentinel;
      stopVideoFallback();
      document.documentElement.dataset.wakeLock = "active";
      document.documentElement.dataset.wakeLockReason = "";
      sentinel.addEventListener("release", function () {
        if (wakeLockSentinel === sentinel) wakeLockSentinel = null;
        document.documentElement.dataset.wakeLock = "released";
      });
    } catch (err) {
      wakeLockSentinel = null;
      var reason = err && err.name ? err.name : "error";
      startVideoFallback(reason);
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") requestScreenWakeLock();
  });

  window.addEventListener("pointerdown", function () {
    if (!wakeLockSentinel) requestScreenWakeLock();
  });

  boot();
  requestScreenWakeLock();
})();
