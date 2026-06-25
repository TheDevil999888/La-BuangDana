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
const c_white = "#ffffff";
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
let liveSheetSyncPromise = null;
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
const BANK_TITLE_ACCENT_PALETTE = [
  "#2b6cff",
  "#1f87ff",
  "#19b8ff",
  "#0fc6d7",
  "#11c48b",
  "#ffd318",
  "#ff4a4a",
  "#ffb21f",
  "#8d5bff",
  "#ff7a3d",
  "#18d2b8",
  "#4e9eff",
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
  backgroundSlideshowHydrated: false,
  bankRenderSignature: "",
  settingsDirtyFields: new Set(),
  themeGallerySelectionId: "",
  themeGalleryPreviewMode: "all",
  themeGalleryMotionPreset: "calm",
  themeGalleryToneX: 50,
  themeGalleryToneY: 50,
  themeGalleryToneDragging: false,
  themeGalleryAnimatedWallpaperEnabled: true,
  themeGalleryBackgroundFinish: "glossy",
  themeGalleryLivePreviewActive: false,
  themeWallpaperMotionFrameId: 0,
  themeWallpaperMotionStartedAt: 0,
  themeWallpaperMotionLastStepAt: 0,
  themeWallpaperMotionLastPosition: "",
  themeGallerySoundStates: {
    browser: true,
    keyboard: true,
    music: true,
  },
  liveWallpaperConfigValues: null,
};

let refreshStabilizeTimerId = 0;
let themeTonePersistTimerId = 0;

class WP_Section {
  constructor(title, key, options = []) {
    this.title = String(title || "").trim();
    this.key = String(key || "").trim();
    this.options = Array.isArray(options) ? options : [];
  }
}

class WP_OptionSelect {
  constructor(label, key, choices = [], defaultValue = "", description = "") {
    this.type = "select";
    this.label = String(label || "").trim();
    this.key = String(key || "").trim();
    this.choices = Array.isArray(choices) ? choices.map((choice) => String(choice || "").trim()).filter(Boolean) : [];
    this.defaultValue = String(defaultValue || this.choices[0] || "").trim();
    this.description = String(description || "").trim();
  }
}

class WP_OptionColor {
  constructor(label, key, defaultValue = c_white, description = "") {
    this.type = "color";
    this.label = String(label || "").trim();
    this.key = String(key || "").trim();
    this.defaultValue = String(defaultValue || c_white).trim();
    this.description = String(description || "").trim();
  }
}

class WallpaperConfiguration {
  constructor(sections = [], onChange = () => {}) {
    this.sections = Array.isArray(sections) ? sections : [];
    this.onChange = typeof onChange === "function" ? onChange : () => {};
  }

  getDefaultValues() {
    return this.sections.reduce((accumulator, section) => {
      accumulator[section.key] = section.options.reduce((sectionValues, option) => {
        sectionValues[option.key] = option.defaultValue;
        return sectionValues;
      }, {});
      return accumulator;
    }, {});
  }

  normalizeValues(candidateValues = {}) {
    return this.sections.reduce((accumulator, section) => {
      const sourceSection = candidateValues?.[section.key] || {};
      accumulator[section.key] = section.options.reduce((sectionValues, option) => {
        const rawValue = sourceSection?.[option.key];
        if (option.type === "select") {
          sectionValues[option.key] = option.choices.includes(String(rawValue || "").trim())
            ? String(rawValue).trim()
            : option.defaultValue;
        } else if (option.type === "color") {
          sectionValues[option.key] = normalizeHexColor(rawValue, option.defaultValue);
        } else {
          sectionValues[option.key] = rawValue ?? option.defaultValue;
        }
        return sectionValues;
      }, {});
      return accumulator;
    }, {});
  }

  apply(candidateValues = {}) {
    const normalizedValues = this.normalizeValues(candidateValues);
    this.onChange(normalizedValues);
    return normalizedValues;
  }
}

const LIVE_WALLPAPER_SPEED_PRESETS = {
  Low: { durationMs: 42000, label: "Low" },
  Normal: { durationMs: 26000, label: "Normal" },
  Blazing: { durationMs: 14000, label: "Blazing" },
};

const LIVE_WALLPAPER_CONFIGURATION = new WallpaperConfiguration(
  [
    new WP_Section("Performance", "perf", [
      new WP_OptionSelect(
        "Speed:",
        "lw_speed",
        ["Low", "Normal", "Blazing"],
        "Normal",
        "Kecepatan drift live wallpaper di background dan preview."
      ),
    ]),
    new WP_Section("Appearance", "appearance", [
      new WP_OptionColor(
        "Color",
        "color",
        c_white,
        "Accent warna tambahan untuk wallpaper live."
      ),
    ]),
  ],
  function callback(values) {
    renderRuntime.liveWallpaperConfigValues = values;
    document.documentElement.style.setProperty("--live-wallpaper-accent", values.appearance.color);
    document.documentElement.style.setProperty(
      "--live-wallpaper-duration",
      `${getLiveWallpaperSpeedPreset(values.perf.lw_speed).durationMs}ms`
    );
  }
);

const THEME_GALLERY_WALLPAPER_MOTION_PRESETS = {
  calm: { label: "Calm", fromX: 50, fromY: 50, toX: 50, toY: 50, durationMs: 26000 },
  left: { label: "Left", fromX: 64, fromY: 50, toX: 36, toY: 50, durationMs: 22000 },
  right: { label: "Right", fromX: 36, fromY: 50, toX: 64, toY: 50, durationMs: 22000 },
  up: { label: "Up", fromX: 50, fromY: 62, toX: 50, toY: 36, durationMs: 22000 },
  down: { label: "Down", fromX: 50, fromY: 36, toX: 50, toY: 62, durationMs: 22000 },
  "diag-up-left": { label: "Up Left", fromX: 64, fromY: 64, toX: 38, toY: 38, durationMs: 24000 },
  "diag-up-right": { label: "Up Right", fromX: 36, fromY: 64, toX: 62, toY: 38, durationMs: 24000 },
  "diag-down-left": { label: "Down Left", fromX: 64, fromY: 36, toX: 38, toY: 62, durationMs: 24000 },
  "diag-down-right": { label: "Down Right", fromX: 36, fromY: 36, toX: 62, toY: 62, durationMs: 24000 },
};

const DEFAULT_THEMEABLE_CSS_VARS = {
  "--bg-panel": "rgba(7, 17, 43, 0.82)",
  "--bg-card": "rgba(10, 25, 56, 0.86)",
  "--bg-soft": "rgba(14, 39, 82, 0.58)",
  "--line": "rgba(74, 212, 255, 0.34)",
  "--line-soft": "rgba(132, 177, 255, 0.18)",
  "--cyan": "#35d8ff",
  "--cyan-soft": "#9af1ff",
  "--gold": "#ffd452",
  "--gold-soft": "#fff2a2",
  "--white": "#f7fbff",
  "--text-soft": "#94aecf",
  "--text-muted": "#6f86a8",
  "--shadow-neon": "0 0 0 1px rgba(53, 216, 255, 0.18), 0 0 34px rgba(53, 216, 255, 0.12)",
  "--dashboard-glow-top":
    "radial-gradient(circle at 14% 18%, rgba(255, 212, 82, 0.16), transparent 20%), radial-gradient(circle at 86% 12%, rgba(255, 212, 82, 0.15), transparent 18%), radial-gradient(circle at 50% 0%, rgba(53, 216, 255, 0.12), transparent 30%)",
  "--dashboard-main-border": "rgba(79, 218, 255, 0.18)",
  "--dashboard-main-bg":
    "linear-gradient(180deg, rgba(4, 16, 41, 0.62), rgba(2, 8, 24, 0.72)), radial-gradient(circle at top center, rgba(255, 212, 82, 0.05), transparent 28%)",
  "--dashboard-main-overlay":
    "radial-gradient(circle at top right, rgba(53, 216, 255, 0.12), transparent 24%), radial-gradient(circle at bottom left, rgba(132, 77, 255, 0.09), transparent 28%)",
  "--dashboard-main-top-line": "linear-gradient(90deg, transparent, rgba(53, 216, 255, 0.7), transparent)",
  "--glow-card-bg":
    "linear-gradient(180deg, rgba(10, 24, 56, 0.95), rgba(3, 10, 28, 0.96)), radial-gradient(circle at top center, rgba(120, 227, 255, 0.08), transparent 58%)",
  "--glow-card-shadow":
    "0 0 0 1px rgba(53, 216, 255, 0.08), 0 18px 44px rgba(0, 0, 0, 0.34), 0 0 34px rgba(53, 216, 255, 0.08)",
  "--stat-card-border": "rgba(83, 220, 255, 0.2)",
  "--stat-card-bg":
    "linear-gradient(180deg, rgba(7, 22, 50, 0.88), rgba(2, 8, 24, 0.92)), radial-gradient(circle at top center, rgba(255, 212, 82, 0.08), transparent 35%)",
  "--stat-card-before":
    "radial-gradient(circle at 20% 18%, rgba(53, 216, 255, 0.18), transparent 26%), radial-gradient(circle at 84% 12%, rgba(255, 212, 82, 0.12), transparent 24%), linear-gradient(135deg, rgba(255, 255, 255, 0.05), transparent 56%)",
  "--stat-card-after":
    "linear-gradient(115deg, transparent 24%, rgba(255, 255, 255, 0.08) 48%, transparent 72%), linear-gradient(180deg, rgba(255, 212, 82, 0.03), transparent 40%)",
  "--stat-label-color": "#c7d8f4",
  "--action-panel-border": "rgba(86, 220, 255, 0.24)",
  "--action-panel-bg":
    "linear-gradient(180deg, rgba(7, 21, 48, 0.9), rgba(4, 12, 31, 0.96)), radial-gradient(circle at top center, rgba(53, 216, 255, 0.1), transparent 42%)",
  "--action-panel-before":
    "radial-gradient(circle at 50% -10%, rgba(255, 212, 82, 0.12), transparent 38%), linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 28%)",
  "--action-btn-border": "rgba(68, 224, 255, 0.55)",
  "--action-btn-bg": "linear-gradient(180deg, rgba(11, 35, 73, 0.95), rgba(5, 16, 40, 0.95))",
  "--action-btn-hover-border": "rgba(132, 238, 255, 0.84)",
  "--action-btn-hover-bg": "linear-gradient(180deg, rgba(16, 43, 86, 0.98), rgba(7, 20, 48, 0.98))",
  "--action-btn-text": "#f4fbff",
  "--action-btn-hover-text": "#ffffff",
  "--action-btn-text-shadow": "0 1px 0 rgba(255, 255, 255, 0.1), 0 0 14px rgba(53, 216, 255, 0.14)",
  "--action-btn-after-border": "rgba(132, 238, 255, 0.16)",
  "--action-btn-after-shadow":
    "inset 0 0 18px rgba(53, 216, 255, 0.08), 0 0 18px rgba(53, 216, 255, 0.08)",
  "--header-border": "rgba(83, 219, 255, 0.14)",
  "--header-bg":
    "linear-gradient(180deg, rgba(7, 19, 45, 0.66), rgba(3, 10, 28, 0.48)), radial-gradient(circle at top left, rgba(53, 216, 255, 0.06), transparent 30%)",
  "--header-title-color": "#f2dfa2",
  "--header-title-shadow": "0 0 18px rgba(255, 212, 82, 0.26), 0 0 30px rgba(255, 244, 196, 0.12)",
  "--header-pill-bg":
    "linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.02)), linear-gradient(90deg, rgba(255, 212, 82, 0.07), rgba(53, 216, 255, 0.04))",
  "--header-pill-border": "rgba(104, 224, 255, 0.16)",
  "--header-pill-text": "#d7e7ff",
  "--header-dot-bg": "linear-gradient(180deg, #62f5b0, #28d887)",
  "--header-dot-shadow": "0 0 0 6px rgba(98, 245, 176, 0.08), 0 0 16px rgba(98, 245, 176, 0.45)",
  "--logo-border": "rgba(255, 212, 82, 0.24)",
  "--logo-bg":
    "linear-gradient(180deg, rgba(16, 26, 52, 0.86), rgba(6, 14, 32, 0.52)), radial-gradient(circle at 28% 50%, rgba(255, 212, 82, 0.12), transparent 28%), radial-gradient(circle at 72% 50%, rgba(53, 216, 255, 0.08), transparent 34%)",
  "--logo-shadow":
    "inset 0 1px 0 rgba(255, 255, 255, 0.05), inset 0 0 42px rgba(255, 212, 82, 0.04), 0 20px 36px rgba(0, 0, 0, 0.24), 0 0 26px rgba(255, 212, 82, 0.08), 0 0 38px rgba(53, 216, 255, 0.06)",
  "--logo-overlay-shadow":
    "inset 0 1px 0 rgba(255, 241, 196, 0.16), inset 0 -1px 0 rgba(53, 216, 255, 0.08)",
  "--logo-live-beam":
    "linear-gradient(112deg, transparent 14%, rgba(255, 255, 255, 0.18) 34%, rgba(255, 221, 121, 0.24) 48%, rgba(96, 224, 255, 0.14) 58%, transparent 76%)",
  "--logo-live-veil":
    "radial-gradient(circle at 24% 42%, rgba(255, 212, 82, 0.16), transparent 24%), radial-gradient(circle at 78% 48%, rgba(53, 216, 255, 0.14), transparent 28%), linear-gradient(180deg, rgba(255, 255, 255, 0.05), transparent 44%, rgba(255, 255, 255, 0.03) 100%)",
  "--logo-live-glow":
    "0 0 0 1px rgba(255, 255, 255, 0.05), 0 20px 42px rgba(0, 0, 0, 0.24), 0 0 28px rgba(255, 212, 82, 0.12), 0 0 42px rgba(53, 216, 255, 0.08)",
  "--logo-image-filter":
    "drop-shadow(0 0 16px rgba(255, 212, 82, 0.16)) drop-shadow(0 0 28px rgba(255, 255, 255, 0.08)) drop-shadow(0 0 18px rgba(53, 216, 255, 0.08))",
  "--logo-image-opacity": "0.99",
  "--logo-text-color": "#f7e29a",
  "--logo-text-shadow": "0 0 12px rgba(255, 212, 82, 0.35), 0 0 28px rgba(255, 255, 255, 0.08)",
  "--badge-text": "#fff7ff",
  "--badge-radius": "999px",
  "--badge-bg":
    "linear-gradient(135deg, rgba(255, 91, 146, 0.22) 0%, rgba(255, 171, 76, 0.22) 18%, rgba(255, 223, 88, 0.24) 34%, rgba(98, 245, 176, 0.22) 50%, rgba(90, 214, 255, 0.24) 66%, rgba(140, 118, 255, 0.24) 82%, rgba(255, 97, 193, 0.22) 100%), linear-gradient(90deg, rgba(255, 255, 255, 0.08), transparent)",
  "--badge-border": "rgba(180, 201, 255, 0.64)",
  "--badge-shadow":
    "inset 0 1px 0 rgba(255, 248, 222, 0.18), 0 12px 22px rgba(0, 0, 0, 0.16), 0 0 16px rgba(255, 91, 146, 0.14), 0 0 22px rgba(90, 214, 255, 0.14), 0 0 28px rgba(140, 118, 255, 0.12)",
  "--badge-text-shadow":
    "0 0 8px rgba(255, 91, 146, 0.22), 0 0 14px rgba(90, 214, 255, 0.18), 0 1px 0 rgba(255, 255, 255, 0.22)",
  "--badge-sweep-bg":
    "linear-gradient(110deg, transparent 20%, rgba(255, 255, 255, 0.18) 36%, rgba(255, 111, 191, 0.24) 50%, rgba(96, 224, 255, 0.22) 60%, transparent 78%)",
  "--bank-column-bg": "linear-gradient(180deg, rgba(6, 26, 56, 0.92) 0%, rgba(3, 8, 26, 0.96) 100%)",
  "--bank-column-hover-border": "rgba(91, 226, 255, 0.44)",
  "--bank-column-hover-shadow":
    "inset 0 0 0 1px rgba(255, 255, 255, 0.03), 0 18px 36px rgba(0, 0, 0, 0.24), 0 0 0 1px rgba(53, 216, 255, 0.06)",
  "--bank-title-bg":
    "linear-gradient(180deg, rgba(0, 215, 255, 0.14), rgba(0, 215, 255, 0.03)), linear-gradient(90deg, rgba(255, 255, 255, 0.02), transparent)",
  "--bank-title-border": "rgba(0, 215, 255, 0.18)",
  "--count-border": "rgba(255, 213, 74, 0.34)",
  "--count-bg": "linear-gradient(180deg, rgba(255, 213, 74, 0.12), rgba(255, 213, 74, 0.04))",
  "--count-text": "#fff2a2",
  "--table-head-bg": "#f4d63f",
  "--table-head-top-border": "rgba(255, 255, 255, 0.24)",
  "--table-head-bottom-border": "rgba(8, 16, 24, 0.24)",
  "--table-head-divider": "rgba(8, 16, 24, 0.26)",
  "--table-head-text": "#081018",
  "--table-head-code-text": "#081018",
  "--table-head-approve-text": "#081018",
  "--table-head-balance-text": "#081018",
  "--table-head-code-bg": "transparent",
  "--table-head-approve-bg": "transparent",
  "--table-head-balance-bg": "transparent",
  "--table-head-code-border": "transparent",
  "--table-head-approve-border": "transparent",
  "--table-head-balance-border": "transparent",
  "--entry-border": "rgba(90, 200, 255, 0.16)",
  "--entry-bg":
    "linear-gradient(180deg, rgba(12, 29, 63, 0.98), rgba(6, 17, 38, 0.98)), linear-gradient(90deg, rgba(255, 255, 255, 0.02), transparent)",
  "--entry-hover-bg": "rgba(122, 228, 255, 0.08)",
  "--entry-hover-border": "rgba(122, 228, 255, 0.16)",
  "--entry-hover-card-border": "rgba(102, 227, 255, 0.38)",
  "--entry-hover-card-shadow": "0 12px 24px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(0, 215, 255, 0.08)",
  "--entry-code-color": "#edf5ff",
  "--entry-code-shadow": "0 0 12px rgba(154, 241, 255, 0.12)",
  "--entry-limit-color": "#7ceaff",
  "--entry-limit-shadow": "0 0 12px rgba(124, 234, 255, 0.14)",
  "--entry-amount-positive-color": "#8ff6c1",
  "--entry-amount-positive-shadow": "0 0 14px rgba(107, 245, 165, 0.16)",
  "--entry-amount-negative-color": "#ff93a3",
  "--entry-amount-negative-shadow": "0 0 14px rgba(255, 93, 116, 0.18)",
  "--modal-panel-border": "rgba(126, 183, 255, 0.14)",
  "--modal-panel-bg":
    "linear-gradient(180deg, rgba(24, 26, 54, 0.985), rgba(18, 18, 42, 0.985)), radial-gradient(circle at top right, rgba(0, 215, 255, 0.05), transparent 26%)",
  "--modal-panel-shadow": "0 30px 70px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(53, 216, 255, 0.05)",
  "--settings-card-border": "rgba(255, 213, 74, 0.38)",
  "--settings-card-bg": "rgba(255, 255, 255, 0.02)",
  "--settings-card-shadow":
    "inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 16px 32px rgba(2, 6, 18, 0.18)",
  "--settings-card-title-color": "#ffe48b",
  "--settings-card-title-shadow": "0 0 14px rgba(255, 212, 82, 0.14)",
  "--field-border": "rgba(145, 182, 255, 0.2)",
  "--field-bg": "rgba(4, 19, 47, 0.9)",
  "--field-shadow":
    "inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 8px 18px rgba(2, 6, 18, 0.14)",
  "--field-text-color": "#f3f8ff",
  "--field-placeholder-color": "#8ea5c5",
  "--field-focus-border": "rgba(94, 229, 255, 0.7)",
  "--field-focus-ring": "rgba(53, 216, 255, 0.08)",
  "--field-focus-bg": "rgba(6, 24, 58, 0.96)",
  "--orb-1-bg": "rgba(0, 215, 255, 0.22)",
  "--orb-2-bg": "rgba(149, 79, 255, 0.18)",
  "--orb-1-blur": "40px",
  "--orb-2-blur": "40px",
  "--bg-grid-line": "rgba(255, 255, 255, 0.03)",
  "--bg-grid-opacity": "0.5",
  "--bg-grid-size": "44px",
  "--stat-ready-label-color": "#f3e6ba",
  "--stat-ready-label-shadow":
    "0 0 16px rgba(255, 212, 82, 0.22), 0 1px 0 rgba(255, 248, 222, 0.18)",
  "--stat-ready-value-color": "#ffd452",
  "--stat-ready-value-shadow": "0 0 14px rgba(255, 212, 82, 0.22), 0 0 34px rgba(255, 212, 82, 0.12)",
  "--stat-amount-value-color": "#ffd452",
  "--stat-amount-value-shadow": "0 0 14px rgba(255, 212, 82, 0.22), 0 0 34px rgba(255, 212, 82, 0.12)",
  "--bank-title-name-color": "#fff1c7",
  "--bank-title-name-shadow":
    "0 0 18px rgba(255, 212, 82, 0.22), 0 1px 0 rgba(255, 248, 222, 0.16)",
  "--bank-title-name-bg":
    "linear-gradient(180deg, rgba(255, 248, 222, 0.2), rgba(255, 255, 255, 0.06)), linear-gradient(90deg, rgba(255, 212, 82, 0.12), rgba(255, 241, 196, 0.08))",
  "--bank-title-name-border": "rgba(255, 231, 161, 0.34)",
  "--bank-title-name-box-shadow":
    "inset 0 1px 0 rgba(255, 248, 222, 0.2), 0 0 22px rgba(255, 212, 82, 0.1)",
  "--modal-backdrop-bg": "rgba(1, 6, 17, 0.72)",
  "--modal-header-bg":
    "linear-gradient(180deg, rgba(30, 28, 59, 0.985), rgba(22, 22, 47, 0.94)), radial-gradient(circle at top right, rgba(255, 212, 82, 0.06), transparent 28%)",
  "--modal-header-border": "rgba(255, 255, 255, 0.06)",
  "--modal-header-shadow": "0 10px 26px rgba(2, 6, 18, 0.2)",
  "--modal-description-color": "#cbd7ea",
  "--select-item-border": "rgba(115, 150, 235, 0.18)",
  "--select-item-bg":
    "linear-gradient(180deg, rgba(255, 255, 255, 0.038), rgba(255, 255, 255, 0.016)), linear-gradient(135deg, rgba(8, 23, 58, 0.84), rgba(9, 13, 34, 0.86))",
  "--select-item-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 14px 28px rgba(2, 6, 18, 0.16)",
  "--select-item-hover-border": "rgba(106, 224, 255, 0.34)",
  "--select-item-hover-shadow":
    "inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 18px 34px rgba(2, 6, 18, 0.2), 0 0 0 1px rgba(53, 216, 255, 0.05)",
  "--select-item-checked-border": "rgba(86, 222, 255, 0.42)",
  "--select-item-checked-bg":
    "linear-gradient(180deg, rgba(255, 255, 255, 0.048), rgba(255, 255, 255, 0.022)), linear-gradient(135deg, rgba(8, 32, 79, 0.88), rgba(10, 20, 52, 0.86))",
  "--select-item-checked-shadow":
    "inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 20px 36px rgba(2, 6, 18, 0.2), 0 0 0 1px rgba(53, 216, 255, 0.07), 0 0 24px rgba(53, 216, 255, 0.08)",
  "--select-title-color": "#eef5ff",
  "--select-title-active-color": "#f7fbff",
  "--select-title-active-shadow": "0 0 16px rgba(53, 216, 255, 0.12), 0 0 10px rgba(255, 255, 255, 0.04)",
  "--select-subitem-bg":
    "linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02)), rgba(255, 255, 255, 0.02)",
  "--select-subitem-border": "rgba(255, 255, 255, 0.05)",
  "--select-subitem-color": "#dbe5f6",
  "--select-subitem-hover-border": "rgba(255, 212, 82, 0.22)",
  "--select-subitem-hover-bg":
    "linear-gradient(180deg, rgba(255, 212, 82, 0.06), rgba(255, 255, 255, 0.02)), rgba(255, 255, 255, 0.025)",
  "--select-subitem-checked-border": "rgba(255, 212, 82, 0.42)",
  "--select-subitem-checked-bg":
    "linear-gradient(180deg, rgba(255, 212, 82, 0.1), rgba(255, 255, 255, 0.025)), rgba(255, 255, 255, 0.03)",
  "--select-subitem-checked-shadow": "0 0 0 1px rgba(255, 212, 82, 0.08), 0 8px 18px rgba(0, 0, 0, 0.14)",
  "--modal-footer-bg": "linear-gradient(180deg, rgba(19, 18, 44, 0.92), rgba(19, 18, 44, 0.98))",
  "--modal-footer-border": "rgba(255, 255, 255, 0.08)",
  "--modal-action-bar-border": "rgba(119, 150, 232, 0.14)",
  "--modal-action-bar-bg":
    "linear-gradient(180deg, rgba(25, 24, 58, 0.992), rgba(17, 18, 42, 0.96)), radial-gradient(circle at top right, rgba(0, 215, 255, 0.04), transparent 26%)",
  "--modal-action-bar-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 14px 28px rgba(2, 6, 18, 0.18)",
  "--form-label-color": "#dce6f8",
  "--settings-preview-bg": "rgba(255, 255, 255, 0.035)",
  "--settings-preview-border": "rgba(255, 255, 255, 0.07)",
  "--settings-preview-text": "#d5dfef",
  "--slideshow-field-border": "rgba(122, 202, 255, 0.18)",
  "--slideshow-field-bg":
    "linear-gradient(180deg, rgba(8, 24, 56, 0.8), rgba(5, 15, 37, 0.88)), linear-gradient(120deg, rgba(255, 255, 255, 0.025), transparent)",
  "--slideshow-field-before":
    "radial-gradient(circle at top right, rgba(255, 212, 82, 0.08), transparent 28%), linear-gradient(120deg, transparent 18%, rgba(255, 255, 255, 0.05) 50%, transparent 82%)",
  "--desktop-overlay-bg":
    "radial-gradient(circle at top right, rgba(91, 20, 194, 0.18), transparent 30%), radial-gradient(circle at 15% 20%, rgba(0, 214, 255, 0.08), transparent 22%), radial-gradient(circle at bottom left, rgba(0, 214, 255, 0.1), transparent 26%), linear-gradient(180deg, rgba(2, 13, 34, 0.56) 0%, rgba(5, 11, 27, 0.48) 52%, rgba(17, 5, 30, 0.58) 100%)",
};

const state = {
  data: null,
  persistRevision: 0,
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
    themeGalleryThemeId: "",
    themeGalleryPreviewMode: "all",
    themeGalleryMotionPreset: "calm",
    themeGalleryToneX: 50,
    themeGalleryToneY: 50,
    themeGalleryAnimatedWallpaperEnabled: true,
    themeGalleryBackgroundFinish: "glossy",
    liveWallpaperSpeed: "Normal",
    liveWallpaperColor: c_white,
    desktopBackgroundSource: "preset",
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
  themeGalleryModal: document.getElementById("theme-gallery-modal-backdrop"),
  openBankModal: document.getElementById("open-bank-modal"),
  openSettingsModal: document.getElementById("open-settings-modal"),
  openThemeGallery: document.getElementById("open-theme-gallery"),
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
  saveSettings: document.getElementById("save-settings"),
  backgroundSourceSelect: document.getElementById("background-source-select"),
  backgroundFitSelect: document.getElementById("background-fit-select"),
  backgroundImageInput: document.getElementById("background-image-input"),
  backgroundPasteZone: document.getElementById("background-paste-zone"),
  backgroundPresetGrid: document.getElementById("background-preset-grid"),
  backgroundPreview: document.getElementById("background-preview"),
  themeGalleryCurrentTheme: document.getElementById("theme-gallery-current-theme"),
  themeGalleryGrid: document.getElementById("theme-gallery-grid"),
  themeGalleryDetail: document.getElementById("theme-gallery-detail"),
  themeGalleryDetailBackdrop: document.getElementById("theme-gallery-detail-backdrop"),
  themeGalleryPreviewImage: document.getElementById("theme-gallery-preview-image"),
  themeGalleryPreviewTitle: document.getElementById("theme-gallery-preview-title"),
  themeGalleryPreviewKicker: document.getElementById("theme-gallery-preview-kicker"),
  themeGalleryPreviewCaptionTitle: document.getElementById("theme-gallery-preview-caption-title"),
  themeGalleryPreviewCaptionMode: document.getElementById("theme-gallery-preview-caption-mode"),
  themeGalleryColorPicker: document.getElementById("theme-gallery-color-picker"),
  themeGalleryColorSurface: document.getElementById("theme-gallery-color-surface"),
  themeGalleryColorHandle: document.getElementById("theme-gallery-color-handle"),
  themeGalleryColorLabel: document.getElementById("theme-gallery-color-label"),
  themeGalleryColorDescription: document.getElementById("theme-gallery-color-description"),
  themeGalleryWallpaperAnimated: document.getElementById("theme-gallery-wallpaper-animated"),
  themeGalleryWallpaperAnimatedDescription: document.getElementById("theme-gallery-wallpaper-animated-description"),
  themeGalleryWallpaperFinish: document.getElementById("theme-gallery-wallpaper-finish"),
  themeGalleryWallpaperFinishTitle: document.getElementById("theme-gallery-wallpaper-finish-title"),
  themeGalleryWallpaperFinishDescription: document.getElementById("theme-gallery-wallpaper-finish-description"),
  liveWallpaperConfigs: document.getElementById("live-wallpaper-configs"),
  themeGalleryModeLight: document.getElementById("theme-gallery-mode-light"),
  themeGalleryModeDark: document.getElementById("theme-gallery-mode-dark"),
  themeGalleryPreviewMode: document.getElementById("theme-gallery-preview-mode"),
  themeGalleryPreviewDescription: document.getElementById("theme-gallery-preview-description"),
  backThemeGalleryDetail: document.getElementById("back-theme-gallery-detail"),
  closeThemeGalleryDetail: document.getElementById("close-theme-gallery-detail"),
  closeThemeGallery: document.getElementById("close-theme-gallery"),
  applyThemeGallery: document.getElementById("apply-theme-gallery"),
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

  if (amount < 1000000) {
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

function isModalOpen(modal) {
  return modal instanceof HTMLElement && !modal.classList.contains("hidden");
}

function markSettingsFieldDirty(fieldName) {
  if (fieldName) {
    renderRuntime.settingsDirtyFields.add(fieldName);
  }
}

function clearSettingsFieldDirtyState() {
  renderRuntime.settingsDirtyFields.clear();
}

function setSaveSettingsButtonState(isSubmitting) {
  if (!(elements.saveSettings instanceof HTMLButtonElement)) {
    return;
  }

  elements.saveSettings.disabled = isSubmitting;
  elements.saveSettings.classList.toggle("is-submitting", isSubmitting);
  elements.saveSettings.textContent = isSubmitting ? "Saving..." : "Save & Extract";
}

function flushFirebaseSyncInBackground() {
  void flushFirebaseSync().catch((error) => {
    console.error("Firebase Sync background gagal.", error);
  });
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
  state.persistRevision = normalizePersistRevision(payload.persistRevision, state.persistRevision);
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
    themeGalleryThemeId: payload.uiSettings?.themeGalleryThemeId || "",
    themeGalleryPreviewMode: ["light", "dark", "all"].includes(payload.uiSettings?.themeGalleryPreviewMode)
      ? payload.uiSettings.themeGalleryPreviewMode
      : "all",
    themeGalleryMotionPreset: normalizeThemeGalleryMotionPreset(payload.uiSettings?.themeGalleryMotionPreset, "calm"),
    themeGalleryToneX: clampNumber(Number(payload.uiSettings?.themeGalleryToneX ?? 50), 0, 100),
    themeGalleryToneY: clampNumber(Number(payload.uiSettings?.themeGalleryToneY ?? 50), 0, 100),
    themeGalleryAnimatedWallpaperEnabled: payload.uiSettings?.themeGalleryAnimatedWallpaperEnabled !== false,
    themeGalleryBackgroundFinish: String(payload.uiSettings?.themeGalleryBackgroundFinish || "").trim().toLowerCase() === "doff"
      ? "doff"
      : "glossy",
    liveWallpaperSpeed: getLiveWallpaperSpeedPreset(payload.uiSettings?.liveWallpaperSpeed).label,
    liveWallpaperColor: normalizeHexColor(payload.uiSettings?.liveWallpaperColor, c_white),
    desktopBackgroundSource: normalizeDesktopBackgroundSource(
      payload.uiSettings?.desktopBackgroundSource,
      inferDesktopBackgroundSource(payload.uiSettings)
    ),
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

function normalizeDesktopBackgroundSource(value, fallback = "preset") {
  return ["theme", "preset", "custom"].includes(value) ? value : fallback;
}

function hasThemeGallerySelection(settings = state.uiSettings) {
  return Boolean(String(settings?.themeGalleryThemeId || "").trim());
}

function hasDesktopCustomBackground(settings = state.uiSettings) {
  return Boolean(settings?.desktopImageData || settings?.desktopImageRemoteUrl);
}

function hasDesktopPresetBackground(settings = state.uiSettings) {
  return Boolean(String(settings?.desktopImagePresetId || "").trim());
}

function inferDesktopBackgroundSource(settings = state.uiSettings) {
  if (hasDesktopCustomBackground(settings)) {
    return "custom";
  }
  if (hasDesktopPresetBackground(settings)) {
    return "preset";
  }
  if (hasThemeGallerySelection(settings)) {
    return "theme";
  }
  return "preset";
}

function getResolvedDesktopBackgroundSource(settings = state.uiSettings) {
  const explicitSource = normalizeDesktopBackgroundSource(
    settings?.desktopBackgroundSource,
    inferDesktopBackgroundSource(settings)
  );

  if (explicitSource === "custom" && hasDesktopCustomBackground(settings)) {
    return "custom";
  }
  if (explicitSource === "preset" && hasDesktopPresetBackground(settings)) {
    return "preset";
  }
  if (explicitSource === "theme" && hasThemeGallerySelection(settings)) {
    return "theme";
  }

  if (hasDesktopCustomBackground(settings)) {
    return "custom";
  }
  if (hasDesktopPresetBackground(settings)) {
    return "preset";
  }
  if (hasThemeGallerySelection(settings)) {
    return "theme";
  }

  return "preset";
}

function getDesktopBackgroundSourceLabel(source = getResolvedDesktopBackgroundSource()) {
  switch (source) {
    case "theme":
      return "Theme Gallery";
    case "custom":
      return "Upload / Paste";
    case "preset":
    default:
      return "Built-in";
  }
}

function normalizeBackgroundSelection() {
  state.uiSettings.desktopBackgroundSource = normalizeDesktopBackgroundSource(
    state.uiSettings.desktopBackgroundSource,
    inferDesktopBackgroundSource()
  );
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
  } else if (getResolvedDesktopBackgroundSource() === "preset" || !hasDesktopCustomBackground()) {
    state.uiSettings.desktopImagePresetId = presets[0].id;
  }

  state.uiSettings.desktopBackgroundSource = getResolvedDesktopBackgroundSource();
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

const OPERA_WALLPAPER_THEME_CONFIGS = [
  { id: "opera-canvas-01", title: "Opera Canvas 01", mode: "dark mode", description: "Wallpaper Opera source 01 dengan nuansa retro desktop yang gelap.", imagePath: "./assets/opera-wallpapers/opera-01.png", accent: "#d79bff", tint: "#221d37", highlight: "#ffd39b" },
  { id: "opera-canvas-02", title: "Opera Canvas 02", mode: "light mode", description: "Wallpaper Opera source 02 dengan ilustrasi tropis yang terang dan bersih.", imagePath: "./assets/opera-wallpapers/opera-02.png", accent: "#1dbcc0", tint: "#4b8b6f", highlight: "#ffbc3a" },
  { id: "opera-canvas-03", title: "Opera Canvas 03", mode: "light mode", description: "Wallpaper Opera source 03 dengan taman futuristik cerah dan vibe airy.", imagePath: "./assets/opera-wallpapers/opera-03.png", accent: "#7bc7ff", tint: "#5f86af", highlight: "#ffffff" },
  { id: "opera-canvas-04", title: "Opera Canvas 04", mode: "dark mode", description: "Wallpaper Opera source 04 dengan tekstur satin gelap minimalis.", imagePath: "./assets/opera-wallpapers/opera-04.png", accent: "#8f96b3", tint: "#10131f", highlight: "#d9dde8" },
  { id: "opera-canvas-05", title: "Opera Canvas 05", mode: "all modes", description: "Wallpaper Opera source 05 dengan nuansa artistik yang fleksibel untuk semua mode.", imagePath: "./assets/opera-wallpapers/opera-05.png", accent: "#c889ff", tint: "#2d2447", highlight: "#ffe1aa" },
  { id: "opera-canvas-06", title: "Opera Canvas 06", mode: "all modes", description: "Wallpaper Opera source 06 dengan sapuan metalik premium dan glow halus.", imagePath: "./assets/opera-wallpapers/opera-06.png", accent: "#d8b276", tint: "#4f556d", highlight: "#fff4d1" },
  { id: "opera-canvas-07", title: "Opera Canvas 07", mode: "all modes", description: "Wallpaper Opera source 07 dengan warna neon penuh energi dan sangat hidup.", imagePath: "./assets/opera-wallpapers/opera-07.png", accent: "#7a4dff", tint: "#22466f", highlight: "#f0ff5f" },
  { id: "opera-canvas-08", title: "Opera Canvas 08", mode: "dark mode", description: "Wallpaper Opera source 08 dengan fokus gelap dan aksen dramatis.", imagePath: "./assets/opera-wallpapers/opera-08.png", accent: "#ff8ab6", tint: "#251935", highlight: "#ffdba0" },
  { id: "opera-canvas-09", title: "Opera Canvas 09", mode: "dark mode", description: "Wallpaper Opera source 09 bernuansa gelap dengan aksen elegan.", imagePath: "./assets/opera-wallpapers/opera-09.png", accent: "#7a84ff", tint: "#1b213c", highlight: "#ffda97" },
  { id: "opera-canvas-10", title: "Opera Canvas 10", mode: "all modes", description: "Wallpaper Opera source 10 dengan komposisi visual modern dan fleksibel.", imagePath: "./assets/opera-wallpapers/opera-10.png", accent: "#56d4ff", tint: "#254161", highlight: "#ffb883" },
  { id: "opera-canvas-11", title: "Opera Canvas 11", mode: "light mode", description: "Wallpaper Opera source 11 dengan nuansa soft terang dan warna halus.", imagePath: "./assets/opera-wallpapers/opera-11.png", accent: "#8ab1ff", tint: "#7a86a8", highlight: "#ffffff" },
  { id: "opera-canvas-12", title: "Opera Canvas 12", mode: "light mode", description: "Wallpaper Opera source 12 dengan rasa clean, modern, dan penuh ruang.", imagePath: "./assets/opera-wallpapers/opera-12.png", accent: "#e6a16a", tint: "#7ea39c", highlight: "#fff5cc" },
  { id: "opera-canvas-13", title: "Opera Canvas 13", mode: "dark mode", description: "Wallpaper Opera source 13 dengan tone gelap premium dan cahaya fokus.", imagePath: "./assets/opera-wallpapers/opera-13.png", accent: "#b884ff", tint: "#221c32", highlight: "#f0d7ff" },
  { id: "opera-canvas-14", title: "Opera Canvas 14", mode: "light mode", description: "Wallpaper Opera source 14 dengan palette lembut dan kesan glossy ringan.", imagePath: "./assets/opera-wallpapers/opera-14.png", accent: "#f0b1d6", tint: "#8c86b0", highlight: "#fffaf8" },
  { id: "opera-canvas-15", title: "Opera Canvas 15", mode: "all modes", description: "Wallpaper Opera source 15 dengan tampilan modern berwarna dan seimbang.", imagePath: "./assets/opera-wallpapers/opera-15.png", accent: "#6fd4ff", tint: "#34506c", highlight: "#ffd38f" },
  { id: "opera-canvas-16", title: "Opera Canvas 16", mode: "light mode", description: "Wallpaper Opera source 16 dengan ilustrasi cerah dan karakter ringan.", imagePath: "./assets/opera-wallpapers/opera-16.png", accent: "#7cc7c0", tint: "#7f93ab", highlight: "#ffffff" },
  { id: "opera-canvas-17", title: "Opera Canvas 17", mode: "dark mode", description: "Wallpaper Opera source 17 dengan vibe urban gelap dan kontras lembut.", imagePath: "./assets/opera-wallpapers/opera-17.png", accent: "#7f9dff", tint: "#202743", highlight: "#ffd2a3" },
  { id: "opera-canvas-18", title: "Opera Canvas 18", mode: "dark mode", description: "Wallpaper Opera source 18 dengan tekstur malam halus dan glow premium.", imagePath: "./assets/opera-wallpapers/opera-18.png", accent: "#9a8cff", tint: "#1b1d31", highlight: "#ffe0a8" },
  { id: "opera-canvas-19", title: "Opera Canvas 19", mode: "all modes", description: "Wallpaper Opera source 19 dengan warna coral-lilac dan nuansa artistik.", imagePath: "./assets/opera-wallpapers/opera-19.png", accent: "#ff8ea4", tint: "#6b4575", highlight: "#ffd9a3" },
  { id: "opera-canvas-20", title: "Opera Canvas 20", mode: "all modes", description: "Wallpaper Opera source 20 dengan komposisi wallpaper premium yang fleksibel.", imagePath: "./assets/opera-wallpapers/opera-20.png", accent: "#65d6ff", tint: "#355170", highlight: "#fff1cf" },
  { id: "opera-canvas-21", title: "Opera Canvas 21", mode: "light mode", description: "Wallpaper Opera source 21 dengan nuansa natural terang dan segar.", imagePath: "./assets/opera-wallpapers/opera-21.png", accent: "#7dd6a6", tint: "#6a9a8e", highlight: "#ffffff" },
  { id: "opera-canvas-22", title: "Opera Canvas 22", mode: "dark mode", description: "Wallpaper Opera source 22 dengan rasa velvet gelap dan aksen tajam.", imagePath: "./assets/opera-wallpapers/opera-22.png", accent: "#a77dff", tint: "#231b34", highlight: "#f3dcff" },
  { id: "opera-canvas-23", title: "Opera Canvas 23", mode: "light mode", description: "Wallpaper Opera source 23 dengan tone porselen terang dan lembut.", imagePath: "./assets/opera-wallpapers/opera-23.png", accent: "#d8a6c9", tint: "#8e87a8", highlight: "#fffdfa" },
  { id: "opera-canvas-24", title: "Opera Canvas 24", mode: "all modes", description: "Wallpaper Opera source 24 dengan style cyber botanica dan warna hidup.", imagePath: "./assets/opera-wallpapers/opera-24.png", accent: "#54d4ff", tint: "#285268", highlight: "#ffe67a" },
  { id: "opera-canvas-25", title: "Opera Canvas 25", mode: "dark mode", description: "Wallpaper Opera source 25 dengan sapuan gelap cinematic dan glow tipis.", imagePath: "./assets/opera-wallpapers/opera-25.png", accent: "#c898ff", tint: "#1d1b29", highlight: "#ffd1a2" },
];

function buildThemeGalleryWallpaperBackground(imagePath, topColor, bottomColor, accent, highlight, accentAlpha, highlightAlpha) {
  return `linear-gradient(180deg, ${topColor} 0%, ${bottomColor} 100%), radial-gradient(circle at 16% 18%, ${rgbaFromHex(accent, accentAlpha)}, transparent 24%), radial-gradient(circle at 82% 14%, ${rgbaFromHex(highlight, highlightAlpha)}, transparent 20%), url("${imagePath}") center center / cover no-repeat`;
}

function createThemeGalleryWallpaperTheme(config) {
  const themeCategory = getThemeGalleryModeCategory({ mode: config.mode });
  const tint = normalizeHexColor(config.tint, "#1b2234");
  const accent = normalizeHexColor(config.accent, "#8f7cff");
  const highlight = normalizeHexColor(config.highlight, "#ffe1a8");
  const imagePath = String(config.imagePath || "").trim();

  const cardTop = themeCategory === "dark" ? rgbaFromHex(tint, 0.08) : themeCategory === "light" ? "rgba(255, 255, 255, 0.04)" : rgbaFromHex(accent, 0.04);
  const cardBottom = themeCategory === "dark" ? rgbaFromHex(tint, 0.34) : themeCategory === "light" ? "rgba(255, 255, 255, 0.2)" : rgbaFromHex(tint, 0.16);
  const detailTop = themeCategory === "dark" ? rgbaFromHex(tint, 0.06) : themeCategory === "light" ? "rgba(255, 255, 255, 0.02)" : rgbaFromHex(accent, 0.03);
  const detailBottom = themeCategory === "dark" ? rgbaFromHex(tint, 0.22) : themeCategory === "light" ? "rgba(255, 255, 255, 0.12)" : rgbaFromHex(tint, 0.12);
  const previewTop = themeCategory === "dark" ? rgbaFromHex(tint, 0.04) : themeCategory === "light" ? "rgba(255, 255, 255, 0.02)" : rgbaFromHex(accent, 0.02);
  const previewBottom = themeCategory === "dark" ? rgbaFromHex(tint, 0.18) : themeCategory === "light" ? "rgba(255, 255, 255, 0.1)" : rgbaFromHex(tint, 0.1);
  const dashboardTop = themeCategory === "dark" ? rgbaFromHex(tint, 0.16) : themeCategory === "light" ? "rgba(255, 255, 255, 0.14)" : rgbaFromHex(tint, 0.1);
  const dashboardBottom = themeCategory === "dark" ? rgbaFromHex(tint, 0.3) : themeCategory === "light" ? "rgba(255, 255, 255, 0.06)" : rgbaFromHex(tint, 0.16);
  const overlayOpacity = themeCategory === "light" ? "0.11" : themeCategory === "dark" ? "0.06" : "0.08";

  return {
    id: config.id,
    title: config.title,
    mode: config.mode,
    description: config.description,
    imagePath,
    wallpaperMotionEligible: true,
    cardBackground: buildThemeGalleryWallpaperBackground(imagePath, cardTop, cardBottom, accent, highlight, 0.12, 0.08),
    detailBackdrop: buildThemeGalleryWallpaperBackground(imagePath, detailTop, detailBottom, accent, highlight, 0.1, 0.06),
    previewBackground: buildThemeGalleryWallpaperBackground(imagePath, previewTop, previewBottom, accent, highlight, 0.1, 0.06),
    dashboardBackground: buildThemeGalleryWallpaperBackground(imagePath, dashboardTop, dashboardBottom, accent, highlight, 0.08, 0.05),
    overlayOpacity,
  };
}

const THEME_GALLERY_THEMES = [
  {
    id: "default-dashboard",
    title: "Default Dashboard",
    mode: "all modes",
    description: "Tema asli dashboard dengan nuansa cyan-gold dan tampilan gelap premium.",
    cardBackground:
      "radial-gradient(circle at 18% 20%, rgba(54,216,255,0.34), transparent 18%), radial-gradient(circle at 82% 16%, rgba(255,212,82,0.24), transparent 18%), linear-gradient(145deg, #07142f 0%, #0f2c56 42%, #050d22 100%)",
    detailBackdrop:
      "radial-gradient(circle at 18% 22%, rgba(53,216,255,0.14), transparent 18%), radial-gradient(circle at 82% 16%, rgba(255,212,82,0.12), transparent 18%), linear-gradient(145deg, #07142f 0%, #0d2750 42%, #050d22 100%)",
    previewBackground:
      "radial-gradient(circle at 18% 22%, rgba(53,216,255,0.18), transparent 18%), radial-gradient(circle at 82% 16%, rgba(255,212,82,0.14), transparent 18%), linear-gradient(145deg, #07142f 0%, #123164 42%, #050d22 100%)",
    dashboardBackground:
      "radial-gradient(circle at top right, rgba(91,20,194,0.18), transparent 30%), radial-gradient(circle at 15% 20%, rgba(0,214,255,0.08), transparent 22%), radial-gradient(circle at bottom left, rgba(0,214,255,0.1), transparent 26%), linear-gradient(180deg, rgba(2,13,34,0.56) 0%, rgba(5,11,27,0.48) 52%, rgba(17,5,30,0.58) 100%)",
    overlayOpacity: "1",
  },
  {
    id: "classic",
    title: "Classic",
    mode: "all modes",
    description: "Sapuan ungu lembut dengan nuansa satin terang yang tenang dan elegan.",
    cardBackground:
      "linear-gradient(145deg, #efeaf7 0%, #f6f0e9 24%, #d3c9ff 52%, #b394ff 76%, #f8f4ff 100%)",
    detailBackdrop:
      "radial-gradient(circle at 12% 18%, rgba(255,255,255,0.66), transparent 22%), linear-gradient(140deg, #f4efe9 0%, #ece5fb 28%, #c7b5ff 58%, #9570ff 78%, #f7f4ff 100%)",
    previewBackground:
      "radial-gradient(circle at 18% 22%, rgba(255,255,255,0.52), transparent 18%), linear-gradient(140deg, #f2ede8 0%, #eee6fb 30%, #d2c3ff 56%, #b292ff 78%, #f7f4ff 100%)",
    dashboardBackground:
      "radial-gradient(circle at top left, rgba(255,255,255,0.18), transparent 18%), linear-gradient(135deg, #efe8f8 0%, #d4c4ff 34%, #9f86ff 62%, #f8f3ff 100%)",
    overlayOpacity: "0.12",
  },
  {
    id: "aurora",
    title: "Aurora",
    mode: "dark mode",
    description: "Gelombang biru gelap dengan cahaya neon lembut seperti langit malam kutub.",
    cardBackground:
      "radial-gradient(circle at 30% 75%, rgba(72,146,255,0.42), transparent 28%), linear-gradient(145deg, #06111f 0%, #10234b 38%, #1a2b89 62%, #030712 100%)",
    detailBackdrop:
      "radial-gradient(circle at 18% 80%, rgba(77,168,255,0.26), transparent 24%), linear-gradient(145deg, #040b18 0%, #0f2143 34%, #163b72 66%, #02040a 100%)",
    previewBackground:
      "radial-gradient(circle at 24% 72%, rgba(77,168,255,0.28), transparent 22%), linear-gradient(145deg, #07101f 0%, #10234b 38%, #1e3677 70%, #04070f 100%)",
    dashboardBackground:
      "radial-gradient(circle at 20% 80%, rgba(72,146,255,0.18), transparent 20%), linear-gradient(145deg, #06111f 0%, #10234b 40%, #162869 72%, #030712 100%)",
    overlayOpacity: "0.08",
  },
  {
    id: "midsommar",
    title: "Midsommar",
    mode: "light mode",
    description: "Campuran pastel terang dengan gradasi halus yang hangat dan ringan.",
    cardBackground:
      "radial-gradient(circle at 78% 30%, rgba(255,210,218,0.78), transparent 24%), linear-gradient(145deg, #edf7f0 0%, #d7eef8 30%, #f3e0ee 62%, #fff0d9 100%)",
    detailBackdrop:
      "radial-gradient(circle at 20% 18%, rgba(255,255,255,0.58), transparent 20%), linear-gradient(145deg, #eef7f1 0%, #d7edf9 30%, #f2deed 64%, #ffeecf 100%)",
    previewBackground:
      "radial-gradient(circle at 80% 24%, rgba(255,207,219,0.72), transparent 22%), linear-gradient(145deg, #ecf7ef 0%, #d8eef7 28%, #f0ddeb 62%, #fff0d4 100%)",
    dashboardBackground:
      "radial-gradient(circle at 76% 26%, rgba(255,210,218,0.2), transparent 18%), linear-gradient(145deg, #edf7f1 0%, #d9eef8 36%, #f2e2ee 68%, #fff1d8 100%)",
    overlayOpacity: "0.1",
  },
  {
    id: "matchday",
    title: "Matchday",
    mode: "all modes",
    description: "Energi warna olahraga modern dengan panel merah, ungu, dan biru yang dinamis.",
    cardBackground:
      "linear-gradient(125deg, #ff3b61 0%, #ffd2a4 18%, #7c2ee6 52%, #13296b 100%)",
    detailBackdrop:
      "radial-gradient(circle at 82% 20%, rgba(255,200,150,0.22), transparent 16%), linear-gradient(125deg, #c3264a 0%, #ffcea1 18%, #7530da 54%, #102050 100%)",
    previewBackground:
      "radial-gradient(circle at 78% 22%, rgba(255,208,160,0.2), transparent 18%), linear-gradient(125deg, #db3154 0%, #ffd4aa 18%, #7a30df 54%, #11235c 100%)",
    dashboardBackground:
      "radial-gradient(circle at 84% 20%, rgba(255,200,150,0.16), transparent 14%), linear-gradient(125deg, #a81f3f 0%, #f7b47d 20%, #642ec9 56%, #0b1842 100%)",
    overlayOpacity: "0.08",
  },
  {
    id: "interstellar",
    title: "Interstellar",
    mode: "all modes",
    description: "Tema kosmik dramatis dengan nebula hangat, debu bintang, dan planet besar.",
    cardBackground:
      "radial-gradient(circle at 18% 70%, rgba(255,240,210,0.42), transparent 16%), radial-gradient(circle at 72% 18%, rgba(255,180,152,0.36), transparent 24%), linear-gradient(135deg, #302228 0%, #8c6558 42%, #f7d2bf 74%, #3f2b29 100%)",
    detailBackdrop:
      "radial-gradient(circle at 14% 76%, rgba(255,245,225,0.26), transparent 14%), radial-gradient(circle at 76% 20%, rgba(255,186,154,0.24), transparent 18%), linear-gradient(135deg, #2d2228 0%, #8f685b 42%, #f2cfc0 76%, #352424 100%)",
    previewBackground:
      "radial-gradient(circle at 20% 74%, rgba(255,243,217,0.26), transparent 14%), radial-gradient(circle at 76% 18%, rgba(255,186,154,0.22), transparent 18%), linear-gradient(135deg, #36272b 0%, #926d63 44%, #f3d6c7 78%, #382727 100%)",
    dashboardBackground:
      "radial-gradient(circle at 15% 75%, rgba(255,245,225,0.12), transparent 12%), radial-gradient(circle at 76% 20%, rgba(255,186,154,0.16), transparent 14%), linear-gradient(135deg, #2a2025 0%, #7b5e57 40%, #eec4b3 72%, #2f2121 100%)",
    overlayOpacity: "0.06",
  },
  {
    id: "metamorphic",
    title: "Metamorphic",
    mode: "all modes",
    description: "Kilau kristal hitam dan ungu dengan refleksi futuristik yang kontras.",
    cardBackground:
      "radial-gradient(circle at 72% 32%, rgba(255,255,255,0.18), transparent 16%), linear-gradient(140deg, #040608 0%, #2b1a5f 28%, #0f1333 54%, #e5dff8 100%)",
    detailBackdrop:
      "radial-gradient(circle at 72% 30%, rgba(255,255,255,0.12), transparent 14%), linear-gradient(140deg, #020306 0%, #261854 30%, #0e1535 56%, #d7d0f0 100%)",
    previewBackground:
      "radial-gradient(circle at 68% 28%, rgba(255,255,255,0.14), transparent 14%), linear-gradient(140deg, #05070b 0%, #2b1a5f 28%, #12173b 56%, #ddd6f6 100%)",
    dashboardBackground:
      "radial-gradient(circle at 72% 28%, rgba(255,255,255,0.08), transparent 10%), linear-gradient(140deg, #030507 0%, #24194d 30%, #0c112f 58%, #cfc9eb 100%)",
    overlayOpacity: "0.08",
  },
  {
    id: "sonic",
    title: "Sonic",
    mode: "dark mode",
    description: "Cahaya lengkung biru-putih pada latar gelap, tajam, dan sangat modern.",
    cardBackground:
      "radial-gradient(circle at 45% 45%, rgba(205,236,255,0.95), transparent 8%), radial-gradient(circle at 50% 50%, rgba(160,220,255,0.28), transparent 22%), linear-gradient(145deg, #11181f 0%, #213448 38%, #0d1219 100%)",
    detailBackdrop:
      "radial-gradient(circle at 46% 44%, rgba(205,236,255,0.8), transparent 7%), radial-gradient(circle at 50% 50%, rgba(160,220,255,0.2), transparent 18%), linear-gradient(145deg, #0d1218 0%, #1b2e3f 38%, #090d12 100%)",
    previewBackground:
      "radial-gradient(circle at 46% 44%, rgba(205,236,255,0.86), transparent 7%), radial-gradient(circle at 50% 50%, rgba(160,220,255,0.22), transparent 18%), linear-gradient(145deg, #10161d 0%, #203445 38%, #0b1015 100%)",
    dashboardBackground:
      "radial-gradient(circle at 48% 46%, rgba(205,236,255,0.18), transparent 6%), linear-gradient(145deg, #10161d 0%, #203445 42%, #0b1015 100%)",
    overlayOpacity: "0.08",
  },
  {
    id: "radiance",
    title: "Radiance",
    mode: "dark mode",
    description: "Debu cahaya kosmik ungu-biru dengan kilau partikel yang dalam.",
    cardBackground:
      "radial-gradient(circle at 74% 78%, rgba(255,176,92,0.38), transparent 14%), radial-gradient(circle at 26% 20%, rgba(255,255,255,0.12), transparent 18%), linear-gradient(145deg, #1c1132 0%, #412e8e 46%, #071425 100%)",
    detailBackdrop:
      "radial-gradient(circle at 74% 78%, rgba(255,176,92,0.28), transparent 14%), linear-gradient(145deg, #170e2a 0%, #3a2b82 46%, #06111f 100%)",
    previewBackground:
      "radial-gradient(circle at 72% 76%, rgba(255,176,92,0.3), transparent 14%), linear-gradient(145deg, #1a1030 0%, #3d2e87 46%, #061322 100%)",
    dashboardBackground:
      "radial-gradient(circle at 72% 76%, rgba(255,176,92,0.16), transparent 12%), linear-gradient(145deg, #160d28 0%, #332671 46%, #06111f 100%)",
    overlayOpacity: "0.08",
  },
  {
    id: "orbit",
    title: "Orbit",
    mode: "light mode",
    description: "Kabut lilac terang dengan tekstur lembut dan pusat cahaya putih.",
    cardBackground:
      "radial-gradient(circle at 62% 34%, rgba(255,255,255,0.88), transparent 12%), linear-gradient(145deg, #eadcf8 0%, #cfb7ff 34%, #c9d5ff 62%, #ffffff 100%)",
    detailBackdrop:
      "radial-gradient(circle at 60% 32%, rgba(255,255,255,0.76), transparent 12%), linear-gradient(145deg, #eadcf8 0%, #cfb7ff 34%, #c7d3ff 62%, #fbfdff 100%)",
    previewBackground:
      "radial-gradient(circle at 60% 30%, rgba(255,255,255,0.8), transparent 12%), linear-gradient(145deg, #e9ddf8 0%, #d1bafc 34%, #c9d5ff 62%, #ffffff 100%)",
    dashboardBackground:
      "radial-gradient(circle at 58% 30%, rgba(255,255,255,0.18), transparent 10%), linear-gradient(145deg, #e7dbf4 0%, #c8b0fa 34%, #c1cdf7 62%, #f7fbff 100%)",
    overlayOpacity: "0.1",
  },
  {
    id: "web-rewind",
    title: "Web Rewind",
    mode: "all modes",
    description: "Nuansa retro digital dengan monitor klasik dan cahaya violet kebiruan.",
    cardBackground:
      "linear-gradient(145deg, #dcdce7 0%, #a6b0c4 22%, #2a2a44 52%, #8f84cf 100%)",
    detailBackdrop:
      "radial-gradient(circle at 60% 38%, rgba(164,174,255,0.18), transparent 16%), linear-gradient(145deg, #d8d9e3 0%, #a8b0c6 22%, #25263f 52%, #877cc8 100%)",
    previewBackground:
      "radial-gradient(circle at 60% 38%, rgba(164,174,255,0.18), transparent 16%), linear-gradient(145deg, #d8d9e3 0%, #a7afc6 22%, #23243b 52%, #8578c6 100%)",
    dashboardBackground:
      "radial-gradient(circle at 60% 38%, rgba(164,174,255,0.12), transparent 14%), linear-gradient(145deg, #c7c9d8 0%, #8d97b0 22%, #1f2238 52%, #776db7 100%)",
    overlayOpacity: "0.09",
  },
  {
    id: "mirage",
    title: "Mirage",
    mode: "dark mode",
    description: "Gelombang hitam dengan highlight tipis keemasan seperti laut malam.",
    cardBackground:
      "radial-gradient(circle at 60% 38%, rgba(255,220,178,0.14), transparent 16%), linear-gradient(145deg, #05070a 0%, #14181e 42%, #020304 100%)",
    detailBackdrop:
      "radial-gradient(circle at 58% 38%, rgba(255,220,178,0.12), transparent 14%), linear-gradient(145deg, #030507 0%, #11151b 42%, #010203 100%)",
    previewBackground:
      "radial-gradient(circle at 58% 38%, rgba(255,220,178,0.12), transparent 14%), linear-gradient(145deg, #040609 0%, #13171d 42%, #020304 100%)",
    dashboardBackground:
      "radial-gradient(circle at 58% 38%, rgba(255,220,178,0.08), transparent 12%), linear-gradient(145deg, #040609 0%, #12161b 42%, #020304 100%)",
    overlayOpacity: "0.07",
  },
  {
    id: "cyberroom",
    title: "Cyberroom",
    mode: "dark mode",
    description: "Interior neon futuristik dengan kombinasi cyan-oranye yang sinematik.",
    cardBackground:
      "radial-gradient(circle at 22% 18%, rgba(147,244,255,0.4), transparent 18%), radial-gradient(circle at 76% 14%, rgba(255,162,92,0.42), transparent 18%), linear-gradient(145deg, #0f1a27 0%, #2e4154 46%, #0b1118 100%)",
    detailBackdrop:
      "radial-gradient(circle at 22% 18%, rgba(147,244,255,0.26), transparent 18%), radial-gradient(circle at 76% 14%, rgba(255,162,92,0.28), transparent 18%), linear-gradient(145deg, #0d1723 0%, #283a4c 46%, #091017 100%)",
    previewBackground:
      "radial-gradient(circle at 22% 18%, rgba(147,244,255,0.28), transparent 18%), radial-gradient(circle at 76% 14%, rgba(255,162,92,0.3), transparent 18%), linear-gradient(145deg, #101a27 0%, #2d4054 46%, #0b1118 100%)",
    dashboardBackground:
      "radial-gradient(circle at 22% 18%, rgba(147,244,255,0.14), transparent 16%), radial-gradient(circle at 76% 14%, rgba(255,162,92,0.14), transparent 16%), linear-gradient(145deg, #0d1723 0%, #243545 46%, #091017 100%)",
    overlayOpacity: "0.08",
  },
  {
    id: "velvet-dusk",
    title: "Velvet Dusk",
    mode: "all modes",
    description: "Wallpaper ungu beludru dengan cahaya lembut dan nuansa premium ala Opera.",
    cardBackground:
      "radial-gradient(circle at 22% 26%, rgba(255,214,244,0.24), transparent 18%), radial-gradient(circle at 78% 18%, rgba(255,255,255,0.16), transparent 14%), linear-gradient(145deg, #25153d 0%, #6f3f9f 42%, #d199d6 72%, #2a163e 100%)",
    detailBackdrop:
      "radial-gradient(circle at 18% 24%, rgba(255,222,246,0.16), transparent 18%), linear-gradient(145deg, #261540 0%, #74449f 44%, #d29dd8 74%, #311944 100%)",
    previewBackground:
      "radial-gradient(circle at 24% 26%, rgba(255,234,247,0.28), transparent 18%), radial-gradient(circle at 82% 14%, rgba(255,255,255,0.12), transparent 12%), linear-gradient(145deg, #2b1845 0%, #7b46a8 44%, #d7a6df 74%, #331b4a 100%)",
    dashboardBackground:
      "radial-gradient(circle at 18% 24%, rgba(255,224,246,0.18), transparent 14%), linear-gradient(145deg, #221238 0%, #61378d 42%, #c68bd0 72%, #24143a 100%)",
    overlayOpacity: "0.07",
  },
  {
    id: "pearl-bloom",
    title: "Pearl Bloom",
    mode: "light mode",
    description: "Wallpaper putih-mutiara dengan blush pink dan lavender yang sangat lembut.",
    cardBackground:
      "radial-gradient(circle at 24% 20%, rgba(255,255,255,0.78), transparent 22%), radial-gradient(circle at 78% 28%, rgba(255,210,230,0.64), transparent 20%), linear-gradient(145deg, #fffaf7 0%, #f6eefb 34%, #e1dcff 68%, #ffe8ef 100%)",
    detailBackdrop:
      "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.86), transparent 22%), linear-gradient(145deg, #fffaf7 0%, #f5edfb 36%, #e1dbff 70%, #ffe9ef 100%)",
    previewBackground:
      "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.88), transparent 22%), radial-gradient(circle at 82% 30%, rgba(255,214,232,0.56), transparent 20%), linear-gradient(145deg, #fffaf8 0%, #f4edfb 34%, #e0dcff 68%, #ffe9ef 100%)",
    dashboardBackground:
      "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.5), transparent 18%), linear-gradient(145deg, #fff8f5 0%, #f2ebfb 34%, #d8d5ff 68%, #ffe5ee 100%)",
    overlayOpacity: "0.11",
  },
  {
    id: "alpine-mist",
    title: "Alpine Mist",
    mode: "light mode",
    description: "Kabut biru es dengan nuansa clean, airy, dan sangat terang seperti wallpaper browser modern.",
    cardBackground:
      "radial-gradient(circle at 76% 20%, rgba(255,255,255,0.72), transparent 18%), radial-gradient(circle at 18% 74%, rgba(171,212,255,0.42), transparent 24%), linear-gradient(145deg, #f7fbff 0%, #d9e7f8 36%, #bccde9 68%, #f7faff 100%)",
    detailBackdrop:
      "radial-gradient(circle at 76% 20%, rgba(255,255,255,0.66), transparent 16%), linear-gradient(145deg, #f5faff 0%, #d6e4f7 38%, #bacce8 70%, #f5f9ff 100%)",
    previewBackground:
      "radial-gradient(circle at 76% 20%, rgba(255,255,255,0.7), transparent 16%), radial-gradient(circle at 16% 72%, rgba(177,216,255,0.34), transparent 22%), linear-gradient(145deg, #f7fbff 0%, #d7e5f8 36%, #bfd0ea 70%, #f6faff 100%)",
    dashboardBackground:
      "radial-gradient(circle at 76% 20%, rgba(255,255,255,0.28), transparent 14%), linear-gradient(145deg, #f3f9ff 0%, #d2e1f5 36%, #b6c7e4 70%, #eef5ff 100%)",
    overlayOpacity: "0.12",
  },
  {
    id: "lunar-petal",
    title: "Lunar Petal",
    mode: "all modes",
    description: "Perpaduan floral-lilac dan moonlight glow dengan nuansa halus seperti wallpaper premium.",
    cardBackground:
      "radial-gradient(circle at 70% 26%, rgba(255,255,255,0.48), transparent 16%), radial-gradient(circle at 26% 72%, rgba(247,194,255,0.38), transparent 20%), linear-gradient(145deg, #221834 0%, #7b5ca3 44%, #dcb8ef 72%, #1e152d 100%)",
    detailBackdrop:
      "radial-gradient(circle at 68% 26%, rgba(255,255,255,0.36), transparent 14%), linear-gradient(145deg, #241a38 0%, #7e61a6 46%, #ddbdf0 74%, #201731 100%)",
    previewBackground:
      "radial-gradient(circle at 70% 24%, rgba(255,255,255,0.42), transparent 14%), radial-gradient(circle at 24% 74%, rgba(246,196,255,0.34), transparent 18%), linear-gradient(145deg, #271c3d 0%, #8466ad 46%, #e1c3f3 74%, #231833 100%)",
    dashboardBackground:
      "radial-gradient(circle at 68% 24%, rgba(255,255,255,0.18), transparent 12%), linear-gradient(145deg, #20152f 0%, #705394 44%, #d3a9e6 74%, #1b1227 100%)",
    overlayOpacity: "0.08",
  },
  {
    id: "night-drive",
    title: "Night Drive",
    mode: "dark mode",
    description: "Nuansa malam kota dengan kilau magenta-biru seperti wallpaper otomotif futuristik.",
    cardBackground:
      "radial-gradient(circle at 24% 18%, rgba(60,223,255,0.24), transparent 18%), radial-gradient(circle at 82% 78%, rgba(255,96,170,0.2), transparent 18%), linear-gradient(145deg, #050913 0%, #13213d 34%, #531f6d 68%, #090d17 100%)",
    detailBackdrop:
      "radial-gradient(circle at 24% 18%, rgba(60,223,255,0.18), transparent 16%), linear-gradient(145deg, #060a14 0%, #14223d 36%, #4e1f67 68%, #090d16 100%)",
    previewBackground:
      "radial-gradient(circle at 24% 18%, rgba(60,223,255,0.18), transparent 16%), radial-gradient(circle at 82% 78%, rgba(255,96,170,0.18), transparent 16%), linear-gradient(145deg, #070c16 0%, #162642 36%, #56216f 68%, #0a0e18 100%)",
    dashboardBackground:
      "radial-gradient(circle at 24% 18%, rgba(60,223,255,0.1), transparent 14%), radial-gradient(circle at 82% 78%, rgba(255,96,170,0.1), transparent 14%), linear-gradient(145deg, #050913 0%, #121e36 36%, #431a59 68%, #080b13 100%)",
    overlayOpacity: "0.06",
  },
  {
    id: "emerald-wave",
    title: "Emerald Wave",
    mode: "dark mode",
    description: "Kabut hijau laut dan biru malam dengan vibe tenang namun mewah.",
    cardBackground:
      "radial-gradient(circle at 24% 26%, rgba(166,255,223,0.22), transparent 18%), radial-gradient(circle at 76% 18%, rgba(137,206,255,0.2), transparent 16%), linear-gradient(145deg, #07141a 0%, #113542 40%, #1d6d6c 72%, #071219 100%)",
    detailBackdrop:
      "radial-gradient(circle at 24% 26%, rgba(166,255,223,0.18), transparent 16%), linear-gradient(145deg, #07141a 0%, #123641 42%, #1e6b69 72%, #08121a 100%)",
    previewBackground:
      "radial-gradient(circle at 24% 26%, rgba(166,255,223,0.18), transparent 16%), radial-gradient(circle at 76% 18%, rgba(137,206,255,0.14), transparent 14%), linear-gradient(145deg, #08161d 0%, #143844 42%, #207370 72%, #08131b 100%)",
    dashboardBackground:
      "radial-gradient(circle at 24% 26%, rgba(166,255,223,0.1), transparent 14%), linear-gradient(145deg, #061219 0%, #10323c 42%, #1c625f 72%, #061119 100%)",
    overlayOpacity: "0.07",
  },
  {
    id: "sunset-glass",
    title: "Sunset Glass",
    mode: "all modes",
    description: "Panel kaca hangat dengan oranye, merah muda, dan violet seperti wallpaper kaca modern.",
    cardBackground:
      "radial-gradient(circle at 20% 18%, rgba(255,255,255,0.36), transparent 16%), linear-gradient(125deg, #ffb06a 0%, #ffd9bc 18%, #ff8fc3 48%, #8a5fff 100%)",
    detailBackdrop:
      "radial-gradient(circle at 20% 18%, rgba(255,255,255,0.24), transparent 16%), linear-gradient(125deg, #f0a363 0%, #ffd5b7 18%, #fb89bd 48%, #8259f0 100%)",
    previewBackground:
      "radial-gradient(circle at 20% 18%, rgba(255,255,255,0.28), transparent 16%), linear-gradient(125deg, #f6a969 0%, #ffdabc 18%, #fe90c3 48%, #8961f9 100%)",
    dashboardBackground:
      "radial-gradient(circle at 20% 18%, rgba(255,255,255,0.12), transparent 14%), linear-gradient(125deg, #da9059 0%, #ffcda7 18%, #f67ab4 48%, #724cdf 100%)",
    overlayOpacity: "0.08",
  },
  {
    id: "rose-quartz",
    title: "Rose Quartz",
    mode: "light mode",
    description: "Wallpaper rose-lilac yang lembut, bersih, dan sangat mendekati nuansa putih Opera.",
    cardBackground:
      "radial-gradient(circle at 22% 18%, rgba(255,255,255,0.82), transparent 20%), radial-gradient(circle at 80% 28%, rgba(255,196,221,0.58), transparent 18%), linear-gradient(145deg, #fff8fb 0%, #f9eef8 36%, #e9def9 68%, #ffe4ec 100%)",
    detailBackdrop:
      "radial-gradient(circle at 22% 18%, rgba(255,255,255,0.86), transparent 20%), linear-gradient(145deg, #fff8fb 0%, #f7edf8 38%, #e8ddf9 70%, #ffe4eb 100%)",
    previewBackground:
      "radial-gradient(circle at 22% 18%, rgba(255,255,255,0.86), transparent 20%), radial-gradient(circle at 80% 28%, rgba(255,199,223,0.5), transparent 18%), linear-gradient(145deg, #fff8fb 0%, #f8eef8 36%, #eadff9 68%, #ffe6ed 100%)",
    dashboardBackground:
      "radial-gradient(circle at 22% 18%, rgba(255,255,255,0.34), transparent 16%), linear-gradient(145deg, #fff5fa 0%, #f3e9f7 36%, #e1d6f5 68%, #ffdce7 100%)",
    overlayOpacity: "0.11",
  },
  {
    id: "polar-night",
    title: "Polar Night",
    mode: "dark mode",
    description: "Langit malam biru-violet dengan kilau dingin seperti wallpaper browser dark premium.",
    cardBackground:
      "radial-gradient(circle at 72% 20%, rgba(221,238,255,0.24), transparent 14%), radial-gradient(circle at 24% 70%, rgba(111,137,255,0.26), transparent 20%), linear-gradient(145deg, #060916 0%, #17254b 42%, #362a69 72%, #070913 100%)",
    detailBackdrop:
      "radial-gradient(circle at 72% 20%, rgba(221,238,255,0.18), transparent 12%), linear-gradient(145deg, #060917 0%, #17264a 44%, #342864 72%, #070913 100%)",
    previewBackground:
      "radial-gradient(circle at 72% 20%, rgba(221,238,255,0.2), transparent 12%), radial-gradient(circle at 24% 70%, rgba(111,137,255,0.18), transparent 18%), linear-gradient(145deg, #070b18 0%, #1b2951 44%, #382d6d 72%, #080a15 100%)",
    dashboardBackground:
      "radial-gradient(circle at 72% 20%, rgba(221,238,255,0.1), transparent 10%), linear-gradient(145deg, #050913 0%, #152145 44%, #2f255b 72%, #060811 100%)",
    overlayOpacity: "0.07",
  },
  {
    id: "mint-haze",
    title: "Mint Haze",
    mode: "light mode",
    description: "Wallpaper hijau mint dan biru pucat yang fresh, airy, dan halus.",
    cardBackground:
      "radial-gradient(circle at 78% 22%, rgba(255,255,255,0.74), transparent 18%), radial-gradient(circle at 20% 72%, rgba(194,255,231,0.44), transparent 22%), linear-gradient(145deg, #f7fffb 0%, #ddf8f1 34%, #dceeff 68%, #f7fbff 100%)",
    detailBackdrop:
      "radial-gradient(circle at 78% 22%, rgba(255,255,255,0.74), transparent 18%), linear-gradient(145deg, #f6fffb 0%, #dcf7f0 36%, #dceeff 70%, #f5fbff 100%)",
    previewBackground:
      "radial-gradient(circle at 78% 22%, rgba(255,255,255,0.78), transparent 18%), radial-gradient(circle at 20% 72%, rgba(192,255,230,0.38), transparent 20%), linear-gradient(145deg, #f7fffb 0%, #def8f1 34%, #deefff 68%, #f8fbff 100%)",
    dashboardBackground:
      "radial-gradient(circle at 78% 22%, rgba(255,255,255,0.28), transparent 14%), linear-gradient(145deg, #f1fff9 0%, #d5f3eb 34%, #d7e8fb 68%, #f2f8ff 100%)",
    overlayOpacity: "0.11",
  },
  {
    id: "royal-bloom",
    title: "Royal Bloom",
    mode: "all modes",
    description: "Bunga ungu mewah dengan cahaya pink yang elegan dan terasa premium.",
    cardBackground:
      "radial-gradient(circle at 22% 22%, rgba(255,221,244,0.26), transparent 18%), radial-gradient(circle at 80% 18%, rgba(255,255,255,0.16), transparent 14%), linear-gradient(145deg, #2b153d 0%, #7e3f92 42%, #db85be 72%, #311646 100%)",
    detailBackdrop:
      "radial-gradient(circle at 22% 22%, rgba(255,221,244,0.18), transparent 16%), linear-gradient(145deg, #2b163f 0%, #804395 44%, #d988c1 72%, #33184a 100%)",
    previewBackground:
      "radial-gradient(circle at 22% 22%, rgba(255,221,244,0.2), transparent 16%), radial-gradient(circle at 80% 18%, rgba(255,255,255,0.12), transparent 12%), linear-gradient(145deg, #2f1845 0%, #87479d 44%, #df8ec6 72%, #371b4f 100%)",
    dashboardBackground:
      "radial-gradient(circle at 22% 22%, rgba(255,221,244,0.1), transparent 14%), linear-gradient(145deg, #261236 0%, #703b85 44%, #cf77b4 72%, #2d1440 100%)",
    overlayOpacity: "0.08",
  },
  {
    id: "amber-drift",
    title: "Amber Drift",
    mode: "all modes",
    description: "Sapuan amber, peach, dan cream dengan rasa hangat seperti wallpaper senja lembut.",
    cardBackground:
      "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.34), transparent 16%), linear-gradient(125deg, #f7ad6c 0%, #ffd4ae 24%, #ffecdc 52%, #f1a0b1 100%)",
    detailBackdrop:
      "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.22), transparent 16%), linear-gradient(125deg, #f0a66a 0%, #ffd2af 24%, #ffecde 52%, #eb9bab 100%)",
    previewBackground:
      "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.24), transparent 16%), linear-gradient(125deg, #f6ab6c 0%, #ffd4b1 24%, #ffedde 52%, #eea1b0 100%)",
    dashboardBackground:
      "radial-gradient(circle at 18% 18%, rgba(255,255,255,0.12), transparent 14%), linear-gradient(125deg, #df9558 0%, #ffc79e 24%, #ffe3cf 52%, #df8a9d 100%)",
    overlayOpacity: "0.09",
  },
  {
    id: "ocean-beam",
    title: "Ocean Beam",
    mode: "dark mode",
    description: "Kilau cyan dan biru samudra dengan nuansa modern yang bersih dan tajam.",
    cardBackground:
      "radial-gradient(circle at 20% 20%, rgba(139,250,255,0.28), transparent 18%), radial-gradient(circle at 78% 70%, rgba(110,140,255,0.24), transparent 18%), linear-gradient(145deg, #07131c 0%, #153c55 44%, #1d6691 72%, #07121b 100%)",
    detailBackdrop:
      "radial-gradient(circle at 20% 20%, rgba(139,250,255,0.2), transparent 16%), linear-gradient(145deg, #07131c 0%, #163a52 44%, #1d638a 72%, #07111a 100%)",
    previewBackground:
      "radial-gradient(circle at 20% 20%, rgba(139,250,255,0.22), transparent 16%), radial-gradient(circle at 78% 70%, rgba(110,140,255,0.16), transparent 16%), linear-gradient(145deg, #08151f 0%, #19405a 44%, #1f6a94 72%, #08131d 100%)",
    dashboardBackground:
      "radial-gradient(circle at 20% 20%, rgba(139,250,255,0.1), transparent 14%), linear-gradient(145deg, #06111a 0%, #143349 44%, #1a587c 72%, #061019 100%)",
    overlayOpacity: "0.07",
  },
  {
    id: "ivory-silk",
    title: "Ivory Silk",
    mode: "light mode",
    description: "Ivory, champagne, dan lilac pudar dengan kesan mewah dan sangat halus.",
    cardBackground:
      "radial-gradient(circle at 76% 22%, rgba(255,255,255,0.84), transparent 18%), linear-gradient(145deg, #fffaf1 0%, #f8f0e7 30%, #efe7f4 64%, #fffdf8 100%)",
    detailBackdrop:
      "radial-gradient(circle at 76% 22%, rgba(255,255,255,0.84), transparent 18%), linear-gradient(145deg, #fffaf1 0%, #f6efe6 30%, #ede5f3 66%, #fffdf8 100%)",
    previewBackground:
      "radial-gradient(circle at 76% 22%, rgba(255,255,255,0.86), transparent 18%), linear-gradient(145deg, #fffbf3 0%, #f8f1e8 30%, #eee7f4 66%, #fffef9 100%)",
    dashboardBackground:
      "radial-gradient(circle at 76% 22%, rgba(255,255,255,0.34), transparent 14%), linear-gradient(145deg, #fff7ee 0%, #f3ebdf 30%, #e8dff0 66%, #fdfaf4 100%)",
    overlayOpacity: "0.12",
  },
  {
    id: "noir-velvet",
    title: "Noir Velvet",
    mode: "dark mode",
    description: "Hitam halus dengan cahaya violet tipis untuk tampilan dark yang mewah.",
    cardBackground:
      "radial-gradient(circle at 76% 22%, rgba(255,255,255,0.12), transparent 14%), radial-gradient(circle at 22% 74%, rgba(149,104,255,0.22), transparent 18%), linear-gradient(145deg, #050507 0%, #161220 38%, #2c1b42 68%, #070608 100%)",
    detailBackdrop:
      "radial-gradient(circle at 76% 22%, rgba(255,255,255,0.08), transparent 12%), linear-gradient(145deg, #050507 0%, #17131f 40%, #2b1b40 68%, #070608 100%)",
    previewBackground:
      "radial-gradient(circle at 76% 22%, rgba(255,255,255,0.1), transparent 12%), radial-gradient(circle at 22% 74%, rgba(149,104,255,0.14), transparent 16%), linear-gradient(145deg, #060608 0%, #191520 40%, #301e45 68%, #080709 100%)",
    dashboardBackground:
      "radial-gradient(circle at 22% 74%, rgba(149,104,255,0.08), transparent 14%), linear-gradient(145deg, #040406 0%, #14111a 40%, #251735 68%, #060507 100%)",
    overlayOpacity: "0.06",
  },
  ...OPERA_WALLPAPER_THEME_CONFIGS.map((themeConfig) => createThemeGalleryWallpaperTheme(themeConfig)),
];

function getThemeGalleryThemes() {
  return THEME_GALLERY_THEMES;
}

function getThemeGalleryThemeById(themeId) {
  return getThemeGalleryThemes().find((theme) => theme.id === themeId) || null;
}

const THEME_GALLERY_UI_SEEDS = {
  "default-dashboard": { accent: "#35d8ff", tint: "#071b45", highlight: "#ffd452" },
  classic: { accent: "#a578ff", tint: "#322656", highlight: "#f3d7a0" },
  aurora: { accent: "#6f8dff", tint: "#122d5d", highlight: "#9ad8ff" },
  midsommar: { accent: "#f0a2c3", tint: "#473261", highlight: "#ffe5ab" },
  matchday: { accent: "#9a55ff", tint: "#4f2048", highlight: "#ffc982" },
  interstellar: { accent: "#d7809a", tint: "#503040", highlight: "#ffd2a7" },
  metamorphic: { accent: "#8a7dff", tint: "#271d45", highlight: "#edf4ff" },
  sonic: { accent: "#5bbdff", tint: "#17314a", highlight: "#d8efff" },
  radiance: { accent: "#8c69ff", tint: "#2d1b52", highlight: "#ffba79" },
  orbit: { accent: "#c08fff", tint: "#403763", highlight: "#ffffff" },
  "web-rewind": { accent: "#8f7dff", tint: "#3f4568", highlight: "#dce6ff" },
  mirage: { accent: "#8ea3ff", tint: "#16202b", highlight: "#f0d0a1" },
  cyberroom: { accent: "#9a62ff", tint: "#1b3442", highlight: "#ffb26c" },
  "velvet-dusk": { accent: "#bf79ff", tint: "#3b1f5b", highlight: "#ffd6ed" },
  "pearl-bloom": { accent: "#e1a0d0", tint: "#6b5d87", highlight: "#fffaf4" },
  "alpine-mist": { accent: "#8cb8ec", tint: "#55729c", highlight: "#ffffff" },
  "lunar-petal": { accent: "#d394ff", tint: "#4f3367", highlight: "#fff4ff" },
  "night-drive": { accent: "#53d7ff", tint: "#1f2b4d", highlight: "#ff82ba" },
  "emerald-wave": { accent: "#6de0cb", tint: "#1d4b4f", highlight: "#bfefff" },
  "sunset-glass": { accent: "#ff8fb8", tint: "#6e458c", highlight: "#ffd39a" },
  "rose-quartz": { accent: "#e2a1cf", tint: "#77639a", highlight: "#fff8fb" },
  "polar-night": { accent: "#7c95ff", tint: "#202d59", highlight: "#dfeeff" },
  "mint-haze": { accent: "#7fdcc9", tint: "#5d8ea3", highlight: "#ffffff" },
  "royal-bloom": { accent: "#cc73d3", tint: "#4a245d", highlight: "#ffd1ea" },
  "amber-drift": { accent: "#f09a63", tint: "#8d5470", highlight: "#ffe0bd" },
  "ocean-beam": { accent: "#79ecff", tint: "#1f4c67", highlight: "#b6d2ff" },
  "ivory-silk": { accent: "#d7bca1", tint: "#8a7aa1", highlight: "#fffef8" },
  "noir-velvet": { accent: "#9f74ff", tint: "#231a32", highlight: "#e6dbff" },
  ...Object.fromEntries(
    OPERA_WALLPAPER_THEME_CONFIGS.map(({ id, accent, tint, highlight }) => [id, { accent, tint, highlight }])
  ),
};

function getThemeGalleryModeCategory(theme) {
  const normalized = String(theme?.mode || "").trim().toLowerCase();
  if (normalized.includes("light")) {
    return "light";
  }
  if (normalized.includes("dark")) {
    return "dark";
  }
  return "all";
}

function getThemeGalleryModeBadgeLabel(theme) {
  const category = getThemeGalleryModeCategory(theme);
  if (category === "light") {
    return "light";
  }
  if (category === "dark") {
    return "dark";
  }
  return "all";
}

function normalizeThemeGalleryMotionPreset(value, fallback = "calm") {
  const normalized = String(value || "").trim().toLowerCase();
  return THEME_GALLERY_WALLPAPER_MOTION_PRESETS[normalized] ? normalized : fallback;
}

function getSavedThemeGalleryMotionPreset(themeId = state.uiSettings.themeGalleryThemeId) {
  const currentThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (themeId && themeId === currentThemeId) {
    return normalizeThemeGalleryMotionPreset(state.uiSettings.themeGalleryMotionPreset, "calm");
  }
  return "calm";
}

function getPreferredThemeGalleryMotionPreset(theme, { preserveRuntime = false } = {}) {
  const runtimePreset = normalizeThemeGalleryMotionPreset(renderRuntime.themeGalleryMotionPreset, "");
  if (preserveRuntime && runtimePreset) {
    return runtimePreset;
  }

  const activeThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (theme?.id && theme.id === activeThemeId) {
    return getSavedThemeGalleryMotionPreset(theme.id);
  }

  if (runtimePreset) {
    return runtimePreset;
  }

  return "calm";
}

function getThemeGalleryResolvedMotionPreset(theme) {
  return getPreferredThemeGalleryMotionPreset(theme, { preserveRuntime: true });
}

function getThemeGalleryWallpaperMotionConfig(preset) {
  return THEME_GALLERY_WALLPAPER_MOTION_PRESETS[
    normalizeThemeGalleryMotionPreset(preset, "calm")
  ] || THEME_GALLERY_WALLPAPER_MOTION_PRESETS.calm;
}

function isThemeGalleryWallpaperTheme(theme) {
  return Boolean(theme);
}

function normalizeThemeGalleryToneValue(value, fallback = 50) {
  return clampNumber(Number(value ?? fallback), 0, 100);
}

function getSavedThemeGalleryTone(themeId = state.uiSettings.themeGalleryThemeId) {
  const currentThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (themeId && themeId === currentThemeId) {
    return {
      x: normalizeThemeGalleryToneValue(state.uiSettings.themeGalleryToneX, 50),
      y: normalizeThemeGalleryToneValue(state.uiSettings.themeGalleryToneY, 50),
    };
  }
  return { x: 50, y: 50 };
}

function getPreferredThemeGalleryTone(theme, { preserveRuntime = false } = {}) {
  const runtimeTone = {
    x: normalizeThemeGalleryToneValue(renderRuntime.themeGalleryToneX, 50),
    y: normalizeThemeGalleryToneValue(renderRuntime.themeGalleryToneY, 50),
  };
  if (preserveRuntime) {
    return runtimeTone;
  }

  const activeThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (theme?.id && theme.id === activeThemeId) {
    return getSavedThemeGalleryTone(theme.id);
  }

  return runtimeTone;
}

function getThemeGalleryResolvedTone(theme) {
  const runtimeTone = {
    x: normalizeThemeGalleryToneValue(renderRuntime.themeGalleryToneX, 50),
    y: normalizeThemeGalleryToneValue(renderRuntime.themeGalleryToneY, 50),
  };
  const selectedThemeId = String(getThemeGallerySelectionId() || "").trim();
  if (!elements.themeGalleryModal?.classList.contains("hidden") && theme?.id && theme.id === selectedThemeId) {
    return runtimeTone;
  }
  const activeThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (theme?.id && theme.id === activeThemeId) {
    return getSavedThemeGalleryTone(theme.id);
  }
  return runtimeTone;
}

function getThemeGalleryToneLabel(tone) {
  const horizontal = tone.x >= 50 ? "Active" : "Calm";
  const vertical = tone.y >= 50 ? "Australis" : "Borealis";
  return `${horizontal} ${vertical}`;
}

function getThemeGalleryToneDescription(tone) {
  const calmness = tone.x >= 50
    ? "warna theme menjadi lebih hidup dan tegas"
    : "warna theme tetap lembut dan tenang";
  const auroraSide = tone.y >= 50
    ? "dengan arah warna ke pink, violet, dan sunset"
    : "dengan arah warna ke cyan, mint, dan aurora";
  return `Tarik titik untuk mengubah warna theme. Saat ini ${calmness} ${auroraSide}.`;
}

function updateThemeGalleryToneUi(theme) {
  const tone = getThemeGalleryResolvedTone(theme);
  if (elements.themeGalleryColorHandle) {
    elements.themeGalleryColorHandle.style.setProperty("--theme-color-x", `${tone.x}%`);
    elements.themeGalleryColorHandle.style.setProperty("--theme-color-y", `${tone.y}%`);
    elements.themeGalleryColorHandle.style.left = `${tone.x}%`;
    elements.themeGalleryColorHandle.style.top = `${tone.y}%`;
  }
  if (elements.themeGalleryColorSurface) {
    elements.themeGalleryColorSurface.style.setProperty("--theme-color-x", `${tone.x}%`);
    elements.themeGalleryColorSurface.style.setProperty("--theme-color-y", `${tone.y}%`);
  }
  if (elements.themeGalleryColorLabel) {
    elements.themeGalleryColorLabel.textContent = getThemeGalleryToneLabel(tone);
  }
  if (elements.themeGalleryColorDescription) {
    elements.themeGalleryColorDescription.textContent = getThemeGalleryToneDescription(tone);
  }
}

function updateThemeGalleryToneFromClientPosition(clientX, clientY) {
  if (!(elements.themeGalleryColorSurface instanceof HTMLDivElement)) {
    return;
  }
  const rect = elements.themeGalleryColorSurface.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return;
  }
  renderRuntime.themeGalleryToneX = normalizeThemeGalleryToneValue(((clientX - rect.left) / rect.width) * 100, 50);
  renderRuntime.themeGalleryToneY = normalizeThemeGalleryToneValue(((clientY - rect.top) / rect.height) * 100, 50);
  updateThemeGalleryPreview();
  syncActiveThemeGalleryToneFromRuntime();
}

function stopThemeGalleryToneDragging() {
  renderRuntime.themeGalleryToneDragging = false;
  syncActiveThemeGalleryToneFromRuntime({ persistImmediately: true });
}

function syncActiveThemeGalleryToneFromRuntime({ persistImmediately = false } = {}) {
  const selectedThemeId = String(getThemeGallerySelectionId() || "").trim();
  const activeThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (!selectedThemeId || selectedThemeId !== activeThemeId) {
    return;
  }

  state.uiSettings.themeGalleryToneX = normalizeThemeGalleryToneValue(renderRuntime.themeGalleryToneX, 50);
  state.uiSettings.themeGalleryToneY = normalizeThemeGalleryToneValue(renderRuntime.themeGalleryToneY, 50);

  if (themeTonePersistTimerId) {
    window.clearTimeout(themeTonePersistTimerId);
    themeTonePersistTimerId = 0;
  }

  if (persistImmediately) {
    persistState();
    return;
  }

  themeTonePersistTimerId = window.setTimeout(() => {
    themeTonePersistTimerId = 0;
    persistState();
  }, 120);
}

function normalizeThemeGalleryAnimatedWallpaperEnabled(value, fallback = true) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (["false", "0", "off", "no"].includes(normalized)) {
    return false;
  }
  if (["true", "1", "on", "yes"].includes(normalized)) {
    return true;
  }
  return Boolean(fallback);
}

function normalizeThemeGalleryBackgroundFinish(value, fallback = "glossy") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "doff" || normalized === "matte") {
    return "doff";
  }
  if (normalized === "glossy") {
    return "glossy";
  }
  return fallback === "doff" ? "doff" : "glossy";
}

function getSavedThemeGalleryAnimatedWallpaperEnabled(themeId = state.uiSettings.themeGalleryThemeId) {
  const currentThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (themeId && themeId === currentThemeId) {
    return normalizeThemeGalleryAnimatedWallpaperEnabled(
      state.uiSettings.themeGalleryAnimatedWallpaperEnabled,
      true
    );
  }
  return true;
}

function getSavedThemeGalleryBackgroundFinish(themeId = state.uiSettings.themeGalleryThemeId) {
  const currentThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (themeId && themeId === currentThemeId) {
    return normalizeThemeGalleryBackgroundFinish(state.uiSettings.themeGalleryBackgroundFinish, "glossy");
  }
  return "glossy";
}

function getPreferredThemeGalleryAnimatedWallpaperEnabled(theme, { preserveRuntime = false } = {}) {
  const runtimeValue = normalizeThemeGalleryAnimatedWallpaperEnabled(
    renderRuntime.themeGalleryAnimatedWallpaperEnabled,
    true
  );
  if (preserveRuntime) {
    return runtimeValue;
  }
  const activeThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (theme?.id && theme.id === activeThemeId) {
    return getSavedThemeGalleryAnimatedWallpaperEnabled(theme.id);
  }
  return runtimeValue;
}

function getPreferredThemeGalleryBackgroundFinish(theme, { preserveRuntime = false } = {}) {
  const runtimeValue = normalizeThemeGalleryBackgroundFinish(renderRuntime.themeGalleryBackgroundFinish, "glossy");
  if (preserveRuntime) {
    return runtimeValue;
  }
  const activeThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (theme?.id && theme.id === activeThemeId) {
    return getSavedThemeGalleryBackgroundFinish(theme.id);
  }
  return runtimeValue;
}

function getThemeGalleryResolvedAnimatedWallpaperEnabled(theme) {
  const selectedThemeId = String(getThemeGallerySelectionId() || "").trim();
  if (!elements.themeGalleryModal?.classList.contains("hidden") && theme?.id && theme.id === selectedThemeId) {
    return normalizeThemeGalleryAnimatedWallpaperEnabled(renderRuntime.themeGalleryAnimatedWallpaperEnabled, true);
  }
  const activeThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (theme?.id && theme.id === activeThemeId) {
    return getSavedThemeGalleryAnimatedWallpaperEnabled(theme.id);
  }
  return normalizeThemeGalleryAnimatedWallpaperEnabled(renderRuntime.themeGalleryAnimatedWallpaperEnabled, true);
}

function getThemeGalleryResolvedBackgroundFinish(theme) {
  const selectedThemeId = String(getThemeGallerySelectionId() || "").trim();
  if (!elements.themeGalleryModal?.classList.contains("hidden") && theme?.id && theme.id === selectedThemeId) {
    return normalizeThemeGalleryBackgroundFinish(renderRuntime.themeGalleryBackgroundFinish, "glossy");
  }
  const activeThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (theme?.id && theme.id === activeThemeId) {
    return getSavedThemeGalleryBackgroundFinish(theme.id);
  }
  return normalizeThemeGalleryBackgroundFinish(renderRuntime.themeGalleryBackgroundFinish, "glossy");
}

function updateThemeGalleryWallpaperUi(theme) {
  const animatedEnabled = getThemeGalleryResolvedAnimatedWallpaperEnabled(theme);
  const finish = getThemeGalleryResolvedBackgroundFinish(theme);

  if (elements.themeGalleryWallpaperAnimated) {
    elements.themeGalleryWallpaperAnimated.classList.toggle("on", animatedEnabled);
    elements.themeGalleryWallpaperAnimated.setAttribute("aria-pressed", String(animatedEnabled));
  }
  if (elements.themeGalleryWallpaperAnimatedDescription) {
    elements.themeGalleryWallpaperAnimatedDescription.textContent = animatedEnabled
      ? "Background theme bergerak live saat posisi warna digeser."
      : "Background theme tetap statis, tetapi warna masih berubah live saat digeser.";
  }
  if (elements.themeGalleryWallpaperFinish) {
    const glossy = finish === "glossy";
    elements.themeGalleryWallpaperFinish.classList.toggle("on", glossy);
    elements.themeGalleryWallpaperFinish.setAttribute("aria-pressed", String(glossy));
  }
  if (elements.themeGalleryWallpaperFinishTitle) {
    elements.themeGalleryWallpaperFinishTitle.textContent =
      finish === "glossy" ? "Glossy Finish" : "Doff Finish";
  }
  if (elements.themeGalleryWallpaperFinishDescription) {
    elements.themeGalleryWallpaperFinishDescription.textContent = finish === "glossy"
      ? "Latar utama memakai kilau lembut. Matikan untuk finish doff."
      : "Latar utama memakai finish doff yang lebih matte dan tenang.";
  }
}

function applyThemeGalleryWallpaperFx(theme) {
  const animatedEnabled = getThemeGalleryResolvedAnimatedWallpaperEnabled(theme);
  const finish = getThemeGalleryResolvedBackgroundFinish(theme);
  const tone = getThemeGalleryResolvedTone(theme);
  const liveProfile = getThemeGalleryWallpaperLiveProfile(theme);
  const rootStyle = document.documentElement.style;
  const activeFactor = normalizeThemeGalleryToneValue(tone.x, 50) / 100;
  const auroraFactor = normalizeThemeGalleryToneValue(tone.y, 50) / 100;
  const baseX = clampNumber(42 + ((tone.x - 50) / 50) * 10, 32, 68);
  const baseY = clampNumber(42 + ((tone.y - 50) / 50) * 10, 32, 68);
  const driftStrength = animatedEnabled ? (2.5 + activeFactor * 6) * liveProfile.driftScaleX : 0;
  const driftDirectionX = Math.abs(tone.x - 50) < 6 ? 1 : Math.sign(tone.x - 50);
  const driftDirectionY = Math.abs(tone.y - 50) < 6 ? 1 : Math.sign(tone.y - 50);
  const startX = clampNumber(baseX - driftDirectionX * driftStrength, 28, 72);
  const endX = clampNumber(baseX + driftDirectionX * driftStrength, 28, 72);
  const verticalDriftStrength = driftStrength * liveProfile.driftScaleY;
  const startY = clampNumber(baseY - driftDirectionY * verticalDriftStrength, 28, 72);
  const endY = clampNumber(baseY + driftDirectionY * verticalDriftStrength, 28, 72);
  const midX = clampNumber((startX + endX) / 2 + (auroraFactor - 0.5) * 3.5, 28, 72);
  const midY = clampNumber((startY + endY) / 2 + (activeFactor - 0.5) * 3.5, 28, 72);
  const durationMs = animatedEnabled ? Math.round((28000 - activeFactor * 11000) * liveProfile.durationMultiplier) : 0;
  const glossyFinish = finish === "glossy";
  const basePosition = `${baseX}% ${baseY}%`;

  rootStyle.setProperty("--live-wallpaper-start-x", `${startX}%`);
  rootStyle.setProperty("--live-wallpaper-start-y", `${startY}%`);
  rootStyle.setProperty("--live-wallpaper-mid-x", `${midX}%`);
  rootStyle.setProperty("--live-wallpaper-mid-y", `${midY}%`);
  rootStyle.setProperty("--live-wallpaper-end-x", `${endX}%`);
  rootStyle.setProperty("--live-wallpaper-end-y", `${endY}%`);
  rootStyle.setProperty("--live-wallpaper-duration", `${Math.max(durationMs, 1)}ms`);
  rootStyle.setProperty("--live-wallpaper-saturate", glossyFinish ? `${1.04 + activeFactor * 0.18}` : `${0.92 + activeFactor * 0.08}`);
  rootStyle.setProperty("--live-wallpaper-brightness", glossyFinish ? `${1.01 + activeFactor * 0.04}` : `${0.94 + activeFactor * 0.03}`);
  rootStyle.setProperty("--live-wallpaper-gloss-alpha", glossyFinish ? `${0.14 + activeFactor * 0.1}` : "0.03");
  rootStyle.setProperty("--live-wallpaper-matte-alpha", glossyFinish ? "0.05" : `${0.16 + (1 - activeFactor) * 0.08}`);
  rootStyle.setProperty("--live-wallpaper-scale", animatedEnabled ? `${liveProfile.scaleBase + activeFactor * liveProfile.scaleBoost}` : "1");
  rootStyle.setProperty("--live-wallpaper-shift-x", `${(tone.x - 50) * liveProfile.shiftXFactor}%`);
  rootStyle.setProperty("--live-wallpaper-shift-y", `${(tone.y - 50) * liveProfile.shiftYFactor}%`);
  rootStyle.setProperty("--live-wallpaper-tilt", `${(tone.x - 50) * liveProfile.tiltFactor}deg`);
  rootStyle.setProperty(
    "--opera-live-motion-ease",
    liveProfile.motionEase === "swift"
      ? "cubic-bezier(0.18, 0.72, 0.18, 1)"
      : liveProfile.motionEase === "dramatic"
        ? "cubic-bezier(0.4, 0.08, 0.2, 1)"
        : liveProfile.motionEase === "soft"
          ? "cubic-bezier(0.33, 0, 0.13, 1)"
          : "cubic-bezier(0.22, 0.61, 0.36, 1)"
  );
  rootStyle.setProperty(
    "--opera-live-filter-ease",
    liveProfile.filterEase === "swift"
      ? "cubic-bezier(0.18, 0.72, 0.18, 1)"
      : liveProfile.filterEase === "dramatic"
        ? "cubic-bezier(0.4, 0.08, 0.2, 1)"
        : liveProfile.filterEase === "soft"
          ? "cubic-bezier(0.33, 0, 0.13, 1)"
          : "cubic-bezier(0.22, 0.61, 0.36, 1)"
  );
  document.documentElement.dataset.liveWallpaperFinish = finish;
  document.documentElement.dataset.liveWallpaperAnimated = animatedEnabled ? "true" : "false";
  document.documentElement.dataset.liveWallpaperProfile = liveProfile.path;

  if (elements.themeGalleryPreviewImage) {
    elements.themeGalleryPreviewImage.dataset.liveWallpaper = "false";
    elements.themeGalleryPreviewImage.dataset.finish = finish;
    elements.themeGalleryPreviewImage.dataset.liveWallpaperBasePosition = basePosition;
    elements.themeGalleryPreviewImage.style.backgroundPosition = basePosition;
  }

  getDesktopBackgroundLayers().forEach((layer) => {
    layer.dataset.liveWallpaper = "false";
    layer.dataset.finish = finish;
    layer.dataset.liveWallpaperBasePosition = basePosition;
    layer.style.backgroundPosition = basePosition;
  });

  if (elements.desktopBackgroundOverlay) {
    elements.desktopBackgroundOverlay.dataset.finish = finish;
  }
}

function normalizeHexColor(value, fallback = "#000000") {
  const normalized = String(value || "").trim();
  const candidate = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  if (!/^[\da-f]{3}$|^[\da-f]{6}$/i.test(candidate)) {
    return fallback;
  }
  if (candidate.length === 3) {
    return `#${candidate.split("").map((char) => `${char}${char}`).join("")}`.toLowerCase();
  }
  return `#${candidate}`.toLowerCase();
}

function getLiveWallpaperSpeedPreset(value) {
  const normalized = String(value || "").trim();
  return LIVE_WALLPAPER_SPEED_PRESETS[normalized] || LIVE_WALLPAPER_SPEED_PRESETS.Normal;
}

function buildLiveWallpaperConfigValues(overrides = {}) {
  return LIVE_WALLPAPER_CONFIGURATION.normalizeValues({
    perf: {
      lw_speed: overrides?.perf?.lw_speed ?? overrides?.liveWallpaperSpeed ?? state.uiSettings.liveWallpaperSpeed,
    },
    appearance: {
      color: overrides?.appearance?.color ?? overrides?.liveWallpaperColor ?? state.uiSettings.liveWallpaperColor,
    },
  });
}

function getResolvedLiveWallpaperConfigValues() {
  if (!elements.themeGalleryModal?.classList.contains("hidden") && renderRuntime.liveWallpaperConfigValues) {
    return LIVE_WALLPAPER_CONFIGURATION.normalizeValues(renderRuntime.liveWallpaperConfigValues);
  }
  return buildLiveWallpaperConfigValues();
}

function getLiveWallpaperAccentColor() {
  return normalizeHexColor(getResolvedLiveWallpaperConfigValues().appearance.color, c_white);
}

function renderLiveWallpaperConfigurationPanel() {
  if (!elements.liveWallpaperConfigs) {
    return;
  }

  const values = getResolvedLiveWallpaperConfigValues();
  elements.liveWallpaperConfigs.innerHTML = LIVE_WALLPAPER_CONFIGURATION.sections
    .map((section) => `
      <section class="live-wallpaper-config-section">
        <strong class="live-wallpaper-config-title">${escapeHtml(section.title)}</strong>
        ${section.options.map((option) => {
          const value = values?.[section.key]?.[option.key] ?? option.defaultValue;
          if (option.type === "select") {
            return `
              <div class="live-wallpaper-config-option">
                <div class="live-wallpaper-config-label-row">
                  <label for="lw-config-${escapeHtml(section.key)}-${escapeHtml(option.key)}">${escapeHtml(option.label)}</label>
                </div>
                <select
                  class="live-wallpaper-config-select"
                  id="lw-config-${escapeHtml(section.key)}-${escapeHtml(option.key)}"
                  data-lw-config-section="${escapeHtml(section.key)}"
                  data-lw-config-option="${escapeHtml(option.key)}"
                >
                  ${option.choices.map((choice) => `
                    <option value="${escapeHtml(choice)}" ${choice === value ? "selected" : ""}>${escapeHtml(choice)}</option>
                  `).join("")}
                </select>
                ${option.description ? `<span class="live-wallpaper-config-help">${escapeHtml(option.description)}</span>` : ""}
              </div>
            `;
          }

          if (option.type === "color") {
            return `
              <div class="live-wallpaper-config-option">
                <div class="live-wallpaper-config-label-row">
                  <label for="lw-config-${escapeHtml(section.key)}-${escapeHtml(option.key)}">${escapeHtml(option.label)}</label>
                  <span class="live-wallpaper-config-help">${escapeHtml(value)}</span>
                </div>
                <input
                  class="live-wallpaper-config-color"
                  id="lw-config-${escapeHtml(section.key)}-${escapeHtml(option.key)}"
                  data-lw-config-section="${escapeHtml(section.key)}"
                  data-lw-config-option="${escapeHtml(option.key)}"
                  type="color"
                  value="${escapeHtml(value)}"
                />
                ${option.description ? `<span class="live-wallpaper-config-help">${escapeHtml(option.description)}</span>` : ""}
              </div>
            `;
          }

          return "";
        }).join("")}
      </section>
    `)
    .join("");
}

function applyLiveWallpaperConfiguration(candidateValues = {}, { updatePreview = true } = {}) {
  const normalized = LIVE_WALLPAPER_CONFIGURATION.apply(candidateValues);
  renderRuntime.liveWallpaperConfigValues = normalized;
  if (updatePreview) {
    renderLiveWallpaperConfigurationPanel();
    updateThemeGalleryPreview();
  }
}

function hexToRgb(value, fallback = "#000000") {
  const normalized = normalizeHexColor(value, fallback).slice(1);
  const numeric = Number.parseInt(normalized, 16);
  return {
    r: (numeric >> 16) & 255,
    g: (numeric >> 8) & 255,
    b: numeric & 255,
  };
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function mixHexColors(baseHex, blendHex, blendRatio = 0.5) {
  const ratio = clampNumber(Number(blendRatio || 0), 0, 1);
  const base = hexToRgb(baseHex, "#000000");
  const blend = hexToRgb(blendHex, "#ffffff");
  const mixed = {
    r: Math.round(base.r * (1 - ratio) + blend.r * ratio),
    g: Math.round(base.g * (1 - ratio) + blend.g * ratio),
    b: Math.round(base.b * (1 - ratio) + blend.b * ratio),
  };
  return `#${[mixed.r, mixed.g, mixed.b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function rgbaFromHex(hex, alpha = 1) {
  const color = hexToRgb(hex, "#000000");
  const normalizedAlpha = clampNumber(Number(alpha || 0), 0, 1);
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${normalizedAlpha})`;
}

function getRelativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex, "#000000");
  const normalizeChannel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * normalizeChannel(r)) + (0.7152 * normalizeChannel(g)) + (0.0722 * normalizeChannel(b));
}

function getContrastRatio(baseHex, comparisonHex) {
  const luminanceA = getRelativeLuminance(baseHex);
  const luminanceB = getRelativeLuminance(comparisonHex);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

function getReadableTextColor(backgroundHex, {
  light = "#f7fbff",
  dark = "#172033",
} = {}) {
  return getContrastRatio(backgroundHex, dark) >= getContrastRatio(backgroundHex, light)
    ? dark
    : light;
}

function hashString(value) {
  const source = String(value || "");
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function hslToHex(hue, saturation, lightness) {
  const normalizedHue = ((Number(hue) % 360) + 360) % 360;
  const normalizedSaturation = clampNumber(Number(saturation || 0), 0, 100) / 100;
  const normalizedLightness = clampNumber(Number(lightness || 0), 0, 100) / 100;
  const chroma = (1 - Math.abs((2 * normalizedLightness) - 1)) * normalizedSaturation;
  const secondary = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const match = normalizedLightness - (chroma / 2);
  let red = 0;
  let green = 0;
  let blue = 0;

  if (normalizedHue < 60) {
    red = chroma;
    green = secondary;
  } else if (normalizedHue < 120) {
    red = secondary;
    green = chroma;
  } else if (normalizedHue < 180) {
    green = chroma;
    blue = secondary;
  } else if (normalizedHue < 240) {
    green = secondary;
    blue = chroma;
  } else if (normalizedHue < 300) {
    red = secondary;
    blue = chroma;
  } else {
    red = chroma;
    blue = secondary;
  }

  const toHex = (value) => Math.round((value + match) * 255).toString(16).padStart(2, "0");
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function buildVisibleBankAccentMap(bankNames) {
  const assignedColors = new Set();
  const accentMap = new Map();

  bankNames.forEach((bankName, index) => {
    const normalizedName = String(bankName || "").trim();
    if (!normalizedName || accentMap.has(normalizedName)) {
      return;
    }

    const startIndex = hashString(normalizedName) % BANK_TITLE_ACCENT_PALETTE.length;
    let accentColor = "";

    for (let offset = 0; offset < BANK_TITLE_ACCENT_PALETTE.length; offset += 1) {
      const candidate = BANK_TITLE_ACCENT_PALETTE[(startIndex + offset) % BANK_TITLE_ACCENT_PALETTE.length];
      if (!assignedColors.has(candidate)) {
        accentColor = candidate;
        break;
      }
    }

    if (!accentColor) {
      accentColor = hslToHex((hashString(normalizedName) + (index * 37)) % 360, 84, 66);
    }

    assignedColors.add(accentColor);
    accentMap.set(normalizedName, accentColor);
  });

  return accentMap;
}

function applyBankColumnAccent(columnElement, bankName, accentColor) {
  if (!columnElement || !accentColor) {
    return;
  }

  const accentStrong = mixHexColors(accentColor, "#ffffff", 0.22);
  const accentSoft = mixHexColors(accentColor, "#ffffff", 0.42);
  const accentDeep = mixHexColors(accentColor, "#07111a", 0.4);
  const accentGlow = mixHexColors(accentColor, "#ffffff", 0.12);
  const titleTextColor = getReadableTextColor(accentColor, {
    light: "#f8fbff",
    dark: "#102030",
  });

  columnElement.style.setProperty("--bank-column-hover-border", rgbaFromHex(accentColor, 0.42));
  columnElement.style.setProperty("--bank-title-border", rgbaFromHex(accentColor, 0.26));
  columnElement.style.setProperty(
    "--bank-title-bg",
    `linear-gradient(180deg, ${rgbaFromHex(accentColor, 0.08)}, ${rgbaFromHex(accentColor, 0.02)}), linear-gradient(90deg, ${rgbaFromHex(accentStrong, 0.04)}, transparent)`
  );
  columnElement.style.setProperty("--bank-title-sheen", `linear-gradient(110deg, transparent 22%, ${rgbaFromHex(accentSoft, 0.28)} 48%, transparent 74%)`);
  columnElement.style.setProperty("--bank-title-name-color", titleTextColor);
  columnElement.style.setProperty(
    "--bank-title-name-bg",
    `linear-gradient(180deg, ${accentStrong} 0%, ${accentColor} 52%, ${mixHexColors(accentColor, accentDeep, 0.18)} 100%)`
  );
  columnElement.style.setProperty("--bank-title-name-border", rgbaFromHex(accentSoft, 0.72));
  columnElement.style.setProperty(
    "--bank-title-name-box-shadow",
    `inset 0 1px 0 ${rgbaFromHex("#ffffff", 0.28)}, 0 10px 18px ${rgbaFromHex(accentDeep, 0.22)}, 0 0 18px ${rgbaFromHex(accentGlow, 0.18)}`
  );
  columnElement.style.setProperty("--bank-title-name-stroke", "transparent");
  columnElement.style.setProperty(
    "--bank-title-name-live-shadow",
    titleTextColor === "#102030"
      ? `0 1px 0 ${rgbaFromHex("#ffffff", 0.18)}, 0 0 8px ${rgbaFromHex("#ffffff", 0.08)}`
      : `0 1px 0 ${rgbaFromHex("#08131d", 0.18)}, 0 0 10px ${rgbaFromHex(accentGlow, 0.22)}`
  );
}

function createCubicBezierEasing(x1, y1, x2, y2) {
  if (!(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1)) {
    throw new Error("Bezier x values must be in [0, 1] range.");
  }
  if (x1 === y1 && x2 === y2) {
    return (value) => value;
  }

  const sampleStep = 0.1;
  const sampleValues = typeof Float32Array === "function"
    ? new Float32Array(11)
    : new Array(11);
  const calcBezier = (value, a1, a2) => {
    const c = 3 * a1;
    const b = 3 * (a2 - a1) - c;
    const a = 1 - c - b;
    return ((a * value + b) * value + c) * value;
  };
  const getSlope = (value, a1, a2) => {
    const c = 3 * a1;
    const b = 3 * (a2 - a1) - c;
    const a = 1 - c - b;
    return 3 * a * value * value + 2 * b * value + c;
  };

  for (let index = 0; index < 11; index += 1) {
    sampleValues[index] = calcBezier(index * sampleStep, x1, x2);
  }

  const getTForX = (value) => {
    let intervalStart = 0;
    let currentSample = 1;
    while (currentSample !== 10 && sampleValues[currentSample] <= value) {
      intervalStart += sampleStep;
      currentSample += 1;
    }
    currentSample -= 1;

    const distance = (value - sampleValues[currentSample]) / (sampleValues[currentSample + 1] - sampleValues[currentSample]);
    let guessForT = intervalStart + distance * sampleStep;
    const initialSlope = getSlope(guessForT, x1, x2);

    if (initialSlope >= 0.001) {
      for (let iteration = 0; iteration < 4; iteration += 1) {
        const currentSlope = getSlope(guessForT, x1, x2);
        if (currentSlope === 0) {
          return guessForT;
        }
        guessForT -= (calcBezier(guessForT, x1, x2) - value) / currentSlope;
      }
      return guessForT;
    }

    if (initialSlope === 0) {
      return guessForT;
    }

    let start = intervalStart;
    let end = intervalStart + sampleStep;
    let iteration = 0;
    while (iteration < 10) {
      guessForT = start + (end - start) / 2;
      const currentValue = calcBezier(guessForT, x1, x2) - value;
      if (Math.abs(currentValue) <= 1e-7) {
        return guessForT;
      }
      if (currentValue > 0) {
        end = guessForT;
      } else {
        start = guessForT;
      }
      iteration += 1;
    }
    return guessForT;
  };

  return (value) => {
    if (value <= 0) {
      return 0;
    }
    if (value >= 1) {
      return 1;
    }
    return calcBezier(getTForX(value), y1, y2);
  };
}

const OPERA_LIVE_WALLPAPER_EASE = createCubicBezierEasing(0.22, 0.61, 0.36, 1);
const OPERA_LIVE_WALLPAPER_SOFT_EASE = createCubicBezierEasing(0.33, 0, 0.13, 1);
const OPERA_LIVE_WALLPAPER_SWIFT_EASE = createCubicBezierEasing(0.18, 0.72, 0.18, 1);
const OPERA_LIVE_WALLPAPER_DRAMATIC_EASE = createCubicBezierEasing(0.4, 0.08, 0.2, 1);

const THEME_GALLERY_WALLPAPER_LIVE_PROFILES = {
  satin: {
    path: "satin-float",
    durationMultiplier: 1.18,
    driftScaleX: 0.82,
    driftScaleY: 0.76,
    shiftXFactor: 0.08,
    shiftYFactor: 0.06,
    tiltFactor: 0.012,
    scaleBase: 1.018,
    scaleBoost: 0.018,
    motionEase: "soft",
    filterEase: "soft",
  },
  airy: {
    path: "airy-pan",
    durationMultiplier: 1.06,
    driftScaleX: 0.96,
    driftScaleY: 0.82,
    shiftXFactor: 0.1,
    shiftYFactor: 0.07,
    tiltFactor: 0.013,
    scaleBase: 1.02,
    scaleBoost: 0.018,
    motionEase: "opera",
    filterEase: "soft",
  },
  aurora: {
    path: "aurora-curtain",
    durationMultiplier: 1.22,
    driftScaleX: 1.16,
    driftScaleY: 1.08,
    shiftXFactor: 0.15,
    shiftYFactor: 0.11,
    tiltFactor: 0.022,
    scaleBase: 1.028,
    scaleBoost: 0.026,
    motionEase: "soft",
    filterEase: "opera",
  },
  cosmic: {
    path: "orbital-cosmic",
    durationMultiplier: 1.28,
    driftScaleX: 1.08,
    driftScaleY: 1,
    shiftXFactor: 0.13,
    shiftYFactor: 0.1,
    tiltFactor: 0.02,
    scaleBase: 1.03,
    scaleBoost: 0.03,
    motionEase: "dramatic",
    filterEase: "opera",
  },
  neon: {
    path: "neon-sweep",
    durationMultiplier: 0.86,
    driftScaleX: 1.3,
    driftScaleY: 0.92,
    shiftXFactor: 0.18,
    shiftYFactor: 0.09,
    tiltFactor: 0.03,
    scaleBase: 1.026,
    scaleBoost: 0.028,
    motionEase: "swift",
    filterEase: "opera",
  },
  cinematic: {
    path: "cinematic-glide",
    durationMultiplier: 1.02,
    driftScaleX: 1.18,
    driftScaleY: 0.86,
    shiftXFactor: 0.14,
    shiftYFactor: 0.08,
    tiltFactor: 0.018,
    scaleBase: 1.024,
    scaleBoost: 0.024,
    motionEase: "opera",
    filterEase: "soft",
  },
  urban: {
    path: "urban-drift",
    durationMultiplier: 0.94,
    driftScaleX: 1.08,
    driftScaleY: 0.96,
    shiftXFactor: 0.14,
    shiftYFactor: 0.09,
    tiltFactor: 0.024,
    scaleBase: 1.022,
    scaleBoost: 0.022,
    motionEase: "swift",
    filterEase: "soft",
  },
};

function getThemeGalleryMotionEasingByName(name) {
  switch (String(name || "").trim()) {
    case "soft":
      return OPERA_LIVE_WALLPAPER_SOFT_EASE;
    case "swift":
      return OPERA_LIVE_WALLPAPER_SWIFT_EASE;
    case "dramatic":
      return OPERA_LIVE_WALLPAPER_DRAMATIC_EASE;
    default:
      return OPERA_LIVE_WALLPAPER_EASE;
  }
}

function getThemeGalleryWallpaperLiveProfile(theme) {
  const themeId = String(theme?.id || "").trim();
  if (!themeId) {
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.cinematic;
  }

  if (themeId === "aurora") {
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.aurora;
  }
  if (themeId === "interstellar") {
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.cosmic;
  }
  if (themeId === "cyberroom") {
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.neon;
  }
  if (themeId === "night-drive") {
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.urban;
  }
  if (themeId === "classic" || themeId === "pearl-bloom") {
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.satin;
  }
  if (themeId === "alpine-mist") {
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.airy;
  }

  if (themeId.startsWith("opera-canvas-")) {
    const numericId = Number.parseInt(themeId.slice("opera-canvas-".length), 10);
    const profileRotation = theme?.mode === "light mode"
      ? ["airy", "satin", "cinematic"]
      : theme?.mode === "dark mode"
        ? ["aurora", "cosmic", "urban"]
        : ["cinematic", "neon", "airy"];
    const profileKey = profileRotation[(Number.isFinite(numericId) ? Math.abs(numericId) : 0) % profileRotation.length];
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES[profileKey] || THEME_GALLERY_WALLPAPER_LIVE_PROFILES.cinematic;
  }

  if (theme?.mode === "light mode") {
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.airy;
  }
  if (theme?.mode === "dark mode") {
    return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.aurora;
  }
  return THEME_GALLERY_WALLPAPER_LIVE_PROFILES.cinematic;
}

function getThemeGalleryUiSeed(theme) {
  if (!theme) {
    return null;
  }
  return THEME_GALLERY_UI_SEEDS[theme.id] || THEME_GALLERY_UI_SEEDS.classic;
}

function getThemeGalleryDefaultPreviewMode(theme) {
  if (theme?.mode === "light mode") {
    return "light";
  }
  if (theme?.mode === "dark mode") {
    return "dark";
  }
  return "all";
}

function normalizeThemeGalleryPreviewMode(value, fallback = "all") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "light" || normalized === "dark" || normalized === "all") {
    return normalized;
  }
  return fallback;
}

function getSavedThemeGalleryPreviewMode(themeId = state.uiSettings.themeGalleryThemeId) {
  const currentThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (themeId && themeId === currentThemeId) {
    return normalizeThemeGalleryPreviewMode(state.uiSettings.themeGalleryPreviewMode, "all");
  }
  return "all";
}

function getThemeGalleryResolvedPreviewMode(theme) {
  const runtimeMode = String(renderRuntime.themeGalleryPreviewMode || "").trim().toLowerCase();
  if (runtimeMode === "light" || runtimeMode === "dark" || runtimeMode === "all") {
    return runtimeMode;
  }
  const savedMode = getSavedThemeGalleryPreviewMode(theme?.id || "");
  if (savedMode !== "all") {
    return savedMode;
  }
  return getThemeGalleryDefaultPreviewMode(theme);
}

function buildThemeGalleryModeTone(seed, previewMode, variant = "preview") {
  if (!seed) {
    return "";
  }

  const tone = getThemeGalleryResolvedTone(renderRuntime.themeGalleryLivePreviewActive
    ? getThemeGalleryThemeById(getThemeGallerySelectionId())
    : getThemeGalleryThemeById(state.uiSettings.themeGalleryThemeId));
  const activeFactor = normalizeThemeGalleryToneValue(tone.x, 50) / 100;
  const baseAlpha = (variant === "dashboard"
    ? previewMode === "light" ? 0.16 : previewMode === "dark" ? 0.28 : 0.2
    : previewMode === "light" ? 0.18 : previewMode === "dark" ? 0.22 : 0.14) + activeFactor * 0.05;
  const glowAlpha = (variant === "dashboard"
    ? previewMode === "light" ? 0.12 : previewMode === "dark" ? 0.18 : 0.14
    : previewMode === "light" ? 0.14 : previewMode === "dark" ? 0.16 : 0.12) + activeFactor * 0.08;
  const veilStart = previewMode === "light"
    ? rgbaFromHex(mixHexColors(seed.tint, "#ffffff", 0.82), baseAlpha)
    : previewMode === "dark"
      ? rgbaFromHex(mixHexColors(seed.tint, "#03060c", 0.58), baseAlpha)
      : rgbaFromHex(mixHexColors(seed.tint, "#ffffff", 0.24), baseAlpha * 0.72);
  const veilEnd = previewMode === "light"
    ? rgbaFromHex(mixHexColors(seed.highlight, "#ffffff", 0.76), baseAlpha * 0.3)
    : previewMode === "dark"
      ? rgbaFromHex(mixHexColors(seed.tint, "#02040a", 0.72), baseAlpha * 0.82)
      : rgbaFromHex(mixHexColors(seed.accent, seed.tint, 0.44), baseAlpha * 0.4);

  return `linear-gradient(180deg, ${veilStart} 0%, ${veilEnd} 100%), radial-gradient(circle at 16% 18%, ${rgbaFromHex(seed.accent, glowAlpha)}, transparent 24%), radial-gradient(circle at 82% 14%, ${rgbaFromHex(seed.highlight, glowAlpha * 0.86)}, transparent 20%)`;
}

function buildThemeGalleryToneOverlay(seed, tone, variant = "preview") {
  if (!seed) {
    return "";
  }

  const activeFactor = normalizeThemeGalleryToneValue(tone.x, 50) / 100;
  const auroraFactor = normalizeThemeGalleryToneValue(tone.y, 50) / 100;
  const borealisColor = mixHexColors(seed.accent, "#58f1d2", 0.44);
  const australisColor = mixHexColors(seed.accent, "#f07fff", 0.4);
  const borealisHighlight = mixHexColors(seed.highlight, "#dfffee", 0.38);
  const australisHighlight = mixHexColors(seed.highlight, "#ffc5d9", 0.34);
  const leftColor = mixHexColors(borealisColor, australisColor, auroraFactor);
  const rightColor = mixHexColors(australisColor, borealisColor, 1 - auroraFactor);
  const variantStrength = variant === "dashboard" ? 0.26 : variant === "detail" ? 0.3 : 0.34;
  const energy = 0.18 + activeFactor * variantStrength;
  const glow = 0.12 + activeFactor * (variantStrength + 0.06);
  const topColor = mixHexColors(borealisHighlight, australisHighlight, auroraFactor);
  const bottomColor = mixHexColors(australisHighlight, borealisHighlight, 1 - auroraFactor);

  return [
    `radial-gradient(circle at ${18 + activeFactor * 26}% ${20 + auroraFactor * 18}%, ${rgbaFromHex(leftColor, glow)}, transparent 30%)`,
    `radial-gradient(circle at ${78 - activeFactor * 18}% ${78 - auroraFactor * 22}%, ${rgbaFromHex(rightColor, glow * 0.92)}, transparent 32%)`,
    `linear-gradient(135deg, ${rgbaFromHex(topColor, energy * 0.78)} 0%, ${rgbaFromHex(leftColor, energy * 0.38)} 42%, ${rgbaFromHex(bottomColor, energy * 0.82)} 100%)`,
  ].join(", ");
}

function getPreferredThemeGalleryPreviewMode(theme, { preserveRuntime = false } = {}) {
  const runtimeMode = normalizeThemeGalleryPreviewMode(renderRuntime.themeGalleryPreviewMode, "");
  if (preserveRuntime && runtimeMode) {
    return runtimeMode;
  }

  const activeThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  if (theme?.id && theme.id === activeThemeId) {
    return getSavedThemeGalleryPreviewMode(theme.id);
  }

  if (runtimeMode) {
    return runtimeMode;
  }

  return getThemeGalleryDefaultPreviewMode(theme);
}

function getThemeGalleryMotionDescription(preset) {
  const normalized = normalizeThemeGalleryMotionPreset(preset, "calm");
  switch (normalized) {
    case "left":
      return "Wallpaper bergerak perlahan dari kanan ke kiri seperti pan sinematik Opera.";
    case "right":
      return "Wallpaper bergerak perlahan dari kiri ke kanan untuk efek live wallpaper.";
    case "up":
      return "Wallpaper naik lembut dari bawah ke atas.";
    case "down":
      return "Wallpaper turun halus dari atas ke bawah.";
    case "diag-up-left":
      return "Wallpaper bergerak diagonal ke kiri atas dengan rasa cinematic.";
    case "diag-up-right":
      return "Wallpaper bergerak diagonal ke kanan atas dengan rasa ringan.";
    case "diag-down-left":
      return "Wallpaper bergerak diagonal ke kiri bawah dengan motion yang halus.";
    case "diag-down-right":
      return "Wallpaper bergerak diagonal ke kanan bawah seperti live scene.";
    default:
      return "Wallpaper tetap hidup lembut di tengah seperti Opera.";
  }
}

function updateThemeGalleryMotionUi(theme) {
  const motionPreset = getThemeGalleryResolvedMotionPreset(theme);
  document.querySelectorAll("[data-theme-motion-preset]").forEach((button) => {
    if (button instanceof HTMLButtonElement) {
      const preset = button.getAttribute("data-theme-motion-preset");
      button.classList.toggle("active", preset === motionPreset);
      button.disabled = false;
    }
  });

  const motionConfig = getThemeGalleryWallpaperMotionConfig(motionPreset);
  if (elements.themeGalleryMotionLabel) {
    elements.themeGalleryMotionLabel.textContent = motionConfig.label;
  }
  if (elements.themeGalleryMotionDescription) {
    elements.themeGalleryMotionDescription.textContent = getThemeGalleryMotionDescription(motionPreset);
  }
}

function stopThemeWallpaperMotionLoop(resetTargets = true) {
  if (renderRuntime.themeWallpaperMotionFrameId) {
    cancelAnimationFrame(renderRuntime.themeWallpaperMotionFrameId);
    renderRuntime.themeWallpaperMotionFrameId = 0;
  }
  renderRuntime.themeWallpaperMotionStartedAt = 0;
  renderRuntime.themeWallpaperMotionLastStepAt = 0;
  renderRuntime.themeWallpaperMotionLastPosition = "";
  if (!resetTargets) {
    return;
  }

  const basePosition = document.documentElement.style.getPropertyValue("--desktop-image-position") || "center center";
  getDesktopBackgroundLayers().forEach((layer) => {
    if (layer instanceof HTMLDivElement) {
      layer.style.backgroundPosition =
        layer.dataset.liveWallpaperBasePosition ||
        layer.dataset.baseBackgroundPosition ||
        basePosition;
    }
  });
  if (elements.themeGalleryPreviewImage) {
    elements.themeGalleryPreviewImage.style.backgroundPosition =
      elements.themeGalleryPreviewImage.dataset.liveWallpaperBasePosition || "center center";
  }
}

function isDashboardRefreshStabilizing() {
  return document.documentElement.dataset.refreshStabilizing === "true";
}

function setDashboardRefreshStabilizing(active) {
  document.documentElement.dataset.refreshStabilizing = active ? "true" : "false";
  if (active) {
    stopThemeWallpaperMotionLoop(true);
  }
}

function scheduleDashboardRefreshRelease(delayMs = 220) {
  if (refreshStabilizeTimerId) {
    window.clearTimeout(refreshStabilizeTimerId);
  }
  refreshStabilizeTimerId = window.setTimeout(() => {
    refreshStabilizeTimerId = 0;
    setDashboardRefreshStabilizing(false);
    ensureThemeWallpaperMotionLoop();
  }, Math.max(0, delayMs));
}

function getCurrentThemeWallpaperMotionContext() {
  if (renderRuntime.themeGalleryLivePreviewActive) {
    const previewTheme = getThemeGalleryThemeById(getThemeGallerySelectionId());
    return {
      theme: previewTheme,
      preset: previewTheme ? getThemeGalleryResolvedMotionPreset(previewTheme) : "calm",
    };
  }

  const activeTheme = getThemeGalleryThemeById(state.uiSettings.themeGalleryThemeId);
  return {
    theme: activeTheme,
    preset: activeTheme ? getSavedThemeGalleryMotionPreset(activeTheme.id) : "calm",
  };
}

function tickThemeWallpaperMotion(now) {
  if (isDashboardRefreshStabilizing()) {
    stopThemeWallpaperMotionLoop(true);
    return;
  }
  const { theme } = getCurrentThemeWallpaperMotionContext();
  const animatedEnabled = getThemeGalleryResolvedAnimatedWallpaperEnabled(theme);
  if (!isThemeGalleryWallpaperTheme(theme) || !animatedEnabled) {
    stopThemeWallpaperMotionLoop(true);
    return;
  }

  if (!renderRuntime.themeWallpaperMotionStartedAt) {
    renderRuntime.themeWallpaperMotionStartedAt = now;
  }
  if (renderRuntime.themeWallpaperMotionLastStepAt && now - renderRuntime.themeWallpaperMotionLastStepAt < 40) {
    renderRuntime.themeWallpaperMotionFrameId = requestAnimationFrame(tickThemeWallpaperMotion);
    return;
  }
  renderRuntime.themeWallpaperMotionLastStepAt = now;

  const elapsed = now - renderRuntime.themeWallpaperMotionStartedAt;
  const tone = getThemeGalleryResolvedTone(theme);
  const liveProfile = getThemeGalleryWallpaperLiveProfile(theme);
  const activeFactor = normalizeThemeGalleryToneValue(tone.x, 50) / 100;
  const auroraFactor = normalizeThemeGalleryToneValue(tone.y, 50) / 100;
  const speedPreset = getLiveWallpaperSpeedPreset(state.uiSettings.liveWallpaperSpeed);
  const cycleMs = Math.max(Number(speedPreset.durationMs || 26000) * liveProfile.durationMultiplier, 16000);
  const baseX = clampNumber(42 + ((tone.x - 50) / 50) * 10, 32, 68);
  const baseY = clampNumber(42 + ((tone.y - 50) / 50) * 10, 32, 68);
  const progressToPingPong = (value) => (value < 0.5 ? value * 2 : (1 - value) * 2);
  const motionEase = getThemeGalleryMotionEasingByName(liveProfile.motionEase);
  const softEase = getThemeGalleryMotionEasingByName(liveProfile.filterEase);
  const primaryCycleProgress = ((elapsed % cycleMs) / cycleMs);
  const secondaryCycleMs = cycleMs * 1.34;
  const secondaryCycleProgress = (((elapsed + cycleMs * (0.18 + auroraFactor * 0.08)) % secondaryCycleMs) / secondaryCycleMs);
  const verticalCycleProgress = (((elapsed + cycleMs * (0.28 + activeFactor * 0.12)) % (cycleMs * 1.12)) / (cycleMs * 1.12));
  const primaryProgress = motionEase(progressToPingPong(primaryCycleProgress));
  const secondaryProgress = softEase(progressToPingPong(secondaryCycleProgress));
  const verticalProgress = motionEase(progressToPingPong(verticalCycleProgress));
  const driftX = (2.2 + activeFactor * 4.2) * liveProfile.driftScaleX;
  const driftY = (1.8 + auroraFactor * 3.4) * liveProfile.driftScaleY;
  const startX = clampNumber(baseX - driftX, 28, 72);
  const endX = clampNumber(baseX + driftX, 28, 72);
  const startY = clampNumber(baseY - driftY, 28, 72);
  const endY = clampNumber(baseY + driftY, 28, 72);
  let x = baseX;
  let y = baseY;
  switch (liveProfile.path) {
    case "aurora-curtain":
      x = baseX + Math.sin(primaryCycleProgress * Math.PI * 2) * (driftX * 0.62)
        + Math.sin(secondaryCycleProgress * Math.PI * 2) * (1.2 + auroraFactor * 1.8);
      y = baseY + Math.cos((primaryCycleProgress * Math.PI * 2) * 0.54 + auroraFactor) * (driftY * 0.72)
        + Math.sin((secondaryCycleProgress * Math.PI * 2) * 0.82) * (0.9 + activeFactor * 1.2);
      break;
    case "orbital-cosmic":
      x = baseX + Math.cos(primaryCycleProgress * Math.PI * 2) * (driftX * 0.74)
        + Math.sin((secondaryCycleProgress * Math.PI * 2) * 0.68) * (1.1 + activeFactor * 1.1);
      y = baseY + Math.sin((primaryCycleProgress * Math.PI * 2) * 0.82) * (driftY * 0.68)
        + Math.cos((verticalCycleProgress * Math.PI * 2) * 0.58) * (1 + auroraFactor * 1.2);
      break;
    case "neon-sweep":
      x = startX + (endX - startX) * primaryProgress + ((secondaryProgress - 0.5) * (1.6 + activeFactor * 1.5));
      y = startY + (endY - startY) * softEase(progressToPingPong((verticalCycleProgress + 0.18) % 1))
        + ((secondaryProgress - 0.5) * (0.82 + auroraFactor * 1));
      break;
    case "urban-drift":
      x = startX + (endX - startX) * primaryProgress + Math.sin((secondaryCycleProgress * Math.PI * 2) * 0.88) * (1 + auroraFactor);
      y = baseY + Math.cos((verticalCycleProgress * Math.PI * 2) * 0.76) * (driftY * 0.56)
        + Math.sin((primaryCycleProgress * Math.PI * 2) * 0.42) * (0.8 + activeFactor);
      break;
    case "airy-pan":
      x = startX + (endX - startX) * primaryProgress;
      y = baseY + Math.sin((verticalCycleProgress * Math.PI * 2) * 0.6) * (driftY * 0.34)
        + ((secondaryProgress - 0.5) * 0.68);
      break;
    case "satin-float":
      x = baseX + Math.sin(primaryCycleProgress * Math.PI * 2) * (driftX * 0.32);
      y = baseY + Math.cos((verticalCycleProgress * Math.PI * 2) * 0.72) * (driftY * 0.28);
      break;
    default:
      x = startX + (endX - startX) * primaryProgress + ((secondaryProgress - 0.5) * (1.2 + auroraFactor * 1.2));
      y = startY + (endY - startY) * verticalProgress + ((secondaryProgress - 0.5) * (0.9 + activeFactor));
      break;
  }
  x = clampNumber(x, 28, 72);
  y = clampNumber(y, 28, 72);
  const position = `${x.toFixed(2)}% ${y.toFixed(2)}%`;
  if (renderRuntime.themeWallpaperMotionLastPosition === position) {
    renderRuntime.themeWallpaperMotionFrameId = requestAnimationFrame(tickThemeWallpaperMotion);
    return;
  }
  renderRuntime.themeWallpaperMotionLastPosition = position;

  getDesktopBackgroundLayers().forEach((layer) => {
    if (layer instanceof HTMLDivElement && layer.classList.contains("is-visible")) {
      layer.style.backgroundPosition = position;
    }
  });
  if (elements.themeGalleryPreviewImage) {
    elements.themeGalleryPreviewImage.style.backgroundPosition = position;
  }

  renderRuntime.themeWallpaperMotionFrameId = requestAnimationFrame(tickThemeWallpaperMotion);
}

function ensureThemeWallpaperMotionLoop() {
  stopThemeWallpaperMotionLoop(true);
}

function getThemeGallerySeedByPreviewMode(seed, previewMode, tone = { x: 50, y: 50 }) {
  if (!seed) {
    return null;
  }

  const activeFactor = normalizeThemeGalleryToneValue(tone.x, 50) / 100;
  const auroraFactor = normalizeThemeGalleryToneValue(tone.y, 50) / 100;
  const borealisAccent = mixHexColors(seed.accent, "#59f6d3", 0.26);
  const australisAccent = mixHexColors(seed.accent, "#d06cff", 0.24);
  const borealisTint = mixHexColors(seed.tint, "#113e34", 0.18);
  const australisTint = mixHexColors(seed.tint, "#3b165c", 0.2);
  const borealisHighlight = mixHexColors(seed.highlight, "#e7ffe3", 0.24);
  const australisHighlight = mixHexColors(seed.highlight, "#ffc6df", 0.2);
  const dynamicSeed = {
    accent: mixHexColors(borealisAccent, australisAccent, auroraFactor),
    tint: mixHexColors(borealisTint, australisTint, auroraFactor),
    highlight: mixHexColors(borealisHighlight, australisHighlight, auroraFactor),
  };
  const liveWallpaperAccent = getLiveWallpaperAccentColor();
  const accentBlendRatio = liveWallpaperAccent === c_white ? 0 : 0.3;
  const liveWallpaperSeed = {
    accent: mixHexColors(dynamicSeed.accent, liveWallpaperAccent, accentBlendRatio),
    tint: mixHexColors(dynamicSeed.tint, liveWallpaperAccent, accentBlendRatio * 0.18),
    highlight: mixHexColors(dynamicSeed.highlight, liveWallpaperAccent, accentBlendRatio * 0.26),
  };

  if (previewMode === "light") {
    return {
      accent: mixHexColors(liveWallpaperSeed.accent, "#ffffff", 0.24 + activeFactor * 0.12),
      tint: mixHexColors(liveWallpaperSeed.tint, "#f6f8ff", 0.74 - activeFactor * 0.08),
      highlight: mixHexColors(liveWallpaperSeed.highlight, "#ffffff", 0.28 + activeFactor * 0.1),
    };
  }

  if (previewMode === "dark") {
    return {
      accent: mixHexColors(liveWallpaperSeed.accent, "#8ea8ff", 0.08 + activeFactor * 0.18),
      tint: mixHexColors(liveWallpaperSeed.tint, "#02050d", 0.78 - activeFactor * 0.08),
      highlight: mixHexColors(liveWallpaperSeed.highlight, liveWallpaperSeed.tint, 0.44 - activeFactor * 0.1),
    };
  }

  return {
    accent: mixHexColors(liveWallpaperSeed.accent, "#ffffff", 0.04 + activeFactor * 0.12),
    tint: mixHexColors(liveWallpaperSeed.tint, liveWallpaperSeed.accent, activeFactor * 0.14),
    highlight: mixHexColors(liveWallpaperSeed.highlight, "#ffffff", 0.02 + activeFactor * 0.08),
  };
}

function buildThemeGalleryVisuals(theme, previewMode) {
  const tone = getThemeGalleryResolvedTone(theme);
  const explicitPreviewBackground = theme?.previewBackground || theme?.cardBackground || "";
  const explicitDetailBackdrop = theme?.detailBackdrop || explicitPreviewBackground;
  const explicitDashboardBackground = theme?.dashboardBackground || explicitDetailBackdrop;
  const explicitSeed = getThemeGalleryUiSeed(theme);
  const isWallpaperTheme = Boolean(theme?.imagePath);
  if (explicitPreviewBackground || explicitDetailBackdrop || explicitDashboardBackground) {
    return {
      previewBackground: [
        buildThemeGalleryToneOverlay(explicitSeed, tone, "preview"),
        buildThemeGalleryModeTone(explicitSeed, previewMode, "preview"),
        explicitPreviewBackground,
      ]
        .filter(Boolean)
        .join(", "),
      detailBackdrop: [
        buildThemeGalleryToneOverlay(explicitSeed, tone, "detail"),
        buildThemeGalleryModeTone(explicitSeed, previewMode, "detail"),
        explicitDetailBackdrop,
      ]
        .filter(Boolean)
        .join(", "),
      dashboardBackground: isWallpaperTheme
        ? explicitDashboardBackground
        : [
          buildThemeGalleryToneOverlay(explicitSeed, tone, "dashboard"),
          buildThemeGalleryModeTone(explicitSeed, previewMode, "dashboard"),
          explicitDashboardBackground,
        ]
          .filter(Boolean)
          .join(", "),
      overlayOpacity:
        isWallpaperTheme
          ? previewMode === "light"
            ? "0.014"
            : previewMode === "dark"
              ? "0.024"
              : "0.018"
          : previewMode === "light"
            ? String(Number(theme?.overlayOpacity || "0.14") + tone.x / 900)
            : previewMode === "dark"
              ? String(0.08 + tone.x / 1400)
              : String(Number(theme?.overlayOpacity || "0.1") + tone.x / 1200),
    };
  }

  const seed = getThemeGallerySeedByPreviewMode(getThemeGalleryUiSeed(theme), previewMode, tone);
  if (!seed) {
    return {
      previewBackground: theme?.previewBackground || "",
      detailBackdrop: theme?.detailBackdrop || "",
      dashboardBackground: theme?.dashboardBackground || "",
      overlayOpacity: theme?.overlayOpacity || "0.08",
    };
  }

  const accentGlow = mixHexColors(seed.accent, "#ffffff", 0.18);
  const softAccent = mixHexColors(seed.accent, seed.highlight, 0.22);
  const brightHighlight = mixHexColors(seed.highlight, "#ffffff", 0.22);
  const baseMid = mixHexColors(seed.tint, seed.accent, 0.24);
  const baseEnd = mixHexColors(seed.tint, "#040913", previewMode === "light" ? 0.08 : 0.3);
  const overlayOpacity = previewMode === "light"
    ? String(0.16 + tone.x / 700)
    : previewMode === "dark"
      ? String(0.08 + tone.x / 1200)
      : String(Number(theme?.overlayOpacity || "0.12") + tone.x / 1000);

  return {
    previewBackground:
      `${buildThemeGalleryToneOverlay(seed, tone, "preview")}, radial-gradient(circle at 18% 22%, ${rgbaFromHex(accentGlow, 0.32)}, transparent 20%), radial-gradient(circle at 78% 16%, ${rgbaFromHex(brightHighlight, 0.28)}, transparent 20%), linear-gradient(145deg, ${mixHexColors(baseMid, "#ffffff", previewMode === "light" ? 0.34 : 0)} 0%, ${baseMid} 48%, ${baseEnd} 100%)`,
    detailBackdrop:
      `${buildThemeGalleryToneOverlay(seed, tone, "detail")}, radial-gradient(circle at 14% 20%, ${rgbaFromHex(accentGlow, 0.16)}, transparent 18%), radial-gradient(circle at 82% 14%, ${rgbaFromHex(brightHighlight, 0.12)}, transparent 18%), linear-gradient(145deg, ${mixHexColors(seed.tint, seed.accent, 0.16)} 0%, ${baseMid} 44%, ${baseEnd} 100%)`,
    dashboardBackground:
      `${buildThemeGalleryToneOverlay(seed, tone, "dashboard")}, radial-gradient(circle at top right, ${rgbaFromHex(softAccent, 0.18)}, transparent 28%), radial-gradient(circle at 15% 20%, ${rgbaFromHex(accentGlow, 0.14)}, transparent 22%), radial-gradient(circle at bottom left, ${rgbaFromHex(brightHighlight, 0.1)}, transparent 24%), linear-gradient(180deg, ${rgbaFromHex(mixHexColors(seed.tint, "#07101d", 0.22), 0.72)} 0%, ${rgbaFromHex(baseMid, 0.58)} 52%, ${rgbaFromHex(baseEnd, 0.74)} 100%)`,
    overlayOpacity,
  };
}

function buildDashboardThemeVars(theme, previewMode = "all") {
  const baseSeed = getThemeGalleryUiSeed(theme);
  const tone = getThemeGalleryResolvedTone(theme);
  const seed = getThemeGallerySeedByPreviewMode(baseSeed, previewMode, tone);
  if (!seed || (theme?.id === "default-dashboard" && previewMode === "all")) {
    return DEFAULT_THEMEABLE_CSS_VARS;
  }

  const accent = seed.accent;
  const highlight = seed.highlight;
  const tint = seed.tint;
  const cardTint = mixHexColors(seed.tint, seed.accent, 0.2);
  const softTint = mixHexColors(seed.tint, seed.highlight, 0.14);
  const deepTint = mixHexColors(tint, "#050b16", 0.34);
  const deeperTint = mixHexColors(tint, "#040812", 0.48);
  const strongTextBase = getReadableTextColor(
    previewMode === "light" ? mixHexColors(cardTint, "#ffffff", 0.34) : mixHexColors(cardTint, deepTint, 0.2)
  );
  const useDarkText = strongTextBase === "#172033";
  const strongText = useDarkText
    ? mixHexColors("#172033", accent, 0.08)
    : mixHexColors("#f7fbff", seed.accent, 0.08);
  const softText = useDarkText
    ? mixHexColors(strongText, "#667489", 0.36)
    : mixHexColors(strongText, "#bed0e8", 0.32);
  const mutedText = useDarkText
    ? mixHexColors(strongText, "#7c8898", 0.56)
    : mixHexColors(strongText, "#8ea5c3", 0.54);
  const cyanSoft = useDarkText
    ? mixHexColors("#22425d", accent, 0.46)
    : mixHexColors(seed.accent, "#ffffff", 0.5);
  const goldSoft = useDarkText
    ? mixHexColors("#6b4f08", highlight, 0.48)
    : mixHexColors(seed.highlight, "#ffffff", 0.44);
  const entryCodeColor = mixHexColors("#f7fbff", cyanSoft, 0.08);
  const entryLimitColor = mixHexColors("#f7fbff", highlight, 0.2);
  const entryPositiveColor = mixHexColors("#f7fffb", "#7fffd4", 0.72);
  const entryNegativeColor = mixHexColors("#fff5f7", "#ff8fa3", 0.72);
  const brightAccent = mixHexColors(accent, "#ffffff", 0.14);
  const darkAccent = mixHexColors(accent, tint, 0.34);
  const softHighlight = mixHexColors(highlight, "#ffffff", 0.24);
  const accentViolet = mixHexColors(accent, "#8a63ff", 0.3);
  const hasThemeWallpaper = Boolean(theme?.dashboardBackground);
  const tableStart = mixHexColors(highlight, accent, 0.18);
  const tableEnd = mixHexColors(highlight, "#ffffff", 0.14);
  const tableStripBase = hasThemeWallpaper
    ? useDarkText
      ? mixHexColors(mixHexColors(highlight, accent, 0.3), "#f4d457", 0.26)
      : mixHexColors(mixHexColors(accent, highlight, 0.38), "#fff1a8", 0.24)
    : previewMode === "light"
      ? mixHexColors(mixHexColors(highlight, accent, 0.3), "#ffe88a", 0.18)
      : mixHexColors(mixHexColors(highlight, accent, 0.22), "#f5d54e", 0.24);
  const tableText = getReadableTextColor(tableStripBase, { light: "#f7fbff", dark: "#081018" });
  const tableCodeText = tableText;
  const tableApproveText = tableText;
  const tableBalanceText = tableText;
  const tableCodeBg = "transparent";
  const tableApproveBg = "transparent";
  const tableBalanceBg = "transparent";
  const tableCodeBorder = "transparent";
  const tableApproveBorder = "transparent";
  const tableBalanceBorder = "transparent";
  const tableStripTopBorder = rgbaFromHex(
    mixHexColors(tableStripBase, tableText === "#081018" ? "#ffffff" : "#f7fbff", tableText === "#081018" ? 0.34 : 0.18),
    tableText === "#081018" ? 0.42 : 0.24
  );
  const tableStripBottomBorder = rgbaFromHex(
    mixHexColors(tableStripBase, tableText === "#081018" ? "#081018" : "#dce7ff", tableText === "#081018" ? 0.7 : 0.52),
    tableText === "#081018" ? 0.36 : 0.28
  );
  const tableStripDivider = rgbaFromHex(tableText === "#081018" ? "#081018" : "#f7fbff", tableText === "#081018" ? 0.26 : 0.22);
  const logoText = useDarkText
    ? mixHexColors("#5b4300", highlight, 0.48)
    : mixHexColors(highlight, "#ffffff", 0.18);
  const cleanGlossyPanelTop = useDarkText
    ? rgbaFromHex(mixHexColors("#ffffff", tint, 0.92), 0.032)
    : rgbaFromHex(mixHexColors("#ffffff", accent, 0.92), 0.015);
  const cleanGlossyPanelBottom = useDarkText
    ? rgbaFromHex(mixHexColors("#ffffff", tint, 0.97), 0.012)
    : rgbaFromHex(mixHexColors("#ffffff", accent, 0.98), 0.008);
  const cleanGlossyPanelAccent = rgbaFromHex(mixHexColors(accent, "#ffffff", 0.34), useDarkText ? 0.035 : 0.02);
  const cleanGlossyPanelHighlight = rgbaFromHex(mixHexColors(highlight, "#ffffff", 0.3), useDarkText ? 0.026 : 0.015);
  const overlayVeil =
    hasThemeWallpaper
      ? `linear-gradient(180deg, ${rgbaFromHex(mixHexColors("#ffffff", tint, useDarkText ? 0.96 : 0.99), useDarkText ? 0.022 : 0.01)} 0%, ${rgbaFromHex(mixHexColors("#ffffff", tint, useDarkText ? 0.99 : 0.998), useDarkText ? 0.006 : 0.003)} 100%), radial-gradient(circle at top right, ${rgbaFromHex(accent, useDarkText ? 0.03 : 0.016)}, transparent 36%), radial-gradient(circle at bottom left, ${rgbaFromHex(highlight, useDarkText ? 0.026 : 0.012)}, transparent 32%)`
      : `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(tint, "#050a12", previewMode === "light" ? 0.12 : 0.42), previewMode === "light" ? 0.16 : 0.42)} 0%, ${rgbaFromHex(mixHexColors(tint, "#020409", previewMode === "light" ? 0.2 : 0.58), previewMode === "light" ? 0.08 : 0.32)} 100%), radial-gradient(circle at top right, ${rgbaFromHex(accent, previewMode === "light" ? 0.08 : 0.1)}, transparent 30%), radial-gradient(circle at bottom left, ${rgbaFromHex(highlight, previewMode === "light" ? 0.06 : 0.08)}, transparent 24%)`;
  const gridOpacity = hasThemeWallpaper
    ? theme?.id === "cyberroom"
      ? "0.26"
      : theme?.id === "night-drive"
        ? "0.22"
        : theme?.id === "interstellar"
          ? "0.16"
          : previewMode === "light"
            ? "0.12"
            : "0.18"
    : previewMode === "light"
      ? "0.34"
      : previewMode === "dark"
        ? "0.58"
        : "0.46";
  const orbOpacity = hasThemeWallpaper
    ? theme?.id === "classic" || theme?.id === "pearl-bloom" || theme?.id === "alpine-mist"
      ? "0.18"
      : theme?.id === "cyberroom" || theme?.id === "night-drive"
        ? "0.32"
        : "0.24"
    : "0.55";

  return {
    "--bg-panel": rgbaFromHex(tint, 0.82),
    "--bg-card": rgbaFromHex(cardTint, 0.86),
    "--bg-soft": rgbaFromHex(softTint, 0.58),
    "--line": rgbaFromHex(accent, 0.34),
    "--line-soft": rgbaFromHex(accent, 0.18),
    "--cyan": accent,
    "--cyan-soft": cyanSoft,
    "--gold": highlight,
    "--gold-soft": goldSoft,
    "--white": strongText,
    "--text-soft": softText,
    "--text-muted": mutedText,
    "--shadow-neon": `0 0 0 1px ${rgbaFromHex(accent, 0.18)}, 0 0 34px ${rgbaFromHex(accent, 0.12)}`,
    "--dashboard-glow-top":
      `radial-gradient(circle at 14% 18%, ${rgbaFromHex(highlight, 0.14)}, transparent 20%), radial-gradient(circle at 86% 12%, ${rgbaFromHex(accent, 0.12)}, transparent 18%), radial-gradient(circle at 50% 0%, ${rgbaFromHex(brightAccent, 0.14)}, transparent 30%)`,
    "--dashboard-main-border": rgbaFromHex(accent, 0.24),
    "--dashboard-main-bg":
      hasThemeWallpaper
        ? `linear-gradient(180deg, ${cleanGlossyPanelTop} 0%, ${cleanGlossyPanelBottom} 100%), linear-gradient(135deg, ${cleanGlossyPanelAccent} 0%, transparent 42%, ${cleanGlossyPanelHighlight} 100%)`
        : `linear-gradient(180deg, ${rgbaFromHex(tint, 0.66)}, ${rgbaFromHex(deepTint, 0.76)}), radial-gradient(circle at top center, ${rgbaFromHex(highlight, 0.07)}, transparent 28%)`,
    "--dashboard-main-overlay":
      hasThemeWallpaper
        ? `linear-gradient(180deg, rgba(255, 255, 255, ${useDarkText ? 0.02 : 0.012}) 0%, transparent 24%, rgba(255, 255, 255, ${useDarkText ? 0.006 : 0.004}) 100%), radial-gradient(circle at top right, ${rgbaFromHex(accent, useDarkText ? 0.028 : 0.016)}, transparent 30%), radial-gradient(circle at bottom left, ${rgbaFromHex(accentViolet, useDarkText ? 0.02 : 0.012)}, transparent 32%)`
        : `radial-gradient(circle at top right, ${rgbaFromHex(accent, 0.14)}, transparent 24%), radial-gradient(circle at bottom left, ${rgbaFromHex(accentViolet, 0.12)}, transparent 28%)`,
    "--dashboard-main-top-line": `linear-gradient(90deg, transparent, ${rgbaFromHex(accent, 0.86)}, ${rgbaFromHex(highlight, 0.52)}, transparent)`,
    "--glow-card-bg":
      `linear-gradient(180deg, ${rgbaFromHex(cardTint, 0.95)}, ${rgbaFromHex(deeperTint, 0.96)}), radial-gradient(circle at top center, ${rgbaFromHex(brightAccent, 0.1)}, transparent 58%)`,
    "--glow-card-shadow":
      `0 0 0 1px ${rgbaFromHex(accent, 0.08)}, 0 18px 44px rgba(0, 0, 0, 0.34), 0 0 34px ${rgbaFromHex(accent, 0.08)}`,
    "--stat-card-border": rgbaFromHex(accent, 0.24),
    "--stat-card-bg":
      hasThemeWallpaper
        ? `linear-gradient(180deg, ${rgbaFromHex(cardTint, useDarkText ? 0.28 : 0.2)}, ${rgbaFromHex(deeperTint, useDarkText ? 0.36 : 0.24)}), radial-gradient(circle at top center, ${rgbaFromHex(highlight, useDarkText ? 0.08 : 0.045)}, transparent 38%)`
        : `linear-gradient(180deg, ${rgbaFromHex(cardTint, 0.88)}, ${rgbaFromHex(deeperTint, 0.92)}), radial-gradient(circle at top center, ${rgbaFromHex(highlight, 0.08)}, transparent 35%)`,
    "--stat-card-before":
      hasThemeWallpaper
        ? `radial-gradient(circle at 20% 18%, ${rgbaFromHex(accent, 0.24)}, transparent 28%), radial-gradient(circle at 84% 12%, ${rgbaFromHex(highlight, 0.16)}, transparent 24%), linear-gradient(135deg, rgba(255, 255, 255, 0.09), transparent 56%)`
        : `radial-gradient(circle at 20% 18%, ${rgbaFromHex(accent, 0.18)}, transparent 26%), radial-gradient(circle at 84% 12%, ${rgbaFromHex(highlight, 0.1)}, transparent 24%), linear-gradient(135deg, rgba(255, 255, 255, 0.05), transparent 56%)`,
    "--stat-card-after":
      hasThemeWallpaper
        ? `linear-gradient(115deg, transparent 22%, rgba(255, 255, 255, 0.12) 48%, transparent 74%), linear-gradient(180deg, ${rgbaFromHex(highlight, 0.06)}, transparent 42%)`
        : `linear-gradient(115deg, transparent 24%, rgba(255, 255, 255, 0.08) 48%, transparent 72%), linear-gradient(180deg, ${rgbaFromHex(highlight, 0.03)}, transparent 40%)`,
    "--stat-label-color": hasThemeWallpaper
      ? mixHexColors(strongText, cyanSoft, useDarkText ? 0.28 : 0.2)
      : mixHexColors(cyanSoft, "#d6e3f8", 0.26),
    "--action-panel-border": rgbaFromHex(accent, 0.24),
    "--action-panel-bg":
      hasThemeWallpaper
        ? `linear-gradient(180deg, ${rgbaFromHex(cardTint, useDarkText ? 0.15 : 0.09)}, ${rgbaFromHex(deepTint, useDarkText ? 0.22 : 0.12)}), radial-gradient(circle at top center, ${rgbaFromHex(accent, useDarkText ? 0.05 : 0.028)}, transparent 46%)`
        : `linear-gradient(180deg, ${rgbaFromHex(cardTint, 0.9)}, ${rgbaFromHex(deepTint, 0.96)}), radial-gradient(circle at top center, ${rgbaFromHex(accent, 0.1)}, transparent 42%)`,
    "--action-panel-before":
      `radial-gradient(circle at 50% -10%, ${rgbaFromHex(highlight, 0.1)}, transparent 38%), linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent 28%)`,
    "--action-btn-border": rgbaFromHex(mixHexColors(accent, highlight, 0.18), hasThemeWallpaper ? 0.62 : 0.54),
    "--action-btn-bg":
      hasThemeWallpaper
        ? `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(cardTint, accent, 0.08), useDarkText ? 0.84 : 0.78)}, ${rgbaFromHex(mixHexColors(deeperTint, accent, 0.1), useDarkText ? 0.9 : 0.84)})`
        : `linear-gradient(180deg, ${rgbaFromHex(cardTint, 0.95)}, ${rgbaFromHex(deeperTint, 0.96)})`,
    "--action-btn-hover-border": rgbaFromHex(mixHexColors(accent, highlight, 0.24), 0.88),
    "--action-btn-hover-bg":
      hasThemeWallpaper
        ? `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(cardTint, accent, 0.22), useDarkText ? 0.92 : 0.86)}, ${rgbaFromHex(mixHexColors(deeperTint, accent, 0.18), useDarkText ? 0.94 : 0.88)})`
        : `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(cardTint, accent, 0.16), 0.98)}, ${rgbaFromHex(mixHexColors(deeperTint, accent, 0.14), 0.98)})`,
    "--action-btn-text": getReadableTextColor(mixHexColors(cardTint, deeperTint, 0.46), { light: "#f7fbff", dark: "#0a1119" }),
    "--action-btn-hover-text": getReadableTextColor(mixHexColors(cardTint, accent, 0.2), { light: "#ffffff", dark: "#071018" }),
    "--action-btn-text-shadow":
      getReadableTextColor(mixHexColors(cardTint, deeperTint, 0.46), { light: "#f7fbff", dark: "#0a1119" }) === "#0a1119"
        ? `0 1px 0 rgba(255, 255, 255, 0.12), 0 1px 10px rgba(255, 255, 255, 0.04)`
        : `0 1px 0 rgba(255, 255, 255, 0.1), 0 0 14px ${rgbaFromHex(accent, 0.16)}`,
    "--action-btn-after-border": rgbaFromHex(cyanSoft, 0.16),
    "--action-btn-after-shadow":
      `inset 0 0 18px ${rgbaFromHex(accent, 0.08)}, 0 0 18px ${rgbaFromHex(accent, 0.08)}`,
    "--header-border": rgbaFromHex(accent, 0.18),
    "--header-bg":
      hasThemeWallpaper
        ? `linear-gradient(180deg, ${rgbaFromHex(cardTint, useDarkText ? 0.16 : 0.1)}, ${rgbaFromHex(deepTint, useDarkText ? 0.12 : 0.08)}), radial-gradient(circle at top left, ${rgbaFromHex(accent, useDarkText ? 0.035 : 0.018)}, transparent 34%)`
        : `linear-gradient(180deg, ${rgbaFromHex(cardTint, 0.72)}, ${rgbaFromHex(deepTint, 0.54)}), radial-gradient(circle at top left, ${rgbaFromHex(accent, 0.08)}, transparent 30%)`,
    "--header-title-color": useDarkText
      ? mixHexColors("#6f5311", highlight, 0.26)
      : mixHexColors(goldSoft, strongText, 0.14),
    "--header-title-shadow": useDarkText
      ? `0 0 14px ${rgbaFromHex(highlight, 0.16)}, 0 1px 0 ${rgbaFromHex("#ffffff", 0.12)}`
      : `0 0 18px ${rgbaFromHex(highlight, 0.24)}, 0 0 30px ${rgbaFromHex(goldSoft, 0.12)}`,
    "--header-pill-bg":
      `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(cardTint, "#10243a", 0.34), hasThemeWallpaper ? 0.82 : 0.88)}, ${rgbaFromHex(mixHexColors(deepTint, "#081624", 0.28), hasThemeWallpaper ? 0.74 : 0.82)}), linear-gradient(90deg, ${rgbaFromHex(highlight, 0.12)}, ${rgbaFromHex(accent, 0.08)})`,
    "--header-pill-border": rgbaFromHex(mixHexColors(accent, "#ffffff", 0.22), 0.34),
    "--header-pill-text": getReadableTextColor(mixHexColors(cardTint, "#10243a", 0.34), {
      light: "#eef8ff",
      dark: "#122131",
    }),
    "--logo-border": rgbaFromHex(highlight, 0.28),
    "--logo-bg":
      hasThemeWallpaper
        ? `linear-gradient(180deg, ${rgbaFromHex(cardTint, useDarkText ? 0.18 : 0.11)}, ${rgbaFromHex(deepTint, useDarkText ? 0.14 : 0.09)}), radial-gradient(circle at 28% 50%, ${rgbaFromHex(highlight, useDarkText ? 0.05 : 0.03)}, transparent 30%), radial-gradient(circle at 72% 50%, ${rgbaFromHex(accent, useDarkText ? 0.04 : 0.025)}, transparent 36%)`
        : `linear-gradient(180deg, ${rgbaFromHex(cardTint, 0.86)}, ${rgbaFromHex(deepTint, 0.56)}), radial-gradient(circle at 28% 50%, ${rgbaFromHex(highlight, 0.14)}, transparent 28%), radial-gradient(circle at 72% 50%, ${rgbaFromHex(accent, 0.1)}, transparent 34%)`,
    "--logo-shadow":
      `inset 0 1px 0 rgba(255, 255, 255, 0.05), inset 0 0 42px ${rgbaFromHex(highlight, 0.04)}, 0 20px 36px rgba(0, 0, 0, 0.24), 0 0 26px ${rgbaFromHex(highlight, 0.09)}, 0 0 38px ${rgbaFromHex(accent, 0.08)}`,
    "--logo-overlay-shadow":
      `inset 0 1px 0 ${rgbaFromHex(softHighlight, 0.16)}, inset 0 -1px 0 ${rgbaFromHex(accent, 0.1)}`,
    "--logo-live-beam":
      `linear-gradient(112deg, transparent 14%, rgba(255, 255, 255, ${hasThemeWallpaper ? 0.2 : 0.16}) 34%, ${rgbaFromHex(mixHexColors(highlight, "#fff1aa", 0.12), hasThemeWallpaper ? 0.26 : 0.22)} 48%, ${rgbaFromHex(mixHexColors(accent, "#ffffff", 0.18), hasThemeWallpaper ? 0.16 : 0.12)} 58%, transparent 76%)`,
    "--logo-live-veil":
      `radial-gradient(circle at 24% 42%, ${rgbaFromHex(highlight, hasThemeWallpaper ? 0.18 : 0.12)}, transparent 24%), radial-gradient(circle at 78% 48%, ${rgbaFromHex(accent, hasThemeWallpaper ? 0.16 : 0.1)}, transparent 28%), linear-gradient(180deg, rgba(255, 255, 255, ${hasThemeWallpaper ? 0.06 : 0.04}), transparent 44%, rgba(255, 255, 255, ${hasThemeWallpaper ? 0.035 : 0.02}) 100%)`,
    "--logo-live-glow":
      `0 0 0 1px rgba(255, 255, 255, ${hasThemeWallpaper ? 0.06 : 0.04}), 0 20px 42px rgba(0, 0, 0, 0.24), 0 0 28px ${rgbaFromHex(highlight, hasThemeWallpaper ? 0.16 : 0.1)}, 0 0 42px ${rgbaFromHex(accent, hasThemeWallpaper ? 0.12 : 0.08)}`,
    "--logo-image-filter":
      `drop-shadow(0 0 16px ${rgbaFromHex(highlight, hasThemeWallpaper ? 0.2 : 0.12)}) drop-shadow(0 0 28px rgba(255, 255, 255, ${hasThemeWallpaper ? 0.08 : 0.05})) drop-shadow(0 0 18px ${rgbaFromHex(accent, hasThemeWallpaper ? 0.12 : 0.08)})`,
    "--logo-image-opacity": hasThemeWallpaper ? "1" : "0.99",
    "--logo-text-color": logoText,
    "--logo-text-shadow": `0 0 12px ${rgbaFromHex(highlight, 0.35)}, 0 0 28px rgba(255, 255, 255, 0.08)`,
    "--badge-text": "#fff7ff",
    "--badge-radius":
      theme?.id === "classic" ? "22px" : theme?.id === "cyberroom" ? "12px" : theme?.id === "interstellar" ? "16px" : "999px",
    "--badge-bg":
      `linear-gradient(135deg, ${rgbaFromHex(mixHexColors("#ff5b92", highlight, 0.08), hasThemeWallpaper ? 0.26 : 0.22)} 0%, ${rgbaFromHex(mixHexColors("#ffab4c", highlight, 0.08), hasThemeWallpaper ? 0.26 : 0.22)} 18%, ${rgbaFromHex(mixHexColors("#ffdf58", highlight, 0.08), hasThemeWallpaper ? 0.28 : 0.24)} 34%, ${rgbaFromHex(mixHexColors("#62f5b0", accent, 0.08), hasThemeWallpaper ? 0.26 : 0.22)} 50%, ${rgbaFromHex(mixHexColors("#5ad6ff", accent, 0.1), hasThemeWallpaper ? 0.28 : 0.24)} 66%, ${rgbaFromHex(mixHexColors("#8c76ff", accent, 0.08), hasThemeWallpaper ? 0.28 : 0.24)} 82%, ${rgbaFromHex(mixHexColors("#ff61c1", highlight, 0.08), hasThemeWallpaper ? 0.26 : 0.22)} 100%), linear-gradient(90deg, rgba(255, 255, 255, 0.08), transparent)`,
    "--badge-border": rgbaFromHex(mixHexColors(mixHexColors("#8c76ff", accent, 0.16), "#ffffff", 0.12), 0.64),
    "--badge-shadow":
      `inset 0 1px 0 rgba(255, 248, 222, 0.18), 0 12px 22px rgba(0, 0, 0, 0.16), 0 0 16px ${rgbaFromHex(mixHexColors("#ff5b92", highlight, 0.08), hasThemeWallpaper ? 0.18 : 0.14)}, 0 0 22px ${rgbaFromHex(mixHexColors("#5ad6ff", accent, 0.1), hasThemeWallpaper ? 0.18 : 0.14)}, 0 0 28px ${rgbaFromHex(mixHexColors("#8c76ff", accent, 0.08), hasThemeWallpaper ? 0.16 : 0.12)}`,
    "--badge-text-shadow":
      `0 0 8px ${rgbaFromHex(mixHexColors("#ff5b92", highlight, 0.08), hasThemeWallpaper ? 0.26 : 0.22)}, 0 0 14px ${rgbaFromHex(mixHexColors("#5ad6ff", accent, 0.1), hasThemeWallpaper ? 0.22 : 0.18)}, 0 1px 0 rgba(255, 255, 255, 0.22)`,
    "--badge-sweep-bg":
      `linear-gradient(110deg, transparent 20%, rgba(255, 255, 255, ${hasThemeWallpaper ? 0.2 : 0.18}) 36%, ${rgbaFromHex(mixHexColors("#ff6fbf", highlight, 0.08), hasThemeWallpaper ? 0.28 : 0.24)} 50%, ${rgbaFromHex(mixHexColors("#60e0ff", accent, 0.1), hasThemeWallpaper ? 0.24 : 0.22)} 60%, transparent 78%)`,
    "--bank-column-bg": `linear-gradient(180deg, ${rgbaFromHex(cardTint, 0.92)} 0%, ${rgbaFromHex(deeperTint, 0.96)} 100%)`,
    "--bank-column-hover-border": rgbaFromHex(mixHexColors(accent, highlight, 0.24), 0.82),
    "--bank-column-hover-shadow":
      `inset 0 0 0 1px rgba(255, 255, 255, 0.04), 0 18px 36px rgba(0, 0, 0, 0.24), 0 0 0 1px ${rgbaFromHex(mixHexColors(accent, highlight, 0.24), 0.22)}, 0 0 28px ${rgbaFromHex(accent, 0.16)}`,
    "--bank-title-bg":
      `linear-gradient(180deg, ${rgbaFromHex(accent, hasThemeWallpaper ? 0.22 : 0.16)}, ${rgbaFromHex(accent, hasThemeWallpaper ? 0.08 : 0.04)}), linear-gradient(90deg, ${rgbaFromHex("#ffffff", hasThemeWallpaper ? 0.06 : 0.03)}, transparent)`,
    "--bank-title-border": rgbaFromHex(accent, 0.18),
    "--count-border": rgbaFromHex(highlight, 0.34),
    "--count-bg": hasThemeWallpaper
      ? `linear-gradient(180deg, ${rgbaFromHex(highlight, 0.18)}, ${rgbaFromHex(highlight, 0.07)})`
      : `linear-gradient(180deg, ${rgbaFromHex(highlight, 0.12)}, ${rgbaFromHex(highlight, 0.04)})`,
    "--count-text": goldSoft,
    "--table-head-bg": tableStripBase,
    "--table-head-top-border": tableStripTopBorder,
    "--table-head-bottom-border": tableStripBottomBorder,
    "--table-head-divider": tableStripDivider,
    "--table-head-text": tableText,
    "--table-head-code-text": tableCodeText,
    "--table-head-approve-text": tableApproveText,
    "--table-head-balance-text": tableBalanceText,
    "--table-head-code-bg": tableCodeBg,
    "--table-head-approve-bg": tableApproveBg,
    "--table-head-balance-bg": tableBalanceBg,
    "--table-head-code-border": tableCodeBorder,
    "--table-head-approve-border": tableApproveBorder,
    "--table-head-balance-border": tableBalanceBorder,
    "--entry-border": rgbaFromHex(accent, 0.18),
    "--entry-bg":
      `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(cardTint, accent, 0.12), 0.98)}, ${rgbaFromHex(deeperTint, 0.98)}), linear-gradient(90deg, rgba(255, 255, 255, 0.02), transparent)`,
    "--entry-hover-bg": rgbaFromHex(mixHexColors(accent, highlight, 0.12), 0.08),
    "--entry-hover-border": rgbaFromHex(mixHexColors(accent, highlight, 0.18), 0.24),
    "--entry-hover-card-border": rgbaFromHex(mixHexColors(accent, highlight, 0.2), 0.56),
    "--entry-hover-card-shadow": `0 12px 24px rgba(0, 0, 0, 0.22), 0 0 0 1px ${rgbaFromHex(mixHexColors(accent, highlight, 0.2), 0.16)}, 0 0 18px ${rgbaFromHex(accent, 0.12)}`,
    "--entry-code-color": entryCodeColor,
    "--entry-code-shadow": `0 0 12px ${rgbaFromHex(cyanSoft, 0.14)}`,
    "--entry-limit-color": entryLimitColor,
    "--entry-limit-shadow": `0 0 12px ${rgbaFromHex(highlight, 0.16)}`,
    "--entry-amount-positive-color": entryPositiveColor,
    "--entry-amount-positive-shadow": `0 0 14px ${rgbaFromHex("#7fffd4", 0.22)}`,
    "--entry-amount-negative-color": entryNegativeColor,
    "--entry-amount-negative-shadow": `0 0 14px ${rgbaFromHex("#ff8fa3", 0.22)}`,
    "--modal-panel-border": rgbaFromHex(accent, 0.16),
    "--modal-panel-bg":
      hasThemeWallpaper
        ? `linear-gradient(180deg, ${cleanGlossyPanelTop} 0%, ${rgbaFromHex(mixHexColors(deepTint, tint, 0.12), 0.9)} 100%), linear-gradient(135deg, ${rgbaFromHex(mixHexColors(accent, "#ffffff", 0.28), 0.05)} 0%, transparent 40%, ${rgbaFromHex(mixHexColors(highlight, "#ffffff", 0.24), 0.045)} 100%)`
        : `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(cardTint, accent, 0.14), 0.94)}, ${rgbaFromHex(mixHexColors(deepTint, tint, 0.08), 0.98)}), radial-gradient(circle at top right, ${rgbaFromHex(accent, 0.08)}, transparent 26%)`,
    "--modal-panel-shadow": `0 30px 70px rgba(0, 0, 0, 0.45), 0 0 0 1px ${rgbaFromHex(accent, 0.07)}, 0 0 28px ${rgbaFromHex(accent, 0.06)}, inset 0 1px 0 rgba(255, 255, 255, ${hasThemeWallpaper ? 0.06 : 0.04})`,
    "--settings-card-border": rgbaFromHex(mixHexColors(highlight, accent, 0.18), hasThemeWallpaper ? 0.34 : 0.28),
    "--settings-card-bg":
      `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(cardTint, tableStripBase, 0.14), hasThemeWallpaper ? 0.2 : 0.12)}, ${rgbaFromHex(mixHexColors(deepTint, accent, 0.08), hasThemeWallpaper ? 0.28 : 0.16)}), linear-gradient(135deg, ${rgbaFromHex(accent, 0.05)}, transparent 58%)`,
    "--settings-card-shadow":
      `inset 0 1px 0 rgba(255, 255, 255, ${hasThemeWallpaper ? 0.08 : 0.05}), 0 16px 32px ${rgbaFromHex(mixHexColors(tint, "#02060f", 0.52), 0.2)}`,
    "--settings-card-title-color": useDarkText
      ? mixHexColors("#6f5311", highlight, 0.26)
      : mixHexColors(goldSoft, strongText, 0.14),
    "--settings-card-title-shadow": useDarkText
      ? `0 0 14px ${rgbaFromHex(highlight, 0.16)}, 0 1px 0 ${rgbaFromHex("#ffffff", 0.12)}`
      : `0 0 18px ${rgbaFromHex(highlight, 0.24)}, 0 0 30px ${rgbaFromHex(goldSoft, 0.12)}`,
    "--field-border": rgbaFromHex(mixHexColors(accent, cyanSoft, 0.14), hasThemeWallpaper ? 0.32 : 0.22),
    "--field-bg":
      `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(cardTint, tableStripBase, 0.1), hasThemeWallpaper ? 0.78 : 0.88)}, ${rgbaFromHex(mixHexColors(deepTint, "#081624", 0.18), hasThemeWallpaper ? 0.9 : 0.96)})`,
    "--field-shadow":
      `inset 0 1px 0 rgba(255, 255, 255, ${hasThemeWallpaper ? 0.08 : 0.04}), 0 8px 18px ${rgbaFromHex(mixHexColors(tint, "#02060f", 0.5), 0.16)}`,
    "--field-text-color": getReadableTextColor(mixHexColors(tint, "#071a33", 0.3), {
      light: "#f3f8ff",
      dark: "#122131",
    }),
    "--field-placeholder-color": mixHexColors(softText, cyanSoft, useDarkText ? 0.12 : 0.08),
    "--field-focus-border": rgbaFromHex(brightAccent, 0.72),
    "--field-focus-ring": rgbaFromHex(accent, 0.09),
    "--field-focus-bg": rgbaFromHex(mixHexColors(tint, accent, 0.14), hasThemeWallpaper ? 0.94 : 0.96),
    "--orb-1-bg": rgbaFromHex(accent, 0.22),
    "--orb-2-bg": rgbaFromHex(accentViolet, 0.2),
    "--bg-orb-opacity": orbOpacity,
    "--orb-1-blur":
      theme?.id === "interstellar" ? "58px" : theme?.id === "cyberroom" ? "34px" : "40px",
    "--orb-2-blur":
      theme?.id === "aurora" ? "54px" : theme?.id === "classic" ? "30px" : "40px",
    "--bg-grid-line": rgbaFromHex(cyanSoft, 0.06),
    "--bg-grid-opacity": gridOpacity,
    "--bg-grid-size":
      theme?.id === "cyberroom" ? "34px" : theme?.id === "classic" ? "56px" : theme?.id === "interstellar" ? "62px" : "44px",
    "--stat-ready-label-color": getReadableTextColor(mixHexColors(cardTint, accent, 0.2), {
      light: mixHexColors(goldSoft, "#ffffff", 0.14),
      dark: mixHexColors("#4f3900", highlight, 0.28),
    }),
    "--stat-ready-label-shadow": useDarkText
      ? `0 1px 0 ${rgbaFromHex("#fff8de", 0.22)}, 0 0 10px ${rgbaFromHex(highlight, 0.14)}`
      : `0 0 16px ${rgbaFromHex(highlight, 0.22)}, 0 1px 0 ${rgbaFromHex("#fff8de", 0.18)}`,
    "--stat-ready-value-color": useDarkText
      ? mixHexColors("#745300", highlight, 0.5)
      : mixHexColors(highlight, "#ffffff", previewMode === "light" ? 0.16 : 0.04),
    "--stat-ready-value-shadow": hasThemeWallpaper
      ? `0 0 14px ${rgbaFromHex(highlight, 0.28)}, 0 0 34px ${rgbaFromHex(highlight, 0.18)}`
      : `0 0 14px ${rgbaFromHex(highlight, 0.2)}, 0 0 34px ${rgbaFromHex(highlight, 0.12)}`,
    "--stat-amount-value-color": useDarkText
      ? mixHexColors("#6a5000", mixHexColors(accent, highlight, 0.56), 0.34)
      : mixHexColors(accent, highlight, 0.56),
    "--stat-amount-value-shadow": hasThemeWallpaper
      ? `0 0 14px ${rgbaFromHex(accent, 0.32)}, 0 0 34px ${rgbaFromHex(highlight, 0.16)}`
      : `0 0 14px ${rgbaFromHex(accent, 0.24)}, 0 0 34px ${rgbaFromHex(highlight, 0.12)}`,
    "--bank-title-name-color": getReadableTextColor(mixHexColors(cardTint, accent, 0.22), {
      light: mixHexColors(goldSoft, "#ffffff", 0.12),
      dark: mixHexColors("#5a4100", highlight, 0.24),
    }),
    "--bank-title-name-shadow": `0 0 18px ${rgbaFromHex(highlight, 0.22)}, 0 1px 0 ${rgbaFromHex("#fff8de", 0.16)}`,
    "--bank-title-name-bg":
      `linear-gradient(180deg, ${rgbaFromHex("#fff8de", useDarkText ? 0.3 : 0.2)}, ${rgbaFromHex("#ffffff", useDarkText ? 0.12 : 0.06)}), linear-gradient(90deg, ${rgbaFromHex(highlight, useDarkText ? 0.14 : 0.12)}, ${rgbaFromHex(goldSoft, useDarkText ? 0.1 : 0.08)})`,
    "--bank-title-name-border": rgbaFromHex(useDarkText ? mixHexColors("#fff8de", highlight, 0.18) : goldSoft, useDarkText ? 0.34 : 0.3),
    "--bank-title-name-box-shadow":
      `inset 0 1px 0 ${rgbaFromHex("#fff8de", useDarkText ? 0.22 : 0.2)}, 0 0 22px ${rgbaFromHex(highlight, useDarkText ? 0.12 : 0.1)}`,
    "--modal-backdrop-bg": rgbaFromHex(mixHexColors(tint, "#03060c", 0.44), 0.76),
    "--modal-header-bg":
      `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(tableStripBase, cardTint, 0.18), hasThemeWallpaper ? 0.34 : 0.88)}, ${rgbaFromHex(mixHexColors(deepTint, tint, 0.08), hasThemeWallpaper ? 0.9 : 0.96)}), radial-gradient(circle at top right, ${rgbaFromHex(highlight, hasThemeWallpaper ? 0.08 : 0.06)}, transparent 28%)`,
    "--modal-header-border": rgbaFromHex(mixHexColors(accent, tableText === "#081018" ? "#ffffff" : "#f7fbff", 0.18), 0.16),
    "--modal-header-shadow": `0 10px 26px ${rgbaFromHex(mixHexColors(tint, "#000000", 0.52), 0.32)}, inset 0 1px 0 ${rgbaFromHex(tableText === "#081018" ? "#ffffff" : "#f7fbff", hasThemeWallpaper ? 0.08 : 0.05)}`,
    "--modal-description-color": mixHexColors(softText, tableText === "#081018" ? "#122131" : "#f7fbff", useDarkText ? 0.18 : 0.08),
    "--select-item-border": rgbaFromHex(mixHexColors(accent, tableStripBase, 0.12), 0.2),
    "--select-item-bg":
      `linear-gradient(180deg, ${rgbaFromHex(tableStripBase, hasThemeWallpaper ? 0.16 : 0.08)}, rgba(255, 255, 255, 0.02)), linear-gradient(135deg, ${rgbaFromHex(mixHexColors(cardTint, accent, 0.06), 0.84)}, ${rgbaFromHex(mixHexColors(deeperTint, tableStripBase, 0.08), 0.9)})`,
    "--select-item-shadow": `inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 14px 28px ${rgbaFromHex(mixHexColors(tint, "#03070d", 0.46), 0.18)}, 0 0 18px ${rgbaFromHex(accent, 0.05)}`,
    "--select-item-hover-border": rgbaFromHex(mixHexColors(accent, highlight, 0.14), 0.38),
    "--select-item-hover-shadow": `inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 18px 34px ${rgbaFromHex(mixHexColors(tint, "#03070d", 0.46), 0.22)}, 0 0 0 1px ${rgbaFromHex(accent, 0.08)}, 0 0 20px ${rgbaFromHex(highlight, 0.08)}`,
    "--select-item-checked-border": rgbaFromHex(mixHexColors(accent, highlight, 0.2), 0.46),
    "--select-item-checked-bg":
      `linear-gradient(180deg, ${rgbaFromHex(tableStripBase, hasThemeWallpaper ? 0.22 : 0.12)}, rgba(255, 255, 255, 0.03)), linear-gradient(135deg, ${rgbaFromHex(mixHexColors(cardTint, accent, 0.18), 0.9)}, ${rgbaFromHex(mixHexColors(deepTint, highlight, 0.12), 0.9)})`,
    "--select-item-checked-shadow": `inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 20px 36px ${rgbaFromHex(mixHexColors(tint, "#03070d", 0.46), 0.22)}, 0 0 0 1px ${rgbaFromHex(accent, 0.08)}, 0 0 26px ${rgbaFromHex(highlight, 0.12)}`,
    "--select-title-color": mixHexColors(strongText, useDarkText ? "#1d2a37" : "#f7fbff", useDarkText ? 0.18 : 0.08),
    "--select-title-active-color": useDarkText
      ? mixHexColors("#6f5311", highlight, 0.26)
      : mixHexColors(goldSoft, strongText, 0.14),
    "--select-title-active-shadow": useDarkText
      ? `0 0 14px ${rgbaFromHex(highlight, 0.16)}, 0 1px 0 ${rgbaFromHex("#ffffff", 0.12)}`
      : `0 0 18px ${rgbaFromHex(highlight, 0.22)}, 0 0 10px rgba(255, 255, 255, 0.04)`,
    "--select-subitem-bg":
      `linear-gradient(180deg, ${rgbaFromHex(tableStripBase, hasThemeWallpaper ? 0.12 : 0.06)}, rgba(255, 255, 255, 0.02)), ${rgbaFromHex(cyanSoft, 0.02)}`,
    "--select-subitem-border": rgbaFromHex(mixHexColors(cyanSoft, tableStripBase, 0.12), 0.1),
    "--select-subitem-color": mixHexColors(strongText, softText, 0.22),
    "--select-subitem-hover-border": rgbaFromHex(mixHexColors(highlight, tableStripBase, 0.12), 0.26),
    "--select-subitem-hover-bg":
      `linear-gradient(180deg, ${rgbaFromHex(tableStripBase, hasThemeWallpaper ? 0.18 : 0.1)}, rgba(255, 255, 255, 0.02)), ${rgbaFromHex(highlight, 0.025)}`,
    "--select-subitem-checked-border": rgbaFromHex(mixHexColors(highlight, tableStripBase, 0.14), 0.44),
    "--select-subitem-checked-bg":
      `linear-gradient(180deg, ${rgbaFromHex(tableStripBase, hasThemeWallpaper ? 0.2 : 0.12)}, rgba(255, 255, 255, 0.025)), ${rgbaFromHex(highlight, 0.03)}`,
    "--select-subitem-checked-shadow": `0 0 0 1px ${rgbaFromHex(highlight, 0.08)}, 0 8px 18px rgba(0, 0, 0, 0.14), inset 0 1px 0 ${rgbaFromHex("#ffffff", 0.06)}`,
    "--modal-footer-bg": `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(deepTint, tableStripBase, 0.06), 0.92)}, ${rgbaFromHex(deepTint, 0.98)})`,
    "--modal-footer-border": rgbaFromHex(mixHexColors(cyanSoft, tableStripBase, 0.12), 0.12),
    "--modal-action-bar-border": rgbaFromHex(mixHexColors(accent, tableStripBase, 0.12), 0.18),
    "--modal-action-bar-bg":
      `linear-gradient(180deg, ${rgbaFromHex(mixHexColors(cardTint, tableStripBase, 0.08), 0.992)}, ${rgbaFromHex(deepTint, 0.96)}), radial-gradient(circle at top right, ${rgbaFromHex(accent, 0.04)}, transparent 26%)`,
    "--modal-action-bar-shadow": `inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 14px 28px ${rgbaFromHex(mixHexColors(tint, "#03070d", 0.46), 0.18)}, 0 0 18px ${rgbaFromHex(accent, 0.04)}`,
    "--form-label-color": mixHexColors(strongText, tableText === "#081018" ? "#122131" : "#f7fbff", useDarkText ? 0.3 : 0.14),
    "--settings-preview-bg":
      `linear-gradient(180deg, ${rgbaFromHex(tableStripBase, hasThemeWallpaper ? 0.14 : 0.08)}, ${rgbaFromHex(mixHexColors(cardTint, accent, 0.08), hasThemeWallpaper ? 0.12 : 0.08)})`,
    "--settings-preview-border": rgbaFromHex(mixHexColors(accent, tableStripBase, 0.14), 0.14),
    "--settings-preview-text": mixHexColors(strongText, tableText === "#081018" ? "#122131" : "#f7fbff", useDarkText ? 0.24 : 0.12),
    "--slideshow-field-border": rgbaFromHex(accent, 0.2),
    "--slideshow-field-bg":
      `linear-gradient(180deg, ${rgbaFromHex(cardTint, 0.82)}, ${rgbaFromHex(deepTint, 0.88)}), linear-gradient(120deg, rgba(255, 255, 255, 0.025), transparent)`,
    "--slideshow-field-before":
      `radial-gradient(circle at top right, ${rgbaFromHex(highlight, 0.08)}, transparent 28%), linear-gradient(120deg, transparent 18%, rgba(255, 255, 255, 0.05) 50%, transparent 82%)`,
    "--desktop-overlay-bg": hasThemeWallpaper
      ? overlayVeil
      : buildThemeGalleryVisuals(theme, previewMode).dashboardBackground || DEFAULT_THEMEABLE_CSS_VARS["--desktop-overlay-bg"],
  };
}

function applyDashboardThemeCssVars(theme, previewMode = "all") {
  const rootStyle = document.documentElement.style;
  const vars = buildDashboardThemeVars(theme, previewMode);
  Object.entries(vars).forEach(([key, value]) => rootStyle.setProperty(key, value));
  document.documentElement.dataset.dashboardTheme = theme?.id || "";
}

function applyThemeGalleryLivePreview(theme) {
  if (!theme) {
    return;
  }

  const previewMode = getThemeGalleryResolvedPreviewMode(theme);
  const visuals = buildThemeGalleryVisuals(theme, previewMode);
  const layout = getBackgroundLayoutByFit(normalizeDesktopFitMode(state.uiSettings.desktopImageFit));
  applyDashboardThemeCssVars(
    {
      ...theme,
      dashboardBackground: visuals.dashboardBackground,
      overlayOpacity: visuals.overlayOpacity,
    },
    previewMode
  );
  document.documentElement.style.setProperty("--desktop-image", visuals.dashboardBackground || "none");
  document.documentElement.style.setProperty("--desktop-image-size", layout.size);
  document.documentElement.style.setProperty("--desktop-image-repeat", layout.repeat);
  document.documentElement.style.setProperty("--desktop-image-position", layout.position);
  document.documentElement.style.setProperty("--desktop-overlay-opacity", visuals.overlayOpacity || "0.12");
  document.documentElement.dataset.desktopImageActive = visuals.dashboardBackground ? "true" : "false";

  getDesktopBackgroundLayers().forEach((layer) => {
    applyBackgroundImageToLayer(layer, visuals.dashboardBackground || "none", layout);
    layer.classList.add("is-visible");
    layer.classList.remove("is-entering", "is-exiting");
  });
  applyThemeGalleryWallpaperFx(theme);

  if (elements.desktopBackgroundOverlay) {
    elements.desktopBackgroundOverlay.style.opacity = visuals.overlayOpacity || "0.12";
  }

  renderRuntime.themeGalleryLivePreviewActive = true;
  ensureThemeWallpaperMotionLoop();
}

function restoreThemeGalleryLivePreview() {
  if (!renderRuntime.themeGalleryLivePreviewActive) {
    return;
  }
  renderRuntime.themeGalleryLivePreviewActive = false;
  applyDesktopBackground();
  ensureThemeWallpaperMotionLoop();
}

function buildThemeGalleryChromeVars(theme, previewMode) {
  const tone = getThemeGalleryResolvedTone(theme);
  const seed = getThemeGallerySeedByPreviewMode(
    getThemeGalleryUiSeed(theme) || THEME_GALLERY_UI_SEEDS.classic,
    previewMode,
    tone
  ) || THEME_GALLERY_UI_SEEDS.classic;
  const darkMode = previewMode === "dark";
  const accent = seed.accent;
  const accentHover = mixHexColors(seed.accent, "#ffffff", 0.1);
  const accentPressed = mixHexColors(seed.accent, seed.tint, 0.18);
  const lightSurface = mixHexColors("#ffffff", seed.accent, 0.06);
  const lightSurfaceStrong = mixHexColors("#ffffff", seed.highlight, 0.08);
  const darkSurface = mixHexColors("#11162a", seed.tint, 0.58);
  const darkSurfaceStrong = mixHexColors("#1d2238", seed.tint, 0.52);
  const surface = darkMode ? darkSurface : lightSurface;
  const surfaceStrong = darkMode ? darkSurfaceStrong : lightSurfaceStrong;
  const surfaceSoft = darkMode ? mixHexColors(surface, "#ffffff", 0.06) : mixHexColors(surface, "#ffffff", 0.48);
  const tabSurface = darkMode ? mixHexColors(surface, "#2a3150", 0.44) : mixHexColors(surface, "#ffffff", 0.56);
  const text = darkMode ? "#eef3ff" : "#212733";
  const textSoft = darkMode ? mixHexColors("#dbe6ff", accent, 0.12) : mixHexColors("#657086", accent, 0.18);

  return {
    "--opera-gallery-surface": surface,
    "--opera-gallery-surface-soft": surfaceSoft,
    "--opera-gallery-surface-strong": surfaceStrong,
    "--opera-gallery-surface-tab": tabSurface,
    "--opera-gallery-border": darkMode ? rgbaFromHex(accent, 0.24) : "rgba(204, 211, 227, 0.96)",
    "--opera-gallery-border-strong": darkMode ? rgbaFromHex(accent, 0.34) : "rgba(173, 183, 206, 0.96)",
    "--opera-gallery-text": text,
    "--opera-gallery-text-soft": textSoft,
    "--opera-gallery-accent": accent,
    "--opera-gallery-accent-hover": accentHover,
    "--opera-gallery-accent-pressed": accentPressed,
    "--opera-gallery-accent-foreground": "#ffffff",
    "--opera-gallery-shadow": darkMode
      ? `0 28px 70px rgba(0, 0, 0, 0.42), 0 0 0 1px ${rgbaFromHex(accent, 0.14)}`
      : `0 28px 70px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.42)`,
  };
}

function applyThemeGalleryChrome(theme) {
  if (!elements.themeGalleryModal) {
    return;
  }

  const previewMode = getThemeGalleryResolvedPreviewMode(theme);
  const vars = buildThemeGalleryChromeVars(theme, previewMode);
  Object.entries(vars).forEach(([key, value]) => elements.themeGalleryModal.style.setProperty(key, value));
  elements.themeGalleryModal.dataset.previewMode = previewMode;
  elements.themeGalleryDetail?.setAttribute("data-preview-mode", previewMode);
  elements.themeGalleryDetail?.setAttribute("data-theme-category", getThemeGalleryModeCategory(theme));
}

function syncThemeGallerySoundButtons() {
  document.querySelectorAll("[data-theme-sound-toggle]").forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const soundKey = button.getAttribute("data-theme-sound-toggle") || "";
    const enabled = Boolean(renderRuntime.themeGallerySoundStates[soundKey]);
    button.classList.toggle("on", enabled);
    button.setAttribute("aria-pressed", String(enabled));
  });
}

function getThemeGallerySelectionId() {
  const themes = getThemeGalleryThemes();
  if (themes.length === 0) {
    return "";
  }

  const currentThemeId = String(state.uiSettings.themeGalleryThemeId || "").trim();
  const runtimeThemeId = String(renderRuntime.themeGallerySelectionId || "").trim();
  if (runtimeThemeId && themes.some((theme) => theme.id === runtimeThemeId)) {
    return runtimeThemeId;
  }
  if (currentThemeId && themes.some((theme) => theme.id === currentThemeId)) {
    return currentThemeId;
  }
  return String(themes[0].id || "default-dashboard");
}

function updateThemeGallerySettingsSummary() {
  if (!elements.themeGalleryCurrentTheme) {
    return;
  }

  const theme = getThemeGalleryThemeById(state.uiSettings.themeGalleryThemeId);
  const activeTheme = theme || getThemeGalleryThemeById("default-dashboard");
  const activeMode = normalizeThemeGalleryPreviewMode(state.uiSettings.themeGalleryPreviewMode, "all");
  const modeLabel = activeMode === "all" ? "All Modes" : `${activeMode.charAt(0).toUpperCase()}${activeMode.slice(1)} Mode`;
  const toneLabel = getThemeGalleryToneLabel(getSavedThemeGalleryTone());
  const animatedLabel = getSavedThemeGalleryAnimatedWallpaperEnabled() ? "Animated" : "Static";
  const finishLabel = getSavedThemeGalleryBackgroundFinish() === "glossy" ? "Glossy" : "Doff";
  const backgroundSourceLabel = getDesktopBackgroundSourceLabel();
  elements.themeGalleryCurrentTheme.textContent = activeTheme
    ? `Theme aktif: ${activeTheme.title} | ${modeLabel} | ${toneLabel} | ${animatedLabel} | ${finishLabel} | BG: ${backgroundSourceLabel}`
    : `Theme aktif: Default Dashboard | ${modeLabel} | ${toneLabel} | ${animatedLabel} | ${finishLabel} | BG: ${backgroundSourceLabel}`;
}

function setThemeGalleryApplyButtonState(isApplying = false) {
  if (!elements.applyThemeGallery) {
    return;
  }

  elements.applyThemeGallery.disabled = isApplying;
  elements.applyThemeGallery.textContent = isApplying ? "Applying..." : "Set Theme";
  elements.applyThemeGallery.dataset.loading = isApplying ? "true" : "false";
}

function closeThemeGalleryDetail() {
  elements.themeGalleryDetail?.classList.add("hidden");
}

function openThemeGalleryDetail() {
  elements.themeGalleryDetail?.classList.remove("hidden");
}

function closeThemeGalleryModalAndRestore() {
  resetThemeGallerySelection();
  closeThemeGalleryDetail();
  restoreThemeGalleryLivePreview();
  if (elements.themeGalleryModal) {
    closeModal(elements.themeGalleryModal);
  }
}

function updateThemeGalleryPreview() {
  const theme = getThemeGalleryThemeById(getThemeGallerySelectionId());
  if (!theme) {
    return;
  }
  const previewMode = getThemeGalleryResolvedPreviewMode(theme);
  const visuals = buildThemeGalleryVisuals(theme, previewMode);

  if (elements.themeGalleryPreviewImage) {
    elements.themeGalleryPreviewImage.style.background = visuals.previewBackground;
  }
  if (elements.themeGalleryColorSurface) {
    elements.themeGalleryColorSurface.style.background = visuals.previewBackground;
  }
  if (elements.themeGalleryDetailBackdrop) {
    elements.themeGalleryDetailBackdrop.style.background = visuals.detailBackdrop;
  }
  applyThemeGalleryWallpaperFx(theme);
  applyThemeGalleryChrome(theme);
  if (!elements.themeGalleryModal?.classList.contains("hidden")) {
    applyThemeGalleryLivePreview({
      ...theme,
      dashboardBackground: visuals.dashboardBackground,
      overlayOpacity: visuals.overlayOpacity,
    });
  }
  if (elements.themeGalleryPreviewTitle) {
    elements.themeGalleryPreviewTitle.textContent = theme.title;
  }
  if (elements.themeGalleryPreviewKicker) {
    elements.themeGalleryPreviewKicker.textContent = theme.id.includes("default") ? "Opera Style Base" : "Wallpaper Theme";
  }
  if (elements.themeGalleryPreviewCaptionTitle) {
    elements.themeGalleryPreviewCaptionTitle.textContent = theme.title;
  }
  if (elements.themeGalleryPreviewCaptionMode) {
    elements.themeGalleryPreviewCaptionMode.textContent = previewMode === "all" ? "all modes" : `${previewMode} mode`;
  }
  if (elements.themeGalleryPreviewMode) {
    elements.themeGalleryPreviewMode.textContent = previewMode === "all" ? "all modes" : `${previewMode} mode`;
  }
  elements.themeGalleryModeLight?.classList.toggle("active", previewMode === "light");
  elements.themeGalleryModeDark?.classList.toggle("active", previewMode === "dark");
  elements.themeGalleryPreviewMode?.classList.toggle("active", previewMode === "all");
  if (elements.themeGalleryPreviewDescription) {
    const toneLabel = getThemeGalleryToneLabel(getThemeGalleryResolvedTone(theme));
    const animatedLabel = getThemeGalleryResolvedAnimatedWallpaperEnabled(theme) ? "Animated" : "Static";
    const finishLabel = getThemeGalleryResolvedBackgroundFinish(theme) === "glossy" ? "Glossy" : "Doff";
    elements.themeGalleryPreviewDescription.textContent = theme.id === "default-dashboard"
      ? `${theme.description} Pilihan ini akan mengembalikan warna, garis tepi, dan transparansi dashboard ke gaya asli.`
      : `${theme.description} Theme ini akan dipakai sebagai background dashboard, seluruh warna panel menyesuaikan otomatis, tone aktif: ${toneLabel}, wallpaper: ${animatedLabel}, finish: ${finishLabel}.`;
  }
  updateThemeGalleryToneUi(theme);
  updateThemeGalleryWallpaperUi(theme);
  syncThemeGallerySoundButtons();
}

function renderThemeGallery() {
  if (!elements.themeGalleryGrid) {
    return;
  }

  const themes = getThemeGalleryThemes();
  if (themes.length === 0) {
    elements.themeGalleryGrid.innerHTML =
      '<div class="empty-column">Belum ada tema mandiri yang tersedia untuk gallery.</div>';
    return;
  }

  const selectedThemeId = getThemeGallerySelectionId();
  renderRuntime.themeGallerySelectionId = selectedThemeId;
  elements.themeGalleryGrid.innerHTML = themes
    .map((theme) => {
      const activeClass = theme.id === selectedThemeId ? "active" : "";
      const modeCategory = getThemeGalleryModeCategory(theme);
      const modeBadgeLabel = getThemeGalleryModeBadgeLabel(theme);
      return `
        <button
          class="theme-gallery-card theme-gallery-card-${escapeHtml(modeCategory)} ${activeClass}"
          data-theme-gallery-id="${escapeHtml(theme.id)}"
          data-theme-gallery-mode="${escapeHtml(modeCategory)}"
          type="button"
        >
          <span class="theme-gallery-card-mode-badge">${escapeHtml(modeBadgeLabel)}</span>
          <span
            class="theme-gallery-card-image"
            aria-hidden="true"
            style="background:${escapeHtml(theme.cardBackground)};"
          ></span>
          <span class="theme-gallery-card-meta">
            <strong>${escapeHtml(theme.title)}</strong>
            <small>${escapeHtml(theme.mode)}</small>
          </span>
        </button>
      `;
    })
    .join("");

  updateThemeGalleryPreview();
}

function openThemeGalleryModal() {
  const selectedTheme = getThemeGalleryThemeById(getThemeGallerySelectionId());
  renderRuntime.themeGallerySelectionId = getThemeGallerySelectionId();
  renderRuntime.themeGalleryPreviewMode = getPreferredThemeGalleryPreviewMode(selectedTheme);
  renderRuntime.themeGalleryMotionPreset = getPreferredThemeGalleryMotionPreset(selectedTheme);
  const tone = getPreferredThemeGalleryTone(selectedTheme);
  renderRuntime.themeGalleryToneX = tone.x;
  renderRuntime.themeGalleryToneY = tone.y;
  renderRuntime.themeGalleryAnimatedWallpaperEnabled = getPreferredThemeGalleryAnimatedWallpaperEnabled(selectedTheme);
  renderRuntime.themeGalleryBackgroundFinish = getPreferredThemeGalleryBackgroundFinish(selectedTheme);
  renderRuntime.themeGallerySoundStates = {
    browser: true,
    keyboard: true,
    music: true,
  };
  renderThemeGallery();
  closeThemeGalleryDetail();
  if (elements.themeGalleryModal) {
    openModal(elements.themeGalleryModal);
  }
  if (selectedTheme) {
    applyThemeGalleryLivePreview(selectedTheme);
  }
}

function resetThemeGallerySelection() {
  const currentTheme = getThemeGalleryThemeById(state.uiSettings.themeGalleryThemeId) || getThemeGalleryThemeById("default-dashboard");
  renderRuntime.themeGallerySelectionId = String(state.uiSettings.themeGalleryThemeId || "default-dashboard").trim();
  renderRuntime.themeGalleryPreviewMode = currentTheme?.id === state.uiSettings.themeGalleryThemeId
    ? getSavedThemeGalleryPreviewMode(currentTheme.id)
    : getThemeGalleryDefaultPreviewMode(currentTheme);
  renderRuntime.themeGalleryMotionPreset = currentTheme?.id === state.uiSettings.themeGalleryThemeId
    ? getSavedThemeGalleryMotionPreset(currentTheme.id)
    : "calm";
  const tone = currentTheme?.id === state.uiSettings.themeGalleryThemeId
    ? getSavedThemeGalleryTone(currentTheme.id)
    : { x: 50, y: 50 };
  renderRuntime.themeGalleryToneX = tone.x;
  renderRuntime.themeGalleryToneY = tone.y;
  renderRuntime.themeGalleryAnimatedWallpaperEnabled = currentTheme?.id === state.uiSettings.themeGalleryThemeId
    ? getSavedThemeGalleryAnimatedWallpaperEnabled(currentTheme.id)
    : true;
  renderRuntime.themeGalleryBackgroundFinish = currentTheme?.id === state.uiSettings.themeGalleryThemeId
    ? getSavedThemeGalleryBackgroundFinish(currentTheme.id)
    : "glossy";
  renderRuntime.themeGallerySoundStates = {
    browser: true,
    keyboard: true,
    music: true,
  };
  renderThemeGallery();
  if (currentTheme) {
    openThemeGalleryDetail();
  } else {
    closeThemeGalleryDetail();
  }
  if (currentTheme && !elements.themeGalleryModal?.classList.contains("hidden")) {
    applyThemeGalleryLivePreview(currentTheme);
  }
}

async function applyThemeGallerySelection() {
  const themeId = getThemeGallerySelectionId();
  const theme = getThemeGalleryThemeById(themeId);
  if (!theme) {
    return;
  }

  setThemeGalleryApplyButtonState(true);
  try {
    const previousBackgroundSource = getResolvedDesktopBackgroundSource();
    state.uiSettings.themeGalleryThemeId = theme.id;
    state.uiSettings.themeGalleryPreviewMode = getThemeGalleryResolvedPreviewMode(theme);
    state.uiSettings.themeGalleryMotionPreset = getThemeGalleryResolvedMotionPreset(theme);
    state.uiSettings.themeGalleryToneX = normalizeThemeGalleryToneValue(renderRuntime.themeGalleryToneX, 50);
    state.uiSettings.themeGalleryToneY = normalizeThemeGalleryToneValue(renderRuntime.themeGalleryToneY, 50);
    state.uiSettings.themeGalleryAnimatedWallpaperEnabled = normalizeThemeGalleryAnimatedWallpaperEnabled(
      renderRuntime.themeGalleryAnimatedWallpaperEnabled,
      true
    );
    state.uiSettings.themeGalleryBackgroundFinish = normalizeThemeGalleryBackgroundFinish(
      renderRuntime.themeGalleryBackgroundFinish,
      "glossy"
    );
    renderRuntime.themeGallerySelectionId = theme.id;
    renderRuntime.themeGalleryPreviewMode = state.uiSettings.themeGalleryPreviewMode;
    renderRuntime.themeGalleryMotionPreset = state.uiSettings.themeGalleryMotionPreset;
    renderRuntime.themeGalleryToneX = state.uiSettings.themeGalleryToneX;
    renderRuntime.themeGalleryToneY = state.uiSettings.themeGalleryToneY;
    renderRuntime.themeGalleryAnimatedWallpaperEnabled = state.uiSettings.themeGalleryAnimatedWallpaperEnabled;
    renderRuntime.themeGalleryBackgroundFinish = state.uiSettings.themeGalleryBackgroundFinish;
    if (previousBackgroundSource === "theme" || !hasDesktopCustomBackground() && !hasDesktopPresetBackground()) {
      state.uiSettings.desktopBackgroundSource = "theme";
    }
    applyDesktopBackground();
    persistState();
    syncUiSettingsToForm();
    updateThemeGallerySettingsSummary();
    await flushFirebaseSync();
    closeThemeGalleryDetail();
    renderRuntime.themeGalleryLivePreviewActive = false;
    if (elements.themeGalleryModal) {
      closeModal(elements.themeGalleryModal);
    }
  } finally {
    setThemeGalleryApplyButtonState(false);
  }
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

function applyBackgroundImageToLayer(layer, backgroundValue, layout) {
  if (!(layer instanceof HTMLDivElement)) {
    return;
  }

  layer.style.background = backgroundValue || "none";
  layer.style.backgroundSize = layout.size;
  layer.style.backgroundRepeat = layout.repeat;
  layer.style.backgroundPosition = layout.position;
  layer.style.backgroundAttachment = "scroll";
  layer.dataset.activeImageSrc = backgroundValue || "";
  layer.dataset.baseBackgroundPosition = layout.position;
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

function syncBackgroundLayersImmediately(backgroundValue, layout) {
  const layers = getDesktopBackgroundLayers();
  if (layers.length === 0) {
    return;
  }

  clearBackgroundSlideshowTransition();
  const visibleLayer = getActiveBackgroundLayer() || layers[0];
  layers.forEach((layer) => {
    applyBackgroundImageToLayer(layer, backgroundValue, layout);
    layer.classList.toggle("is-visible", layer === visibleLayer && Boolean(backgroundValue));
  });
  renderRuntime.backgroundActiveLayerId = visibleLayer.dataset.layerId || "primary";
}

function playBackgroundSlideshowTransition(transitionName, backgroundValue, layout) {
  const activeLayer = getActiveBackgroundLayer();
  const inactiveLayer = getInactiveBackgroundLayer();
  if (!activeLayer || !inactiveLayer) {
    syncBackgroundLayersImmediately(backgroundValue, layout);
    return;
  }

  const normalizedTransition = normalizeSlideshowTransitionName(transitionName);
  clearBackgroundSlideshowTransition();
  applyBackgroundImageToLayer(inactiveLayer, backgroundValue, layout);
  inactiveLayer.classList.add("is-visible");
  void inactiveLayer.offsetWidth;
  activeLayer.classList.add("is-exiting", `slideshow-transition-${normalizedTransition}`);
  inactiveLayer.classList.add("is-entering", `slideshow-transition-${normalizedTransition}`);
  renderRuntime.backgroundActiveLayerId = inactiveLayer.dataset.layerId || "primary";

  backgroundSlideshowTransitionTimerId = window.setTimeout(() => {
    applyBackgroundImageToLayer(activeLayer, backgroundValue, layout);
    activeLayer.classList.remove("is-visible");
    inactiveLayer.classList.add("is-visible");
    clearBackgroundSlideshowTransition();
  }, BACKGROUND_SLIDESHOW_TRANSITION_DURATION_MS);
}

function renderDesktopBackgroundImage({
  backgroundValue,
  preloadSrc,
  layout,
  shouldAnimateSlideshowTransition,
  transitionName,
}) {
  const requestId = ++renderRuntime.backgroundRenderRequestId;

  if (!backgroundValue) {
    syncBackgroundLayersImmediately("", layout);
    return;
  }

  Promise.resolve(preloadSrc ? preloadBackgroundImage(preloadSrc) : undefined)
    .then(() => {
      if (requestId !== renderRuntime.backgroundRenderRequestId) {
        return;
      }

      if (shouldAnimateSlideshowTransition) {
        playBackgroundSlideshowTransition(transitionName, backgroundValue, layout);
        return;
      }

      syncBackgroundLayersImmediately(backgroundValue, layout);
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
  return Boolean(state.uiSettings.desktopSlideshowEnabled) && getResolvedDesktopBackgroundSource() !== "theme";
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
      backgroundValue: `url("${slideshowImage.src}")`,
      title: `Slideshow ${slideshowImage.slideIndex}/${slideshowImage.slideCount}`,
      description: `${slideshowImage.title} aktif otomatis tiap 10-15 detik dengan efek transisi acak.`,
      isPreset: slideshowImage.isPreset,
    };
  }

  const backgroundSource = getResolvedDesktopBackgroundSource();
  const theme = getThemeGalleryThemeById(state.uiSettings.themeGalleryThemeId);
  if (backgroundSource === "theme" && theme) {
    const previewMode = getSavedThemeGalleryPreviewMode(theme.id);
    const toneLabel = getThemeGalleryToneLabel(getSavedThemeGalleryTone(theme.id));
    const visuals = buildThemeGalleryVisuals(theme, previewMode);
    return {
      src: theme.imagePath || "",
      backgroundValue: visuals.dashboardBackground,
      previewBackground: visuals.previewBackground,
      title: theme.title,
      description: `${theme.description} Mode aktif: ${previewMode}. Tone aktif: ${toneLabel}. Sumber gambar: Theme Gallery.`,
      overlayOpacity: visuals.overlayOpacity || "0.08",
      isThemeGallery: true,
    };
  }

  if (backgroundSource === "preset") {
    const preset = getBackgroundPresetById(state.uiSettings.desktopImagePresetId);
    if (preset?.image) {
      return {
        src: preset.image,
        backgroundValue: `url("${preset.image}")`,
        title: formatBackgroundPresetTitle(preset),
        description: `${formatBackgroundPresetDescription(preset)} Sumber gambar: Built-in.`,
        isPreset: true,
      };
    }
  }

  if (backgroundSource === "custom" && state.uiSettings.desktopImageRemoteUrl) {
    return {
      src: state.uiSettings.desktopImageRemoteUrl,
      backgroundValue: `url("${state.uiSettings.desktopImageRemoteUrl}")`,
      title: "Desktop Image Ready",
      description: "Custom background aktif dari sinkronisasi cloud lama. Sumber gambar: Upload / Paste.",
      isPreset: false,
    };
  }

  if (backgroundSource === "custom" && state.uiSettings.desktopImageData) {
    return {
      src: state.uiSettings.desktopImageData,
      backgroundValue: `url("${state.uiSettings.desktopImageData}")`,
      title: "Desktop Image Ready",
      description: "Custom background aktif dari upload atau paste, tersimpan langsung ke Firestore. Sumber gambar: Upload / Paste.",
      isPreset: false,
    };
  }

  if (theme) {
    const previewMode = getSavedThemeGalleryPreviewMode(theme.id);
    const toneLabel = getThemeGalleryToneLabel(getSavedThemeGalleryTone(theme.id));
    const visuals = buildThemeGalleryVisuals(theme, previewMode);
    return {
      src: theme.imagePath || "",
      backgroundValue: visuals.dashboardBackground,
      previewBackground: visuals.previewBackground,
      title: theme.title,
      description: `${theme.description} Mode aktif: ${previewMode}. Tone aktif: ${toneLabel}. Sumber gambar fallback: Theme Gallery.`,
      overlayOpacity: visuals.overlayOpacity || "0.08",
      isThemeGallery: true,
    };
  }

  const preset = getBackgroundPresetById(state.uiSettings.desktopImagePresetId);
  if (preset?.image) {
    return {
      src: preset.image,
      backgroundValue: `url("${preset.image}")`,
      title: formatBackgroundPresetTitle(preset),
      description: `${formatBackgroundPresetDescription(preset)} Sumber gambar fallback: Built-in.`,
      isPreset: true,
    };
  }

  if (state.uiSettings.desktopImageRemoteUrl) {
    return {
      src: state.uiSettings.desktopImageRemoteUrl,
      backgroundValue: `url("${state.uiSettings.desktopImageRemoteUrl}")`,
      title: "Desktop Image Ready",
      description: "Custom background aktif dari sinkronisasi cloud lama. Sumber gambar fallback: Upload / Paste.",
      isPreset: false,
    };
  }

  if (state.uiSettings.desktopImageData) {
    return {
      src: state.uiSettings.desktopImageData,
      backgroundValue: `url("${state.uiSettings.desktopImageData}")`,
      title: "Desktop Image Ready",
      description: "Custom background aktif dari upload atau paste, tersimpan langsung ke Firestore. Sumber gambar fallback: Upload / Paste.",
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
    : getResolvedDesktopBackgroundSource() === "preset"
      ? state.uiSettings.desktopImagePresetId || ""
      : "";
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
    renderRuntime.backgroundSlideshowHydrated = false;
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
    renderRuntime.backgroundSlideshowHydrated = false;
    updateBackgroundSlideshowButton();
    return;
  }

  syncBackgroundSlideshowState(sources);
  if (sources.length <= 1) {
    renderRuntime.backgroundSlideshowHydrated = true;
    updateBackgroundSlideshowButton();
    return;
  }

  const startedAt = Number(state.uiSettings.desktopSlideshowStartedAt || Date.now());
  const intervalMs = normalizeSlideshowIntervalMs(state.uiSettings.desktopSlideshowIntervalMs);
  const elapsed = Math.max(0, Date.now() - startedAt);
  const isInitialHydration = !renderRuntime.backgroundSlideshowHydrated;
  renderRuntime.backgroundSlideshowHydrated = true;

  // Keep the current slide after reload/F5, then restart the timer from "now".
  if (isInitialHydration && elapsed >= intervalMs) {
    state.uiSettings.desktopSlideshowStartedAt = Date.now();
    persistState();
  }

  const effectiveElapsed = isInitialHydration && elapsed >= intervalMs ? 0 : elapsed;
  const nextDelay = Math.max(80, intervalMs - effectiveElapsed);

  if (!isInitialHydration && elapsed >= intervalMs) {
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
  applyDashboardThemeCssVars(
    getThemeGalleryThemeById(state.uiSettings.themeGalleryThemeId),
    getSavedThemeGalleryPreviewMode()
  );

  const activeImage = getActiveDesktopImage();
  const backgroundValue = activeImage?.backgroundValue || "";
  const preloadSrc = activeImage?.src || "";
  const fit = normalizeDesktopFitMode(state.uiSettings.desktopImageFit);
  const layout = getBackgroundLayoutByFit(fit);
  const previousImageData = getActiveBackgroundLayer()?.dataset.activeImageSrc || "";
  const overlayOpacity = activeImage?.overlayOpacity || (backgroundValue ? "0.08" : "1");

  document.documentElement.style.setProperty("--desktop-image", backgroundValue || "none");
  document.documentElement.style.setProperty("--desktop-image-size", layout.size);
  document.documentElement.style.setProperty("--desktop-image-repeat", layout.repeat);
  document.documentElement.style.setProperty("--desktop-image-position", layout.position);
  document.documentElement.style.setProperty("--desktop-overlay-opacity", overlayOpacity);
  document.documentElement.dataset.desktopImageActive = backgroundValue ? "true" : "false";

  const shouldAnimateSlideshowTransition = Boolean(
    backgroundValue &&
      previousImageData &&
      backgroundValue !== previousImageData &&
      isDesktopSlideshowEnabled() &&
      getDesktopBackgroundLayers().length > 1
  );

  renderDesktopBackgroundImage({
    backgroundValue,
    preloadSrc,
    layout,
    shouldAnimateSlideshowTransition,
    transitionName: state.uiSettings.desktopSlideshowTransitionName,
  });

  if (elements.desktopBackgroundOverlay) {
    elements.desktopBackgroundOverlay.style.opacity = overlayOpacity;
  }
  applyThemeGalleryWallpaperFx(getThemeGalleryThemeById(state.uiSettings.themeGalleryThemeId));
  ensureThemeWallpaperMotionLoop();

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
            ${activeImage.previewBackground ? `background:${activeImage.previewBackground};` : `background-image:url('${activeImage.src}');`}
            background-size:${getPreviewImageFit(fit)};
            background-repeat:${layout.repeat};
            background-position:${layout.position};
          "
        ></div>
        <div class="background-preview-meta">
          <strong>${escapeHtml(activeImage.title)}</strong>
          <span>Source: ${escapeHtml(getDesktopBackgroundSourceLabel())}</span>
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
  updateThemeGallerySettingsSummary();
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
  state.uiSettings.desktopBackgroundSource = "custom";
  state.uiSettings.desktopImageData = compressedImageData;
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
  syncUiSettingsToForm();
  persistState();
}

function applyDesktopImagePreset(presetId) {
  const preset = getBackgroundPresetById(presetId);
  if (!preset) {
    return;
  }

  state.uiSettings.desktopBackgroundSource = "preset";
  state.uiSettings.desktopImagePresetId = preset.id;
  if (isDesktopSlideshowEnabled()) {
    state.uiSettings.desktopSlideshowSlideIndex = 0;
    state.uiSettings.desktopSlideshowStartedAt = Date.now();
    state.uiSettings.desktopSlideshowIntervalMs = getRandomSlideshowIntervalMs();
    state.uiSettings.desktopSlideshowTransitionName = pickRandomSlideshowTransition(
      state.uiSettings.desktopSlideshowTransitionName
    );
  }
  applyDesktopBackground();
  syncUiSettingsToForm();
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
  state.uiSettings.desktopBackgroundSource = state.uiSettings.themeGalleryThemeId ? "theme" : "preset";
  state.uiSettings.desktopSlideshowEnabled = false;
  state.uiSettings.desktopSlideshowStartedAt = 0;
  state.uiSettings.desktopSlideshowSlideIndex = 0;
  state.uiSettings.desktopSlideshowIntervalMs = BACKGROUND_SLIDESHOW_INTERVAL_MIN_MS;
  state.uiSettings.desktopSlideshowTransitionName = BACKGROUND_SLIDESHOW_TRANSITIONS[0];
  applyDesktopBackground();
  syncUiSettingsToForm();
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
      return false;
    }

    const persisted = JSON.parse(raw);
    applySerializedStatePayload(persisted);
    return true;
  } catch (error) {
    console.warn("Gagal memuat state tersimpan.", error);
    return false;
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

function normalizePersistRevision(value, fallback = 0) {
  return Math.max(0, Number(value || fallback || 0));
}

function shouldIgnoreIncomingPersistedPayload(payload) {
  const currentPersistRevision = normalizePersistRevision(state.persistRevision);
  const incomingPersistRevision = normalizePersistRevision(payload?.persistRevision);

  if (currentPersistRevision > 0 && incomingPersistRevision === 0) {
    return true;
  }

  return incomingPersistRevision > 0 && incomingPersistRevision < currentPersistRevision;
}

function getNextPersistRevision() {
  return Math.max(Date.now(), state.persistRevision + 1);
}

function buildShareableStatePayload() {
  return {
    persistRevision: normalizePersistRevision(state.persistRevision),
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
      themeGalleryThemeId: state.uiSettings.themeGalleryThemeId || "",
      themeGalleryPreviewMode: state.uiSettings.themeGalleryPreviewMode || "all",
      themeGalleryMotionPreset: state.uiSettings.themeGalleryMotionPreset || "calm",
      themeGalleryToneX: Number(state.uiSettings.themeGalleryToneX ?? 50),
      themeGalleryToneY: Number(state.uiSettings.themeGalleryToneY ?? 50),
      themeGalleryAnimatedWallpaperEnabled: state.uiSettings.themeGalleryAnimatedWallpaperEnabled !== false,
      themeGalleryBackgroundFinish: state.uiSettings.themeGalleryBackgroundFinish === "doff" ? "doff" : "glossy",
      liveWallpaperSpeed: getLiveWallpaperSpeedPreset(state.uiSettings.liveWallpaperSpeed).label,
      liveWallpaperColor: normalizeHexColor(state.uiSettings.liveWallpaperColor, c_white),
      desktopBackgroundSource: getResolvedDesktopBackgroundSource(),
      desktopImagePresetId: state.uiSettings.desktopImagePresetId || "",
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
      payload.uiSettings.themeGalleryThemeId ||
      payload.uiSettings.desktopImagePresetId ||
      payload.uiSettings.desktopBackgroundSource === "custom"
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
      return false;
    }

    const shared = decodeShareState(encoded);
    if (!shared) {
      clearShareStateFromUrl();
      return false;
    }

    applySerializedStatePayload(shared);
    if (isFirebaseSyncConfigured() || encoded.length > MAX_SHARE_STATE_PARAM_LENGTH) {
      clearShareStateFromUrl();
    }
    return true;
  } catch (error) {
    console.warn("Gagal memuat share state dari URL.", error);
    return false;
  }
}

function buildFirebaseStatePayload() {
  return {
    persistRevision: normalizePersistRevision(state.persistRevision),
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
      themeGalleryThemeId: state.uiSettings.themeGalleryThemeId || "",
      themeGalleryPreviewMode: state.uiSettings.themeGalleryPreviewMode || "all",
      themeGalleryMotionPreset: state.uiSettings.themeGalleryMotionPreset || "calm",
      themeGalleryToneX: Number(state.uiSettings.themeGalleryToneX ?? 50),
      themeGalleryToneY: Number(state.uiSettings.themeGalleryToneY ?? 50),
      themeGalleryAnimatedWallpaperEnabled: state.uiSettings.themeGalleryAnimatedWallpaperEnabled !== false,
      themeGalleryBackgroundFinish: state.uiSettings.themeGalleryBackgroundFinish === "doff" ? "doff" : "glossy",
      liveWallpaperSpeed: getLiveWallpaperSpeedPreset(state.uiSettings.liveWallpaperSpeed).label,
      liveWallpaperColor: normalizeHexColor(state.uiSettings.liveWallpaperColor, c_white),
      desktopBackgroundSource: getResolvedDesktopBackgroundSource(),
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

  if (shouldIgnoreIncomingPersistedPayload(payload)) {
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

async function initializeFirebaseSync({ preferCurrentState = false } = {}) {
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
      if (preferCurrentState) {
        await syncStateToFirebaseNow();
        updateFirebaseStatus("Firebase Sync aktif. State lokal dipertahankan saat refresh dan disinkronkan ke cloud.");
      } else {
        await applyRemoteFirebasePayload(snapshot.data()?.payload);
      }
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
    if (!firebaseRuntime.suppressWrites) {
      state.persistRevision = getNextPersistRevision();
    }

    const payload = {
      persistRevision: normalizePersistRevision(state.persistRevision),
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

function getLiveSheetRequestKeyFromInputs() {
  const spreadsheetId = extractSpreadsheetId(elements.googleSheetLink.value);
  const sheetName = String(elements.sourceBankSelect.value || "").trim();
  const areaRange = String(elements.areaCodeDisplay.value || "").trim();
  const balanceRange = String(elements.rangeStart.value || "").trim();
  const limitRange = String(elements.rangeEnd.value || "").trim();
  return [spreadsheetId, sheetName, areaRange, balanceRange, limitRange].join("|");
}

function canReuseCurrentLiveSheetEntries() {
  if (!isLiveSheetReady() || state.liveSheet.loading || state.liveSheet.entries.length === 0) {
    return false;
  }

  return state.liveSheet.lastAppliedKey === getLiveSheetRequestKeyFromInputs();
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
  state.uiSettings.desktopBackgroundSource = normalizeDesktopBackgroundSource(
    elements.backgroundSourceSelect?.value,
    inferDesktopBackgroundSource()
  );
  state.uiSettings.desktopImageFit = normalizeDesktopFitMode(
    elements.backgroundFitSelect?.value || state.uiSettings.desktopImageFit
  );
}

function syncUiSettingsToForm({ preserveDirtyFields = true } = {}) {
  const shouldPreserveDirty = preserveDirtyFields && isModalOpen(elements.settingsModal);
  const assignFieldValue = (fieldName, element, nextValue) => {
    if (!element) {
      return;
    }

    if (shouldPreserveDirty && renderRuntime.settingsDirtyFields.has(fieldName)) {
      return;
    }

    element.value = nextValue;
  };

  assignFieldValue("googleSheetLink", elements.googleSheetLink, state.uiSettings.googleSheetLink);
  assignFieldValue("sourceBankSelect", elements.sourceBankSelect, state.uiSettings.sheetName);
  assignFieldValue("areaCodeDisplay", elements.areaCodeDisplay, state.uiSettings.areaCodeDisplay);
  assignFieldValue("orientationMode", elements.orientationMode, state.uiSettings.orientationMode || "auto");
  assignFieldValue("rangeStart", elements.rangeStart, state.uiSettings.rangeBalance || "A:A");
  assignFieldValue("rangeEnd", elements.rangeEnd, state.uiSettings.rangeLimit || "B:B");
  if (elements.backgroundSourceSelect) {
    elements.backgroundSourceSelect.value = getResolvedDesktopBackgroundSource();
  }
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

  return "";
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
    const emptySignature = "empty:no-live-data";
    if (renderRuntime.bankRenderSignature !== emptySignature) {
      elements.bankColumns.innerHTML =
        '<div class="empty-column">Belum ada data hasil extract Google Sheet untuk ditampilkan di dashboard.</div>';
      renderRuntime.bankRenderSignature = emptySignature;
    }
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
  const renderSignature = JSON.stringify(
    visibleBanks.map(({ bank, entries }) => ({
      bankName: bank.name,
      entries: entries.map((entry) => [entry.code, Number(entry.limit || 0), Number(entry.amount || 0)]),
    }))
  );
  const previousScrollLeft = elements.bankColumns.scrollLeft;
  const bankAccentMap = buildVisibleBankAccentMap(visibleBanks.map(({ bank }) => bank.name));

  visibleBanks.forEach(({ bank, entries }) => {
    const column = document.createElement("article");
    column.className = "bank-column";
    const longestCodeLength = Math.max(
      "Area Code".length,
      ...entries.map((entry) => String(entry.code || "").trim().length)
    );
    const codeColumnWidth = Math.min(30, Math.max(14, longestCodeLength + 1));
    column.style.setProperty("--code-column-width", `${codeColumnWidth}ch`);
    applyBankColumnAccent(column, bank.name, bankAccentMap.get(bank.name) || "#f4ca47");

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
    const emptySignature = "empty:no-selected-codes";
    if (renderRuntime.bankRenderSignature !== emptySignature) {
      elements.bankColumns.innerHTML =
        '<div class="empty-column">Belum ada area code yang dipilih untuk ditampilkan di dashboard.</div>';
      renderRuntime.bankRenderSignature = emptySignature;
    }
  } else {
    if (renderRuntime.bankRenderSignature !== renderSignature) {
      elements.bankColumns.replaceChildren(fragment);
      renderRuntime.bankRenderSignature = renderSignature;
      window.requestAnimationFrame(() => {
        elements.bankColumns.scrollLeft = previousScrollLeft;
      });
    }
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

function syncSettingsForm({ forceBankConfig = false } = {}) {
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

  const shouldApplyBankConfig =
    !hasLiveSheetInput() &&
    (
      forceBankConfig ||
      (!String(elements.rangeStart.value || "").trim() && !String(elements.rangeEnd.value || "").trim())
    );

  if (shouldApplyBankConfig) {
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
  applyDesktopBackground();
  persistState();

  if (isLiveSheetReady()) {
    if (canReuseCurrentLiveSheetEntries()) {
      normalizePersistedSelections();
      renderBankSelectionModal();
      updateSettingsPreview();
      updateSheetBadge();
      renderBanks();
      flushFirebaseSyncInBackground();
      if (closeAfterApply) {
        closeModal(elements.settingsModal);
        showSaveSuccessNotice("Save & Extract berhasil. Dashboard utama langsung diperbarui.");
      }
      return true;
    }

    const success = await syncLiveSheetEntries();
    if (success) {
      flushFirebaseSyncInBackground();
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
  flushFirebaseSyncInBackground();

  if (closeAfterApply) {
    closeModal(elements.settingsModal);
    showSaveSuccessNotice("Save & Extract berhasil. Dashboard utama langsung diperbarui.");
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
    state.uiSettings.themeGalleryThemeId = "";
    state.uiSettings.themeGalleryPreviewMode = "all";
    state.uiSettings.desktopBackgroundSource = "preset";
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

  try {
    const nextPersistedState = JSON.parse(event.newValue);
    if (shouldIgnoreIncomingPersistedPayload(nextPersistedState)) {
      return;
    }

    applySerializedStatePayload(nextPersistedState);
  } catch (error) {
    console.warn("Gagal membaca state dashboard dari tab lain.", error);
    return;
  }

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
    liveSheetSyncPromise = null;
    persistState();
    return false;
  }

  if (state.liveSheet.loading) {
    return liveSheetSyncPromise || false;
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

  liveSheetSyncPromise = (async () => {
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
    } finally {
      liveSheetSyncPromise = null;
    }
  })();

  return liveSheetSyncPromise;
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
    clearSettingsFieldDirtyState();
    setSaveSettingsButtonState(false);
    syncUiSettingsToForm({ preserveDirtyFields: false });
    updateSettingsPreview();
    openModal(elements.settingsModal);
  });

  elements.openThemeGallery?.addEventListener("click", openThemeGalleryModal);

  elements.refreshData.addEventListener("click", refreshDashboard);

  document.querySelectorAll("[data-close-modal='bank']").forEach((button) => {
    button.addEventListener("click", () => closeModal(elements.bankModal));
  });

  document.querySelectorAll("[data-close-modal='settings']").forEach((button) => {
    button.addEventListener("click", () => {
      clearSettingsFieldDirtyState();
      setSaveSettingsButtonState(false);
      closeModal(elements.settingsModal);
    });
  });

  document.querySelectorAll("[data-close-modal='theme-gallery']").forEach((button) => {
    button.addEventListener("click", closeThemeGalleryModalAndRestore);
  });

  elements.bankModal.addEventListener("click", (event) => {
    if (event.target === elements.bankModal) {
      closeModal(elements.bankModal);
    }
  });

  elements.settingsModal.addEventListener("click", (event) => {
    if (event.target === elements.settingsModal) {
      clearSettingsFieldDirtyState();
      setSaveSettingsButtonState(false);
      closeModal(elements.settingsModal);
    }
  });

  elements.themeGalleryModal?.addEventListener("click", (event) => {
    if (event.target === elements.themeGalleryModal) {
      closeThemeGalleryModalAndRestore();
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

  elements.previewRange.addEventListener("click", updateSettingsPreview);
  elements.cancelSettings.addEventListener("click", () => {
    clearSettingsFieldDirtyState();
    setSaveSettingsButtonState(false);
    closeModal(elements.settingsModal);
  });
  elements.backThemeGalleryDetail?.addEventListener("click", closeThemeGalleryDetail);
  elements.closeThemeGalleryDetail?.addEventListener("click", closeThemeGalleryDetail);
  elements.themeGalleryDetailBackdrop?.addEventListener("click", closeThemeGalleryDetail);
  elements.closeThemeGallery?.addEventListener("click", resetThemeGallerySelection);
  elements.applyThemeGallery?.addEventListener("click", applyThemeGallerySelection);
  elements.themeGalleryModal?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const previewModeButton = target.closest("[data-theme-preview-mode]");
    if (previewModeButton instanceof HTMLButtonElement) {
      const previewMode = previewModeButton.getAttribute("data-theme-preview-mode");
      if (previewMode === "light" || previewMode === "dark" || previewMode === "all") {
        renderRuntime.themeGalleryPreviewMode = previewMode;
        updateThemeGalleryPreview();
      }
      return;
    }

    const soundToggleButton = target.closest("[data-theme-sound-toggle]");
    if (soundToggleButton instanceof HTMLButtonElement) {
      const soundKey = soundToggleButton.getAttribute("data-theme-sound-toggle") || "";
      if (soundKey) {
        renderRuntime.themeGallerySoundStates[soundKey] = !Boolean(
          renderRuntime.themeGallerySoundStates[soundKey]
        );
        syncThemeGallerySoundButtons();
      }
      return;
    }

    const wallpaperToggleButton = target.closest("[data-theme-wallpaper-toggle]");
    if (wallpaperToggleButton instanceof HTMLButtonElement) {
      const toggleType = wallpaperToggleButton.getAttribute("data-theme-wallpaper-toggle") || "";
      if (toggleType === "animated") {
        renderRuntime.themeGalleryAnimatedWallpaperEnabled = !normalizeThemeGalleryAnimatedWallpaperEnabled(
          renderRuntime.themeGalleryAnimatedWallpaperEnabled,
          true
        );
        updateThemeGalleryPreview();
        return;
      }
      if (toggleType === "finish") {
        renderRuntime.themeGalleryBackgroundFinish =
          normalizeThemeGalleryBackgroundFinish(renderRuntime.themeGalleryBackgroundFinish, "glossy") === "glossy"
            ? "doff"
            : "glossy";
        updateThemeGalleryPreview();
      }
      return;
    }
  });
  document.addEventListener("visibilitychange", refreshLiveSheetOnFocus);
  window.addEventListener("focus", refreshLiveSheetOnFocus);
  window.addEventListener("storage", handleStorageSync);

  elements.googleSheetLink.addEventListener("input", () => {
    markSettingsFieldDirty("googleSheetLink");
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });

  elements.sourceBankSelect.addEventListener("input", () => {
    markSettingsFieldDirty("sourceBankSelect");
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });

  elements.areaCodeDisplay.addEventListener("input", () => {
    markSettingsFieldDirty("areaCodeDisplay");
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

  elements.backgroundSourceSelect?.addEventListener("change", () => {
    const requestedSource = normalizeDesktopBackgroundSource(
      elements.backgroundSourceSelect?.value,
      getResolvedDesktopBackgroundSource()
    );
    state.uiSettings.desktopBackgroundSource = getResolvedDesktopBackgroundSource({
      ...state.uiSettings,
      desktopBackgroundSource: requestedSource,
    });
    if (elements.backgroundSourceSelect) {
      elements.backgroundSourceSelect.value = state.uiSettings.desktopBackgroundSource;
    }
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

  elements.themeGalleryGrid?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const card = target.closest(".theme-gallery-card");
    if (!(card instanceof HTMLButtonElement)) {
      return;
    }

    const presetId = card.getAttribute("data-theme-gallery-id");
    if (!presetId) {
      return;
    }

    renderRuntime.themeGallerySelectionId = presetId;
    renderRuntime.themeGalleryPreviewMode = getPreferredThemeGalleryPreviewMode(
      getThemeGalleryThemeById(presetId),
      { preserveRuntime: true }
    );
    renderRuntime.themeGalleryMotionPreset = getPreferredThemeGalleryMotionPreset(
      getThemeGalleryThemeById(presetId),
      { preserveRuntime: true }
    );
    {
      const tone = getPreferredThemeGalleryTone(getThemeGalleryThemeById(presetId), {
        preserveRuntime: true,
      });
      renderRuntime.themeGalleryToneX = tone.x;
      renderRuntime.themeGalleryToneY = tone.y;
    }
    renderRuntime.themeGalleryAnimatedWallpaperEnabled = getPreferredThemeGalleryAnimatedWallpaperEnabled(
      getThemeGalleryThemeById(presetId),
      { preserveRuntime: true }
    );
    renderRuntime.themeGalleryBackgroundFinish = getPreferredThemeGalleryBackgroundFinish(
      getThemeGalleryThemeById(presetId),
      { preserveRuntime: true }
    );
    renderThemeGallery();
    openThemeGalleryDetail();
  });

  const startThemeToneDrag = (event) => {
    renderRuntime.themeGalleryToneDragging = true;
    updateThemeGalleryToneFromClientPosition(event.clientX, event.clientY);
    if (event.target instanceof Element && "setPointerCapture" in event.target && typeof event.target.setPointerCapture === "function") {
      try {
        event.target.setPointerCapture(event.pointerId);
      } catch (error) {
        // Ignore capture failures and continue with window-level pointer tracking.
      }
    }
    event.preventDefault();
  };

  elements.themeGalleryColorSurface?.addEventListener("pointerdown", startThemeToneDrag);
  elements.themeGalleryColorHandle?.addEventListener("pointerdown", startThemeToneDrag);

  window.addEventListener("pointermove", (event) => {
    if (!renderRuntime.themeGalleryToneDragging) {
      return;
    }
    updateThemeGalleryToneFromClientPosition(event.clientX, event.clientY);
  });

  window.addEventListener("pointerup", stopThemeGalleryToneDragging);
  window.addEventListener("pointercancel", stopThemeGalleryToneDragging);

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
    state.uiSettings.themeGalleryThemeId = "";
    state.uiSettings.themeGalleryPreviewMode = "all";
    state.uiSettings.desktopBackgroundSource = "preset";
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
    markSettingsFieldDirty("orientationMode");
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });
  elements.rangeStart.addEventListener("input", () => {
    markSettingsFieldDirty("rangeStart");
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });
  elements.rangeEnd.addEventListener("input", () => {
    markSettingsFieldDirty("rangeEnd");
    syncUiSettingsFromForm();
    persistState();
    updateSettingsPreview();
    scheduleSettingsAutoApply();
  });
  elements.sourceBankSelect.addEventListener("change", () => {
    markSettingsFieldDirty("sourceBankSelect");
    syncSettingsForm();
    scheduleSettingsAutoApply();
  });

  elements.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (elements.saveSettings?.disabled) {
      return;
    }

    if (settingsInputTimerId) {
      window.clearTimeout(settingsInputTimerId);
      settingsInputTimerId = 0;
    }

    setSaveSettingsButtonState(true);
    void applySettingsFromForm({ closeAfterApply: true }).finally(() => {
      clearSettingsFieldDirtyState();
      setSaveSettingsButtonState(false);
    });
  });
}

async function init() {
  setDashboardRefreshStabilizing(true);
  setupAntiTamperGuards();
  const restoredFromLocal = loadPersistedState();
  const restoredFromUrl = restoredFromLocal ? false : loadSharedStateFromUrl();
  const preferCurrentStateOnInit = restoredFromLocal || restoredFromUrl;
  syncUiSettingsToForm({ preserveDirtyFields: false });
  if (restoredFromUrl) {
    persistState();
  }
  applyDesktopBackground();
  updateFirebaseStatus("Firebase Sync nonaktif. Isi `firebase-config.js` untuk mengaktifkan sinkronisasi global.");
  if (state.liveSheet.entries.length > 0 && isGoogleSheetUrl(state.uiSettings.googleSheetLink)) {
    startLiveSyncTimer();
  }
  startDashboardClock();
  registerEvents();

  try {
    await loadData();
    await initializeFirebaseSync({ preferCurrentState: preferCurrentStateOnInit });
  } catch (error) {
    console.error(error);
    elements.bankColumns.innerHTML =
      '<div class="empty-column">Data dashboard gagal dimuat. Pastikan file JSON tersedia.</div>';
  } finally {
    scheduleDashboardRefreshRelease(260);
  }
}

init();
