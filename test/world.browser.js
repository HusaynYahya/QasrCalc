/* A stress test: twenty journeys, six continents, driven through the real page.
   Each asserts the app's own numbers are self-consistent and that the verdict
   follows the 44 km rule applied to the total it reports. */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const TILE=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR42mP8//8/AzGAiYFEMKphVMOohuGjAQDcHgQAdW3H8gAAAABJRU5ErkJggg==','base64');

/* a box of about r km around a point, longitude corrected for latitude */
const city = (lat, lon, r) => {
  const dLat = r/111.32, dLon = r/(111.32*Math.cos(lat*Math.PI/180));
  return { type:'Polygon', coordinates:[[[lon-dLon,lat-dLat],[lon-dLon,lat+dLat],
           [lon+dLon,lat+dLat],[lon+dLon,lat-dLat],[lon-dLon,lat-dLat]]] };
};

const C = [
 // name                     from            fromCity  r   to              toCity      roadKm return  opts
 ['Watford → central London',[51.656,-0.396],'Watford', 6,[51.507,-0.128],'London',    31, true,  {}],
 ['Qom → Tehran',            [34.64, 50.88], 'Qom',    12,[35.69, 51.39], 'Tehran',   148, true,  {}],
 ['Karbala → Najaf',         [32.61, 44.02], 'Karbala', 9,[32.00, 44.33], 'Najaf',     80, true,  {}],
 ['Jeddah → Makkah, 10 days',[21.49, 39.19], 'Jeddah', 18,[21.42, 39.83], 'Makkah',    85, true,  {ten:true}],
 ['Cairo → Alexandria',      [30.04, 31.24], 'Cairo',  22,[31.20, 29.92], 'Alexandria',220,true,  {}],
 ['Lagos → Ibadan',          [6.52,  3.38],  'Lagos',  20,[7.38,  3.90],  'Ibadan',    130,true,  {}],
 ['Mumbai → Pune',           [19.08, 72.88], 'Mumbai', 20,[18.52, 73.86], 'Pune',      150,true,  {}],
 ['Tokyo → Yokohama',        [35.69,139.70], 'Tokyo',  18,[35.44,139.64], 'Yokohama',   42,true,  {}],
 ['Istanbul, side to side',  [41.05, 28.85], 'Istanbul',28,[41.01,29.13], 'Istanbul',   40,true,  {sameCity:true}],
 ['KL → Putrajaya',          [3.14, 101.69], 'Kuala Lumpur',12,[2.93,101.69],'Putrajaya',33,true, {}],
 ['Sydney → Wollongong',     [-33.87,151.21],'Sydney', 25,[-34.42,150.89],'Wollongong', 85,true,  {}],
 ['São Paulo → Campinas',    [-23.55,-46.63],'São Paulo',22,[-22.90,-47.06],'Campinas', 99,true,  {}],
 ['Mexico City → Puebla',    [19.43,-99.13], 'Ciudad de México',25,[19.04,-98.20],'Puebla',134,true,{}],
 ['New York → Newark',       [40.75,-73.98], 'New York',15,[40.74,-74.17], 'Newark',     19,true,  {}],
 ['Anchorage → Wasilla',     [61.22,-149.90],'Anchorage',14,[61.58,-149.44],'Wasilla',   68,true,  {}],
 ['Rovaniemi → Kemi',        [66.50, 25.73], 'Rovaniemi',8,[65.74, 24.56], 'Kemi',      117,true,  {}],
 ['Nadi → Suva',             [-17.80,177.42],'Nadi',    6,[-18.14,178.44],'Suva',      190,true,  {}],
 ['Reykjavík → Keflavík',    [64.15,-21.94], 'Reykjavík',9,[63.99,-22.56],'Keflavík',   49,true,  {}],
 ['Doha → Al Khor, one way', [25.29, 51.53], 'Doha',   16,[25.68, 51.50], 'Al Khor',    57, false, {}],
 ['Kano → small village',    [12.00,  8.52], 'Kano',   14,[12.70,  8.90], 'Gwarzo',     92,true,  {noBorder:true}],
];

const line=(a,b,n)=>Array.from({length:n},(_,i)=>[a[1]+(b[1]-a[1])*i/(n-1), a[0]+(b[0]-a[0])*i/(n-1)]);
const num = t => { const m=String(t).match(/-?[\d.]+/); return m?parseFloat(m[0]):NaN; };

(async()=>{
  const browser = await chromium.launch();
  let bad = 0, ran = 0;
  console.log('case'.padEnd(28)+'road   less   1 leg   total   verdict            border check');
  console.log('-'.repeat(104));

  for (const [name, from, fromCity, r, to, toCity, roadKm, returning, opts] of C) {
    const page = await browser.newPage({ viewport:{width:1000,height:1100} });
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{ if(m.type()==='error' && !/ERR_FAILED/.test(m.text())) errors.push(m.text()); });

    const homeShape = opts.noBorder ? null : city(from[0], from[1], r);
    const destShape = city(to[0], to[1], 8);

    await page.route('**/*', rt => {
      const u = rt.request().url();
      if (u.startsWith('http://127.0.0.1:8078')) return rt.continue();
      if (u.includes('/api/interpreter')) return rt.fulfill({status:200,contentType:'application/json',body:JSON.stringify({elements:[]})});
      if (u.includes('photon')) return rt.fulfill({status:200,contentType:'application/json',body:JSON.stringify({features:[]})});
      if (u.includes('featureType=settlement')) {
        const q = decodeURIComponent(u.split('&q=')[1]||'');
        const isHome = q.toLowerCase().includes(fromCity.toLowerCase().slice(0,5));
        const shape = isHome ? homeShape : destShape;
        if (!shape) return rt.fulfill({status:200,contentType:'application/json',body:JSON.stringify([])});
        return rt.fulfill({status:200,contentType:'application/json',body:JSON.stringify([{
          display_name:q, addresstype:'city', place_rank:16,
          lat:String(isHome?from[0]:to[0]), lon:String(isHome?from[1]:to[1]),
          address:{city:isHome?fromCity:toCity}, geojson:shape }])});
      }
      if (u.includes('/reverse')) {
        const p=new URL(u).searchParams;
        if (p.get('zoom')==='18') return rt.fulfill({status:200,contentType:'application/json',body:JSON.stringify({display_name:'An address'})});
        const lat=parseFloat(p.get('lat')), lon=parseFloat(p.get('lon'));
        const isHome = Math.abs(lat-from[0])<Math.abs(lat-to[0]) || opts.sameCity;
        const nm = isHome ? fromCity : toCity;
        const shape = isHome ? homeShape : destShape;
        return rt.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
          addresstype:'city', place_rank:16, name:nm, address:{city:nm},
          geojson: shape || {type:'Point',coordinates:[lon,lat]} })});
      }
      if (u.includes('nominatim')) {
        const q=decodeURIComponent(u);
        const wantsTo = q.toLowerCase().includes(toCity.toLowerCase().slice(0,4));
        const pt = wantsTo ? to : from;
        return rt.fulfill({status:200,contentType:'application/json',body:JSON.stringify([
          {display_name:(wantsTo?toCity:fromCity), lat:String(pt[0]), lon:String(pt[1])}])});
      }
      if (u.includes('osrm')) return rt.fulfill({status:200,contentType:'application/json',body:JSON.stringify({code:'Ok',
        routes:[{distance:roadKm*1000, duration:roadKm*50, geometry:{coordinates:line(from,to,40)}}]})});
      if (u.includes('cartocdn')) return rt.fulfill({status:200,contentType:'image/png',body:TILE});
      return rt.abort();
    });

    await page.goto('http://127.0.0.1:8078/');
    await page.fill('#fromInput', fromCity); await page.waitForTimeout(150);
    await page.fill('#toInput', opts.sameCity ? fromCity + ' east' : toCity);
    if (!returning) await page.click(".seg label:has(input[value='oneway'])");
    if (opts.ten) { await page.check('#qTenDays'); }
    await page.click('#calcBtn');
    let ok = true, note = '';
    try {
      await page.waitForSelector('#result:not([hidden])', { timeout: 20000 });
      await page.waitForTimeout(1800);
    } catch (e) { ok=false; note='no result'; }

    let rows = {}, verdict='—', check='—';
    if (ok) {
      const pairs = await page.$$eval('.measure div', ds=>ds.map(d=>[d.querySelector('dt').textContent, d.querySelector('dd').textContent]));
      pairs.forEach(([k,v])=>{ rows[k.replace(/\s+/g,' ').trim()] = v.replace(/\s+/g,' ').trim(); });
      verdict = (await page.textContent('#verdictLabel')).trim();
      check = (await page.getAttribute('#borderCheck','class')||'').replace('bordercheck ','');
    }

    const road   = num(rows['Road measured, your door to the destination']);
    const lessK  = Object.keys(rows).find(k=>/not counted$/.test(k));
    const less   = lessK ? Math.abs(num(rows[lessK])) : 0;
    const legK   = Object.keys(rows).find(k=>/^Counts/.test(k));
    const leg    = legK ? num(rows[legK]) : NaN;
    const total  = num(rows['Total counted']);
    const combined = Object.keys(rows).some(k=>/on the way back/.test(k));

    /* --- the assertions ------------------------------------------------ */
    const fails = [];
    if (!ok) fails.push('no result');
    else {
      if (!opts.sameCity && Math.abs((road - less) - leg) > 0.25) fails.push(`road-less≠leg (${road}-${less}≠${leg})`);
      const expectTotal = opts.sameCity ? 0 : (combined ? leg*2 : leg);
      if (Math.abs(expectTotal - total) > 0.25) fails.push(`total≠legs (${expectTotal}≠${total})`);
      const shouldQasr = total >= 44;
      const saysQasr = /Shorten/.test(verdict);
      const saysFull = /full/i.test(verdict);
      if (opts.ten) {
        if (!/road/i.test(verdict) && !saysFull) fails.push('ten-day: expected road/stay split');
      } else if (shouldQasr && !saysQasr) fails.push(`total ${total} ≥ 44 but verdict "${verdict}"`);
      else if (!shouldQasr && !saysFull) fails.push(`total ${total} < 44 but verdict "${verdict}"`);
      if (opts.sameCity && !(total === 0 || isNaN(total))) fails.push(`same city should count 0, counted ${total}`);
      if (opts.noBorder && check !== 'is-off') fails.push(`no border should flag amber, got ${check}`);
      if (!opts.noBorder && !opts.sameCity && check !== 'is-ok') fails.push(`expected a border, got ${check}`);
      if (errors.length) fails.push('js: '+errors[0].slice(0,40));
    }
    ran++;
    if (fails.length) bad++;
    console.log(
      (fails.length?'✗ ':'  ') + name.padEnd(26) +
      String(road||'—').padEnd(7) + String(less||0).padEnd(7) + String(leg||'—').padEnd(8) +
      String(total||'—').padEnd(8) + verdict.slice(0,18).padEnd(19) + check +
      (fails.length ? '\n     ↳ ' + fails.join('; ') : ''));
    await page.close();
  }
  await browser.close();
  console.log('-'.repeat(104));
  console.log(`${ran - bad} of ${ran} consistent` + (bad ? `, ${bad} with problems` : ''));
})();
