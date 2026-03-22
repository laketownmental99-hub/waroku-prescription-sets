// ==UserScript==
// @name         Waroku処方セット v6.5
// @namespace    http://tampermonkey.net/
// @version      6.5
// @description  処方分析データに基づくシチュエーション別処方セット（GitHub外部JSON・全用法対応・セカンドモニター対応・ドラッグ＆ドロップ並替）
// @match        https://lmc.karte.waroku.net/*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function() {
'use strict';

/* ============ 設定 ============ */
var GITHUB_JSON_URL = 'https://raw.githubusercontent.com/laketownmental99-hub/waroku-prescription-sets/main/prescription-sets.json';

var STORAGE_KEY = 'waroku_prescription_sets_v6';
var SETS_VERSION_KEY = 'waroku_prescription_sets_version_v6';
var USER_CUSTOM_KEY = 'waroku_user_custom_sets_v6';
var CURRENT_VERSION = '6.5';

/* ============ データ管理 ============ */
function loadSets() {
  try {
    var s = localStorage.getItem(STORAGE_KEY);
    if (s) return JSON.parse(s);
  } catch(e) {}
  return null;
}

function saveSets(sets) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
}

function fetchDefaultSets() {
  return new Promise(function(resolve, reject) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: GITHUB_JSON_URL + '?t=' + Date.now(),
      onload: function(response) {
        try {
          var data = JSON.parse(response.responseText);
          resolve(data);
        } catch(e) {
          console.error('JSON parse error:', e);
          reject(e);
        }
      },
      onerror: function(err) {
        console.error('Fetch error:', err);
        reject(err);
      }
    });
  });
}

function getSets(callback) {
  var ver = localStorage.getItem(SETS_VERSION_KEY);
  var sets = loadSets();
  if (sets && ver === CURRENT_VERSION) {
    callback(sets);
    return;
  }
  fetchDefaultSets().then(function(data) {
    saveSets(data);
    localStorage.setItem(SETS_VERSION_KEY, CURRENT_VERSION);
    callback(data);
  }).catch(function() {
    if (sets) {
      callback(sets);
    } else {
      callback([]);
      alert('処方セットの読み込みに失敗しました。GitHub URLを確認してください。');
    }
  });
}

/* ============ 用法キャッシュ ============ */
var cachedAdminTypes = null;
var cachedAdminFlat = null;
var adminLoadPromise = null;

function getAngularContext() {
  var el = document.querySelector('[ng-controller="KarteController as ctrl"]');
  if (!el) return null;
  var scope = angular.element(el).scope();
  if (!scope || !scope.ctrl) return null;
  var ctrl = scope.ctrl;
  var injector = angular.element(document.body).injector();
  var $timeout = injector.get('$timeout');
  var OrderingService = ctrl.OrderingService;
  var orderRps = null;
  var mode = null;

  var doFormOpen = !!document.querySelector('#order-edit-form.open');
  if (doFormOpen && ctrl.orderInfo) {
    if (!ctrl.orderInfo.orderRps) { ctrl.orderInfo.orderRps = []; }
    orderRps = ctrl.orderInfo.orderRps;
    mode = 'do';
  } else if (ctrl.palettePrescribe) {
    if (!ctrl.palettePrescribe.orderRps) { ctrl.palettePrescribe.orderRps = []; }
    orderRps = ctrl.palettePrescribe.orderRps;
    mode = 'order';
  }

  return { scope: scope, ctrl: ctrl, injector: injector, $timeout: $timeout, OrderingService: OrderingService, orderRps: orderRps, mode: mode };
}

function loadAdminTypes(OrderingService) {
  if (adminLoadPromise) return adminLoadPromise;
  adminLoadPromise = new Promise(function(resolve) {
    if (cachedAdminTypes) { resolve(cachedAdminTypes); return; }
    OrderingService.findMedicineAdministrationType().then(function(res) {
      var data = res.data || res;
      cachedAdminTypes = Array.isArray(data) ? data : [];
      cachedAdminFlat = [];
      cachedAdminTypes.forEach(function(cat) {
        if (cat.medicineAdministrations) {
          cat.medicineAdministrations.forEach(function(a) {
            cachedAdminFlat.push(a);
          });
        }
      });
      resolve(cachedAdminTypes);
    }).catch(function() {
      adminLoadPromise = null;
      resolve([]);
    });
  });
  return adminLoadPromise;
}

function getFlatAdminList(OrderingService) {
  return new Promise(function(resolve) {
    if (cachedAdminFlat) { resolve(cachedAdminFlat); return; }
    loadAdminTypes(OrderingService).then(function() {
      resolve(cachedAdminFlat || []);
    });
  });
}

function preloadAdminTypes() {
  try {
    var ctx = getAngularContext();
    if (ctx && ctx.OrderingService) {
      loadAdminTypes(ctx.OrderingService);
    }
  } catch(e) {}
}

function toFullWidth(str) {
  if (!str) return '';
  return str.replace(/[0-9]/g, function(c) {
    return String.fromCharCode(c.charCodeAt(0) + 0xFEE0);
  }).replace(/\./g, '．').replace(/,/g, '，').replace(/ /g, '　');
}

function normalizeAdmin(str) {
  if (!str) return '';
  return toFullWidth(str).replace(/\s+/g, '');
}

function findAdminObj(list, name) {
  if (!list || !name) return null;
  // 1. exact match
  var found = list.find(function(a) { return a.name === name; });
  if (found) return found;
  // 2. full-width normalized exact match
  var normName = normalizeAdmin(name);
  found = list.find(function(a) { return normalizeAdmin(a.name) === normName; });
  if (found) return found;
  // 3. partial match (indexOf)
  found = list.find(function(a) { return a.name && a.name.indexOf(name) >= 0; });
  if (found) return found;
  // 4. normalized partial match
  found = list.find(function(a) { return a.name && normalizeAdmin(a.name).indexOf(normName) >= 0; });
  if (found) return found;
  // 5. reverse partial match
  found = list.find(function(a) { return a.name && normName.indexOf(normalizeAdmin(a.name)) >= 0; });
  return found || null;
}
/* ============ 薬剤入力コア関数 ============ */
function injectMedicine(med) {
  var ctx = getAngularContext();
  if (!ctx) {
    alert('カルテ画面が見つかりません。');
    return;
  }
  if (!ctx.orderRps) {
    alert('オーダー画面またはDoオーダーフォームを開いてください。');
    return;
  }
  var $timeout = ctx.$timeout;
  var OrderingService = ctx.OrderingService;
  var orderRps = ctx.orderRps;

  OrderingService.searchMedicine(med.searchText).then(function(res) {
    var list = null;
    if (res && res.data && res.data.content) {
      list = res.data.content;
    } else if (res && res.data && Array.isArray(res.data)) {
      list = res.data;
    } else if (Array.isArray(res)) {
      list = res;
    }
    if (!list || !list.length) {
      alert(med.searchText + ' が見つかりません');
      return;
    }

    var found = list.find(function(m) { return m.name === med.searchText; });
    if (!found) found = list.find(function(m) { return m.medicineName === med.searchText; });
    if (!found) found = list[0];

    var medicine = {
      medicine: JSON.parse(JSON.stringify(found)),
      medicineName: found.name || found.medicineName,
      genericName: null,
      dose: med.dose || '1',
      dosageForm: med.dosageForm || '通常',
      unit: found.unit ? found.unit.name : '錠',
      denyGeneric: med.denyGeneric || false,
      excludePublicInsurance: med.excludePublicInsurance || false,
      comment: null,
      selected: true,
      prescriptionGenericName: false,
      duplicateResult: null,
      reasonForNotChangingGenericProduct: 0,
      selectedMedicalCareClassification: '0',
      reasonForNotChangingGenericProductName: null
    };

    getFlatAdminList(OrderingService).then(function(adminList) {
      var adminObj = findAdminObj(adminList, med.administration);
      var rp = {
        orderMedicines: [medicine],
        numOfDays: parseInt(med.numOfDays) || 28,
        comment: med.comment || '',
        odp: med.odp || false,
        collapsed: false,
        orderType: 'PRESCRIBE',
        selected: true,
        procedureString: null,
        procedure: null,
        procedureId: null,
        administrationCode: null,
        refillNumber: 0
      };

      if (adminObj) {
        rp.administration = JSON.parse(JSON.stringify(adminObj));
        rp.administrationString = adminObj.name;
        rp.administrationId = adminObj.id;
      } else {
        rp.administrationString = med.administration || '';
        rp.administration = null;
        rp.administrationId = null;
      }

      $timeout(function() {
        orderRps.push(rp);
      });
    });
  }).catch(function(err) {
    alert(med.searchText + ' の検索に失敗しました');
    console.error('injectMedicine error:', err);
  });
}

window.injectMedicine = injectMedicine;
/* ============ スタイル ============ */
var STYLE = document.createElement('style');
STYLE.textContent = '\
.mt{font-family:sans-serif;font-size:13px}\
.mt *{box-sizing:border-box}\
.mt-panel{position:fixed;top:60px;right:12px;width:320px;background:#fff;border:1px solid #ccc;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:100000;display:flex;flex-direction:column;max-height:80vh}\
.mt-hdr{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:linear-gradient(135deg,#1976d2,#1565c0);color:#fff;border-radius:8px 8px 0 0;cursor:move;user-select:none}\
.mt-hdr span{font-weight:bold;font-size:14px}\
.mt-hdr-btns button{background:none;border:none;color:#fff;cursor:pointer;font-size:16px;margin-left:4px;padding:2px 6px;border-radius:4px}\
.mt-hdr-btns button:hover{background:rgba(255,255,255,.25)}\
.mt-body{overflow-y:auto;padding:6px;flex:1}\
.mt-set{margin-bottom:4px;border:1px solid #e0e0e0;border-radius:6px;overflow:visible}\
.mt-set-hdr{display:flex;align-items:center;padding:6px 8px;cursor:pointer;font-weight:bold;font-size:13px;border-radius:6px;transition:background .15s}\
.mt-set-hdr:hover{filter:brightness(1.1)}\
.mt-set-hdr .arrow{margin-right:6px;font-size:10px;transition:transform .2s}\
.mt-set-hdr .arrow.open{transform:rotate(90deg)}\
.mt-set-body{display:none;padding:2px 4px 6px}\
.mt-set-body.open{display:block}\
.mt-drug{display:flex;align-items:center;padding:3px 6px;margin:1px 0;border-radius:4px;cursor:pointer;font-size:12px;transition:background .1s}\
.mt-drug:hover{background:#e3f2fd}\
.mt-drug .dname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\
.mt-drug .dinfo{color:#888;font-size:11px;margin-left:4px;white-space:nowrap}\
.mt-footer{padding:4px 8px;border-top:1px solid #eee;display:flex;gap:4px;flex-wrap:wrap}\
.mt-footer button{flex:1;padding:4px 6px;font-size:11px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#fff;min-width:60px}\
.mt-footer button:hover{background:#f0f0f0}\
.mt-footer button.primary{background:#1976d2;color:#fff;border-color:#1565c0}\
.mt-footer button.primary:hover{background:#1565c0}\
.mt-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:200000;display:flex;align-items:center;justify-content:center}\
.mt-dlg{background:#fff;border-radius:10px;width:700px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.3)}\
.mt-dlg-hdr{padding:12px 16px;background:#1976d2;color:#fff;border-radius:10px 10px 0 0;font-weight:bold;font-size:15px;display:flex;justify-content:space-between;align-items:center}\
.mt-dlg-body{padding:12px 16px;overflow-y:auto;flex:1}\
.mt-dlg-foot{padding:10px 16px;border-top:1px solid #eee;display:flex;justify-content:flex-end;gap:8px}\
.mt-dlg-foot button{padding:6px 16px;border-radius:4px;border:1px solid #ccc;cursor:pointer;font-size:13px}\
.mt-dlg-foot button.save{background:#1976d2;color:#fff;border-color:#1565c0}\
.mt-dlg-foot button.save:hover{background:#1565c0}\
.mt-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;padding:6px;border:1px solid #e8e8e8;border-radius:6px;background:#fafafa;flex-wrap:wrap}\
.mt-row label{font-size:11px;color:#555}\
.mt-row input[type=text],.mt-row input[type=number]{border:1px solid #ccc;border-radius:3px;padding:3px 6px;font-size:12px}\
.mt-row select{display:block!important;opacity:1!important;position:static!important;height:28px!important;width:auto!important;pointer-events:auto!important;appearance:auto!important;-webkit-appearance:auto!important;border:1px solid #ccc;border-radius:3px;padding:2px 4px;font-size:12px;background:#fff}\
.mt-row input[type=checkbox]{display:inline-block!important;opacity:1!important;position:static!important;width:16px!important;height:16px!important;pointer-events:auto!important;appearance:auto!important;-webkit-appearance:auto!important;margin:0 2px!important;cursor:pointer}\
.mt-row .del-btn{color:#d32f2f;cursor:pointer;font-size:16px;padding:2px 6px;border:none;background:none}\
.mt-row .del-btn:hover{background:#ffebee;border-radius:4px}\
.mt-row .drag-handle{cursor:grab;font-size:16px;color:#999;padding:2px 4px;user-select:none;line-height:1}\
.mt-row .drag-handle:active{cursor:grabbing}\
.mt-row.dragging{opacity:0.4;border:1px dashed #1976d2;background:#e3f2fd}\
.mt-row.drag-over{border-top:3px solid #1976d2}\
.mt-search-wrap{position:relative}\
.mt-search-dd{position:fixed;background:#fff;border:1px solid #ccc;border-radius:4px;max-height:200px;overflow-y:auto;z-index:300000;box-shadow:0 4px 12px rgba(0,0,0,.2);min-width:300px}\
.mt-search-dd div{padding:4px 8px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0}\
.mt-search-dd div:hover{background:#e3f2fd}\
.mt-admin-dd{position:fixed;background:#fff;border:1px solid #ccc;border-radius:4px;max-height:250px;overflow-y:auto;z-index:300000;box-shadow:0 4px 12px rgba(0,0,0,.2);min-width:250px}\
.mt-admin-dd .mt-admin-cat{padding:4px 8px;font-weight:bold;font-size:11px;color:#1976d2;background:#f5f5f5;border-bottom:1px solid #e0e0e0;cursor:default}\
.mt-admin-dd .mt-admin-item{padding:4px 8px 4px 16px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0}\
.mt-admin-dd .mt-admin-item:hover{background:#e3f2fd}\
';
document.head.appendChild(STYLE);
/* ============ パネルUI ============ */
var panelEl = null;
var popupWin = null;
var popupActive = false;

function createPanel(container, sets) {
  var isPopup = container !== document.body;
  var panel = document.createElement('div');
  panel.className = 'mt';

  if (!isPopup) {
    var wrapper = document.createElement('div');
    wrapper.className = 'mt-panel';
    wrapper.id = 'mt-panel';

    var hdr = document.createElement('div');
    hdr.className = 'mt-hdr';
    hdr.innerHTML = '<span>処方セット v6.5</span><div class="mt-hdr-btns"></div>';
    var btns = hdr.querySelector('.mt-hdr-btns');

    var popBtn = document.createElement('button');
    popBtn.textContent = '\u29C9';
    popBtn.title = 'セカンドモニターに移動';
    popBtn.onclick = function() { openPopup(); };
    btns.appendChild(popBtn);

    var minBtn = document.createElement('button');
    minBtn.textContent = '\u2212';
    minBtn.title = '最小化';
    btns.appendChild(minBtn);

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.title = '閉じる';
    closeBtn.onclick = function() { wrapper.style.display = 'none'; };
    btns.appendChild(closeBtn);

    wrapper.appendChild(hdr);

    var body = document.createElement('div');
    body.className = 'mt-body';
    buildSetList(body, sets);
    wrapper.appendChild(body);

    var footer = document.createElement('div');
    footer.className = 'mt-footer';

    minBtn.onclick = function() {
      body.style.display = body.style.display === 'none' ? '' : 'none';
      footer.style.display = footer.style.display === 'none' ? '' : 'none';
      minBtn.textContent = body.style.display === 'none' ? '+' : '\u2212';
    };

    var editBtn = document.createElement('button');
    editBtn.textContent = '\u270F\uFE0F 編集';
    editBtn.onclick = function() { openEditor(); };
    footer.appendChild(editBtn);

    var exportBtn = document.createElement('button');
    exportBtn.textContent = '\uD83D\uDCE4 書出';
    exportBtn.title = 'カスタムデータをJSONでエクスポート';
    exportBtn.onclick = function() { exportSets(); };
    footer.appendChild(exportBtn);

    var importBtn = document.createElement('button');
    importBtn.textContent = '\uD83D\uDCE5 読込';
    importBtn.title = 'JSONからデータをインポート';
    importBtn.onclick = function() { importSets(); };
    footer.appendChild(importBtn);

    var resetBtn = document.createElement('button');
    resetBtn.textContent = '\uD83D\uDD04 リセット';
    resetBtn.title = 'GitHubからデフォルトに戻す';
    resetBtn.onclick = function() {
      if (confirm('処方セットをGitHubのデフォルトに戻しますか？')) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SETS_VERSION_KEY);
        refreshPanel();
      }
    };
    footer.appendChild(resetBtn);

    wrapper.appendChild(footer);
    panel.appendChild(wrapper);
    makeDraggable(wrapper, hdr);
    panelEl = panel;
    container.appendChild(panel);
  } else {
    var body2 = document.createElement('div');
    body2.style.padding = '8px';
    buildSetList(body2, sets);
    panel.appendChild(body2);

    var footer2 = document.createElement('div');
    footer2.className = 'mt-footer';
    footer2.style.padding = '8px';

    var editBtn2 = document.createElement('button');
    editBtn2.textContent = '\u270F\uFE0F 編集';
    editBtn2.onclick = function() { openEditor(); };
    footer2.appendChild(editBtn2);

    var exportBtn2 = document.createElement('button');
    exportBtn2.textContent = '\uD83D\uDCE4 書出';
    exportBtn2.onclick = function() { exportSets(); };
    footer2.appendChild(exportBtn2);

    var importBtn2 = document.createElement('button');
    importBtn2.textContent = '\uD83D\uDCE5 読込';
    importBtn2.onclick = function() { importSets(); };
    footer2.appendChild(importBtn2);

    var resetBtn2 = document.createElement('button');
    resetBtn2.textContent = '\uD83D\uDD04 リセット';
    resetBtn2.onclick = function() {
      if (confirm('処方セットをGitHubのデフォルトに戻しますか？')) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SETS_VERSION_KEY);
        refreshPanel();
      }
    };
    footer2.appendChild(resetBtn2);

    panel.appendChild(footer2);
    container.appendChild(panel);
  }
}

function buildSetList(container, sets) {
  container.innerHTML = '';
  sets.forEach(function(set) {
    var setEl = document.createElement('div');
    setEl.className = 'mt-set';

    var hdr = document.createElement('div');
    hdr.className = 'mt-set-hdr';
    hdr.style.background = (set.color || '#1976d2') + '22';
    hdr.style.color = set.color || '#1976d2';

    var arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '\u25B6';
    hdr.appendChild(arrow);

    var lbl = document.createElement('span');
    lbl.textContent = set.label + ' (' + set.medicines.length + ')';
    hdr.appendChild(lbl);

    var body = document.createElement('div');
    body.className = 'mt-set-body';

    hdr.onclick = function() {
      arrow.classList.toggle('open');
      body.classList.toggle('open');
    };

    set.medicines.forEach(function(med) {
      var drug = document.createElement('div');
      drug.className = 'mt-drug';

      var nameSpan = document.createElement('span');
      nameSpan.className = 'dname';
      nameSpan.textContent = med.searchText;
      drug.appendChild(nameSpan);

      var info = document.createElement('span');
      info.className = 'dinfo';
      info.textContent = med.dose + '\u00D7' + med.numOfDays + '日';
      drug.appendChild(info);

      drug.title = med.searchText + '\n用量: ' + med.dose + ' / 用法: ' + med.administration + ' / ' + med.numOfDays + '日';

      drug.onclick = function(e) {
        e.stopPropagation();
        var mainWin = window.opener || window;
        if (typeof mainWin.injectMedicine === 'function') {
          mainWin.injectMedicine(med);
        } else {
          injectMedicine(med);
        }
        drug.style.background = '#c8e6c9';
        setTimeout(function() { drug.style.background = ''; }, 800);
      };

      body.appendChild(drug);
    });

    setEl.appendChild(hdr);
    setEl.appendChild(body);
    container.appendChild(setEl);
  });
}

function makeDraggable(el, handle) {
  var startX, startY, startLeft, startTop;
  handle.addEventListener('mousedown', function(e) {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    var rect = el.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    el.style.right = 'auto';
    el.style.left = startLeft + 'px';
    el.style.top = startTop + 'px';

    function onMove(ev) {
      el.style.left = (startLeft + ev.clientX - startX) + 'px';
      el.style.top = (startTop + ev.clientY - startY) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/* ============ セカンドモニター(Popup) ============ */
function openPopup() {
  if (popupWin && !popupWin.closed) { popupWin.focus(); return; }
  popupWin = window.open('', 'rx_popup', 'width=360,height=700,scrollbars=yes,resizable=yes');
  if (!popupWin) { alert('ポップアップがブロックされました。許可してください。'); return; }
  popupActive = true;

  popupWin.document.write('<html><head><title>処方セット</title></head><body></body></html>');
  popupWin.document.close();

  var style = popupWin.document.createElement('style');
  style.textContent = STYLE.textContent;
  popupWin.document.head.appendChild(style);

  getSets(function(sets) {
    createPanel(popupWin.document.body, sets);
  });

  var mainPanel = document.getElementById('mt-panel');
  if (mainPanel) mainPanel.style.display = 'none';

  popupWin.addEventListener('beforeunload', function() {
    popupActive = false;
    popupWin = null;
    var mainPanel = document.getElementById('mt-panel');
    if (mainPanel) mainPanel.style.display = '';
  });
}

function refreshPanel() {
  var existing = document.getElementById('mt-panel');
  if (existing) {
    existing.parentElement.remove();
  }
  panelEl = null;
  getSets(function(sets) {
    if (!popupActive) {
      createPanel(document.body, sets);
    }
    if (popupWin && !popupWin.closed) {
      popupWin.document.body.innerHTML = '';
      createPanel(popupWin.document.body, sets);
    }
  });
}

function cleanupDropdowns() {
  document.querySelectorAll('.mt-search-dd,.mt-admin-dd').forEach(function(e) { e.remove(); });
}

/* ============ エクスポート/インポート ============ */
function exportSets() {
  getSets(function(sets) {
    var exportData = {
      version: CURRENT_VERSION,
      exportDate: new Date().toISOString(),
      sets: sets
    };
    var json = JSON.stringify(exportData, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'waroku-prescription-sets-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

function importSets() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      try {
        var data = JSON.parse(ev.target.result);
        var importedSets = null;

        if (data.sets && Array.isArray(data.sets)) {
          importedSets = data.sets;
        } else if (Array.isArray(data)) {
          importedSets = data;
        } else {
          alert('無効なファイル形式です。');
          return;
        }

        var mode = prompt(
          'インポート方法を選択してください:\n' +
          '1 = 現在のデータに追加（マージ）\n' +
          '2 = 現在のデータを置換\n' +
          'キャンセル = 中止',
          '1'
        );

        if (mode === '1') {
          getSets(function(currentSets) {
            importedSets.forEach(function(newSet) {
              var existing = currentSets.find(function(s) { return s.label === newSet.label; });
              if (existing) {
                newSet.medicines.forEach(function(newMed) {
                  var dup = existing.medicines.find(function(m) { return m.searchText === newMed.searchText; });
                  if (!dup) {
                    existing.medicines.push(newMed);
                  }
                });
              } else {
                currentSets.push(newSet);
              }
            });
            saveSets(currentSets);
            refreshPanel();
            alert('インポート完了（マージ）: ' + importedSets.length + ' セット処理しました。');
          });
        } else if (mode === '2') {
          if (confirm('現在のデータを完全に置き換えますか？この操作は元に戻せません。')) {
            saveSets(importedSets);
            localStorage.setItem(SETS_VERSION_KEY, CURRENT_VERSION);
            refreshPanel();
            alert('インポート完了（置換）: ' + importedSets.length + ' セット読み込みました。');
          }
        }
      } catch(err) {
        alert('JSONの読み込みに失敗しました: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

/* ============ 処方セット編集ダイアログ ============ */
function openEditor(setIdx) {
  getSets(function(sets) {
    var editIdx = (typeof setIdx === 'number') ? setIdx : -1;
    cleanupDropdowns();

    var overlay = document.createElement('div');
    overlay.className = 'mt mt-overlay';

    var dlg = document.createElement('div');
    dlg.className = 'mt-dlg';

    var hdr = document.createElement('div');
    hdr.className = 'mt-dlg-hdr';
    hdr.innerHTML = '<span>処方セット編集</span>';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:18px;cursor:pointer';
    closeBtn.onclick = function() { cleanupDropdowns(); overlay.remove(); };
    hdr.appendChild(closeBtn);
    dlg.appendChild(hdr);

    var body = document.createElement('div');
    body.className = 'mt-dlg-body';

    var selWrap = document.createElement('div');
    selWrap.style.cssText = 'margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';

    var sel = document.createElement('select');
    sel.style.cssText = 'display:block!important;opacity:1!important;position:static!important;height:32px!important;pointer-events:auto!important;appearance:auto!important;-webkit-appearance:auto!important;padding:4px 8px;font-size:13px;border:1px solid #ccc;border-radius:4px;flex:1;min-width:150px';

    var optNew = document.createElement('option');
    optNew.value = '-1';
    optNew.textContent = '\uFF0B 新しいセットを追加';
    sel.appendChild(optNew);

    sets.forEach(function(s, i) {
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = s.label;
      sel.appendChild(opt);
    });

    if (editIdx >= 0) sel.value = editIdx;
    selWrap.appendChild(sel);

    var delSetBtn = document.createElement('button');
    delSetBtn.textContent = '\uD83D\uDDD1 セット削除';
    delSetBtn.style.cssText = 'padding:4px 10px;border:1px solid #d32f2f;color:#d32f2f;border-radius:4px;cursor:pointer;background:#fff;font-size:12px';
    delSetBtn.onclick = function() {
      var idx = parseInt(sel.value);
      if (idx < 0) return;
      if (confirm(sets[idx].label + ' を削除しますか？')) {
        sets.splice(idx, 1);
        saveSets(sets);
        cleanupDropdowns();
        overlay.remove();
        refreshPanel();
        openEditor();
      }
    };
    selWrap.appendChild(delSetBtn);
    body.appendChild(selWrap);

    var editArea = document.createElement('div');
    editArea.id = 'mt-edit-area';
    body.appendChild(editArea);

    function renderEditArea() {
      editArea.innerHTML = '';
      cleanupDropdowns();
      var idx = parseInt(sel.value);
      var current;
      if (idx < 0) {
        current = { label: '新しいセット', color: '#1976d2', medicines: [] };
      } else {
        current = sets[idx];
      }

      var nameRow = document.createElement('div');
      nameRow.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;align-items:center';

      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = current.label;
      nameInput.placeholder = 'セット名';
      nameInput.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px';
      nameInput.oninput = function() { current.label = nameInput.value; };
      nameRow.appendChild(nameInput);

      var colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = current.color || '#1976d2';
      colorInput.style.cssText = 'width:40px;height:32px;border:1px solid #ccc;border-radius:4px;cursor:pointer';
      colorInput.oninput = function() { current.color = colorInput.value; };
      nameRow.appendChild(colorInput);
      editArea.appendChild(nameRow);

      var medsContainer = document.createElement('div');
      medsContainer.id = 'mt-meds-container';

      current.medicines.forEach(function(med) {
        medsContainer.appendChild(buildMedRow(med, current));
      });
      editArea.appendChild(medsContainer);

      var addBtn = document.createElement('button');
      addBtn.textContent = '\uFF0B 薬剤追加';
      addBtn.style.cssText = 'margin-top:6px;padding:6px 12px;border:1px solid #1976d2;color:#1976d2;border-radius:4px;cursor:pointer;background:#fff;font-size:12px';
      addBtn.onclick = function() {
        var newMed = { searchText: '', dose: '1', administration: '', numOfDays: '28', dosageForm: '通常', denyGeneric: false, excludePublicInsurance: false, odp: false, comment: '' };
        current.medicines.push(newMed);
        medsContainer.appendChild(buildMedRow(newMed, current));
      };
      editArea.appendChild(addBtn);

      editArea._current = current;
      editArea._idx = idx;
    }

    sel.onchange = renderEditArea;
    renderEditArea();
    dlg.appendChild(body);

    var foot = document.createElement('div');
    foot.className = 'mt-dlg-foot';

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.onclick = function() { cleanupDropdowns(); overlay.remove(); };
    foot.appendChild(cancelBtn);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'save';
    saveBtn.textContent = '保存';
    saveBtn.onclick = function() {
      var cur = editArea._current;
      var idx = editArea._idx;
      if (idx < 0) {
        sets.push(cur);
      } else {
        sets[idx] = cur;
      }
      saveSets(sets);
      cleanupDropdowns();
      overlay.remove();
      refreshPanel();
    };
    foot.appendChild(saveBtn);
    dlg.appendChild(foot);

    overlay.appendChild(dlg);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) { cleanupDropdowns(); overlay.remove(); }
    });
  });
}
/* ============ 薬剤行ビルダー ============ */
function buildMedRow(med, setObj) {
  var row = document.createElement('div');
  row.className = 'mt-row';

  var ctrlWrap = document.createElement('div');
  ctrlWrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-right:4px;align-items:center';

  var dragHandle = document.createElement('span');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '\u2630';
  dragHandle.title = 'ドラッグで並べ替え';
  ctrlWrap.appendChild(dragHandle);

  var del = document.createElement('button');
  del.className = 'del-btn';
  del.textContent = '\u2715';
  del.title = '削除';
  del.style.cssText = 'color:#d32f2f;cursor:pointer;font-size:13px;padding:1px 5px;border:none;background:none;line-height:1';
  del.onclick = function() {
    var mi = setObj.medicines.indexOf(med);
    if (mi >= 0) setObj.medicines.splice(mi, 1);
    row.remove();
  };
  ctrlWrap.appendChild(del);

  row.appendChild(ctrlWrap);

  /* ---- ドラッグ＆ドロップ ---- */
  row.draggable = true;
  row._med = med;
  row._setObj = setObj;

  row.addEventListener('dragstart', function(e) {
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    row.parentNode._dragSrc = row;
  });

  row.addEventListener('dragend', function() {
    row.classList.remove('dragging');
    var container = row.parentNode;
    if (container) {
      Array.from(container.querySelectorAll('.mt-row')).forEach(function(r) {
        r.classList.remove('drag-over');
      });
    }
  });

  row.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var container = row.parentNode;
    Array.from(container.querySelectorAll('.mt-row')).forEach(function(r) {
      r.classList.remove('drag-over');
    });
    if (container._dragSrc !== row) {
      row.classList.add('drag-over');
    }
  });

  row.addEventListener('dragleave', function() {
    row.classList.remove('drag-over');
  });

  row.addEventListener('drop', function(e) {
    e.preventDefault();
    row.classList.remove('drag-over');
    var container = row.parentNode;
    var srcRow = container._dragSrc;
    if (!srcRow || srcRow === row) return;

    var srcMed = srcRow._med;
    var meds = setObj.medicines;
    var srcIdx = meds.indexOf(srcMed);
    var destIdx = meds.indexOf(med);
    if (srcIdx < 0 || destIdx < 0) return;

    /* データ配列の並べ替え */
    meds.splice(srcIdx, 1);
    meds.splice(destIdx, 0, srcMed);

    /* DOM の並べ替え */
    container.insertBefore(srcRow, row);
    container._dragSrc = null;
  });

  var searchWrap = document.createElement('div');
  searchWrap.className = 'mt-search-wrap';
  searchWrap.style.cssText = 'flex:1;min-width:200px';
  var lbl1 = document.createElement('label');
  lbl1.textContent = '薬剤名';
  searchWrap.appendChild(lbl1);
  var searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.value = med.searchText || '';
  searchInput.placeholder = '薬剤検索...';
  searchInput.style.cssText = 'width:100%;padding:4px 6px;font-size:12px;border:1px solid #ccc;border-radius:3px';
  searchWrap.appendChild(searchInput);

  var searchTimer = null;
  var ddEl = null;

  function removeDD() { if (ddEl) { ddEl.remove(); ddEl = null; } }

  function showSearchDD(list, anchor, onSelect) {
    removeDD();
    if (!list || !list.length) return;
    ddEl = document.createElement('div');
    ddEl.className = 'mt-search-dd';
    var rect = anchor.getBoundingClientRect();
    ddEl.style.left = rect.left + 'px';
    ddEl.style.top = (rect.bottom + 2) + 'px';
    ddEl.style.minWidth = rect.width + 'px';
    list.slice(0, 20).forEach(function(item) {
      var opt = document.createElement('div');
      opt.textContent = item.name || item.medicineName;
      opt.onclick = function() { onSelect(item); };
      ddEl.appendChild(opt);
    });
    document.body.appendChild(ddEl);
  }

  searchInput.oninput = function() {
    med.searchText = searchInput.value;
    clearTimeout(searchTimer);
    if (searchInput.value.length < 2) { removeDD(); return; }
    searchTimer = setTimeout(function() {
      try {
        var ctx = getAngularContext();
        if (!ctx) return;
        ctx.OrderingService.searchMedicine(searchInput.value).then(function(res) {
          var list = null;
          if (res && res.data && res.data.content) list = res.data.content;
          else if (res && res.data && Array.isArray(res.data)) list = res.data;
          else if (Array.isArray(res)) list = res;
          showSearchDD(list, searchInput, function(item) {
            med.searchText = item.name || item.medicineName;
            searchInput.value = med.searchText;
            removeDD();
          });
        });
      } catch(e) {}
    }, 300);
  };
  searchInput.addEventListener('blur', function() { setTimeout(removeDD, 200); });
  row.appendChild(searchWrap);

  var doseWrap = document.createElement('div');
  doseWrap.style.cssText = 'min-width:55px';
  var lbl2 = document.createElement('label');
  lbl2.textContent = '用量';
  doseWrap.appendChild(lbl2);
  var doseInput = document.createElement('input');
  doseInput.type = 'text';
  doseInput.value = med.dose || '1';
  doseInput.style.cssText = 'width:50px';
  doseInput.oninput = function() { med.dose = doseInput.value; };
  doseWrap.appendChild(doseInput);
  row.appendChild(doseWrap);

  var adminWrap = document.createElement('div');
  adminWrap.className = 'mt-search-wrap';
  adminWrap.style.cssText = 'min-width:160px;flex:1';
  var lbl3 = document.createElement('label');
  lbl3.textContent = '用法';
  adminWrap.appendChild(lbl3);
  var adminInput = document.createElement('input');
  adminInput.type = 'text';
  adminInput.value = med.administration || '';
  adminInput.placeholder = '用法を選択または検索...';
  adminInput.style.cssText = 'width:100%;padding:4px 6px;font-size:12px;border:1px solid #ccc;border-radius:3px';
  adminWrap.appendChild(adminInput);

  var adminDD = null;
  function removeAdminDD() { if (adminDD) { adminDD.remove(); adminDD = null; } }

  function showAdminDD() {
    removeAdminDD();
    try {
      var ctx = getAngularContext();
      if (!ctx || !ctx.OrderingService) return;

      var buildDD = function(types) {
        if (!types || !types.length) return;
        adminDD = document.createElement('div');
        adminDD.className = 'mt-admin-dd';
        var rect = adminInput.getBoundingClientRect();
        adminDD.style.left = rect.left + 'px';
        adminDD.style.top = (rect.bottom + 2) + 'px';
        adminDD.style.minWidth = Math.max(rect.width, 280) + 'px';

        var q = adminInput.value ? adminInput.value.toLowerCase() : '';

        types.forEach(function(cat) {
          if (!cat.medicineAdministrations || !cat.medicineAdministrations.length) return;

          var filteredItems = cat.medicineAdministrations;
          if (q) {
            filteredItems = cat.medicineAdministrations.filter(function(a) {
              return (a.name || '').toLowerCase().indexOf(q) >= 0;
            });
          }
          if (!filteredItems.length) return;

          var catHeader = document.createElement('div');
          catHeader.className = 'mt-admin-cat';
          catHeader.textContent = cat.name + ' (' + filteredItems.length + ')';
          adminDD.appendChild(catHeader);

          filteredItems.forEach(function(a) {
            var item = document.createElement('div');
            item.className = 'mt-admin-item';
            item.textContent = a.name;
            item.onclick = function() {
              med.administration = a.name;
              adminInput.value = a.name;
              removeAdminDD();
            };
            adminDD.appendChild(item);
          });
        });

        if (adminDD.children.length > 0) {
          document.body.appendChild(adminDD);
        }
      };

      if (cachedAdminTypes) {
        buildDD(cachedAdminTypes);
      } else {
        loadAdminTypes(ctx.OrderingService).then(buildDD);
      }
    } catch(e) {
      console.error('showAdminDD error:', e);
    }
  }

  adminInput.onfocus = function() { showAdminDD(); };
  adminInput.oninput = function() {
    med.administration = adminInput.value;
    showAdminDD();
  };
  adminInput.addEventListener('blur', function() { setTimeout(removeAdminDD, 200); });
  row.appendChild(adminWrap);

  var daysWrap = document.createElement('div');
  daysWrap.style.cssText = 'min-width:55px';
  var lbl4 = document.createElement('label');
  lbl4.textContent = '日数';
  daysWrap.appendChild(lbl4);
  var daysInput = document.createElement('input');
  daysInput.type = 'text';
  daysInput.value = med.numOfDays || '28';
  daysInput.style.cssText = 'width:50px';
  daysInput.oninput = function() { med.numOfDays = daysInput.value; };
  daysWrap.appendChild(daysInput);
  row.appendChild(daysWrap);

  var br = document.createElement('div');
  br.style.cssText = 'width:100%;height:0';
  row.appendChild(br);

  var dfWrap = document.createElement('div');
  dfWrap.style.cssText = 'min-width:70px';
  var lbl5 = document.createElement('label');
  lbl5.textContent = '形状';
  dfWrap.appendChild(lbl5);
  var dfSel = document.createElement('select');
  ['通常','粉砕','溶解','ヒート'].forEach(function(v) {
    var opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    if (med.dosageForm === v) opt.selected = true;
    dfSel.appendChild(opt);
  });
  dfSel.onchange = function() { med.dosageForm = dfSel.value; };
  dfWrap.appendChild(dfSel);
  row.appendChild(dfWrap);

  function mkChk(label, key) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:2px';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!med[key];
    cb.onchange = function() { med[key] = cb.checked; };
    wrap.appendChild(cb);
    var lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.style.cssText = 'font-size:11px;cursor:pointer';
    lbl.onclick = function() { cb.checked = !cb.checked; med[key] = cb.checked; };
    wrap.appendChild(lbl);
    return wrap;
  }

  row.appendChild(mkChk('後発不可', 'denyGeneric'));
  row.appendChild(mkChk('公費対象外', 'excludePublicInsurance'));
  row.appendChild(mkChk('一包化', 'odp'));

  var cmtWrap = document.createElement('div');
  cmtWrap.style.cssText = 'min-width:120px;flex:1';
  var lbl6 = document.createElement('label');
  lbl6.textContent = 'コメント';
  cmtWrap.appendChild(lbl6);
  var cmtInput = document.createElement('input');
  cmtInput.type = 'text';
  cmtInput.value = med.comment || '';
  cmtInput.placeholder = 'コメント';
  cmtInput.style.cssText = 'width:100%;padding:4px 6px;font-size:12px;border:1px solid #ccc;border-radius:3px';
  cmtInput.oninput = function() { med.comment = cmtInput.value; };
  cmtWrap.appendChild(cmtInput);
  row.appendChild(cmtWrap);

  return row;
}

/* ============ 初期化 ============ */
function init() {
  if (popupActive) return;
  if (document.getElementById('mt-panel')) return;
  preloadAdminTypes();
  getSets(function(sets) {
    if (!document.getElementById('mt-panel') && !popupActive) {
      createPanel(document.body, sets);
    }
  });
}

var lastUrl = '';
var observer = new MutationObserver(function() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(function() {
      if (popupActive) return;
      if (!document.getElementById('mt-panel')) {
        init();
      }
    }, 1000);
  }
});
observer.observe(document.body, { childList: true, subtree: true });

if (document.readyState === 'complete') {
  setTimeout(init, 1500);
} else {
  window.addEventListener('load', function() { setTimeout(init, 1500); });
}

})();
