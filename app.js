const video = document.querySelector("#cameraVideo");
const canvas = document.querySelector("#cameraCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const sourceCanvas = document.createElement("canvas");
const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });

const startButton = document.querySelector("#startButton");
const snapshotButton = document.querySelector("#snapshotButton");
const cameraSelect = document.querySelector("#cameraSelect");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");

const controls = {
  hue: bindSlider("hue"),
  saturation: bindSlider("saturation"),
  contrast: bindSlider("contrast"),
  exposure: bindSlider("exposure"),
  remix: bindSlider("remix"),
  red: bindSlider("red"),
  green: bindSlider("green"),
  blue: bindSlider("blue"),
  mirror: document.querySelector("#mirrorToggle"),
  invert: document.querySelector("#invertToggle"),
  poster: document.querySelector("#posterToggle"),
  shadow: document.querySelector("#shadowColor"),
  mid: document.querySelector("#midColor"),
  light: document.querySelector("#lightColor"),
};

const defaults = {
  hue: 0,
  saturation: 115,
  contrast: 112,
  exposure: 0,
  remix: 62,
  red: 115,
  green: 105,
  blue: 120,
  mirror: true,
  invert: false,
  poster: false,
  shadow: "#10131c",
  mid: "#00d8a7",
  light: "#ff5a4f",
};

let mode = "natural";
let stream = null;
let frameId = 0;
let snapshotReady = false;
let sourceCopy = new Uint8ClampedArray(0);

const modeButtons = [...document.querySelectorAll("[data-mode]")];

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    mode = button.dataset.mode;
    modeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
  });
});

startButton.addEventListener("click", startCamera);
snapshotButton.addEventListener("click", downloadSnapshot);
cameraSelect.addEventListener("change", () => {
  if (stream) {
    startCamera();
  }
});

document.querySelector("#randomButton").addEventListener("click", randomRemix);
document.querySelector("#resetButton").addEventListener("click", resetMixer);

for (const slider of Object.values(controls)) {
  if (slider?.type === "range") {
    slider.addEventListener("input", () => updateSliderOutput(slider));
    updateSliderOutput(slider);
  }
}

populateCameras();
drawIdleFrame();

async function startCamera() {
  try {
    setStatus("Requesting camera access", "idle");
    stopStream();

    const selectedId = cameraSelect.value;
    const constraints = {
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
        ...(selectedId ? { deviceId: { exact: selectedId } } : {}),
      },
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    await populateCameras(stream.getVideoTracks()[0]?.getSettings().deviceId);

    startButton.classList.add("is-hidden");
    snapshotReady = true;
    setStatus("Live camera mixing", "live");
    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(renderFrame);
  } catch (error) {
    startButton.classList.remove("is-hidden");
    setStatus(cameraErrorMessage(error), "error");
  }
}

async function populateCameras(activeDeviceId = cameraSelect.value) {
  if (!navigator.mediaDevices?.enumerateDevices) {
    cameraSelect.innerHTML = '<option value="">Browser camera API unavailable</option>';
    cameraSelect.disabled = true;
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");

    cameraSelect.innerHTML = "";

    if (!cameras.length) {
      const option = new Option("Default camera", "");
      cameraSelect.append(option);
      return;
    }

    cameras.forEach((camera, index) => {
      const label = camera.label || `Camera ${index + 1}`;
      const option = new Option(label, camera.deviceId);
      cameraSelect.append(option);
    });

    if (activeDeviceId && [...cameraSelect.options].some((option) => option.value === activeDeviceId)) {
      cameraSelect.value = activeDeviceId;
    }
  } catch {
    cameraSelect.innerHTML = '<option value="">Default camera</option>';
  }
}

function renderFrame() {
  if (!stream) {
    return;
  }

  const { width, height } = resizeCanvas();

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && width > 0 && height > 0) {
    sourceCtx.save();
    sourceCtx.clearRect(0, 0, width, height);

    if (controls.mirror.checked) {
      sourceCtx.translate(width, 0);
      sourceCtx.scale(-1, 1);
    }

    drawVideoCover(sourceCtx, video, width, height);
    sourceCtx.restore();

    const frame = sourceCtx.getImageData(0, 0, width, height);
    applyColorMix(frame.data, width, height);
    ctx.putImageData(frame, 0, 0);
  }

  frameId = requestAnimationFrame(renderFrame);
}

function applyColorMix(data, width, height) {
  const values = readMixerValues();
  const remix = values.remix / 100;
  const shadow = hexToRgb(controls.shadow.value);
  const mid = hexToRgb(controls.mid.value);
  const light = hexToRgb(controls.light.value);

  if (mode === "channel") {
    if (sourceCopy.length !== data.length) {
      sourceCopy = new Uint8ClampedArray(data.length);
    }
    sourceCopy.set(data);
  }

  for (let index = 0; index < data.length; index += 4) {
    let r = data[index] * values.red;
    let g = data[index + 1] * values.green;
    let b = data[index + 2] * values.blue;

    if (mode === "channel") {
      const pixel = index / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const shift = Math.round(2 + remix * 18);
      const redIndex = 4 * (y * width + clampInt(x + shift, 0, width - 1));
      const blueIndex = 4 * (y * width + clampInt(x - shift, 0, width - 1));
      r = sourceCopy[redIndex] * values.red;
      g = sourceCopy[index + 1] * values.green;
      b = sourceCopy[blueIndex + 2] * values.blue;
    }

    r = clamp255(r);
    g = clamp255(g);
    b = clamp255(b);

    const shifted = adjustHsl(r, g, b, values.hue, values.saturation);
    r = shifted.r;
    g = shifted.g;
    b = shifted.b;

    r = applyTone(r, values.contrast, values.exposure);
    g = applyTone(g, values.contrast, values.exposure);
    b = applyTone(b, values.contrast, values.exposure);

    const luminance = clamp01((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255);
    let mixed = { r, g, b };

    if (mode === "duotone") {
      mixed = gradientColor(luminance, shadow, mid, light);
    } else if (mode === "thermal") {
      mixed = thermalColor(luminance, remix);
    } else if (mode === "solar") {
      const threshold = 0.5 + (remix - 0.5) * 0.35;
      mixed = {
        r: r / 255 > threshold ? 255 - r : r * (0.72 + remix),
        g: g / 255 > threshold ? 255 - g : g * (0.85 + remix * 0.55),
        b: b / 255 > threshold ? 255 - b : b * (1.1 + remix * 0.4),
      };
    } else if (mode === "mono") {
      mixed = {
        r: lerp(luminance * 255, light.r, remix * 0.45),
        g: lerp(luminance * 255, light.g, remix * 0.3),
        b: lerp(luminance * 255, light.b, remix * 0.2),
      };
    }

    r = lerp(r, mixed.r, mode === "natural" ? remix * 0.12 : remix);
    g = lerp(g, mixed.g, mode === "natural" ? remix * 0.12 : remix);
    b = lerp(b, mixed.b, mode === "natural" ? remix * 0.12 : remix);

    if (controls.poster.checked) {
      const levels = Math.max(2, Math.round(3 + remix * 9));
      r = posterize(r, levels);
      g = posterize(g, levels);
      b = posterize(b, levels);
    }

    if (controls.invert.checked) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    data[index] = clampByte(r);
    data[index + 1] = clampByte(g);
    data[index + 2] = clampByte(b);
  }
}

function readMixerValues() {
  return {
    hue: Number(controls.hue.value),
    saturation: Number(controls.saturation.value) / 100,
    contrast: Number(controls.contrast.value) / 100,
    exposure: Number(controls.exposure.value),
    remix: Number(controls.remix.value),
    red: Number(controls.red.value) / 100,
    green: Number(controls.green.value) / 100,
    blue: Number(controls.blue.value) / 100,
  };
}

function bindSlider(name) {
  return document.querySelector(`#${name}Slider`);
}

function updateSliderOutput(slider) {
  const output = document.querySelector(`#${slider.id.replace("Slider", "Value")}`);
  if (output) {
    output.value = slider.value;
    output.textContent = slider.value;
  }
}

function resetMixer() {
  for (const [key, value] of Object.entries(defaults)) {
    if (!controls[key]) continue;
    if (typeof value === "boolean") {
      controls[key].checked = value;
    } else {
      controls[key].value = value;
      updateSliderOutput(controls[key]);
    }
  }

  mode = "natural";
  modeButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.mode === mode));
}

function randomRemix() {
  const randomMode = modeButtons[Math.floor(Math.random() * modeButtons.length)];
  randomMode.click();
  setRange(controls.hue, randomInt(-150, 150));
  setRange(controls.saturation, randomInt(60, 220));
  setRange(controls.contrast, randomInt(70, 200));
  setRange(controls.exposure, randomInt(-38, 46));
  setRange(controls.remix, randomInt(35, 100));
  setRange(controls.red, randomInt(60, 190));
  setRange(controls.green, randomInt(60, 190));
  setRange(controls.blue, randomInt(60, 190));
  controls.poster.checked = Math.random() > 0.72;
  controls.invert.checked = Math.random() > 0.86;
  controls.shadow.value = randomColor(18, 90);
  controls.mid.value = randomColor(80, 210);
  controls.light.value = randomColor(150, 255);
}

function setRange(input, value) {
  input.value = value;
  updateSliderOutput(input);
}

function downloadSnapshot() {
  if (!snapshotReady) {
    setStatus("Start the camera before taking a snapshot", "idle");
    return;
  }

  const link = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.download = `camera-remix-${stamp}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function stopStream() {
  cancelAnimationFrame(frameId);

  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  stream = null;
}

function drawIdleFrame() {
  const { width, height } = resizeCanvas();
  ctx.clearRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#141414");
  gradient.addColorStop(0.42, "#10241f");
  gradient.addColorStop(1, "#301514");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(255,255,255,0.12)";
  const size = Math.max(42, Math.min(width, height) * 0.08);
  for (let y = -size; y < height + size; y += size * 1.8) {
    for (let x = -size; x < width + size; x += size * 1.8) {
      ctx.fillRect(x, y, size, size);
    }
  }
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(rect.width));
  const cssHeight = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
  let width = Math.round(cssWidth * dpr);
  let height = Math.round(cssHeight * dpr);
  const maxSide = Math.max(width, height);

  if (maxSide > 1280) {
    const scale = 1280 / maxSide;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    sourceCanvas.width = width;
    sourceCanvas.height = height;
  }

  return { width, height };
}

function drawVideoCover(targetCtx, source, width, height) {
  const sourceWidth = source.videoWidth || width;
  const sourceHeight = source.videoHeight || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const dx = (width - drawWidth) / 2;
  const dy = (height - drawHeight) / 2;
  targetCtx.drawImage(source, dx, dy, drawWidth, drawHeight);
}

function adjustHsl(r, g, b, hueShift, saturationScale) {
  const hsl = rgbToHsl(r, g, b);
  hsl.h = (hsl.h + hueShift + 360) % 360;
  hsl.s = clamp01(hsl.s * saturationScale);
  return hslToRgb(hsl.h, hsl.s, hsl.l);
}

function applyTone(value, contrast, exposure) {
  return (value - 128) * contrast + 128 + exposure;
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const delta = max - min;
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

    if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
    if (max === g) h = (b - r) / delta + 2;
    if (max === b) h = (r - g) / delta + 4;
    h *= 60;
  }

  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = h / 60;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const match = l - chroma / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (segment >= 0 && segment < 1) [r, g, b] = [chroma, x, 0];
  else if (segment < 2) [r, g, b] = [x, chroma, 0];
  else if (segment < 3) [r, g, b] = [0, chroma, x];
  else if (segment < 4) [r, g, b] = [0, x, chroma];
  else if (segment < 5) [r, g, b] = [x, 0, chroma];
  else [r, g, b] = [chroma, 0, x];

  return {
    r: (r + match) * 255,
    g: (g + match) * 255,
    b: (b + match) * 255,
  };
}

function gradientColor(amount, shadow, mid, light) {
  if (amount < 0.5) {
    return mixColor(shadow, mid, amount * 2);
  }
  return mixColor(mid, light, (amount - 0.5) * 2);
}

function thermalColor(amount, remix) {
  const deep = { r: 12, g: 19, b: 40 };
  const blue = { r: 16, g: 126, b: 255 };
  const green = { r: 0, g: 216, b: 167 };
  const yellow = { r: 255, g: 215, b: 92 };
  const red = { r: 255, g: 72, b: 72 };
  const white = { r: 255, g: 245, b: 220 };
  const pushed = clamp01(amount + (remix - 0.5) * 0.22);

  if (pushed < 0.22) return mixColor(deep, blue, pushed / 0.22);
  if (pushed < 0.46) return mixColor(blue, green, (pushed - 0.22) / 0.24);
  if (pushed < 0.68) return mixColor(green, yellow, (pushed - 0.46) / 0.22);
  if (pushed < 0.88) return mixColor(yellow, red, (pushed - 0.68) / 0.2);
  return mixColor(red, white, (pushed - 0.88) / 0.12);
}

function mixColor(a, b, amount) {
  return {
    r: lerp(a.r, b.r, amount),
    g: lerp(a.g, b.g, amount),
    b: lerp(a.b, b.b, amount),
  };
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function posterize(value, levels) {
  const step = 255 / (levels - 1);
  return Math.round(value / step) * step;
}

function setStatus(message, kind) {
  statusText.textContent = message;
  statusDot.classList.toggle("is-live", kind === "live");
  statusDot.classList.toggle("is-error", kind === "error");
}

function cameraErrorMessage(error) {
  if (error?.name === "NotAllowedError") {
    return "Camera permission was blocked";
  }

  if (error?.name === "NotFoundError") {
    return "No camera was found";
  }

  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    return "Camera needs localhost or HTTPS";
  }

  return "Could not start the camera";
}

function lerp(a, b, amount) {
  return a + (b - a) * clamp01(amount);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function clampByte(value) {
  return Math.round(Math.min(255, Math.max(0, value)));
}

function clamp255(value) {
  return Math.min(255, Math.max(0, value));
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomColor(min, max) {
  const channel = () => randomInt(min, max).toString(16).padStart(2, "0");
  return `#${channel()}${channel()}${channel()}`;
}

window.addEventListener("resize", () => {
  if (!stream) {
    drawIdleFrame();
  }
});
