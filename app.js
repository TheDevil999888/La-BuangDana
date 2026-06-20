import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import {
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";
import { firebaseSyncConfig } from "./firebase-config.js";

const DATA_URL = "./data.json";
const STORAGE_KEY = "dashboard-buang-dana-state-v2";
const SHARE_STATE_QUERY_KEY = "state";
const LIVE_SYNC_INTERVAL_MS = 10000;
const FIREBASE_SYNC_DEBOUNCE_MS = 700;
const SETTINGS_INPUT_DEBOUNCE_MS = 280;
const MAX_SHARE_STATE_PARAM_LENGTH = 1400;
const MAX_FIRESTORE_IMAGE_DATA_LENGTH = 180000;
const BACKGROUND_SLIDESHOW_TRANSITION_DURATION_MS = 3200;
const LEGACY_BACKGROUND_PRESET_MAP = {
  "stadium-night": "bg-1",
  "gold-trophy": "bg-2",
  "field-sunrise": "bg-3",
  "brazil-energy": "bg-4",
};

let liveSyncTimerId = 0;
let dashboardClockTimerId = 0;
let firebaseSyncTimerId = 0;
let settingsInputTimerId = 0;
const BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS = 10000;
const BACKGROUND_SLIDESHOW_INTERVAL_MAX_MS = 15000;
const BACKGROUND_SLIDESHOW_TRANSITIONS = [
  "fade-zoom",
  "pan-left",
  "pan-right",
  "focus-in",
  "drift-up",
  "cinematic-glide",
];
let backgroundSlideshowTimerId = 0;
let backgroundSlideshowTransitionTimerId = 0;

const firebaseRuntime = {
  app: null,
  db: null,
  docRef: null,
  unsubscribe: null,
  ready: false,
  syncInFlight: false,
  syncPromise: null,
  suppressWrites: false,
  lastPayloadSignature: "",
  clientId: globalThis.crypto?.randomUUID?.() || `client-${Date.now()}`,
};

const renderRuntime = {
  entryValueSnapshot: new Map(),
  backgroundActiveLayerId: "primary",
  backgroundRenderRequestId: 0,
  backgroundImagePreloadCache: new Map(),
};

const state = {
  data: null,
  selectedCodes: new Set(),
  selectedOptions: {},
  bankConfigs: {},
  activeSettingsBankId: "",
  selectionInitialized: false,
  liveSheet: {
    entries: [],
    loading: false,
    error: "",
    lastAppliedKey: "",
  },
  uiSettings: {
    googleSheetLink: "",
    areaCodeDisplay: "",
    sheetName: "",
    rangeBalance: "A:A",
    rangeLimit: "B:B",
    orientationMode: "auto",
    desktopImageData: "",
    desktopImageRemoteUrl: "",
    desktopImagePresetId: "",
    desktopImageFit: "fill",
    desktopSlideshowEnabled: false,
    desktopSlideshowStartedAt: 0,
    desktopSlideshowSlideIndex: 0,
    desktopSlideshowIntervalMs: BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS,
    desktopSlideshowTransitionName: BACKGROUND_SLIDESHOW_TRANSITIONS[0],
  },
};

const elements = {
  desktopBackgroundLayer: document.getElementById("desktop-background-layer"),
  desktopBackgroundLayerAlt: document.getElementById("desktop-background-layer-alt"),
  desktopBackgroundOverlay: document.getElementById("desktop-background-overlay"),
  totalReady: document.getElementById("total-ready"),
  totalAmount: document.getElementById("total-amount"),
  bankColumns: document.getElementById("bank-columns"),
  bankSelectGrid: document.getElementById("bank-select-grid"),
  bankModal: document.getElementById("bank-modal-backdrop"),
  settingsModal: document.getElementById("settings-modal-backdrop"),
  openBankModal: document.getElementById("open-bank-modal"),
  openSettingsModal: document.getElementById("open-settings-modal"),
  refreshData: document.getElementById("refresh-data"),
  applyBankSelection: document.getElementById("apply-bank-selection"),
  selectAllBanks: document.getElementById("select-all-banks"),
  deselectAllBanks: document.getElementById("deselect-all-banks"),
  sourceBankSelect: document.getElementById("source-bank-select"),
  sourceBankList: document.getElementById("source-bank-list"),
  orientationMode: document.getElementById("orientation-mode"),
  rangeStart: document.getElementById("range-start"),
  rangeEnd: document.getElementById("range-end"),
  settingsPreview: document.getElementById("settings-preview"),
  settingsForm: document.getElementById("settings-form"),
  previewRange: document.getElementById("preview-range"),
  dashboardSubtitle: document.getElementById("dashboard-subtitle"),
  sheetModeBadge: document.getElementById("sheet-mode-badge"),
  googleSheetLink: document.getElementById("google-sheet-link"),
  areaCodeDisplay: document.getElementById("area-code-display"),
  clearSettings: document.getElementById("clear-settings"),
  cancelSettings: document.getElementById("cancel-settings"),
  backgroundFitSelect: document.getElementById("background-fit-select"),
  backgroundImageInput: document.getElementById("background-image-input"),
  backgroundPasteZone: document.getElementById("background-paste-zone"),
  backgroundPresetGrid: document.getElementById("background-preset-grid"),
  backgroundPreview: document.getElementById("background-preview"),
  clearBackgroundImage: document.getElementById("clear-background-image"),
  backgroundSlideshowToggle: document.getElementById("background-slideshow-toggle"),
  firebaseSyncStatus: document.getElementById("firebase-sync-status"),
};

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

async function copyTextToClipboard(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn("Clipboard API gagal, mencoba fallback.", error);
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch (error) {
    console.error("Gagal menyalin teks.", error);
    return false;
  }
}

function showCopyFeedback(target) {
  if (!(target instanceof HTMLElement)) {
    return;
  }

  // Keep copy interaction silent and clean without extra badge/pop-up.
  if (typeof target.blur === "function") {
    target.blur();
  }
}

function formatSignedClass(value) {
  return Number(value) < 0 ? "negative" : "positive";
}

function getBalanceStatusClass(value) {
  const amount = Number(value || 0);
  if (amount < 0) {
    return "negative";
  }

  if (amount <= 1000000) {
    return "low-balance";
  }

  return "positive";
}

function updateFirebaseStatus(message) {
  if (elements.firebaseSyncStatus) {
    elements.firebaseSyncStatus.textContent = message;
  }
}

function scheduleSettingsAutoApply() {
  if (settingsInputTimerId) {
    window.clearTimeout(settingsInputTimerId);
  }

  settingsInputTimerId = window.setTimeout(() => {
    settingsInputTimerId = 0;
    void autoApplySettingsIfReady();
  }, SETTINGS_INPUT_DEBOUNCE_MS);
}

function showSaveSuccessNotice(message = "Save & Extract berhasil. Dashboard sudah diperbarui.") {
  let notice = document.querySelector(".save-success-toast");
  if (!(notice instanceof HTMLDivElement)) {
    notice = document.createElement("div");
    notice.className = "save-success-toast";
    document.body.appendChild(notice);
  }

  notice.textContent = message;
  notice.classList.remove("visible");

  const existingTimerId = Number(notice.dataset.hideTimerId || 0);
  if (existingTimerId) {
    window.clearTimeout(existingTimerId);
  }

  window.requestAnimationFrame(() => {
    notice.classList.add("visible");
  });

  const timerId = window.setTimeout(() => {
    notice.classList.remove("visible");
    delete notice.dataset.hideTimerId;
  }, 2600);

  notice.dataset.hideTimerId = String(timerId);
}

function isInspectShortcut(event) {
  const key = String(event.key || "").toLowerCase();
  return (
    key === "f12" ||
    (event.ctrlKey && event.shiftKey && ["i", "j", "c"].includes(key)) ||
    (event.ctrlKey && key === "u")
  );
}

function setupAntiTamperGuards() {
  document.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!isInspectShortcut(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
}

function isFirebaseSyncConfigured() {
  const firebaseConfig = firebaseSyncConfig?.firebaseConfig || {};
  return Boolean(
    firebaseSyncConfig?.enabled &&
      firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseSyncConfig?.firestore?.collection &&
      firebaseSyncConfig?.firestore?.documentId
  );
}

function getFirebasePayloadSignature(payload) {
  try {
    return JSON.stringify(payload || {});
  } catch (error) {
    return "";
  }
}

function applySerializedStatePayload(payload = {}) {
  state.selectedCodes = new Set(payload.selectedCodes || []);
  state.selectedOptions = payload.selectedOptions || {};
  state.bankConfigs = payload.bankConfigs || state.bankConfigs || {};
  state.activeSettingsBankId = payload.activeSettingsBankId || "";
  state.selectionInitialized = Boolean(payload.selectionInitialized);
  state.uiSettings = {
    ...state.uiSettings,
    googleSheetLink: payload.uiSettings?.googleSheetLink || "",
    areaCodeDisplay: payload.uiSettings?.areaCodeDisplay || "",
    sheetName: payload.uiSettings?.sheetName || "",
    rangeBalance: payload.uiSettings?.rangeBalance || "A:A",
    rangeLimit: payload.uiSettings?.rangeLimit || "B:B",
    orientationMode: payload.uiSettings?.orientationMode || "auto",
    desktopImageData: payload.uiSettings?.desktopImageData || "",
    desktopImageRemoteUrl: payload.uiSettings?.desktopImageRemoteUrl || "",
    desktopImagePresetId: payload.uiSettings?.desktopImagePresetId || "",
    desktopImageFit: payload.uiSettings?.desktopImageFit || "fill",
    desktopSlideshowEnabled: Boolean(payload.uiSettings?.desktopSlideshowEnabled),
    desktopSlideshowStartedAt: Number(payload.uiSettings?.desktopSlideshowStartedAt || 0),
    desktopSlideshowSlideIndex: Number(payload.uiSettings?.desktopSlideshowSlideIndex || 0),
    desktopSlideshowIntervalMs: Number(payload.uiSettings?.desktopSlideshowIntervalMs || BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS),
    desktopSlideshowTransitionName: payload.uiSettings?.desktopSlideshowTransitionName || BACKGROUND_SLIDESHOW_TRANSITIONS[0],
  };

  if (Array.isArray(payload.liveSheet?.entries)) {
    state.liveSheet.entries = payload.liveSheet.entries;
  }
  if (typeof payload.liveSheet?.lastAppliedKey === "string") {
    state.liveSheet.lastAppliedKey = payload.liveSheet.lastAppliedKey;
  }
}

function formatDashboardDate(value = new Date()) {
  const formatter = new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const parts = formatter.formatToParts(value);
  const weekday = parts.find((part) => part.type === "weekday")?.value || "";
  const day = parts.find((part) => part.type === "day")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const year = parts.find((part) => part.type === "year")?.value || "";

  return `${weekday}, ${day} - ${month} - ${year}`;
}

function formatDashboardTime(value = new Date()) {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function updateDashboardDateTime() {
  const now = new Date();
  elements.dashboardSubtitle.textContent = `${formatDashboardDate(now)} | ${formatDashboardTime(now)}`;
}

function getBackgroundLayoutByFit(mode) {
  switch (mode) {
    case "fit":
      return { size: "contain", repeat: "no-repeat", position: "center center" };
    case "stretch":
      return { size: "100% 100%", repeat: "no-repeat", position: "center center" };
    case "tile":
      return { size: "360px auto", repeat: "repeat", position: "left top" };
    case "center":
      return { size: "auto", repeat: "no-repeat", position: "center center" };
    case "span":
      return { size: "100% auto", repeat: "no-repeat", position: "center top" };
    case "fill":
    default:
      return { size: "cover", repeat: "no-repeat", position: "center center" };
  }
}

function getBackgroundPresets() {
  return Array.isArray(state.data?.backgroundPresets) ? state.data.backgroundPresets : [];
}

function getBackgroundPresetById(presetId) {
  return getBackgroundPresets().find((preset) => preset.id === presetId) || null;
}

function normalizeDesktopFitMode(mode) {
  const normalized = String(mode || "")
    .trim()
    .toLowerCase();
  const alias = normalized === "centre" ? "center" : normalized;
  const validModes = new Set(["fill", "fit", "stretch", "tile", "center", "span"]);
  return validModes.has(alias) ? alias : "fill";
}

function getPreviewImageFit(mode) {
  switch (mode) {
    case "fit":
      return "contain";
    case "stretch":
      return "100% 100%";
    case "tile":
      return "180px auto";
    case "center":
      return "auto";
    case "span":
      return "100% auto";
    case "fill":
    default:
      return "cover";
  }
}

function normalizeBackgroundSelection() {
  const presets = getBackgroundPresets();
  if (presets.length === 0) {
    return;
  }

  const currentPresetId = String(state.uiSettings.desktopImagePresetId || "").trim();
  if (!currentPresetId) {
    return;
  }

  const mappedPresetId = LEGACY_BACKGROUND_PRESET_MAP[currentPresetId] || currentPresetId;
  if (getBackgroundPresetById(mappedPresetId)) {
    state.uiSettings.desktopImagePresetId = mappedPresetId;
    return;
  }

  state.uiSettings.desktopImagePresetId = state.uiSettings.desktopImageData ? "" : presets[0].id;
}

function getPresetImageBaseName(imagePath = "") {
  const normalized = String(imagePath || "").trim();
  if (!normalized) {
    return "";
  }

  const fileName = normalized.split("/").pop()?.split("\\").pop() || "";
  return fileName.replace(/\.[^.]+$/, "");
}

function formatBackgroundPresetTitle(preset) {
  if (preset?.title) {
    return preset.title;
  }

  const baseName = getPresetImageBaseName(preset?.image);
  if (!baseName) {
    return "Background Bawaan";
  }

  return baseName
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatBackgroundPresetDescription(preset) {
  if (preset?.description) {
    return preset.description;
  }

  const title = formatBackgroundPresetTitle(preset);
  return `${title} siap dipakai sebagai gambar bawaan dashboard.`;
}

function getRandomNumber(min, max) {
  const minimum = Math.ceil(min);
  const maximum = Math.floor(max);
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

function getRandomSlideshowIntervalMs() {
  return getRandomNumber(BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS, BACKGROUND_SLIDESHOW_INTERVAL_MAX_MS);
}

function getDesktopBackgroundLayers() {
  return [elements.desktopBackgroundLayer, elements.desktopBackgroundLayerAlt].filter(
    (layer) => layer instanceof HTMLDivElement
  );
}

function initializeDesktopBackgroundLayers() {
  const [primaryLayer, secondaryLayer] = getDesktopBackgroundLayers();
  if (primaryLayer) {
    primaryLayer.dataset.layerId = "primary";
  }
  if (secondaryLayer) {
    secondaryLayer.dataset.layerId = "secondary";
  }
}

function getBackgroundLayerById(layerId) {
  const normalizedLayerId = String(layerId || "").trim();
  return (
    getDesktopBackgroundLayers().find((layer) => layer.dataset.layerId === normalizedLayerId) ||
    null
  );
}

function getActiveBackgroundLayer() {
  return (
    getBackgroundLayerById(renderRuntime.backgroundActiveLayerId) ||
    getDesktopBackgroundLayers()[0] ||
    null
  );
}

function getInactiveBackgroundLayer() {
  const activeLayer = getActiveBackgroundLayer();
  return getDesktopBackgroundLayers().find((layer) => layer !== activeLayer) || null;
}

function applyBackgroundImageToLayer(layer, imageData, layout) {
  if (!(layer instanceof HTMLDivElement)) {
    return;
  }

  layer.style.backgroundImage = imageData ? `url("${imageData}")` : "none";
  layer.style.backgroundSize = layout.size;
  layer.style.backgroundRepeat = layout.repeat;
  layer.style.backgroundPosition = layout.position;
  layer.style.backgroundAttachment = "scroll";
  layer.dataset.activeImageSrc = imageData;
}

function preloadBackgroundImage(src) {
  const normalizedSrc = String(src || "").trim();
  if (!normalizedSrc) {
    return Promise.resolve();
  }

  const cachedPromise = renderRuntime.backgroundImagePreloadCache.get(normalizedSrc);
  if (cachedPromise) {
    return cachedPromise;
  }

  const preloadPromise = new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Gagal memuat background image."));
    image.src = normalizedSrc;
    if (image.complete) {
      resolve();
    }
  }).catch((error) => {
    renderRuntime.backgroundImagePreloadCache.delete(normalizedSrc);
    throw error;
  });

  renderRuntime.backgroundImagePreloadCache.set(normalizedSrc, preloadPromise);
  return preloadPromise;
}

function normalizeSlideshowTransitionName(name) {
  return BACKGROUND_SLIDESHOW_TRANSITIONS.includes(name) ? name : BACKGROUND_SLIDESHOW_TRANSITIONS[0];
}

function pickRandomSlideshowTransition(excludeName = "") {
  const normalizedExclude = normalizeSlideshowTransitionName(excludeName);
  const candidates = BACKGROUND_SLIDESHOW_TRANSITIONS.filter((name) => name !== normalizedExclude);
  if (candidates.length === 0) {
    return BACKGROUND_SLIDESHOW_TRANSITIONS[0];
  }
  return candidates[getRandomNumber(0, candidates.length - 1)];
}

function normalizeSlideshowIntervalMs(intervalMs) {
  const normalized = Number(intervalMs || 0);
  if (normalized >= BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS && normalized <= BACKGROUND_SLIDESHOW_INTERVAL_MAX_MS) {
    return normalized;
  }
  return BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS;
}

function clearBackgroundSlideshowTransition() {
  if (backgroundSlideshowTransitionTimerId) {
    window.clearTimeout(backgroundSlideshowTransitionTimerId);
    backgroundSlideshowTransitionTimerId = 0;
  }

  getDesktopBackgroundLayers().forEach((layer) => {
    layer.classList.remove(
      "is-entering",
      "is-exiting",
      "slideshow-transition-fade-zoom",
      "slideshow-transition-pan-left",
      "slideshow-transition-pan-right",
      "slideshow-transition-focus-in",
      "slideshow-transition-drift-up",
      "slideshow-transition-cinematic-glide"
    );
  });
}

function syncBackgroundLayersImmediately(imageData, layout) {
  const layers = getDesktopBackgroundLayers();
  if (layers.length === 0) {
    return;
  }

  clearBackgroundSlideshowTransition();
  const visibleLayer = getActiveBackgroundLayer() || layers[0];
  layers.forEach((layer) => {
    applyBackgroundImageToLayer(layer, imageData, layout);
    layer.classList.toggle("is-visible", layer === visibleLayer && Boolean(imageData));
  });
  renderRuntime.backgroundActiveLayerId = visibleLayer.dataset.layerId || "primary";
}

function playBackgroundSlideshowTransition(transitionName, imageData, layout) {
  const activeLayer = getActiveBackgroundLayer();
  const inactiveLayer = getInactiveBackgroundLayer();
  if (!activeLayer || !inactiveLayer) {
    syncBackgroundLayersImmediately(imageData, layout);
    return;
  }

  const normalizedTransition = normalizeSlideshowTransitionName(transitionName);
  clearBackgroundSlideshowTransition();
  applyBackgroundImageToLayer(inactiveLayer, imageData, layout);
  inactiveLayer.classList.add("is-visible");
  void inactiveLayer.offsetWidth;
  activeLayer.classList.add("is-exiting", `slideshow-transition-${normalizedTransition}`);
  inactiveLayer.classList.add("is-entering", `slideshow-transition-${normalizedTransition}`);
  renderRuntime.backgroundActiveLayerId = inactiveLayer.dataset.layerId || "primary";

  backgroundSlideshowTransitionTimerId = window.setTimeout(() => {
    applyBackgroundImageToLayer(activeLayer, imageData, layout);
    activeLayer.classList.remove("is-visible");
    inactiveLayer.classList.add("is-visible");
    clearBackgroundSlideshowTransition();
  }, BACKGROUND_SLIDESHOW_TRANSITION_DURATION_MS);
}

function renderDesktopBackgroundImage({
  imageData,
  layout,
  shouldAnimateSlideshowTransition,
  transitionName,
}) {
  const requestId = ++renderRuntime.backgroundRenderRequestId;

  if (!imageData) {
    syncBackgroundLayersImmediately("", layout);
    return;
  }

  preloadBackgroundImage(imageData)
    .then(() => {
      if (requestId !== renderRuntime.backgroundRenderRequestId) {
        return;
      }

      if (shouldAnimateSlideshowTransition) {
        playBackgroundSlideshowTransition(transitionName, imageData, layout);
        return;
      }

      syncBackgroundLayersImmediately(imageData, layout);
    })
    .catch((error) => {
      if (requestId !== renderRuntime.backgroundRenderRequestId) {
        return;
      }

      console.warn("Background gagal dipreload, mempertahankan background sebelumnya.", error);
      updateFirebaseStatus("Background gagal dimuat. Dashboard mempertahankan background sebelumnya.");
    });
}

function syncBackgroundSlideshowState(sources = getDesktopSlideshowSources()) {
  const slideCount = sources.length;
  const normalizedIndex = slideCount > 0
    ? ((Number(state.uiSettings.desktopSlideshowSlideIndex || 0) % slideCount) + slideCount) % slideCount
    : 0;

  state.uiSettings.desktopSlideshowSlideIndex = normalizedIndex;
  state.uiSettings.desktopSlideshowStartedAt = Number(state.uiSettings.desktopSlideshowStartedAt || 0) || Date.now();
  state.uiSettings.desktopSlideshowIntervalMs = normalizeSlideshowIntervalMs(state.uiSettings.desktopSlideshowIntervalMs);
  state.uiSettings.desktopSlideshowTransitionName = normalizeSlideshowTransitionName(
    state.uiSettings.desktopSlideshowTransitionName
  );
}

function getDesktopSlideshowSources() {
  const sources = [];
  const activeOrderId = state.uiSettings.desktopImageData
    ? "custom-upload"
    : state.uiSettings.desktopImageRemoteUrl
      ? "custom-remote"
      : String(state.uiSettings.desktopImagePresetId || "").trim();

  if (state.uiSettings.desktopImageData) {
    sources.push({
      id: "custom-upload",
      src: state.uiSettings.desktopImageData,
      title: "Custom Upload",
      description: "Gambar custom dari upload atau paste ikut masuk ke slideshow otomatis.",
      isPreset: false,
    });
  } else if (state.uiSettings.desktopImageRemoteUrl) {
    sources.push({
      id: "custom-remote",
      src: state.uiSettings.desktopImageRemoteUrl,
      title: "Custom Upload",
      description: "Gambar custom lama dari sinkronisasi cloud ikut masuk ke slideshow otomatis.",
      isPreset: false,
    });
  }

  getBackgroundPresets().forEach((preset) => {
    if (!preset?.image) {
      return;
    }
    sources.push({
      id: String(preset.id || preset.image),
      src: preset.image,
      title: formatBackgroundPresetTitle(preset),
      description: formatBackgroundPresetDescription(preset),
      isPreset: true,
      presetId: preset.id,
    });
  });

  if (!activeOrderId) {
    return sources;
  }

  const activeIndex = sources.findIndex((source) => source.id === activeOrderId);
  if (activeIndex <= 0) {
    return sources;
  }

  const [activeSource] = sources.splice(activeIndex, 1);
  sources.unshift(activeSource);
  return sources;
}

function isDesktopSlideshowEnabled() {
  return Boolean(state.uiSettings.desktopSlideshowEnabled);
}

function getActiveSlideshowImage() {
  if (!isDesktopSlideshowEnabled()) {
    return null;
  }

  const sources = getDesktopSlideshowSources();
  if (sources.length === 0) {
    return null;
  }

  syncBackgroundSlideshowState(sources);
  const index = state.uiSettings.desktopSlideshowSlideIndex;
  return {
    ...sources[index],
    slideIndex: index + 1,
    slideCount: sources.length,
  };
}

function getActiveDesktopImage() {
  const slideshowImage = getActiveSlideshowImage();
  if (slideshowImage) {
    return {
      src: slideshowImage.src,
      title: `Slideshow ${slideshowImage.slideIndex}/${slideshowImage.slideCount}`,
      description: `${slideshowImage.title} aktif otomatis tiap 10-15 detik dengan efek transisi acak.`,
      isPreset: slideshowImage.isPreset,
    };
  }

  const preset = getBackgroundPresetById(state.uiSettings.desktopImagePresetId);
  if (preset?.image) {
    return {
      src: preset.image,
      title: formatBackgroundPresetTitle(preset),
      description: formatBackgroundPresetDescription(preset),
      isPreset: true,
    };
  }

  if (state.uiSettings.desktopImageRemoteUrl) {
    return {
      src: state.uiSettings.desktopImageRemoteUrl,
      title: "Desktop Image Ready",
      description: "Custom background aktif dari sinkronisasi cloud lama.",
      isPreset: false,
    };
  }

  if (state.uiSettings.desktopImageData) {
    return {
      src: state.uiSettings.desktopImageData,
      title: "Desktop Image Ready",
      description: "Custom background aktif dari upload atau paste, tersimpan langsung ke Firestore.",
      isPreset: false,
    };
  }

  return null;
}

function renderBackgroundPresetGallery() {
  if (!elements.backgroundPresetGrid) {
    return;
  }

  const presets = getBackgroundPresets();
  if (presets.length === 0) {
    elements.backgroundPresetGrid.innerHTML =
      '<div class="empty-column">Belum ada background preset bawaan yang tersedia.</div>';
    return;
  }

  const slideshowImage = getActiveSlideshowImage();
  const activePresetId = slideshowImage?.isPreset
    ? slideshowImage.presetId || ""
    : state.uiSettings.desktopImagePresetId || "";
  elements.backgroundPresetGrid.innerHTML = presets
    .map(
      (preset) => `
        <button
          class="background-preset-card ${activePresetId === preset.id ? "active" : ""}"
          data-preset-id="${escapeHtml(preset.id)}"
          type="button"
        >
          <img
            class="background-preset-thumb"
            src="${escapeHtml(preset.image)}"
            alt="${escapeHtml(formatBackgroundPresetTitle(preset))}"
          />
          <span class="background-preset-name">${escapeHtml(formatBackgroundPresetTitle(preset))}</span>
          <span class="background-preset-desc">${escapeHtml(formatBackgroundPresetDescription(preset))}</span>
        </button>
      `
    )
    .join("");
}

function updateBackgroundSlideshowButton() {
  if (!elements.backgroundSlideshowToggle) {
    return;
  }

  const enabled = isDesktopSlideshowEnabled();
  elements.backgroundSlideshowToggle.textContent = enabled ? "Slideshow On" : "Slideshow Off";
  elements.backgroundSlideshowToggle.classList.toggle("active", enabled);
}

function stopBackgroundSlideshow() {
  if (backgroundSlideshowTimerId) {
    window.clearTimeout(backgroundSlideshowTimerId);
    backgroundSlideshowTimerId = 0;
  }
}

function advanceBackgroundSlideshow() {
  const sources = getDesktopSlideshowSources();
  if (!isDesktopSlideshowEnabled() || sources.length === 0) {
    stopBackgroundSlideshow();
    return;
  }

  syncBackgroundSlideshowState(sources);
  if (sources.length > 1) {
    state.uiSettings.desktopSlideshowSlideIndex =
      (state.uiSettings.desktopSlideshowSlideIndex + 1) % sources.length;
  }
  state.uiSettings.desktopSlideshowStartedAt = Date.now();
  state.uiSettings.desktopSlideshowIntervalMs = getRandomSlideshowIntervalMs();
  state.uiSettings.desktopSlideshowTransitionName = pickRandomSlideshowTransition(
    state.uiSettings.desktopSlideshowTransitionName
  );
  applyDesktopBackground();
  persistState();
}

function syncBackgroundSlideshowRuntime() {
  stopBackgroundSlideshow();

  if (!isDesktopSlideshowEnabled()) {
    updateBackgroundSlideshowButton();
    return;
  }

  const sources = getDesktopSlideshowSources();
  if (sources.length === 0) {
    state.uiSettings.desktopSlideshowEnabled = false;
    state.uiSettings.desktopSlideshowStartedAt = 0;
    state.uiSettings.desktopSlideshowSlideIndex = 0;
    state.uiSettings.desktopSlideshowIntervalMs = BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS;
    state.uiSettings.desktopSlideshowTransitionName = BACKGROUND_SLIDESHOW_TRANSITIONS[0];
    updateBackgroundSlideshowButton();
    return;
  }

  syncBackgroundSlideshowState(sources);
  if (sources.length <= 1) {
    updateBackgroundSlideshowButton();
    return;
  }

  const startedAt = Number(state.uiSettings.desktopSlideshowStartedAt || Date.now());
  const intervalMs = normalizeSlideshowIntervalMs(state.uiSettings.desktopSlideshowIntervalMs);
  const elapsed = Math.max(0, Date.now() - startedAt);
  const nextDelay = Math.max(80, intervalMs - elapsed);

  if (elapsed >= intervalMs) {
    backgroundSlideshowTimerId = window.setTimeout(() => {
      backgroundSlideshowTimerId = 0;
      advanceBackgroundSlideshow();
    }, 80);
    updateBackgroundSlideshowButton();
    return;
  }

  backgroundSlideshowTimerId = window.setTimeout(() => {
    backgroundSlideshowTimerId = 0;
    advanceBackgroundSlideshow();
  }, nextDelay);

  updateBackgroundSlideshowButton();
}

function applyDesktopBackground() {
  state.uiSettings.desktopImageFit = normalizeDesktopFitMode(state.uiSettings.desktopImageFit);
  normalizeBackgroundSelection();
  initializeDesktopBackgroundLayers();

  const activeImage = getActiveDesktopImage();
  const imageData = activeImage?.src || "";
  const fit = normalizeDesktopFitMode(state.uiSettings.desktopImageFit);
  const layout = getBackgroundLayoutByFit(fit);
  const previousImageData = getActiveBackgroundLayer()?.dataset.activeImageSrc || "";

  document.documentElement.style.setProperty("--desktop-image", imageData ? `url("${imageData}")` : "none");
  document.documentElement.style.setProperty("--desktop-image-size", layout.size);
  document.documentElement.style.setProperty("--desktop-image-repeat", layout.repeat);
  document.documentElement.style.setProperty("--desktop-image-position", layout.position);
  document.documentElement.style.setProperty("--desktop-overlay-opacity", imageData ? "0.08" : "1");
  document.documentElement.dataset.desktopImageActive = imageData ? "true" : "false";

  const shouldAnimateSlideshowTransition = Boolean(
    imageData &&
      previousImageData &&
      imageData !== previousImageData &&
      isDesktopSlideshowEnabled() &&
      getDesktopBackgroundLayers().length > 1
  );

  renderDesktopBackgroundImage({
    imageData,
    layout,
    shouldAnimateSlideshowTransition,
    transitionName: state.uiSettings.desktopSlideshowTransitionName,
  });

  if (elements.desktopBackgroundOverlay) {
    elements.desktopBackgroundOverlay.style.opacity = imageData ? "0.08" : "1";
  }

  if (elements.backgroundFitSelect) {
    elements.backgroundFitSelect.value = fit;
  }

  if (elements.backgroundPreview) {
    if (activeImage) {
      elements.backgroundPreview.innerHTML = `
        <div
          class="background-preview-image"
          aria-label="Desktop background preview"
          style="
            background-image:url('${activeImage.src}');
            background-size:${getPreviewImageFit(fit)};
            background-repeat:${layout.repeat};
            background-position:${layout.position};
          "
        ></div>
        <div class="background-preview-meta">
          <strong>${escapeHtml(activeImage.title)}</strong>
          <span>Fit mode: ${fit.toUpperCase()}</span>
          <span>${isDesktopSlideshowEnabled() ? "Slideshow: ON | Auto change every 10-15 seconds" : "Slideshow: OFF"}</span>
          <span>${escapeHtml(activeImage.description)}</span>
        </div>
      `;
    } else {
      elements.backgroundPreview.textContent = "No desktop image selected.";
    }
  }

  renderBackgroundPresetGallery();
  updateBackgroundSlideshowButton();
  if (!isDesktopSlideshowEnabled()) {
    clearBackgroundSlideshowTransition();
  }
  syncBackgroundSlideshowRuntime();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Gagal membaca file gambar."));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Gagal memuat gambar untuk proses kompres."));
    image.src = src;
  });
}

function drawCompressedImageDataUrl(image, {
  mimeType = "image/jpeg",
  quality = 0.72,
  maxWidth = 1600,
  maxHeight = 900,
} = {}) {
  const widthRatio = maxWidth / image.naturalWidth;
  const heightRatio = maxHeight / image.naturalHeight;
  const scale = Math.min(1, widthRatio, heightRatio);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas tidak tersedia untuk kompres gambar.");
  }

  // Gunakan latar gelap agar gambar PNG transparan tetap aman saat dikompres ke JPEG.
  context.fillStyle = "#040c23";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(mimeType, quality);
}

async function compressImageDataUrlForFirestore(dataUrl) {
  const normalized = String(dataUrl || "");
  if (!normalized.startsWith("data:image/")) {
    return normalized;
  }

  if (normalized.length <= MAX_FIRESTORE_IMAGE_DATA_LENGTH) {
    return normalized;
  }

  const image = await loadImageElement(normalized);
  const attempts = [
    { maxWidth: 1600, maxHeight: 900, quality: 0.82 },
    { maxWidth: 1366, maxHeight: 768, quality: 0.72 },
    { maxWidth: 1280, maxHeight: 720, quality: 0.62 },
    { maxWidth: 1024, maxHeight: 576, quality: 0.52 },
    { maxWidth: 860, maxHeight: 484, quality: 0.44 },
    { maxWidth: 720, maxHeight: 405, quality: 0.36 },
    { maxWidth: 640, maxHeight: 360, quality: 0.3 },
  ];

  let bestCandidate = normalized;
  for (const attempt of attempts) {
    const candidate = drawCompressedImageDataUrl(image, attempt);
    if (candidate.length < bestCandidate.length) {
      bestCandidate = candidate;
    }
    if (candidate.length <= MAX_FIRESTORE_IMAGE_DATA_LENGTH) {
      return candidate;
    }
  }

  if (bestCandidate.length <= MAX_FIRESTORE_IMAGE_DATA_LENGTH) {
    return bestCandidate;
  }

  throw new Error("Ukuran gambar masih terlalu besar untuk sinkronisasi gratis. Coba gambar lain atau crop lebih kecil.");
}

async function applyDesktopImageFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    return;
  }

  updateFirebaseStatus("Gambar background diproses. Klik Save & Extract untuk menyimpan dan sync ke semua tempat.");
  const imageData = await readFileAsDataUrl(file);
  const compressedImageData = await compressImageDataUrlForFirestore(imageData);
  state.uiSettings.desktopImageData = compressedImageData;
  state.uiSettings.desktopImageRemoteUrl = "";
  state.uiSettings.desktopImagePresetId = "";
  if (isDesktopSlideshowEnabled()) {
    state.uiSettings.desktopSlideshowSlideIndex = 0;
    state.uiSettings.desktopSlideshowStartedAt = Date.now();
    state.uiSettings.desktopSlideshowIntervalMs = getRandomSlideshowIntervalMs();
    state.uiSettings.desktopSlideshowTransitionName = pickRandomSlideshowTransition(
      state.uiSettings.desktopSlideshowTransitionName
    );
  }
  applyDesktopBackground();
  persistState();
}

function applyDesktopImagePreset(presetId) {
  const preset = getBackgroundPresetById(presetId);
  if (!preset) {
    return;
  }

  state.uiSettings.desktopImagePresetId = preset.id;
  state.uiSettings.desktopImageData = "";
  state.uiSettings.desktopImageRemoteUrl = "";
  if (isDesktopSlideshowEnabled()) {
    state.uiSettings.desktopSlideshowSlideIndex = 0;
    state.uiSettings.desktopSlideshowStartedAt = Date.now();
    state.uiSettings.desktopSlideshowIntervalMs = getRandomSlideshowIntervalMs();
    state.uiSettings.desktopSlideshowTransitionName = pickRandomSlideshowTransition(
      state.uiSettings.desktopSlideshowTransitionName
    );
  }
  applyDesktopBackground();
  persistState();
}

function getClipboardImageFile(event) {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.type.startsWith("image/"));
  return imageItem?.getAsFile() || null;
}

async function handleBackgroundPaste(event) {
  const imageFile = getClipboardImageFile(event);
  if (!imageFile) {
    return;
  }

  event.preventDefault();

  try {
    await applyDesktopImageFile(imageFile);
  } catch (error) {
    console.error("Gagal menempel gambar background.", error);
  }
}

function clearDesktopBackground() {
  state.uiSettings.desktopImageData = "";
  state.uiSettings.desktopImageRemoteUrl = "";
  state.uiSettings.desktopImagePresetId = "";
  state.uiSettings.desktopSlideshowEnabled = false;
  state.uiSettings.desktopSlideshowStartedAt = 0;
  state.uiSettings.desktopSlideshowSlideIndex = 0;
  state.uiSettings.desktopSlideshowIntervalMs = BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS;
  state.uiSettings.desktopSlideshowTransitionName = BACKGROUND_SLIDESHOW_TRANSITIONS[0];
  applyDesktopBackground();
  persistState();

  if (elements.backgroundImageInput) {
    elements.backgroundImageInput.value = "";
  }
}

function startDashboardClock() {
  if (dashboardClockTimerId) {
    window.clearInterval(dashboardClockTimerId);
  }

  updateDashboardDateTime();
  dashboardClockTimerId = window.setInterval(updateDashboardDateTime, 1000);
}

function loadPersistedState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }

    const persisted = JSON.parse(raw);
    applySerializedStatePayload(persisted);
  } catch (error) {
    console.warn("Gagal memuat state tersimpan.", error);
  }
}

function encodeShareState(payload) {
  try {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  } catch (error) {
    console.warn("Gagal meng-encode share state.", error);
    return "";
  }
}

function decodeShareState(value) {
  try {
    const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const binary = atob(normalized + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    console.warn("Gagal membaca share state dari URL.", error);
    return null;
  }
}

function buildShareableStatePayload() {
  const hasCustomDesktopImage = Boolean(state.uiSettings.desktopImageData);
  return {
    selectedCodes: [...state.selectedCodes],
    selectedOptions: state.selectedOptions,
    selectionInitialized: state.selectionInitialized,
    uiSettings: {
      googleSheetLink: state.uiSettings.googleSheetLink || "",
      areaCodeDisplay: state.uiSettings.areaCodeDisplay || "",
      sheetName: state.uiSettings.sheetName || "",
      rangeBalance: state.uiSettings.rangeBalance || "A:A",
      rangeLimit: state.uiSettings.rangeLimit || "B:B",
      orientationMode: state.uiSettings.orientationMode || "auto",
      desktopImagePresetId: hasCustomDesktopImage ? "" : state.uiSettings.desktopImagePresetId || "",
      desktopImageFit: state.uiSettings.desktopImageFit || "fill",
      desktopSlideshowEnabled: Boolean(state.uiSettings.desktopSlideshowEnabled),
      desktopSlideshowStartedAt: Number(state.uiSettings.desktopSlideshowStartedAt || 0),
      desktopSlideshowSlideIndex: Number(state.uiSettings.desktopSlideshowSlideIndex || 0),
      desktopSlideshowIntervalMs: Number(state.uiSettings.desktopSlideshowIntervalMs || BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS),
      desktopSlideshowTransitionName: state.uiSettings.desktopSlideshowTransitionName || BACKGROUND_SLIDESHOW_TRANSITIONS[0],
    },
  };
}

function hasMeaningfulShareableState(payload) {
  return Boolean(
    payload.uiSettings.googleSheetLink ||
      payload.uiSettings.sheetName ||
      payload.uiSettings.areaCodeDisplay ||
      payload.selectedCodes.length > 0 ||
      payload.uiSettings.desktopImagePresetId
  );
}

function clearShareStateFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(SHARE_STATE_QUERY_KEY)) {
      return;
    }

    url.searchParams.delete(SHARE_STATE_QUERY_KEY);
    window.history.replaceState({}, "", url.toString());
  } catch (error) {
    console.warn("Gagal membersihkan share state dari URL.", error);
  }
}

function syncShareStateToUrl() {
  try {
    if (isFirebaseSyncConfigured()) {
      clearShareStateFromUrl();
      return;
    }

    const url = new URL(window.location.href);
    const payload = buildShareableStatePayload();

    if (!hasMeaningfulShareableState(payload)) {
      url.searchParams.delete(SHARE_STATE_QUERY_KEY);
      window.history.replaceState({}, "", url.toString());
      return;
    }

    const encoded = encodeShareState(payload);
    if (!encoded) {
      return;
    }

    if (encoded.length > MAX_SHARE_STATE_PARAM_LENGTH) {
      clearShareStateFromUrl();
      return;
    }

    url.searchParams.set(SHARE_STATE_QUERY_KEY, encoded);
    window.history.replaceState({}, "", url.toString());
  } catch (error) {
    console.warn("Gagal menyinkronkan share state ke URL.", error);
  }
}

function loadSharedStateFromUrl() {
  try {
    const url = new URL(window.location.href);
    const encoded = url.searchParams.get(SHARE_STATE_QUERY_KEY);
    if (!encoded) {
      return;
    }

    const shared = decodeShareState(encoded);
    if (!shared) {
      clearShareStateFromUrl();
      return;
    }

    applySerializedStatePayload(shared);
    if (isFirebaseSyncConfigured() || encoded.length > MAX_SHARE_STATE_PARAM_LENGTH) {
      clearShareStateFromUrl();
    }
  } catch (error) {
    console.warn("Gagal memuat share state dari URL.", error);
  }
}

function buildFirebaseStatePayload() {
  return {
    selectedCodes: [...state.selectedCodes],
    selectedOptions: state.selectedOptions,
    bankConfigs: state.bankConfigs,
    activeSettingsBankId: state.activeSettingsBankId,
    selectionInitialized: state.selectionInitialized,
    uiSettings: {
      googleSheetLink: state.uiSettings.googleSheetLink || "",
      areaCodeDisplay: state.uiSettings.areaCodeDisplay || "",
      sheetName: state.uiSettings.sheetName || "",
      rangeBalance: state.uiSettings.rangeBalance || "A:A",
      rangeLimit: state.uiSettings.rangeLimit || "B:B",
      orientationMode: state.uiSettings.orientationMode || "auto",
      desktopImageData: state.uiSettings.desktopImageData || "",
      desktopImageRemoteUrl: "",
      desktopImagePresetId: state.uiSettings.desktopImagePresetId || "",
      desktopImageFit: state.uiSettings.desktopImageFit || "fill",
      desktopSlideshowEnabled: Boolean(state.uiSettings.desktopSlideshowEnabled),
      desktopSlideshowStartedAt: Number(state.uiSettings.desktopSlideshowStartedAt || 0),
      desktopSlideshowSlideIndex: Number(state.uiSettings.desktopSlideshowSlideIndex || 0),
      desktopSlideshowIntervalMs: Number(state.uiSettings.desktopSlideshowIntervalMs || BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS),
      desktopSlideshowTransitionName: state.uiSettings.desktopSlideshowTransitionName || BACKGROUND_SLIDESHOW_TRANSITIONS[0],
    },
    liveSheet: {
      entries: Array.isArray(state.liveSheet.entries) ? state.liveSheet.entries : [],
      lastAppliedKey: state.liveSheet.lastAppliedKey || "",
    },
  };
}

function scheduleFirebaseSync() {
  if (!firebaseRuntime.ready || firebaseRuntime.suppressWrites) {
    return;
  }

  if (firebaseSyncTimerId) {
    window.clearTimeout(firebaseSyncTimerId);
  }

  firebaseSyncTimerId = window.setTimeout(() => {
    firebaseSyncTimerId = 0;
    void syncStateToFirebaseNow();
  }, FIREBASE_SYNC_DEBOUNCE_MS);
}

async function flushFirebaseSync() {
  if (!firebaseRuntime.ready || firebaseRuntime.suppressWrites) {
    return true;
  }

  if (firebaseSyncTimerId) {
    window.clearTimeout(firebaseSyncTimerId);
    firebaseSyncTimerId = 0;
  }

  await syncStateToFirebaseNow();
  return true;
}

async function syncStateToFirebaseNow() {
  if (!firebaseRuntime.ready || !firebaseRuntime.docRef || firebaseRuntime.suppressWrites || firebaseRuntime.syncInFlight) {
    if (firebaseRuntime.syncPromise) {
      await firebaseRuntime.syncPromise;
    }
    return;
  }

  const payload = buildFirebaseStatePayload();
  const signature = getFirebasePayloadSignature(payload);
  if (signature && firebaseRuntime.lastPayloadSignature === signature) {
    return;
  }

  firebaseRuntime.syncInFlight = true;
  firebaseRuntime.syncPromise = (async () => {
    try {
      await setDoc(
        firebaseRuntime.docRef,
        {
          version: 1,
          updatedAt: serverTimestamp(),
          updatedBy: firebaseRuntime.clientId,
          payload,
        },
        { merge: true }
      );
      firebaseRuntime.lastPayloadSignature = signature;
      updateFirebaseStatus("Firebase Sync aktif. Semua tempat akan mengikuti perubahan terbaru.");
    } catch (error) {
      console.error("Gagal menyimpan data ke Firebase.", error);
      updateFirebaseStatus(
        "Firebase Sync gagal menyimpan data. Periksa Firestore rules atau kecilkan gambar custom yang diupload."
      );
    } finally {
      firebaseRuntime.syncInFlight = false;
      firebaseRuntime.syncPromise = null;
    }
  })();

  await firebaseRuntime.syncPromise;
}

async function applyRemoteFirebasePayload(payload) {
  if (!payload) {
    return;
  }

  const signature = getFirebasePayloadSignature(payload);
  if (signature && firebaseRuntime.lastPayloadSignature === signature) {
    return;
  }

  firebaseRuntime.suppressWrites = true;
  firebaseRuntime.lastPayloadSignature = signature;

  try {
    applySerializedStatePayload(payload);
    syncUiSettingsToForm();
    applyDesktopBackground();
    persistState();

    if (!state.data) {
      return;
    }

    normalizePersistedSelections();
    renderBankSelectionModal();
    updateSheetBadge();
    updateSettingsPreview();

    if (isLiveSheetReady()) {
      await syncLiveSheetEntries();
    } else {
      renderBanks();
    }

    updateFirebaseStatus("Firebase Sync aktif. Data cloud terbaru sudah dimuat.");
  } finally {
    firebaseRuntime.suppressWrites = false;
  }
}

async function initializeFirebaseSync() {
  if (!isFirebaseSyncConfigured()) {
    updateFirebaseStatus("Firebase Sync nonaktif. Isi `firebase-config.js` untuk mengaktifkan sinkronisasi global.");
    return;
  }

  try {
    const app = getApps()[0] || initializeApp(firebaseSyncConfig.firebaseConfig, firebaseSyncConfig.appName || "dashboard-buang-dana");
    firebaseRuntime.app = app;
    firebaseRuntime.db = getFirestore(app);
    firebaseRuntime.docRef = doc(
      firebaseRuntime.db,
      firebaseSyncConfig.firestore.collection,
      firebaseSyncConfig.firestore.documentId
    );
    firebaseRuntime.ready = true;
    updateFirebaseStatus("Firebase Sync aktif. Menghubungkan dashboard ke cloud...");

    const snapshot = await getDoc(firebaseRuntime.docRef);
    if (snapshot.exists()) {
      await applyRemoteFirebasePayload(snapshot.data()?.payload);
    } else {
      await syncStateToFirebaseNow();
    }

    if (firebaseRuntime.unsubscribe) {
      firebaseRuntime.unsubscribe();
    }

    firebaseRuntime.unsubscribe = onSnapshot(
      firebaseRuntime.docRef,
      (docSnapshot) => {
        if (!docSnapshot.exists()) {
          return;
        }

        const remoteData = docSnapshot.data();
        if (remoteData?.updatedBy === firebaseRuntime.clientId) {
          return;
        }

        void applyRemoteFirebasePayload(remoteData?.payload);
      },
      (error) => {
        console.error("Realtime Firebase sync error.", error);
        updateFirebaseStatus("Firebase Sync realtime terputus. Periksa koneksi atau Firestore rules.");
      }
    );
  } catch (error) {
    console.error("Gagal menginisialisasi Firebase.", error);
    updateFirebaseStatus("Firebase Sync gagal aktif. Periksa `firebase-config.js` dan Firestore rules.");
  }
}

function persistState() {
  try {
    const payload = {
      selectedCodes: [...state.selectedCodes],
      selectedOptions: state.selectedOptions,
      bankConfigs: state.bankConfigs,
      activeSettingsBankId: state.activeSettingsBankId,
      selectionInitialized: state.selectionInitialized,
      uiSettings: state.uiSettings,
      liveSheet: {
        entries: state.liveSheet.entries,
        lastAppliedKey: state.liveSheet.lastAppliedKey,
      },
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    syncShareStateToUrl();
    scheduleFirebaseSync();
  } catch (error) {
    console.warn("Gagal menyimpan state dashboard.", error);
  }
}

function clearPersistedState() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    syncShareStateToUrl();
    scheduleFirebaseSync();
  } catch (error) {
    console.warn("Gagal menghapus state dashboard.", error);
  }
}

function isA1Range(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return /^[A-Z]+(?:\d+)?(?::[A-Z]+(?:\d+)?)?$/.test(normalized);
}

function isGoogleSheetUrl(value) {
  return /docs\.google\.com\/spreadsheets\/d\//i.test(String(value || "").trim());
}

function isLiveSheetReady() {
  return (
    isGoogleSheetUrl(elements.googleSheetLink.value) &&
    String(elements.sourceBankSelect.value || "").trim() !== "" &&
    isA1Range(elements.areaCodeDisplay.value) &&
    isA1Range(elements.rangeStart.value) &&
    isA1Range(elements.rangeEnd.value)
  );
}

function hasLiveSheetInput() {
  return Boolean(String(elements.googleSheetLink.value || state.uiSettings.googleSheetLink || "").trim());
}

function shouldUseLiveSheet() {
  return isLiveSheetReady() || state.liveSheet.entries.length > 0 || Boolean(state.liveSheet.error);
}

function extractSpreadsheetId(url) {
  const value = String(url || "").trim();
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/i);
  return match?.[1] || "";
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let insideQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (insideQuotes && next === '"') {
        field += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function flattenMatrix(matrix) {
  return matrix.flat().map((value) => String(value ?? "").trim());
}

function parseSheetNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return 0;
  }

  const negative = text.includes("-");
  const digits = text.replace(/[^\d]/g, "");
  const number = Number(digits || 0);
  return negative ? number * -1 : number;
}

function syncUiSettingsFromForm() {
  state.uiSettings.googleSheetLink = elements.googleSheetLink.value;
  state.uiSettings.areaCodeDisplay = elements.areaCodeDisplay.value;
  state.uiSettings.sheetName = elements.sourceBankSelect.value;
  state.uiSettings.rangeBalance = elements.rangeStart.value;
  state.uiSettings.rangeLimit = elements.rangeEnd.value;
  state.uiSettings.orientationMode = elements.orientationMode.value;
  state.uiSettings.desktopImageFit = normalizeDesktopFitMode(
    elements.backgroundFitSelect?.value || state.uiSettings.desktopImageFit
  );
}

function syncUiSettingsToForm() {
  elements.googleSheetLink.value = state.uiSettings.googleSheetLink;
  elements.sourceBankSelect.value = state.uiSettings.sheetName;
  elements.areaCodeDisplay.value = state.uiSettings.areaCodeDisplay;
  elements.orientationMode.value = state.uiSettings.orientationMode || "auto";
  elements.rangeStart.value = state.uiSettings.rangeBalance || "A:A";
  elements.rangeEnd.value = state.uiSettings.rangeLimit || "B:B";
  if (elements.backgroundFitSelect) {
    elements.backgroundFitSelect.value = normalizeDesktopFitMode(state.uiSettings.desktopImageFit);
  }
  updateBackgroundSlideshowButton();
}

async function fetchGoogleSheetRange(spreadsheetId, sheetName, range) {
  const url =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&range=${encodeURIComponent(range)}`;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Gagal ambil range ${range}: ${response.status}`);
  }

  const text = await response.text();
  return parseCsv(text);
}

function buildEntriesFromLiveRanges(areaRows, balanceRows, limitRows) {
  const areaValues = flattenMatrix(areaRows);
  const balanceValues = flattenMatrix(balanceRows);
  const limitValues = flattenMatrix(limitRows);
  const maxLength = Math.max(areaValues.length, balanceValues.length, limitValues.length);
  const entries = [];

  for (let index = 0; index < maxLength; index += 1) {
    const code = areaValues[index] || "";
    if (!code) {
      continue;
    }

    entries.push({
      code,
      amount: parseSheetNumber(balanceValues[index]),
      limit: parseSheetNumber(limitValues[index]),
    });
  }

  return entries;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function detectOrientation(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "vertical";
  }

  if (rows.length <= 3 && Array.isArray(rows[0]) && rows[0].length > 1) {
    return "horizontal";
  }

  return "vertical";
}

function normalizeRows(rows, mode) {
  const effectiveMode = mode === "auto" ? detectOrientation(rows) : mode;

  if (effectiveMode === "horizontal") {
    const codes = rows[0] || [];
    const amounts = rows[1] || [];
    const limits = rows[2] || [];

    return codes
      .map((code, index) => ({
        code: String(code || "").trim(),
        amount: Number(amounts[index] || 0),
        limit: Number(limits[index] || 0),
      }))
      .filter((item) => item.code);
  }

  return rows
    .map((row) => ({
      code: String(row?.[0] || "").trim(),
      amount: Number(row?.[1] || 0),
      limit: Number(row?.[2] || 0),
    }))
    .filter((item) => item.code);
}

function getBankConfig(bank) {
  return (
    state.bankConfigs[bank.id] || {
      orientation: "auto",
      rangeStart: 0,
      rangeEnd: getSourceLength(bank.sourceKey) - 1,
    }
  );
}

function getSourceLength(sourceKey) {
  const source = state.data?.sheetSources?.[sourceKey];
  const rows = source?.rows || [];
  return Math.max(0, normalizeRows(rows, source?.orientation || "auto").length);
}

function getNormalizedSourceEntries(sourceKey) {
  const source = state.data.sheetSources[sourceKey];
  const matchingBank = state.data.banks.find((bank) => bank.sourceKey === sourceKey);
  const config = matchingBank
    ? getBankConfig(matchingBank)
    : {
        orientation: "auto",
        rangeStart: 0,
        rangeEnd: Math.max(0, getSourceLength(sourceKey) - 1),
      };
  const sourceMode = config.orientation || "auto";
  const normalized = normalizeRows(source?.rows || [], sourceMode);
  const start = Math.max(0, Number(config.rangeStart || 0));
  const end = Math.max(start, Number(config.rangeEnd || normalized.length - 1));
  const sliced = normalized.slice(start, end + 1);

  return sliced;
}

function getEntryLookup() {
  const lookup = new Map();

  if (shouldUseLiveSheet()) {
    state.liveSheet.entries.forEach((entry) => {
      if (!lookup.has(entry.code)) {
        lookup.set(entry.code, entry);
      }
    });
    return lookup;
  }

  Object.keys(state.data.sheetSources || {}).forEach((sourceKey) => {
    getNormalizedSourceEntries(sourceKey).forEach((entry) => {
      if (!lookup.has(entry.code)) {
        lookup.set(entry.code, entry);
      }
    });
  });

  return lookup;
}

function getDefaultOption(item) {
  return item.bankOptions?.[0] || "";
}

function getConfiguredOptionsForCode(code) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  const matched = (state.data?.bankSelectionOptions || []).find(
    (item) => String(item.code || "").trim().toUpperCase() === normalizedCode
  );
  return matched ? [...new Set(matched.bankOptions || [])] : [];
}

function getPresetOptionsForCode(code, fallbackBankName = "") {
  const normalizedCode = String(code || "").toUpperCase();
  const hasBankPrefix = (prefix) => new RegExp(`^${prefix}(?:[_\\-\\s]|$)`).test(normalizedCode);

  if (hasBankPrefix("BCA")) {
    return ["Tarik BCA", "Tarik Dana", "Tarik Gopay"];
  }

  if (hasBankPrefix("BRI")) {
    return ["Tarik BRI", "Tarik SEABANK", "Tarik BSI", "Tarik JAGO", "Tarik Dana"];
  }

  if (hasBankPrefix("BNI")) {
    return ["BNI", "Tarik Dana", "Tarik Linkaja", "Tarik Ovo", "Tarik Gopay"];
  }

  if (hasBankPrefix("MANDIRI")) {
    return ["Mandiri"];
  }

  if (hasBankPrefix("CIMB")) {
    return ["Tarik E-wallet"];
  }

  if (hasBankPrefix("DANAMON")) {
    return ["Danamon", "Tarik SEABANK", "Tarik BSI", "Tarik JAGO"];
  }

  const configuredOptions = getConfiguredOptionsForCode(code);
  if (configuredOptions.length > 0) {
    return configuredOptions;
  }

  return fallbackBankName ? [fallbackBankName] : [];
}

function getSelectedOptionForCode(code, bankOptions = []) {
  const savedOption = state.selectedOptions[code];
  if (savedOption && bankOptions.includes(savedOption)) {
    return savedOption;
  }

  return bankOptions[0] || "";
}

function getTargetColumnName(option) {
  return state.data.optionColumnMap?.[option] || option;
}

function getColumnEntries(bankName, entryLookup, selectableCodeMap) {
  const entries = [];

  state.selectedCodes.forEach((code) => {
    const item = selectableCodeMap.get(code);
    const option = getSelectedOptionForCode(code, item?.bankOptions || []);
    const targetColumn = getTargetColumnName(option);
    if (targetColumn !== bankName) {
      return;
    }

    const entry = entryLookup.get(code);
    if (entry) {
      entries.push(entry);
    }
  });

  return entries;
}

function computeSummary(columnEntries) {
  const allEntries = columnEntries.flatMap((item) => item.entries);
  const totalAmount = allEntries.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalReady = allEntries.length;
  return { totalAmount, totalReady };
}

function getEntryMetricSnapshotKey(bankName, code, field) {
  return `${bankName}::${code}::${field}`;
}

function getEntryMetricChangeClass(bankName, entry, field) {
  const nextValue = Number(entry?.[field] || 0);
  const snapshotKey = getEntryMetricSnapshotKey(bankName, entry.code, field);
  const previousValue = renderRuntime.entryValueSnapshot.get(snapshotKey);

  if (typeof previousValue !== "number" || previousValue === nextValue) {
    return "";
  }

  return nextValue > previousValue ? "metric-updated metric-updated-up" : "metric-updated metric-updated-down";
}

function updateEntryValueSnapshot(columnEntries) {
  const nextSnapshot = new Map();

  columnEntries.forEach(({ bank, entries }) => {
    entries.forEach((entry) => {
      nextSnapshot.set(getEntryMetricSnapshotKey(bank.name, entry.code, "limit"), Number(entry.limit || 0));
      nextSnapshot.set(getEntryMetricSnapshotKey(bank.name, entry.code, "amount"), Number(entry.amount || 0));
    });
  });

  renderRuntime.entryValueSnapshot = nextSnapshot;
}

function renderSummary(columnEntries) {
  const summary = computeSummary(columnEntries);
  elements.totalReady.textContent = formatNumber(summary.totalReady);
  elements.totalAmount.textContent = formatNumber(summary.totalAmount);
}

function renderBanks() {
  if (!shouldUseLiveSheet() || state.liveSheet.entries.length === 0) {
    elements.totalReady.textContent = "0";
    elements.totalAmount.textContent = "0";
    elements.bankColumns.innerHTML =
      '<div class="empty-column">Belum ada data hasil extract Google Sheet untuk ditampilkan di dashboard.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  const entryLookup = getEntryLookup();
  const selectableCodeMap = new Map(buildSelectableCodes().map((item) => [item.code, item]));
  const visibleBanks = state.data.banks
    .filter((bank) => state.data.selectedBanks.includes(bank.name))
    .map((bank) => ({
      bank,
      entries: getColumnEntries(bank.name, entryLookup, selectableCodeMap),
    }))
    .filter(({ entries }) => entries.length > 0);

  visibleBanks.forEach(({ bank, entries }) => {
    const column = document.createElement("article");
    column.className = "bank-column";
    const longestCodeLength = Math.max(
      "Area Code".length,
      ...entries.map((entry) => String(entry.code || "").trim().length)
    );
    const codeColumnWidth = Math.min(30, Math.max(14, longestCodeLength + 1));
    column.style.setProperty("--code-column-width", `${codeColumnWidth}ch`);

    const listHtml = entries
      .map(
        (entry) => `
          <article class="entry-card">
            <div class="entry-row">
              <button class="entry-copy entry-code" data-copy-text="${escapeHtml(entry.code)}" type="button">
                ${escapeHtml(entry.code)}
              </button>
              <button
                class="entry-copy entry-limit-value ${getEntryMetricChangeClass(bank.name, entry, "limit")}"
                data-copy-text="${formatNumber(entry.limit)}"
                type="button"
              >
                ${formatNumber(entry.limit)}
              </button>
              <button
                class="entry-copy entry-amount ${getBalanceStatusClass(entry.amount)} ${getEntryMetricChangeClass(bank.name, entry, "amount")}"
                data-copy-text="${formatNumber(entry.amount)}"
                type="button"
              >
                ${formatNumber(entry.amount)}
              </button>
            </div>
          </article>
        `
      )
      .join("");

    column.innerHTML = `
      <header class="bank-title">
        <span class="bank-entry-count">${formatNumber(entries.length)} Ready</span>
        <span class="bank-title-name">${escapeHtml(bank.name)}</span>
      </header>
      <div class="bank-headings">
        <span>Area Code</span>
        <span>Total Approve</span>
        <span>Balance</span>
      </div>
      <div class="bank-list">${listHtml}</div>
    `;
    fragment.appendChild(column);
  });

  if (visibleBanks.length === 0) {
    elements.bankColumns.innerHTML =
      '<div class="empty-column">Belum ada area code yang dipilih untuk ditampilkan di dashboard.</div>';
  } else {
    elements.bankColumns.replaceChildren(fragment);
  }

  renderSummary(visibleBanks);
  updateEntryValueSnapshot(visibleBanks);
}

function buildSelectableCodes() {
  if (shouldUseLiveSheet() && state.liveSheet.entries.length > 0) {
    return state.liveSheet.entries.map((entry) => ({
      code: entry.code,
      bankOptions: getPresetOptionsForCode(entry.code),
    }));
  }

  return [];
}

function renderBankSelectionModal() {
  const selectableCodes = buildSelectableCodes();
  if (selectableCodes.length === 0) {
    elements.bankSelectGrid.innerHTML =
      '<div class="empty-column">Belum ada area code. Tempel link sheet lalu klik Save & Extract agar data muncul di sini.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();

  selectableCodes.forEach((item) => {
    const wrapper = document.createElement("div");
    wrapper.className = "select-item";
    const checked = state.selectedCodes.has(item.code) ? "checked" : "";
    const expandedClass = checked ? "expanded" : "";
    const selectedOption = getSelectedOptionForCode(item.code, item.bankOptions);
    const optionsHtml = item.bankOptions
      .map(
        (option) => `
          <label class="select-subitem">
            <input
              class="select-suboption"
              data-code="${escapeHtml(item.code)}"
              data-option="${escapeHtml(option)}"
              name="bank-option-${escapeHtml(item.code)}"
              type="radio"
              ${selectedOption === option ? "checked" : ""}
              ${checked ? "" : "disabled"}
            />
            <span>${escapeHtml(option)}</span>
          </label>
        `
      )
      .join("");

    wrapper.innerHTML = `
      <label class="select-main">
        <input class="bank-code-checkbox" data-code="${escapeHtml(item.code)}" type="checkbox" ${checked} />
        <div>
          <div class="select-title">${escapeHtml(item.code)}</div>
          <div class="select-sublist ${expandedClass}">${optionsHtml}</div>
        </div>
      </label>
    `;
    fragment.appendChild(wrapper);
  });

  elements.bankSelectGrid.replaceChildren(fragment);
}

function syncBankOptionVisibility(checkbox) {
  const selectItem = checkbox.closest(".select-item");
  const sublist = selectItem?.querySelector(".select-sublist");
  const subOptions = selectItem?.querySelectorAll(".select-suboption") || [];

  if (!sublist) {
    return;
  }

  sublist.classList.toggle("expanded", checkbox.checked);
  subOptions.forEach((option) => {
    option.disabled = !checkbox.checked;
  });
}

function findBankFromSheetInput(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return state.data.banks.find((item) => item.id === state.activeSettingsBankId) || null;
  }

  return (
    state.data.banks.find(
      (item) =>
        item.id.toLowerCase() === normalized || item.name.toLowerCase() === normalized
    ) || null
  );
}

function populateSettingsOptions() {
  const options = state.data.banks
    .map((bank) => `<option value="${escapeHtml(bank.name)}"></option>`)
    .join("");
  elements.sourceBankList.innerHTML = options;

  if (!state.activeSettingsBankId && state.data.banks[0]) {
    state.activeSettingsBankId = state.data.banks[0].id;
  }

  const activeBank = state.data.banks.find((item) => item.id === state.activeSettingsBankId);
  elements.sourceBankSelect.value = state.uiSettings.sheetName || activeBank?.name || "";
  syncSettingsForm();
}

function syncSettingsForm() {
  const bank = findBankFromSheetInput(elements.sourceBankSelect.value);
  syncUiSettingsFromForm();
  applyDesktopBackground();

  if (!bank) {
    state.uiSettings.sheetName = elements.sourceBankSelect.value;
    persistState();
    updateSettingsPreview();
    return;
  }

  state.activeSettingsBankId = bank.id;
  state.uiSettings.sheetName = elements.sourceBankSelect.value || bank.name;
  const config = getBankConfig(bank);
  const maxLength = Math.max(0, getSourceLength(bank.sourceKey) - 1);

  elements.rangeStart.max = String(maxLength);
  elements.rangeEnd.max = String(maxLength);

  if (!hasLiveSheetInput()) {
    elements.orientationMode.value = config.orientation;
    elements.rangeStart.value = String(config.rangeStart);
    elements.rangeEnd.value = String(config.rangeEnd);
    syncUiSettingsFromForm();
  }

  persistState();
  updateSettingsPreview();
}

function updateSettingsPreview() {
  if (hasLiveSheetInput() && !isLiveSheetReady()) {
    elements.settingsPreview.textContent =
      "Input Google Sheet tetap disimpan sesuai yang ditempel. Lengkapi link, sheet, dan range lalu klik Save & Extract.";
    return;
  }

  if (shouldUseLiveSheet()) {
    if (state.liveSheet.error) {
      elements.settingsPreview.textContent = state.liveSheet.error;
      return;
    }

    if (state.liveSheet.loading) {
      elements.settingsPreview.textContent = "Mengambil data Google Sheet...";
      return;
    }

    const mode = elements.orientationMode.value;
    elements.settingsPreview.textContent =
      `Sheet: ${elements.sourceBankSelect.value || "-"} | Mode aktif: ${mode} | ` +
      `Jumlah data live: ${state.liveSheet.entries.length}. ` +
      `Area code yang sudah dicentang akan langsung muncul di dashboard utama.`;
    return;
  }

  const bank = findBankFromSheetInput(elements.sourceBankSelect.value);
  if (!bank) {
    return;
  }

  const source = state.data.sheetSources[bank.sourceKey];
  const mode = elements.orientationMode.value;
  const start = Math.max(0, Number(elements.rangeStart.value || 0));
  const end = Math.max(start, Number(elements.rangeEnd.value || 0));
  const normalized = normalizeRows(source.rows, mode);
  const preview = normalized.slice(start, end + 1);
  const detected = mode === "auto" ? detectOrientation(source.rows) : mode;

  elements.settingsPreview.textContent =
    `Bank: ${bank.name} | Mode aktif: ${detected} | Range: ${start}-${end} | ` +
    `Jumlah data terbaca: ${preview.length}. ` +
    `Semua hasil render tetap ditampilkan vertikal di dashboard.`;
}

function parseRangeValue(value, fallback = 0) {
  const text = String(value ?? "").trim();
  const match = text.match(/\d+/);
  if (!match) {
    return fallback;
  }

  return Number(match[0]);
}

function areSettingsReady() {
  return [
    elements.googleSheetLink.value,
    elements.sourceBankSelect.value,
    elements.areaCodeDisplay.value,
    elements.rangeStart.value,
    elements.rangeEnd.value,
  ].every((value) => String(value || "").trim() !== "");
}

async function applySettingsFromForm({ closeAfterApply = false } = {}) {
  const bank = findBankFromSheetInput(elements.sourceBankSelect.value);
  if (bank) {
    state.activeSettingsBankId = bank.id;
  }

  syncUiSettingsFromForm();
  persistState();

  if (isLiveSheetReady()) {
    const success = await syncLiveSheetEntries();
    if (success) {
      await flushFirebaseSync();
      if (closeAfterApply) {
        closeModal(elements.settingsModal);
        showSaveSuccessNotice("Save & Extract berhasil. Dashboard utama sudah diperbarui.");
      }
    }
    return success;
  }

  if (hasLiveSheetInput()) {
    updateSettingsPreview();
    return false;
  }

  if (!bank) {
    updateSettingsPreview();
    return false;
  }

  const maxLength = Math.max(0, getSourceLength(bank.sourceKey) - 1);
  const rangeStart = Math.min(maxLength, Math.max(0, parseRangeValue(elements.rangeStart.value, 0)));
  const rangeEnd = Math.min(
    maxLength,
    Math.max(rangeStart, parseRangeValue(elements.rangeEnd.value, rangeStart))
  );

  state.bankConfigs[bank.id] = {
    orientation: elements.orientationMode.value,
    rangeStart,
    rangeEnd,
  };

  elements.rangeStart.value = String(rangeStart);
  elements.rangeEnd.value = String(rangeEnd);
  syncUiSettingsFromForm();

  persistState();
  updateSettingsPreview();
  updateSheetBadge();
  renderBanks();
  await flushFirebaseSync();

  if (closeAfterApply) {
    closeModal(elements.settingsModal);
    showSaveSuccessNotice("Save & Extract berhasil. Dashboard utama sudah diperbarui.");
  }

  return true;
}

function autoApplySettingsIfReady() {
  if (!areSettingsReady()) {
    persistState();
    return false;
  }

  if (hasLiveSheetInput() && !isLiveSheetReady()) {
    persistState();
    updateSettingsPreview();
    return false;
  }

  void applySettingsFromForm();
  return true;
}

function updateSheetBadge() {
  if (shouldUseLiveSheet()) {
    const label = elements.orientationMode.value === "auto" ? "Auto Detect" : elements.orientationMode.value;
    const name = elements.sourceBankSelect.value || "Google Sheet";
    elements.sheetModeBadge.textContent = `Mode: ${label} | ${name}`;
    return;
  }

  const bank = state.data.banks.find((item) => item.id === state.activeSettingsBankId);
  if (!bank) {
    elements.sheetModeBadge.textContent = "Mode: Auto Detect";
    return;
  }

  const config = getBankConfig(bank);
  const label = config.orientation === "auto" ? "Auto Detect" : config.orientation;
  elements.sheetModeBadge.textContent = `Mode: ${label} | ${bank.name}`;
}

function collectSelectedCodes() {
  const selected = [...document.querySelectorAll(".bank-code-checkbox:checked")].map((node) =>
    node.getAttribute("data-code")
  );
  state.selectedCodes = new Set(selected);
}

function syncDashboardSelection() {
  collectSelectedCodes();
  persistState();
  renderBanks();
  void flushFirebaseSync();
}

function updateCodeSelection(code, checked) {
  if (checked) {
    state.selectedCodes.add(code);
    persistState();
    return;
  }

  state.selectedCodes.delete(code);
  persistState();
}

function normalizePersistedSelections() {
  const selectableItems = buildSelectableCodes();
  const selectableMap = new Map(selectableItems.map((item) => [item.code, item]));

  state.selectedCodes = new Set(
    [...state.selectedCodes].filter((code) => selectableMap.has(code))
  );

  Object.keys(state.selectedOptions).forEach((code) => {
    const item = selectableMap.get(code);
    if (!item || !item.bankOptions.includes(state.selectedOptions[code])) {
      delete state.selectedOptions[code];
    }
  });

  if (!state.selectionInitialized && selectableItems.length > 0) {
    selectableItems.forEach((item) => {
      state.selectedCodes.add(item.code);
    });
    state.selectionInitialized = true;
  }

  selectableItems.forEach((item) => {
    if (!state.selectedOptions[item.code]) {
      state.selectedOptions[item.code] = getDefaultOption(item);
    }
  });

  persistState();
}

function stopLiveSyncTimer() {
  if (liveSyncTimerId) {
    window.clearInterval(liveSyncTimerId);
    liveSyncTimerId = 0;
  }
}

function startLiveSyncTimer() {
  stopLiveSyncTimer();
  if (!isLiveSheetReady()) {
    return;
  }

  liveSyncTimerId = window.setInterval(() => {
    if (!document.hidden && !state.liveSheet.loading) {
      void syncLiveSheetEntries();
    }
  }, LIVE_SYNC_INTERVAL_MS);
}

function refreshLiveSheetOnFocus() {
  if (isDesktopSlideshowEnabled()) {
    applyDesktopBackground();
  }

  if (!document.hidden && isLiveSheetReady() && !state.liveSheet.loading) {
    void syncLiveSheetEntries();
  }
}

function handleStorageSync(event) {
  if (event.key !== STORAGE_KEY) {
    return;
  }

  if (!event.newValue) {
    state.uiSettings.desktopImageData = "";
    state.uiSettings.desktopImageRemoteUrl = "";
    state.uiSettings.desktopImagePresetId = "";
    state.uiSettings.desktopImageFit = "fill";
    state.uiSettings.desktopSlideshowEnabled = false;
    state.uiSettings.desktopSlideshowStartedAt = 0;
    state.uiSettings.desktopSlideshowSlideIndex = 0;
    state.uiSettings.desktopSlideshowIntervalMs = BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS;
    state.uiSettings.desktopSlideshowTransitionName = BACKGROUND_SLIDESHOW_TRANSITIONS[0];
    syncUiSettingsToForm();
    applyDesktopBackground();
    syncShareStateToUrl();
    return;
  }

  loadPersistedState();
  syncShareStateToUrl();
  syncUiSettingsToForm();
  applyDesktopBackground();
  renderBankSelectionModal();
  updateSheetBadge();
  renderBanks();
  updateSettingsPreview();
}

async function syncLiveSheetEntries() {
  if (!isLiveSheetReady()) {
    stopLiveSyncTimer();
    state.liveSheet.error = "";
    state.liveSheet.entries = [];
    state.liveSheet.lastAppliedKey = "";
    persistState();
    return false;
  }

  if (state.liveSheet.loading) {
    return false;
  }

  const spreadsheetId = extractSpreadsheetId(elements.googleSheetLink.value);
  const sheetName = String(elements.sourceBankSelect.value || "").trim();
  const areaRange = String(elements.areaCodeDisplay.value || "").trim();
  const balanceRange = String(elements.rangeStart.value || "").trim();
  const limitRange = String(elements.rangeEnd.value || "").trim();

  if (!spreadsheetId) {
    state.liveSheet.error = "Link Google Sheet tidak valid.";
    updateSettingsPreview();
    persistState();
    return false;
  }

  const requestKey = [spreadsheetId, sheetName, areaRange, balanceRange, limitRange].join("|");
  state.liveSheet.loading = true;
  state.liveSheet.error = "";
  updateSettingsPreview();

  try {
    const [areaRows, balanceRows, limitRows] = await Promise.all([
      fetchGoogleSheetRange(spreadsheetId, sheetName, areaRange),
      fetchGoogleSheetRange(spreadsheetId, sheetName, balanceRange),
      fetchGoogleSheetRange(spreadsheetId, sheetName, limitRange),
    ]);

    state.liveSheet.entries = buildEntriesFromLiveRanges(areaRows, balanceRows, limitRows);
    state.liveSheet.lastAppliedKey = requestKey;
    state.liveSheet.error = "";
    state.liveSheet.loading = false;
    normalizePersistedSelections();
    renderBankSelectionModal();
    updateSettingsPreview();
    updateSheetBadge();
    renderBanks();
    persistState();
    startLiveSyncTimer();
    return true;
  } catch (error) {
    state.liveSheet.loading = false;
    state.liveSheet.error =
      "Gagal mengambil data dari Google Sheet. Pastikan sheet publik dan range yang ditempel benar.";
    updateSettingsPreview();
    persistState();
    console.error(error);
    return false;
  }
}

function openModal(modal) {
  modal.classList.remove("hidden");
}

function closeModal(modal) {
  modal.classList.add("hidden");
}

async function loadData() {
  const response = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Gagal memuat data: ${response.status}`);
  }

  state.data = await response.json();

  document.title = state.data.meta?.title || "Dashboard Buang Dana";
  updateDashboardDateTime();
  applyDesktopBackground();
  persistState();

  state.data.banks.forEach((bank) => {
    const size = getSourceLength(bank.sourceKey);
    if (!state.bankConfigs[bank.id]) {
      state.bankConfigs[bank.id] = {
        orientation: "auto",
        rangeStart: 0,
        rangeEnd: Math.max(0, size - 1),
      };
    }
  });

  normalizePersistedSelections();

  populateSettingsOptions();
  renderBankSelectionModal();
  renderBanks();
  updateSheetBadge();

  if (isLiveSheetReady()) {
    await syncLiveSheetEntries();
  }
}

async function refreshDashboard() {
  const originalLabel = elements.refreshData.innerHTML;
  elements.refreshData.innerHTML = `<span class="btn-icon">↻</span><span>Refreshing...</span>`;
  elements.refreshData.disabled = true;

  try {
    if (shouldUseLiveSheet()) {
      await syncLiveSheetEntries();
    } else {
      await loadData();
    }
  } finally {
    elements.refreshData.innerHTML = originalLabel;
    elements.refreshData.disabled = false;
  }
}

function registerEvents() {
  elements.openBankModal.addEventListener("click", () => {
    renderBankSelectionModal();
    openModal(elements.bankModal);
  });

  elements.openSettingsModal.addEventListener("click", () => {
    syncSettingsForm();
    openModal(elements.settingsModal);
  });

  elements.refreshData.addEventListener("click", refreshDashboard);

  document.querySelectorAll("[data-close-modal='bank']").forEach((button) => {
    button.addEventListener("click", () => closeModal(elements.bankModal));
  });

  document.querySelectorAll("[data-close-modal='settings']").forEach((button) => {
    button.addEventListener("click", () => closeModal(elements.settingsModal));
  });

  elements.bankModal.addEventListener("click", (event) => {
    if (event.target === elements.bankModal) {
      closeModal(elements.bankModal);
    }
  });

  elements.settingsModal.addEventListener("click", (event) => {
    if (event.target === elements.settingsModal) {
      closeModal(elements.settingsModal);
    }
  });

  elements.selectAllBanks.addEventListener("click", () => {
    document.querySelectorAll(".bank-code-checkbox").forEach((checkbox) => {
      checkbox.checked = true;
      syncBankOptionVisibility(checkbox);
    });
    buildSelectableCodes().forEach((item) => state.selectedCodes.add(item.code));
    state.selectionInitialized = true;
    persistState();
    renderBanks();
    scheduleFirebaseSync();
  });

  elements.deselectAllBanks.addEventListener("click", () => {
    document.querySelectorAll(".bank-code-checkbox").forEach((checkbox) => {
      checkbox.checked = false;
      syncBankOptionVisibility(checkbox);
    });
    state.selectedCodes.clear();
    state.selectionInitialized = true;
    persistState();
    renderBanks();
    scheduleFirebaseSync();
  });

  elements.applyBankSelection.addEventListener("click", () => {
    syncDashboardSelection();
    closeModal(elements.bankModal);
  });

  elements.bankSelectGrid.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    if (target.classList.contains("bank-code-checkbox")) {
      syncBankOptionVisibility(target);
      updateCodeSelection(target.getAttribute("data-code"), target.checked);
      renderBanks();
      scheduleFirebaseSync();
      return;
    }

    if (target.classList.contains("select-suboption")) {
      const code = target.getAttribute("data-code");
      const option = target.getAttribute("data-option");
      if (!code || !option) {
        return;
      }

      state.selectedOptions[code] = option;
      persistState();
      if (state.selectedCodes.has(code)) {
        renderBanks();
      }
      scheduleFirebaseSync();
    }
  });

  elements.bankColumns.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const copyTarget = target.closest(".entry-copy");
    if (!(copyTarget instanceof HTMLButtonElement)) {
      return;
    }

    const copyText = copyTarget.getAttribute("data-copy-text") || copyTarget.textContent || "";
    const copied = await copyTextToClipboard(copyText);
    if (copied) {
      showCopyFeedback(copyTarget);
    }
  });

  elements.sourceBankSelect.addEventListener("change", syncSettingsForm);
  elements.orientationMode.addEventListener("change", updateSettingsPreview);
  elements.rangeStart.addEventListener("input", updateSettingsPreview);
  elements.rangeEnd.addEventListener("input", updateSettingsPreview);
  elements.previewRange.addEventListener("click", updateSettingsPreview);
  elements.cancelSettings.addEventListener("click", () => closeModal(elements.settingsModal));
  document.addEventListener("visibilitychange", refreshLiveSheetOnFocus);
  window.addEventListener("focus", refreshLiveSheetOnFocus);
  window.addEventListener("storage", handleStorageSync);

  elements.googleSheetLink.addEventListener("input", () => {
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });

  elements.sourceBankSelect.addEventListener("input", () => {
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });

  elements.areaCodeDisplay.addEventListener("input", () => {
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });

  elements.backgroundFitSelect?.addEventListener("change", () => {
    syncUiSettingsFromForm();
    applyDesktopBackground();
    persistState();
  });

  elements.backgroundPresetGrid?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const card = target.closest(".background-preset-card");
    if (!(card instanceof HTMLButtonElement)) {
      return;
    }

    const presetId = card.getAttribute("data-preset-id");
    if (!presetId) {
      return;
    }

    applyDesktopImagePreset(presetId);
  });

  elements.backgroundImageInput?.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    const [file] = target.files || [];
    if (!file) {
      return;
    }

    try {
      await applyDesktopImageFile(file);
    } catch (error) {
      console.error("Gagal memproses gambar background.", error);
    } finally {
      target.value = "";
    }
  });

  elements.backgroundPasteZone?.addEventListener("click", () => {
    elements.backgroundPasteZone?.focus();
  });

  document.addEventListener("paste", (event) => {
    if (document.activeElement !== elements.backgroundPasteZone) {
      return;
    }

    void handleBackgroundPaste(event);
  });

  elements.clearBackgroundImage?.addEventListener("click", () => {
    clearDesktopBackground();
  });

  elements.backgroundSlideshowToggle?.addEventListener("click", () => {
    const sources = getDesktopSlideshowSources();
    if (sources.length === 0) {
      updateFirebaseStatus("Tambahkan minimal satu gambar bawaan atau upload gambar dulu sebelum slideshow diaktifkan.");
      return;
    }

    const nextEnabled = !isDesktopSlideshowEnabled();
    state.uiSettings.desktopSlideshowEnabled = nextEnabled;
    state.uiSettings.desktopSlideshowStartedAt = nextEnabled ? Date.now() : 0;
    state.uiSettings.desktopSlideshowSlideIndex = 0;
    state.uiSettings.desktopSlideshowIntervalMs = nextEnabled
      ? getRandomSlideshowIntervalMs()
      : BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS;
    state.uiSettings.desktopSlideshowTransitionName = nextEnabled
      ? pickRandomSlideshowTransition(state.uiSettings.desktopSlideshowTransitionName)
      : BACKGROUND_SLIDESHOW_TRANSITIONS[0];
    applyDesktopBackground();
    persistState();
  });

  elements.clearSettings.addEventListener("click", async () => {
    const confirmed = window.confirm(
      "Yakin ingin hapus semua data dashboard?\n\nSemua setting, pilihan bank, data sheet, background, dan sinkronisasi cloud juga akan ikut terhapus di semua tempat."
    );
    if (!confirmed) {
      return;
    }

    stopLiveSyncTimer();
    stopBackgroundSlideshow();
    clearBackgroundSlideshowTransition();
    state.selectedCodes.clear();
    state.selectedOptions = {};
    state.bankConfigs = {};
    state.activeSettingsBankId = "";
    state.selectionInitialized = false;
    state.uiSettings.googleSheetLink = "";
    state.uiSettings.areaCodeDisplay = "";
    state.uiSettings.sheetName = "";
    state.uiSettings.rangeBalance = "";
    state.uiSettings.rangeLimit = "";
    state.uiSettings.orientationMode = "auto";
    state.uiSettings.desktopImageData = "";
    state.uiSettings.desktopImageRemoteUrl = "";
    state.uiSettings.desktopImagePresetId = "";
    state.uiSettings.desktopImageFit = "fill";
    state.uiSettings.desktopSlideshowEnabled = false;
    state.uiSettings.desktopSlideshowStartedAt = 0;
    state.uiSettings.desktopSlideshowSlideIndex = 0;
    state.uiSettings.desktopSlideshowIntervalMs = BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS;
    state.uiSettings.desktopSlideshowTransitionName = BACKGROUND_SLIDESHOW_TRANSITIONS[0];
    state.liveSheet.entries = [];
    state.liveSheet.error = "";
    state.liveSheet.loading = false;
    state.liveSheet.lastAppliedKey = "";

    if (elements.backgroundImageInput) {
      elements.backgroundImageInput.value = "";
    }

    syncUiSettingsToForm();
    elements.settingsPreview.textContent =
      "Sistem akan membaca data sesuai mode yang dipilih.";
    updateFirebaseStatus("Data dashboard dihapus. Sinkronisasi ke semua tempat sedang diproses...");
    persistState();
    renderBankSelectionModal();
    updateSheetBadge();
    renderBanks();
    await flushFirebaseSync();
    closeModal(elements.settingsModal);
    showSaveSuccessNotice("Semua data berhasil dihapus dan sinkron ke semua tempat.");
  });

  elements.orientationMode.addEventListener("change", () => {
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });
  elements.rangeStart.addEventListener("input", () => {
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });
  elements.rangeEnd.addEventListener("input", () => {
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });
  elements.sourceBankSelect.addEventListener("change", () => {
    syncSettingsForm();
    scheduleSettingsAutoApply();
  });

  elements.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void applySettingsFromForm({ closeAfterApply: true });
  });
}

async function init() {
  setupAntiTamperGuards();
  loadPersistedState();
  loadSharedStateFromUrl();
  applyDesktopBackground();
  updateFirebaseStatus("Firebase Sync nonaktif. Isi `firebase-config.js` untuk mengaktifkan sinkronisasi global.");
  if (state.liveSheet.entries.length > 0 && isGoogleSheetUrl(state.uiSettings.googleSheetLink)) {
    startLiveSyncTimer();
  }
  startDashboardClock();
  registerEvents();

  try {
    await loadData();
    await initializeFirebaseSync();
  } catch (error) {
    console.error(error);
    elements.bankColumns.innerHTML =
      '<div class="empty-column">Data dashboard gagal dimuat. Pastikan file JSON tersedia.</div>';
  }
}

init();
