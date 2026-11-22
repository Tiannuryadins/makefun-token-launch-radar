// Token Launch Radar — dashboard logic. No network, no fetch: every byte the
// page shows comes from window.RADAR, the dataset main.ts wrote beside it.
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R || !Array.isArray(R.rows)) {
    document.getElementById('rows').innerHTML =
      '<tr><td colspan="8">No radar data found. Run main.ts first — it writes data.js beside this page.</td></tr>';
    return;
  }

  var state = {
    q: '',
    cat: '',
    chain: '',
    watchOnly: false,
    sort: 'value',
    selected: null,
    baseMul: null, // null = the board's own model; a number = the sandbox override
    gw: null,
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtUsd(n) {
    if (n == null || !isFinite(n)) return '-';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n == null || !isFinite(n)) return '-';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function pctClass(n) {
    if (n == null || !isFinite(n) || n === 0) return '';
    return n > 0 ? 'up' : 'down';
  }
  function fmtAge(days) {
    if (days == null) return 'unknown';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.round(days / 30) + 'mo';
    return (days / 365).toFixed(1) + 'y';
  }

  // The model's implied value under the sandbox constants, or the board's own.
  function implied(row) {
    if (state.baseMul === null && state.gw === null) return row.implied_value_usd;
    var base = state.baseMul === null ? R.model.base_multiple : state.baseMul;
    var gw = state.gw === null ? R.model.growth_weight : state.gw;
    var growthF = 1 + (row.growth_pct / 100) * gw;
    return Math.max(1, Math.round(row.tvl_usd * base * growthF * row.maturity_multiplier * row.breadth_multiplier));
  }

  function matches(row) {
    if (state.watchOnly && !row.on_watchlist) return false;
    if (state.cat && row.category !== state.cat) return false;
    if (state.chain && row.chains.indexOf(state.chain) === -1) return false;
    if (state.q) {
      var q = state.q.toLowerCase();
      if (row.name.toLowerCase().indexOf(q) === -1 && row.slug.toLowerCase().indexOf(q) === -1) return false;
    }
    return true;
  }

  function viewRows() {
    var rows = R.rows.filter(matches).map(function (r) {
      return { row: r, value: implied(r) };
    });
    var by = state.sort;
    rows.sort(function (a, b) {
      if (by === 'tvl') return b.row.tvl_usd - a.row.tvl_usd;
      if (by === 'growth') return (b.row.change_7d || 0) - (a.row.change_7d || 0);
      if (by === 'age') return (b.row.age_days || 0) - (a.row.age_days || 0);
      if (by === 'name') return a.row.name.localeCompare(b.row.name);
      return b.value - a.value || a.row.slug.localeCompare(b.row.slug);
    });
    return rows;
  }

  function renderStats() {
    var top = R.rows[0];
    $('stats').innerHTML =
      '<div><dt>Board rows</dt><dd>' + R.board_size + '</dd></div>' +
      '<div><dt>Watchlist</dt><dd>' + R.watchlist_size + '</dd></div>' +
      '<div><dt>Early finds</dt><dd>' + R.early_size + '</dd></div>' +
      '<div><dt>Top implied value</dt><dd>' + fmtUsd(top ? top.implied_value_usd : 0) + '</dd></div>';
  }

  function fillSelect(el, values) {
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      el.appendChild(o);
    });
  }

  function renderFilterOptions() {
    var cats = {}, chains = {};
    R.rows.forEach(function (r) {
      if (r.category) cats[r.category] = true;
      r.chains.forEach(function (c) { chains[c] = true; });
    });
    fillSelect($('cat'), Object.keys(cats).sort());
    fillSelect($('chain'), Object.keys(chains).sort());
  }

  function renderBoard() {
    var rows = viewRows();
    var sandbox = state.baseMul !== null || state.gw !== null;
    var html = rows.map(function (item, i) {
      var r = item.row;
      var rank = sandbox ? i + 1 : r.rank;
      var chains = r.chains.slice(0, 3).map(function (c) { return '<span class="pill">' + esc(c) + '</span>'; }).join('');
      var extra = r.chains.length > 3 ? ' <span class="slug">+' + (r.chains.length - 3) + '</span>' : '';
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="selected"' : '') + '>' +
        '<td class="num"><span class="rank">' + rank + '</span>' + (r.on_watchlist ? ' <span class="star" title="On the watchlist">&#9733;</span>' : '') + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span><br><span class="slug">' + esc(r.slug) + '</span></td>' +
        '<td>' + esc(r.category || '-') + '</td>' +
        '<td>' + chains + extra + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num"><strong>' + fmtUsd(item.value) + '</strong></td>' +
        '</tr>';
    }).join('');
    $('rows').innerHTML = html || '<tr><td colspan="8">No protocols match these filters.</td></tr>';
    $('count').textContent = rows.length + ' of ' + R.board_size + ' protocols shown' +
      (sandbox ? ' — re-ranked under your model constants.' : ' — ranked by the board\u2019s model.') +
      ' A star marks a watchlist protocol. Click a row for its detail and farm plan.';
  }

  function renderDetail() {
    var box = $('detail');
    if (!state.selected) { box.hidden = true; box.innerHTML = ''; return; }
    var r = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === state.selected) { r = R.rows[i]; break; }
    if (!r) { box.hidden = true; box.innerHTML = ''; return; }
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    box.innerHTML =
      '<button type="button" class="close" id="detailClose">Close</button>' +
      '<h2>' + esc(r.name) + ' <span class="slug">' + esc(r.slug) + '</span></h2>' +
      '<p class="sub">Rank #' + r.rank + ' of ' + R.board_size +
      (r.on_watchlist ? ' · on the watchlist' : ' · found below the watchlist floor') +
      ' · ' + esc(r.category || 'no category') + ' · ' + esc(r.chains.join(', ') || 'no chain listed') + '</p>' +
      '<dl class="kv">' +
      '<div><dt>Implied value</dt><dd>' + fmtUsd(implied(r)) + '</dd></div>' +
      '<div><dt>TVL</dt><dd>' + fmtUsd(r.tvl_usd) + '</dd></div>' +
      '<div><dt>7-day change</dt><dd class="' + pctClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</dd></div>' +
      '<div><dt>Age with no token</dt><dd>' + fmtAge(r.age_days) + '</dd></div>' +
      '<div><dt>Growth factor</dt><dd>&times;' + r.growth_multiplier.toFixed(2) + '</dd></div>' +
      '<div><dt>Maturity factor</dt><dd>&times;' + r.maturity_multiplier.toFixed(2) + '</dd></div>' +
      '<div><dt>Chain breadth</dt><dd>&times;' + r.breadth_multiplier.toFixed(2) + '</dd></div>' +
      '<div><dt>Token status</dt><dd>records no token</dd></div>' +
      '</dl>' +
      '<h3>How to farm it</h3>' +
      '<ol class="farm">' + steps + '</ol>' +
      '<p class="fine">Each step names its cost and time. The plan follows from the protocol\u2019s own record — its category, chains, size and age.</p>';
    box.hidden = false;
    $('detailClose').addEventListener('click', function () {
      state.selected = null;
      renderBoard();
      renderDetail();
    });
  }

  function formulaText() {
    var m = R.model;
    var base = state.baseMul === null ? m.base_multiple : state.baseMul;
    var gw = state.gw === null ? m.growth_weight : state.gw;
    return 'implied = TVL \u00d7 ' + base.toFixed(2) +
      ' \u00d7 (1 + growth% \u00d7 ' + gw.toFixed(2) + ')' +
      ' \u00d7 maturity(0.70\u20131.00 over ' + m.maturity_days + ' days)' +
      ' \u00d7 breadth(1.00\u20131.12 across chains)';
  }

  function renderModel() {
    $('modelVer').textContent = '(' + R.model_version + ', snapshot ' + R.as_of + ')';
    $('modelFormula').textContent = formulaText();
    var baseEl = $('baseMul'), gwEl = $('gw');
    baseEl.value = state.baseMul === null ? R.model.base_multiple : state.baseMul;
    gwEl.value = state.gw === null ? R.model.growth_weight : state.gw;
    $('baseOut').textContent = '\u00d7' + Number(baseEl.value).toFixed(2);
    $('gwOut').textContent = Number(gwEl.value).toFixed(2);
  }

  function renderLive() {
    $('liveRows').innerHTML = R.live.map(function (p) {
      return '<tr><td><span class="name">' + esc(p.name) + '</span><br><span class="slug">' + esc(p.slug) + '</span></td>' +
        '<td>' + esc(p.category || '-') + '</td>' +
        '<td class="num">' + fmtUsd(p.tvl_usd) + '</td>' +
        '<td class="num">' + fmtUsd(p.mcap_usd) + '</td>' +
        '<td class="num ' + pctClass(p.change_7d) + '">' + fmtPct(p.change_7d) + '</td></tr>';
    }).join('');
  }

  function renderFoot() {
    $('foot').textContent = 'Snapshot ' + R.as_of + ' · ' + R.source +
      ' · watchlist floor ' + fmtUsd(R.floor_usd) + ' · ' + R.board_size + ' board rows.';
  }

  function renderAll() {
    renderStats();
    renderBoard();
    renderDetail();
    renderModel();
  }

  // Wire up controls.
  $('q').addEventListener('input', function (e) { state.q = e.target.value.trim(); renderBoard(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  $('watchOnly').addEventListener('change', function (e) { state.watchOnly = e.target.checked; renderBoard(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    state.selected = tr.getAttribute('data-slug');
    renderBoard();
    renderDetail();
    $('detail').scrollIntoView({ block: 'nearest' });
  });
  $('baseMul').addEventListener('input', function (e) {
    state.baseMul = Number(e.target.value);
    renderModel();
    renderBoard();
  });
  $('gw').addEventListener('input', function (e) {
    state.gw = Number(e.target.value);
    renderModel();
    renderBoard();
  });
  $('modelReset').addEventListener('click', function () {
    state.baseMul = null;
    state.gw = null;
    renderModel();
    renderBoard();
  });

  renderFilterOptions();
  renderLive();
  renderFoot();
  renderAll();
})();
