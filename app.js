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
  var STORAGE_HIDDEN = "photoFrame.hiddenSamples";
  var DB_NAME = "photo-frame";
  var DB_STORE = "photos";
  // Long edge of the 13-inch iPad screen. Saved JPEGs stay sharp when shown in full, and smaller than camera originals.
  var MAX_EDGE = 2752;
  var JPEG_QUALITY = 0.82;

  var stage = document.getElementById("stage");
  var slideA = document.getElementById("slide-a");
  var slideB = document.getElementById("slide-b");
  var statusEl = document.getElementById("status");
  var clockEl = document.getElementById("clock");
  var clockDateEl = document.getElementById("clock-date");
  var clockTimeEl = document.getElementById("clock-time");
  var settingsEl = document.getElementById("settings");
  var stayAwake = document.getElementById("stay-awake");
  var shuffleButton = document.getElementById("shuffle-toggle");
  var closeButton = document.getElementById("close-settings");
  var photoInput = document.getElementById("photo-input");
  var photoCount = document.getElementById("photo-count");
  var removeButton = document.getElementById("remove-photo");
  var clearButton = document.getElementById("clear-photos");

  var front = slideA;
  var back = slideB;
  var photos = [];
  var order = [];
  var index = -1;
  var now = null;
  var intervalMs = DEFAULT_INTERVAL;
  var shuffle = true;
  var settingsOpen = false;
  var fading = false;
  var holdTimer = 0;
  var pressTimer = 0;
  var pressX = 0;
  var pressY = 0;
  var pressPointer = null;
  var pressing = false;
  var wakeLockSentinel = null;
  var wakeLockTask = null;
  var localUrls = [];
  var urlToId = {};
  var hiddenSamples = [];
  var removeTarget = null;
  var savedCount = 0;
  var playGeneration = 0;
  var clockStamp = "";
  var clockPlaceToken = 0;
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

  function readHidden() {
    hiddenSamples = [];
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_HIDDEN) || "[]");
      if (!Array.isArray(raw)) return;
      for (var i = 0; i < raw.length; i += 1) {
        if (typeof raw[i] !== "string") continue;
        var trimmed = raw[i].trim();
        if (trimmed && hiddenSamples.indexOf(trimmed) === -1) hiddenSamples.push(trimmed);
      }
    } catch (err) {
      hiddenSamples = [];
    }
  }

  function writeHidden() {
    try {
      localStorage.setItem(STORAGE_HIDDEN, JSON.stringify(hiddenSamples));
    } catch (err) {
      // The skip still applies until the page closes when storage throws.
    }
  }

  function rememberHidden(url) {
    readHidden();
    if (hiddenSamples.indexOf(url) === -1) hiddenSamples.push(url);
    writeHidden();
  }

  function activeSamples() {
    readHidden();
    var list = readList();
    var kept = [];
    for (var i = 0; i < list.length; i += 1) {
      if (hiddenSamples.indexOf(list[i]) === -1) kept.push(list[i]);
    }
    return kept;
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
    hideClock();
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  function hideStatus() {
    statusEl.hidden = true;
    statusEl.textContent = "";
  }

  function hideClock() {
    clockEl.hidden = true;
  }

  function updateClockText() {
    var date = new Date();
    var dateText = date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
    var timeText = date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    });
    var stamp = dateText + "\n" + timeText;
    if (stamp === clockStamp) return false;
    clockStamp = stamp;
    clockDateEl.textContent = dateText;
    clockTimeEl.textContent = timeText;
    return true;
  }

  function photoContentRect(slide) {
    var stageBox = stage.getBoundingClientRect();
    var box = slide.getBoundingClientRect();
    var nw = slide.naturalWidth;
    var nh = slide.naturalHeight;
    if (!nw || !nh || box.width < 2 || box.height < 2) return null;
    var scale = Math.min(box.width / nw, box.height / nh);
    var w = nw * scale;
    var h = nh * scale;
    return {
      x: box.left - stageBox.left + (box.width - w) / 2,
      y: box.top - stageBox.top + (box.height - h) / 2,
      w: w,
      h: h
    };
  }

  function isSkinTone(r, g, b) {
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    return r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 15 && (max - min) > 15;
  }

  function samplePatch(pixels, width, x0, y0, x1, y1) {
    var skin = 0;
    var count = 0;
    var sum = 0;
    var sum2 = 0;
    var red = 0;
    var green = 0;
    var blue = 0;
    var edges = 0;
    var skinEdges = 0;
    var wasSkin = false;
    var height = pixels.height;
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(width, x1);
    y1 = Math.min(height, y1);
    for (var y = y0; y < y1; y += 1) {
      var previous = 0;
      wasSkin = false;
      for (var x = x0; x < x1; x += 1) {
        var offset = (y * width + x) * 4;
        var r = pixels.data[offset];
        var g = pixels.data[offset + 1];
        var b = pixels.data[offset + 2];
        var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += lum;
        sum2 += lum * lum;
        red += r;
        green += g;
        blue += b;
        count += 1;
        var skinPixel = isSkinTone(r, g, b);
        if (skinPixel) skin += 1;
        if (x > x0) {
          edges += Math.abs(lum - previous);
          if (skinPixel !== wasSkin) skinEdges += 1;
        }
        wasSkin = skinPixel;
        previous = lum;
      }
    }
    if (!count) return null;
    var mean = sum / count;
    var variance = Math.max(0, sum2 / count - mean * mean);
    return {
      skin: skin / count,
      skinEdges: skinEdges / count,
      detail: Math.sqrt(variance) + edges / count,
      r: Math.round(red / count),
      g: Math.round(green / count),
      b: Math.round(blue / count)
    };
  }

  // A flat field can match the skin-tone test, including the red sample. A person is a skin cluster with edges or detail.
  function personThere(sample) {
    if (!sample || sample.skin < 0.18) return false;
    return sample.skinEdges >= 0.015 || sample.detail >= 12;
  }

  function chooseClockSpot(canvas, clockW, clockH, content, margin) {
    var context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    var pixels;
    try {
      pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    } catch (err) {
      return null;
    }

    function sampleAt(fx, fy) {
      var spanX = Math.max(0, content.w - clockW - margin * 2);
      var spanY = Math.max(0, content.h - clockH - margin * 2);
      var left = margin + fx * spanX;
      var top = margin + fy * spanY;
      var x0 = Math.floor(left / content.w * canvas.width);
      var y0 = Math.floor(top / content.h * canvas.height);
      var x1 = Math.max(x0 + 1, Math.floor((left + clockW) / content.w * canvas.width));
      var y1 = Math.max(y0 + 1, Math.floor((top + clockH) / content.h * canvas.height));
      var sample = samplePatch(pixels, canvas.width, x0, y0, x1, y1);
      return sample ? { fx: fx, fy: fy, sample: sample } : null;
    }

    var topLeft = sampleAt(0, 0);
    if (!personThere(topLeft && topLeft.sample)) return topLeft;
    var topRight = sampleAt(1, 0);
    if (!personThere(topRight && topRight.sample)) return topRight || topLeft;
    var cols = 5;
    var rows = 5;
    var row;
    var col;
    for (row = 0; row < rows; row += 1) {
      for (col = 0; col < cols; col += 1) {
        var fx = cols === 1 ? 0 : col / (cols - 1);
        var fy = rows === 1 ? 0 : row / (rows - 1);
        if (fy === 0 && (fx === 0 || fx === 1)) continue;
        var spot = sampleAt(fx, fy);
        if (spot && !personThere(spot.sample)) return spot;
      }
    }
    return topLeft;
  }

  function paintGlyphs(sample) {
    var red = sample ? sample.r : 32;
    var green = sample ? sample.g : 32;
    var blue = sample ? sample.b : 32;
    var lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    var ink = lum > 170 ? "rgba(16, 16, 16, 0.58)" : "rgba(255, 255, 255, 0.55)";
    clockDateEl.style.color = ink;
    clockTimeEl.style.color = ink;
  }

  function placeClock() {
    var token = ++clockPlaceToken;
    requestAnimationFrame(function () {
      if (token !== clockPlaceToken) return;
      var slide = front;
      var content = slide && slide.getAttribute("data-url") ? photoContentRect(slide) : null;
      if (!content || content.w < 48 || content.h < 48) {
        hideClock();
        return;
      }
      updateClockText();
      clockEl.hidden = false;
      clockEl.style.transform = "none";
      var rawW = clockEl.offsetWidth;
      var rawH = clockEl.offsetHeight;
      var scale = Math.min(1, (content.w * 0.46) / rawW, (content.h * 0.32) / rawH);
      clockEl.style.transformOrigin = "top left";
      clockEl.style.transform = scale < 1 ? "scale(" + scale + ")" : "none";
      var clockW = rawW * scale;
      var clockH = rawH * scale;
      var margin = Math.max(40, Math.min(content.w, content.h) * 0.07);
      var minX = content.x + margin;
      var minY = content.y + margin;
      var maxX = Math.max(minX, content.x + content.w - clockW - margin);
      var maxY = Math.max(minY, content.y + content.h - clockH - margin);

      function park(fx, fy, sample) {
        var left = minX + fx * (maxX - minX);
        var top = minY + fy * (maxY - minY);
        clockEl.style.left = Math.round(left) + "px";
        clockEl.style.top = Math.round(top) + "px";
        paintGlyphs(sample);
      }

      park(0, 0, null);
      if (!slide.complete || !slide.naturalWidth) return;
      var canvas = document.createElement("canvas");
      var longEdge = 96;
      if (slide.naturalWidth >= slide.naturalHeight) {
        canvas.width = longEdge;
        canvas.height = Math.max(1, Math.round(longEdge * slide.naturalHeight / slide.naturalWidth));
      } else {
        canvas.height = longEdge;
        canvas.width = Math.max(1, Math.round(longEdge * slide.naturalWidth / slide.naturalHeight));
      }
      var context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      try {
        context.drawImage(slide, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        return;
      }
      var spot = chooseClockSpot(canvas, clockW, clockH, content, margin);
      if (!spot || token !== clockPlaceToken) return;
      park(spot.fx, spot.fy, spot.sample);
    });
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

  function nextPass() {
    if (!photos.length) return [];
    var pass;
    if (!shuffle) {
      var start = 0;
      if (now) {
        var at = photos.indexOf(now);
        start = at === -1 ? 0 : (at + 1) % photos.length;
      }
      pass = photos.slice(start).concat(photos.slice(0, start));
    } else {
      pass = shuffledCopy(photos);
      if (now && pass.length > 1 && pass[0] === now) {
        var swapAt = -1;
        for (var i = 1; i < pass.length; i += 1) {
          if (pass[i] !== now) {
            swapAt = i;
            break;
          }
        }
        if (swapAt > 0) {
          var first = pass[0];
          pass[0] = pass[swapAt];
          pass[swapAt] = first;
        }
      }
    }
    if (now && pass.length && pass[0] === now && hasAnother(now)) {
      var keep = [];
      for (var n = 0; n < pass.length; n += 1) {
        if (pass[n] !== now) keep.push(pass[n]);
      }
      return keep;
    }
    return pass;
  }

  // Append the next pass. Taps and the timer share this order, so a tap does not reshuffle it.
  function appendPass() {
    if (index >= 0 && index < order.length - 1) return;
    var pass = nextPass();
    if (!pass.length) return;
    order = order.concat(pass);
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
    placeClock();
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

  function showUrl(url, generation) {
    return preload(url).then(function () {
      if (generation !== playGeneration || url === now) return false;
      return beginIncoming(url, generation);
    }).then(function (faded) {
      if (!faded || generation !== playGeneration) return false;
      now = url;
      placeClock();
      return true;
    }).catch(function () {
      return false;
    });
  }

  // direction 1 is the next photo. direction -1 is the photo just shown.
  function step(direction) {
    if (settingsOpen || fading || !hasAnother(now)) return Promise.resolve(false);
    if (direction < 0 && index <= 0) return Promise.resolve(false);
    var generation = playGeneration;
    clearTimeout(holdTimer);
    holdTimer = 0;
    fading = true;
    var moved = false;
    var travel = direction < 0 ? stepBack(generation) : stepForward(generation);
    return travel.then(function (didMove) {
      moved = didMove;
    }).finally(function () {
      if (generation !== playGeneration) return;
      fading = false;
      if (moved || hasAnother(now)) armHold();
    });
  }

  function stepBack(generation) {
    var cursor = index - 1;
    function tryOne() {
      if (generation !== playGeneration || cursor < 0) return Promise.resolve(false);
      var url = order[cursor];
      if (!url || url === now) {
        cursor -= 1;
        return tryOne();
      }
      var at = cursor;
      return showUrl(url, generation).then(function (ok) {
        if (generation !== playGeneration) return false;
        if (ok) {
          index = at;
          return true;
        }
        order.splice(at, 1);
        if (at < index) index -= 1;
        cursor = at - 1;
        return tryOne();
      });
    }
    return tryOne();
  }

  function stepForward(generation) {
    var guard = 0;
    var limit = Math.max(photos.length * 3, 1);
    function tryOne() {
      if (generation !== playGeneration || guard >= limit) return Promise.resolve(false);
      guard += 1;
      if (index >= order.length - 1) {
        var size = order.length;
        appendPass();
        if (order.length === size) return Promise.resolve(false);
      }
      var at = index + 1;
      var url = order[at];
      if (!url || url === now) {
        if (url === now) order.splice(at, 1);
        return tryOne();
      }
      return showUrl(url, generation).then(function (ok) {
        if (generation !== playGeneration) return false;
        if (ok) {
          index = at;
          return true;
        }
        order.splice(at, 1);
        return tryOne();
      });
    }
    return tryOne();
  }

  function startFade() {
    step(1);
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

  function deleteSaved(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error("delete")); };
        tx.onabort = function () { reject(tx.error || new Error("delete aborted")); };
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
    var nextIds = {};
    for (var i = 0; i < records.length; i += 1) {
      if (!records[i] || !records[i].blob) continue;
      var objectUrl = URL.createObjectURL(records[i].blob);
      nextUrls.push(objectUrl);
      if (records[i].id != null) nextIds[objectUrl] = records[i].id;
    }
    var previousUrls = localUrls;
    localUrls = nextUrls;
    urlToId = nextIds;
    savedCount = nextUrls.length;
    updateCount();
    order = [];
    index = -1;
    now = null;
    if (savedCount > 0) {
      photos = nextUrls.slice();
      document.documentElement.dataset.photoSource = "local";
    } else {
      photos = activeSamples();
      document.documentElement.dataset.photoSource = "samples";
    }
    if (!photos.length) {
      clearSlide(front);
      clearSlide(back);
      showStatus("No photos yet. Hold the screen, then tap Choose Photos.");
      revokeLocalUrls(previousUrls);
      return;
    }
    appendPass();
    var tried = 0;
    while (tried < photos.length && order.length) {
      if (generation !== playGeneration) {
        revokeLocalUrls(previousUrls);
        return;
      }
      var url = order[0];
      tried += 1;
      try {
        await preload(url);
      } catch (err) {
        order.shift();
        continue;
      }
      if (generation !== playGeneration) {
        revokeLocalUrls(previousUrls);
        return;
      }
      showImmediate(url);
      index = 0;
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
    removeTarget = now || (front && front.getAttribute("data-url")) || null;
    removeButton.disabled = !removeTarget;
    syncControls();
    settingsEl.hidden = false;
  }

  function closeSettingsWithoutResume() {
    settingsOpen = false;
    settingsEl.hidden = true;
    removeTarget = null;
    clearTimeout(holdTimer);
    holdTimer = 0;
  }

  async function showFirstAvailable(generation) {
    var tried = 0;
    while (tried < photos.length && order.length) {
      if (generation !== playGeneration) return;
      var url = order[0];
      tried += 1;
      try {
        await preload(url);
      } catch (err) {
        order.shift();
        continue;
      }
      if (generation !== playGeneration) return;
      showImmediate(url);
      index = 0;
      armHold();
      return;
    }
    if (generation !== playGeneration) return;
    clearSlide(front);
    clearSlide(back);
    showStatus(photos.length ? "These photos could not be loaded." : "No photos yet. Hold the screen, then tap Choose Photos.");
  }

  async function revealAfterRemoval(target) {
    var generation = ++playGeneration;
    fading = false;
    var upcoming = [];
    var i;
    for (i = index + 1; i < order.length; i += 1) {
      if (order[i] !== target) upcoming.push(order[i]);
    }
    for (i = 0; i < index; i += 1) {
      if (order[i] !== target) upcoming.push(order[i]);
    }
    var kept = [];
    for (i = 0; i < photos.length; i += 1) {
      if (photos[i] !== target) kept.push(photos[i]);
    }
    photos = kept;
    var cleaned = [];
    for (i = 0; i < upcoming.length; i += 1) {
      if (photos.indexOf(upcoming[i]) !== -1) cleaned.push(upcoming[i]);
    }
    order = cleaned.length ? cleaned : photos.slice();
    index = -1;
    now = null;
    if (!photos.length) {
      clearSlide(front);
      clearSlide(back);
      showStatus("No photos yet. Hold the screen, then tap Choose Photos.");
      return;
    }
    await showFirstAvailable(generation);
  }

  async function removePhoto(target) {
    if (!target) return;
    playGeneration += 1;
    fading = false;
    var savedId = urlToId[target];
    if (savedId != null) {
      try {
        await deleteSaved(savedId);
      } catch (err) {
        removeTarget = target;
        removeButton.disabled = false;
        return;
      }
      var keptUrls = [];
      for (var i = 0; i < localUrls.length; i += 1) {
        if (localUrls[i] === target) URL.revokeObjectURL(target);
        else keptUrls.push(localUrls[i]);
      }
      localUrls = keptUrls;
      delete urlToId[target];
      savedCount = keptUrls.length;
      updateCount();
      closeSettingsWithoutResume();
      if (savedCount === 0) {
        await boot();
        return;
      }
      await revealAfterRemoval(target);
      return;
    }
    rememberHidden(target);
    closeSettingsWithoutResume();
    await revealAfterRemoval(target);
  }

  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    settingsEl.hidden = true;
    if (!fading) armHold();
  }

  function cancelPress() {
    pressing = false;
    pressPointer = null;
    clearTimeout(pressTimer);
    pressTimer = 0;
  }

  // Left tap: previous photo in this play order. Right tap: next photo. A tap does not reshuffle.
  function tapPhoto(clientX) {
    if (settingsOpen || fading) return;
    var rect = stage.getBoundingClientRect();
    var mid = rect.left + rect.width / 2;
    step(clientX < mid ? -1 : 1);
  }

  stage.addEventListener("pointerdown", function (event) {
    if (settingsOpen) return;
    if (event.button !== undefined && event.button !== 0) return;
    pressing = true;
    pressPointer = event.pointerId;
    pressX = event.clientX;
    pressY = event.clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function () {
      pressTimer = 0;
      pressing = false;
      pressPointer = null;
      openSettings();
    }, LONG_PRESS_MS);
  });

  window.addEventListener("pointerup", function (event) {
    if (!pressing || event.pointerId !== pressPointer) return;
    var dx = event.clientX - pressX;
    var dy = event.clientY - pressY;
    var moved = Math.sqrt(dx * dx + dy * dy) > MOVE_CANCEL_PX;
    var x = event.clientX;
    cancelPress();
    if (moved || settingsOpen) return;
    tapPhoto(x);
  });
  window.addEventListener("pointercancel", function (event) {
    if (!pressing || event.pointerId !== pressPointer) return;
    cancelPress();
  });
  window.addEventListener("pointermove", function (event) {
    if (!pressing || event.pointerId !== pressPointer) return;
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

  removeButton.addEventListener("click", function () {
    var target = removeTarget;
    if (!target) return;
    removeTarget = null;
    removeButton.disabled = true;
    enqueueLibraryWork(function () { return removePhoto(target); });
  });

  clearButton.addEventListener("click", function () {
    enqueueLibraryWork(function () {
      return clearSaved().then(function () { return boot(); });
    });
  });

  shuffleButton.addEventListener("click", function () {
    shuffle = !shuffle;
    if (index >= 0) order.length = index + 1;
    else order = [];
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
  setInterval(function () {
    if (!updateClockText()) return;
    if (!clockEl.hidden) placeClock();
  }, 1000);

  window.addEventListener("resize", placeClock);
})();
