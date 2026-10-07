/* digital_aquarium - browser aquarium for kanon-server.com / others
 *
 * The fish simulation (wandering, feeding, bubbles, ripples, day/night) is the
 * original p5 sketch. What changed:
 *   - the Python folder-watcher server is gone; fish images are processed to
 *     transparent sprites in the browser (Canvas), so the site is static;
 *   - Arduino joystick / camera scanner are opt-in, chosen at start-up, with a
 *     mouse + file-upload fallback;
 *   - p5.dom / p5.sound were dropped (plain DOM + Web Audio).
 */
'use strict';

/* =========================================================================
 * 1. App layer: DOM, sound, in-browser image processing, input, hardware
 * ========================================================================= */
window.AQ = (function () {
  const ASSETS = 'assets/';
  const DEFAULT_FISH_FILES = ['fish1.png', 'fish2.png', 'fish3.png'];
  const MAX_PROCESS_DIM = 1024;

  const $ = (id) => document.getElementById(id);
  const ui = {
    overlay: $('overlay'),
    modeCards: Array.from(document.querySelectorAll('.mode-card')),
    start: $('start'),
    modeBtn: $('mode-btn'),
    add: $('btn-add'),
    scan: $('btn-scan'),
    serial: $('btn-serial'),
    sound: $('btn-sound'),
    file: $('file-input'),
    toast: $('toast'),
    camera: $('camera'),
    camVideo: $('cam-video'),
    camCanvas: $('cam-canvas'),
    camShot: $('cam-shot'),
    camClose: $('cam-close'),
  };

  const state = { mode: 'simple', started: false, selected: 'simple' };
  const input = { mode: 'mouse', x: 0, y: 0, visible: false, wasPressed: false };
  const hooks = { addSprite: null, feed: null };

  // ---- toast ----
  let toastTimer = null;
  function toast(message, kind) {
    if (!ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      ui.toast.className = 'toast';
    }, 2800);
  }

  // ---- sound (replaces p5.sound) ----
  const Sfx = {
    ctx: null,
    buffer: null,
    muted: false,
    init: function () {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const self = this;
      fetch(ASSETS + 'bubble_pop.mp3')
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { return self.ctx.decodeAudioData(buf); })
        .then(function (dec) { self.buffer = dec; })
        .catch(function () {});
    },
    resume: function () {
      if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(function () {});
    },
    bubble: function (xNorm) {
      if (!this.ctx || !this.buffer || this.muted) return;
      if (this.ctx.state !== 'running') return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffer;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.04 + Math.random() * 0.12;
      src.connect(gain);
      let out = gain;
      if (this.ctx.createStereoPanner) {
        const pan = this.ctx.createStereoPanner();
        pan.pan.value = Math.max(-0.9, Math.min(0.9, xNorm));
        gain.connect(pan);
        out = pan;
      }
      out.connect(this.ctx.destination);
      src.start();
    },
  };

  // ---- in-browser image processing: drawing -> transparent fish sprite ----
  const FishImage = (function () {
    function loadToCanvas(source, maxDim) {
      const sw = source.naturalWidth || source.width;
      const sh = source.naturalHeight || source.height;
      const scale = Math.min(1, maxDim / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, w, h);
      return canvas;
    }

    function hasTransparency(data) {
      const total = data.length / 4;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250 && ++count > total * 0.02) return true;
      }
      return false;
    }

    // Adaptive mean threshold (blockSize, C) -> binary inverse (ink = 255).
    function adaptiveThreshold(gray, w, h, block, C) {
      const r = (block - 1) >> 1;
      const W = w + 1;
      const integral = new Uint32Array(W * (h + 1));
      for (let y = 0; y < h; y++) {
        let rowSum = 0;
        for (let x = 0; x < w; x++) {
          rowSum += gray[y * w + x];
          integral[(y + 1) * W + (x + 1)] = integral[y * W + (x + 1)] + rowSum;
        }
      }
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - r);
        const y1 = Math.min(h - 1, y + r);
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - r);
          const x1 = Math.min(w - 1, x + r);
          const area = (x1 - x0 + 1) * (y1 - y0 + 1);
          const sum =
            integral[(y1 + 1) * W + (x1 + 1)] -
            integral[y0 * W + (x1 + 1)] -
            integral[(y1 + 1) * W + x0] +
            integral[y0 * W + x0];
          out[y * w + x] = gray[y * w + x] <= sum / area - C ? 255 : 0;
        }
      }
      return out;
    }

    function morphology(src, w, h, isErode, iterations) {
      let cur = src;
      for (let it = 0; it < iterations; it++) {
        const dst = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let keep = isErode;
            for (let dy = -1; dy <= 1 && (isErode ? keep : !keep); dy++) {
              const ny = y + dy;
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const inside = nx >= 0 && nx < w && ny >= 0 && ny < h;
                const s = inside ? cur[ny * w + nx] : 0;
                if (isErode && s === 0) { keep = false; break; }
                if (!isErode && s === 255) { keep = true; break; }
              }
            }
            dst[y * w + x] = keep ? 255 : 0;
          }
        }
        cur = dst;
      }
      return cur;
    }

    function largestComponent(bin, w, h) {
      const labels = new Int32Array(w * h);
      const stack = new Int32Array(w * h);
      let bestLabel = 0;
      let bestSize = 0;
      let label = 0;
      for (let i = 0; i < w * h; i++) {
        if (bin[i] === 0 || labels[i] !== 0) continue;
        label++;
        let sp = 0;
        stack[sp++] = i;
        labels[i] = label;
        let size = 0;
        while (sp > 0) {
          const p = stack[--sp];
          size++;
          const px = p % w;
          const py = (p - px) / w;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = py + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = px + dx;
              if (nx < 0 || nx >= w) continue;
              const q = ny * w + nx;
              if (bin[q] === 255 && labels[q] === 0) {
                labels[q] = label;
                stack[sp++] = q;
              }
            }
          }
        }
        if (size > bestSize) { bestSize = size; bestLabel = label; }
      }
      if (bestLabel === 0 || bestSize < w * h * 0.002) return null;
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) if (labels[i] === bestLabel) mask[i] = 1;
      return mask;
    }

    function fillHoles(mask, w, h) {
      const outside = new Uint8Array(w * h);
      const stack = new Int32Array(w * h);
      let sp = 0;
      const push = function (i) {
        if (mask[i] === 0 && outside[i] === 0) { outside[i] = 1; stack[sp++] = i; }
      };
      for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
      while (sp > 0) {
        const p = stack[--sp];
        const px = p % w;
        const py = (p - px) / w;
        if (px > 0) push(p - 1);
        if (px < w - 1) push(p + 1);
        if (py > 0) push(p - w);
        if (py < h - 1) push(p + w);
      }
      for (let i = 0; i < w * h; i++) if (mask[i] === 0 && outside[i] === 0) mask[i] = 1;
    }

    function trim(canvas) {
      const w = canvas.width;
      const h = canvas.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const d = ctx.getImageData(0, 0, w, h).data;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return canvas;
      const cw = maxX - minX + 1;
      const ch = maxY - minY + 1;
      const pad = Math.round(Math.max(cw, ch) * 0.03);
      const out = document.createElement('canvas');
      out.width = cw + pad * 2;
      out.height = ch + pad * 2;
      out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, pad, pad, cw, ch);
      return out;
    }

    function process(source) {
      const colorCanvas = loadToCanvas(source, MAX_PROCESS_DIM);
      const w = colorCanvas.width;
      const h = colorCanvas.height;
      const ctx = colorCanvas.getContext('2d', { willReadFrequently: true });
      const data = ctx.getImageData(0, 0, w, h).data;

      if (hasTransparency(data)) return trim(colorCanvas);

      const gray = new Uint8ClampedArray(w * h);
      for (let i = 0, j = 0; j < w * h; i += 4, j++) {
        gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      }

      let bin = adaptiveThreshold(gray, w, h, 15, 4);
      bin = morphology(bin, w, h, true, 1);   // open
      bin = morphology(bin, w, h, false, 1);
      bin = morphology(bin, w, h, false, 2);  // close
      bin = morphology(bin, w, h, true, 2);

      const mask = largestComponent(bin, w, h);
      if (!mask) return null;
      fillHoles(mask, w, h);

      const out = ctx.createImageData(w, h);
      const od = out.data;
      for (let j = 0; j < w * h; j++) {
        od[j * 4] = data[j * 4];
        od[j * 4 + 1] = data[j * 4 + 1];
        od[j * 4 + 2] = data[j * 4 + 2];
        od[j * 4 + 3] = mask[j] ? 255 : 0;
      }
      const cut = document.createElement('canvas');
      cut.width = w;
      cut.height = h;
      cut.getContext('2d', { willReadFrequently: true }).putImageData(out, 0, 0);
      return trim(cut);
    }

    return { process: process };
  })();

  function imageFromFile(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
      img.src = url;
    });
  }

  function imageFromUrl(url) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  function addFromImage(img) {
    const sprite = FishImage.process(img);
    if (!sprite) return false;
    if (hooks.addSprite) hooks.addSprite(sprite.toDataURL('image/png'));
    return true;
  }

  function handleFiles(files) {
    const list = Array.from(files).filter(function (f) { return f.type.indexOf('image/') === 0; });
    if (!list.length) return;
    toast('魚を加工しています…');
    let ok = 0;
    let done = 0;
    list.reduce(function (chain, file) {
      return chain.then(function () {
        return imageFromFile(file).then(function (img) {
          if (addFromImage(img)) ok++;
        }).catch(function () {}).then(function () { done++; });
      });
    }, Promise.resolve()).then(function () {
      if (ok) toast(ok + '匹の魚を追加しました');
      else toast('魚のかたちを見つけられませんでした', 'bad');
    });
  }

  // ---- camera scanner ----
  let camStream = null;
  function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('カメラが利用できません。画像を選んでください', 'bad');
      ui.file.click();
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (stream) {
        camStream = stream;
        ui.camVideo.srcObject = stream;
        ui.camVideo.play().catch(function () {});
        ui.camera.classList.remove('hidden');
      })
      .catch(function () {
        toast('カメラを開けませんでした。画像を選んでください', 'bad');
        ui.file.click();
      });
  }
  function closeCamera() {
    if (camStream) {
      camStream.getTracks().forEach(function (t) { t.stop(); });
      camStream = null;
    }
    ui.camera.classList.add('hidden');
  }
  function captureCamera() {
    const v = ui.camVideo;
    const canvas = ui.camCanvas;
    const vw = v.videoWidth || 1280;
    const vh = v.videoHeight || 720;
    canvas.width = vw;
    canvas.height = vh;
    canvas.getContext('2d').drawImage(v, 0, 0, vw, vh);
    const url = canvas.toDataURL('image/png');
    closeCamera();
    toast('魚を加工しています…');
    imageFromUrl(url).then(function (img) {
      if (addFromImage(img)) toast('スキャンした魚を追加しました');
      else toast('魚のかたちを見つけられませんでした', 'bad');
    }).catch(function () {});
  }

  // ---- Arduino (Web Serial) ----
  let port = null;
  let serialBuffer = '';
  function connectSerial() {
    if (!('serial' in navigator)) {
      toast('このブラウザは Arduino 接続に対応していません', 'bad');
      return;
    }
    navigator.serial.requestPort().then(function (p) {
      port = p;
      return port.open({ baudRate: 9600 });
    }).then(function () {
      ui.serial.classList.add('active');
      toast('Arduino に接続しました');
      Sfx.resume();
      readSerial();
    }).catch(function (err) {
      if (!err || err.name !== 'NotFoundError') toast('Arduino に接続できませんでした', 'bad');
    });
  }
  function readSerial() {
    const decoder = new TextDecoder();
    (function loop() {
      if (!port || !port.readable) {
        ui.serial.classList.remove('active');
        return;
      }
      const reader = port.readable.getReader();
      (function pump() {
        reader.read().then(function (res) {
          if (res.done) { reader.releaseLock(); loop(); return; }
          serialBuffer += decoder.decode(res.value, { stream: true });
          let index;
          while ((index = serialBuffer.indexOf('\n')) >= 0) {
            const line = serialBuffer.slice(0, index).trim();
            serialBuffer = serialBuffer.slice(index + 1);
            if (line) parseSerial(line);
          }
          pump();
        }).catch(function () { reader.releaseLock(); loop(); });
      })();
    })();
  }
  function parseSerial(line) {
    const parts = line.split(',');
    if (parts.length < 4 || parts[0] !== 'STICK') return;
    const xRaw = parseInt(parts[1], 10);
    const yRaw = parseInt(parts[2], 10);
    const pressed = parseInt(parts[3], 10) === 0;
    if (pressed) {
      input.mode = 'stick';
      input.x = ((xRaw + 30) / 60) * width;
      input.y = ((yRaw + 30) / 60) * height;
      input.visible = true;
    } else if (input.mode === 'stick' && input.wasPressed) {
      input.visible = false;
      if (hooks.feed) hooks.feed(input.x, input.y);
    }
    input.wasPressed = pressed;
  }

  // ---- pointer input ----
  function bindCanvas(el) {
    const setPos = function (clientX, clientY) {
      const rect = el.getBoundingClientRect();
      input.mode = 'mouse';
      input.x = clientX - rect.left;
      input.y = clientY - rect.top;
      input.visible = true;
    };
    el.addEventListener('mousemove', function (e) { setPos(e.clientX, e.clientY); });
    el.addEventListener('mouseleave', function () { if (input.mode === 'mouse') input.visible = false; });
    el.addEventListener('click', function (e) {
      setPos(e.clientX, e.clientY);
      if (hooks.feed) hooks.feed(input.x, input.y);
    });
    el.addEventListener('touchstart', function (e) {
      const t = e.touches[0];
      if (t) setPos(t.clientX, t.clientY);
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      const t = e.touches[0];
      if (t) setPos(t.clientX, t.clientY);
    }, { passive: true });
    el.addEventListener('touchend', function () {
      if (hooks.feed) hooks.feed(input.x, input.y);
    }, { passive: true });
  }

  // ---- start / mode ----
  function start(mode) {
    state.mode = mode;
    state.started = true;
    Sfx.init();
    Sfx.resume();
    ui.modeBtn.textContent = mode === 'hardware' ? 'Arduino・スキャナー' : 'マウス操作';
    ui.scan.hidden = mode !== 'hardware';
    ui.serial.hidden = mode !== 'hardware';
    ui.overlay.classList.add('hidden');
    if (mode === 'hardware') {
      toast('ジョイスティックを接続するか、カメラでスキャンしてください');
    } else {
      toast('クリックで餌をまけます。右上の＋から画像を読み込めます');
    }
  }

  function wire() {
    ui.modeCards.forEach(function (card) {
      card.addEventListener('click', function () {
        state.selected = card.dataset.mode;
        ui.modeCards.forEach(function (c) {
          const on = c === card;
          c.classList.toggle('selected', on);
          c.setAttribute('aria-checked', String(on));
        });
      });
    });
    ui.start.addEventListener('click', function () { start(state.selected); });
    ui.modeBtn.addEventListener('click', function () { ui.overlay.classList.remove('hidden'); });

    ui.add.addEventListener('click', function () { ui.file.click(); });
    ui.file.addEventListener('change', function () {
      handleFiles(ui.file.files);
      ui.file.value = '';
    });
    ui.scan.addEventListener('click', openCamera);
    ui.camShot.addEventListener('click', captureCamera);
    ui.camClose.addEventListener('click', closeCamera);
    ui.serial.addEventListener('click', connectSerial);

    let muted = false;
    try { muted = localStorage.getItem('aquarium:muted') === '1'; } catch (e) {}
    Sfx.muted = muted;
    ui.sound.classList.toggle('muted', muted);
    ui.sound.setAttribute('aria-pressed', String(muted));
    ui.sound.addEventListener('click', function () {
      Sfx.muted = !Sfx.muted;
      ui.sound.classList.toggle('muted', Sfx.muted);
      ui.sound.setAttribute('aria-pressed', String(Sfx.muted));
      try { localStorage.setItem('aquarium:muted', Sfx.muted ? '1' : '0'); } catch (e) {}
    });

    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      if (state.started && e.dataTransfer && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });
  }

  wire();

  return {
    ASSETS: ASSETS,
    DEFAULT_FISH_FILES: DEFAULT_FISH_FILES,
    Sfx: Sfx,
    state: state,
    input: input,
    hooks: hooks,
    bindCanvas: bindCanvas,
    toast: toast,
  };
})();

/* =========================================================================
 * 2. p5 sketch (global mode) - the aquarium itself
 * ========================================================================= */
const VIRTUAL_DAY_DURATION = 10 * 60 * 1000;
const FISH_LIFESPAN = 180;

let allFish = [];
let bubbles = [];
let ripples = [];
let foodPellets = [];
let defaultFishImages = [];
let bgLayer = null;

const displayCursor = { x: 0, y: 0 };

function preload() {
  AQ.DEFAULT_FISH_FILES.forEach(function (file) {
    loadImage(AQ.ASSETS + file, function (img) { defaultFishImages.push(img); }, function () {});
  });
}

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight);
  cnv.parent('stage');
  AQ.bindCanvas(cnv.elt);
  AQ.hooks.feed = function (x, y) { feedFish(x, y); };
  AQ.hooks.addSprite = function (url) {
    loadImage(url, function (img) {
      if (img && img.width > 0) allFish.push(new Fish(img, false));
    });
  };

  displayCursor.x = width / 2;
  displayCursor.y = height / 2;

  const count = Math.min(AQ.DEFAULT_FISH_FILES.length, defaultFishImages.length);
  for (let i = 0; i < count; i++) {
    const img = defaultFishImages[i];
    if (img && img.width > 0) allFish.push(new Fish(img, true));
  }

  buildBackground();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  buildBackground();
}

function draw() {
  if (bgLayer) image(bgLayer, 0, 0);
  else background('#0a2740');

  if (frameCount % 15 === 0) bubbles.push(new Bubble());
  for (let i = bubbles.length - 1; i >= 0; i--) {
    bubbles[i].update();
    bubbles[i].display();
    if (bubbles[i].isFinished()) bubbles.splice(i, 1);
  }

  const input = AQ.input;
  displayCursor.x += (input.x - displayCursor.x) * 0.3;
  displayCursor.y += (input.y - displayCursor.y) * 0.3;
  if (input.visible) {
    const breath = sin(frameCount * 0.1) * 5 + 30;
    noStroke();
    fill(255, 255, 255, 80);
    ellipse(displayCursor.x, displayCursor.y, breath, breath);
    fill(255, 255, 255, 180);
    ellipse(displayCursor.x, displayCursor.y, 8, 8);
  }

  for (let i = foodPellets.length - 1; i >= 0; i--) {
    foodPellets[i].update();
    foodPellets[i].display();
    if (foodPellets[i].isFinished()) foodPellets.splice(i, 1);
  }

  for (let i = ripples.length - 1; i >= 0; i--) {
    ripples[i].update();
    ripples[i].display();
    if (ripples[i].isFinished()) ripples.splice(i, 1);
  }

  for (let i = allFish.length - 1; i >= 0; i--) {
    const fish = allFish[i];
    fish.applyBehaviors(allFish);
    fish.update();
    fish.checkCollisionWithBubbles(bubbles);
    fish.display();
    fish.checkBounds();
    if (!fish.isDefault && fish.isDead()) allFish.splice(i, 1);
  }

  if (frameCount % 30 === 0) buildBackground();
}

// Day/night gradient, cached to an offscreen buffer instead of redrawing the
// whole column stack every frame.
function buildBackground() {
  if (!bgLayer || bgLayer.width !== width || bgLayer.height !== height) {
    bgLayer = createGraphics(width, height);
  }
  const elapsed = millis() % VIRTUAL_DAY_DURATION;
  const hour = (elapsed / VIRTUAL_DAY_DURATION) * 24;
  const day = 0.5 - 0.5 * cos((hour / 24) * TWO_PI); // 0 at midnight, 1 at noon
  const top = lerpColor(color('#012a4a'), color('#b3e5fc'), day);
  const bottom = lerpColor(color('#01111f'), color('#03a9f4'), day);
  bgLayer.strokeWeight(1);
  for (let y = 0; y < height; y++) {
    bgLayer.stroke(lerpColor(top, bottom, y / height));
    bgLayer.line(0, y, width, y);
  }
}

function feedFish(x, y) {
  for (let i = 0; i < 10; i++) foodPellets.push(new FoodPellet(x, y));
  ripples.push(new Ripple(x, y));
}

/* ------------------------------ Fish ------------------------------ */
class Fish {
  constructor(img, isDefaultFish = false) {
    this.img = img;
    this.isDefault = isDefaultFish;
    this.size = this.isDefault ? random(150, 300) : random(250, 450);
    this.birthTime = millis();
    const speed = random(1, this.isDefault ? 2.5 : 3);
    const startY = random(height * 0.2, height * 0.8);
    if (random() < 0.5) {
      this.pos = createVector(width + this.size / 2, startY);
      this.vel = createVector(-speed, 0);
    } else {
      this.pos = createVector(-this.size / 2, startY);
      this.vel = createVector(speed, 0);
    }
    this.pukapukaAngle = random(TWO_PI);
    this.pukapukaSpeed = random(0.02, 0.05);
    this.pukapukaAmplitude = random(10, 30);
    this.targetY = startY;
    this.baseY = startY;
    this.acc = createVector();
    this.maxSpeed = this.isDefault ? 3.5 : 4;
    this.maxForce = 0.05;
    this.awareness = random(0.5, 1.0);
    this.targetFood = null;
    this.isEating = false;
    this.eatTimer = 0;
    this.wanderTimer = millis() + random(2000, 5000);
    this.bobbingAngle = random(TWO_PI);
    this.bobbingSpeed = random(0.1, 0.2);
    this.bobbingAmount = this.size * 0.01;
  }

  update() {
    this.vel.add(this.acc);
    this.vel.limit(this.isEating ? this.maxSpeed * 1.5 : this.maxSpeed);
    this.pos.add(this.vel);
    this.acc.mult(0);
    if (this.isEating) {
      this.eatTimer--;
      if (this.eatTimer <= 0) {
        this.isEating = false;
        if (this.targetFood) this.eatFood(this.targetFood);
      }
    }
    if (!this.targetFood && !this.isEating) {
      this.baseY += (this.targetY - this.baseY) * 0.1;
      this.pukapukaAngle += this.pukapukaSpeed;
      this.pos.y = this.baseY + sin(this.pukapukaAngle) * this.pukapukaAmplitude;
    } else {
      this.baseY = this.pos.y;
      this.targetY = this.pos.y;
    }
    if (!this.targetFood && !this.isEating) {
      if (this.vel.x > 0) this.vel.x = max(this.vel.x, 1.0);
      if (this.vel.x < 0) this.vel.x = min(this.vel.x, -1.0);
    }
    this.bobbingAngle += this.bobbingSpeed;
    const fishHeight = (this.img.height / this.img.width) * this.size;
    this.pos.y = constrain(this.pos.y, fishHeight / 2, height - fishHeight / 2);
  }

  applyBehaviors(fishes) {
    const separateForce = this.separate(fishes);
    separateForce.mult(0.5);
    this.applyForce(separateForce);
    let didSeek = false;
    if (!this.isEating) didSeek = this.seekFoodBehavior();
    if (!didSeek) this.wanderBehavior();
  }

  seekFoodBehavior() {
    if (this.targetFood) {
      if (this.targetFood.isFinished() || !foodPellets.includes(this.targetFood)) {
        this.targetFood = null;
        return false;
      }
      const seekForce = this.seek(this.targetFood.pos);
      seekForce.mult(1.5);
      this.applyForce(seekForce);
      const d = p5.Vector.dist(this.pos, this.targetFood.pos);
      if (d < 30 && !this.isEating) this.startEating();
      return true;
    }
    if (foodPellets.length > 0) {
      let closestFood = null;
      let closestDist = Infinity;
      for (const pellet of foodPellets) {
        if (pellet.isFinished()) continue;
        const d = p5.Vector.dist(this.pos, pellet.pos);
        if (d < closestDist) { closestDist = d; closestFood = pellet; }
      }
      if (closestFood && random() < this.awareness * 0.1) {
        this.targetFood = closestFood;
        return true;
      }
    }
    return false;
  }

  startEating() {
    this.isEating = true;
    this.eatTimer = 10;
    const force = p5.Vector.sub(this.targetFood.pos, this.pos);
    force.setMag(this.maxForce * 5);
    this.applyForce(force);
  }

  eatFood(food) {
    food.lifespan = 0;
    this.targetFood = null;
    this.isEating = false;
  }

  checkCollisionWithBubbles(bubbles) {
    if (this.targetFood || this.isEating) return;
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i];
      const d = dist(this.pos.x, this.pos.y, bubble.x, bubble.y);
      if (d < this.size / 2.5 + bubble.r / 2) {
        this.floatUp();
        bubbles.splice(i, 1);
      }
    }
  }

  floatUp() {
    this.targetY -= 30;
  }

  checkBounds() {
    let didWarp = false;
    if (this.vel.x < 0 && this.pos.x < -this.size * 1.5) {
      this.pos.x = width + this.size * 1.5;
      didWarp = true;
    }
    if (this.vel.x > 0 && this.pos.x > width + this.size * 1.5) {
      this.pos.x = -this.size * 1.5;
      didWarp = true;
    }
    if (didWarp) {
      this.baseY = random(height * 0.2, height * 0.8);
      this.targetY = this.baseY;
      this.pos.y = this.baseY;
      this.targetFood = null;
      this.isEating = false;
    }
  }

  isDead() {
    return (millis() - this.birthTime) / 1000 > FISH_LIFESPAN;
  }

  display() {
    push();
    translate(this.pos.x, this.pos.y);
    translate(0, sin(this.bobbingAngle) * this.bobbingAmount);
    if (this.vel.x > 0) scale(-1, 1);
    imageMode(CENTER);
    image(this.img, 0, 0, this.size, this.size * (this.img.height / this.img.width));
    pop();
  }

  applyForce(force) {
    this.acc.add(force);
  }

  seek(targetPos) {
    const desired = p5.Vector.sub(targetPos, this.pos);
    const d = desired.mag();
    let speed = this.maxSpeed;
    if (d < 50) speed = map(d, 0, 50, this.maxSpeed * 0.1, this.maxSpeed);
    desired.setMag(speed);
    const steer = p5.Vector.sub(desired, this.vel);
    steer.limit(this.maxForce);
    return steer;
  }

  separate(fishes) {
    const desiredSeparation = this.size * 0.7;
    const steer = createVector();
    let count = 0;
    for (const other of fishes) {
      const d = dist(this.pos.x, this.pos.y, other.pos.x, other.pos.y);
      if (d > 0 && d < desiredSeparation) {
        const diff = p5.Vector.sub(this.pos, other.pos);
        diff.normalize();
        diff.div(d);
        steer.add(diff);
        count++;
      }
    }
    if (count > 0) steer.div(count);
    if (steer.mag() > 0) {
      steer.setMag(this.maxSpeed);
      steer.sub(this.vel);
      steer.limit(this.maxForce);
    }
    return steer;
  }

  wanderBehavior() {
    if (!this.targetFood && !this.isEating && millis() > this.wanderTimer) {
      const w = p5.Vector.random2D();
      w.setMag(0.1);
      this.applyForce(w);
      this.wanderTimer = millis() + random(3000, 7000);
    }
  }
}

/* ----------------------------- Bubble ----------------------------- */
class Bubble {
  constructor() {
    this.x = random(width);
    this.y = height + random(10, 100);
    this.r = random(10, 50);
    this.speed = random(1, 3);
    if (random() < 0.3) {
      AQ.Sfx.bubble(map(this.x, 0, width, -1, 1));
    }
  }
  update() {
    this.y -= this.speed;
    this.x += random(-1, 1);
  }
  display() {
    stroke(255, 180);
    strokeWeight(2);
    noFill();
    ellipse(this.x, this.y, this.r, this.r);
  }
  isFinished() {
    return this.y < -this.r;
  }
}

/* ----------------------------- Ripple ----------------------------- */
class Ripple {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.radius = 0;
    this.alpha = 200;
  }
  update() {
    this.radius += 2;
    this.alpha -= 5;
  }
  display() {
    noFill();
    stroke(255, 255, 255, this.alpha);
    strokeWeight(2);
    ellipse(this.x, this.y, this.radius * 2);
  }
  isFinished() {
    return this.alpha <= 0;
  }
}

/* --------------------------- FoodPellet --------------------------- */
class FoodPellet {
  constructor(x, y) {
    this.pos = createVector(x + random(-30, 30), y + random(-30, 30));
    this.vel = createVector(random(-0.5, 0.5), random(0.5, 1.5));
    this.lifespan = 255 * 1.5;
    this.size = random(5, 10);
  }
  update() {
    this.pos.add(this.vel);
    this.lifespan -= 0.8;
    this.pos.x += sin(this.lifespan * 0.1) * 0.5;
  }
  display() {
    fill(255, 180, 0, this.lifespan);
    noStroke();
    ellipse(this.pos.x, this.pos.y, this.size, this.size);
  }
  isFinished() {
    return this.lifespan < 0;
  }
}
