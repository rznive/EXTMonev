const MONEV_API    = 'https://monev-api.maganghub.kemnaker.go.id';
const MONEV_ORIGIN = 'monev.maganghub.kemnaker.go.id';

const $  = (id) => document.getElementById(id);
const rp = (n)  => new Intl.NumberFormat('id-ID', {
  style: 'currency', currency: 'IDR',
  minimumFractionDigits: 0, maximumFractionDigits: 0,
}).format(n);

function showState(id) {
  ['state-loading', 'state-no-token', 'state-main'].forEach((s) => {
    $(s).style.display = (s === id) ? '' : 'none';
  });
}

async function findMonevTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ url: `*://${MONEV_ORIGIN}/*` }, (tabs) =>
      resolve(tabs?.[0] ?? null)
    )
  );
}

async function extractToken(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const t = sessionStorage.getItem('monev_access_token');
      if (t) return t;
      for (let i = 0; i < sessionStorage.length; i++) {
        const v = sessionStorage.getItem(sessionStorage.key(i));
        if (typeof v === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return v;
      }
      return null;
    },
  });
  return res?.[0]?.result ?? null;
}

async function api(path, token) {
  const r = await fetch(`${MONEV_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(r.status);
  const j = await r.json();
  return j.data ?? j;
}

let _gajiCache = null;
async function getGajiData() {
  if (_gajiCache) return _gajiCache;
  const r = await fetch(chrome.runtime.getURL('gaji-maganghub.json'));
  _gajiCache = await r.json();
  return _gajiCache;
}

function clean(s) {
  return s.toLowerCase()
    .replace(/\badm\b\.?/g, 'administrasi')
    .replace(/\bkab\b\.?/g, 'kabupaten')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function stripPrefix(s) {
  return s.replace(/\b(kabupaten|administrasi|kota)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

function lookupStipend(gajiData, city) {
  if (!city) return null;
  const c = clean(city);

  let found = gajiData.find((d) => clean(d.kota) === c);
  if (found) return found;

  found = gajiData.find((d) => clean(d.kota).includes(c) || c.includes(clean(d.kota)));
  if (found) return found;

  const bare = stripPrefix(c);
  found = gajiData.find((d) => stripPrefix(clean(d.kota)) === bare);
  if (found) return found;

  found = gajiData.find((d) => stripPrefix(clean(d.kota)).includes(bare));
  if (found) return found;

  const words = bare.split(' ').filter(Boolean);
  return (
    gajiData.find((d) => {
      const hay = stripPrefix(clean(d.kota));
      return words.length > 0 && words.every((w) => hay.includes(w));
    }) || null
  );
}

function getActivePeriodFromClaims(claims, today) {
  if (!Array.isArray(claims) || claims.length === 0) return null;
  const todayStr = today.toISOString().slice(0, 10);
  const active = claims.find(
    (c) => c.period_start <= todayStr && todayStr <= c.period_end
  );
  if (active) return { periodStart: active.period_start, periodEnd: active.period_end };
  const sorted = [...claims].sort((a, b) => b.period_start.localeCompare(a.period_start));
  const last = sorted[0];
  const nextStart = new Date(last.period_end);
  nextStart.setDate(nextStart.getDate() + 1);
  const nextEnd = new Date(nextStart);
  nextEnd.setDate(nextEnd.getDate() + 30);
  return {
    periodStart: nextStart.toISOString().slice(0, 10),
    periodEnd:   nextEnd.toISOString().slice(0, 10),
  };
}

function countWorkingDays(from, to, offDayNames, holidayDates) {
  const offDayNums = offDayNames.map((d) => {
    const map = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
    return map[d.toLowerCase()] ?? -1;
  });
  const holidaySet = new Set(holidayDates);
  let count = 0;
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cur <= end) {
    const dow = cur.getDay();
    const ymd = cur.toISOString().slice(0, 10);
    if (!offDayNums.includes(dow) && !holidaySet.has(ymd)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function fmtDate(d) {
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function main() {
  showState('state-loading');

  const tab = await findMonevTab();
  if (!tab) { showState('state-no-token'); return; }

  let token;
  try { token = await extractToken(tab.id); } catch { /* skip */ }
  if (!token) { showState('state-no-token'); return; }

  chrome.storage.local.set({ monev_token: token });

  let gajiData, profile, home, attendances, holidays, claims;
  try {
    [gajiData, profile, home, attendances, holidays, claims] = await Promise.all([
      getGajiData(),
      api('/api/v1/users/me', token),
      api('/api/v1/users/me/home', token).catch(() => null),
      api('/api/v1/attendances?limit=200', token).catch(() => []),
      api('/api/v1/holidays', token).catch(() => []),
      api('/api/v1/stipend-claims', token).catch(() => []),
    ]);
  } catch {
    chrome.storage.local.remove('monev_token');
    showState('state-no-token');
    return;
  }

  showState('state-main');

  $('el-user-name').textContent = profile.name || profile.email || '—';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const period      = getActivePeriodFromClaims(Array.isArray(claims) ? claims : [], today);
  const periodStart = period ? new Date(period.periodStart) : null;
  const periodEnd   = period ? new Date(period.periodEnd)   : null;

  $('el-period').textContent = periodStart && periodEnd
    ? `${fmtDate(periodStart)} – ${fmtDate(periodEnd)}`
    : '—';

  const offDays = profile.off_days || ['SATURDAY', 'SUNDAY'];
  const holidayDates = (Array.isArray(holidays) ? holidays : [])
    .filter((h) => h.scope === 'NATIONAL' || h.province_code === profile.internship_location_province_code)
    .map((h) => h.date);

  let totalHariKerja = 0, hariSudahLewat = 0, hariSisa = 0;
  if (periodStart && periodEnd) {
    const capEnd   = today < periodEnd ? today : periodEnd;
    totalHariKerja = countWorkingDays(periodStart, periodEnd, offDays, holidayDates);
    hariSudahLewat = countWorkingDays(periodStart, capEnd,    offDays, holidayDates);
    hariSisa       = totalHariKerja - hariSudahLewat;
  }

  const fromStr = period?.periodStart ?? '';
  const toStr   = period?.periodEnd   ?? '';
  const list    = (Array.isArray(attendances) ? attendances : [])
    .filter((a) => a.date >= fromStr && a.date <= toStr);

  const hariHadir = list.filter((a) => (a.status || '').toUpperCase() === 'PRESENT').length;
  const hariCuti  = list.filter((a) => (a.status || '').toUpperCase() === 'ON_LEAVE').length;

  $('el-total-hari').textContent = totalHariKerja;
  $('el-hadir').textContent      = hariHadir;
  $('el-cuti').textContent       = hariCuti;
  $('el-sisa').textContent       = hariSisa;

  const todayVal = $('el-today-val');
  if (!home || home.is_holiday || home.is_scheduled_off_day) {
    todayVal.textContent = 'Libur';
    todayVal.className   = 'today-val today-libur';
  } else if (!home.active_internship) {
    todayVal.textContent = 'Tidak aktif';
    todayVal.className   = 'today-val today-libur';
  } else if (home.has_attendance) {
    todayVal.textContent = 'Sudah absen';
    todayVal.className   = 'today-val today-hadir';
  } else {
    todayVal.textContent = 'Belum absen';
    todayVal.className   = 'today-val today-belum';
  }

  const override = (await chrome.storage.local.get('monev_city_override')).monev_city_override;
  const cityRaw  = override
    || profile.internship_location_regency_name
    || profile.internship_company_regency_name
    || null;

  const stipend = lookupStipend(gajiData, cityRaw);

  if (stipend) {
    $('city-picker').style.display = 'none';
    $('el-kota').textContent       = stipend.kota;
    $('el-provinsi').textContent   = stipend.provinsi;
    const bulanan      = stipend.uang_saku;
    const harian       = totalHariKerja > 0 ? Math.floor(bulanan / totalHariKerja) : 0;
    const cutiDibayar  = Math.min(hariCuti, 3);
    const hariTerbayar = Math.min(hariHadir + cutiDibayar, totalHariKerja);
    const earned       = (hariTerbayar === totalHariKerja && totalHariKerja > 0)
      ? bulanan
      : hariTerbayar * harian;
    $('el-bulanan').textContent = rp(bulanan);
    $('el-harian').textContent  = rp(harian);
    $('el-earned').textContent  = rp(earned);
  } else {
    $('el-kota').textContent     = cityRaw || 'Tidak diketahui';
    $('el-provinsi').textContent = '?';
    $('el-bulanan').textContent  = '—';
    $('el-harian').textContent   = '—';
    $('el-earned').textContent   = '—';
    const sel = $('el-city-select');
    sel.innerHTML = '<option value="">-- Pilih kota magang --</option>' +
      gajiData.map((d) => `<option value="${d.kota}">${d.kota} · ${d.provinsi}</option>`).join('');
    $('city-picker').style.display = '';
    sel.addEventListener('change', async (e) => {
      const found = lookupStipend(gajiData, e.target.value);
      if (!found) return;
      await chrome.storage.local.set({ monev_city_override: e.target.value });
      $('city-picker').style.display = 'none';
      $('el-kota').textContent        = found.kota;
      $('el-provinsi').textContent    = found.provinsi;
      const b            = found.uang_saku;
      const h            = totalHariKerja > 0 ? Math.floor(b / totalHariKerja) : 0;
      const cutiDibayar  = Math.min(hariCuti, 3);
      const hariTerbayar = Math.min(hariHadir + cutiDibayar, totalHariKerja);
      const earned       = (hariTerbayar === totalHariKerja && totalHariKerja > 0)
        ? b
        : hariTerbayar * h;
      $('el-bulanan').textContent = rp(b);
      $('el-harian').textContent  = rp(h);
      $('el-earned').textContent  = rp(earned);
    });
  }
}

main();
