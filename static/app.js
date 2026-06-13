const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const ls = {
  get(k, d) { try { const v = localStorage.getItem('ac_' + k); return v !== null ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ac_' + k, JSON.stringify(v)); } catch {} }
};

let channels = [];
let hls = null;
let currentHash = null;
let currentChannel = null;
let failoverTimer = null;
let idleTimer = null;
let currentUser = null;
let isAdmin = false;
let favorites = new Set(ls.get('favs', []));
let deadChannels = new Set();

function saveFavs() { ls.set('favs', [...favorites]); }
function toggleFav(chId) {
  if (favorites.has(chId)) favorites.delete(chId); else favorites.add(chId);
  saveFavs();
  renderCurrent();
}
function renderCurrent() {
  renderChannels($('#search').value
    ? channels.filter(c => c.name.toLowerCase().includes($('#search').value.toLowerCase()) || (c.group && c.group.toLowerCase().includes($('#search').value.toLowerCase())))
    : channels);
}

function checkAuth() {
  fetch('/api/me')
    .then(r => {
      if (r.status === 401) {
        $('#login-overlay').classList.remove('hidden');
        $('.app-content').classList.add('hidden');
        return null;
      }
      return r.json();
    })
    .then(data => {
      if (!data) return;
      currentUser = data.user;
      isAdmin = data.is_admin;
      $('#login-overlay').classList.add('hidden');
      $('.app-content').classList.remove('hidden');
      $('#user-span').textContent = currentUser;
      $('#admin-btn-wrap').style.display = isAdmin ? '' : 'none';
      $('#logout-btn-wrap').style.display = '';
      initApp();
    })
    .catch(() => {
      $('#login-overlay').classList.remove('hidden');
      $('.app-content').classList.add('hidden');
    });
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('#login-form .login-btn');
  const error = $('#login-error');
  btn.disabled = true;
  btn.textContent = 'Iniciando sesión...';
  error.style.display = 'none';
  fetch('/api/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      username: $('#login-user').value,
      password: $('#login-pass').value,
    })
  })
    .then(r => r.json().then(d => ({status: r.status, body: d})))
    .then(({status, body}) => {
      if (status === 200) {
        checkAuth();
      } else {
        error.textContent = body.error || 'Error al iniciar sesión';
        error.style.display = 'block';
      }
    })
    .catch(() => {
      error.textContent = 'Error de conexión';
      error.style.display = 'block';
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Iniciar sesión';
    });
});

$('#login-user').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#login-pass').focus();
});
$('#login-pass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#login-form').dispatchEvent(new Event('submit'));
});

$('#logout-btn').addEventListener('click', () => {
  fetch('/api/logout', {method: 'POST'})
    .then(() => { location.reload(); })
    .catch(() => { location.reload(); });
});

$('#admin-btn').addEventListener('click', () => {
  $('#admin-panel').classList.add('open');
  loadAdminUsers();
  loadAdminActive();
});
$('#admin-panel .modal-close').addEventListener('click', () => {
  $('#admin-panel').classList.remove('open');
});
$('#admin-panel').addEventListener('click', (e) => {
  if (e.target === $('#admin-panel')) $('#admin-panel').classList.remove('open');
});

function loadAdminUsers() {
  const container = $('#admin-users');
  container.innerHTML = '<h3>Usuarios</h3>';
  fetch('/api/admin/users')
    .then(r => r.json())
    .then(users => {
      if (!users.length) {
        container.innerHTML += '<div class="admin-empty">No hay usuarios creados</div>';
        return;
      }
      users.forEach(u => {
        if (u.username === 'admin') {
          container.innerHTML += '<div class="admin-user-row"><span>' + u.username + '</span><span style="color:#52526e;font-size:11px;">built-in</span></div>';
        } else {
          container.innerHTML += '<div class="admin-user-row"><span>' + u.username + '</span><button class="admin-del-btn" data-user="' + u.username + '">Delete</button></div>';
        }
      });
      container.querySelectorAll('.admin-del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          fetch('/api/admin/users/' + encodeURIComponent(btn.dataset.user), {method: 'DELETE'})
            .then(r => r.json())
            .then(() => { loadAdminUsers(); })
            .catch(() => {});
        });
      });
    })
    .catch(() => {
      container.innerHTML += '<div class="admin-empty">Error al cargar</div>';
    });
  container.innerHTML += '<div class="admin-create-row">' +
    '<input id="new-user-input" placeholder="Usuario">' +
    '<input id="new-pass-input" type="password" placeholder="Contraseña">' +
    '<button id="create-user-btn">Crear</button></div>';
  setTimeout(() => {
    $('#create-user-btn').addEventListener('click', () => {
      const u = $('#new-user-input').value.trim();
      const p = $('#new-pass-input').value;
      const msg = $('#admin-msg');
      if (!u || !p) { msg.textContent = 'Completa todos los campos'; msg.className = 'admin-msg err'; return; }
      fetch('/api/admin/users', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({username: u, password: p})
      })
        .then(r => r.json().then(d => ({status: r.status, body: d})))
        .then(({status, body}) => {
          if (status === 200) {
            msg.textContent = 'Usuario creado'; msg.className = 'admin-msg ok';
            $('#new-user-input').value = ''; $('#new-pass-input').value = '';
            loadAdminUsers();
          } else {
            msg.textContent = body.error || 'Error'; msg.className = 'admin-msg err';
          }
        })
        .catch(() => { msg.textContent = 'Error'; msg.className = 'admin-msg err'; });
    });
  }, 50);
}

function loadAdminActive() {
  const container = $('#admin-active');
  container.innerHTML = '<h3>Connected Viewers</h3>';
  fetch('/api/admin/active')
    .then(r => r.json())
    .then(list => {
      if (!list.length) {
        container.innerHTML += '<div class="admin-empty">No hay usuarios conectados</div>';
        return;
      }
      list.forEach(v => {
        const ago = Math.floor((Date.now() / 1000 - v.last_seen) / 60);
        const timeStr = ago < 1 ? 'Ahora' : 'Hace ' + ago + ' min';
        container.innerHTML += '<div class="admin-active-item">' +
          '<span class="aa-user">' + v.user + '</span>' +
          '<span class="aa-channel">' + (v.channel || '—') + '</span>' +
          '<span class="aa-time">' + timeStr + '</span></div>';
      });
    })
    .catch(() => {
      container.innerHTML += '<div class="admin-empty">Error al cargar</div>';
    });
}

function extractQuality(title) {
  const m = title.match(/\d+p|4K|HD|FHD|UHD/i);
  return m ? m[0] : 'HD';
}

function renderChannels(chs) {
  const favIds = new Set([...favorites].filter(id => chs.some(c => c.id === id)));
  const favChs = chs.filter(c => favIds.has(c.id));
  const otherChs = chs.filter(c => !favIds.has(c.id));
  const groups = {};
  otherChs.forEach(c => {
    const g = c.group || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(c);
  });
  const sidebar = $('#sidebar');
  sidebar.innerHTML = '';
  if (favChs.length) {
    const div = document.createElement('div');
    div.className = 'group';
    div.innerHTML = '<div class="group-title">⭐ Favoritos</div>';
    favChs.forEach(ch => renderChannelItem(div, ch));
    sidebar.appendChild(div);
  }
  Object.entries(groups).sort((a,b) => a[0].localeCompare(b[0])).forEach(([g, chList]) => {
    const div = document.createElement('div');
    div.className = 'group';
    div.innerHTML = '<div class="group-title">' + g + '</div>';
    chList.forEach(ch => renderChannelItem(div, ch));
    sidebar.appendChild(div);
  });
}
function renderChannelItem(container, ch) {
  const item = document.createElement('div');
  const isDead = deadChannels.has(ch.id);
  item.className = 'channel' + (currentChannel && currentChannel.id === ch.id ? ' active' : '') + (isDead ? ' dead' : '');
  item.dataset.id = ch.id;
  const isFav = favorites.has(ch.id);
  let html = '<div class="channel-row">';
  html += '<span class="channel-fav' + (isFav ? ' is-fav' : '') + '" data-fav="1">' + (isFav ? '★' : '☆') + '</span>';
  if (ch.logo) html += '<img class="channel-logo" src="' + ch.logo + '" alt="" onerror="this.style.display=\'none\'">';
  html += '<div class="channel-indicator"></div>';
  html += '<div class="channel-info"><div class="channel-name">' + ch.name + '</div>';
  if (ch.epg_now) {
    html += '<div class="channel-epg has-epg" data-epg="1">Ahora: ' + ch.epg_now.title + '</div>';
  } else {
    html += '<div class="channel-epg">Sin guía</div>';
  }
  if (ch.variants && ch.variants.length > 1) {
    html += '<div class="channel-variants">';
    ch.variants.forEach((v, idx) => {
      const active = currentChannel && currentChannel.id === ch.id && currentHash === v.hash;
      html += '<span class="variant-chip' + (active ? ' active' : '') + '" data-idx="' + idx + '">' + extractQuality(v.title) + '</span>';
    });
    html += '</div>';
  }
  html += '</div></div>';
  item.innerHTML = html;
  item.addEventListener('click', (e) => {
    if (e.target.closest('.variant-chip')) return;
    if (e.target.closest('.channel-epg[data-epg]')) return;
    if (e.target.closest('.channel-fav')) return;
    closeSidebar();
    playHash(ch.id, ch.variants[0].hash);
  });
  item.querySelector('.channel-fav').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(ch.id);
  });
  item.querySelectorAll('.variant-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSidebar();
      playHash(ch.id, ch.variants[parseInt(chip.dataset.idx)].hash);
    });
  });
  const epgEl = item.querySelector('.channel-epg[data-epg]');
  if (epgEl) {
    epgEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openEPG(ch.id);
    });
  }
  container.appendChild(item);
}

function closeSidebar() {
  $('.sidebar-outer').classList.remove('open');
  $('.sidebar-backdrop').classList.remove('open');
}

$('.menu-btn').addEventListener('click', () => {
  $('.sidebar-outer').classList.toggle('open');
  $('.sidebar-backdrop').classList.toggle('open');
});
$('.sidebar-backdrop').addEventListener('click', closeSidebar);

$('#search').addEventListener('input', () => {
  const q = $('#search').value.toLowerCase();
  const filtered = q ? channels.filter(c =>
    c.name.toLowerCase().includes(q) || (c.group && c.group.toLowerCase().includes(q))
  ) : channels;
  renderChannels(filtered);
});

$('.refresh-btn').addEventListener('click', function() {
  this.disabled = true;
  this.innerHTML = '<span class="spinner-sm" style="width:14px;height:14px;border-width:2px;"></span> Actualizando...';
  fetch('/api/channels/refresh')
    .then(r => r.json())
    .then(data => {
      channels = data;
      deadChannels.clear();
      renderChannels(channels);
      this.innerHTML = '↻ Actualizar canales';
      this.disabled = false;
    })
    .catch(() => {
      this.innerHTML = '↻ Error';
      this.disabled = false;
    });
});

function setPlayerState(mode, msg, sub) {
  const el = $('.player-state');
  const icon = $('.player-state .state-icon');
  const msgEl = $('.player-state .state-msg');
  const subEl = $('.player-state .state-sub');
  $('.player-placeholder').style.display = 'none';
  $('#player-video').style.display = 'none';
  $('.player-overlay').classList.remove('visible');
  el.style.display = 'flex';
  el.className = 'player-state ' + mode;
  if (mode === 'loading') {
    icon.innerHTML = '<div class="spinner-sm"></div>';
    msgEl.textContent = msg || 'Cargando stream...';
    subEl.textContent = '';
  } else if (mode === 'error') {
    icon.textContent = '⚠';
    msgEl.textContent = msg || 'Error';
    subEl.textContent = sub || 'Prueba con otro canal';
  } else {
    el.style.display = 'none';
  }
}

function playHash(channelId, hash) {
  const ch = channels.find(c => c.id === channelId);
  if (!ch) return;
  if (currentHash === hash) return;
  currentHash = hash;
  currentChannel = ch;

  const variant = ch.variants.find(v => v.hash === hash) || ch.variants[0];
  const qual = extractQuality(variant.title);
  $('#np-name').textContent = ch.name + (qual ? ' — ' + qual : '');
  $('.now-playing').style.display = 'none';

  const startIdx = ch.variants.findIndex(v => v.hash === hash);
  tryVariant(ch, startIdx >= 0 ? startIdx : 0);
}

function tryVariant(ch, variantIdx) {
  if (variantIdx >= ch.variants.length) {
    deadChannels.add(ch.id);
    renderCurrent();
    setPlayerState('error', 'No se pudo cargar',
      'Probamos todas las calidades sin éxito. El canal puede estar caído.');
    return;
  }
  deadChannels.delete(ch.id);

  const video = $('#player-video');
  const hash = ch.variants[variantIdx].hash;
  const qual = extractQuality(ch.variants[variantIdx].title);

  if (hls) { hls.destroy(); hls = null; }
  video.style.display = 'none';
  $('.player-overlay').classList.remove('visible');
  $('.now-playing').style.display = 'none';
  clearTimeout(idleTimer);
  $('.player-wrapper').classList.remove('idle', 'controls-shown');

  currentHash = hash;
  setPlayerState('loading', 'Probando ' + qual + '...');

  if (failoverTimer) clearTimeout(failoverTimer);
  failoverTimer = setTimeout(() => {
    failoverTimer = null;
    tryVariant(ch, variantIdx + 1);
  }, 20000);

  fetch('/api/probe?hash=' + hash)
    .then(r => r.json())
    .then(probe => {
      if (probe.status !== 'ok') {
        if (failoverTimer) { clearTimeout(failoverTimer); failoverTimer = null; }
        tryVariant(ch, variantIdx + 1);
        return;
      }
      startPlayback(ch, variantIdx);
    })
    .catch(() => {
      if (failoverTimer) { clearTimeout(failoverTimer); failoverTimer = null; }
      tryVariant(ch, variantIdx + 1);
    });
}

function startPlayback(ch, variantIdx) {
  const video = $('#player-video');
  const hash = ch.variants[variantIdx].hash;
  const qual = extractQuality(ch.variants[variantIdx].title);

  setPlayerState('loading', 'Conectando... ' + qual);

  if (failoverTimer) clearTimeout(failoverTimer);
  failoverTimer = setTimeout(() => {
    failoverTimer = null;
    tryVariant(ch, variantIdx + 1);
  }, 20000);

  fetch('/api/play?hash=' + hash)
    .then(r => r.json())
    .then(data => {
      renderChannels(channels);

      if (Hls.isSupported()) {
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          fragLoadingTimeOut: 30000,
          manifestLoadingTimeOut: 30000,
        });
        hls.loadSource(data.url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (failoverTimer) { clearTimeout(failoverTimer); failoverTimer = null; }
          video.style.display = 'block';
          $('.player-overlay').classList.add('visible');
          $('.player-placeholder').style.display = 'none';
          $('.player-state').style.display = 'none';
          $('.now-playing').style.display = 'flex';
          resetIdleTimer();
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.ERROR, (_, ev) => {
          if (ev.fatal) {
            if (failoverTimer) { clearTimeout(failoverTimer); failoverTimer = null; }
            $('.player-overlay').classList.remove('visible');
            tryVariant(ch, variantIdx + 1);
          }
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => { buildAudioMenu(); });
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => { buildAudioMenu(); });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = data.url;
        video.style.display = 'block';
        $('.player-overlay').classList.add('visible');
        $('.player-placeholder').style.display = 'none';
        $('.player-state').style.display = 'none';
        $('.now-playing').style.display = 'flex';
        resetIdleTimer();
        video.addEventListener('loadedmetadata', () => {
          if (failoverTimer) { clearTimeout(failoverTimer); failoverTimer = null; }
          video.play().catch(() => {});
        }, { once: true });
        video.addEventListener('error', () => {
          if (failoverTimer) { clearTimeout(failoverTimer); failoverTimer = null; }
          $('.player-overlay').classList.remove('visible');
          tryVariant(ch, variantIdx + 1);
        });
      } else {
        if (failoverTimer) { clearTimeout(failoverTimer); failoverTimer = null; }
        setPlayerState('error', 'Tu navegador no soporta HLS', 'Probá con Chrome, Firefox o Edge.');
      }
    })
    .catch(() => {
      if (failoverTimer) { clearTimeout(failoverTimer); failoverTimer = null; }
      $('.player-overlay').classList.remove('visible');
      tryVariant(ch, variantIdx + 1);
    });
}

function openEPG(channelId) {
  const ch = channels.find(c => c.id === channelId);
  if (!ch) return;
  $('#epg-modal-title').textContent = ch.name;
  const logo = $('#epg-modal-logo');
  if (ch.logo) { logo.src = ch.logo; logo.style.display = ''; }
  else { logo.style.display = 'none'; }
  $('#epg-modal-body').innerHTML = '<div class="epg-loading">Cargando guía...</div>';
  $('#epg-modal').classList.add('open');

  fetch('/api/epg/guide?channel=' + channelId)
    .then(r => r.json())
    .then(data => {
      if (!data.programmes || data.programmes.length === 0) {
        $('#epg-modal-body').innerHTML = '<div class="epg-loading" style="color:#52526e">No hay guía disponible</div>';
        return;
      }
      let html = '';
      data.programmes.forEach(p => {
        const cls = p.is_now ? 'epg-entry is-now' : 'epg-entry';
        const timeStr = formatEPGTime(p.start) + ' - ' + shortEPGTime(p.stop);
        const nowLabel = p.is_now ? ' <span style="color:#22c55e;font-size:10px">&#9679; EN VIVO</span>' : '';
        html += '<div class="' + cls + '">';
        html += '<div class="epg-time">' + timeStr + nowLabel + '</div>';
        html += '<div class="epg-title">' + esc(p.title || 'Sin título') + '</div>';
        if (p.desc) {
          html += '<div class="epg-desc">' + esc(p.desc) + '</div>';
          html += '<button class="epg-desc-toggle" onclick="var d=this.previousElementSibling;d.classList.toggle(\'open\');this.textContent=d.classList.contains(\'open\')?\'less\':\'more\'">more</button>';
        }
        html += '</div>';
      });
      $('#epg-modal-body').innerHTML = html;
    })
    .catch(() => {
      $('#epg-modal-body').innerHTML = '<div class="epg-loading" style="color:#f87171">Error al cargar la guía</div>';
    });
}

function formatEPGTime(timestr) {
  const m = timestr.match(/\d{14}/);
  if (!m) return timestr;
  const s = m[0];
  return s.substring(6, 8) + '/' + s.substring(4, 6) + ' ' + s.substring(8, 10) + ':' + s.substring(10, 12);
}
function shortEPGTime(timestr) {
  const m = timestr.match(/\d{14}/);
  if (!m) return timestr;
  return m[0].substring(8, 10) + ':' + m[0].substring(10, 12);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

$('#epg-modal .modal-close').addEventListener('click', () => {
  $('#epg-modal').classList.remove('open');
});
$('#epg-modal').addEventListener('click', (e) => {
  if (e.target === $('#epg-modal')) $('#epg-modal').classList.remove('open');
});

// ---- playback controls ----
function initControls() {
  const v = $('#player-video');
  const pw = $('.player-wrapper');

  $('.play-toggle').addEventListener('click', () => {
    if (v.paused) v.play().catch(() => {}); else v.pause();
  });
  v.addEventListener('play', () => {
    $('.play-toggle').textContent = '⏸';
    resetIdleTimer();
  });
  v.addEventListener('pause', () => {
    $('.play-toggle').textContent = '▶';
    showControlsNow();
  });
  v.addEventListener('timeupdate', () => {
    if (!v.duration) return;
    const pct = (v.currentTime / v.duration) * 100;
    $('.progress-fill').style.width = pct + '%';
    $('.time-current').textContent = formatTime(v.currentTime);
  });
  v.addEventListener('loadedmetadata', () => {
    $('.time-duration').textContent = formatTime(v.duration);
  });
  v.addEventListener('durationchange', () => {
    $('.time-duration').textContent = formatTime(v.duration);
  });

  $('.progress-wrap').addEventListener('click', (e) => {
    if (!v.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const target = ((e.clientX - rect.left) / rect.width) * v.duration;
    v.currentTime = Math.min(target, v.duration - 1);
  });

  const volumeRange = $('.volume-slider input');
  $('.mute-toggle').addEventListener('click', () => {
    v.muted = !v.muted;
    updateVolumeUI();
  });
  volumeRange.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    v.muted = val === 0;
    v.volume = val;
    updateVolumeUI();
  });

  $('.live-btn').addEventListener('click', () => {
    if (hls && hls.liveSyncPosition) {
      v.currentTime = hls.liveSyncPosition;
    } else {
      v.currentTime = v.duration || 1e10;
    }
  });
  function updateLiveBtn() {
    const liveBtn = $('.live-btn');
    if (!v.duration) return;
    const atLive = v.duration - v.currentTime < 5;
    liveBtn.classList.toggle('at-live', atLive);
  }
  v.addEventListener('timeupdate', updateLiveBtn);
  v.addEventListener('seeked', updateLiveBtn);
  v.addEventListener('loadedmetadata', updateLiveBtn);

  $('.full-btn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else pw.requestFullscreen();
  });

  $('.pip-btn').addEventListener('click', () => {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      v.requestPictureInPicture().catch(() => {});
    }
  });
  v.addEventListener('enterpictureinpicture', () => {
    $('.pip-btn').textContent = '⛶';
  });
  v.addEventListener('leavepictureinpicture', () => {
    $('.pip-btn').textContent = '📌';
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (v.paused) v.play().catch(() => {}); else v.pause();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
        break;
      case 'ArrowUp':
        e.preventDefault();
        v.volume = Math.min(1, v.volume + 0.1);
        updateVolumeUI();
        break;
      case 'ArrowDown':
        e.preventDefault();
        v.volume = Math.max(0, v.volume - 0.1);
        updateVolumeUI();
        break;
      case 'm':
      case 'M':
        v.muted = !v.muted;
        updateVolumeUI();
        break;
      case 'f':
      case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else pw.requestFullscreen();
        break;
    }
  });

  pw.addEventListener('mousemove', resetIdleTimer);
  pw.addEventListener('touchstart', resetIdleTimer);
}

function formatTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function updateVolumeUI() {
  const v = $('#player-video');
  const icon = $('.mute-toggle');
  if (v.muted || v.volume === 0) icon.textContent = '🔇';
  else if (v.volume < 0.5) icon.textContent = '🔉';
  else icon.textContent = '🔊';
  $('.volume-slider input').value = v.muted ? 0 : v.volume;
}

function showControlsNow() {
  const pw = $('.player-wrapper');
  pw.classList.remove('idle');
  $('.player-overlay').classList.add('visible');
  clearTimeout(idleTimer);
}
function hideControlsLater() {
  const v = $('#player-video');
  if (v.paused) return;
  $('.player-wrapper').classList.add('idle');
  $('.player-overlay').classList.remove('visible');
}
function resetIdleTimer() {
  showControlsNow();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(hideControlsLater, 3000);
}

function buildAudioMenu() {
  const btn = $('.audio-btn .ctrl-btn');
  const menu = $('.audio-menu');
  const label = $('.audio-label');
  const hasMulti = hls && hls.audioTracks && hls.audioTracks.length > 1;
  btn.disabled = !hasMulti;
  btn.style.opacity = hasMulti ? '1' : '.35';
  if (!hasMulti) {
    menu.classList.remove('open');
    label.textContent = '1';
    return;
  }
  menu.innerHTML = '';
  hls.audioTracks.forEach((t, idx) => {
    const item = document.createElement('div');
    item.className = 'audio-menu-item' + (idx === hls.audioTrack ? ' active' : '');
    item.textContent = t.name || t.lang || 'Track ' + (idx + 1);
    item.addEventListener('click', () => {
      hls.audioTrack = idx;
      menu.classList.remove('open');
    });
    menu.appendChild(item);
  });
  const activeIdx = hls.audioTrack;
  label.textContent = (hls.audioTracks[activeIdx] && hls.audioTracks[activeIdx].name) || (activeIdx + 1);
}

$('.audio-btn .ctrl-btn').addEventListener('click', (e) => {
  if ($('.audio-btn .ctrl-btn').disabled) return;
  e.stopPropagation();
  $('.audio-menu').classList.toggle('open');
});
document.addEventListener('click', () => {
  $('.audio-menu').classList.remove('open');
});

function initApp() {
  initControls();
  fetch('/api/channels')
    .then(r => r.json())
    .then(data => {
      channels = data;
      fetch('/api/epg/now')
        .then(r => r.json())
        .then(epgNow => {
          channels.forEach(ch => {
            if (epgNow[ch.id]) ch.epg_now = epgNow[ch.id];
          });
          renderChannels(channels);
        })
        .catch(() => { renderChannels(channels); });
    })
    .catch(() => {
      $('#sidebar').innerHTML = '<p style="color:#666;padding:16px">Error al cargar canales</p>';
    });
}

document.addEventListener('DOMContentLoaded', checkAuth);